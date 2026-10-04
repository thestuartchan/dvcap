// src/MarketState.jsx — the Market Watch screens built on lib/marketState.js.
//
// STATE is the landing screen: the regime (where growth and inflation are heading), the conditions
// score (how much risk the system will carry), policy and liquidity, the plan those imply, and the
// if/then list — the transitions worth preparing for, each with how close it is. DRIVERS is every
// gauge behind it in one tile format, grouped by the axis it feeds, with the old deep panels folded
// underneath. DATA HEALTH says how old each input is. The Street's view is a cross-check beside the
// measured one, never an input to it.
//
// Pure rendering: App fetches and computes, these draw. Nothing here reads private data.
import { useState } from "react";
import { C, alpha } from "./theme.js";
import { Card, SLabel, StaleChip } from "./ui.jsx";
import { REGIME_PALETTE } from "../lib/regimes.js";
import { QUADRANTS, BANDS, STRESS_AT, CONDITION_SIZING, DRIVER_GROUPS, seriesHealth } from "../lib/marketState.js";
import { REGIME_SIZING } from "../lib/sizing.js";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const QORDER = ["ref", "inf", "stag", "def"];
const BAND_TONE = {
  calm: { color: C.green, bg: C.gBg, bdr: C.gBdr },
  caution: { color: C.amber, bg: C.aBg, bdr: C.aBdr },
  stress: { color: C.orange, bg: C.oBg, bdr: C.oBdr },
  crisis: { color: C.red, bg: C.rBg, bdr: C.rBdr },
};
const TONE = {
  bad: { color: C.red, bg: C.rBg, bdr: C.rBdr },
  warn: { color: C.amber, bg: C.aBg, bdr: C.aBdr },
  good: { color: C.green, bg: C.gBg, bdr: C.gBdr },
  info: { color: C.blue, bg: C.blBg, bdr: C.blBdr },
};
const bandTone = (id) => BAND_TONE[id] || { color: C.mid, bg: C.inset, bdr: C.bdr };
const scoreBand = (v) => (v == null ? null : BANDS.find(b => v < b.max)?.id);
const sgn = (v, d = 0) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`);
const pretty = (s) => (s ? s.replace(/_/g, " ").replace(/^./, c => c.toUpperCase()) : "—");
const fmtWhen = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const fmtDay = (iso) => (iso ? new Date(iso + "T12:00:00Z").toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" }) : "—");

// ── SMALL PIECES ─────────────────────────────────────────────────────────────
function Eyebrow({ children, style }) {
  return <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, textTransform: "uppercase", color: C.lbl, ...style }}>{children}</div>;
}
export function Chip({ k, v, tone, title }) {
  const t = tone || { color: C.mid, bg: C.inset, bdr: C.bdr };
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "baseline", gap: 6, padding: "4px 9px", borderRadius: 7, background: t.bg, border: "1px solid " + t.bdr, maxWidth: "100%", minWidth: 0 }}>
      {k && <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.8, textTransform: "uppercase", color: C.lbl, whiteSpace: "nowrap" }}>{k}</span>}
      <span style={{ fontSize: 12.5, fontWeight: 800, color: t.color, overflowWrap: "anywhere" }}>{v}</span>
    </span>
  );
}
function Bar({ pct, color, height = 8, marks = [], ghost = null }) {
  const w = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const g = ghost == null ? null : Math.max(0, Math.min(100, ghost));
  return (
    <div style={{ position: "relative", height, borderRadius: height / 2, background: C.inset, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: w + "%", background: color, borderRadius: height / 2 }} />
      {marks.map(m => <div key={m} style={{ position: "absolute", left: m + "%", top: 0, bottom: 0, width: 1.5, background: C.bdrMd }} />)}
      {g != null && <div title={`a week ago: ${Math.round(g)}%`} style={{ position: "absolute", left: `calc(${g}% - 1px)`, top: 0, bottom: 0, width: 2, background: C.text, opacity: 0.55 }} />}
    </div>
  );
}
// A sparkline in the series' own units. `lines` are horizontal references in the same units.
export function Spark({ values, color = C.blue, height = 34, lines = [], lo = null, hi = null }) {
  const v = (values || []).filter(Number.isFinite);
  if (v.length < 2) return <div style={{ height }} />;
  const min = lo ?? Math.min(...v, ...lines), max = hi ?? Math.max(...v, ...lines);
  const span = max - min || 1, W = 100;
  const y = (x) => height - 2 - ((x - min) / span) * (height - 4);
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * W).toFixed(2)},${y(x).toFixed(2)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ width: "100%", height, display: "block" }} aria-hidden="true">
      {lines.map(l => <line key={l} x1="0" x2={W} y1={y(l)} y2={y(l)} style={{ stroke: C.bdrMd, strokeWidth: 1, strokeDasharray: "3 3" }} vectorEffect="non-scaling-stroke" />)}
      <polyline points={pts} style={{ fill: "none", stroke: color, strokeWidth: 1.8 }} vectorEffect="non-scaling-stroke" />
      <circle cx={W} cy={y(v[v.length - 1])} r="2.2" style={{ fill: color }} />
    </svg>
  );
}
// Mounts its children only when opened: the deep panels are heavy and most visits never open them.
export function Fold({ title, hint, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: "1.5px solid " + C.bdr, borderRadius: 10, background: C.surf }}>
      <button onClick={() => setOpen(o => !o)} aria-expanded={open}
        style={{ width: "100%", display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", background: "none", border: "none", cursor: "pointer", padding: "9px 12px", color: C.text, textAlign: "left" }}>
        <span style={{ fontSize: 12, color: C.muted, width: 12 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontSize: 13, fontWeight: 800 }}>{title}</span>
        {hint && <span style={{ fontSize: 11.5, color: C.muted }}>{hint}</span>}
      </button>
      {open && <div style={{ padding: "0 10px 10px", display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>}
    </div>
  );
}

// ── REGIME ───────────────────────────────────────────────────────────────────
// Growth across, inflation up. The dot is where the axes are; the arrow is where the fast legs say
// they are going. Each quadrant is tinted by its probability.
function RegimeMap({ r }) {
  const S = 240, M = S / 2, k = (S / 2 - 14) / 1.1;
  const X = (g) => M + Math.max(-1.1, Math.min(1.1, g)) * k;
  const Y = (i) => M - Math.max(-1.1, Math.min(1.1, i)) * k;
  const cells = { stag: [0, 0], inf: [M, 0], def: [0, M], ref: [M, M] };
  const g = r.growth.level, i = r.inflation.level;
  const tg = g + r.growth.drift, ti = i + r.inflation.drift;
  const moved = Math.abs(r.growth.drift) >= 0.15 || Math.abs(r.inflation.drift) >= 0.15;
  const corner = { stag: [8, 18, "start"], inf: [S - 8, 18, "end"], def: [8, S - 10, "start"], ref: [S - 8, S - 10, "end"] };
  return (
    <svg viewBox={`0 0 ${S} ${S}`} style={{ width: "100%", maxWidth: 280, display: "block", margin: "0 auto" }} role="img"
      aria-label={`Regime map: growth ${g}, inflation ${i}`}>
      <defs>
        <marker id="ms-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" style={{ fill: C.text }} />
        </marker>
      </defs>
      {Object.entries(cells).map(([id, [x, y]]) => {
        const pal = REGIME_PALETTE[id], p = r.probs[id] ?? 0;
        return <rect key={id} x={x} y={y} width={M} height={M} style={{ fill: alpha(pal.color, 0.06 + (p / 100) * 0.5) }} />;
      })}
      <line x1={M} x2={M} y1="0" y2={S} style={{ stroke: C.bdrMd, strokeWidth: 1 }} />
      <line y1={M} y2={M} x1="0" x2={S} style={{ stroke: C.bdrMd, strokeWidth: 1 }} />
      {Object.entries(corner).map(([id, [x, y, anchor]]) => (
        <text key={id} x={x} y={y} textAnchor={anchor} style={{ fill: REGIME_PALETTE[id].color, fontSize: 10.5, fontWeight: 800, fontFamily: MONO }}>
          {QUADRANTS[id].short.replace("Inflationary boom", "Infl. boom").replace("Deflationary bust", "Defl. bust")} {r.probs[id]}%
        </text>
      ))}
      <text x={S - 4} y={M - 4} textAnchor="end" style={{ fill: C.lbl, fontSize: 8.5, fontFamily: MONO }}>growth →</text>
      <text x={M + 4} y={30} style={{ fill: C.lbl, fontSize: 8.5, fontFamily: MONO }}>↑ inflation</text>
      {moved && <line x1={X(g)} y1={Y(i)} x2={X(tg)} y2={Y(ti)} markerEnd="url(#ms-arrow)" style={{ stroke: C.text, strokeWidth: 1.6, strokeDasharray: "4 3" }} />}
      <circle cx={X(g)} cy={Y(i)} r="6.5" style={{ fill: C.text, stroke: C.surf, strokeWidth: 2 }} />
    </svg>
  );
}

const LEG_NAME = { market: "market", weekly: "weekly", monthly: "monthly", nowcast: "nowcast", printed: "printed" };
function AxisRow({ name, a, words }) {
  const legs = Object.entries(a.legs || {});
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: C.text }}>{name}</span>
        <span style={{ fontSize: 11.5, color: C.muted, fontFamily: MONO }}>level {sgn(a.level, 2)} · drift {sgn(a.drift, 2)}</span>
      </div>
      <div style={{ fontSize: 12, color: C.mid }}>{words}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {legs.map(([k, v]) => (
          <span key={k} style={{ fontSize: 11, fontFamily: MONO, color: v > 0.2 ? C.text : v < -0.2 ? C.text : C.muted, background: C.inset, borderRadius: 5, padding: "2px 6px" }}>
            {LEG_NAME[k] || k} {sgn(v, 2)}
          </span>
        ))}
      </div>
    </div>
  );
}

function RegimePanel({ r }) {
  if (!r?.available) {
    return (
      <Card><Eyebrow>Regime</Eyebrow><div style={{ marginTop: 8, fontSize: 13, color: C.muted }}>No read — {r?.reason || "the indicators have not loaded"}.</div></Card>
    );
  }
  return (
    <Card style={{ display: "grid", gap: 12, alignContent: "start", minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
        <Eyebrow>Regime · weeks → months</Eyebrow>
        <span style={{ fontSize: 11, color: C.muted }}>{r.contested ? "top two within 10 pts" : `leader by ${r.probs[r.id] - Object.values(r.probs).sort((a, b) => b - a)[1]} pts`}</span>
      </div>
      <RegimeMap r={r} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6 }}>
        {QORDER.map(id => {
          const pal = REGIME_PALETTE[id], on = id === r.id;
          return (
            <div key={id} style={{ borderRadius: 8, padding: "7px 8px", background: on ? pal.bg : C.inset, border: "1px solid " + (on ? pal.bdr : "transparent"), minWidth: 0 }}>
              <div style={{ fontSize: 19, fontWeight: 800, color: pal.color, lineHeight: 1 }}>{r.probs[id]}%</div>
              <div style={{ fontSize: 10.5, color: C.muted, lineHeight: 1.25, marginTop: 3 }}>{QUADRANTS[id].label}</div>
            </div>
          );
        })}
      </div>
      <AxisRow name="Growth" a={r.growth} words={r.words.growth} />
      <AxisRow name="Inflation" a={r.inflation} words={r.words.inflation} />
      <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
        Legs are net leans in [−1, 1]; the level weights the market leg most, drift is the fast leg minus the slow one. The dashed arrow is where the axes go if the fast legs are right.
      </div>
    </Card>
  );
}

// ── CONDITIONS ───────────────────────────────────────────────────────────────
function ConditionsPanel({ c }) {
  const comps = Object.entries(c?.components || {}).sort((a, b) => (b[1].contribution ?? 0) - (a[1].contribution ?? 0));
  const [sel, setSel] = useState(null);
  const pick = sel && c?.components?.[sel] ? sel : comps[0]?.[0] ?? null;
  if (!c || c.score == null) {
    return <Card><Eyebrow>Conditions</Eyebrow><div style={{ marginTop: 8, fontSize: 13, color: C.muted }}>No read — fewer than four gauges answered.</div></Card>;
  }
  const t = bandTone(c.band.id);
  const d = c.components[pick];
  return (
    <Card style={{ display: "grid", gap: 12, alignContent: "start", minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
        <Eyebrow>Conditions · days → weeks</Eyebrow>
        <span style={{ fontSize: 11, color: C.muted }}>as of {fmtDay(c.date)}</span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 38, fontWeight: 900, color: t.color, lineHeight: 1 }}>{c.score}</span>
        <Chip v={c.band.label} tone={t} />
        {c.trend && <Chip v={`${c.trend === "rising" ? "↑" : c.trend === "easing" ? "↓" : "→"} ${c.trend}`} tone={c.trend === "rising" ? TONE.warn : c.trend === "easing" ? TONE.good : undefined} />}
        <span style={{ fontSize: 12, color: C.muted }}>week ago {c.weekAgo ?? "—"} · 20-day peak {c.peak20 ?? "—"}</span>
      </div>
      <div>
        <Bar pct={c.score} color={t.color} height={10} marks={[45, STRESS_AT, 82]} />
        <div style={{ position: "relative", height: 14, fontSize: 9.5, color: C.lbl, fontFamily: MONO }}>
          <span style={{ position: "absolute", left: 0 }}>calm</span>
          <span style={{ position: "absolute", left: "45%", transform: "translateX(-50%)" }}>45</span>
          <span style={{ position: "absolute", left: STRESS_AT + "%", transform: "translateX(-50%)" }}>{STRESS_AT} stress</span>
          <span style={{ position: "absolute", right: 0 }}>82+</span>
        </div>
      </div>
      <div>
        <Spark values={(c.history || []).map(h => h.score)} color={t.color} lines={[45, STRESS_AT]} lo={0} hi={100} height={40} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.lbl, fontFamily: MONO }}>
          <span>{fmtDay(c.history?.[0]?.date)}</span><span>{c.history?.length ?? 0} sessions</span><span>{fmtDay(c.history?.[c.history.length - 1]?.date)}</span>
        </div>
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        {comps.map(([k, x]) => {
          const on = k === pick, bt = bandTone(scoreBand(x.score));
          return (
            <button key={k} onClick={() => setSel(k)} aria-pressed={on}
              style={{ display: "grid", gridTemplateColumns: "92px minmax(0, 1fr) 30px 44px", gap: 8, alignItems: "center", width: "100%", textAlign: "left",
                background: on ? C.blBg : "none", border: "1px solid " + (on ? C.blBdr : "transparent"), borderRadius: 6, padding: "4px 5px", cursor: "pointer", color: C.text }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{x.label}</span>
              <Bar pct={x.score} color={bt.color} />
              <span style={{ fontSize: 12, fontWeight: 800, fontFamily: MONO, textAlign: "right" }}>{x.score}</span>
              <span style={{ fontSize: 10.5, color: C.muted, fontFamily: MONO, textAlign: "right" }} title="points of the composite">{x.contribution}pt</span>
            </button>
          );
        })}
      </div>
      {d && (
        <div style={{ fontSize: 12.5, color: C.mid, background: C.inset, borderRadius: 8, padding: "9px 11px", lineHeight: 1.5 }}>
          <b style={{ color: C.text }}>{d.label}</b> — {d.read}.
          <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>weight {Math.round(d.weight * 100)}% · {d.contribution} of the {c.score} points · observed {fmtDay(d.asOf)}</div>
        </div>
      )}
    </Card>
  );
}

// ── POLICY & LIQUIDITY ───────────────────────────────────────────────────────
function KV({ k, v, s, color }) {
  return (
    <div style={{ background: C.inset, borderRadius: 8, padding: "9px 10px", minWidth: 0 }}>
      <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.8, textTransform: "uppercase", color: C.lbl }}>{k}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: color || C.text, marginTop: 2, overflowWrap: "anywhere" }}>{v}</div>
      {s && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2, lineHeight: 1.4 }}>{s}</div>}
    </div>
  );
}
function PolicyPanel({ p }) {
  const n = p?.next, l = p?.liquidity;
  const stanceTone = p?.stance === "tightening" ? C.red : p?.stance === "easing" ? C.green : C.amber;
  return (
    <Card style={{ display: "grid", gap: 10, alignContent: "start", minWidth: 0 }}>
      <Eyebrow>Policy & liquidity</Eyebrow>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
        <KV k="Statement" v={pretty(p?.stanceRaw)} color={stanceTone} s={p?.stanceAsOf ? `kept by hand · ${fmtDay(p.stanceAsOf)}` : "kept by hand"} />
        <KV k="Next FOMC" v={n ? `${n.hikeOdds != null ? `hike ${Math.round(n.hikeOdds)}%` : ""}${n.hikeOdds != null && n.cutOdds != null ? " · " : ""}${n.cutOdds != null ? `cut ${Math.round(n.cutOdds)}%` : ""}` || "—" : "—"}
          color={n?.hikeOdds >= 50 ? C.red : n?.cutOdds >= 50 ? C.green : C.text} s={n?.meeting ? `${fmtDay(n.meeting)} · ZQ futures` : "ZQ futures not loaded"} />
        <KV k="Net liquidity" v={l ? `$${l.net.toLocaleString()}bn` : "—"}
          color={l?.impulse === "draining" ? C.red : l?.impulse === "adding" ? C.green : C.text}
          s={l ? `${sgn(l.chg4w)}bn over 4 weeks · ${l.impulse} · ${fmtDay(l.asOf)}` : "FRED H.4.1 not loaded"} />
      </div>
      {l && (
        <div style={{ fontSize: 11.5, color: C.muted, fontFamily: MONO, lineHeight: 1.5 }}>
          Fed assets ${l.fed.toLocaleString()}bn − Treasury account ${l.tga.toLocaleString()}bn − reverse repo ${l.rrp.toLocaleString()}bn
        </div>
      )}
    </Card>
  );
}

// ── THE PLAN THE STATE IMPLIES ───────────────────────────────────────────────
const PHASE_WORDS = {
  preCrash: "Pre-crash — hedges are still cheap; buy them now, not after",
  liquidity: "Liquidity event — monetise what is on; do not add at these prices",
  recovery: "Recovery — roll hedges off and redeploy in tranches",
};
function PlanPanel({ st, legacy }) {
  const s = st.sizing, g = st.stage, h = st.hedgePhase;
  return (
    <Card style={{ display: "grid", gap: 10, alignContent: "start", minWidth: 0 }}>
      <Eyebrow>What it implies</Eyebrow>
      {g && (
        <div style={{ display: "grid", gap: 3 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: C.blue, fontFamily: MONO }}>STAGE {g.n}</span>
            <span style={{ fontSize: 15, fontWeight: 800, color: C.text }}>{g.label}</span>
          </div>
          <div style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.5 }}>{g.plan}</div>
        </div>
      )}
      <div style={{ background: C.inset, borderRadius: 8, padding: "9px 11px", display: "grid", gap: 4 }}>
        <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.8, textTransform: "uppercase", color: C.lbl }}>Sizing multiplier</div>
        <div style={{ fontFamily: MONO, fontSize: 13, color: C.text, overflowWrap: "anywhere" }}>
          regime ×{s.regimeMult?.toFixed(2) ?? "—"} × conditions ×{s.condMult?.toFixed(2) ?? "—"} = <b style={{ fontSize: 16 }}>×{s.total?.toFixed(2) ?? "—"}</b>
        </div>
        {(s.regimeMult == null || s.condMult == null) && (
          <div style={{ fontSize: 11.5, color: C.amber, fontWeight: 700 }}>{s.regimeMult == null ? "The regime has no read — this is the conditions multiplier alone." : "Conditions have no read — this is the regime multiplier alone."}</div>
        )}
        <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.45 }}>
          Regime multiplier is the probability-weighted average of {QORDER.map(id => `${QUADRANTS[id].short.split(" ")[0].toLowerCase()} ×${REGIME_SIZING[id].mult}`).join(", ")};
          conditions {Object.entries(CONDITION_SIZING).map(([k, v]) => `${k} ×${v}`).join(", ")}.
          {legacy != null && <> The Console sizes on this figure; the consensus engine it replaced would give <b style={{ color: C.mid }}>×{legacy.toFixed(2)}</b>.</>}
        </div>
      </div>
      {h && <div style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.5 }}><b style={{ color: C.text }}>Hedges:</b> {PHASE_WORDS[h.id]} <span style={{ color: C.muted }}>({h.why})</span></div>}
    </Card>
  );
}

// ── IF / THEN ────────────────────────────────────────────────────────────────
// The week's change in how close a trigger is: up is closer.
// Red when a warning moved closer; for a good transition (relief, easing) closer is green.
export function Delta5({ v, good = false, title = "change in proximity over the last five sessions" }) {
  if (v == null || v === 0) return v === 0 ? <span title={title} style={{ fontSize: 10.5, fontFamily: MONO, color: C.muted }}>± 0 5d</span> : null;
  const up = v > 0;
  return (
    <span title={title} style={{ fontSize: 10.5, fontFamily: MONO, fontWeight: 800, color: up !== good ? C.red : C.green, whiteSpace: "nowrap" }}>
      {up ? "▲" : "▼"} {up ? "+" : "−"}{Math.abs(v)} 5d
    </span>
  );
}

// What is closest today, and what moved the most toward its trigger this week. Read by the State
// header, the if/then card and the Plan tab.
function closestToday(list) {
  if (!list?.length) return null;
  const top = list[0];
  // The gauge that moved furthest toward any trigger this week, other than the one already named.
  let fastest = null;
  for (const t of list) for (const p of t.parts) {
    if (t.id === top.id && p.label === top.nearest?.label) continue;
    if (p.delta5 != null && p.delta5 > 0 && (!fastest || p.delta5 > fastest.part.delta5)) fastest = { t, part: p };
  }
  return { top, fastest };
}
export function ClosestCallout({ list, asOf = null }) {
  const c = closestToday(list);
  if (!c) return null;
  const { top, fastest } = c;
  const tone = TONE[top.tone] || TONE.info;
  return (
    <div style={{ display: "grid", gap: 4, padding: "9px 12px", borderRadius: 9, background: tone.bg, border: "1px solid " + tone.bdr }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, fontWeight: 900, letterSpacing: 1, textTransform: "uppercase", color: tone.color }}>Closest today</span>
        <span style={{ fontSize: 14, fontWeight: 900, color: C.text }}>{top.title}</span>
        <span style={{ fontSize: 12, fontWeight: 800, fontFamily: MONO, color: tone.color }}>{top.proximity >= 100 ? "TRIGGERED" : `${top.proximity}%`}</span>
        <Delta5 v={top.delta5} good={top.tone === "good"} />
      </div>
      {top.nearest && (
        <div style={{ fontSize: 12.5, color: C.mid, fontFamily: MONO }}>
          {top.nearest.label} {top.nearest.text} → {top.nearest.atText} · <b style={{ color: C.text }}>{top.nearest.gapText}</b>
        </div>
      )}
      {fastest && (
        <div style={{ fontSize: 12, color: C.muted }}>
          Moving fastest: <b style={{ color: C.text }}>{fastest.part.label}</b> toward “{fastest.t.title}” — {fastest.part.proximityWas}% → {fastest.part.proximity}% of the way in five sessions ({fastest.part.gapText}).
        </div>
      )}
      {asOf && <div style={{ fontSize: 10.5, color: C.lbl }}>live · gauges as of {fmtDay(asOf)}, recomputed on every load</div>}
    </div>
  );
}

function IfThen({ list, asOf = null }) {
  if (!list?.length) return null;
  return (
    <Card style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
        <Eyebrow>If / then — live, closest first</Eyebrow>
        <span style={{ fontSize: 11, color: C.muted }}>bar: 0 = calm reference, 100 = trigger · tick = a week ago</span>
      </div>
      <ClosestCallout list={list} asOf={asOf} />
      {list.map(t => {
        const tone = TONE[t.tone] || TONE.info;
        const hot = t.proximity >= 100;
        return (
          <div key={t.id} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "8px 14px", padding: "10px 12px",
            border: "1.5px solid " + (hot ? tone.bdr : C.bdr), background: hot ? tone.bg : "transparent", borderRadius: 9, borderLeft: "4px solid " + tone.color }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontSize: 13.5, fontWeight: 800, color: C.text }}>{t.title}</span>
                <span style={{ fontSize: 11, fontWeight: 800, fontFamily: MONO, color: tone.color }}>{hot ? "TRIGGERED" : `${t.proximity}%`}</span>
                <Delta5 v={t.delta5} good={t.tone === "good"} />
              </div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 3, lineHeight: 1.45 }}>when {t.trigger}</div>
            </div>
            <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
              {t.parts.map(p => (
                <div key={p.label} style={{ display: "grid", gap: 2 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 11, fontFamily: MONO, flexWrap: "wrap" }}>
                    <span style={{ color: C.mid }}>{p.label} <Delta5 v={p.delta5} good={t.tone === "good"} /></span>
                    <span style={{ color: C.muted }}>{p.text} → {p.atText}{p.gapText ? <b style={{ color: p.met ? tone.color : C.text }}> · {p.gapText}</b> : null}</span>
                  </div>
                  <Bar pct={p.proximity} color={p.proximity >= 100 ? tone.color : alpha(tone.color, 0.7)} height={6} ghost={p.proximityWas} />
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.5, minWidth: 0 }}><b style={{ color: C.text }}>Then:</b> {t.plan}</div>
          </div>
        );
      })}
      <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
        Every figure here is today's reading against a fixed trigger, recomputed each time the page loads. The five-session change is shown where the gauge can be re-read a week back (conditions, credit, rates vol, the VIX curve, real yields); the regime axes, futures odds and liquidity show today only.
      </div>
    </Card>
  );
}

// ── THE STATE SCREEN ─────────────────────────────────────────────────────────
export function StateView({ st, feed, loading, error, onRefresh, legacySizing = null, streetLabel = null }) {
  const c = st?.conditions, r = st?.regime;
  const bt = bandTone(c?.band?.id);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ borderTop: "4px solid " + (c?.band ? bt.color : C.bdr), display: "grid", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
          <Eyebrow>Market state · measured</Eyebrow>
          <span style={{ fontSize: 11, color: C.muted, display: "inline-flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            gauges {fmtWhen(feed?.at)}{feed?.source === "stale" && <StaleChip>last good copy</StaleChip>}
            {onRefresh && <button onClick={onRefresh} disabled={loading} style={{ cursor: "pointer", background: "none", border: "1px solid " + C.bdr, borderRadius: 6, color: C.blue, fontSize: 11, fontWeight: 700, padding: "2px 8px" }}>{loading ? "…" : "↻"}</button>}
          </span>
        </div>
        <div style={{ fontSize: 22, fontWeight: 900, color: C.text, lineHeight: 1.2, letterSpacing: -0.3 }}>{st?.headline ?? "Loading the market state…"}</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {r?.available && <Chip k="Regime" v={`${QUADRANTS[r.id].short} ${r.probs[r.id]}%${r.contested ? " · contested" : ""}`} tone={REGIME_PALETTE[r.id]} />}
          {c?.band && <Chip k="Conditions" v={`${c.score} ${c.band.label}${c.trend ? ` · ${c.trend}` : ""}`} tone={bt} />}
          {st?.stage && <Chip k="Stage" v={`${st.stage.n} · ${st.stage.label}`} tone={TONE.info} />}
          {st?.sizing?.total != null && <Chip k="Size" v={`×${st.sizing.total.toFixed(2)}`} />}
          {st?.policy?.stance && <Chip k="Fed" v={`${st.policy.stance}${st.policy.next?.hikeOdds != null ? ` · hike ${Math.round(st.policy.next.hikeOdds)}%` : ""}`} tone={st.policy.stance === "tightening" ? TONE.bad : st.policy.stance === "easing" ? TONE.good : TONE.warn} />}
        </div>
        {st?.transitions?.[0] && (() => {
          const t = st.transitions[0];
          return (
            <div style={{ fontSize: 12.5, color: C.mid }}>
              <b style={{ color: C.text }}>Closest trigger:</b> {t.title} — {t.proximity >= 100 ? "triggered" : `${t.proximity}% of the way`}
              {t.nearest?.gapText ? <span style={{ fontFamily: MONO }}> · {t.nearest.label} {t.nearest.text} → {t.nearest.atText}, {t.nearest.gapText}</span> : null}{" "}
              <Delta5 v={t.delta5} good={t.tone === "good"} />
            </div>
          );
        })()}
        {error && <div style={{ fontSize: 12, color: C.red }}>The gauges did not load: {error}. The regime still reads from the indicators.</div>}
        {streetLabel && <div style={{ fontSize: 11.5, color: C.muted }}>The Street's consensus reads {streetLabel} — a cross-check under Smart Money, not an input here.</div>}
      </Card>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, alignItems: "start" }}>
        <RegimePanel r={r} />
        <ConditionsPanel c={c} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, alignItems: "start" }}>
        <PolicyPanel p={st?.policy} />
        {st && <PlanPanel st={st} legacy={legacySizing} />}
      </div>
      <IfThen list={st?.transitions} asOf={c?.date ?? null} />
    </div>
  );
}

// ── DRIVERS ──────────────────────────────────────────────────────────────────
const fmtVal = (s) => {
  if (s.value == null) return "—";
  if (s.kind === "rate") return `${s.value.toFixed(2)}%`;
  if (s.kind === "usd") return `$${Math.round(s.value).toLocaleString()}bn`;
  return `${s.unit === "$" ? "$" : ""}${s.value.toFixed(2)}`;
};
const fmtChg = (s, v) => {
  if (v == null) return "—";
  if (s.chgUnit === "bp") return `${sgn(v)}bp`;
  if (s.chgUnit === "%") return `${sgn(v, 1)}%`;
  return `${sgn(v)}bn`;
};
export function DriverTile({ s, health }) {
  const per = s.cadence === "weekly" ? "w" : "d";
  return (
    <div style={{ background: C.surf, border: "1.5px solid " + C.bdr, borderRadius: 10, padding: "10px 11px", display: "grid", gap: 5, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: C.text }}>{s.label}</span>
        <span style={{ fontSize: 10, color: C.lbl }}>{fmtDay(s.date)}</span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 19, fontWeight: 900, color: C.text, fontFamily: MONO }}>{fmtVal(s)}</span>
        {(health?.status === "stale" || health?.status === "late") && <StaleChip>{health.age}d</StaleChip>}
      </div>
      <div style={{ display: "flex", gap: 10, fontSize: 11, fontFamily: MONO, color: C.mid, flexWrap: "wrap" }}>
        <span>5{per} {fmtChg(s, s.chg5)}</span><span>20{per} {fmtChg(s, s.chg20)}</span>
      </div>
      <Spark values={s.spark} height={28} />
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 6, alignItems: "center" }}>
        <Bar pct={s.pctile} color={C.blue} height={5} marks={[50]} />
        <span style={{ fontSize: 10, color: C.muted, fontFamily: MONO }}>{s.pctile != null ? `${s.pctile}th pct` : "—"}</span>
      </div>
      <div style={{ fontSize: 9.5, color: C.lbl }}>{s.src}</div>
    </div>
  );
}

// One group: header (the conditions component it feeds, or the regime axis), tiles, then the deep
// panels folded. `deep` is [{ title, hint, render }].
export function DriverGroup({ g, st, stats, health, deep = [], extra = null }) {
  const comp = g.comp ? st?.conditions?.components?.[g.comp] : null;
  const ax = g.axis && st?.regime?.available ? st.regime[g.axis] : null;
  const tiles = g.series.filter(k => stats?.[k]);
  const hmap = Object.fromEntries((health || []).map(h => [h.key, h]));
  return (
    <section id={`drivers-${g.id}`} style={{ display: "grid", gap: 10, scrollMarginTop: 96 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", borderBottom: "1.5px solid " + C.bdr, paddingBottom: 6 }}>
        <span style={{ fontSize: 16, fontWeight: 900, color: C.text }}>{g.label}</span>
        {comp && <Chip k="Stress" v={`${comp.score}`} tone={bandTone(scoreBand(comp.score))} title={comp.read} />}
        {ax && <Chip k="Axis" v={`${sgn(ax.level, 2)} · drift ${sgn(ax.drift, 2)}`} title="level in [−1, 1]; drift = fast leg − slow leg" />}
        {ax && <span style={{ fontSize: 12, color: C.mid }}>{st.regime.words[g.axis]}</span>}
      </div>
      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>{g.lead}{comp ? ` Now: ${comp.read}.` : ""}</div>
      {extra}
      {tiles.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
          {tiles.map(k => <DriverTile key={k} s={stats[k]} health={hmap[k]} />)}
        </div>
      )}
      {deep.map(d => <Fold key={d.title} title={d.title} hint={d.hint}>{d.render()}</Fold>)}
    </section>
  );
}

export function DriversView({ st, feed, deep = {}, extra = {} }) {
  const stats = feed?.stats || {};
  const health = seriesHealth(stats);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <Eyebrow style={{ marginRight: 4 }}>Jump to</Eyebrow>
        {DRIVER_GROUPS.map(g => (
          <button key={g.id} onClick={() => { const el = typeof document !== "undefined" && document.getElementById(`drivers-${g.id}`); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }}
            style={{ cursor: "pointer", background: C.surf, color: C.mid, border: "1.5px solid " + C.bdr, borderRadius: 999, padding: "4px 11px", fontSize: 11.5, fontWeight: 700 }}>
            {g.label}
          </button>
        ))}
      </div>
      {!feed && <div style={{ fontSize: 12.5, color: C.muted }}>Loading the gauges…</div>}
      {DRIVER_GROUPS.map(g => <DriverGroup key={g.id} g={g} st={st} stats={stats} health={health} deep={deep[g.id] || []} extra={extra[g.id] || null} />)}
    </div>
  );
}

// ── DATA HEALTH ──────────────────────────────────────────────────────────────
const HEALTH_TONE = { fresh: TONE.good, late: TONE.warn, stale: TONE.bad, missing: TONE.bad };
export function FeedHealth({ feed, indErrors = [], indUpdated = null }) {
  const rows = seriesHealth(feed?.stats || {});
  const errs = [...(feed?.errors || []).map(e => ({ ...e, feed: "state" })), ...(indErrors || []).map(e => ({ ...e, feed: "indicators" }))];
  const counts = rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
  return (
    <Card style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
        <SLabel>Market-state gauges</SLabel>
        <span style={{ fontSize: 11.5, color: C.muted }}>
          fetched {fmtWhen(feed?.at)} · {feed?.source === "kv" ? "from the half-hour cache" : feed?.source === "stale" ? "last good copy (refresh failed)" : feed?.source === "live" ? "live" : "—"}
          {indUpdated ? ` · indicators ${fmtWhen(indUpdated)}` : ""}
        </span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {["fresh", "late", "stale", "missing"].filter(k => counts[k]).map(k => <Chip key={k} v={`${counts[k]} ${k}`} tone={HEALTH_TONE[k]} />)}
      </div>
      {errs.length > 0 && (
        <div style={{ padding: "8px 11px", background: C.rBg, border: "1px solid " + C.rBdr, borderRadius: 8, fontSize: 12, color: C.red, lineHeight: 1.5 }}>
          <b>{errs.length} feed{errs.length > 1 ? "s" : ""} failed.</b> A blank reading below is a failed request, not an unpublished figure.
          <div style={{ fontFamily: MONO, fontSize: 11, color: C.mid, marginTop: 4 }}>{errs.map((e, i) => <div key={i}>{e.feed} · {e.series} — {e.error || "unknown"}</div>)}</div>
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 480, fontSize: 12.5 }}>
          <thead>
            <tr>{["Series", "Source", "Cadence", "Last obs", "Age", ""].map(h => <th key={h} style={{ textAlign: "left", padding: "6px 8px", fontSize: 10, letterSpacing: 0.8, textTransform: "uppercase", color: C.lbl, borderBottom: "1.5px solid " + C.bdr }}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key}>
                <td style={{ padding: "5px 8px", borderBottom: "1px solid " + C.bdr, fontWeight: 700, color: C.text }}>{r.label}</td>
                <td style={{ padding: "5px 8px", borderBottom: "1px solid " + C.bdr, color: C.muted }}>{r.src}</td>
                <td style={{ padding: "5px 8px", borderBottom: "1px solid " + C.bdr, color: C.muted }}>{r.cadence}</td>
                <td style={{ padding: "5px 8px", borderBottom: "1px solid " + C.bdr, fontFamily: MONO }}>{r.date ?? "—"}</td>
                <td style={{ padding: "5px 8px", borderBottom: "1px solid " + C.bdr, fontFamily: MONO }}>{r.age != null ? `${r.age}d` : "—"}</td>
                <td style={{ padding: "5px 8px", borderBottom: "1px solid " + C.bdr }}><Chip v={r.status} tone={HEALTH_TONE[r.status]} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5 }}>Daily series are fresh to 4 calendar days (a weekend and FRED's one-to-two-day lag on the credit indices) and stale past 7; weekly ones fresh to 9 and stale past 16. The term premium is daily data that FRED posts in a weekly batch, so it is judged as weekly.</div>
    </Card>
  );
}

// ── STREET ── the measured regime beside the Street's, as a cross-check.
export function StreetCompare({ st, street }) {
  const r = st?.regime;
  const topM = r?.available ? r.id : null, topS = street?.id ?? null;
  const agree = topM && topS ? topM === topS : null;
  return (
    <Card style={{ display: "grid", gap: 10, borderLeft: "4px solid " + (agree == null ? C.bdr : agree ? C.green : C.amber) }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
        <SLabel>Measured vs the Street</SLabel>
        {agree != null && <Chip v={agree ? "agree" : "disagree"} tone={agree ? TONE.good : TONE.warn} />}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 54px 54px", gap: "5px 10px", alignItems: "center", fontSize: 12.5 }}>
        <span style={{ fontSize: 10, color: C.lbl, fontWeight: 800, letterSpacing: 0.8, textTransform: "uppercase" }}>Quadrant</span>
        <span style={{ fontSize: 10, color: C.lbl, fontWeight: 800, letterSpacing: 0.8, textTransform: "uppercase", textAlign: "right" }}>Measured</span>
        <span style={{ fontSize: 10, color: C.lbl, fontWeight: 800, letterSpacing: 0.8, textTransform: "uppercase", textAlign: "right" }}>Street</span>
        {QORDER.map(id => (
          <span key={id} style={{ display: "contents" }}>
            <span style={{ color: REGIME_PALETTE[id].color, fontWeight: 700 }}>{QUADRANTS[id].label}</span>
            <span style={{ fontFamily: MONO, textAlign: "right", fontWeight: id === topM ? 900 : 500 }}>{r?.available ? `${r.probs[id]}%` : "—"}</span>
            <span style={{ fontFamily: MONO, textAlign: "right", fontWeight: id === topS ? 900 : 500 }}>{street?.probs?.[id] != null ? `${street.probs[id]}%` : "—"}</span>
          </span>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.5 }}>
        Measured: the growth and inflation axes, from market prices, weekly data and prints. Street: the regime implied by the named houses' recession odds and live CPI{street?.vintage ? ` (${street.vintage})` : ""}.
        The Street view is a cross-check — when the two disagree, the measured one is what the tape is doing and the Street's is what the houses expect.
      </div>
    </Card>
  );
}

// ── CROSS-CHECK SOURCES ── the status of each source behind the read-only cross-check JSON (served
// under the gamma feed's slug). Statuses only; the data is not fetched to the dashboard.
const XC_LABEL = {
  credit: "HY OAS (FRED)", real_yields: "10Y TIPS + breakeven (FRED)", term_premium: "ACM term premium (NY Fed)",
  breadth: "RSP / SPY", auctions: "Treasury auctions", positioning: "CFTC COT", gamma_independent: "DIX / GEX (SqueezeMetrics)",
  sentiment_aaii: "AAII sentiment", put_call: "Put/call (Cboe)",
};
export function CrossCheckHealth({ xc }) {
  if (!xc) return null;
  const rows = Object.entries(xc.blocks || {});
  return (
    <Card style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
        <SLabel>Cross-check sources</SLabel>
        <span style={{ fontSize: 11.5, color: C.muted }}>{xc.ok ? `checked ${fmtWhen(xc.at)}` : `not loaded${xc.error ? ` — ${xc.error}` : ""}`}</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 420, fontSize: 12.5 }}>
          <tbody>
            {rows.map(([k, b]) => (
              <tr key={k}>
                <td style={{ padding: "5px 8px", borderBottom: "1px solid " + C.bdr, fontWeight: 700, color: C.text }}>{XC_LABEL[k] || k}</td>
                <td style={{ padding: "5px 8px", borderBottom: "1px solid " + C.bdr, fontFamily: MONO }}>{b.as_of ?? "—"}</td>
                <td style={{ padding: "5px 8px", borderBottom: "1px solid " + C.bdr }}><Chip v={b.status} tone={b.status === "fresh" ? TONE.good : b.status === "stale" ? TONE.warn : TONE.bad} /></td>
                <td style={{ padding: "5px 8px", borderBottom: "1px solid " + C.bdr, color: C.muted, fontSize: 11.5 }}>{b.error || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5 }}>The sources the Current Market Read cross-checks against, fetched and cached server-side. Stale means older than its publication lag plus one and a half cadences.</div>
    </Card>
  );
}
