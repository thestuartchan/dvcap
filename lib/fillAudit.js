// lib/fillAudit.js — the broker's fills against the console's, instrument by instrument.
//
// WHY. A trade the console never saw leaves no trace in it: a position sold and later rebuilt looks
// exactly like one that was held throughout. 0981.HK, 2026-10-05: the card said "realised HK$0"
// while IBKR had a 1,000-share sale at 83.75 on 10 Jul for +HK$9,825 — the console had only the
// rebuild. The Open Positions reconciliation cannot catch this (the position today agrees); only
// the fills can.
//
// THE SOURCE, ONCE: the owner's old trade sheet, "Fills (auto)" — every IBKR and Hyperliquid fill
// since 6 Jun 2026. It is being retired (it converts currencies on its other tabs and has its own
// clock problem, below); the console is the record from here on and IBKR's daily statement keeps it
// complete. This exists to carry the sheet's history across one time. It is read IN THE BROWSER,
// from a link kept in the console's private settings — never through a server function and never
// into the bundle — and the link is dropped when the reconcile is marked done.
//
// THE SHEET'S CLOCK. Its "DateTime (UTC)" for IBKR rows is New York wall time with a Z on it:
// checked 2026-10-05 against IBKR's own trade times, all 1,286 matched fills sat exactly 4h early
// (EDT). That moved every Hong Kong morning trade onto the previous day. IBKR rows are re-read as
// New York time, and each trade's DATE is taken in its exchange's zone (Hong Kong for HKD, New
// York otherwise), which is the date IBKR's statement gives it. Hyperliquid rows carry true UTC.
// Prices, quantities and currencies matched IBKR; fees are slightly light (IBKR's commission only,
// without stamp duty and exchange fees), so a backfilled price can be a few cents generous.
//
// WHAT IS CHECKED: every instrument the console has a row for, open or archived. What it has no row
// for (day trades, scalps, FX conversions) is out of the console's scope by design and only counted.
// Option spreads are left out: a spread's fill is a net price across legs, which no single broker
// fill equals.
//
// MATCHING, in order:
//   1. the IBKR trade id — a fill the statement sync wrote carries it ("<tradeID>:<conid>");
//   2. same side, within ±1 day (Dubai and New York disagree about an evening trade's date), and
//      within 1% on price (the console's price includes commission). A console fill may absorb
//      several broker fills — a "bulk average" entry is one console fill for many executions.
// What is left of a broker fill is MISSING. What is left of a console fill is reported as not seen
// at the broker, which is usually a consolidated or pre-history entry, not an error.
import { parseOptionSymbol, contractKey } from './bookExposure.js';
import { isDerivativeRow, legsOf, underlyingOf, optionRow } from './instruments.js';
import { DAYTRADE_MAX_DTE } from './flex.js';
import { derivePosition } from './positions.js';
import { isCashEquivalent } from './cashEquivalents.js';
import { MULTIPLIER } from './futuresContracts.js';

export const SHEET_TAB = 'Fills (auto)';
export const DATE_WINDOW_DAYS = 1;
export const PRICE_TOL_PCT = 1;
// How far back a consolidated console fill may reach for the broker fills it stands for.
export const BULK_LOOKBACK_DAYS = 45;

