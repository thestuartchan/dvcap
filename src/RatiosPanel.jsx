// src/RatiosPanel.jsx — seven ratios, each read for which side is WINNING (Market Watch → Ratios).
//
// Written for someone new to ratios: every card reads cold — what the line is, what rising and
// falling mean, what it is doing now in one sentence, and whether today broke out of its recent
// range. The arithmetic is lib/ratios.js; the closes come from the public history route
// (/api/atr?history=1), settled sessions only. Market data only — nothing here reads the book.
import { useEffect, useMemo, useState } from "react";
import { C, alpha } from "./theme.js";
import { Card } from "./ui.jsx";
import { CARDS, LEGS, LEGEND, buildCard, summaryLine } from "../lib/ratios.js";

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
          <div style={{ marginTop: 6, color: C.muted, fontSize: 12.5 }}>Each card's shaded band is where the ratio traded over the previous 60 sessions. A close outside it is a range break; the 1-year bar shows where today sits between the year's low (0%) and high (100%).</div>
        </div>
      )}
    </div>
  );
}

// ── THE CHART ── six months; the band behind it is, for each day, the range of the 60 sessions
// before that day — so a close outside it is visible as the line leaving the shading.
function RatioChart({ chart, colour, card }) {
  const W = 600, H = 132, pad = { l: 4, r: 46, t: 8, b: 18 };
  const vals = chart.flatMap(p => [p.v, p.hi, p.lo]);
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

function Chip({ s, card }) {
  const col = s.kind === "inside" ? C.muted : s.kind === "fast" ? C.orange
    : card.group === "ai" ? (s.kind === "above" ? C.blue : C.amber) : (s.kind === "above" ? C.green : C.red);
  return <span style={{ display: "inline-block", fontSize: 12, fontWeight: 800, color: col, background: s.kind === "inside" ? C.inset : alpha(col, 0.12),
    border: "1.5px solid " + (s.kind === "inside" ? C.bdr : alpha(col, 0.45)), borderRadius: 999, padding: "2px 10px" }}>{s.text}</span>;
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
          <RatioChart chart={s.chart} colour={colour} card={card} />
          <div style={{ fontSize: 14, color: C.text, lineHeight: 1.5 }}><b style={{ color: colour }}>NOW:</b> {b.now}</div>
          <div style={{ fontSize: 13, color: C.mid, lineHeight: 1.55 }}>
            <div>⬆ <b>Rising</b> = <Rich text={card.up} /></div>
            <div>⬇ <b>Falling</b> = <Rich text={card.down} /></div>
            <div style={{ marginTop: 4 }}><b style={{ color: C.text }}>Why you care:</b> {card.why}</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: "auto" }}>{b.status.map(x => <Chip key={x.kind} s={x} card={card} />)}</div>
          {b.base && <div style={{ fontSize: 11.5, color: C.muted }}>Basket: {card.den.join(", ")}, each indexed to 100 on {dayY(b.base)} and averaged; SMH indexed the same day.</div>}
        </div>
      )}
    </Card>
  );
}

function Group({ title, legend, swatches, cards }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", margin: "4px 2px 10px" }}>
        <span style={{ fontSize: 13, letterSpacing: 2, textTransform: "uppercase", fontWeight: 800, color: C.lbl }}>{title}</span>
        <span style={{ fontSize: 12.5, color: C.mid, display: "inline-flex", alignItems: "center", gap: 6 }}>
          {swatches.map(c => <span key={c} style={{ width: 12, height: 4, borderRadius: 2, background: c, display: "inline-block" }} />)}
          {legend}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 420px), 1fr))", gap: 14 }}>
        {cards.map(b => <RatioCard key={b.card.id} b={b} />)}
      </div>
    </div>
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
          <Card style={{ marginBottom: 16, padding: "12px 16px", background: C.metricBg }}>
            <div style={{ fontSize: 14.5, fontWeight: 800, color: C.text, lineHeight: 1.5 }}>{summaryLine(built)}</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>Daily closes through {dayY(built.find(b => b.stats)?.stats.date)} · rising and falling are the 20-day move · refreshed after the US close</div>
          </Card>
          <Group title="AI cycle" legend={LEGEND.ai} swatches={[C.blue, C.amber]} cards={built.filter(b => b.card.group === "ai")} />
          <Group title="Risk appetite" legend={LEGEND.risk} swatches={[C.green, C.red]} cards={built.filter(b => b.card.group === "risk")} />
        </>
      )}
    </div>
  );
}
