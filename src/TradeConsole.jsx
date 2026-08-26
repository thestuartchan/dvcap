// src/TradeConsole.jsx — the Console tab.
//
// Lives in its own module because it did not, and that cost three blank tabs in a row. App.jsx
// carries every tab in one ~8,000-line file, so a splice-style edit to one component silently
// damaged another: helpers removed with their region, a prop dropped at one call site, a ctx
// destructure left stale after a hoist. Each built cleanly and failed only in the browser.
// Guards now catch all three, but the structural fix is this — edits here cannot reach the rest
// of the dashboard, and the surface a change can break is a file you can read in one sitting.
//
// The contract with App.jsx is the TradeConsole props below: live regime and its qualifiers, the
// price feed, and the regime history. Everything else is derived here or imported from lib/.

import { useState, useEffect, useMemo } from "react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { C, SLabel, Card, Btn } from "./ui.jsx";
import { ASSETS } from "../lib/assets.js";
import { derivePosition, splitIntoTrades, collapseFills, positionPnl, levelHit, levelHits, distancePct, POINT_TOLERANCE_PCT, summarize, realizedCurve } from "../lib/positions.js";
import { CURRENCY_CODES, fxSymbolsFor, ratesFrom, convert, fxRisk, fmtCcy } from "../lib/fxrates.js";
import { REGIME_SIZING, regimeMultiplier, sizeSuggestion, equityFreshness, EQUITY_STALE_DAYS, DEFAULT_BASE_RISK_PCT, DEFAULT_TARGET_PCT, CREDIT_DANGER_CAP } from "../lib/sizing.js";

// Shown in the sizing note; kept a constant so the copy and the cap cannot drift apart.
const CREDIT_DANGER_CAP_LABEL = `×${CREDIT_DANGER_CAP.toFixed(2)}`;

// Insurance-book tickers, for the "insurance overlap" tag (ASSETS is the insurance universe).
const INSURANCE_TICKERS = (() => {
  const m = {};
  for (const a of ASSETS) for (const t of (a.tickers || [])) if (t?.t) m[t.t.toUpperCase()] = a.name;
  return m;
})();
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// How a symbol sits vs the live regime: its tickers appear in the regime's best/worst asset lists.
function regimeFitFor(sym, regime) {
  if (!sym || !regime) return { fit: "neutral", where: null };
  const re = new RegExp(`\\b${reEsc(sym.toUpperCase())}\\b`, "i");
  const hitBest = (regime.best || []).find(x => re.test(x));
  if (hitBest) return { fit: "tailwind", where: hitBest };
  const hitWorst = (regime.worst || []).find(x => re.test(x));
  if (hitWorst) return { fit: "headwind", where: hitWorst };
  return { fit: "neutral", where: null };
}


