// src/RatiosPanel.jsx — seven ratios, each read for which side is WINNING (Market Watch → Ratios).
//
// Written for someone new to ratios: every card reads cold — what the line is, what rising and
// falling mean, what it is doing now in one sentence, and whether today broke out of its recent
// range. The arithmetic is lib/ratios.js; the closes come from the public history route
// (/api/atr?history=1), settled sessions only. Market data only — nothing here reads the book.
import { useEffect, useMemo, useState } from "react";
import { C, alpha } from "./theme.js";
import { Card } from "./ui.jsx";
import { CARDS, LEGS, LEGEND, buildCard, summaryRead, turning } from "../lib/ratios.js";
import { mergeBreakLogs, stageSummary, HELD_DAYS } from "../lib/ratioBreaks.js";

const TONE = { boom: C.blue, caution: C.amber, healthy: C.green, unhealthy: C.red, neutral: C.muted };
const signedPct = (v, dp = 1) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(dp)}%`);
const level = (v) => (v == null ? "—" : v >= 10 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toFixed(4));
const day = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "—");
const dayY = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
// The card copy marks emphasis the way the brief wrote it: *italic*, **bold**.
function Rich({ text }) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return <>{parts.map((p, i) => p.startsWith("**") ? <b key={i}>{p.slice(2, -2)}</b> : p.startsWith("*") ? <i key={i}>{p.slice(1, -1)}</i> : <span key={i}>{p}</span>)}</>;
}
// The colour a move takes on this card: the AI cards use the side that leads, the others health.
const moveColour = (card, v) => (v == null || v === 0 ? C.muted : card.group === "ai" ? (v > 0 ? C.blue : C.amber) : (v > 0 ? C.green : C.red));

// ── HOW TO READ A RATIO ── open for the first 30 days the panel is seen, then folded; a click
// either way is remembered.
const FIRST_KEY = "ratios_first_seen_v1", OPEN_KEY = "ratios_howto_open_v1";
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } } };
function initialHowTo() {
  const chosen = store.get(OPEN_KEY);
  if (chosen === "1" || chosen === "0") return chosen === "1";
  let first = store.get(FIRST_KEY);
  if (!first) { first = new Date().toISOString().slice(0, 10); store.set(FIRST_KEY, first); }
  return (Date.now() - Date.parse(first)) / 86400000 < 30;
}
function HowTo() {
  const [open, setOpen] = useState(initialHowTo);
  const toggle = () => { setOpen(o => { store.set(OPEN_KEY, o ? "0" : "1"); return !o; }); };
  return (
    <div style={{ border: "1.5px solid " + C.blBdr, background: C.blBg, borderRadius: 12, marginBottom: 14 }}>
      <button onClick={toggle} aria-expanded={open} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", padding: "11px 14px", cursor: "pointer", color: C.text, textAlign: "left" }}>
        <span style={{ fontSize: 15 }}>📏</span>
        <span style={{ fontWeight: 800, fontSize: 14 }}>How to read a ratio</span>
        <span style={{ marginLeft: "auto", color: C.blue, fontSize: 12.5, fontWeight: 700 }}>{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 14px 13px 39px", fontSize: 13.5, lineHeight: 1.6, color: C.mid }}>
          <div>A ratio divides one price by another, for example <b style={{ color: C.text }}>NVDA ÷ META</b>. The number itself is not interesting. <b style={{ color: C.text }}>Its direction is.</b></div>
          <div style={{ marginTop: 6 }}>⬆ <b style={{ color: C.text }}>Line rising:</b> the first one is beating the second (it went up more, or fell less).</div>
          <div>⬇ <b style={{ color: C.text }}>Line falling:</b> the second one is winning.</div>
          <div style={{ marginTop: 6 }}>Both can be falling in dollars while the ratio rises. The ratio only shows who is <i>winning</i>.</div>
          <div style={{ marginTop: 6 }}><b style={{ color: C.text }}>Colours:</b> <span style={{ color: C.blue, fontWeight: 700 }}>blue</span> or <span style={{ color: C.green, fontWeight: 700 }}>green</span> = the line is rising, the first name is winning; <span style={{ color: C.amber, fontWeight: 700 }}>amber</span> or <span style={{ color: C.red, fontWeight: 700 }}>red</span> = falling, the second name is winning. The AI cards use blue/amber because neither side is good or bad; the risk cards use green/red because rising is the healthier reading.</div>
          <div style={{ marginTop: 6, color: C.muted, fontSize: 12.5 }}>Each card's shaded band is where the ratio closed over the previous 60 sessions. A close outside it starts a break: <b>day 1</b>; <b>Confirmed</b> on a second close beyond the level it crossed (that level is frozen and drawn dashed, so a moving band cannot shift it); <b>Held</b> after 5 sessions without closing back inside. A close back inside before then is a <b>failed break</b>. A <i>window roll</i> tag means the band moved onto a flat ratio rather than the ratio moving. The 1-year bar shows where today sits between the year's low (0%) and high (100%).</div>
        </div>
      )}
    </div>
  );
}

// ── THE CHART ── six months; the band behind it is, for each day, the range of the 60 sessions
// before that day — so a close outside it is visible as the line leaving the shading.
function RatioChart({ chart, colour, card, track }) {
  const W = 600, H = 132, pad = { l: 4, r: 46, t: 8, b: 18 };
  // THE FROZEN LEVEL: a break is judged against the band edge it crossed on day 1, not the rolling
  // band, so the line it is measured against is drawn where it was set.
  const frozen = track?.level != null && track.stage && track.stage !== "inside" ? track.level : null;
  const vals = [...chart.flatMap(p => [p.v, p.hi, p.lo]), ...(frozen != null ? [frozen] : [])];
  let lo = Math.min(...vals), hi = Math.max(...vals); const m = (hi - lo) * 0.08 || hi * 0.01; lo -= m; hi += m;
  const X = (i) => pad.l + (i / Math.max(1, chart.length - 1)) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const line = chart.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
  const band = chart.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.hi).toFixed(1)}`).join("") +
    [...chart].reverse().map((p, j) => `L${X(chart.length - 1 - j).toFixed(1)},${Y(p.lo).toFixed(1)}`).join("") + "Z";
  const last = chart.at(-1);
  const months = []; chart.forEach((p, i) => { if (i && p.d.slice(5, 7) !== chart[i - 1].d.slice(5, 7)) months.push({ i, d: p.d }); });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label={`${card.formula}, six months, with its 60-day band`}>
      {months.map(mk => <g key={mk.d}><line x1={X(mk.i)} x2={X(mk.i)} y1={pad.t} y2={H - pad.b} stroke={C.bdr} strokeWidth="1" />
        <text x={X(mk.i) + 3} y={H - 5} fontSize="10.5" fill={C.muted}>{new Date(`${mk.d}T12:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}</text></g>)}
      <path d={band} fill={alpha(colour, 0.13)} stroke="none" />
      <path d={line} fill="none" stroke={colour} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
      {frozen != null && <g>
        <line x1={pad.l} x2={W - pad.r} y1={Y(frozen)} y2={Y(frozen)} stroke={C.text} strokeOpacity="0.7" strokeWidth="1.2" strokeDasharray="5 4" />
        <text x={pad.l + 4} y={Y(frozen) + (track.dir === "below" ? -4 : 12)} fontSize="10.5" fill={C.text} fillOpacity="0.85">break level {level(frozen)} (set {day(track.levelDate)})</text>
      </g>}
      <circle cx={X(chart.length - 1)} cy={Y(last.v)} r="3.6" fill={colour} stroke={C.surf} strokeWidth="1.5" />
      <text x={W - pad.r + 6} y={Y(hi - m) + 4} fontSize="10.5" fill={C.muted}>{level(hi - m)}</text>
      <text x={W - pad.r + 6} y={Y(lo + m) + 4} fontSize="10.5" fill={C.muted}>{level(lo + m)}</text>
    </svg>
  );
}

function YearBar({ s, colour }) {
  const p = Math.max(0, Math.min(1, s.yearPos));
  return (
    <div title={`1-year low ${level(s.yearLo)} (${day(s.yearLoDate)}) · high ${level(s.yearHi)} (${day(s.yearHiDate)}), on daily closes`} style={{ minWidth: 120, flex: "1 1 120px" }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: C.lbl }}>1-year range</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
        <div style={{ position: "relative", flex: 1, height: 8, background: C.inset, borderRadius: 4, border: "1px solid " + C.bdr }}>
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${p * 100}%`, background: alpha(colour, 0.45), borderRadius: 4 }} />
          <div style={{ position: "absolute", left: `calc(${p * 100}% - 1.5px)`, top: -3, bottom: -3, width: 3, borderRadius: 2, background: colour }} />
        </div>
        <b style={{ fontSize: 14, color: C.text, minWidth: 34, textAlign: "right" }}>{Math.round(p * 100)}%</b>
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>low {level(s.yearLo)} · high {level(s.yearHi)}</div>
    </div>
  );
}

