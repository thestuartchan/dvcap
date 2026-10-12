// lib/sameDayFills.js — fills from IBKR's SAME-DAY report, and how the next statement takes them over.
//
// WHY. The daily sync reads a "Last Business Day" statement at 08:00 New York, so a fill reached the
// console the morning after it traded and a journal note from chat waited a day to draft. A Trade
// Confirmation Flex Query answers for TODAY, minutes after a fill. The console's "Sync now" reads it
// (api/flex-sync.js ?tc=1) and runs the same journal matcher over it.
//
// WHAT DOES NOT CHANGE. The broker is the only source of fills and Stu confirms what enters the book.
// The same-day report has no Open Positions section, so nothing can be reconciled against it — which
// is why it only ever DRAFTS. It never adds shares or futures by itself, never runs the trade
// planner, never writes a console row. A draft Stu confirms from it is written PROVISIONAL, and the
// next morning's statement adopts it by IBKR's order id: the mark is cleared, and quantity or price
// are corrected to the statement's if they differ. It is never written twice, and a provisional fill
// the statement does not contain is flagged on the card, never deleted (the sync never deletes).
//
// Pure: no I/O and no clock, so the server, the console and the tests call the same functions.

import { isDerivativeRow, legsOf, underlyingOf } from './instruments.js';
import { isTradingDay } from './journalInbox.js';
import { JOURNAL_ONLY } from './dayTradeJournal.js';

export const TC_QUERY_ENV = 'IBKR_FLEX_TC_QUERY_ID';
export const tcQueryId = () => String(process.env[TC_QUERY_ENV] || '').trim();
// A same-day report is a few rows; IBKR builds it in seconds. Shorter pauses than the statement's,
// about 15s in all, so the button answers while Stu is still looking at it.
export const TC_WAITS_MS = Object.freeze([2000, 2000, 3000, 3000, 4000]);
export const SYNC_NOW_MIN_INTERVAL_S = 60;

const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const nextSession = (d, holidays = []) => { let x = addDays(d, 1); for (let g = 0; g < 10 && !isTradingDay(x, holidays); g++) x = addDays(x, 1); return x; };

// ── DAY TRADES, ON THE SAME-DAY PATH ─────────────────────────────────────────
// lib/journalInbox.js already keeps 0DTE orders and same-session round trips out of the unjournaled
// drafts. Intraday, a round trip is often only half-printed, so this path also leaves out options
// expiring by the next session (1DTE) and the names traded day-trade only (lib/dayTradeJournal.js
// JOURNAL_ONLY). A note that names one still matches it — only the unprompted draft is withheld.
export function skipOnSameDay(u, { holidays = [] } = {}) {
  const isOpt = u?.type === 'OPT' || u?.type === 'COMBO';
  if (!isOpt) return false;
  if (JOURNAL_ONLY.some(j => j.kind === 'option' && j.root === String(u.root).toUpperCase())) return true;
  const last = nextSession(u.date, holidays);
  return (u.legs || []).length > 0 && u.legs.every(l => l.expiry && l.expiry <= last);
}

// ── THE ONE-LINE ANSWER ──────────────────────────────────────────────────────
// "2 fills found, 1 matched a note ✓, 1 unjournaled" — and never silence: no fills, a report still
// being built, and notes for today with nothing to match yet all say so.
export function syncNowLine({ fate = {}, units = [], waitingToday = 0 } = {}) {
  const ids = units.filter(u => u.type !== 'OTHER').map(u => u.orderId);
  const n = (k) => ids.filter(id => fate[id] === k).length;
  const bits = [];
  if (!ids.length) {
    bits.push('No fills in IBKR\'s same-day report yet');
  } else {
    bits.push(`${ids.length} fill${ids.length === 1 ? '' : 's'} found`);
    const matched = n('matched');
    bits.push(`${matched} matched a note${matched ? ' ✓' : ''}`);
    if (n('ambiguous')) bits.push(`${n('ambiguous')} matched more than one note`);
    bits.push(`${n('unjournaled')} unjournaled`);
    if (n('seen')) bits.push(`${n('seen')} already drafted`);
    if (n('known')) bits.push(`${n('known')} already in the console`);
    const day = n('dayTrade') + n('excluded');
    if (day) bits.push(`${day} day trade${day === 1 ? '' : 's'} left out`);
  }
  let line = bits.join(', ');
  if (waitingToday) line += ` · ${waitingToday} note${waitingToday === 1 ? '' : 's'} for today still waiting — not in IBKR's report yet, try again in a few minutes`;
  else if (!ids.length) line += ' — if you just traded, it is not in IBKR\'s report yet; try again in a few minutes';
  return line;
}

