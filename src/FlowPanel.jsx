// src/FlowPanel.jsx — Unusual Whales flow (build step 8, lib/uw.js via /api/flow), under the Gamma
// board: Market Tide, QQQ/SPY net premium and NOPE, UW's GEX levels against dvcap's board, dark-pool
// levels and the latest flow alerts. Read-only. UW data is licensed for personal use: the route
// answers only the dashboard session, and nothing here is posted anywhere.
import { useEffect, useState, useCallback } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from "recharts";
import { C } from "./theme.js";
import { Card, SLabel } from "./ui.jsx";
import { gammaCrossCheck } from "../lib/uw.js";
import { dubaiEtStamp } from "../lib/timeFmt.js";

const usd = (v) => (v == null || !Number.isFinite(v) ? "—"
  : `${v < 0 ? "−" : "+"}$${Math.abs(v) >= 1e9 ? (Math.abs(v) / 1e9).toFixed(2) + "bn" : Math.abs(v) >= 1e6 ? (Math.abs(v) / 1e6).toFixed(1) + "M" : Math.round(Math.abs(v) / 1e3) + "k"}`);
const tone = (v) => (v == null ? C.mid : v > 0 ? C.green : v < 0 ? C.red : C.mid);
const lvl = (v) => (v == null || !Number.isFinite(v) ? "—" : (+v).toFixed(v >= 100 ? 0 : 2));

function Stat({ label, value, color, sub }) {
  return (
    <div style={{ minWidth: 104 }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, color: C.lbl, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 800, color: color || C.text, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted }}>{sub}</div>}
    </div>
  );
}

