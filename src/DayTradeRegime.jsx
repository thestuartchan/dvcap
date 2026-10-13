// src/DayTradeRegime.jsx — Stu's day trades by gamma regime: a private analysis on the console.
//
// Reads /api/flex-sync?regimepnl=1 behind the console's session: GET shows the last run, "Run" reads
// IBKR Flex afresh. Everything here is the account's own P&L, so it lives only on this signed-in
// page — never in the repo, a PR, a log or the channel. The numbers are lib/dayTradeRegime.js's.
import { useEffect, useState } from "react";
import { C } from "./theme.js";

const usd = (v) => (v == null ? "—" : `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const ci = (c) => (!c || c[0] == null ? "—" : `${usd(c[0])} … ${usd(c[1])}`);
const LABEL = { positive: "positive γ", negative: "negative γ", undecided: "undecided", unknown: "no capture" };

function Table({ title, rows, note }) {
  const entries = Object.entries(rows || {});
  if (!entries.length) return null;
  const cell = { padding: "3px 6px", fontSize: 11.5, borderTop: "1px solid " + C.bdr, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: C.text }}>{title}</div>
      {note && <div style={{ fontSize: 11, color: C.muted }}>{note}</div>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", minWidth: 640 }}>
          <thead><tr>{["", "trades", "days", "total", "per day", "win days", "mean/trade", "median", "PF", "top-3 days", "95% CI per day"].map(h =>
            <th key={h} style={{ ...cell, borderTop: "none", textAlign: h ? "right" : "left", color: C.lbl, fontWeight: 800 }}>{h}</th>)}</tr></thead>
          <tbody>{entries.map(([k, s]) => (
            <tr key={k}>
              <td style={{ ...cell, fontWeight: 700, color: C.text }}>{k.split(" · ").map(x => LABEL[x] || x).join(" · ")}</td>
              <td style={{ ...cell, textAlign: "right" }}>{s.n}</td>
              <td style={{ ...cell, textAlign: "right" }}>{s.days ?? "—"}</td>
              <td style={{ ...cell, textAlign: "right", color: s.total < 0 ? C.red : C.green, fontWeight: 700 }}>{usd(s.total)}</td>
              <td style={{ ...cell, textAlign: "right" }}>{usd(s.perDay)}</td>
              <td style={{ ...cell, textAlign: "right" }}>{pct(s.winDays)}</td>
              <td style={{ ...cell, textAlign: "right" }}>{usd(s.mean)}</td>
              <td style={{ ...cell, textAlign: "right" }}>{usd(s.median)}</td>
              <td style={{ ...cell, textAlign: "right" }}>{s.pf ?? "—"}</td>
              <td style={{ ...cell, textAlign: "right" }}>{s.top3Share == null ? "—" : `${Math.round(s.top3Share * 100)}%`}</td>
              <td style={{ ...cell, textAlign: "right" }}>{ci(s.ciDay)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function SitOut({ name, s, v }) {
  if (!s) return null;
  return (
    <div style={{ fontSize: 12, color: C.mid, borderTop: "1px solid " + C.bdr, paddingTop: 6, marginTop: 6 }}>
      <b style={{ color: C.text }}>{name}</b>: skip {s.daysSkipped} days / {s.tradesLost} trades — avoided {usd(s.avoided)} (a positive figure is losses avoided),
      {" "}kept {usd(s.kept.total)} over {s.kept.days ?? 0} days. Skipped days {usd(s.skipped.perDay)}/day, CI {ci(s.skipped.ciDay)};
      {" "}without the best and worst day {usd(s.skippedTrimmed.perDay)}/day, CI {ci(s.skippedTrimmed.ciDay)}.
      {v && <span style={{ fontWeight: 800, color: v.adopt ? C.green : C.amber }}> {v.adopt ? "Meets the bar." : "Does not meet the bar."}</span>}
    </div>
  );
}

export default function DayTradeRegime() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    if (!open || data) return undefined;
    let cancelled = false;
    fetch("/api/flex-sync?regimepnl=1", { credentials: "include" }).then(r => r.json()).then(j => { if (!cancelled) setData(j); }).catch(() => {});
    return () => { cancelled = true; };
  }, [open, data]);
  const run = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/flex-sync?regimepnl=1", { method: "POST", credentials: "include" });
      const j = await r.json().catch(() => null);
      if (j?.ok) setData(j); else setMsg(j?.reason || `HTTP ${r.status}`);
    } catch { setMsg("could not reach the server"); }
    setBusy(false);
  };
  const res = data?.ok ? data.result : null;
  return (
    <div style={{ padding: "9px 13px", borderRadius: 10, background: C.surf, border: "1.5px solid " + C.bdr }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", cursor: "pointer" }} onClick={() => setOpen(x => !x)}>
        <span style={{ fontSize: 11, fontWeight: 800, color: C.blue, textTransform: "uppercase", letterSpacing: 0.5 }}>{open ? "▾" : "▸"} Day trades × gamma regime</span>
        <span style={{ fontSize: 11.5, color: C.muted }}>private analysis — your IBKR fills, this page only</span>
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={run} disabled={busy} style={{ fontSize: 11.5, fontWeight: 800, padding: "4px 10px", borderRadius: 7, cursor: "pointer", border: "1.5px solid " + C.blBdr, background: C.blue, color: C.onFill }}>
              {busy ? "Reading IBKR…" : data?.ok ? "Run again" : "Run"}
            </button>
            {data?.ok && <span style={{ fontSize: 11.5, color: C.muted }}>run {String(data.at).slice(0, 16).replace("T", " ")}Z · {data.query} · statement {data.statement.from} → {data.statement.to}</span>}
            {msg && <span style={{ fontSize: 11.5, color: C.amber, fontWeight: 700 }}>{msg}</span>}
            {!data?.ok && data?.reason && !msg && <span style={{ fontSize: 11.5, color: C.muted }}>{data.reason}</span>}
          </div>
          {res && (
            <>
              <div style={{ fontSize: 12.5, marginTop: 8, color: C.text }}>
                <b>{res.window.inScope}</b> day-trade round trips ({res.window.first} → {res.window.last}) of {res.window.roundTripsAll} in the statement.
                {" "}Verdict: <b style={{ color: res.verdict.summary === "no evidence" ? C.amber : C.green }}>{res.verdict.summary}</b>.
              </div>
              <Table title="All day trades" rows={{ all: res.overall }} />
              <Table title="By the early call (08:00 Dubai: overnight board + futures-implied open)" rows={res.byEarly} />
              <Table title="By the open call (9:30 print vs that morning's board)" rows={res.byOpen} />
              <Table title="By SqueezeMetrics SPX GEX tercile (previous close)" rows={res.bySmTercile} />
              <Table title="By SqueezeMetrics GEX sign" rows={res.bySmSign} />
              <Table title="Data / opex days" rows={res.byDataDay} />
              <div style={{ fontSize: 12, fontWeight: 800, color: C.text, marginTop: 12 }}>Sit-out simulation</div>
              <SitOut name="Sit out positive γ (early call)" s={res.sitOut.earlyPositive} v={res.verdict.sitOutPositiveEarly} />
              <SitOut name="Sit out positive γ (open call)" s={res.sitOut.openPositive} v={res.verdict.sitOutPositiveOpen} />
              <SitOut name="Sit out high-GEX tercile" s={res.sitOut.smHigh} v={res.verdict.sitOutHighTercile} />
              <Table title="Fade vs break, by open call" rows={res.setup.byOpen} note="Fade = toward the pin / back inside the box; break = away from it, through a wall or trapdoor. Pre-registered: fades in positive γ, breaks in negative." />
              <Table title="Calls vs puts, by open call" rows={res.callsPuts.open} />
              <Table title="Calls vs puts, by GEX tercile" rows={res.callsPuts.smTercile} />
              <Table title="Entry time (30-minute buckets, New York)" rows={res.timeOfDay.all} />
              <Table title="Quiet vs big days (realised range ÷ implied 1σ, terciles)" rows={res.range.all} />
              <Table title="Within each range bucket, by open call — does the label add anything?" rows={res.range.withinRangeByOpen} />
              <Table title="First-hour tell (first hour > half the implied 1σ)" rows={res.range.firstHourTell} />
              <div style={{ fontSize: 10.5, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
                Definitions are in lib/dayTradeRegime.js. Round trips are rebuilt flat-to-flat per contract from IBKR's fills, P&L net of commission; in scope: QQQ/SPY
                options at ≤1 trading day to expiry and same-day MES/MNQ/ES/NQ round trips. dvcap labels exist from 1 Sep 2026 (the captures); before that they read "no capture".
                Data sources answered: {Object.entries(data.sources || {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