// ── THE SHEET ────────────────────────────────────────────────────────────────
// A pasted link or a bare id → the id. Null when it is neither.
export function sheetIdOf(input) {
  const s = String(input || '').trim();
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}
export const sheetCsvUrl = (id, tab = SHEET_TAB) =>
  `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;

// RFC 4180, enough of it: quoted fields, doubled quotes, commas and newlines inside quotes.
export function parseCsv(text) {
  const out = []; let row = [], cell = '', q = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); out.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out.filter(r => r.some(c => c !== ''));
}

const num = (v) => {
  const s = String(v ?? '').replace(/[,$\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  return s === '' || !Number.isFinite(+s) ? null : +s;
};
// The UTC offset, in minutes, of a time zone at an instant.
function zoneOffsetMin(zone, ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60000;
}
const dateIn = (zone, ms) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
export const SHEET_IBKR_CLOCK = 'America/New_York';
export const exchangeZone = (currency) => (String(currency || '').toUpperCase() === 'HKD' ? 'Asia/Hong_Kong' : 'America/New_York');
// A sheet timestamp → { time (true UTC ISO), date (the exchange's trade date) }. IBKR rows are New
// York wall time labelled Z; anything else is taken as the UTC it says it is.
export function sheetTime(stamp, { venue, currency } = {}) {
  const t = Date.parse(stamp || '');
  if (!Number.isFinite(t)) return null;
  const ibkr = String(venue || '').toUpperCase() === 'IBKR';
  // Wall time W read as UTC; the true instant is W − offset(NY), and the offset is the one in force
  // at that instant (one refinement covers a DST edge).
  let real = t;
  if (ibkr) { real = t - zoneOffsetMin(SHEET_IBKR_CLOCK, t) * 60000; real = t - zoneOffsetMin(SHEET_IBKR_CLOCK, real) * 60000; }
  return { time: new Date(real).toISOString(), date: ibkr ? dateIn(exchangeZone(currency), real) : new Date(real).toISOString().slice(0, 10) };
}

const SIDE = { BUY: 'buy', SELL: 'sell', 'OPEN LONG': 'buy', 'CLOSE LONG': 'sell', 'OPEN SHORT': 'sell', 'CLOSE SHORT': 'buy' };

// The "Fills (auto)" tab → broker fills. Rows that are not a fill (no side, no quantity, no
// price) are dropped and counted, never guessed.
export function parseBrokerFills(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { fills: [], dropped: 0, error: 'the sheet is empty' };
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (name) => head.findIndex(h => h.startsWith(name));
  const ix = { uid: col('uid'), venue: col('venue'), time: col('datetime'), date: col('date'), symbol: col('symbol'),
               dir: col('direction'), qty: col('qty'), price: col('price'), pnl: col('realized'), fee: col('fee'), ccy: col('ccy') };
  // "date" also prefixes "datetime"; the plain one is the exact header.
  ix.date = head.findIndex(h => h === 'date');
  const missing = ['uid', 'symbol', 'dir', 'qty', 'price'].filter(k => ix[k] < 0);
  if (missing.length) return { fills: [], dropped: 0, error: `the tab has no ${missing.join(', ')} column — is it "${SHEET_TAB}"?` };
  const fills = []; let dropped = 0;
  for (const r of rows.slice(1)) {
    const get = (k) => (ix[k] >= 0 ? String(r[ix[k]] ?? '').trim() : '');
    const side = SIDE[get('dir').toUpperCase()] || null;
    const qty = num(get('qty')), price = num(get('price'));
    const at = sheetTime(get('time'), { venue: get('venue'), currency: get('ccy') });
    const date = at?.date || get('date').slice(0, 10);
    if (!side || !qty || price == null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { dropped++; continue; }
    fills.push({ uid: get('uid'), venue: get('venue') || null, time: at?.time || null, date, symbol: get('symbol'),
                 side, qty: Math.abs(qty), price, realized: num(get('pnl')), fee: num(get('fee')), currency: get('ccy') || null });
  }
  return { fills, dropped, error: null };
}

// ── ONE KEY PER INSTRUMENT, FROM EITHER SIDE ─────────────────────────────────
const stripZeros = (root) => (/^\d+$/.test(root) ? String(Number(root)) : root);
const FUT = /^([A-Z]{1,4}?)([FGHJKMNQUVXZ])(\d{1,2})$/;

// A broker symbol → { key, kind } or null when it is out of scope (FX conversions).
export function brokerKey(f) {
  const raw = String(f?.symbol || '').trim();
  if (!raw || /^[A-Z]{3}\.[A-Z]{3}$/.test(raw)) return null;            // USD.HKD — a conversion
  if (/\s/.test(raw) || raw.length >= 15) {
    const c = parseOptionSymbol(raw);
    return c ? { key: `opt:${contractKey(c)}`, kind: 'option' } : null;
  }
  // IBKR writes an LSE line with a lower-case suffix ("BRNTl"); the console writes BRNT.L.
  const base = raw.replace(/l$/, '').toUpperCase();
  const fut = FUT.exec(base);
  if (fut && !/^\d+$/.test(base)) return { key: `fut:${fut[1]}`, kind: 'future' };
  return { key: stripZeros(base.split('.')[0]), kind: 'equity' };
}

// A console row → its key, or null with the reason it is not checked.
export function rowKey(r) {
  if (isDerivativeRow(r)) {
    const legs = legsOf(r);
    if (legs.length !== 1) return { key: null, why: 'a spread — its fill is a net price across legs' };
    const l = legs[0];
    const root = String(underlyingOf(r) || '').toUpperCase();
    return { key: `opt:${contractKey({ root, expiry: l.expiry, type: l.right === 'P' ? 'put' : 'call', strike: +l.strike })}` };
  }
  // An option recorded on a share row — ×100, no legs, not margined: its contract is unknown, so
  // its fills cannot be held against any broker contract (AVGO, 26–27 Aug).
  if (!r?.margined && +r?.multiplier === 100) return { key: null, why: 'an option recorded without its contract (×100, no strike or expiry)' };
  const sym = String(r?.symbol || '').trim().toUpperCase().split('.')[0];
  if (r?.margined || (+r?.multiplier > 1 && FUT.test(sym))) {
    const m = FUT.exec(sym);
    return { key: `fut:${m ? m[1] : sym}` };
  }
  return { key: stripZeros(sym) };
}

const dayMs = 86400000;
const daysApart = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / dayMs;
const tradeIdBase = (id) => String(id || '').split(':')[0].replace(/^IBKR-/, '');
const uidBase = (uid) => String(uid || '').replace(/^IBKR-/, '');

// ── THE AUDIT ────────────────────────────────────────────────────────────────
// THE CONSOLE'S OWN SCOPE RULES, as the daily sync applies them (lib/flexTrades.js planTrades),
// judged AS OF EACH TRADE'S DATE — a June scalp in a symbol the console only started tracking in
// September was out of scope in June:
//   • while the console HOLDS the instrument, every fill counts, scalp or not: it moved a tracked
//     position, and leaving it out would put the average cost at odds with IBKR's;
//   • while it does not, a round trip opened and closed on ONE day is a day trade and stays out;
//     one spanning days is a swing that was never recorded — offered, never filed on its own;
//   • a sale out of nothing that IBKR booked realised P&L on closed shares bought before the
//     history starts (981 on 10 Jul) — offered as a closed trade, entry implied from that P&L;
//   • options, cash equivalents, FX conversions and Hyperliquid perps never enter from outside a
//     console row: options and crypto have their own paths, cash is the cash book.
export function auditFills(rows = [], fills = [], { tolPct = PRICE_TOL_PCT, windowDays = DATE_WINDOW_DAYS } = {}) {
  const byKey = new Map(), unchecked = [];
  for (const r of rows || []) {
    const k = rowKey(r);
    if (!k.key) { unchecked.push({ rowId: r.id, symbol: r.symbol, why: k.why }); continue; }
    byKey.set(k.key, [...(byKey.get(k.key) || []), r]);
  }
  const dates = fills.map(f => f.date).sort();
  const from = dates[0] || null, to = dates.at(-1) || null;
  const groups = new Map();
  for (const f of fills) {
    const k = brokerKey(f);
    if (!k) continue;
    if (!groups.has(k.key)) groups.set(k.key, { kind: k.kind, fills: [] });
    groups.get(k.key).fills.push(f);
  }
  const instruments = [], swings = [], dayTrades = [], heldNoRow = [], outOfScope = new Map();
  const byTime = (a, b) => (a.time || a.date).localeCompare(b.time || b.date);

  // Which console row absorbed a broker fill — the trade it belongs to is that row's.
  const took = (b, c) => { (b.rows ||= new Map()).set(c.rowId, (b.rows.get(c.rowId) || 0) + 1); };
  for (const [key, g] of groups) {
    const rs = byKey.get(key) || [];
    const broker = g.fills.map(f => ({ ...f, left: f.qty })).sort(byTime);
    let unseen = [];
    if (rs.length) {
      // Console fills inside the sheet's window (a day's grace); earlier ones are history it cannot speak to.
      const mine = rs.flatMap(r => (r.fills || []).map(f => ({ rowId: r.id, fill: f, side: f.side, qty: +f.qty || 0, price: +f.price, date: String(f.date || '').slice(0, 10), left: +f.qty || 0 })))
        .filter(c => from && c.date && (c.date >= from || daysApart(c.date, from) <= windowDays));
      for (const b of broker) {                                   // 1. trade id
        const c = mine.find(m => m.left > 0 && m.fill.tradeId && tradeIdBase(m.fill.tradeId) === uidBase(b.uid));
        if (c) { const q = Math.min(c.left, b.left); c.left -= q; b.left -= q; took(b, c); }
      }
      const close = (c, b) => c.left > 1e-9 && c.side === b.side && c.date && daysApart(c.date, b.date) <= windowDays
        && Math.abs(c.price - b.price) / Math.max(Math.abs(b.price), 1e-9) * 100 <= tolPct;
      for (const b of broker) {                                   // 2. one to one: same quantity too
        const c = mine.find(m => close(m, b) && Math.abs(m.left - b.left) < 1e-9);
        if (c) { c.left = 0; b.left = 0; took(b, c); }
      }
      // 3. A consolidated console fill — "bulk average of the IBKR fills for this trade" — is one
      //    fill standing for several: a run of same-side broker fills whose quantities sum to it
      //    exactly, at an average price within the tolerance. The run may lead up to the console
      //    fill's date or start from it: a bulk entry is often dated at the trade's FIRST fill
      //    (TQQQ's "1,000 @ 69.40" on 20 Aug stands for 500 that day and 500 on 24 Aug).
      for (const c of mine) {
        if (c.left <= 1e-9) continue;
        const pool = broker.filter(b => b.left > 1e-9 && b.side === c.side && daysApart(b.date, c.date) <= BULK_LOOKBACK_DAYS);
        const upTo = pool.filter(b => b.date <= c.date), onward = pool.filter(b => daysApart(b.date, c.date) <= windowDays || b.date >= c.date);
        for (const run of [[...upTo].reverse(), upTo, onward]) {
          let q = 0, n = 0; const take = [];
          for (const b of run) { if (q >= c.left - 1e-9) break; take.push(b); q += b.left; n += b.left * b.price; }
          if (Math.abs(q - c.left) > 1e-9 || !take.length) continue;
          if (!(Math.abs(c.price - n / q) / Math.max(n / q, 1e-9) * 100 <= tolPct)) continue;
          for (const b of take) { b.left = 0; took(b, c); }
          c.left = 0;
          break;
        }
      }
      for (const b of broker) {                                   // 4. what is left: side, date, price, partly
        for (const c of mine) {
          if (b.left <= 1e-9) break;
          if (c.left <= 1e-9 || c.side !== b.side || !c.date || daysApart(c.date, b.date) > windowDays) continue;
          if (!(Math.abs(c.price - b.price) / Math.max(Math.abs(b.price), 1e-9) * 100 <= tolPct)) continue;
          const q = Math.min(c.left, b.left); c.left -= q; b.left -= q; took(b, c);
        }
      }
      unseen = mine.filter(c => c.left > 1e-9).map(c => ({ rowId: c.rowId, fillId: c.fill.id, side: c.side, qty: +c.left.toFixed(8), price: c.price, date: c.date, note: c.fill.note || null }));
    } else {
      // No console row at all: shares, futures and single options on IBKR can come in, and only as
      // swings (an option day trade — same day, or opened at 0–1 DTE — stays out, below).
      const why = broker.some(f => String(f.venue || '').toUpperCase() !== 'IBKR') ? 'crypto'
        : isCashEquivalent(broker[0]?.symbol) ? 'cash equivalents' : null;
      if (why) { outOfScope.set(why, (outOfScope.get(why) || 0) + broker.length); continue; }
    }

    // ── TRADE BY TRADE, BY THE BROKER'S OWN POSITION ──────────────────────────
    // The broker's fills cut flat-to-flat (segments). A trade the console has ANY of is a trade it
    // tracks: what it lacks is added to that trade's row, scalps inside it included — the daily
    // sync's rule for a held name. A trade it has NONE of is judged as the sync judges a name it
    // does not hold: same day (or an option opened at 0–1 DTE) is a day trade and stays out;
    // across days it is a swing, offered as a row of its own; a close IBKR booked P&L on from flat
    // ended a trade begun before the history; still open, it belongs to the open row if there is
    // one, else the daily sync adds it.
    const toMissing = (b) => ({ ...b, qty: +b.left.toFixed(8), partOf: b.left < b.qty - 1e-9 ? b.qty : null });
    const openRow = rs.find(r => derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side }).status === 'open') || null;
    const listed = [], trades = [];
    const exp = g.kind === 'option' ? parseOptionSymbol(broker[0]?.symbol)?.expiry : null;
    for (const seg of segments(broker)) {
      const miss = seg.fills.filter(b => b.left > 1e-9).map(toMissing);
      const touched = seg.fills.filter(b => b.rows?.size);
      const add = (status, items = []) => { trades.push(tradeSummary(seg, items, status)); };
      if (!miss.length) { add('recorded'); continue; }
      if (touched.length) {
        const votes = new Map();
        for (const b of touched) for (const [rid, n] of b.rows) votes.set(rid, (votes.get(rid) || 0) + n);
        const rowId = [...votes.entries()].sort((x, y) => y[1] - x[1])[0][0];
        const items = miss.map(m => ({ ...m, plan: planFor(m, rs, rowId) }));
        listed.push(...items); add('missing', items); continue;
      }
      const dte = openedAtDte(seg.fills[0]);
      const optionDay = g.kind === 'option' && dte != null && dte <= DAYTRADE_MAX_DTE;
      if (seg.kind === 'day' || (optionDay && seg.kind !== 'pre-history-close' && (seg.kind === 'swing' || (exp && to && exp < to)))) {
        dayTrades.push({ key, symbol: seg.fills[0].symbol, date: seg.fills[0].date, fills: seg.fills.length }); add('day'); continue;
      }
      if (seg.kind === 'swing' || (seg.kind === 'open' && exp && to && exp < to)) {
        const expired = seg.kind === 'open' ? exp : null;
        swings.push({ key, symbol: rs[0]?.symbol || consoleSymbolOf(seg.fills[0]), fills: seg.fills, from: seg.fills[0].date,
                      to: expired || seg.fills.at(-1).date, realized: seg.realized, rowLike: rs[0] || null, ...(expired ? { expired } : {}) });
        add('swing'); continue;
      }
      if (seg.kind === 'pre-history-close') {
        const shape = rs[0] || rowLikeFor(seg.fills[0], { side: seg.fills[0].side === 'buy' ? 'short' : 'long' });
        const items = miss.map(m => ({ ...m, plan: { action: 'closed-trade', rowId: rs[0]?.id ?? null, heldThen: 0, impliedEntry: impliedEntry(m, shape) } }));
        listed.push(...items); add('missing', items); continue;
      }
      // Open at the end of the history, and none of it in the console.
      if (openRow) { const items = miss.map(m => ({ ...m, plan: planFor(m, rs, openRow.id) })); listed.push(...items); add('missing', items); continue; }
      heldNoRow.push({ key, symbol: consoleSymbolOf(seg.fills[0]), fills: seg.fills.length }); add('held-no-row');
    }
    listed.sort(byTime);
    if (!rs.length && !listed.length) continue;
    if (!rs.length) { instruments.push({ key, symbol: consoleSymbolOf(listed[0]), rowIds: [], brokerFills: broker.length, missing: listed, unseen: [], trades, noRow: true }); continue; }
    if (!broker.length && !unseen.length) continue;
    instruments.push({ key, symbol: rs[0].symbol, rowIds: rs.map(r => r.id), brokerFills: broker.length, missing: listed, unseen, trades });
  }
  // Instruments the console has a row for and the sheet never mentions.
  instruments.sort((a, b) => b.missing.length - a.missing.length || String(a.symbol).localeCompare(String(b.symbol)));
  return { from, to, instruments, missingCount: instruments.reduce((a, i) => a + i.missing.length, 0),
           swings, dayTrades: { trades: dayTrades.length, fills: dayTrades.reduce((a, d) => a + d.fills, 0) },
           heldNoRow, outOfScope: Object.fromEntries(outOfScope), unchecked };
}

// One broker trade (a segment), summarised for the panel: its side, dates, averages, IBKR's
// realised P&L, what the console is missing from it, and what the audit decided about it —
// recorded · missing (with plans) · day (left out) · swing (offered below) · held-no-row.
export function tradeSummary(seg, missing = [], status = 'missing') {
  const vwap = (fs) => { const q = fs.reduce((a, f) => a + f.qty, 0); return q > 0 ? +(fs.reduce((a, f) => a + f.qty * f.price, 0) / q).toPrecision(8) : null; };
  const first = seg.fills[0];
  // A pre-history close is the END of a trade begun before the sheet: its direction is the one it
  // closed (a sale closes a long).
  const side = seg.kind === 'pre-history-close' ? (first.side === 'sell' ? 'long' : 'short') : (first.side === 'buy' ? 'long' : 'short');
  const opening = side === 'long' ? 'buy' : 'sell';
  const ins = seg.fills.filter(f => f.side === opening), outs = seg.fills.filter(f => f.side !== opening);
  return {
    kind: seg.kind === 'open' ? 'open' : seg.kind === 'pre-history-close' ? 'pre-history-close' : 'closed',
    dayTrade: seg.kind === 'day', side, from: first.date, to: seg.fills.at(-1).date,
    qty: +(seg.kind === 'pre-history-close' ? first.qty : ins.reduce((a, f) => a + f.qty, 0)).toFixed(8),
    avgIn: seg.kind === 'pre-history-close' ? null : vwap(ins), avgOut: vwap(outs),
    realized: +seg.fills.reduce((a, f) => a + (f.realized || 0), 0).toFixed(2),
    currency: first.currency || null, fills: seg.fills.length, missing, status,
  };
}
// The trades of a fill list with no console to compare against (each one 'missing' unless given).
export const tradesOf = (fills = [], listed = []) => segments(fills).map(seg => {
  const uids = new Set(seg.fills.map(f => f.uid));
  const mine = listed.filter(m => uids.has(m.uid));
  return tradeSummary(seg, mine, mine.length ? 'missing' : 'recorded');
});

// Round trips from flat, in the broker's order. A fill that IBKR booked realised P&L on while the
// running position is flat closed something from BEFORE the history — its own segment.
export function segments(fills = []) {
  const out = []; let cur = [], net = 0;
  const close = (kind) => { if (cur.length) out.push({ kind, fills: cur, realized: +cur.reduce((a, f) => a + (f.realized || 0), 0).toFixed(2) }); cur = []; net = 0; };
  for (const f of fills) {
    if (Math.abs(net) < 1e-9 && f.realized && Math.abs(f.realized) > 0) { out.push({ kind: 'pre-history-close', fills: [f], realized: f.realized }); continue; }
    cur.push(f); net += f.side === 'buy' ? f.qty : -f.qty;
    if (Math.abs(net) < 1e-9) close(new Set(cur.map(x => x.date)).size === 1 ? 'day' : 'swing');
  }
  if (cur.length) out.push({ kind: 'open', fills: cur, realized: null });
  return out;
}

// Days from the opening fill to the option's expiry; null for anything that is not an option.
export function openedAtDte(f) {
  const c = brokerKey(f)?.kind === 'option' ? parseOptionSymbol(f.symbol) : null;
  if (!c?.expiry || !f?.date) return null;
  return Math.round((Date.parse(c.expiry) - Date.parse(f.date)) / 86400000);
}
// The console's name for a broker symbol: 0981.HK, BRNT.L, MGC, and for an option its contract
// ("QQQ 2026-10-16 730C") — the row itself is named by its underlying, as every option row is.
export function consoleSymbolOf(f) {
  const raw = String(f?.symbol || '').trim();
  const k = brokerKey(f);
  if (!k) return raw;
  if (k.kind === 'option') { const c = parseOptionSymbol(raw); return `${c.root} ${c.expiry} ${c.strike}${c.type === 'put' ? 'P' : 'C'}`; }
  if (k.kind === 'future') return k.key.slice(4);
  if (/^\d+$/.test(raw) && String(f.currency).toUpperCase() === 'HKD') return `${raw.padStart(4, '0')}.HK`;
  if (/[A-Z0-9]l$/.test(raw)) return `${raw.slice(0, -1)}.L`;
  return raw.toUpperCase();
}
// What a row for this broker fill would carry: its multiplier and whether it is margined.
export function rowLikeFor(f, { side = 'long' } = {}) {
  const k = brokerKey(f);
  if (k?.kind === 'option') {
    // Built the console's way (lib/instruments.js optionRow): one leg marked long, the direction on
    // the row — the convention the daily sync's option adds use.
    const c = parseOptionSymbol(f.symbol);
    const made = optionRow({ underlying: c.root, legs: [{ right: c.type === 'put' ? 'P' : 'C', strike: c.strike, expiry: c.expiry, side: 'long' }],
                             side, currency: f.currency || 'USD' });
    if (made.error) return { symbol: c.root, multiplier: null };
    const { fills: _f, id: _id, ...shape } = made.row;
    return { ...shape, trade: '', tag: null, margined: false };
  }
  const fut = k?.kind === 'future';
  const root = fut ? k.key.slice(4) : null;
  return { symbol: consoleSymbolOf(f), currency: f.currency === 'USDC' ? 'USD' : (f.currency || 'USD'), side,
           multiplier: fut ? (MULTIPLIER[root] ?? null) : 1, margined: fut, trade: '', tag: null };
}

// A swing the console never recorded, as one closed row — offered, never filed on its own.
export function swingRow(sw) {
  const row = swingRowRaw(sw);
  if (!row || sw.expired || sw.realized == null) return row;
  // IBKR'S P&L, EXACTLY. The sheet's fees leave out exchange and regulatory fees, so a swing built
  // from its fills realises a few cents to a dollar more than IBKR booked (INTC 115C: 381.73 vs
  // 380.98). The difference goes into the last closing fill's price, and the fill says so.
  const d = derivePosition(row.fills, { multiplier: row.multiplier, side: row.side });
  const got = d.realized ?? d.realised;
  const gap = +(sw.realized - got).toFixed(2);
  const closing = row.side === 'short' ? 'buy' : 'sell';
  const last = [...row.fills].reverse().find(f => f.side === closing);
  if (!last || !(Math.abs(gap) >= 0.01) || !(last.qty > 0)) return row;
  const per = gap / (last.qty * row.multiplier) * (closing === 'sell' ? 1 : -1);
  return { ...row, fills: row.fills.map(f => f === last ? { ...f, price: +(f.price + per).toPrecision(10),
    note: `${f.note} · adjusted ${gap > 0 ? '+' : ''}${gap} so the trade's P&L equals IBKR's` } : f) };
}
function swingRowRaw(sw) {
  const first = sw.fills[0];
  const side = first.side === 'sell' ? 'short' : 'long';
  const base = sw.rowLike ? { ...sw.rowLike, side } : rowLikeFor(first, { side });
  if (!(base.multiplier > 0)) return null;
  const tail = String(first.uid).replace(/[^A-Za-z0-9]/g, '').slice(-8);
  return {
    id: `${String(base.symbol).replace(/[^A-Za-z0-9]/g, '')}-sw-${tail}`,
    symbol: base.symbol, currency: base.currency || 'USD', multiplier: base.multiplier, margined: !!base.margined, side,
    ...optionShape(base),
    trade: '', tag: null,
    thesis: `Recorded from the broker's fills: a ${side} swing from ${sw.from} to ${sw.to} the console never had. No view was written at the time.`,
    levels: [], tags: ['broker-fills'],
    fills: [...sw.fills.map(m => fillFromBroker(m, base.multiplier)),
      // No closing fill: it expired. Closed at zero on the expiry date, and said so.
      ...(sw.expired ? [{ id: `bfx${tail}`, side: side === 'short' ? 'buy' : 'sell', date: sw.expired,
        qty: +sw.fills.reduce((a, f) => a + (f.side === (side === 'short' ? 'sell' : 'buy') ? f.qty : -f.qty), 0).toFixed(8), price: 0,
        note: `expired ${sw.expired} with no closing fill — from the broker sheet; if it was exercised or assigned, the shares show under the underlying` }] : [])],
  };
}

