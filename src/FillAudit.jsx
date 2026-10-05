// src/FillAudit.jsx — the ONE-TIME carry-over from the old trade sheet into the console.
//
// The sheet is being retired and the console is the record from here on (IBKR's daily statement
// keeps it complete). This reads the sheet's "Fills (auto)" tab straight from this signed-in page — the link lives
// in the console's private settings, never in the bundle and never through a server function — and
// lists, per instrument the console tracks, every broker fill it has no record of. Each one gets
// the action lib/fillAudit.js plans for it; nothing is written until a button is pressed.
import { useState } from "react";
import { C } from "./theme.js";
import { sheetIdOf, sheetCsvUrl, parseBrokerFills, auditFills, fillFromBroker, closedTradeRow, swingRow } from "../lib/fillAudit.js";

const btn = (primary = false) => ({
  cursor: "pointer", fontSize: 11.5, fontWeight: 700, padding: "3px 9px", borderRadius: 6,
  background: primary ? C.blue : C.surf, color: primary ? C.onFill : C.blue, border: "1.5px solid " + (primary ? C.blue : C.bdr),
});
const fmt = (v) => (v == null ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: 6 }));

export default function FillAudit({ rows, sheet, setSheet, onAddFill, onAddRow, retired, onRetire, snapshots = [], onSnapshot, onRestore, onUndo }) {
  const [draft, setDraft] = useState(sheet || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [res, setRes] = useState(null);
  const [done, setDone] = useState({});
  const id = sheetIdOf(sheet);

  const run = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await fetch(sheetCsvUrl(id), { credentials: "omit" });
      if (!r.ok) throw new Error(`the sheet answered HTTP ${r.status} — is it shared to anyone with the link?`);
      const text = await r.text();
      if (/^\s*</.test(text)) throw new Error("the sheet sent a web page, not CSV — it may not be shared by link");
      const p = parseBrokerFills(text);
      if (p.error) throw new Error(p.error);
      setRes({ ...auditFills(rows, p.fills), dropped: p.dropped, read: p.fills.length, at: new Date().toISOString() });
      setDone({});
    } catch (e) { setErr(e.message || String(e)); }
    setBusy(false);
  };
  // ── ROLLBACK FIRST ── no write until a named copy of the console, as it stands, is stored beside
  // the live one. If that copy cannot be made, nothing is written.
  const [snap, setSnap] = useState(null);
  const [rbMsg, setRbMsg] = useState(null);
  const guarded = async (write) => {
    if (!snap) {
      const d = new Date().toISOString();
      const label = `carryover-${d.slice(0, 10)}-${d.slice(11, 16).replace(":", "")}`;
      const r = await onSnapshot(label);
      if (!r.ok) { setErr(`Nothing written: the rollback snapshot could not be stored (${r.error}).`); return false; }
      setSnap(label);
    }
    write();
    return true;
  };
  const rollback = (
    <div style={{ display: "grid", gap: 5, paddingTop: 6, borderTop: "1px dashed " + C.bdr, fontSize: 11.5, color: C.mid }}>
      <div><b style={{ color: C.text }}>Rollback.</b> Before the first change a snapshot of the console is stored beside it (kept 90 days).
        Nothing reaches your other devices until you press Save to cloud.</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <button style={btn()} onClick={() => { const u = onUndo(); setRbMsg(u.removedRows || u.removedFills ? `Removed ${u.removedRows} carried-over trade${u.removedRows === 1 ? "" : "s"} and ${u.removedFills} fill${u.removedFills === 1 ? "" : "s"}; nothing else touched.` : "Nothing from the carry-over to remove."); setDone({}); }}>
          Undo what the carry-over added</button>
        {snapshots.slice(0, 3).map(x => (
          <button key={x.label} style={btn()} title={`${x.rows} trades, ${x.fills} fills`}
            onClick={async () => { if (!window.confirm(`Restore the console exactly as it was at ${String(x.at).replace("T", " ").slice(0, 16)}Z? Changes made since then are replaced.`)) return; const r = await onRestore(x.label); setRbMsg(r.ok ? `Restored ${r.rows} trades from ${x.label}. Press Save to cloud to keep it.` : `Restore failed: ${r.error}`); }}>
            Restore {String(x.at).replace("T", " ").slice(0, 16)}Z</button>
        ))}
      </div>
      {rbMsg && <div style={{ color: C.text, fontWeight: 700 }}>{rbMsg}</div>}
    </div>
  );
  const rowOf = (rid) => rows.find(r => r.id === rid);
  // One missing fill and what can be done about it.
  const missingLine = (m) => {
    const key = m.uid + m.qty, row = m.plan.rowId ? rowOf(m.plan.rowId) : null, state = done[key];
    return (
      <div key={key} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 6, fontSize: 12, color: C.text }}>
        <span style={{ fontWeight: 800, color: m.side === "buy" ? C.green : C.blue, textTransform: "uppercase", fontSize: 11 }}>{m.side}</span>
        <span>{fmt(m.qty)}{m.partOf ? ` (of ${fmt(m.partOf)})` : ""} @ {fmt(m.price)} · {m.date}</span>
        {m.realized ? <span style={{ color: m.realized > 0 ? C.green : C.red }}>realised {m.realized > 0 ? "+" : ""}{fmt(m.realized)} {m.currency || ""}</span> : null}
        <span style={{ color: C.muted, fontSize: 11 }}>{m.uid}</span>
        {m.plan.action === "review" && <span style={{ color: C.amber, fontSize: 11.5 }}>{m.plan.why}</span>}
        {state ? <span style={{ color: C.green, fontWeight: 700 }}>✓ {state}</span> : (
          <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
            {m.plan.action === "closed-trade" && (
              <button style={btn(true)} title={`More than the console held then (${fmt(m.plan.heldThen)}). Records a closed trade whose entry, ${fmt(m.plan.impliedEntry)}, is implied by IBKR's realised P&L.`}
                onClick={() => { const nr = closedTradeRow(m, row, { from: res.from }); if (nr) guarded(() => { onAddRow(nr); mark(m, "recorded as a closed trade"); }); }}>
                Record as a closed trade</button>
            )}
            {row && (
              <button style={btn(m.plan.action === "add")} onClick={() => guarded(() => { onAddFill(row.id, fillFromBroker(m, row.multiplier || 1)); mark(m, `added to ${row.symbol}`); })}>
                Add to {row.symbol}{row.archived ? " (archived)" : ""}</button>
            )}
          </span>
        )}
      </div>
    );
  };

  // Once marked done the sheet is forgotten and the panel goes away: the console is the record.
  if (retired) return snapshots.length ? (
    <details style={{ border: "1px solid " + C.bdr, borderRadius: 12, background: C.surf, padding: "8px 14px", marginBottom: 14 }}>
      <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 700, color: C.muted }}>Sheet carry-over done · rollback</summary>
      <div style={{ marginTop: 8 }}>{rollback}</div>
    </details>
  ) : null;
  const mark = (m, what) => setDone(d => ({ ...d, [m.uid + m.qty]: what }));

  return (
    <details style={{ border: "1px solid " + C.bdr, borderRadius: 12, background: C.surf, padding: "10px 14px", marginBottom: 14 }}>
      <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 800, color: C.text }}>
        Bring over fills from the old trade sheet (one-time)
        {res && <span style={{ fontWeight: 700, color: res.missingCount ? C.amber : C.green }}> · {res.missingCount ? `${res.missingCount} missing` : "nothing missing"}</span>}
      </summary>
      <div style={{ marginTop: 9, fontSize: 12, color: C.mid, lineHeight: 1.55 }}>
        A one-off carry-over before the sheet is retired: reads its <b>Fills (auto)</b> tab from this page and lists every broker fill a console trade has no record of —
        matched on the IBKR trade id, otherwise the same side within a day and 1% on price. Instruments with no console row (day trades,
        FX conversions) are counted, not listed. Nothing is written until you press a button.
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
        <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="sheet link"
          style={{ flex: "1 1 260px", minWidth: 0, padding: "5px 9px", border: "1.5px solid " + (sheetIdOf(draft) ? C.bdr : C.aBdr), borderRadius: 7, fontSize: 12, background: C.bg, color: C.text }} />
        {draft !== (sheet || "") && <button style={btn()} disabled={!sheetIdOf(draft)} onClick={() => setSheet(draft.trim())}>Keep link</button>}
        <button style={btn(true)} disabled={!id || busy} onClick={run}>{busy ? "Reading…" : res ? "Check again" : "Check now"}</button>
      </div>
      {!id && <div style={{ marginTop: 6, fontSize: 11.5, color: C.muted }}>Paste the sheet's link once; it is kept with the console's settings.</div>}
      {err && <div style={{ marginTop: 8, fontSize: 12, color: C.red, fontWeight: 700 }}>{err}</div>}
      {res && (
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          <div style={{ fontSize: 11.5, color: C.lbl }}>
            {res.read} broker fills, {res.from} → {res.to}{res.dropped ? ` · ${res.dropped} rows not fills` : ""} ·
            {" "}{res.instruments.length} instruments to look at
            {res.unchecked.length ? ` · ${res.unchecked.length} spread${res.unchecked.length === 1 ? "" : "s"} not checked` : ""}
          </div>
          {/* THE CONSOLE'S SCOPE, as the daily sync applies it, judged on each trade's own date. */}
          <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.5 }}>
            Left out by the console's rules: {res.dayTrades.trades} day trade{res.dayTrades.trades === 1 ? "" : "s"} ({res.dayTrades.fills} fills, opened and closed the same day while the console held nothing)
            {Object.entries(res.outOfScope).map(([k, n]) => ` · ${n} ${k} fill${n === 1 ? "" : "s"}`).join("")}
            {res.heldNoRow.length ? ` · held at the broker with no console row, which the daily sync adds: ${res.heldNoRow.map(h => h.symbol).join(", ")}` : ""}.
            While the console holds a name, every fill in it counts, scalps included, so its cost matches IBKR's.
          </div>
          {res.instruments.filter(i => i.missing.length || i.unseen.length).map(i => (
            <div key={i.key} style={{ border: "1px solid " + (i.missing.length ? C.aBdr : C.bdr), borderRadius: 9, padding: "8px 10px", background: C.bg }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <b style={{ fontSize: 13.5, color: C.text }}>{i.symbol}</b>
                {i.noRow && <span style={{ fontSize: 11, color: C.muted }}>no console row</span>}
                <span style={{ fontSize: 11.5, color: C.muted }}>{i.brokerFills} broker fill{i.brokerFills === 1 ? "" : "s"}</span>
                {i.missing.length > 0 && <span style={{ fontSize: 11.5, color: C.amber, fontWeight: 800 }}>{i.missing.length} missing</span>}
              </div>
              {i.trades.filter(t => t.status === "missing").map(t => (
                <div key={t.from + t.side + t.qty} style={{ marginTop: 7, paddingLeft: 8, borderLeft: "2px solid " + C.aBdr }}>
                  <div style={{ fontSize: 12, color: C.mid }}>
                    <b style={{ color: C.text, textTransform: "uppercase", fontSize: 11 }}>{t.side}</b>{" "}
                    {t.kind === "pre-history-close"
                      ? <>sale of {fmt(t.qty)} bought before {res.from} · {t.from}</>
                      : <>{fmt(t.qty)}{t.avgIn != null ? ` @ ${fmt(t.avgIn)}` : ""} · {t.from}{t.kind === "closed" ? ` → ${t.to}${t.avgOut != null ? ` @ ${fmt(t.avgOut)}` : ""}` : " · still open"}</>}
                    {t.realized ? <span style={{ color: t.realized > 0 ? C.green : C.red }}> · realised {t.realized > 0 ? "+" : ""}{fmt(t.realized)} {t.currency || ""}</span> : null}
                    <span style={{ color: C.muted }}> · {t.missing.length} of {t.fills} fill{t.fills === 1 ? "" : "s"} missing</span>
                  </div>
                  {t.missing.map(missingLine)}
                </div>
              ))}
              {(() => {
                const rec = i.trades.filter(t => t.status === "recorded").length, out = i.trades.filter(t => t.status === "left-out").length;
                return rec || out ? <div style={{ marginTop: 6, fontSize: 11.5, color: C.muted }}>{rec ? `${rec} trade${rec === 1 ? "" : "s"} fully recorded` : ""}{rec && out ? " · " : ""}{out ? `${out} left out by the console's rules (day trades while it held nothing)` : ""}</div> : null;
              })()}
              {i.unseen.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 11.5, color: C.muted }}>
                  In the console, not among the broker's fills: {i.unseen.map(u => `${u.side} ${fmt(u.qty)} @ ${fmt(u.price)} ${u.date}`).join(" · ")}
                  {" "}— usually a consolidated or pre-history entry.
                </div>
              )}
            </div>
          ))}
          {res.swings.length > 0 && (
            <div style={{ border: "1px solid " + C.bdr, borderRadius: 9, padding: "8px 10px", background: C.bg }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: C.text }}>Swings the console never recorded</div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>Opened and closed across more than one day while the console held nothing. The daily sync leaves these to you; record the ones that belong in the book.</div>
              {res.swings.map(w => {
                const key = "sw" + w.fills[0].uid, state = done[key];
                return (
                  <div key={key} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 6, fontSize: 12, color: C.text }}>
                    <b>{w.symbol}</b>
                    <span>{w.from} → {w.to} · {w.fills.length} fills</span>
                    {w.realized ? <span style={{ color: w.realized > 0 ? C.green : C.red }}>realised {w.realized > 0 ? "+" : ""}{fmt(w.realized)} {w.fills[0].currency || ""}</span> : null}
                    {state ? <span style={{ color: C.green, fontWeight: 700 }}>✓ {state}</span> : (
                      <button style={btn()} onClick={() => { const nr = swingRow(w); if (nr) guarded(() => { onAddRow(nr); setDone(d => ({ ...d, [key]: "recorded as a closed trade" })); }); else setDone(d => ({ ...d, [key]: "not recorded — unknown contract size" })); }}>
                        Record as a closed trade</button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {res.missingCount === 0 && <div style={{ fontSize: 12.5, color: C.green, fontWeight: 700 }}>Every broker fill on a console instrument is recorded.</div>}
          <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.5 }}>
            The sheet's IBKR times are New York time marked UTC; they are corrected here, so a Hong Kong trade lands on its own date.
            Its fees leave out stamp duty and exchange fees, so a fill brought over can be priced a few cents light of IBKR's.
          </div>
          {rollback}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", paddingTop: 6, borderTop: "1px dashed " + C.bdr }}>
            <button style={btn()} onClick={() => { if (window.confirm("Mark the carry-over done? The sheet link is forgotten and this panel goes away; the console is the record from here on.")) onRetire(); }}>
              Done — forget the sheet</button>
            <span style={{ fontSize: 11.5, color: C.muted }}>From here, IBKR's daily statement keeps the console complete.</span>
          </div>
        </div>
      )}
    </details>
  );
}
