// lib/fillAudit.js — the broker's fills against the console's, instrument by instrument.
//
// WHY. A trade the console never saw leaves no trace in it: a position sold and later rebuilt looks
// exactly like one that was held throughout. 0981.HK, 2026-10-05: the card said "realised HK$0"
// while IBKR had a 1,000-share sale at 83.75 on 10 Jul for +HK$9,825 — the console had only the
// rebuild. The Open Positions reconciliation cannot catch this (the position today agrees); only
// the fills can.
//
// THE SOURCE is the owner's own trade sheet, "Fills (auto)": every IBKR and Hyperliquid fill since
// the sheet started, refreshed by the sheet itself. It is read IN THE BROWSER, from the link kept in
// the console's private settings — never through a server function and never into the bundle — so
// nothing here leaves the signed-in page.
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
import { isDerivativeRow, legsOf, underlyingOf } from './instruments.js';
import { derivePosition } from './positions.js';

export const SHEET_TAB = 'Fills (auto)';
export const DATE_WINDOW_DAYS = 1;
export const PRICE_TOL_PCT = 1;

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
    const date = (get('date') || get('time')).slice(0, 10);
    if (!side || !qty || price == null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { dropped++; continue; }
    fills.push({ uid: get('uid'), venue: get('venue') || null, time: get('time') || null, date, symbol: get('symbol'),
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
export function auditFills(rows = [], fills = [], { tolPct = PRICE_TOL_PCT, windowDays = DATE_WINDOW_DAYS } = {}) {
  const byKey = new Map(), unchecked = [];
  for (const r of rows || []) {
    const k = rowKey(r);
    if (!k.key) { unchecked.push({ rowId: r.id, symbol: r.symbol, why: k.why }); continue; }
    byKey.set(k.key, [...(byKey.get(k.key) || []), r]);
  }
  const from = fills.map(f => f.date).sort()[0] || null;
  const to = fills.map(f => f.date).sort().at(-1) || null;
  const out = [], untracked = new Map();
  const groups = new Map();
  for (const f of fills) {
    const k = brokerKey(f);
    if (!k) continue;
    if (!byKey.has(k.key)) { untracked.set(k.key, (untracked.get(k.key) || 0) + 1); continue; }
    groups.set(k.key, [...(groups.get(k.key) || []), f]);
  }
  for (const [key, rs] of byKey) {
    const broker = (groups.get(key) || []).map(f => ({ ...f, left: f.qty })).sort((a, b) => (a.time || a.date).localeCompare(b.time || b.date));
    // Console fills inside the sheet's window (a day's grace either side); earlier ones are history
    // the sheet cannot speak to.
    const mine = rs.flatMap(r => (r.fills || []).map(f => ({ rowId: r.id, fill: f, side: f.side, qty: +f.qty || 0, price: +f.price, date: String(f.date || '').slice(0, 10), left: +f.qty || 0 })))
      .filter(c => from && c.date && (c.date >= from || daysApart(c.date, from) <= windowDays));
    // 1. trade id
    for (const b of broker) {
      const c = mine.find(m => m.left > 0 && m.fill.tradeId && tradeIdBase(m.fill.tradeId) === uidBase(b.uid));
      if (c) { const q = Math.min(c.left, b.left); c.left -= q; b.left -= q; }
    }
    // 2. side, date, price
    for (const b of broker) {
      if (b.left <= 1e-9) continue;
      for (const c of mine) {
        if (b.left <= 1e-9) break;
        if (c.left <= 1e-9 || c.side !== b.side || !c.date || daysApart(c.date, b.date) > windowDays) continue;
        if (!(Math.abs(c.price - b.price) / Math.max(Math.abs(b.price), 1e-9) * 100 <= tolPct)) continue;
        const q = Math.min(c.left, b.left); c.left -= q; b.left -= q;
      }
    }
    const missing = broker.filter(b => b.left > 1e-9).map(b => ({ ...b, qty: +b.left.toFixed(8), partOf: b.left < b.qty ? b.qty : null }));
    const unseen = mine.filter(c => c.left > 1e-9).map(c => ({ rowId: c.rowId, fillId: c.fill.id, side: c.side, qty: +c.left.toFixed(8), price: c.price, date: c.date, note: c.fill.note || null }));
    if (!broker.length && !unseen.length) continue;
    out.push({ key, symbol: rs[0].symbol, rowIds: rs.map(r => r.id), brokerFills: broker.length, missing: missing.map(m => ({ ...m, plan: planFor(m, rs) })), unseen });
  }
  out.sort((a, b) => b.missing.length - a.missing.length || String(a.symbol).localeCompare(String(b.symbol)));
  return { from, to, instruments: out, missingCount: out.reduce((a, i) => a + i.missing.length, 0),
           unchecked, untracked: [...untracked.entries()].map(([key, n]) => ({ key, fills: n })).sort((a, b) => b.fills - a.fills) };
}

// ── WHAT TO DO WITH A MISSING FILL ───────────────────────────────────────────
// Into the row it belongs to — the one open at that date, else the latest that started before it —
// unless it would close more than that row held then. A sale of shares bought before the sheet's
// history starts (981 on 10 Jul) is then a trade of its own: recorded as a CLOSED row whose entry
// is implied by the broker's own realised P&L, so the console's realised figure equals IBKR's.
export function planFor(m, rows) {
  const before = (r) => (r.fills || []).filter(f => String(f.date || '') <= m.date);
  const held = (r) => derivePosition(before(r), { multiplier: r.multiplier, side: r.side }).qty || 0;
  const target = [...rows].filter(r => before(r).length).sort((a, b) => held(b) - held(a))[0]
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
export function closedTradeRow(m, row, { from = null } = {}) {
  const entry = impliedEntry(m, row);
  if (entry == null) return null;
  const open = row.side === 'short' ? 'sell' : 'buy';
  const opened = from && from < m.date ? from : m.date;
  return {
    id: `${String(row.symbol || 'row').replace(/[^A-Za-z0-9]/g, '')}-bf-${String(m.uid).replace(/[^A-Za-z0-9]/g, '').slice(-8)}`,
    symbol: row.symbol, currency: row.currency || m.currency || 'USD', multiplier: row.multiplier || 1, margined: !!row.margined,
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