// An option row's own fields, carried onto a row the carry-over builds.
const optionShape = (b) => (b?.instrument === 'option' || b?.instrument === 'spread'
  ? { instrument: b.instrument, underlying: b.underlying, legs: b.legs, ...(b.hardDate ? { hardDate: b.hardDate } : {}) } : {});

// ── WHAT TO DO WITH A MISSING FILL ───────────────────────────────────────────
// Into the row it belongs to — the one open at that date, else the latest that started before it —
// unless it would close more than that row held then. A sale of shares bought before the sheet's
// history starts (981 on 10 Jul) is then a trade of its own: recorded as a CLOSED row whose entry
// is implied by the broker's own realised P&L, so the console's realised figure equals IBKR's.
export function planFor(m, rows, preferRowId = null) {
  const before = (r) => (r.fills || []).filter(f => String(f.date || '') <= m.date);
  const held = (r) => derivePosition(before(r), { multiplier: r.multiplier, side: r.side }).qty || 0;
  const target = (preferRowId && rows.find(r => r.id === preferRowId))
    || [...rows].filter(r => before(r).length).sort((a, b) => held(b) - held(a))[0]
    || [...rows].sort((a, b) => String(a.fills?.[0]?.date || '').localeCompare(String(b.fills?.[0]?.date || '')))[0];
  const closes = (r) => (String(r.side || 'long') === 'short' ? m.side === 'buy' : m.side === 'sell');
  const h = target ? held(target) : 0;
  if (target && closes(target) && m.qty > h + 1e-9) {
    const implied = impliedEntry(m, target);
    return implied ? { action: 'closed-trade', rowId: target.id, heldThen: h, impliedEntry: implied }
                   : { action: 'review', rowId: target.id, heldThen: h, why: 'closes more than the console held then, and the broker gave no realised P&L to imply an entry from' };
  }
  return { action: 'add', rowId: target?.id ?? null };
}