const Metric = ({ label, value, colour, big }) => (
  <div style={{ minWidth: big ? 84 : 70 }}>
    <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: C.lbl }}>{label}</div>
    <div style={{ fontSize: big ? 22 : 17, fontWeight: 800, color: colour || C.text, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{value}</div>
  </div>
);

// THE STAGE CHIP: outlined on day 1, filled once confirmed, filled and heavier once held; a failed
// break is amber whichever way it went; the tag rides beside it, small and grey.
const dirColour = (card, dir) => (card.group === "ai" ? (dir === "above" ? C.blue : C.amber) : (dir === "above" ? C.green : C.red));
function Chip({ s, card }) {
  if (s.kind === "tag") return <span style={{ display: "inline-block", fontSize: 11, fontWeight: 700, color: C.muted, border: "1px solid " + C.bdr, borderRadius: 999, padding: "2px 8px" }}>{s.text}</span>;
  const col = s.kind === "inside" ? C.muted : s.kind === "fast" ? C.orange : s.kind === "failed" ? C.amber : s.kind === "ended" ? C.mid : dirColour(card, s.dir);
  const filled = s.kind === "confirmed" || s.kind === "held";
  return <span style={{ display: "inline-block", fontSize: 12, fontWeight: s.kind === "held" ? 900 : 800,
    color: filled ? C.surf : col, background: filled ? col : s.kind === "inside" ? C.inset : s.kind === "day1" ? "transparent" : alpha(col, 0.12),
    border: "1.5px solid " + (s.kind === "inside" ? C.bdr : filled ? col : alpha(col, 0.7)), borderRadius: 999, padding: "2px 10px" }}>{s.text}</span>;
}

function RatioCard({ b }) {
  const { card, stats: s, stale } = b;
  const colour = TONE[b.tone] || C.muted;
  return (
    <Card style={{ padding: 0, overflow: "hidden", opacity: stale ? 0.62 : 1, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "13px 16px 11px", borderBottom: "1px solid " + C.bdr, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: C.lbl }}>{card.n}</span>
        <span style={{ fontSize: 15.5, fontWeight: 800, color: C.text, flex: "1 1 auto" }}>{card.title}</span>
        <span style={{ fontSize: 12, color: C.muted, fontWeight: 600, textAlign: "right" }}>{card.formula}</span>
      </div>
      {stale ? (
        <div style={{ padding: "18px 16px", fontSize: 13.5, color: C.mid }}>
          <b>{stale.since ? `Data stale since ${dayY(stale.since)}` : "Data missing"}</b>
          {stale.legs?.length ? <span style={{ color: C.muted }}> · waiting on {stale.legs.join(", ")}</span> : null}
          <div style={{ marginTop: 6, fontSize: 12.5, color: C.muted }}>Nothing is computed from a leg that is behind, so this card stays blank until every price is current.</div>
        </div>
      ) : (
        <div style={{ padding: "12px 16px 14px", display: "flex", flexDirection: "column", gap: 10, flex: 1 }}>
          <div style={{ display: "flex", gap: 18, alignItems: "flex-end", flexWrap: "wrap" }}>
            <Metric label={`Level · ${day(s.date)}`} value={level(s.last)} big />
            <Metric label="5 days" value={signedPct(s.ch5)} colour={moveColour(card, s.ch5)} />
            <Metric label="20 days" value={signedPct(s.ch20)} colour={moveColour(card, s.ch20)} />
            <YearBar s={s} colour={colour} />
          </div>
          <RatioChart chart={s.chart} colour={colour} card={card} track={b.track} />
          <div style={{ fontSize: 14, color: C.text, lineHeight: 1.5 }}><b style={{ color: colour }}>NOW:</b> {b.now}
            {turning(s) && <div style={{ fontSize: 12.5, color: C.mid, marginTop: 2 }}>↻ {turning(s)}</div>}
          </div>
          <div style={{ fontSize: 13, color: C.mid, lineHeight: 1.55 }}>
            <div>⬆ <b>Rising</b> = <Rich text={card.up} /></div>
            <div>⬇ <b>Falling</b> = <Rich text={card.down} /></div>
            <div style={{ marginTop: 4 }}><b style={{ color: C.text }}>Why you care:</b> {card.why}</div>
          </div>
          <div style={{ marginTop: "auto" }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>{b.status.map(x => <Chip key={x.kind} s={x} card={card} />)}</div>
            {b.track?.note && ["day1", "confirmed", "held"].includes(b.track.stage) && <div style={{ fontSize: 12, color: C.muted, marginTop: 5 }}>{b.track.note}</div>}
          </div>
          {b.base && <div style={{ fontSize: 11.5, color: C.muted }}>Basket: {card.den.join(", ")}, each indexed to 100 on {dayY(b.base)} and averaged; SMH indexed the same day.</div>}
        </div>
      )}
    </Card>
  );
}

// The key: each colour named, in words, next to its swatch.
const Swatch = ({ c }) => <span style={{ width: 14, height: 4, borderRadius: 2, background: c, display: "inline-block", flex: "0 0 auto" }} />;
function Group({ title, legend, swatches, cards }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ margin: "4px 2px 10px" }}>
        <div style={{ fontSize: 13, letterSpacing: 2, textTransform: "uppercase", fontWeight: 800, color: C.lbl }}>{title}</div>
        <div style={{ display: "flex", gap: "4px 18px", flexWrap: "wrap", marginTop: 5, fontSize: 12.5, color: C.mid }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Swatch c={swatches[0]} />{legend.up}</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Swatch c={swatches[1]} />{legend.down}</span>
          {legend.note && <span style={{ color: C.muted }}>{legend.note}</span>}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 420px), 1fr))", gap: 14 }}>
        {cards.map(b => <RatioCard key={b.card.id} b={b} />)}
      </div>
    </div>
  );
}

