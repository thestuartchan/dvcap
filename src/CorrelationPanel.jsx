// src/CorrelationPanel.jsx — COR1M, VIXEQ − VIX and DSPX beside the volatility drivers
// (Market Watch › Drivers › Volatility). Information only: it feeds no score and blocks nothing.
//
// Each row: the latest close and its date, the 5- and 20-session change in points, where today
// sits in the past year, the previous 60 sessions' range with a marker when today's close is
// outside it, and a sparkline of those 60 sessions with the range shaded. Colours follow the rule
// the rest of the dashboard uses — red bad, green good — with the benchmark named in the read.
// The numbers and the colour rules are lib/impliedCorrelation.js; the data is Cboe's own daily
// history (/api/indicators?impliedcorr=1), and the footer says which source answered and when.
import { useEffect, useState } from "react";
import { C, alpha } from "./theme.js";

const TONE = { bad: C.red, good: C.green, neutral: C.muted };
const pts = (v) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`);
const day = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "—");

function Spark({ values, lo, hi, colour }) {
  const W = 120, H = 30, pad = 2;
  const all = [...values, lo, hi];
  const min = Math.min(...all), max = Math.max(...all), span = max - min || 1;
  const x = (i) => pad + (i / Math.max(1, values.length - 1)) * (W - 2 * pad);
  const y = (v) => H - pad - ((v - min) / span) * (H - 2 * pad);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: 120, height: 30, display: "block", flex: "none" }} role="img" aria-label="last 60 sessions, with the prior 60-day range shaded">
      <rect x={pad} y={y(hi)} width={W - 2 * pad} height={Math.max(1, y(lo) - y(hi))} fill={alpha(C.muted, 0.14)} />
      <path d={line} fill="none" stroke={colour} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r="2.4" fill={colour} />
    </svg>
  );
}

function Row({ r }) {
  if (!r.available) {
    return (
      <div style={{ padding: "8px 0", borderTop: "1px solid " + C.bdr, fontSize: 12.5 }}>
        <b style={{ color: C.text }}>{r.label}</b>
        <span style={{ color: C.muted }}> · not available — {r.reason}</span>
      </div>
    );
  }
  const col = TONE[r.tone] || C.muted;
  const stat = (k, v) => <span><span style={{ color: C.lbl, fontWeight: 700, fontSize: 10.5 }}>{k} </span><b style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>{v}</b></span>;
  return (
    <div style={{ padding: "9px 0", borderTop: "1px solid " + C.bdr, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 260px", minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <b style={{ fontSize: 13, color: C.text }}>{r.label}</b>
          <b style={{ fontSize: 15, color: col, fontVariantNumeric: "tabular-nums" }}>{r.latest.toFixed(2)}{r.unit}</b>
          <span style={{ fontSize: 11, color: C.muted }}>{day(r.date)}</span>
          {r.brk && (
            <span title="today's close is outside the previous 60 sessions' range"
              style={{ fontSize: 10.5, fontWeight: 800, color: col, border: "1px solid " + col, borderRadius: 999, padding: "0 7px" }}>
              {r.brk === "above" ? "▲ above" : "▼ below"} 60-day range
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11.5, marginTop: 3 }}>
          {stat("5d", pts(r.ch5))}{stat("20d", pts(r.ch20))}{stat("1y pct", `${r.pct1y}%`)}
          {stat("60d range", `${r.range60.lo.toFixed(2)}–${r.range60.hi.toFixed(2)}`)}
          {r.parts && <span style={{ color: C.muted }}>VIXEQ {r.parts.vixeq?.toFixed(2)} − VIX {r.parts.vix?.toFixed(2)}</span>}
        </div>
        <div style={{ fontSize: 12, color: col === C.muted ? C.mid : col, marginTop: 3 }}>{r.read}</div>
      </div>
      <Spark values={r.spark} lo={r.range60.lo} hi={r.range60.hi} colour={col} />
    </div>
  );
}

export function CorrelationPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/indicators?impliedcorr=1")
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(j => { if (!cancelled) setData(j); })
      .catch(e => { if (!cancelled) setErr(String(e.message || e)); });
    return () => { cancelled = true; };
  }, []);
  const src = data?.sources ? Object.entries(data.sources).map(([k, v]) => (v.source ? `${k} ${v.source} ${day(v.asOf)}` : `${k} not available`)).join(" · ") : null;
  return (
    <div style={{ border: "1px solid " + C.bdr, borderRadius: 10, padding: "10px 12px", background: C.surf, marginTop: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginBottom: 4 }}>
        <b style={{ fontSize: 13.5, color: C.text }}>Correlation &amp; dispersion</b>
        <span style={{ fontSize: 11.5, color: C.muted }}>
          an index can look calm because its stocks are offsetting; the risk sign is correlation rising, or the gap closing, while VIX rises
        </span>
      </div>
      {!data && !err && <div style={{ fontSize: 12, color: C.muted }}>reading Cboe…</div>}
      {err && <div style={{ fontSize: 12, color: C.amber }}>not available — {err}</div>}
      {data?.rows?.map(r => <Row key={r.id} r={r} />)}
      {data && (
        <div style={{ fontSize: 10.5, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>
          Red = bad, green = good; the range is the previous 60 sessions. Information only — not part of the regime score
          (it has not shown an effect beyond VIX in the backtest). Source: {src || "—"}.
        </div>
      )}
    </div>
  );
}