// Per-unit effective price, commission folded in, as the statement sync records it.
export function effectivePrice(m, multiplier = 1) {
  const fee = Math.abs(m.fee || 0), units = m.qty * (multiplier || 1);
  if (!units) return m.price;
  return +((m.price * units + (m.side === 'buy' ? fee : -fee)) / units).toPrecision(10);
}
// realised = proceeds − fee − cost  ⇒  cost = proceeds − fee − realised (long; mirrored for short).
// Only for the broker's FULL fill — a partly matched fill's realised P&L covers more than what is
// left of it.
export function impliedEntry(m, row) {
  if (m.realized == null || m.partOf != null) return null;
  const mult = +row?.multiplier || 1, units = m.qty * mult, fee = Math.abs(m.fee || 0);
  if (!units) return null;
  const short = String(row?.side || 'long') === 'short';
  const cost = short ? m.price * units + fee + m.realized : m.price * units - fee - m.realized;
  return +(cost / units).toPrecision(10);
}

export const fillFromBroker = (m, multiplier = 1) => ({
  id: `bf${String(m.uid).replace(/[^A-Za-z0-9]/g, '').slice(-12)}`,
  side: m.side, qty: m.qty, price: effectivePrice(m, multiplier), date: m.date,
  note: `${m.venue || 'broker'} fill ${m.uid} at ${m.price}, from the broker sheet, commission included`,
  tradeId: m.uid,
});