// A number field that COMMITS ON BLUR OR ENTER, not per keystroke — so a multi-digit quantity can
// be typed. `dk` is the draft key; while a draft exists it wins over the stored value.
const NumCommit = ({ dk, value, onCommit, placeholder, width = 84, title, drafts = {}, setDraft, clearDraft }) => {
  // `drafts` defaults to {} deliberately: this component is rendered from more than one place, and
  // a caller that forgets the draft store should lose the draft behaviour, not crash the tab. The
  // Console went blank once because `drafts[dk]` was read on an undefined store.
  const draft = drafts[dk];
  const shown = draft !== undefined ? draft : (value ?? "");
  const commit = () => {
    if (draft === undefined) return;
    const n = draft === "" ? null : +draft;
    clearDraft(dk);
    if (draft !== "" && !Number.isFinite(n)) return;   // reject junk rather than storing NaN
    onCommit(n);
  };
  return (
    <input
      value={shown} title={title} placeholder={placeholder} inputMode="decimal"
      onChange={e => setDraft(dk, e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") { e.target.blur(); } if (e.key === "Escape") clearDraft(dk); }}
      style={{
        width, padding: "5px 8px", borderRadius: 7, fontSize: 12.5, background: C.surf, color: C.text,
        border: "1.5px solid " + (draft !== undefined ? C.blue : C.bdr),
      }} />
  );
};


// The fill form, rendered INLINE inside the row it belongs to (see PositionRow). It previously sat
// in its own card near the bottom of the page, so pressing "Record a buy" on a row appeared to do
// nothing — the form it opened was off-screen.
const FillForm = ({ ctx, symbol }) => {
  const { fillFor, setFillFor, saveFill, nInput } = ctx;
  if (!fillFor) return null;
  return (

      <div style={{ marginTop: 10, padding: "11px 12px", borderRadius: 9, background: C.bg, border: "1.5px solid " + (fillFor.side === "buy" ? C.green : C.blue) }}>
        <SLabel>
          {fillFor.intent === "stopped" ? "Stopped out" : fillFor.intent === "sell" ? "Record a sell" : "Record a buy"}
          {" — "}{symbol}
        </SLabel>
        <div style={{ marginTop: 9, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Side<br />
            <select value={fillFor.side} onChange={e => setFillFor(f => ({ ...f, side: e.target.value }))} style={{ padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12.5, background: C.surf, color: C.text }}>
              <option value="buy">buy</option><option value="sell">sell</option>
            </select></label>
          <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Quantity <span style={{ fontWeight: 400, color: C.muted }}>(your position size)</span><br />{nInput(fillFor.qty, v => setFillFor(f => ({ ...f, qty: v })), "shares")}</label>
          <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Price<br />{nInput(fillFor.price, v => setFillFor(f => ({ ...f, price: v })), "")}</label>
          <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Date<br />
            <input type="date" value={fillFor.date} onChange={e => setFillFor(f => ({ ...f, date: e.target.value }))} style={{ padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12.5, background: C.surf, color: C.text }} /></label>
          <label style={{ flex: "1 1 200px", fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Note<br />
            <input value={fillFor.note} onChange={e => setFillFor(f => ({ ...f, note: e.target.value }))} placeholder="optional"
              style={{ width: "100%", boxSizing: "border-box", padding: "5px 9px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12.5, background: C.surf, color: C.text }} /></label>
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Btn onClick={saveFill} color="#fff" bgColor={fillFor.side === "buy" ? C.green : C.blue} label="Record fill" />
          <Btn onClick={() => setFillFor(null)} color={C.mid} bgColor={C.bg} label="Cancel" />
          {/* Name the drift, since that is what a stop-out is actually about. */}
          {fillFor.intent === "stopped" && fillFor.stopAt != null && Number.isFinite(+fillFor.price) && +fillFor.price !== +fillFor.stopAt && (() => {
            const slip = ((+fillFor.price - +fillFor.stopAt) / +fillFor.stopAt) * 100;
            return <span style={{ fontSize: 11.5, fontWeight: 800, color: slip < 0 ? C.red : C.green }}>
              {slip < 0 ? "▼" : "▲"} {Math.abs(slip).toFixed(2)}% {slip < 0 ? "worse than" : "better than"} your {fillFor.stopAt} stop
            </span>;
          })()}
          <span style={{ fontSize: 11, color: C.lbl }}>
            {/* Every field here is free. The prefill exists to save typing, and saying so matters:
                a form that opens with a level's price in it looks like it is recording THAT level,
                when the whole point is that you fill where you fill. */}
            <b>Nothing here is fixed</b> — change the price, size, side or date freely; a prefill is
            only a starting point.{" "}
            {fillFor.intent === "stopped"
              ? "This one starts as the whole position at your stop, because that is the usual case — but a stop is a trigger, not a fill price, and gaps and slippage mean the real one is usually worse. Type what you actually got."
              : "Selling part keeps the position open and books realised P&L at your average cost; selling all of it moves the row to Archive."}
          </span>
        </div>
      </div>
    
  );
};

// ── Console row components, at MODULE SCOPE ──────────────────────────────────
// These were originally declared inside TradeConsole. That is a React trap: a component declared
// inside another gets a NEW function identity on every parent render, so React treats it as a
// different component type, unmounts the old tree and mounts a fresh one. Every DOM node is
// replaced — which destroys focus mid-typing. It is why entering a quantity kicked the cursor out
// of the field after each character; holding the draft value in the parent preserved the VALUE but
// could not preserve focus, because the input element itself was being recreated.
// Hoisted here their identity is constant, so React re-renders in place and focus survives. Every
// value they used from the closure is passed through a single `ctx` object.

const LevelPill = ({ lv, price, ctx }) => {
const { kindCol } = ctx;
  const hit = levelHit(lv, price);
  const d = distancePct(lv, price);
  return (
    <span title={lv.note || undefined} style={{
      display: "inline-flex", gap: 5, alignItems: "baseline", padding: "2px 8px", borderRadius: 6,
      // Coloured at rest too, at reduced strength. A grey chip made every level look the same until
      // it fired, which is the moment you least need help telling them apart — the read you want at
      // a glance is "where are my stops", not "which one is live right now".
      border: "1.5px solid " + kindCol(lv.kind) + (hit ? "" : "66"),
      background: hit ? (lv.kind === "buy" ? "#F0FDF4" : lv.kind === "sell" ? C.blBg : "#FEF2F2") : C.surf,
      fontSize: 11.5, fontWeight: 700, color: hit ? kindCol(lv.kind) : C.mid,
    }}>
      <span style={{ color: kindCol(lv.kind) }}>{hit ? "●" : "○"}</span> {lv.kind} {lv.at ?? "—"}{lv.to ? `–${lv.to}` : ""}
      {d != null && !hit && <span style={{ color: C.lbl, fontWeight: 600 }}>{d > 0 ? "+" : ""}{d}%</span>}
    </span>
  );
};

// Calendar days between two ISO dates — the archive's own definition of "how long was this held",
// which is what separates a swing from a scalp. Returns null when either end is unknown (a holding
// opened before the broker's trade window has no recorded entry date to measure from).
const daysBetween = (a, b) => {
  if (!a || !b) return null;
  const t0 = Date.parse(a), t1 = Date.parse(b);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  return Math.round((t1 - t0) / 86400000);
};

// A thin vertical rule between the row's three groups. Its own component so the header reads as
// the three groups it is, rather than as a run of spans.
const Div = () => <span className="dvcap-divider" style={{ width: 1, alignSelf: "stretch", background: C.bdr, margin: "0 2px", flexShrink: 0 }} />;

// "held 5 weeks" beats "since 2026-07-15" in a row whose whole job is telling a swing from a
// scalp: the number you want is the DURATION, and the exact date is one click away in the editor.
const heldFor = (from) => {
  const d = daysBetween(from, new Date().toISOString().slice(0, 10));
  if (d == null || d < 0) return null;
  if (d === 0) return "today";
  if (d === 1) return "1 day";
  if (d < 21) return `${d} days`;
  if (d < 60) return `${Math.round(d / 7)} weeks`;
  return `${Math.round(d / 30)} months`;
};

// Does a free-text trade label already name this date? A row reading "Aug 18 · since 2026-08-18"
// says one thing twice, and the label is the half the user wrote, so the derived half yields.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const echoesDate = (label, iso) => {
  if (!label || !iso) return false;
  const t = String(label).toLowerCase();
  const [, mm, dd] = String(iso).split('-');
  if (!mm || !dd) return false;
  const day = String(+dd), mon = MONTHS[+mm - 1];
  const hasDay = new RegExp(`\\b0?${day}\\b`).test(t);
  return hasDay && (t.includes(mon) || new RegExp(`\\b0?${+mm}\\b`).test(t));
};

const PositionRow = ({ r, mode, ctx }) => {
const {
  prices, priceOf, liveRegime, expanded, setExpanded, upd, del, splitRow, collapseRow, addLevel, updLevel, delLevel,
  openFill, delFill, fillFor, sizeOpen, setSizeOpen, justMoved, drafts, setDraft, clearDraft, nInput, chip, ccyChip, fitChip,
  kindCol, money, pnlCol,
  equityBase, baseCcy, fxRates, regimeCtx, mergedSizing, baseRisk, targetPct, numOrNull,
} = ctx;
  const price = priceOf(r);
  const q = prices?.[r.symbol];
  const fit = regimeFitFor(r.symbol, liveRegime);
  const ins = INSURANCE_TICKERS[r.symbol];
  const open = expanded === r.id;
  const d = r.derived, p = r.pnl;
  // Share of the book this position represents — the number that turns "+$957" into "is this too
  // big?". Computed in the BASE currency, and simply absent when the FX rate or equity is missing
  // rather than shown as a figure that quietly means something else.
  const mvBase = p.marketValue == null ? null : convert(p.marketValue, r.currency || "USD", baseCcy, fxRates);
  const weightPct = (equityBase > 0 && mvBase != null) ? +((mvBase / equityBase) * 100).toFixed(1) : null;
  const active = (r.levels || []).filter(l => l.at != null);
  const stopLevel = active.find(l => l.kind === "stop");
  // Hoisted out of the panel so the folded tab can state the answer without the panel being open.
  // One computation, so the summary can never disagree with the detail it hides.
  const sizeMode = r.sizeMode || (stopLevel ? "risk" : "allocation");
  const equityInPos = equityBase == null ? null : convert(equityBase, baseCcy, r.currency || "USD", fxRates);
  const sug = sizeSuggestion({
    mode: sizeMode, equityInPos, price, stop: stopLevel?.at,
    baseRiskPct: baseRisk, targetPct: numOrNull(r.targetPct) ?? targetPct,
    regime: regimeCtx, heldQty: d.qty || 0, tranches: numOrNull(r.tranches) || 1,
    sizing: mergedSizing,
  });
  const sizeHint = sug.roomQty > 0 ? `room for ${sug.roomQty} more on ${sizeMode === "risk" ? "risk" : "allocation"} sizing`
    : sug.fullQty > 0 ? `at or above full size — ${d.qty || 0} held vs ${sug.fullQty} suggested`
    : sizeMode === "risk" && !stopLevel ? "add a stop and this will size the trade for you"
    : "set your account equity to size this";
  const anyHit = active.some(l => levelHit(l, price));
  return (
    <div className={justMoved === r.id ? "dvcap-row-in dvcap-flash" : "dvcap-row-in"}
      style={{ border: "1.5px solid " + (anyHit ? C.amber : C.bdr), borderLeft: "4px solid " + (anyHit ? C.amber : mode === "open" ? C.blue : C.bdr), borderRadius: 10, overflow: "hidden" }}>
      {/* The row is TWO blocks, not one wrapping run: an info block that flexes and wraps inside
          itself, and an action block that never leaves the top line. Letting the whole row wrap put
          0981.HK's buttons on a second line purely because its label was two words long. */}
      <div onClick={() => setExpanded(open ? null : r.id)} style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", cursor: "pointer", background: open ? C.bg : C.surf }}>
        <span style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", flex: "1 1 auto", minWidth: 0 }}>
        {/* ── THREE GROUPS, IN ONE ORDER, ALWAYS ──
            WHO it is · WHAT it costs on the tape · WHAT it is doing for you. Everything about the
            instrument sits left of the first divider, everything about the quote between the two,
            and everything about your position — when you bought, how much, what it has made —
            right of the second. Previously the entry date sat between the symbol and the price,
            splitting the identity from the quote and putting position data on the wrong side of
            the row. */}
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
          <b style={{ fontSize: 15 }}>{r.symbol}</b>
          {/* A label that just restates the ticker ("AMD" on AMD) is noise, so it is dropped. */}
          {r.trade && r.trade.trim().toUpperCase() !== r.symbol.toUpperCase()
            ? <span style={{ fontSize: 11.5, color: C.mid, fontWeight: 700, background: C.bg, border: "1px solid " + C.bdr, borderRadius: 6, padding: "1px 7px", whiteSpace: "nowrap" }}>{r.trade}</span> : null}
          {d.multiplier > 1 ? chip(`×${d.multiplier}`, C.amber, C.aBg, C.aBdr) : null}
          {ccyChip(r.currency || "USD")}
        </span>

        <Div />
        {/* The tape. Muted, and labelled "today", so it can never be read as your return. */}
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }} title="Last price and today's move on the tape — not your return">
          <span style={{ fontSize: 14, fontWeight: 700 }}>{price != null ? price.toFixed(2) : "—"}</span>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: q?.changePercent == null ? C.muted : q.changePercent >= 0 ? C.green : C.red, whiteSpace: "nowrap" }}>
            {q?.changePercent == null ? "" : `${q.changePercent >= 0 ? "▲" : "▼"}${Math.abs(q.changePercent).toFixed(2)}%`}
          </span>
          <span style={{ fontSize: 10.5, color: C.muted }}>{q?.changePercent == null ? "" : "today"}</span>
        </span>

        {mode === "open" && (
          <>
            <Div />
            <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", minWidth: 0 }}
              title={d.partiallyRealised
                ? `Unrealised ${money(p.unrealized, r.currency)} + realised ${money(d.realized, r.currency)}, against ${money(d.spent, r.currency)} deployed`
                : "Your return on this position since entry"}>
              {/* Held-since is POSITION data, so it belongs here — and it is suppressed when the
                  trade label already names the same date, which is what made rows read
                  "Aug 18 · since 2026-08-18". */}
              {d.firstDate && !echoesDate(r.trade, d.firstDate) && heldFor(d.firstDate)
                ? <span style={{ fontSize: 11.5, color: C.lbl, whiteSpace: "nowrap" }}>held {heldFor(d.firstDate)}</span> : null}
              <span style={{ fontSize: 12, color: C.lbl, whiteSpace: "nowrap" }}>{d.qty} @ {d.avgCost?.toFixed(2)}</span>
              <b style={{ fontSize: 13, color: pnlCol(p.total) }}>{p.total == null ? "—" : (p.total > 0 ? "+" : "") + money(p.total, r.currency)}</b>
              <b style={{ fontSize: 12.5, color: pnlCol(p.totalPct) }}>{p.totalPct == null ? "" : (p.totalPct > 0 ? "+" : "") + p.totalPct + "%"}</b>
              {weightPct != null && <span style={{ fontSize: 11, color: C.muted, whiteSpace: "nowrap" }}>{weightPct}% of book</span>}
            </span>
            {d.partiallyRealised && chip(`incl. realised ${money(d.realized, r.currency)}`, C.green, "#F0FDF4", "#BBF7D0")}
          </>
        )}
        {fitChip(fit.fit)}
        {ins && chip("🛡 " + ins, "#B45309", "#FFFBEB", "#FDE68A")}
        {anyHit && chip("⚡ level hit", C.amber, C.aBg, C.aBdr)}
        {d.needsQty && chip("⚠ quantity needed", C.amber, C.aBg, C.aBdr)}
        </span>
        {/* The actions that answer "how do I record what I did" — on the row, not hidden. */}
        <span className="dvcap-row-actions" style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", flexShrink: 0, flexWrap: "wrap" }} onClick={e => e.stopPropagation()}>
          {mode === "setup" && (
            <Btn onClick={() => { setExpanded(r.id); openFill(r, "buy"); }} color="#fff" bgColor={C.green} label="✓ I bought" />
          )}
          {mode === "open" && (
            <>
              <Btn onClick={() => { setExpanded(r.id); openFill(r, "buy"); }} color="#fff" bgColor={C.green} label="＋ Bought" />
              <Btn onClick={() => { setExpanded(r.id); openFill(r, "sell"); }} color="#fff" bgColor={C.blue} label="－ Sold" />
              {stopLevel && <Btn onClick={() => { setExpanded(r.id); openFill(r, "stopped"); }} color={C.red} bgColor={C.surf} label="🛑 Stopped out" />}
            </>
          )}
          <span style={{ color: C.lbl, fontSize: 12, cursor: "pointer" }} onClick={() => setExpanded(open ? null : r.id)}>{open ? "▲ less" : "▼ edit"}</span>
        </span>
      </div>

      {/* Levels are the point of the console — a row without any is a holding, not a watched trade,
          and silently showing nothing hides that. One quiet line, only when the row is collapsed. */}
      {active.length === 0 && !open && (
        <div style={{ padding: "0 12px 8px", fontSize: 11.5, color: C.muted }}>
          No levels set — <span style={{ color: C.blue, fontWeight: 700, cursor: "pointer" }} onClick={() => setExpanded(r.id)}>add a buy, sell or stop</span> to get flagged when price reaches it.
        </div>
      )}
      {/* levels always visible — this is the daily read */}
      {active.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "0 12px 9px" }}>
          {active.map(l => <LevelPill key={l.id} lv={l} price={price} ctx={ctx} />)}
        </div>
      )}

      {open && (
        <div className="dvcap-expand" onClick={e => e.stopPropagation()} style={{ padding: 12, borderTop: "1px solid " + C.bdr, background: C.surf }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 10 }}>
            <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Currency<br />
              <select value={r.currency || "USD"} onChange={e => upd(r.id, { currency: e.target.value })} style={{ padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12.5, background: C.surf, color: C.text }}>
                {CURRENCY_CODES.map(c => <option key={c} value={c}>{c}</option>)}
              </select></label>
            {/* Only shown when it can matter. Pinning is what stops a finished trade's dollar result
                drifting with spot for as long as it is in the archive. */}
            {(r.currency || "USD") !== baseCcy && (
              <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }} title={`Units of ${r.currency} per 1 ${baseCcy}. Leave blank to use the live rate; set it to the rate you actually got, and this row stops moving with spot.`}>
                {r.currency}/{baseCcy} rate<br />
                <NumCommit dk={`fx:${r.id}`} drafts={drafts} setDraft={setDraft} clearDraft={clearDraft}
                  value={r.fxRate} placeholder={fxRates[r.currency] ? `${fxRates[r.currency].toFixed(4)} live` : "live"} width={96}
                  onCommit={v => upd(r.id, { fxRate: v })} />
                <span style={{ display: "block", fontWeight: 500, color: C.muted, fontSize: 10.5, marginTop: 2 }}>
                  {numOrNull(r.fxRate) != null ? "pinned — will not move with spot" : "using the live rate"}
                </span>
              </label>
            )}
            <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Trade label<br />
              <input value={r.trade || ""} onChange={e => upd(r.id, { trade: e.target.value })} placeholder="e.g. Aug 18 entry"
                style={{ width: 120, padding: "5px 9px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12.5, background: C.surf, color: C.text }} /></label>
            <label style={{ flex: "1 1 240px", fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Thesis / why you are watching<br />
              <input value={r.thesis || ""} onChange={e => upd(r.id, { thesis: e.target.value })} placeholder="e.g. accumulate on a pullback to the 200dma"
                style={{ width: "100%", boxSizing: "border-box", padding: "5px 9px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12.5, background: C.surf, color: C.text }} /></label>
          </div>

          {/* ── LEVELS ──
              These are ALERTS, not orders and not a record of anything. The row said none of that,
              so "how do I flag a future buy without logging that I bought" had no answer visible
              anywhere on screen. It is now the first line of the block, and each level states in
              words what will make it fire. */}
          <div style={{ marginTop: 12, padding: "10px 12px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 9 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>Levels</span>
              <span style={{ fontSize: 11.5, color: C.lbl }}>
                price alerts — <b>nothing is ordered and nothing is recorded.</b> When price reaches one the row flags and,
                if notifications are on, your browser tells you. Recording an actual trade is <b style={{ color: C.green }}>Bought</b> / <b style={{ color: C.blue }}>Sold</b>.
              </span>
            </div>

            {(r.levels || []).length > 0 && (
              <div style={{ display: "flex", gap: 7, marginTop: 9, marginBottom: 3, fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>
                <span style={{ width: 190 }}>What kind, and when</span><span style={{ width: 88 }}>Price</span><span style={{ width: 100 }}>…through (opt)</span>
              </div>
            )}
            {(r.levels || []).map(l => {
              const hit = levelHit(l, price);
              const dist = distancePct(l, price);
              return (
                <div key={l.id} style={{ display: "flex", gap: 7, alignItems: "center", marginBottom: 5, flexWrap: "wrap" }}>
                  {/* Both halves, in one control. Naming only the behaviour ("it falls to") lost the
                      difference between a BUY ZONE and a STOP — both fire on a falling price — and a
                      buy zone promptly got created with "Stop Loss" written in its note. */}
                  <span style={{ width: 9, height: 9, borderRadius: 9, background: kindCol(l.kind), flexShrink: 0 }} />
                  <select value={l.kind} onChange={e => updLevel(r.id, l.id, { kind: e.target.value })}
                    style={{ width: 176, padding: "4px 7px", border: "1.5px solid " + kindCol(l.kind), borderRadius: 6, fontSize: 12, background: C.surf, color: kindCol(l.kind), fontWeight: 800 }}>
                    <option value="buy">BUY ZONE · falls to</option>
                    <option value="sell">SELL ZONE · rises to</option>
                    <option value="stop">STOP · breaks below</option>
                  </select>
                  {/* Draft-backed, so a decimal point survives being typed. The old input coerced the
                      raw string to a number on every keystroke, so "16." became 16 and the next two
                      digits made 1685 — and backspacing past a decimal appeared to eat two
                      characters. Same fix the fill inputs already carry. */}
                  <NumCommit dk={`lv:${l.id}`} drafts={drafts} setDraft={setDraft} clearDraft={clearDraft} value={l.at} placeholder="price" width={88}
                    onCommit={v => updLevel(r.id, l.id, { at: v })} />
                  <NumCommit dk={`lt:${l.id}`} drafts={drafts} setDraft={setDraft} clearDraft={clearDraft} value={l.to} placeholder="optional" width={100}
                    onCommit={v => updLevel(r.id, l.id, { to: v })} />
                  <input value={l.note || ""} onChange={e => updLevel(r.id, l.id, { note: e.target.value })} placeholder="why (optional)"
                    style={{ flex: "1 1 120px", minWidth: 90, padding: "4px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6, fontSize: 12, background: C.surf, color: C.text }} />
                  <button onClick={() => delLevel(r.id, l.id)} title="remove this level" style={{ cursor: "pointer", background: "none", border: "none", color: C.red, fontWeight: 800, fontSize: 13 }}>✕</button>
                  {/* What this level will actually do, in words, including the tolerance band that a
                      single price silently carries. */}
                  <div style={{ flexBasis: "100%", fontSize: 11, color: hit ? kindCol(l.kind) : C.muted, fontWeight: hit ? 700 : 500, paddingLeft: 2 }}>
                    {l.at == null ? `Type a price and this ${l.kind === "stop" ? "stop" : l.kind + " zone"} starts watching.`
                      : hit ? `⚡ Live now — ${price} is ${l.to != null ? `inside ${Math.min(l.at, l.to)}–${Math.max(l.at, l.to)}` : `within ${POINT_TOLERANCE_PCT}% of ${l.at}`}.`
                      : l.to != null ? `Fires anywhere in ${Math.min(l.at, l.to)}–${Math.max(l.at, l.to)} · ${dist == null ? "" : `${Math.abs(dist)}% ${dist > 0 ? "above" : "below"} the last price`}`
                      : `Single price — fires within ±${POINT_TOLERANCE_PCT}% of ${l.at} · ${dist == null ? "" : `${Math.abs(dist)}% ${dist > 0 ? "above" : "below"} the last price`}`}
                    {/* A hit level and the act of recording the trade were on opposite ends of the
                        card, which is what made the two feel like the same thing or unrelated
                        things depending on where you looked. Selling needs something to sell. */}
                    {hit && (l.kind === "buy" || d.qty > 0) && (
                      <button onClick={() => { setExpanded(r.id); openFill(r, l.kind === "sell" ? "sell" : l.kind === "stop" ? "stopped" : "buy"); }}
                        style={{ marginLeft: 8, cursor: "pointer", background: kindCol(l.kind), color: "#fff", border: "none", borderRadius: 6, padding: "2px 9px", fontSize: 11, fontWeight: 800 }}>
                        record a fill
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
              {[["buy", "＋ buy zone"], ["sell", "＋ sell zone"], ["stop", "＋ stop"]].map(([k, label]) => (
                <button key={k} onClick={() => addLevel(r.id, k)} style={{ cursor: "pointer", background: C.surf, color: kindCol(k), border: "1.5px solid " + C.bdr, borderRadius: 7, padding: "4px 10px", fontSize: 12, fontWeight: 700 }}>{label}</button>
              ))}
              <span style={{ fontSize: 11, color: C.lbl }}>
                One price fires within ±{POINT_TOLERANCE_PCT}% of it. Fill the second box to watch a whole zone instead.
              </span>
              {/* "How do I know it saved?" had no answer anywhere near the thing being edited — the
                  only indicator was a toolbar button several screens up. */}
              <span style={{ flexBasis: "100%", fontSize: 11, color: C.muted, marginTop: 2 }}>
                A level is kept the moment you click away or press Enter — a <b>blue border means it is still uncommitted</b>.
                Everything is saved in this browser straight away; <b>Save to cloud</b> is what carries it to your other devices.
              </span>
            </div>
          </div>

          {/* ── SIZE SUGGESTION, folded away ──
              It is a calculator, not a control: it reads nothing, changes nothing and is never
              applied — it answers "what size would my own rules give this?" and shows its working.
              Open by default it dominated the card and read as a field you were required to fill
              in. Shut, with its one-line answer on the tab, it is there when the question is live
              and out of the way when it is not. */}
          <div style={{ marginTop: 12 }}>
            <button onClick={() => setSizeOpen(o => ({ ...o, [r.id]: !o[r.id] }))}
              style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", cursor: "pointer",
                background: C.surf, border: "1.5px solid " + C.bdr, borderRadius: 9, padding: "7px 11px", color: C.text }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap" }}>Size suggestion</span>
              <span style={{ fontSize: 11.5, color: C.lbl }}>{sizeHint}</span>
              <span style={{ marginLeft: "auto", fontSize: 11.5, color: C.blue, fontWeight: 700, whiteSpace: "nowrap" }}>{sizeOpen[r.id] ? "▲ hide" : "▼ show"}</span>
            </button>
            {sizeOpen[r.id] && (
              <>
                <div style={{ fontSize: 11.5, color: C.lbl, margin: "9px 2px 0", lineHeight: 1.65 }}>
                  Suggestions only — nothing is applied and you never have to use it.
                  <b> Risk-based</b> asks how many shares make a stop-out cost a fixed slice of the book, so it needs a stop.
                  <b> Allocation</b> targets a percentage of the book instead, for holds where the thesis rather than a price
                  is the exit. Both are scaled by the regime multiplier and netted against what you already hold.
                  <br /><b>Buy it in N goes</b> divides the room you have LEFT — not the full size — so it keeps working after
                  you have already scaled in: full size 100 with 40 held is 60 of room, which in 3 goes is 20 a time. It changes
                  nothing about how big the position should end up, only the size of each step towards it.
                </div>
          {(() => {
            const mode = sizeMode;
            return (
              <div style={{ marginTop: 12, padding: "10px 12px", background: liveRegime?.bg || C.bg, border: "1px solid " + (liveRegime?.bdr || C.bdr), borderRadius: 9 }}>
                <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap", marginBottom: 7 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>How much to buy</span>
                  <select value={mode} onChange={e => upd(r.id, { sizeMode: e.target.value })}
                    title="Risk: size so a stop-out costs a fixed % of the book. Allocation: hold a target % of the book — for long holds with no stop."
                    style={{ padding: "3px 7px", border: "1.5px solid " + C.bdr, borderRadius: 6, fontSize: 11.5, background: C.surf, color: C.text, fontWeight: 700 }}>
                    <option value="risk">risk-based (needs a stop)</option>
                    <option value="allocation">allocation (% of book)</option>
                  </select>
                  {mode === "allocation" && (
                    <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700, display: "flex", gap: 5, alignItems: "center" }}>
                      target % <NumCommit dk={`tp:${r.id}`} drafts={drafts} setDraft={setDraft} clearDraft={clearDraft}
                        value={r.targetPct} placeholder={String(targetPct)} width={58}
                        onCommit={v => upd(r.id, { targetPct: v })} />
                    </label>
                  )}
                  <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700, display: "flex", gap: 5, alignItems: "center" }}>
                    <span title="How many separate buys you intend to build the position with. The room left to buy is divided by this, so you get a per-buy size instead of one all-at-once number. It changes nothing about the full size — only how you get there.">
                      buy it in <NumCommit dk={`tr:${r.id}`} drafts={drafts} setDraft={setDraft} clearDraft={clearDraft}
                        value={r.tranches} placeholder="1" width={48}
                        onCommit={v => upd(r.id, { tranches: v })} /> goes
                    </span>
                  </label>
                </div>
                {sug.ok ? (
                  <div style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.75 }}>
                    Full size <b style={{ color: C.text }} title={sug.rounded ? `rounded from ${sug.fullExact} — equity is approximate, so the extra digits are not meaningful` : undefined}>~{sug.fullQty}</b> ({money(sug.notional, r.currency)} · {sug.notionalPctOfBook}% of book)
                    {sug.heldQty > 0 && <> · holding <b>{sug.heldQty}</b></>}
                    {" · "}<b style={{ color: sug.roomQty > 0 ? C.green : C.muted }}>room for {sug.roomQty}</b>
                    {sug.tranches > 1 && sug.trancheQty > 0 && <> · <b>{sug.trancheQty}</b> per buy, {sug.tranches} times</>}
                    {sug.riskAmount != null && (
                      <div style={{ color: C.lbl }}>
                        Risks <b style={{ color: C.red }}>{fmtCcy(sug.riskAmount, r.currency)}</b> at the {stopLevel?.at} stop ({sug.effPct}% of book · {money(sug.perShareRisk, r.currency)}/share)
                      </div>
                    )}
                    <div style={{ color: C.muted, fontSize: 11.5 }}>
                      {mode === "risk" ? `${baseRisk}%` : `${numOrNull(r.targetPct) ?? targetPct}%`} base × <b style={{ color: liveRegime?.color }}>{sug.mult}</b> regime — {sug.reasons[sug.reasons.length - 1]}
                      {sug.perTenPctEquity > 0 && <> · a 10% move in your equity shifts this by ~{sug.perTenPctEquity} share{sug.perTenPctEquity === 1 ? "" : "s"}</>}
                    </div>
                    {sug.warnings.map((w, i) => <div key={i} style={{ color: C.amber, fontWeight: 700, fontSize: 11.5 }}>⚠ {w}</div>)}
                  </div>
                ) : (
                  <div style={{ fontSize: 12.5, color: C.muted, fontStyle: "italic" }}>
                    {sug.why}
                    {/^risk sizing needs a stop/.test(sug.why || "") && (
                      <button onClick={() => upd(r.id, { sizeMode: "allocation" })} style={{ marginLeft: 8, cursor: "pointer", background: C.surf, color: C.blue, border: "1.5px solid " + C.bdr, borderRadius: 6, padding: "2px 8px", fontSize: 11.5, fontWeight: 700 }}>
                        use allocation instead
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
              </>
            )}
          </div>

          {/* fills */}
          <div style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, margin: "12px 0 5px" }}>
            Fills {d.nFills > 0 && <span style={{ fontWeight: 600, textTransform: "none", letterSpacing: 0, color: C.lbl }}>· {d.bought} bought · {d.sold} sold · avg {d.avgCost?.toFixed(2) ?? "—"}</span>}
          </div>
          {(d.fills || []).map(f => (
            <div key={f.id} style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 12, color: C.mid, marginBottom: 4, flexWrap: "wrap" }}>
              <b style={{ color: f.side === "buy" ? C.green : C.blue, minWidth: 32 }}>{f.side}</b>
              <NumCommit dk={`fq:${f.id}`} drafts={drafts} setDraft={setDraft} clearDraft={clearDraft} value={f.qty} placeholder="qty" width={78}
                onCommit={q => { if (q != null && q > 0) upd(r.id, { fills: (r.fills || []).map(x => x.id === f.id ? { ...x, qty: q } : x) }); }} />
              <span style={{ color: C.lbl }}>@</span>
              <NumCommit dk={`fp:${f.id}`} drafts={drafts} setDraft={setDraft} clearDraft={clearDraft} value={f.price} placeholder="price" width={92}
                onCommit={p => { if (p != null && p >= 0) upd(r.id, { fills: (r.fills || []).map(x => x.id === f.id ? { ...x, price: p } : x) }); }} />
              <input type="date" value={f.date || ""} onChange={e => upd(r.id, { fills: (r.fills || []).map(x => x.id === f.id ? { ...x, date: e.target.value } : x) })}
                style={{ padding: "4px 7px", border: "1.5px solid " + C.bdr, borderRadius: 6, fontSize: 11.5, background: C.surf, color: C.text }} />
              {f.note && <span style={{ color: C.muted, fontSize: 11.5 }}>{f.note}</span>}
              <button onClick={() => delFill(r.id, f.id)} title="delete this fill" style={{ cursor: "pointer", background: "none", border: "none", color: C.red, fontWeight: 800 }}>✕</button>
            </div>
          ))}
          {(d.incomplete || []).map(f => (
            <div key={f.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12, marginTop: 5, padding: "7px 9px", background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 7 }}>
              <b style={{ color: C.amber }}>⚠ quantity needed</b>
              <span style={{ color: C.mid }}>{f.side} @ {f.price}{f.date ? ` · ${f.date}` : ""}</span>
              <span style={{ color: C.lbl }}>how many?</span>
              <NumCommit dk={`q:${f.id}`} drafts={drafts} setDraft={setDraft} clearDraft={clearDraft} value="" placeholder="qty" width={90}
                title="Type the full quantity, then press Enter or click away."
                onCommit={q => { if (q != null && q > 0) upd(r.id, { fills: (r.fills || []).map(x => x.id === f.id ? { ...x, qty: q } : x) }); }} />
              <span style={{ color: C.muted, fontSize: 11 }}>press Enter or click away to save — the price was imported, the size was not</span>
            </div>
          ))}
          {d.warnings?.map((w, i) => <div key={i} style={{ fontSize: 11.5, color: C.amber, fontWeight: 700, marginTop: 4 }}>⚠ {w}</div>)}
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            {/* The buy/sell pair lives in the row header, where it is reachable without expanding
                anything. Repeating it here gave two controls for one action and made the pair down
                here look like a different, more permanent kind of recording. */}
            <Btn onClick={() => del(r.id)} color={C.red} bgColor={C.surf} label="✕ Remove this trade" />
          </div>

          {/* ── THE FILL FORM ──
              It had never been rendered. FillForm was written, wired into ctx and given a save
              handler, but no JSX ever mounted it, so every Bought / Sold / record-a-fill button set
              state that nothing displayed and appeared to do nothing at all. Guards did not catch it
              because an unmounted component is not an undefined reference — scripts/check-dead-
              components.mjs now looks for exactly this. It renders inside the row it belongs to, so
              the form appears where the button was pressed. */}
          {fillFor?.rowId === r.id && <FillForm ctx={ctx} symbol={r.symbol} />}

          {/* ── TIDYING ──
              Two things the broker's fill stream gets wrong for a human reader, offered only when
              they actually apply to this row. Splitting is the important one: a symbol exited and
              re-entered is two TRADES, and no amount of averaging inside one row can express that. */}
          {(() => {
            const trips = splitIntoTrades(r.fills || []);
            const col = collapseFills(r.fills || [], { multiplier: r.multiplier });
            if (trips.length < 2 && col.to >= col.from) return null;
            return (
              <div style={{ marginTop: 9, padding: "9px 11px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 9 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Tidy up</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  {trips.length > 1 && (
                    <Btn onClick={() => splitRow(r, trips)} color="#fff" bgColor={C.blue} label={`\u2442 Split into ${trips.length} trades`} />
                  )}
                  {col.to < col.from && (
                    <Btn onClick={() => collapseRow(r, col)} color={C.mid} bgColor={C.surf} label={`\u21e5 Collapse ${col.from} fills to ${col.to}`} />
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: C.lbl, marginTop: 6, lineHeight: 1.6 }}>
                  {trips.length > 1 && <>This row went flat and was re-entered, so it holds <b>{trips.length} separate trades</b>. Splitting gives each its own row — the closed ones move to the archive.<br /></>}
                  {col.to < col.from && (col.exact
                    ? <>Collapsing replaces the partial fills with one size-weighted average each way. Realised P&amp;L is unchanged.</>
                    : <span style={{ color: C.amber, fontWeight: 700 }}>⚠ Collapsing this row would move realised P&amp;L by {col.delta > 0 ? "+" : ""}{col.delta} — it has sold part of an open position, so the sell was measured against a different average. Split it first.</span>)}
                </div>
              </div>
            );
          })()}

          {mode === "open" && (
            <div style={{ marginTop: 10, padding: "9px 12px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 9, fontSize: 12.5, color: C.mid, lineHeight: 1.7 }}>
              {d.qty} @ avg {d.avgCost?.toFixed(4)} · market {money(p.marketValue, r.currency)}
              <br />Unrealised <b style={{ color: pnlCol(p.unrealized) }}>{p.unrealized == null ? "—" : money(p.unrealized, r.currency)}</b>
              {p.unrealizedPct != null && <span style={{ color: C.lbl }}> ({p.unrealizedPct > 0 ? "+" : ""}{p.unrealizedPct}%)</span>}
              {" · "}Realised <b style={{ color: pnlCol(d.realized) }}>{money(d.realized, r.currency)}</b>
              {d.realizedPct != null && <span style={{ color: C.lbl }}> ({d.realizedPct > 0 ? "+" : ""}{d.realizedPct}% on capital taken out)</span>}
              {/* The header's single figure, spelled out — so the two never look like they disagree. */}
              <br /><span style={{ color: C.lbl }}>Total </span><b style={{ color: pnlCol(p.total) }}>{p.total == null ? "—" : (p.total > 0 ? "+" : "") + money(p.total, r.currency)}</b>
              {p.totalPct != null && <b style={{ color: pnlCol(p.totalPct) }}> {p.totalPct > 0 ? "+" : ""}{p.totalPct}%</b>}
              <span style={{ color: C.lbl }}> on {money(d.spent, r.currency)} deployed{q?.changePercent != null ? ` · the quote itself is ${q.changePercent >= 0 ? "up" : "down"} ${Math.abs(q.changePercent).toFixed(2)}% today` : ""}</span>
              {d.partiallyRealised && <div style={{ color: C.green, fontSize: 11.5, marginTop: 3 }}>Scaled out {d.sold} of {d.bought} — still open on {d.qty}. The unrealised percentage is the move from your average cost; the total is measured against everything you put in.</div>}
            </div>
          )}
          {fit.where && <div style={{ marginTop: 8, fontSize: 12, color: C.mid }}><b style={{ color: fit.fit === "tailwind" ? C.green : C.red }}>{fit.fit === "tailwind" ? "Regime tailwind" : "Fights the regime"}:</b> {liveRegime?.label} {fit.fit === "tailwind" ? "favours" : "disfavours"} “{fit.where}”.</div>}
        </div>
      )}
    </div>
  );
};

const Section = ({ title, note, list, mode, ctx }) => (
  <Card>
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: list.length ? 10 : 0 }}>
      <SLabel>{title}</SLabel>
      <span style={{ fontSize: 12, color: C.muted }}>{list.length}</span>
      {note && <span style={{ fontSize: 11.5, color: C.lbl }}>{note}</span>}
    </div>
    {list.length === 0
      ? <div style={{ fontSize: 12.5, color: C.muted, fontStyle: "italic", marginTop: 8 }}>Nothing here yet.</div>
      : <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{list.map(r => <PositionRow key={r.id} r={r} mode={mode} ctx={ctx} />)}</div>}
  </Card>
);

// ─── TRADE CONSOLE ───────────────────────────────────────────────────────────
// SCOPE: spot, swing and long holds. Not day trades or scalps — those live in the broker and the
// user's own tracker sheet, and duplicating them here produced a worse second copy of both.
//
// The console answers a PRE-TRADE question the sheet cannot: "what am I waiting for, and has it
// arrived?" Setups carry levels; live prices are checked against them; a hit raises a flag. What it
// keeps beyond that is deliberately thin — enough position state to know what is actually held and
// what it has made, with a brief archive, and nothing that re-implements a P&L tracker.
//
// Positions are FILLS, not a single entry price (lib/positions.js), because these trades scale in
// and scale out: a position is regularly open AND realising P&L at the same time, which the old
// single-entry model could not represent at all.
export function TradeConsole({ regimeHistory = [], liveRegime, regimeProbFor, liveInd, creditDanger, contested, regimeDiverged, prices, fetchPrices, pricesLoading }) {
  const LS = "dvcap_console_v2";
  const [rows, setRows]         = useState([]);     // unified: setups + positions
  const [settings, setSettings] = useState({ baseCurrency: "USD", alertsEnabled: false, equity: null, baseRiskPct: DEFAULT_BASE_RISK_PCT, targetPct: DEFAULT_TARGET_PCT, sizing: {} });
  const [loaded, setLoaded]     = useState(false);
  const [dirty, setDirty]       = useState(false);
  const [saving, setSaving]     = useState(false);
  const [saveMsg, setSaveMsg]   = useState(null);
  const [kvOn, setKvOn]         = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [addSym, setAddSym]     = useState("");
  const [fillFor, setFillFor]   = useState(null);   // open "record a fill" form
  const [sizeOpen, setSizeOpen] = useState({});     // per-row: is the size suggestion unfolded
  const [moved, setMoved]       = useState(null);   // a row that just changed section, for the toast
  const [showArchive, setShowArchive] = useState(false);
  const [portOpen, setPortOpen] = useState(false);
  const [importTxt, setImportTxt] = useState("");
  const [importMsg, setImportMsg] = useState(null);
  // Draft values for numeric fields, keyed by fill id. These are held HERE rather than inside the
  // row component because RowCard is declared inside this function: its identity changes on every
  // render, so React remounts the subtree and any local state in it is lost on each keystroke.
  // That is what made the quantity field commit "1" while typing "1058" — it had no value of its
  // own, so the first character was written straight to the fill and the input reset.
  const [drafts, setDrafts] = useState({});
  const setDraft = (k, v) => setDrafts(d => ({ ...d, [k]: v }));
  const clearDraft = (k) => setDrafts(d => { const n = { ...d }; delete n[k]; return n; });
  const notifiedRef = useMemo(() => ({ current: new Set() }), []);

  // ── load / persist ──
  useEffect(() => {
    try {
      const c = JSON.parse(localStorage.getItem(LS) || "null");
      if (c) { setRows(c.rows || []); setSettings(s => ({ ...s, ...(c.settings || {}) })); }
    } catch { /* no cache */ }
    fetch("/api/manual-entry").then(r => r.json()).then(j => {
      const c = j?.console;
      if (c && typeof c === "object") {
        if (Array.isArray(c.rows)) setRows(c.rows);
        else if (Array.isArray(c.watchlist)) setRows(migrateV1(c.watchlist));   // one-time v1 → v2
        if (c.settings) setSettings(s => ({ ...s, ...c.settings }));
      }
      setKvOn(j?.kv?.configured ?? null);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(LS, JSON.stringify({ rows, settings })); } catch { /* quota */ }
  }, [rows, settings, loaded]);

  // v1 stored a single `entry` per row. Convert it to an opening BUY fill so nothing is lost, and
  // mark the quantity unknown rather than inventing one.
  function migrateV1(watchlist) {
    return (watchlist || []).map(w => ({
      id: w.id || `${w.symbol}-${Math.random().toString(36).slice(2, 8)}`,
      symbol: w.symbol, currency: w.currency || "USD", thesis: w.note || "",
      levels: [
        ...(w.stop != null ? [{ id: "s", kind: "stop", at: w.stop, note: "" }] : []),
        ...((w.targets || []).map((t, i) => ({ id: "t" + i, kind: "sell", at: t, note: "" }))),
      ],
      fills: (w.entry != null && w.status === "in-trade")
        ? [{ id: "f0", date: w.entryDate || "", side: "buy", qty: null, price: w.entry, note: "migrated from v1 — quantity unknown, please set" }]
        : [],
      tags: [],
    }));
  }

  const touch = () => setDirty(true);

  const baseCcy = settings.baseCurrency || "USD";

  // ── prices + fx ──
  // Only LIVE rows are quoted. A closed archive row needs no price — its P&L is already realised —
  // and quoting one is actively wrong for a symbol that is not a plain equity ticker (an option
  // trade archived under "SPCX" would come back priced as the SPCX stock). Derived here from
  // `rows` alone rather than from `derivedRows`, which depends on `prices` and would make the
  // fetch feed its own input.
  const symbols = useMemo(() => [...new Set(
    rows.filter(r => derivePosition(r.fills || [], { multiplier: r.multiplier }).status !== "closed").map(r => r.symbol).filter(Boolean)
  )], [rows]);
  const usedCcys = useMemo(() => [...new Set([baseCcy, ...rows.map(r => r.currency || "USD")])], [rows, baseCcy]);
  const fxSyms = useMemo(() => fxSymbolsFor(usedCcys), [usedCcys]);
  const fetchKey = [...symbols, ...fxSyms].join(",");
  useEffect(() => { const all = [...symbols, ...fxSyms]; if (all.length) fetchPrices(all); }, [fetchKey]);   // eslint-disable-line
  const { rates: fxRates } = useMemo(() => ratesFrom(prices), [prices]);
  // WHICH RATE. Live spot from /api/prices, refreshed whenever prices are, EXCEPT where a row pins
  // one. Realised P&L is a historical fact: a HK trade closed in July booked a specific number of
  // dollars, and re-converting it at today's spot makes a finished result drift for as long as it
  // sits in the archive. So a row may carry `fxRate` — units of its own currency per 1 USD, the
  // same convention as the Yahoo quotes — and that wins for that row. Unrealised P&L is a live
  // number by nature and always uses spot.
  const rateForRow = (r) => numOrNull(r?.fxRate);
  const toBase = (v, r) => {
    const ccy = (typeof r === "string" ? r : r?.currency) || "USD";
    const pinned = typeof r === "string" ? null : rateForRow(r);
    return convert(v, ccy, baseCcy, pinned != null ? { ...fxRates, [ccy]: pinned } : fxRates);
  };
  const priceOf = (r) => prices?.[r.symbol]?.price ?? null;

  // ── sizing context ──
  const numOrNull = (v) => (v == null || v === "" || !Number.isFinite(+v)) ? null : +v;
  const equityBase = numOrNull(settings.equity);
  const baseRisk = numOrNull(settings.baseRiskPct) ?? DEFAULT_BASE_RISK_PCT;
  const targetPct = numOrNull(settings.targetPct) ?? DEFAULT_TARGET_PCT;
  const mergedSizing = useMemo(() => {
    const out = {};
    for (const k of Object.keys(REGIME_SIZING)) {
      const ov = numOrNull(settings?.sizing?.[k]);
      out[k] = ov != null ? { ...REGIME_SIZING[k], mult: ov } : REGIME_SIZING[k];
    }
    return out;
  }, [settings?.sizing]);
  const regimeCtx = { regimeId: liveRegime?.id, creditDanger, contested, pinnedDiverged: regimeDiverged, sizing: mergedSizing };
  const rm = regimeMultiplier(regimeCtx);

  // ── derive everything from fills ──
  const derivedRows = useMemo(() => rows.map(r => {
    const derived = derivePosition(r.fills || [], { multiplier: r.multiplier });
    return { ...r, derived, pnl: positionPnl(derived, priceOf(r)) };
  }), [rows, prices]);

  const setups   = derivedRows.filter(r => r.derived.status === "setup");
  const openPos  = derivedRows.filter(r => r.derived.status === "open");
  const archived = derivedRows.filter(r => r.derived.status === "closed");
  const summary  = useMemo(() => summarize(derivedRows, toBase), [derivedRows, fxRates, baseCcy]);
  // The archive's OWN numbers. It previously borrowed the book-wide summary, which is how a list of
  // closed trades came to report an unrealised figure — that was the open positions' mark-to-market
  // leaking in. Its realised total was book-wide too, and only matched by luck: the moment an OPEN
  // position books a partial exit, book realised and archive realised diverge.
  const archiveStats = useMemo(() => {
    const conv = archived.map(r => ({ r, v: toBase(r.derived.realized, r) }));
    const ok = conv.filter(c => c.v != null);
    const pcts = archived.map(r => r.derived.realizedPct).filter(v => v != null);
    return {
      realized: +ok.reduce((a, c) => a + c.v, 0).toFixed(2),
      wins: ok.filter(c => c.v > 0).length,
      losses: ok.filter(c => c.v < 0).length,
      winRate: ok.length ? Math.round((ok.filter(c => c.v > 0).length / ok.length) * 100) : null,
      avgPct: pcts.length ? +(pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(2) : null,
      counted: ok.length, unconverted: conv.length - ok.length,
      // Every non-base currency in the archive and the rate each one was converted at.
      ccys: [...new Set(archived.map(r => r.currency || "USD"))].filter(c => c !== baseCcy).map(code => {
        const pinned = archived.some(r => (r.currency || "USD") === code && numOrNull(r.fxRate) != null);
        const one = archived.find(r => (r.currency || "USD") === code && numOrNull(r.fxRate) != null);
        return { code, rate: pinned ? numOrNull(one.fxRate) : fxRates[code] ?? null, pinned };
      }),
    };
  }, [archived, fxRates, baseCcy]);
  const curve    = useMemo(() => realizedCurve(derivedRows, toBase), [derivedRows, fxRates, baseCcy]);

  // ── level alerts (poll cadence — checked whenever prices refresh) ──
  const hits = useMemo(() => levelHits(derivedRows.filter(r => r.derived.status !== "closed"), priceOf), [derivedRows, prices]);
  useEffect(() => {
    if (!settings.alertsEnabled || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const h of hits) {
      const key = `${h.position.id}:${h.level.kind}:${h.level.at}`;
      if (notifiedRef.current.has(key)) continue;
      notifiedRef.current.add(key);
      try { new Notification(`${h.position.symbol} — ${h.level.kind} level`, { body: `${h.level.kind} ${h.level.at}${h.level.to ? "–" + h.level.to : ""} · live ${h.price}` }); } catch { /* ignore */ }
    }
  }, [hits, settings.alertsEnabled]);

  // ── mutations ──
  const addRow = () => {
    const sym = addSym.trim().toUpperCase();
    if (!sym) return;
    const id = `${sym}-${Math.random().toString(36).slice(2, 8)}`;
    setRows(p => [...p, { id, symbol: sym, currency: "USD", thesis: "", levels: [], fills: [], tags: [] }]);
    setAddSym(""); setExpanded(id); touch();
  };
  const upd = (id, patch) => { setRows(p => p.map(r => r.id === id ? { ...r, ...patch } : r)); touch(); };

  // Replace one row with one row PER TRADE, in place so the order of the book is preserved. Each
  // new row inherits the thesis and levels but gets its own id and a date-range label, because from
  // here on they have separate lifecycles — one may be closed and archived while another runs. The
  // fills of each trade are collapsed at the same time: a closed trade collapses exactly, and an
  // open one is left alone if it would not, which collapseFills reports.
  const splitRow = (r, trips) => {
    const made = trips.map((fills, i) => {
      const c = collapseFills(fills, { multiplier: r.multiplier });
      const use = c.exact ? c.fills : fills;
      const d0 = use[0]?.date || "", d1 = use[use.length - 1]?.date || "";
      const closed = derivePosition(use, { multiplier: r.multiplier }).status === "closed";
      return {
        ...r,
        id: `${r.symbol}-${(d0 || d1 || i).toString().replace(/-/g, "")}-${i}`,
        trade: r.trade || (closed && d1 && d1 !== d0 ? `${d0.slice(5)} → ${d1.slice(5)}` : d0 ? `from ${d0.slice(5)}` : `trade ${i + 1}`),
        fills: use,
      };
    });
    setRows(p => p.flatMap(x => x.id === r.id ? made : [x]));
    setExpanded(null); touch();
  };

  // Collapse in place. Refused outright when it would move realised P&L — the button is already
  // hidden in that case, but a stale render must not be able to rewrite a trade's history.
  const collapseRow = (r, col) => {
    if (!col?.exact || !col.fills?.length) return;
    upd(r.id, { fills: col.fills });
  };
  const del = (id) => { setRows(p => p.filter(r => r.id !== id)); touch(); };
  const addLevel = (id, kind) => {
    const r = rows.find(x => x.id === id); if (!r) return;
    // BLANK, not seeded at the live price. Seeding looked helpful and was actively wrong: a buy or
    // sell level AT the current price is hit the instant it is created, so every new level arrived
    // already flashing "⚡ level hit" and the row's alert state became meaningless. A level with no
    // price is inert by construction — `active` filters on `at != null` — and the row says so.
    upd(id, { levels: [...(r.levels || []), { id: Math.random().toString(36).slice(2, 8), kind, at: null, to: null, note: "" }] });
  };
  const updLevel = (id, lid, patch) => {
    const r = rows.find(x => x.id === id); if (!r) return;
    upd(id, { levels: (r.levels || []).map(l => l.id === lid ? { ...l, ...patch } : l) });
  };
  const delLevel = (id, lid) => {
    const r = rows.find(x => x.id === id); if (!r) return;
    upd(id, { levels: (r.levels || []).filter(l => l.id !== lid) });
  };
  // One entry point for every "record what I did" action. "stopped" is a SELL of the whole
  // position prefilled at the stop price — it is the most common exit and had no obvious path.
  const openFill = (r, intent) => {
    const d = derivePosition(r.fills || []);
    const stop = (r.levels || []).find(l => l.kind === "stop");
    const live = priceOf(r);
    setFillFor({
      rowId: r.id,
      side: intent === "buy" ? "buy" : "sell",
      intent,
      qty: intent === "stopped" ? (d.qty || "") : "",
      price: intent === "stopped" ? (stop?.at ?? live ?? "") : (live ?? ""),
      date: new Date().toISOString().slice(0, 10),
      note: intent === "stopped" ? "stopped out" : "",
      // Kept so the form can report slippage against it. A stop triggers a sale; it does not price
      // one, and on a gap the difference is the whole story of the trade.
      stopAt: intent === "stopped" ? (stop?.at ?? null) : null,
    });
  };

  const saveFill = () => {
    const f = fillFor; if (!f) return;
    const qty = +f.qty, price = +f.price;
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price)) { setSaveMsg("A fill needs a positive quantity and a price."); setTimeout(() => setSaveMsg(null), 4000); return; }
    const r = rows.find(x => x.id === f.rowId); if (!r) return;
    const fills = [...(r.fills || []), { id: Math.random().toString(36).slice(2, 8), date: f.date, side: f.side, qty, price, note: f.note || "" }];
    // A LIFECYCLE CHANGE needs saying out loud. Selling the last unit moves the row out of Open
    // positions and into a section that is collapsed by default, so with no announcement the row
    // simply disappeared — indistinguishable from having deleted it, on the one action in the tab
    // that is hardest to undo.
    const before = derivePosition(r.fills || [], { multiplier: r.multiplier });
    const after = derivePosition(fills, { multiplier: r.multiplier });
    upd(f.rowId, { fills });
    setFillFor(null);
    if (after.status !== before.status) {
      setMoved({
        id: f.rowId, symbol: r.symbol, to: after.status, currency: r.currency,
        realized: after.realized, realizedPct: after.realizedPct,
      });
      if (after.status === "closed") setShowArchive(true);   // land where the row went
    }
  };
  const delFill = (rowId, fid) => {
    const r = rows.find(x => x.id === rowId); if (!r) return;
    upd(rowId, { fills: (r.fills || []).filter(f => f.id !== fid) });
  };

  const saveCloud = async () => {
    setSaving(true); setSaveMsg(null);
    try {
      const res = await fetch("/api/manual-entry", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ console: { rows, settings } }),
      });
      const j = await res.json().catch(() => null);
      if (res.ok) {
        const stored = j?.console?.stored;
        setDirty(false);
        setSaveMsg(stored === "kv" ? "Synced across devices ✓" : stored === "none" ? "Saved in this browser only — sync not configured." : "Saved ✓");
        if (stored) setKvOn(stored === "kv");
      } else if (res.status === 401) setSaveMsg("Log in to sync (kept locally).");
      else setSaveMsg(`Save failed (${res.status}) — kept locally.`);
    } catch { setSaveMsg("Save failed — kept locally."); }
    setSaving(false); setTimeout(() => setSaveMsg(null), 6000);
  };

  // ── import / export ──
  const exportJson = () => JSON.stringify({ rows, settings }, null, 2);
  const doImport = (mode) => {
    setImportMsg(null);
    let p; try { p = JSON.parse(importTxt); } catch { setImportMsg({ err: "That is not valid JSON." }); return; }
    const incoming = Array.isArray(p?.rows) ? p.rows : Array.isArray(p?.watchlist) ? migrateV1(p.watchlist) : null;
    if (!incoming && !p?.settings) { setImportMsg({ err: "No rows or settings found in that payload." }); return; }
    if (incoming) {
      const clean = incoming.map(r => ({
        id: r.id || `${String(r.symbol || "").toUpperCase()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol: String(r.symbol || "").toUpperCase(), currency: (r.currency || "USD").toUpperCase(),
        thesis: r.thesis || "", trade: r.trade ? String(r.trade).slice(0, 40) : "",
        multiplier: Number.isFinite(+r.multiplier) && +r.multiplier > 0 ? +r.multiplier : 1,
        fxRate: Number.isFinite(+r.fxRate) && +r.fxRate > 0 ? +r.fxRate : null,
        levels: Array.isArray(r.levels) ? r.levels : [],
        fills: Array.isArray(r.fills) ? r.fills : [], tags: Array.isArray(r.tags) ? r.tags : [],
      })).filter(r => r.symbol);
      if (mode === "replace") setRows(clean);
      else {
        // Merge on ROW ID, not on symbol. One symbol can legitimately hold several rows — two
        // separate METU trades, one archived and one open, are two trades and not one position —
        // so keying by symbol silently collapsed them into whichever arrived last. A payload
        // without ids (or with unrecognised ones) falls back to a symbol match ONLY when that
        // symbol is unambiguous; otherwise the row is added rather than overwriting a guess.
        const next = [...rows];
        const byId = new Map(next.map((r, i) => [r.id, i]));
        const symCount = new Map();
        for (const r of next) symCount.set(r.symbol, (symCount.get(r.symbol) || 0) + 1);
        for (const r of clean) {
          let i = byId.has(r.id) ? byId.get(r.id) : -1;
          if (i < 0 && symCount.get(r.symbol) === 1) i = next.findIndex(x => x.symbol === r.symbol);
          if (i >= 0) next[i] = { ...next[i], ...r, id: next[i].id };
          else { byId.set(r.id, next.length); symCount.set(r.symbol, (symCount.get(r.symbol) || 0) + 1); next.push(r); }
        }
        setRows(next);
      }
      setImportMsg({ ok: `Loaded ${clean.length} row${clean.length === 1 ? "" : "s"}. Press “Save to cloud” to sync.` });
    }
    if (p.settings) setSettings(s => ({ ...s, ...p.settings }));
    touch(); setImportTxt("");
  };

  // ── presentation helpers ──
  const chip = (t, col, bg, bd) => <span style={{ background: bg, color: col, border: "1px solid " + bd, borderRadius: 6, padding: "1px 7px", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap" }}>{t}</span>;
  const ccyChip = (ccy) => { if (ccy === baseCcy) return null; const r = fxRisk(ccy, baseCcy); return chip(ccy + (r.real ? "" : " 🔒"), r.real ? C.amber : C.mid, r.real ? C.aBg : C.bg, r.real ? C.aBdr : C.bdr); };
  const fitChip = (f) => f === "tailwind" ? chip("regime tailwind", C.green, "#F0FDF4", "#BBF7D0") : f === "headwind" ? chip("fights regime", C.red, "#FEF2F2", "#FECACA") : null;

  const nInput = (v, on, ph, w = 84) => <input value={v ?? ""} onChange={e => on(e.target.value)} placeholder={ph} inputMode="decimal" style={{ width: w, padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12.5, background: C.surf, color: C.text }} />;
  const kindCol = (k) => k === "buy" ? C.green : k === "sell" ? C.blue : C.red;
  const money = (v, ccy) => v == null ? "—" : fmtCcy(v, ccy);
  const pnlCol = (v) => v == null ? C.muted : v > 0 ? C.green : v < 0 ? C.red : C.mid;

  // A level's live state: how far away, and whether it is currently hit.  // Everything the hoisted row components need from this closure, in one object. Recreated each
  // render, which is fine: the COMPONENT identities are stable, so React re-renders rather than
  // remounting, and focus is preserved.
  const ctx = {
    prices, priceOf, liveRegime, expanded, setExpanded, upd, del, splitRow, collapseRow, addLevel, updLevel, delLevel,
    openFill, delFill, fillFor, setFillFor, saveFill, sizeOpen, setSizeOpen, justMoved: moved?.id ?? null, drafts, setDraft, clearDraft, nInput, chip, ccyChip, fitChip, kindCol, money, pnlCol,
    equityBase, baseCcy, fxRates, regimeCtx, mergedSizing, baseRisk, targetPct, numOrNull,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── STICKY SAVE STATE ──
          The only answer to "did that save?" used to be a toolbar button at the top of the tab,
          which is off screen the moment you open a row to edit it. This follows you down the page
          and is the same control, so the question is answerable wherever the editing happens. */}
      {dirty && (
        <div style={{ position: "sticky", top: 8, zIndex: 20, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          padding: "8px 13px", borderRadius: 10, background: C.aBg, border: "1.5px solid " + C.aBdr, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}>
          <b style={{ fontSize: 12.5, color: C.amber }}>Unsaved changes</b>
          <span style={{ fontSize: 11.5, color: C.mid }}>Kept in this browser already — syncing carries them to your other devices.</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            {saveMsg && <span style={{ fontSize: 11.5, color: C.mid }}>{saveMsg}</span>}
            <Btn onClick={saveCloud} disabled={saving} color="#fff" bgColor={C.blue} label={saving ? "Saving…" : "☁ Save to cloud"} />
          </span>
        </div>
      )}

      {/* ── SECTION CHANGE ──
          Says where the row went, and what it booked on the way. */}
      {moved && (
        // STICKY, and it stays until dismissed. Rendered as an ordinary block at the top of the tab
        // it appeared above wherever you were standing — you record a fill from the row, which is
        // most of a page down, so the notice was off screen the entire time it existed. It also
        // used to time out after nine seconds, which is not long enough to walk down to the archive
        // and back, and a notice about the least reversible action in the tab should be dismissed
        // deliberately rather than on a clock.
        <div className="dvcap-toast" style={{ position: "sticky", top: 8, zIndex: 21, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "9px 13px", borderRadius: 10, boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
          background: moved.to === "closed" ? "#F0FDF4" : C.blBg, border: "1.5px solid " + (moved.to === "closed" ? "#BBF7D0" : C.blBdr) }}>
          <b style={{ fontSize: 13, color: moved.to === "closed" ? C.green : C.blue }}>
            {moved.symbol} {moved.to === "closed" ? "closed out" : moved.to === "open" ? "is now an open position" : "is back to a setup"}
          </b>
          {moved.to === "closed" && (
            <span style={{ fontSize: 12.5, color: C.mid }}>
              Realised <b style={{ color: pnlCol(moved.realized) }}>{(moved.realized > 0 ? "+" : "") + fmtCcy(moved.realized, moved.currency)}</b>
              {moved.realizedPct != null && <b style={{ color: pnlCol(moved.realizedPct) }}> {(moved.realizedPct > 0 ? "+" : "") + moved.realizedPct}%</b>}
              {" — moved to the archive below, nothing was deleted."}
            </span>
          )}
          <button onClick={() => setMoved(null)} title="dismiss"
            style={{ marginLeft: "auto", cursor: "pointer", background: C.surf, border: "1.5px solid " + C.bdr, borderRadius: 7, padding: "2px 9px", color: C.mid, fontWeight: 800, fontSize: 12 }}>✕ Got it</button>
        </div>
      )}

      {/* purpose + regime */}
      <div style={{ background: liveRegime?.bg || C.surf, border: "1.5px solid " + (liveRegime?.bdr || C.bdr), borderTop: "4px solid " + (liveRegime?.color || C.blue), borderRadius: 12, padding: "12px 16px" }}>
        <div style={{ fontSize: 13.5, color: C.mid, lineHeight: 1.55 }}>
          <b style={{ color: C.text }}>Setups and levels.</b> What you are waiting for, and whether it has arrived —
          checked against live prices each time this loads.
          <span style={{ color: C.muted }}> Spot, swing and long holds only; day trades and scalps stay in the broker. Poll-cadence, not streaming; nothing here places orders.</span>
        </div>
        <div style={{ marginTop: 8, fontSize: 12.5, color: C.mid, lineHeight: 1.6, background: "rgba(255,255,255,0.55)", border: "1px solid " + C.bdr, borderRadius: 8, padding: "8px 11px" }}>
          <b style={{ color: C.text }}>How it works:</b> add a ticker, give it <b>levels</b> (buy / sell / stop — a single price or a zone).
          It sits in <b>Setups</b> and every load checks the live price against those levels, flagging any that are hit.
          When you actually trade it, press <b style={{ color: C.green }}>✓ I bought</b> — that records a <b>fill</b> (quantity + price)
          and moves it to <b>Open positions</b>. Buying more or selling part adds another fill, so scaling in and out is just more fills:
          your average cost, realised and unrealised P&amp;L are all worked out from them. Sell everything (or press <b style={{ color: C.red }}>🛑 Stopped out</b>) and it moves to <b>Archive</b>.
          <span style={{ color: C.muted }}> Position size is the quantity you enter on a fill.</span>
        </div>
        <div style={{ marginTop: 7, display: "flex", gap: "5px 14px", flexWrap: "wrap", alignItems: "baseline", fontSize: 13 }}>
          <span style={{ color: C.lbl, fontWeight: 700 }}>Live regime:</span>
          <b style={{ color: liveRegime?.color }}>{liveRegime?.label} {regimeProbFor(liveRegime?.id)}%</b>
          {contested && chip("⚖ CONTESTED", C.amber, C.aBg, C.aBdr)}
          {regimeDiverged && chip("📌 PINNED≠LIVE", C.amber, C.aBg, C.aBdr)}
        </div>
      </div>

      {/* level hits — the reason this tab exists */}
      {hits.length > 0 && (
        <div style={{ background: C.aBg, border: "1.5px solid " + C.aBdr, borderRadius: 12, padding: "11px 14px" }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: C.amber, marginBottom: 7 }}>⚡ Levels hit ({hits.length})</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {hits.map((h, i) => (
              <span key={i} style={{ background: C.surf, border: "1.5px solid " + kindCol(h.level.kind), borderRadius: 8, padding: "4px 10px", fontSize: 12.5, fontWeight: 700 }}>
                <b>{h.position.symbol}</b> <span style={{ color: kindCol(h.level.kind) }}>{h.level.kind}</span> {h.level.at}{h.level.to ? `–${h.level.to}` : ""} · live {h.price}
                {h.level.note && <span style={{ color: C.lbl, fontWeight: 500 }}> · {h.level.note}</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* toolbar */}
      <Card>
        <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
          <input value={addSym} onChange={e => setAddSym(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addRow(); }} placeholder="Add a setup (ticker)"
            style={{ width: 180, padding: "6px 10px", border: "1.5px solid " + C.bdr, borderRadius: 8, fontSize: 13, background: C.surf, color: C.text, textTransform: "uppercase" }} />
          <Btn onClick={addRow} color="#fff" bgColor={C.blue} label="+ Add" />
          <label style={{ fontSize: 12, color: C.lbl, fontWeight: 700, display: "flex", gap: 6, alignItems: "center" }}>
            Base
            <select value={baseCcy} onChange={e => { setSettings(s => ({ ...s, baseCurrency: e.target.value })); touch(); }} style={{ padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12.5, background: C.surf, color: C.text }}>
              {CURRENCY_CODES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <button onClick={async () => { if (typeof Notification !== "undefined" && Notification.permission !== "granted") { try { await Notification.requestPermission(); } catch { /* ignore */ } } setSettings(s => ({ ...s, alertsEnabled: !s.alertsEnabled })); touch(); }}
            style={{ cursor: "pointer", background: settings.alertsEnabled ? C.green : C.surf, color: settings.alertsEnabled ? "#fff" : C.mid, border: "1.5px solid " + (settings.alertsEnabled ? C.green : C.bdr), borderRadius: 8, padding: "6px 11px", fontSize: 12.5, fontWeight: 800 }}>
            {settings.alertsEnabled ? "🔔 Alerts on" : "🔕 Alerts off"}
          </button>
          <div style={{ marginLeft: "auto", display: "flex", gap: 9, alignItems: "center" }}>
            {kvOn === false && <span style={{ fontSize: 11.5, color: C.amber, fontWeight: 700 }}>⚠ this browser only</span>}
            {kvOn === true && <span style={{ fontSize: 11.5, color: C.green, fontWeight: 700 }}>☁ syncing</span>}
            {saveMsg && <span style={{ fontSize: 12, color: C.mid }}>{saveMsg}</span>}
            <Btn onClick={() => fetchPrices([...symbols, ...fxSyms])} disabled={pricesLoading || !symbols.length} color={C.mid} bgColor={C.bg} label={pricesLoading ? "…" : "🔄 Prices"} />
            <Btn onClick={saveCloud} disabled={saving} color="#fff" bgColor={dirty ? C.blue : C.bdrMd} label={saving ? "Saving…" : dirty ? "☁ Save to cloud" : "☁ Synced"} />
          </div>
        </div>
      </Card>

      {/* ── CURRENT PORTFOLIO ──
          Same visual idiom as the Smart Money tab (donut for weight, horizontal bars for the
          per-name read) so the two tabs are read the same way. Everything is converted into the
          base currency; a position whose FX rate is missing is EXCLUDED and counted, never added
          at face value in the wrong currency. */}
      {openPos.length > 0 && (() => {
        const held = openPos.map(r => {
          const mv = r.pnl.marketValue == null ? null : toBase(r.pnl.marketValue, r);
          const un = r.pnl.unrealized == null ? null : toBase(r.pnl.unrealized, r);
          const re = toBase(r.derived.realized, r);
          return { ...r, mvBase: mv, unBase: un, reBase: re, totalBase: (un ?? 0) + (re ?? 0) };
        });
        const priced = held.filter(h => h.mvBase != null && h.mvBase > 0);
        const missing = held.length - priced.length;
        const totalMv = priced.reduce((a, h) => a + h.mvBase, 0);
        const pie = priced.map(h => ({ name: h.symbol, value: +h.mvBase.toFixed(2), pct: totalMv ? +((h.mvBase / totalMv) * 100).toFixed(1) : 0 }))
          .sort((a, b) => b.value - a.value);
        const bars = held.filter(h => h.unBase != null || h.reBase)
          .map(h => ({ name: h.symbol, unrealised: +(h.unBase ?? 0).toFixed(2), realised: +(h.reBase ?? 0).toFixed(2), total: +h.totalBase.toFixed(2) }))
          .sort((a, b) => b.total - a.total);
        const PAL = ["#1E40AF", "#0F766E", "#B45309", "#6D28D9", "#BE185D", "#047857", "#C2410C", "#4338CA", "#0E7490", "#7C2D12"];
        const cashPct = equityBase && totalMv ? Math.max(0, +(100 - (totalMv / equityBase) * 100).toFixed(1)) : null;
        return (
          <Card>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
              <SLabel>Current portfolio</SLabel>
              <span style={{ fontSize: 12, color: C.muted }}>{priced.length} priced position{priced.length === 1 ? "" : "s"} · {baseCcy}</span>
              <div style={{ marginLeft: "auto", display: "flex", gap: 16, alignItems: "baseline", fontSize: 13 }}>
                <span><span style={{ color: C.lbl, fontSize: 10.5, fontWeight: 800 }}>INVESTED </span><b>{fmtCcy(totalMv, baseCcy)}</b></span>
                {cashPct != null && <span><span style={{ color: C.lbl, fontSize: 10.5, fontWeight: 800 }}>CASH </span><b>{cashPct}%</b></span>}
                <span><span style={{ color: C.lbl, fontSize: 10.5, fontWeight: 800 }}>OPEN P&amp;L </span>
                  <b style={{ color: pnlCol(bars.reduce((a, b) => a + b.total, 0)) }}>{fmtCcy(bars.reduce((a, b) => a + b.total, 0), baseCcy)}</b></span>
              </div>
            </div>
            {missing > 0 && (
              <div style={{ fontSize: 11.5, color: C.amber, fontWeight: 700, marginBottom: 6 }}>
                ⚠ {missing} position{missing === 1 ? "" : "s"} not shown — no live price or no {baseCcy} rate yet. Refresh prices.
              </div>
            )}
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {/* weight */}
              <div style={{ flex: "1 1 280px", minWidth: 260 }}>
                <div style={{ fontSize: 10.5, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>Weight by market value</div>
                <div style={{ height: 230 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pie} cx="50%" cy="48%" innerRadius={44} outerRadius={72} dataKey="value" stroke="#fff" strokeWidth={2}
                      /* Only label slices with room for one. With nine positions where a cash leg is
                         ~60%, the remaining labels stack on top of each other and become unreadable;
                         the tooltip still names every slice on hover. */
                      label={(e) => (e.pct >= 5 ? `${e.name} ${e.pct}%` : "")} labelLine={false} fontSize={10}>
                      {pie.map((e, i) => <Cell key={e.name} fill={PAL[i % PAL.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v, n, p) => [`${fmtCcy(v, baseCcy)} (${p?.payload?.pct}%)`, n]}
                      contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid " + C.bdr }} />
                  </PieChart>
                </ResponsiveContainer>
                </div>
              </div>
              {/* per-name P&L, split realised vs unrealised — the scale-out case made visible */}
              <div style={{ flex: "1 1 320px", minWidth: 280 }}>
                <div style={{ fontSize: 10.5, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span>P&amp;L by position</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 600, textTransform: "none", letterSpacing: 0, color: C.lbl }}>
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: C.green, display: "inline-block" }} />realised
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: C.blue, display: "inline-block", marginLeft: 6 }} />unrealised
                    </span>
                  </span>
                </div>
                <div style={{ height: 230 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={bars} layout="vertical" margin={{ left: 6, right: 18, top: 4, bottom: 6 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.bdr} horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 10, fill: C.lbl }} tickLine={false} axisLine={{ stroke: C.bdr }} />
                    <YAxis type="category" dataKey="name" width={62} tick={{ fontSize: 11, fill: C.mid }} tickLine={false} axisLine={false} />
                    <Tooltip formatter={(v, n) => [fmtCcy(v, baseCcy), n]} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid " + C.bdr }} />
                    <ReferenceLine x={0} stroke={C.bdrMd} />
                    <Bar dataKey="realised" stackId="p" fill={C.green} radius={[0, 0, 0, 0]} />
                    <Bar dataKey="unrealised" stackId="p" radius={[0, 4, 4, 0]}>
                      {bars.map(b => <Cell key={b.name} fill={b.unrealised >= 0 ? C.blue : C.red} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                </div>
              </div>
            </div>
            {pie.filter(p => p.pct < 5).length > 0 && (
              <div style={{ fontSize: 11, color: C.lbl, marginTop: 8, lineHeight: 1.5 }}>
                <b style={{ color: C.muted }}>Under 5%:</b> {pie.filter(p => p.pct < 5).map(p => `${p.name} ${p.pct}%`).join(" · ")}
              </div>
            )}
            <div style={{ fontSize: 11, color: C.lbl, marginTop: 8, paddingTop: 8, borderTop: "1px solid " + C.bdr, lineHeight: 1.5 }}>
              Realised bars are profit already taken on scale-outs, so a position can show both at once. Cash % assumes your account equity above is the whole book.
            </div>
          </Card>
        );
      })()}

      {/* sizing settings */}
      <Card>
        <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
          <SLabel>Sizing</SLabel>
          <span style={{ fontSize: 11.5, color: C.muted }}>suggestions only — shown beside your own number, never applied</span>
          <span style={{ marginLeft: "auto", fontSize: 12.5 }}>
            <span style={{ color: C.lbl, fontWeight: 700 }}>regime ×</span> <b style={{ color: liveRegime?.color }}>{rm.mult.toFixed(2)}</b>
            <span style={{ color: C.muted, fontSize: 11.5 }}> ({rm.reasons[rm.reasons.length - 1]})</span>
          </span>
        </div>
        <div style={{ marginTop: 9, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ fontSize: 12, color: C.lbl, fontWeight: 700 }}>Account equity ({baseCcy})<br />
            <NumCommit dk="equity" drafts={drafts} setDraft={setDraft} clearDraft={clearDraft} value={settings.equity} placeholder="e.g. 208597" width={124}
              title="A rough figure is fine — sizing is linear in equity, so being 5% out moves a suggestion by 5%."
              onCommit={v => { setSettings(x => ({ ...x, equity: v, equityAsOf: new Date().toISOString().slice(0, 10) })); touch(); }} />
            {(() => {
              const f = equityFreshness(settings.equityAsOf);
              if (settings.equity == null) return null;
              return (
                <div style={{ fontSize: 10.5, fontWeight: 600, color: f.stale ? C.amber : C.lbl, marginTop: 2 }}
                  title={`Sizing scales linearly with equity, so it is refreshed on your schedule rather than synced — a figure within ~${EQUITY_STALE_DAYS} days is plenty.`}>
                  {f.days == null ? "no date recorded" : f.days === 0 ? "as of today" : `as of ${settings.equityAsOf} · ${f.days}d ago`}
                  {f.stale ? " ⚠" : ""}
                </div>
              );
            })()}
          </label>
          <label style={{ fontSize: 12, color: C.lbl, fontWeight: 700 }}>Risk / trade (%)<br />
            {nInput(settings.baseRiskPct, v => { setSettings(x => ({ ...x, baseRiskPct: v === "" ? null : v })); touch(); }, "1", 64)}</label>
          <label style={{ fontSize: 12, color: C.lbl, fontWeight: 700 }}>Default allocation (%)<br />
            {nInput(settings.targetPct, v => { setSettings(x => ({ ...x, targetPct: v === "" ? null : v })); touch(); }, "5", 64)}</label>
          <div style={{ fontSize: 11.5, color: C.muted, flex: "1 1 240px", lineHeight: 1.55 }}>
            <b style={{ color: C.mid }}>Equity is meant to be approximate.</b> Sizing is linear in it, so a figure 5% out moves a
            suggestion by 5% — which never changes a swing decision. Refresh it when the book has moved materially, not daily;
            sizes are rounded to match that precision.<br />
            <b>Risk</b> sizes so a stop-out costs a fixed % of the book — for swings with an invalidation level.
            <b> Allocation</b> targets a % of the book — for long holds where the thesis, not a price, is the exit.
            Each position picks its own; both are scaled by the regime multiplier and netted against what you already hold.
          </div>
        </div>
        <div style={{ marginTop: 11 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Regime multipliers</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
            {Object.keys(REGIME_SIZING).map(k => {
              const isLive = liveRegime?.id === k;
              return (
                <label key={k} style={{ fontSize: 11.5, color: isLive ? C.text : C.lbl, fontWeight: isLive ? 800 : 600, border: "1.5px solid " + (isLive ? (liveRegime?.color || C.blue) : C.bdr), borderRadius: 8, padding: "5px 9px", background: isLive ? (liveRegime?.bg || C.surf) : C.surf }}>
                  {REGIME_SIZING[k].label}{isLive ? " ● live" : ""}<br />
                  {nInput(settings?.sizing?.[k] ?? REGIME_SIZING[k].mult, v => { setSettings(x => ({ ...x, sizing: { ...(x.sizing || {}), [k]: v === "" ? null : v } })); touch(); }, String(REGIME_SIZING[k].mult), 60)}
                </label>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: C.lbl, marginTop: 6 }}>Credit-DANGER caps the multiplier at {CREDIT_DANGER_CAP_LABEL}; a contested or pinned≠live regime applies a further ×0.7.</div>
        </div>
      </Card>

      <Section title="Setups — waiting" note="no position yet; levels are being watched" list={setups} mode="setup" ctx={ctx} />
      {/* Biggest first. Import order is meaningless, and the position that most deserves a second
          look each morning is the one carrying the most of the book. Rows whose market value cannot
          be converted sort last rather than to the top as a zero. */}
      <Section title="Open positions" note="spot / swing holds, scaled in and out"
        list={[...openPos].sort((a, b) => (convert(b.pnl.marketValue, b.currency || "USD", baseCcy, fxRates) ?? -1) - (convert(a.pnl.marketValue, a.currency || "USD", baseCcy, fxRates) ?? -1))}
        mode="open" ctx={ctx} />

      {/* archive: brief, with the performance summary */}
      <Card>
        <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
          <SLabel>Archive — closed</SLabel>
          <span style={{ fontSize: 12, color: C.muted }}>{archived.length}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 14, alignItems: "baseline", fontSize: 13 }}>
            {/* Closed trades have no unrealised P&L by definition — every one of them is flat.
                Average return replaces it: the figure that says whether the trades were any good,
                which a total cannot, since it is dominated by whichever was largest. */}
            <span><span style={{ color: C.lbl, fontSize: 11, fontWeight: 700 }}>REALISED </span><b style={{ color: pnlCol(archiveStats.realized) }}>{fmtCcy(archiveStats.realized, baseCcy)}</b></span>
            <span><span style={{ color: C.lbl, fontSize: 11, fontWeight: 700 }}>AVG RETURN </span><b style={{ color: pnlCol(archiveStats.avgPct) }}>{archiveStats.avgPct == null ? "—" : (archiveStats.avgPct > 0 ? "+" : "") + archiveStats.avgPct + "%"}</b></span>
            <span><span style={{ color: C.lbl, fontSize: 11, fontWeight: 700 }}>WIN RATE </span><b style={{ color: C.text }}>{archiveStats.winRate == null ? "—" : archiveStats.winRate + "%"}</b></span>
            <button onClick={() => setShowArchive(v => !v)} style={{ cursor: "pointer", background: C.surf, color: C.mid, border: "1.5px solid " + C.bdr, borderRadius: 7, padding: "4px 10px", fontSize: 12, fontWeight: 700 }}>{showArchive ? "Hide" : "Show"}</button>
          </div>
        </div>
        {/* Which rate produced these numbers. A total in USD built from HKD rows is only as good as
            the rate behind it, and that rate was invisible. */}
        {archiveStats.ccys.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 11, color: C.muted }}>
            Converted into {baseCcy} at {archiveStats.ccys.map(c => (
              <span key={c.code} style={{ color: c.pinned ? C.mid : C.muted, fontWeight: c.pinned ? 700 : 500 }}>
                {c.code} {c.rate ? c.rate.toFixed(4) : "—"}{c.pinned ? " (pinned)" : ""}{" "}
              </span>
            ))}
            · live rates come from the same quote refresh as prices; a row can pin its own in the editor.
          </div>
        )}
        {archiveStats.unconverted > 0 && (
          <div style={{ marginTop: 7, fontSize: 11.5, color: C.amber, fontWeight: 700 }}>
            ⚠ {archiveStats.unconverted} closed trade{archiveStats.unconverted === 1 ? "" : "s"} excluded from these totals — no FX rate available to convert into {baseCcy}. Refresh prices.
          </div>
        )}

        {/* Realised curve — when profit was actually taken.
            The chart box is fixed-height and the ResponsiveContainer fills 100% of it, so anything
            else inside overflows it: the caption was landing on top of the table header underneath,
            which is what the mobile screenshot showed. Caption is a sibling now, not a child. The
            two portfolio charts had the same shape, with their headings eating into the plot. */}
        {curve.length > 1 && (
          <div style={{ marginTop: 12 }}>
          <div style={{ height: 190 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={curve} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                <defs><linearGradient id="rc" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.green} stopOpacity={0.35} /><stop offset="100%" stopColor={C.green} stopOpacity={0.03} />
                </linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke={C.bdr} vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.lbl }} tickLine={false} axisLine={{ stroke: C.bdr }} />
                <YAxis tick={{ fontSize: 10, fill: C.lbl }} tickLine={false} axisLine={false} width={54} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid " + C.bdr }}
                  formatter={(v, n) => [fmtCcy(v, baseCcy), n === "cumulative" ? "cumulative realised" : n]}
                  labelFormatter={(l, pl) => `${l}${pl?.[0]?.payload?.symbol ? " · " + pl[0].payload.symbol : ""}`} />
                <Area type="monotone" dataKey="cumulative" stroke={C.green} strokeWidth={2} fill="url(#rc)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
            <div style={{ fontSize: 11, color: C.lbl, textAlign: "center", marginTop: 6 }}>Cumulative realised P&amp;L in {baseCcy} — one step per sell fill, so the curve marks when profit was actually taken.</div>
          </div>
        )}

        {showArchive && archived.length > 0 && (
          <div className="dvcap-wide-only" style={{ marginTop: 12, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 520 }}>
              <thead><tr>{["Trade", "Held", "Size", "Entry", "Exit", "Realised", "Return"].map(h => (
                <th key={h} style={{ textAlign: "left", color: C.mid, padding: "6px 10px", borderBottom: "1.5px solid " + C.bdr, fontWeight: 700, fontSize: 11.5 }}>{h}</th>))}</tr></thead>
              <tbody>
                {[...archived].sort((a, b) => String(b.derived.lastDate || "").localeCompare(String(a.derived.lastDate || ""))).map(r => {
                  const td = { padding: "6px 10px", borderBottom: "1px solid " + C.bdr };
                  const days = daysBetween(r.derived.firstDate, r.derived.lastDate);
                  return (
                    <tr key={r.id} title={r.thesis || ""}>
                      <td style={{ ...td, fontWeight: 700 }}>{r.symbol} {ccyChip(r.currency)}
                        {r.derived.multiplier > 1 ? <span style={{ fontWeight: 700, color: C.amber, fontSize: 11 }}> ×{r.derived.multiplier}</span> : null}
                        {r.trade ? <span style={{ fontWeight: 600, color: C.lbl, fontSize: 11.5 }}> · {r.trade}</span> : null}</td>
                      <td style={{ ...td, color: C.lbl, whiteSpace: "nowrap" }}>
                        {r.derived.firstDate || "?"} → {r.derived.lastDate || "?"}{days == null ? "" : ` · ${days}d`}</td>
                      <td style={td}>{r.derived.bought}</td>
                      <td style={td}>{r.derived.avgEntry == null ? "—" : r.derived.avgEntry.toFixed(4)}</td>
                      <td style={td}>{r.derived.avgExit == null ? "—" : r.derived.avgExit.toFixed(4)}</td>
                      <td style={{ ...td, fontWeight: 700, color: pnlCol(r.derived.realized) }}>{money(r.derived.realized, r.currency)}</td>
                      <td style={{ ...td, color: pnlCol(r.derived.realizedPct) }}>{r.derived.realizedPct == null ? "—" : (r.derived.realizedPct > 0 ? "+" : "") + r.derived.realizedPct + "%"}</td>
                    </tr>
                  );
                })}
              </tbody>
              {/* Totals are in the BASE currency, so a row whose FX rate is missing is left out and
                  counted rather than added at face value in the wrong currency. */}
              <tfoot><tr>
                <td colSpan={5} style={{ padding: "8px 10px", borderTop: "1.5px solid " + C.bdr, color: C.mid, fontWeight: 700 }}>
                  {archiveStats.counted} closed trade{archiveStats.counted === 1 ? "" : "s"} in {baseCcy} · {archiveStats.wins} up / {archiveStats.losses} down
                  {archiveStats.unconverted ? ` · ${archiveStats.unconverted} excluded (no FX rate)` : ""}
                </td>
                <td colSpan={2} style={{ padding: "8px 10px", borderTop: "1.5px solid " + C.bdr, fontWeight: 800, color: pnlCol(archiveStats.realized) }}>
                  {(archiveStats.realized > 0 ? "+" : "") + money(archiveStats.realized, baseCcy)}
                </td>
              </tr></tfoot>
            </table>
          </div>
        )}

        {/* The same rows, laid out for a phone. Seven columns do not fit on one, and the four that
            fell off the right were the ones carrying the result. */}
        {showArchive && archived.length > 0 && (
          <div className="dvcap-narrow-only" style={{ marginTop: 12 }}>
            {[...archived].sort((a, b) => String(b.derived.lastDate || "").localeCompare(String(a.derived.lastDate || ""))).map(r => {
              const days = daysBetween(r.derived.firstDate, r.derived.lastDate);
              const d = r.derived;
              return (
                <div key={r.id} style={{ border: "1px solid " + C.bdr, borderLeft: "4px solid " + (d.realized >= 0 ? C.green : C.red), borderRadius: 9, padding: "9px 11px", marginBottom: 7 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 7, flexWrap: "wrap" }}>
                    <b style={{ fontSize: 13.5 }}>{r.symbol}</b>
                    {ccyChip(r.currency)}
                    {d.multiplier > 1 ? <span style={{ fontWeight: 700, color: C.amber, fontSize: 11 }}>×{d.multiplier}</span> : null}
                    {r.trade ? <span style={{ fontSize: 11.5, color: C.lbl }}>{r.trade}</span> : null}
                    <span style={{ marginLeft: "auto", display: "inline-flex", gap: 7, alignItems: "baseline" }}>
                      <b style={{ fontSize: 13, color: pnlCol(d.realized) }}>{(d.realized > 0 ? "+" : "") + money(d.realized, r.currency)}</b>
                      <b style={{ fontSize: 12.5, color: pnlCol(d.realizedPct) }}>{d.realizedPct == null ? "" : (d.realizedPct > 0 ? "+" : "") + d.realizedPct + "%"}</b>
                    </span>
                  </div>
                  <div style={{ fontSize: 11.5, color: C.lbl, marginTop: 3 }}>
                    {d.firstDate || "?"} → {d.lastDate || "?"}{days == null ? "" : ` · ${days}d`} · {d.bought} @ {d.avgEntry == null ? "—" : d.avgEntry.toFixed(4)} → {d.avgExit == null ? "—" : d.avgExit.toFixed(4)}
                  </div>
                </div>
              );
            })}
            <div style={{ fontSize: 12, fontWeight: 700, color: C.mid, marginTop: 8 }}>
              {archiveStats.counted} closed in {baseCcy} · {archiveStats.wins} up / {archiveStats.losses} down
              <b style={{ color: pnlCol(archiveStats.realized), marginLeft: 8 }}>{(archiveStats.realized > 0 ? "+" : "") + money(archiveStats.realized, baseCcy)}</b>
            </div>
          </div>
        )}
      </Card>


      {/* import / export */}
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <SLabel>Import / export</SLabel>
          <span style={{ fontSize: 11.5, color: C.muted }}>seed, back up, or move between devices</span>
          <button onClick={() => setPortOpen(o => !o)} style={{ marginLeft: "auto", cursor: "pointer", background: C.surf, color: C.mid, border: "1.5px solid " + C.bdr, borderRadius: 8, padding: "5px 12px", fontSize: 12, fontWeight: 700 }}>{portOpen ? "Hide" : "Open"}</button>
        </div>
        {portOpen && (
          <div style={{ marginTop: 10 }}>
            <textarea value={importTxt} onChange={e => setImportTxt(e.target.value)} placeholder='{"rows":[{"symbol":"GLD","currency":"USD","thesis":"...","levels":[{"kind":"buy","at":300,"to":310}],"fills":[]}]}'
              style={{ width: "100%", boxSizing: "border-box", minHeight: 100, padding: "9px 11px", border: "1.5px solid " + C.bdr, borderRadius: 8, fontSize: 12, fontFamily: "ui-monospace, Menlo, monospace", background: C.surf, color: C.text }} />
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Btn onClick={() => doImport("merge")} disabled={!importTxt.trim()} color="#fff" bgColor={C.blue} label="Merge in" />
              <Btn onClick={() => doImport("replace")} disabled={!importTxt.trim()} color={C.red} bgColor={C.surf} label="Replace all" />
              <Btn onClick={() => { setImportTxt(exportJson()); setImportMsg({ ok: "Exported below — copy it somewhere safe." }); }} color={C.mid} bgColor={C.bg} label="⬇ Export" />
              {importMsg && <span style={{ fontSize: 12, fontWeight: 600, color: importMsg.err ? C.red : C.green }}>{importMsg.err || importMsg.ok}</span>}
            </div>
          </div>
        )}
      </Card>

      <div style={{ color: C.lbl, fontSize: 11.5, textAlign: "center", lineHeight: 1.55 }}>
        Prices: /api/prices (Yahoo, poll-cadence — levels are checked when this loads or you refresh, not continuously).
        Positions are derived from fills at average cost, so a scaled position reports realised and unrealised side by side.
        Not investment advice; no orders are placed.
      </div>
    </div>
  );
}


