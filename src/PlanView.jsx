// src/PlanView.jsx — the Playbook's Plan tab: what to hold, given the measured state, and what
// changes if each transition happens.
//
// Posture is a regime × conditions grid (lib/plan.js). Between regimes the plan is the
// probability-weighted blend, so a close call is planned between the cases rather than on
// whichever one is a point ahead today. The stage is the one derivation (lib/marketState.js stage),
// and every if/then carries the posture and size it would lead to — decided now, not in the moment.
import { useState, useMemo } from "react";
import { C, alpha } from "./theme.js";
import { Card } from "./ui.jsx";
import { REGIME_PALETTE } from "../lib/regimes.js";
import { QUADRANTS, STAGES, CONDITION_SIZING } from "../lib/marketState.js";
import { REGIME_KEYS, BAND_KEYS, BUCKETS, postureGrid, blendedPosture, transitionPlan, midOf } from "../lib/plan.js";
import { Chip, ClosestCallout, Delta5 } from "./MarketState.jsx";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const BAND_LABEL = { calm: "Calm", caution: "Caution", stress: "Stress", crisis: "Crisis" };
const BAND_COLOR = { calm: C.green, caution: C.amber, stress: C.orange, crisis: C.red };
const REGIME_ABBR = { ref: "Refl", inf: "Infl", stag: "Stag", def: "Defl" };
const BUCKET_SHORT = { cash: "Cash", insurance: "Hedges", income: "Income", longTermHolds: "Core", deploymentReady: "Deploy" };
const TONE = { bad: C.red, warn: C.amber, good: C.green };
const pp = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}pp`;
const pct = (v) => (v == null ? "—" : `${Number.isInteger(v) ? v : v.toFixed(1)}%`);

function Eyebrow({ children }) {
  return <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, textTransform: "uppercase", color: C.lbl }}>{children}</div>;
}

// One bucket of the blended posture: the blended range, then each regime's range at its weight.
function BucketCard({ meta, b, grid, probs, band, statusTone, fillNote, pv, onGo }) {
  const lead = b?.lead;
  const tone = statusTone(lead?.status);
  const usd = (v) => (pv > 0 ? "$" + Math.round(pv * v / 100).toLocaleString("en-US") : null);
  return (
    <Card onClick={meta.link ? () => onGo(meta.link) : undefined}
      style={{ borderTop: "4px solid " + (tone?.color || C.bdr), cursor: meta.link ? "pointer" : "default", minWidth: 0, display: "grid", gap: 7, alignContent: "start", padding: "13px 14px" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 900, color: C.text }}>{meta.icon} {meta.name}</span>
        {lead?.status && <span style={{ fontSize: 10, fontWeight: 900, letterSpacing: 0.5, color: tone?.color, background: tone?.bg, border: "1px solid " + (tone?.bdr || C.bdr), borderRadius: 5, padding: "1px 6px" }}>{lead.status}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 24, fontWeight: 900, color: C.text, fontFamily: MONO }}>{b ? pct(b.mid) : "—"}</span>
        {b && <span style={{ fontSize: 11.5, color: C.muted, fontFamily: MONO }}>{pct(b.lo)}–{pct(b.hi)}</span>}
      </div>
      {b && pv > 0 && <div style={{ fontSize: 11, color: C.muted, fontFamily: MONO }}>{usd(b.lo)} – {usd(b.hi)}</div>}
      <div style={{ display: "grid", gap: 3 }}>
        {REGIME_KEYS.map(r => {
          const range = grid[r]?.[band]?.[meta.key]?.range;
          const p = probs?.[r] ?? 0;
          return (
            <div key={r} title={QUADRANTS[r].label} style={{ display: "grid", gridTemplateColumns: "34px minmax(0, 1fr) 30px", gap: 6, alignItems: "center", fontSize: 10.5, fontFamily: MONO, opacity: p >= 10 ? 1 : 0.55 }}>
              <span style={{ color: REGIME_PALETTE[r].color, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{REGIME_ABBR[r]}</span>
              <span style={{ color: C.mid, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{range ?? "—"}</span>
              <span style={{ color: C.muted, textAlign: "right" }}>{p}%</span>
            </div>
          );
        })}
      </div>
      {lead?.note && (
        <details onClick={(e) => e.stopPropagation()}>
          <summary style={{ cursor: "pointer", fontSize: 11.5, color: C.blue, fontWeight: 700 }}>{QUADRANTS[b.leadRegime || "def"]?.short ?? ""} note</summary>
          <div style={{ fontSize: 12, color: C.mid, lineHeight: 1.55, marginTop: 4 }}>{fillNote(lead.note)}</div>
        </details>
      )}
    </Card>
  );
}

// The grid itself: regimes down, bands across; each cell a stacked bar of the five buckets.
function Matrix({ grid, probs, band, sel, onSel }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: "118px repeat(4, minmax(96px, 1fr))", gap: 6, minWidth: 520 }}>
        <span />
        {BAND_KEYS.map(b => (
          <span key={b} style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.8, textTransform: "uppercase", color: b === band ? BAND_COLOR[b] : C.lbl, textAlign: "center" }}>
            {BAND_LABEL[b]} ×{CONDITION_SIZING[b]}{b === band ? " · now" : ""}
          </span>
        ))}
        {REGIME_KEYS.map(r => (
          <span key={r} style={{ display: "contents" }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: REGIME_PALETTE[r].color, alignSelf: "center" }}>
              {QUADRANTS[r].short}<span style={{ color: C.muted, fontWeight: 600, fontFamily: MONO }}> {probs?.[r] ?? "—"}%</span>
            </span>
            {BAND_KEYS.map(b => {
              const cell = grid[r][b];
              const on = sel && sel.r === r && sel.b === b;
              const live = b === band;
              const mids = BUCKETS.map(k => midOf(cell[k]?.range) ?? 0);
              const tot = mids.reduce((a, x) => a + x, 0) || 1;
              return (
                <button key={b} onClick={() => onSel({ r, b })} aria-pressed={on} title={`${QUADRANTS[r].label} · ${BAND_LABEL[b]}`}
                  style={{ cursor: "pointer", borderRadius: 8, padding: "6px 7px", display: "grid", gap: 4, textAlign: "left", color: C.text,
                    background: live ? alpha(REGIME_PALETTE[r].color, 0.05 + ((probs?.[r] ?? 0) / 100) * 0.45) : C.surf,
                    border: (on ? "2px solid " + C.blue : "1px solid " + (live ? C.bdrMd : C.bdr)) }}>
                  <div style={{ display: "flex", height: 7, borderRadius: 3, overflow: "hidden" }}>
                    {mids.map((m, i) => <span key={i} style={{ width: (m / tot * 100) + "%", background: alpha(C.text, 0.85 - i * 0.16) }} />)}
                  </div>
                  <span style={{ fontSize: 10.5, fontFamily: MONO, color: C.mid }}>cash {pct(mids[0])} · hdg {pct(mids[1])}</span>
                  {cell.tilt && <span style={{ fontSize: 9.5, color: BAND_COLOR[b], fontWeight: 800 }}>+{cell.tilt.find(t => t.bucket === "cash")?.delta ?? 0} cash · +{cell.tilt.find(t => t.bucket === "insurance")?.delta ?? 0} hdg</span>}
                  {cell.tuned && <span style={{ fontSize: 9.5, color: C.blue, fontWeight: 800 }}>TUNED</span>}
                </button>
              );
            })}
          </span>
        ))}
      </div>
    </div>
  );
}

function CellDetail({ cell, meta, statusTone, fillNote }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>{QUADRANTS[cell.regime].label} · {BAND_LABEL[cell.band]}</div>
      {meta.map(m => {
        const a = cell[m.key];
        const t = statusTone(a?.status);
        return (
          <div key={m.key} style={{ display: "grid", gridTemplateColumns: "110px 70px minmax(0, 1fr)", gap: 8, fontSize: 12, alignItems: "baseline", borderTop: "1px solid " + C.bdr, paddingTop: 5 }}>
            <span style={{ fontWeight: 700, color: C.text }}>{m.icon} {m.name}</span>
            <span style={{ fontFamily: MONO, color: t?.color || C.mid, fontWeight: 800 }}>{a?.range ?? "—"}</span>
            <span style={{ color: C.mid, lineHeight: 1.5 }}><b style={{ color: t?.color || C.mid, fontSize: 10.5 }}>{a?.status}</b> {a?.note ? fillNote(a.note) : ""}</span>
          </div>
        );
      })}
      {cell.tilt && (
        <div style={{ fontSize: 12, color: BAND_COLOR[cell.band], fontWeight: 700, lineHeight: 1.5 }}>
          {BAND_LABEL[cell.band]} tilt on the {QUADRANTS[cell.regime].short.toLowerCase()} allocation: {cell.tilt.map(t => `${BUCKET_SHORT[t.bucket].toLowerCase()} ${pp(t.delta)}`).join(", ")}.
          <span style={{ color: C.muted, fontWeight: 500 }}> Deployment money funds it first, then core and income in proportion; the notes below are the regime's.</span>
        </div>
      )}
      {cell.categoryNote && <div style={{ fontSize: 11.5, color: C.muted }}>{cell.categoryNote}</div>}
    </div>
  );
}

export function PlanView({ st, allocations, bucketMeta, statusTone, fillNote = (s) => s, portfolioValue = "", onGo = () => {} }) {
  const grid = useMemo(() => postureGrid(allocations), [allocations]);
  const probs = st?.regime?.available ? st.regime.probs : null;
  const band = st?.conditions?.band?.id ?? null;
  const blend = blendedPosture(grid, probs, band);
  const lead = blend?.lead ?? null;
  const [sel, setSel] = useState(null);
  const cellSel = sel ? grid[sel.r][sel.b] : (lead && band ? grid[lead][band] : null);
  const pv = parseFloat(portfolioValue) || 0;
  const plans = (st?.transitions || []).map(t => ({ t, p: transitionPlan(t, st, grid) }));

  if (!probs || !band) {
    return (
      <Card>
        <Eyebrow>The plan</Eyebrow>
        <div style={{ marginTop: 8, fontSize: 13, color: C.muted }}>
          Waiting for the measured state — {!probs ? "the regime has no read yet" : "the conditions score has not loaded"}. The previous Posture tab is under “previous layout”.
        </div>
      </Card>
    );
  }
  const buckets = Object.fromEntries(BUCKETS.map(k => [k, blend.buckets[k] ? { ...blend.buckets[k], leadRegime: lead } : null]));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ display: "grid", gap: 8, borderTop: "4px solid " + BAND_COLOR[band] }}>
        <Eyebrow>The plan · from the measured state</Eyebrow>
        <div style={{ fontSize: 20, fontWeight: 900, color: C.text, lineHeight: 1.25 }}>
          {st.regime.contested ? "Between regimes — planned on the blend" : `${QUADRANTS[st.regime.id].label} — planned on the blend`} at {BAND_LABEL[band]}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {REGIME_KEYS.map(r => <Chip key={r} k={QUADRANTS[r].short.split(" ")[0]} v={`${probs[r]}%`} tone={r === lead ? REGIME_PALETTE[r] : undefined} />)}
          {st.stage && <Chip k="Stage" v={`${st.stage.n} · ${st.stage.label}`} />}
          {st.sizing?.total != null && <Chip k="Size" v={`×${st.sizing.total.toFixed(2)}`} />}
        </div>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
          Each bucket is the probability-weighted range across the four regimes at today's conditions; the status and note are the leading regime's ({QUADRANTS[lead].short}).
          In the grid below, Calm and Caution are each regime's allocation as written; Stress adds 5pp cash and 3pp hedges, Crisis 10pp and 6pp, funded from deployment first and then core and income.
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        {bucketMeta.map(m => (
          <BucketCard key={m.key} meta={m} b={buckets[m.key]} grid={grid} probs={probs} band={band}
            statusTone={statusTone} fillNote={fillNote} pv={pv} onGo={onGo} />
        ))}
      </div>

      <Card style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
          <Eyebrow>Posture by regime × conditions</Eyebrow>
          <span style={{ fontSize: 11, color: C.muted }}>today's column shaded by probability · pick a cell for its detail</span>
        </div>
        <Matrix grid={grid} probs={probs} band={band} sel={sel || (lead ? { r: lead, b: band } : null)} onSel={setSel} />
        <div style={{ fontSize: 10.5, color: C.lbl, fontFamily: MONO }}>bar: {BUCKETS.map(k => BUCKET_SHORT[k]).join(" · ")}</div>
        {cellSel && <CellDetail cell={cellSel} meta={bucketMeta} statusTone={statusTone} fillNote={fillNote} />}
      </Card>

      <Card style={{ display: "grid", gap: 8 }}>
        <Eyebrow>Stage</Eyebrow>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
          {STAGES.map(s => {
            const on = st.stage?.n === s.n;
            return (
              <div key={s.n} style={{ borderRadius: 9, padding: "9px 11px", border: (on ? "2px solid " + C.blue : "1px solid " + C.bdr), background: on ? C.blBg : "transparent" }}>
                <div style={{ fontSize: 11, fontFamily: MONO, fontWeight: 800, color: on ? C.blue : C.muted }}>STAGE {s.n}{on ? " · NOW" : ""}</div>
                <div style={{ fontSize: 14, fontWeight: 800, color: C.text }}>{s.label}</div>
                <div style={{ fontSize: 12, color: C.mid, lineHeight: 1.5, marginTop: 2 }}>{s.plan}</div>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.5 }}>
          From the conditions score: Calm → 1, Caution → 2, Stress or Crisis → 3, and Deploy once a 20-session peak of 70+ has eased 15 points and is still easing. One derivation, read by every tab.
        </div>
      </Card>

      <Card style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
          <Eyebrow>If / then — what changes, decided now</Eyebrow>
          <span style={{ fontSize: 11, color: C.muted }}>live · closest first</span>
        </div>
        <ClosestCallout list={st.transitions} asOf={st.conditions?.date ?? null} />
        {plans.map(({ t, p }) => (
          <div key={t.id} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "6px 14px", padding: "9px 11px", borderRadius: 9, border: "1px solid " + C.bdr, borderLeft: "4px solid " + (TONE[t.tone] || C.blue) }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontSize: 13.5, fontWeight: 800, color: C.text }}>{t.title}</span>
                <span style={{ fontSize: 11, fontFamily: MONO, fontWeight: 800, color: TONE[t.tone] || C.blue }}>{t.proximity >= 100 ? "TRIGGERED" : `${t.proximity}%`}</span>
                <Delta5 v={t.delta5} good={t.tone === "good"} />
              </div>
              <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.45, marginTop: 2 }}>when {t.trigger}</div>
              {t.nearest?.gapText && <div style={{ fontSize: 11.5, color: C.mid, fontFamily: MONO, marginTop: 2 }}>{t.nearest.label} {t.nearest.text} → {t.nearest.atText} · {t.nearest.gapText}</div>}
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignContent: "flex-start" }}>
              {p.to.regime && <Chip k="Regime" v={QUADRANTS[p.to.regime].short} tone={REGIME_PALETTE[p.to.regime]} />}
              {p.to.band && p.to.band !== band && <Chip k="Conditions" v={BAND_LABEL[p.to.band]} />}
              {p.sizeFrom != null && p.sizeTo != null && p.sizeTo !== p.sizeFrom && <Chip k="Size" v={`×${p.sizeFrom.toFixed(2)} → ×${p.sizeTo.toFixed(2)}`} />}
              {!p.moves.length && (p.sizeTo === p.sizeFrom || p.sizeTo == null) && <span style={{ fontSize: 11.5, color: C.muted }}>no allocation change</span>}
              {p.moves.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "1px 10px", fontSize: 11.5, fontFamily: MONO, width: "100%" }}>
                  {p.moves.map(m => (
                    <span key={m.bucket} style={{ display: "contents" }}>
                      <span style={{ color: C.muted }}>{BUCKET_SHORT[m.bucket]}</span>
                      <span style={{ color: C.text }}>{pct(m.from)} → {pct(m.to)} <b style={{ color: m.delta > 0 ? C.text : C.mid }}>({pp(m.delta)})</b></span>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.5, minWidth: 0 }}><b style={{ color: C.text }}>Then:</b> {t.plan}</div>
          </div>
        ))}
      </Card>
    </div>
  );
}