// The closed trade a pre-history sale stands for: an implied opening fill, then the sale.
export function closedTradeRow(m, row0, { from = null } = {}) {
  const row = row0 || rowLikeFor(m, { side: m.side === 'buy' ? 'short' : 'long' });
  if (!(row.multiplier > 0)) return null;
  const entry = impliedEntry(m, row);
  if (entry == null) return null;
  const open = row.side === 'short' ? 'sell' : 'buy';
  const opened = from && from < m.date ? from : m.date;
  return {
    id: `${String(row.symbol || 'row').replace(/[^A-Za-z0-9]/g, '')}-bf-${String(m.uid).replace(/[^A-Za-z0-9]/g, '').slice(-8)}`,
    symbol: row.symbol, currency: row.currency || m.currency || 'USD', multiplier: row.multiplier || 1, margined: !!row.margined,
    ...optionShape(row),
    side: row.side || 'long', trade: row.trade || '', tag: row.tag ?? null,
    thesis: `Recorded from the broker's fills: a ${row.side === 'short' ? 'cover' : 'sale'} the console never had. The entry is implied from IBKR's realised P&L on it; the shares were bought on or before ${opened}, before the broker history starts.`,
    levels: [], tags: ['broker-fills'],
    fills: [
      { id: `bfo${String(m.uid).replace(/[^A-Za-z0-9]/g, '').slice(-10)}`, side: open, qty: m.qty, price: entry, date: opened,
        note: `implied from IBKR's realised P&L of ${m.realized} on fill ${m.uid} — the actual purchase dates are before the broker history` },
      fillFromBroker(m, row.multiplier || 1),
    ],
  };
}