function Ticker({ sym, t, board }) {
  const cc = board ? gammaCrossCheck(t.gex, board, board.spot ?? t.spot) : null;
  const top = (t.alerts || []).slice().sort((a, b) => (b.premium || 0) - (a.premium || 0)).slice(0, 6);
  return (
    <div style={{ border: "1px solid " + C.bdr, borderRadius: 10, padding: 12, display: "grid", gap: 10, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <b style={{ fontSize: 16 }}>{sym}</b>
        <span style={{ fontSize: 11.5, color: C.muted }}>{t.spot != null ? `spot ${lvl(t.spot)}` : ""}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        <Stat label="Net premium" value={usd(t.netPrem?.net)} color={tone(t.netPrem?.net)} sub={t.netPrem ? `calls ${usd(t.netPrem.netCall)} · puts ${usd(t.netPrem.netPut)}` : "not available"} />
        <Stat label="NOPE" value={t.nope?.nope != null ? t.nope.nope.toFixed(2) : "—"} color={tone(t.nope?.nope)} sub="net options delta ÷ stock volume" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr", gap: "2px 12px", fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
        <span style={{ color: C.lbl, fontWeight: 700 }}>GEX</span><span style={{ color: C.lbl, fontWeight: 700 }}>UW (flow-weighted)</span><span style={{ color: C.lbl, fontWeight: 700 }}>dvcap board</span>
        <span style={{ color: C.muted }}>Call wall</span><span>{lvl(t.gex?.callWall)}</span><span>{lvl(board?.callWall)}</span>
        <span style={{ color: C.muted }}>Flip</span><span>{lvl(t.gex?.flip)}</span><span>{lvl(board?.flip)}</span>
        <span style={{ color: C.muted }}>Put wall</span><span>{lvl(t.gex?.putWall)}</span><span>—</span>
      </div>
      {cc && <div style={{ fontSize: 12, fontWeight: 700, color: cc.agree ? C.green : C.amber }}>
        {cc.agree ? "Both books agree within 0.5%" : `Books disagree: wall ${cc.wallGapPct ?? "—"}% · flip ${cc.flipGapPct ?? "—"}% of spot (both shown, neither overrides)`}
      </div>}
      {(t.darkpool || []).length > 0 && (
        <div style={{ fontSize: 12.5 }}>
          <div style={{ color: C.lbl, fontWeight: 700, marginBottom: 2 }}>Dark-pool levels</div>
          {t.darkpool.map(r => <div key={r.price} style={{ display: "flex", justifyContent: "space-between", fontVariantNumeric: "tabular-nums" }}>
            <span>{lvl(r.price)}</span><span style={{ color: C.muted }}>{Math.round(r.share * 100)}% of off-exchange volume</span></div>)}
        </div>
      )}
      {top.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
            <thead><tr style={{ color: C.lbl, textAlign: "left" }}><th>Alert</th><th>Premium</th><th>Side</th><th>Rule</th></tr></thead>
            <tbody>{top.map((a, i) => (
              <tr key={i} style={{ borderTop: "1px solid " + C.bdr }}>
                <td style={{ color: a.type === "put" ? C.red : C.green, fontWeight: 700 }}>{a.type} {lvl(a.strike)} {a.expiry ? a.expiry.slice(5) : ""}</td>
                <td>{usd(a.premium).replace("+", "")}</td>
                <td>{a.side || "—"}</td>
                <td style={{ color: C.muted }}>{a.rule}{a.sweep ? " · sweep" : ""}{a.floor ? " · floor" : ""}{a.opening ? " · opening" : ""}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function FlowPanel() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [boards, setBoards] = useState({});
  const load = useCallback((fresh) => {
    fetch(`/api/flow${fresh ? "?fresh=1" : ""}`, { credentials: "include" })
      .then(r => { if (r.status === 401) { setHidden(true); return null; } return r.json(); })
      .then(j => { if (!j) return; if (j.ok && j.snap) { setD(j.snap); setErr(null); } else setErr(j.why || j.error || "no answer"); })
      .catch(e => setErr(String(e.message || e)));
  }, []);
  useEffect(() => { load(false); }, [load]);
  // dvcap's own board for the cross-check (the same stored board the Gamma panel above reads).
  useEffect(() => {
    ["QQQ", "SPY"].forEach(s => fetch(`/api/gex?symbol=${s}`, { credentials: "include" }).then(r => r.json())
      .then(j => { const l = j?.latest; if (l) setBoards(b => ({ ...b, [s]: { callWall: l.callWall ?? null, flip: l.flipLevel ?? null, spot: l.spot ?? null } })); })
      .catch(() => {}));
  }, []);
  if (hidden) return null;
  const tide = d?.tide;
  const series = (tide?.series || []).map(p => ({ t: String(p.t).slice(11, 16), calls: p.c / 1e6, puts: p.p / 1e6 }));
  return (
    <Card style={{ marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <SLabel>🐋 Options flow · Unusual Whales</SLabel>
        <span style={{ fontSize: 11.5, color: C.muted }}>
          {d?.at ? `as of ${dubaiEtStamp(d.at)} · ${d.ok}/${d.of} sources` : err ? "" : "loading…"}
          {" "}<button type="button" onClick={() => load(true)} style={{ font: "inherit", fontSize: 11.5, border: "1px solid " + C.bdr, background: "transparent", color: C.text, borderRadius: 999, padding: "1px 10px", cursor: "pointer" }}>↻</button>
        </span>
      </div>
      {err && <div style={{ fontSize: 12.5, color: C.amber, marginTop: 6 }}>Flow not available: {err}</div>}
      {tide && (
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
            <Stat label="Market Tide" value={tide.lean === "calls" ? "Calls lead" : tide.lean === "puts" ? "Puts lead" : "Flat"} color={tone(tide.net)} sub={`net ${usd(tide.net)} · ${tide.date}`} />
            <Stat label="Net call premium" value={usd(tide.netCall)} color={tone(tide.netCall)} />
            <Stat label="Net put premium" value={usd(tide.netPut)} color={tone(-tide.netPut)} />
          </div>
          {series.length > 2 && (
            <div style={{ height: 150 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={C.bdr} strokeDasharray="2 4" />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: C.muted }} interval="preserveStartEnd" minTickGap={40} />
                  <YAxis tick={{ fontSize: 10, fill: C.muted }} width={44} tickFormatter={(v) => `${Math.round(v)}M`} />
                  <Tooltip formatter={(v, n) => [`$${(+v).toFixed(1)}M`, n]} />
                  <ReferenceLine y={0} stroke={C.mid} />
                  <Line type="monotone" dataKey="calls" stroke={C.green} dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="puts" stroke={C.red} dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}
      {d?.tickers && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 12, marginTop: 12 }}>
          {Object.entries(d.tickers).map(([s, t]) => <Ticker key={s} sym={s} t={t} board={boards[s]} />)}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", fontSize: 11.5, color: C.muted, marginTop: 12 }}>
        <b>Tide</b><span>net premium at the ask minus at the bid, market-wide, cumulative</span>
        <b>Net premium</b><span>the same, for one ticker</span>
        <b>UW GEX</b><span>built from the day&apos;s directional volume; dvcap&apos;s board from open interest</span>
        <b>Alerts</b><span>UW&apos;s unusual-activity rules; side = where ≥60% of premium traded</span>
        <b>Source</b><span>Unusual Whales API · personal use · snapshots 09:50, 12:30, 15:30 ET and the close</span>
      </div>
    </Card>
  );
}