// ── HOW LONG IBKR TAKES ──────────────────────────────────────────────────────
// Flex stamps an execution in New York time ("20261012;101530"). The lag is measured, not assumed:
// each order's fill time against the first Sync now that saw it, with the latest earlier sync that
// did NOT see it as the lower bound. Timings and order ids only — no sizes, no prices.
export function nyEpochMs(stamp) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})[;T ,]*(\d{2}):?(\d{2}):?(\d{2})?/.exec(String(stamp || '').trim());
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  // New York's offset at that moment, from the platform's own zone data.
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(asUtc)).reduce((a, p) => ({ ...a, [p.type]: p.value }), {});
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - (shown - asUtc);
}
export const LAG_KEEP_RUNS = 60, LAG_KEEP_ORDERS = 30;
export function recordLag(store = {}, { trades = [], at }) {
  const runs = [...(store.runs || [])];
  const orders = { ...(store.orders || {}) };
  const atMs = Date.parse(at);
  const lags = [];
  const byOrder = new Map();
  for (const t of trades) {
    const id = String(t.tradeId || '').split(':')[0];
    const ms = nyEpochMs(t.lastTime || t.time);
    if (!id || ms == null) continue;
    byOrder.set(id, Math.max(byOrder.get(id) ?? -Infinity, ms));
  }
  for (const [id, filledMs] of byOrder) {
    if (orders[id]) continue;
    const earlier = runs.map(Date.parse).filter(r => r > filledMs && r < atMs);
    const missedAt = earlier.length ? Math.max(...earlier) : null;
    const rec = { filled: new Date(filledMs).toISOString(), firstSeen: at, missedAt: missedAt == null ? null : new Date(missedAt).toISOString(),
      upToMin: +((atMs - filledMs) / 60000).toFixed(1), overMin: missedAt == null ? null : +((missedAt - filledMs) / 60000).toFixed(1) };
    orders[id] = rec;
    lags.push(rec);
  }
  runs.push(at);
  const keptOrders = Object.entries(orders).sort((a, b) => String(b[1].firstSeen).localeCompare(String(a[1].firstSeen))).slice(0, LAG_KEEP_ORDERS);
  return { store: { runs: runs.slice(-LAG_KEEP_RUNS), orders: Object.fromEntries(keptOrders) }, lags };
}
// "IBKR's report showed it 4–7 min after the fill" — or "within 7 min" when no earlier sync missed it.
export function lagText(rec) {
  if (!rec) return null;
  if (rec.upToMin < 0) return 'the fill time is later than the sync — IBKR\'s time stamps may not be New York time';
  return rec.overMin != null ? `IBKR's report showed it ${rec.overMin}–${rec.upToMin} min after the fill` : `IBKR's report showed it within ${rec.upToMin} min of the fill`;
}

// ── THE NEXT MORNING: ADOPT, CORRECT, OR FLAG ────────────────────────────────
// `units` are the statement's orders (lib/journalInbox.js orderUnits). A provisional fill is found by
// IBKR's order id first — the part of its tradeId before the colon, which is how both reports key an
// order. If the two reports ever disagree on the id, one statement order of the same contract, side,
// quantity and date that no other console fill holds is adopted instead, and named as such. Two or
// more candidates is not guessed between: the fill stays provisional and is flagged.
const orderPart = (id) => String(id || '').split(':')[0];
const legKey = (legs) => (legs || []).map(l => `${l.right}${+l.strike}${l.expiry}`).sort().join('|');
const nearPx = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(b) * 1e-6, 1e-9);