// ── UNDO ─────────────────────────────────────────────────────────────────────
// Everything the carry-over writes is marked: rows it creates carry the tag broker-fills, and every
// fill it adds has an id starting "bf" and a note naming the sheet (or the implied entry). Undo
// removes exactly those and nothing else — a fill recorded by hand, by the statement sync or by a
// journal note after the carry-over is untouched. (A named snapshot, taken before the first write,
// is the other way back: it restores the console exactly as it was, later changes included.)
export const isCarryOverFill = (f) => /^bf/.test(String(f?.id || ''))
  && /from the broker sheet|implied from IBKR's realised P&L/.test(String(f?.note || ''));
export const isCarryOverRow = (r) => (r?.tags || []).includes('broker-fills');
export function undoCarryOver(rows = []) {
  let removedRows = 0, removedFills = 0;
  const touched = [];
  const out = [];
  for (const r of rows) {
    if (isCarryOverRow(r)) { removedRows++; continue; }
    const keep = (r.fills || []).filter(f => !isCarryOverFill(f));
    if (keep.length !== (r.fills || []).length) { removedFills += (r.fills || []).length - keep.length; touched.push(r.id); out.push({ ...r, fills: keep }); }
    else out.push(r);
  }
  return { rows: out, removedRows, removedFills, touched };
}
