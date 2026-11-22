// src/NoiseBandPanel.jsx — the noise-band intraday paper trial on QQQ (lib/noiseBand.js): one paper
// trade a session at most, scored after the close by the scheduler (lib/cronRouter.js noiseband-paper)
// through /api/atr?noiseband=1&write=1. Read-only. UW-derived, so behind the dashboard login.
import { useEffect, useState } from "react";
import { C } from "./theme.js";
import { Card, SLabel } from "./ui.jsx";

const pct = (x, d = 2) => (x == null || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`);
const usd = (x) => (x == null ? "—" : `$${Math.round(x).toLocaleString("en-US")}`);
const tone = (x) => (x == null ? C.mid : x >= 0 ? C.green : C.red);
const VERDICT_TONE = { collecting: C.mid, consistent: C.green, off: C.red };

function Stat({ label, value, color, sub }) {
  return (
    <div style={{ minWidth: 104 }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, color: C.lbl, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 800, color: color || C.text, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted }}>{sub}</div>}
    </div>
  );
}

export function NoiseBandPanel() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    fetch("/api/atr?noiseband=1", { credentials: "include" }).then(r => r.json())
      .then(j => (j?.ok ? setD(j) : setErr(j?.why || j?.reason || j?.error || "no answer")))
      .catch(e => setErr(String(e.message || e)));
  }, []);
  const rows = [
    ["Rule", "QQQ · close beyond the 09:30–09:45 range (+0.05%), the noise band (20 days × 1.25) and VWAP"],
    ["Checks", "10:00 → 14:00 every 10 min · first signal only · either direction"],
    ["Exit", "15:45 · no stop"],
    ["Fills", "next bar's open + 2bp · 0.4bp round trip"],
    ["Size", "1% daily vol ÷ 14-day realised vol · cap 4×"],
    ["Pass line", "after 40+ trades, mean above the backtest's lower 90% band (−0.15% at 40, −0.10% at 60)"],
  ];
  const head = (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 12, rowGap: 3, fontSize: 12, lineHeight: 1.45 }}>
        {rows.map(([k, v]) => [
          <div key={k} style={{ fontSize: 10.5, fontWeight: 800, color: C.lbl, textTransform: "uppercase", letterSpacing: 0.4, paddingTop: 1 }}>{k}</div>,
          <div key={k + "v"} style={{ color: C.mid }}>{v}</div>,
        ])}
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
        <b style={{ color: C.text }}>Backtest Jul 2022 – Nov 2026:</b> <b style={{ color: C.green }}>+0.09%</b> a trade · 56% hit · fires 66% of sessions ·
        a real edge still shows a negative 40–60-trade mean about 1 time in 4
      </div>
    </div>
  );
  const shell = (body) => <div style={{ marginTop: 14 }}><Card><SLabel>Paper trial — noise band (QQQ intraday)</SLabel>{head}{body}</Card></div>;
  if (err) return shell(<div style={{ color: C.amber, fontWeight: 700, fontSize: 12.5 }}>Could not load the ledger: {err}</div>);
  if (!d) return shell(<div style={{ color: C.muted, fontSize: 12.5 }}>Loading…</div>);
  const s = d.summary;
  if (!s?.started) return shell(<div style={{ color: C.mid, fontSize: 12.5 }}>Starts {s?.startDate}: the first session is scored after that day's close (16:25 ET).</div>);
  const recent = [...(d.days || [])].reverse().slice(0, 15);
  const td = { fontSize: 12, padding: "3px 8px 3px 0", fontVariantNumeric: "tabular-nums", color: C.text };
  const th = { textAlign: "left", fontSize: 10.5, color: C.lbl, fontWeight: 800, padding: "3px 8px 3px 0", textTransform: "uppercase" };
  return shell(
    <>
      <div style={{ fontSize: 13, fontWeight: 800, color: VERDICT_TONE[s.verdict.state], marginBottom: 10 }}>{s.verdict.text}</div>
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 10 }}>
        <Stat label="Trades" value={s.trades} sub={`${s.sessions} sessions · fired ${s.fireRate == null ? "—" : Math.round(s.fireRate * 100) + "%"}`} />
        <Stat label="Mean / trade" value={pct(s.mean)} color={tone(s.mean)} sub={`median ${pct(s.median)}`} />
        <Stat label="Hit" value={s.hit == null ? "—" : `${Math.round(s.hit * 100)}%`} sub={`${s.shorts} short · ${s.longs} long`} />
        <Stat label="Equity" value={usd(s.equity)} color={tone(s.totalReturn)} sub={`${pct(s.totalReturn, 1)} from $100,000`} />
        <Stat label="Worst drawdown" value={pct(s.maxDrawdown, 1)} color={s.maxDrawdown < -0.09 ? C.red : C.mid} />
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr><th style={th}>Session</th><th style={th}>Signal</th><th style={th}>At</th><th style={th}>Return</th><th style={th}>Size</th><th style={th}>Zone</th></tr></thead>
          <tbody>{recent.map((r) => (
            <tr key={r.date}>
              <td style={td}>{r.date}</td>
              <td style={{ ...td, fontWeight: 800, color: r.status === "trade" ? (r.d > 0 ? C.green : C.red) : C.muted }}>{r.status === "trade" ? (r.d > 0 ? "Long" : "Short") : r.status === "skipped" ? "half day" : "none"}</td>
              <td style={td}>{r.at || "—"}</td>
              <td style={{ ...td, color: tone(r.ret), fontWeight: 700 }}>{r.status === "trade" ? pct(r.ret) : "—"}</td>
              <td style={td}>{r.lev ? `${r.lev.toFixed(2)}×` : "—"}</td>
              <td style={{ ...td, color: C.muted }}>{r.zone || "—"}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>Last scored: {s.lastDate || "—"} · paper only, no orders</div>
    </>
  );
}
