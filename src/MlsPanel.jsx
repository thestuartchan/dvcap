// src/MlsPanel.jsx — the Momentum-Leaders paper trial (lib/mls.js): the paper account against SPY,
// what it holds, what is queued for the next open, and every closed trade. Read-only; the ledger is
// written once a session by .github/workflows/mls-paper.yml through /api/atr?mls=1&write=1.
import { useEffect, useState } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { C } from "./theme.js";
import { Card, SLabel } from "./ui.jsx";

const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`);
const usd = (x) => (x == null ? "—" : `$${Math.round(x).toLocaleString("en-US")}`);
const tone = (x) => (x == null ? C.mid : x >= 0 ? C.green : C.red);

function Stat({ label, value, color, sub }) {
  return (
    <div style={{ minWidth: 110 }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, color: C.lbl, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 800, color: color || C.text, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted }}>{sub}</div>}
    </div>
  );
}

export function MlsPanel() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    fetch("/api/atr?mls=1", { credentials: "include" }).then(r => r.json())
      .then(j => (j?.ok ? setD(j) : setErr(j?.why || j?.reason || j?.error || "no answer")))
      .catch(e => setErr(String(e.message || e)));
  }, []);
  const rules = d?.rules;
  const head = (
    <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 10 }}>
      Paper trial of the S&amp;P 500 momentum-leaders snapback: buy a top-20% momentum name above its 200-day when RSI(2) &lt; 15
      and it closes in the bottom quarter of its range; sell on the first close above the prior high or after 20 sessions.
      {rules ? ` ${rules.slots} positions × ${rules.slotWeight * 100}% (max ${(rules.slots * rules.slotWeight).toFixed(1)}× gross), ${rules.newPerDay} new a day, ` +
        `no new buys while half or fewer of the index are above their 200-day or the account is ${rules.pauseDrawdown * 100}% below its peak. ` +
        `Fills at the next real opening print, ${rules.costBps} bp a side; cash earns ${rules.cashRate * 100}%, margin costs ${rules.marginRate * 100}%.` : ""}
      {" "}Backtest (2008–2026, point-in-time S&amp;P 500): 17.2% a year, worst drawdown −22%, against SPY's 11.2% and −52%.
    </div>
  );
  if (err) return <Card><SLabel>Paper trial — momentum leaders</SLabel>{head}<div style={{ color: C.amber, fontWeight: 700, fontSize: 12.5 }}>Could not load the ledger: {err}</div></Card>;
  if (!d) return <Card><SLabel>Paper trial — momentum leaders</SLabel>{head}<div style={{ color: C.muted, fontSize: 12.5 }}>Loading…</div></Card>;
  const s = d.summary;
  if (!s?.started) return <Card><SLabel>Paper trial — momentum leaders</SLabel>{head}<div style={{ color: C.mid, fontSize: 12.5 }}>Not started yet — the first run reads the next US close (21:45 UTC, weekdays) and queues its first buys for the following open.</div></Card>;
  const h = d.history || [];
  const spy0 = h.find(x => x.spy != null)?.spy;
  const chart = h.map(x => ({ date: x.date, Paper: +(x.equity / s.capital * 100).toFixed(2), SPY: spy0 && x.spy != null ? +(x.spy / spy0 * 100).toFixed(2) : null }));
  const last = h[h.length - 1];
  const pos = Object.entries(d.positions || {}).sort((a, b) => a[1].entryDate.localeCompare(b[1].entryDate));
  const trades = [...(d.trades || [])].reverse();
  const th = { textAlign: "left", fontSize: 10.5, color: C.lbl, fontWeight: 800, padding: "3px 8px 3px 0", textTransform: "uppercase" };
  const td = { fontSize: 12, padding: "3px 8px 3px 0", fontVariantNumeric: "tabular-nums", color: C.text };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card>
        <SLabel>Paper trial — momentum leaders</SLabel>
        {head}
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap", marginBottom: 10 }}>
          <Stat label="Equity" value={usd(s.equity)} sub={`from ${usd(s.capital)} on ${s.start}`} />
          <Stat label="Return" value={pct(s.ret)} color={tone(s.ret)} sub={`SPY ${pct(s.spyRet)} over the same sessions`} />
          <Stat label="Worst drawdown" value={pct(s.maxDd)} color={s.maxDd < -0.15 ? C.red : C.mid} />
          <Stat label="Gross" value={`${((s.gross || 0) * 100).toFixed(0)}%`} sub={`${s.open} of ${rules.slots} open`} />
          <Stat label="Breadth" value={s.breadth == null ? "—" : `${Math.round(s.breadth * 100)}%`} color={s.breadth > rules.breadthMin ? C.green : C.amber} sub={s.breadth > rules.breadthMin ? "buys allowed" : "buys wait"} />
          <Stat label="Trades" value={s.trades} sub={s.win == null ? "none closed yet" : `${Math.round(s.win * 100)}% winners`} />
        </div>
        <div style={{ fontSize: 11.5, color: C.muted }}>Last run: session of {s.lastDate} · {s.days} session{s.days === 1 ? "" : "s"} recorded{last?.gate ? " · new buys held back that session" : ""}</div>
      </Card>
      {chart.length > 1 && (
        <Card>
          <SLabel>Paper account vs SPY (start = 100)</SLabel>
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart} margin={{ left: 0, right: 12, top: 6, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.bdr} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.lbl }} minTickGap={40} />
                <YAxis tick={{ fontSize: 10, fill: C.lbl }} domain={["auto", "auto"]} width={40} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid " + C.bdr }} />
                <Line type="monotone" dataKey="Paper" stroke={C.blue} dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="SPY" stroke={C.muted} dot={false} strokeWidth={1.5} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}
      <Card>
        <SLabel>Held · queued for the next open</SLabel>
        {pos.length === 0 ? <div style={{ fontSize: 12.5, color: C.muted }}>Nothing held.</div> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr><th style={th}>Name</th><th style={th}>Bought</th><th style={th}>Entry</th><th style={th}>Last</th><th style={th}>P&amp;L</th><th style={th}>Sessions</th><th style={th}>Next open</th></tr></thead>
              <tbody>{pos.map(([sym, p]) => {
                const r = p.last / p.entry - 1, selling = d.pending?.sell?.includes(sym);
                return (<tr key={sym}><td style={{ ...td, fontWeight: 800 }}>{sym}</td><td style={td}>{p.entryDate}</td><td style={td}>{p.entry.toFixed(2)}</td><td style={td}>{p.last.toFixed(2)}</td>
                  <td style={{ ...td, color: tone(r), fontWeight: 700 }}>{pct(r)}</td><td style={td}>{p.held}</td><td style={{ ...td, color: selling ? C.amber : C.muted }}>{selling ? `sell — ${p.why || "exit"}` : "hold"}</td></tr>);
              })}</tbody>
            </table>
          </div>
        )}
        <div style={{ fontSize: 12, color: C.mid, marginTop: 8 }}>
          <b>Buys queued:</b> {d.pending?.buy?.length ? d.pending.buy.join(", ") : "none"}
        </div>
      </Card>
      <Card>
        <SLabel>Closed trades</SLabel>
        {trades.length === 0 ? <div style={{ fontSize: 12.5, color: C.muted }}>None yet.</div> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr><th style={th}>Name</th><th style={th}>In</th><th style={th}>Out</th><th style={th}>Entry</th><th style={th}>Exit</th><th style={th}>Return</th><th style={th}>Why</th></tr></thead>
              <tbody>{trades.slice(0, 40).map((t, i) => (
                <tr key={i}><td style={{ ...td, fontWeight: 800 }}>{t.sym}</td><td style={td}>{t.entryDate}</td><td style={td}>{t.exitDate}</td><td style={td}>{t.entry.toFixed(2)}</td><td style={td}>{t.exit.toFixed(2)}</td>
                  <td style={{ ...td, color: tone(t.ret), fontWeight: 700 }}>{pct(t.ret, 2)}</td><td style={{ ...td, color: C.muted }}>{t.why || "—"}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