// ── THE BREAK LOG ── every break, how far it got and what the ratio did next; the summary rows say
// which stage, if any, has been worth acting on. It informs and tests; it is not a rule.
const STAGE_LABEL = { day1: "Day 1", confirmed: "Confirmed", held: `Held ${HELD_DAYS}d` };
const fwdPct = (x) => (x == null ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(1)}%`);
function BreakLog({ built }) {
  const [open, setOpen] = useState(false);
  const [stored, setStored] = useState(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (!open || stored) return;
    let cancelled = false;
    fetch("/api/atr?ratios=1").then(r => (r.ok ? r.json() : null)).then(j => { if (!cancelled) setStored(j?.log || []); }).catch(() => { if (!cancelled) setStored([]); });
    return () => { cancelled = true; };
  }, [open, stored]);
  // The stored log, with this load's own reading merged in — the same merge the daily run makes.
  const log = useMemo(() => mergeBreakLogs(stored || [], built.flatMap(b => b.breaks || [])), [stored, built]);
  const summary = useMemo(() => stageSummary(log), [log]);
  const th = { textAlign: "left", fontWeight: 800, color: C.lbl, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, padding: "4px 8px", borderBottom: "1px solid " + C.bdr, whiteSpace: "nowrap" };
  const td = { padding: "4px 8px", borderBottom: "1px solid " + C.bdr, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
  const cont = (c) => (c ? `${c.pct}% (${c.n})` : "—");
  const rows = all ? log : log.slice(0, 40);
  return (
    <Card style={{ marginTop: 4, padding: 0 }}>
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", padding: "12px 16px", cursor: "pointer", color: C.text, textAlign: "left" }}>
        <span style={{ fontWeight: 800, fontSize: 14 }}>Break log</span>
        <span style={{ fontSize: 12.5, color: C.muted }}>{log.length} breaks over two years · how each stage has played out</span>
        <span style={{ marginLeft: "auto", color: C.blue, fontSize: 12.5, fontWeight: 700 }}>{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 16px 14px" }}>
          <div style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.55, marginBottom: 8 }}>
            Continued = the ratio was further in the break's direction that many sessions after day 1 (of the breaks with that many sessions behind them). Median d20 is signed so that positive means it continued. A break counts toward every stage it reached. These stages are a hypothesis being tested, not a rule.
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12.5, color: C.text, width: "100%" }}>
              <thead><tr><th style={th}>Stage</th><th style={th}>Tag</th><th style={th}>Breaks</th><th style={th}>Continued d10</th><th style={th}>Continued d20</th><th style={th}>Median d20</th></tr></thead>
              <tbody>{summary.map(r => (
                <tr key={r.stage + r.tag} style={{ color: r.tag === "all" ? C.text : C.mid, fontWeight: r.tag === "all" ? 800 : 500 }}>
                  <td style={td}>{r.tag === "all" ? STAGE_LABEL[r.stage] : ""}</td><td style={td}>{r.tag}</td><td style={td}>{r.n}</td>
                  <td style={td}>{cont(r.d10)}</td><td style={td}>{cont(r.d20)}</td><td style={td}>{fwdPct(r.medianD20)}</td>
                </tr>))}</tbody>
            </table>
          </div>
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12.5, color: C.text, width: "100%" }}>
              <thead><tr>{["Day 1", "Ratio", "", "Level", "Tag", "Reached", "Then", "d5", "d10", "d20", "SPY d20"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>{rows.map(b => (
                <tr key={`${b.ratio}|${b.direction}|${b.day1_date}`}>
                  <td style={td}>{dayY(b.day1_date)}</td><td style={td}>{b.ratio}</td><td style={td}>{b.direction === "below" ? "▼" : "▲"}</td>
                  <td style={td}>{level(b.break_level)}</td><td style={{ ...td, color: C.muted }}>{b.tag}</td><td style={td}>{STAGE_LABEL[b.reached]}</td>
                  <td style={{ ...td, color: C.muted }}>{b.failed_date ? `failed ${day(b.failed_date)}` : b.ended_date ? `ended ${day(b.ended_date)}` : b.superseded_date ? `new break ${day(b.superseded_date)}` : "live"}</td>
                  <td style={td}>{fwdPct(b.fwd_ratio_change?.d5)}</td><td style={td}>{fwdPct(b.fwd_ratio_change?.d10)}</td><td style={td}>{fwdPct(b.fwd_ratio_change?.d20)}</td>
                  <td style={{ ...td, color: C.muted }}>{fwdPct(b.fwd_spy_change?.d20)}</td>
                </tr>))}</tbody>
            </table>
          </div>
          {log.length > 40 && <button onClick={() => setAll(a => !a)} style={{ marginTop: 8, background: "none", border: "none", color: C.blue, fontWeight: 700, cursor: "pointer", fontSize: 12.5, padding: 0 }}>{all ? "Show the latest 40" : `Show all ${log.length}`}</button>}
        </div>
      )}
    </Card>
  );
}

// ── THE READ ── a headline, then per group: what is happening, and what it implies.
function Summary({ built }) {
  const r = summaryRead(built);
  return (
    <Card style={{ marginBottom: 16, padding: "13px 16px", background: C.metricBg }}>
      {r.headline && <div style={{ fontSize: 15.5, fontWeight: 800, color: C.text, lineHeight: 1.45 }}>{r.headline}</div>}
      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
        {r.rows.map(row => (
          <div key={row.key} style={{ display: "flex", gap: 10 }}>
            <span style={{ width: 4, borderRadius: 2, background: TONE[row.tone] || C.muted, flex: "0 0 auto" }} />
            <div style={{ fontSize: 13.5, lineHeight: 1.55, color: C.mid }}>
              <b style={{ color: C.text }}>{row.label}</b> <span style={{ color: TONE[row.tone] || C.muted, fontWeight: 700 }}>· {row.count}</span>
              <div style={{ color: C.text }}>{row.read}</div>
              <div><b style={{ color: C.text }}>So what:</b> {row.soWhat}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12.5, color: C.mid, marginTop: 10 }}>
        {r.breaks.length
          ? <><b style={{ color: C.text }}>Breaks:</b> {r.breaks.join(" · ")}<span style={{ color: C.muted }}> · day 1 = one close outside the previous 60 sessions' range; Confirmed = a second close beyond that level; Held = {HELD_DAYS} sessions without closing back inside.</span></>
          : "No breaks: every ratio closed inside its previous 60 sessions' range."}
        {r.stale ? ` ${r.stale} card${r.stale === 1 ? " is" : "s are"} waiting on data.` : ""}
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Daily closes through {dayY(built.find(b => b.stats)?.stats.date)} · rising and falling are the 20-day move · refreshed after the US close</div>
    </Card>
  );
}

export function RatiosPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/atr?history=1&range=2y&tickers=${encodeURIComponent(LEGS.join(","))}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`history ${r.status}`))))
      .then(j => { if (!cancelled) setData(j); })
      .catch(e => { if (!cancelled) setErr(String(e?.message || e)); });
    return () => { cancelled = true; };
  }, []);
  const built = useMemo(() => {
    if (!data?.symbols) return null;
    const closes = Object.fromEntries(Object.entries(data.symbols).map(([k, v]) => [k, v?.status === "ok" ? v.closes : []]));
    return CARDS.map(c => buildCard(c, closes));
  }, [data]);

  return (
    <div>
      <HowTo />
      {err && <Card style={{ marginBottom: 14, color: C.red }}>Couldn't load prices ({err}). Reload to try again.</Card>}
      {!built && !err && <Card style={{ marginBottom: 14, color: C.muted }}>Loading two years of daily closes…</Card>}
      {built && (
        <>
          <Summary built={built} />
          <Group title="AI cycle" legend={LEGEND.ai} swatches={[C.blue, C.amber]} cards={built.filter(b => b.card.group === "ai")} />
          <Group title="Risk appetite" legend={LEGEND.risk} swatches={[C.green, C.red]} cards={built.filter(b => b.card.group === "risk")} />
          <BreakLog built={built} />
        </>
      )}
    </div>
  );
}