export function adoptProvisional(rows = [], units = [], { asOf = null } = {}) {
  const byOrder = new Map(units.map(u => [String(u.orderId), u]));
  // Orders some console fill already stands for — never a fallback candidate for another one.
  const held = new Set();
  for (const r of rows) for (const f of (r.fills || [])) if (f.tradeId && !f.provisional) held.add(orderPart(f.tradeId));
  const adopted = [], missing = [], ambiguous = [], corrected = [];
  const roots = new Set();
  let changed = false;
  const next = rows.map(r => {
    if (!(r.fills || []).some(f => f.provisional)) return r;
    const opt = isDerivativeRow(r);
    const root = String(opt ? underlyingOf(r) : r.symbol).split('.')[0].toUpperCase();
    let touched = false;
    const fills = r.fills.map(f => {
      if (!f.provisional) return f;
      let u = byOrder.get(orderPart(f.tradeId)) || null, how = 'order id';
      if (!u) {
        const cands = units.filter(x => !held.has(String(x.orderId)) && x.date === f.date && String(x.root).toUpperCase() === root
          && (x.side === 'SELL' ? 'sell' : 'buy') === f.side && Math.abs((x.qty ?? -1) - f.qty) < 1e-9
          && (opt ? (x.type === 'OPT' || x.type === 'COMBO') && legKey(x.legs) === legKey(legsOf(r)) : (x.type === 'STK' || x.type === 'FUT')));
        if (cands.length === 1) { u = cands[0]; how = 'contract, side, quantity and date (the order ids differed)'; }
        else if (cands.length > 1) { ambiguous.push({ rowId: r.id, fillId: f.id, date: f.date, symbol: root }); return f; }
      }
      if (!u) {
        if (asOf && f.date && f.date <= asOf) missing.push({ rowId: r.id, fillId: f.id, date: f.date, symbol: root, asOf });
        return f;
      }
      held.add(String(u.orderId));
      let qty = u.qty, price = u.price, tradeId = String(u.orderId).slice(0, 24);
      if (!opt) {
        const t = (u.trades || []).find(x => x.tradeId === f.tradeId) || ((u.trades || []).length === 1 ? u.trades[0] : null);
        if (t) { qty = t.qty; price = t.price; }
        tradeId = String(t?.tradeId || u.tradeIds?.[0] || u.orderId).slice(0, 24);
      }
      const fixed = [];
      if (qty != null && Math.abs(qty - f.qty) > 1e-9) fixed.push({ field: 'qty', was: f.qty, now: qty });
      if (price != null && !nearPx(f.price, price)) fixed.push({ field: 'price', was: f.price, now: price });
      const out = { ...f, tradeId, ...(qty != null ? { qty } : {}), ...(price != null ? { price } : {}) };
      delete out.provisional;
      adopted.push({ rowId: r.id, fillId: f.id, how, corrected: fixed.map(x => x.field) });
      if (fixed.length) { corrected.push({ rowId: r.id, fillId: f.id, fixed }); if (!opt) roots.add(root); }
      touched = true;
      return out;
    });
    if (!touched) return r;
    changed = true;
    return { ...r, fills };
  });
  return { rows: next, changed, adopted, corrected, missing, ambiguous, roots: [...roots] };
}

// A same-day DRAFT still waiting when the statement arrives takes the statement's numbers, so what
// Stu confirms afterwards is the record and not the provisional report. `rematch` re-runs the note's
// checks against the statement's order (lib/journalInbox.js matchNote); a draft that no longer
// matches is kept, marked, and drops out of "Confirm all exact matches".
export function upgradeDrafts(drafts = [], units = [], { asOf = null, fillOf, rematch = null } = {}) {
  const byOrder = new Map(units.map(u => [String(u.orderId), u]));
  let changed = 0;
  const lift = (d, f) => {
    if (!f?.provisional) return { f, checks: null };
    const u = byOrder.get(String(f.orderId));
    if (!u) return { f: asOf && f.date && f.date <= asOf ? { ...f, statementMissing: asOf } : f, checks: null };
    changed++;
    const m = rematch && d.note ? rematch(d.note, u) : null;
    const nf = fillOf(u);
    return { f: d.note && rematch && !m ? { ...nf, statementDiffers: true } : nf, checks: m ? m.checks : null };
  };
  const out = drafts.map(d => {
    if (d.fill) {
      const { f, checks } = lift(d, d.fill);
      return f === d.fill ? d : { ...d, fill: f, ...(checks ? { checks } : {}) };
    }
    if (Array.isArray(d.candidates)) {
      const cs = d.candidates.map(c => { if (!c.fill) return c; const { f, checks } = lift(d, c.fill); return f === c.fill ? c : { ...c, fill: f, ...(checks ? { checks } : {}) }; });
      return cs.some((c, i) => c !== d.candidates[i]) ? { ...d, candidates: cs } : d;
    }
    return d;
  });
  return { drafts: out, changed };
}

// What the card shows beside a provisional fill. `missing` is the last sync's list of fills the
// statement did not contain (api/flex-sync.js writes it to the console's note).
export function provisionalBadge(f, missing = []) {
  if (!f?.provisional) return null;
  const miss = (missing || []).find(m => m.fillId === f.id);
  return miss
    ? { text: `not in IBKR's ${miss.asOf} statement`, warn: true, title: 'Confirmed from the same-day report, but the next statement did not contain it. Kept, not deleted — check it against IBKR.' }
    : { text: 'same-day', warn: false, title: 'From IBKR\'s same-day report — provisional until the next statement adopts it by order id' };
}
