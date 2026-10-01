// lib/journalInbox.js — notes written from chat, matched to the fills IBKR reports.
//
// THE DIVISION OF LABOUR. The statement owns every fill: symbol, legs, side, quantity, price and
// date, and nothing here overrides one of those. A note owns what the statement cannot know — why
// the trade was taken, what it is tagged as, the levels and dates it will be managed by. A note's
// quantity and price are MATCHING HINTS only; they are compared with the fill and never written.
// Stu confirms, edits or dismisses every draft, and nothing reaches the book without that.
//
// WHY REDIS AND NOT A FILE. The obvious home was journal/inbox/*.json in the repo, and it is the
// wrong one for the reason api/manual-entry.js already gives for the console: a permanent, diffable
// history of a real book's rationale and levels is a liability. Notes live in Redis, arrive through
// an append-only route, and a processed note is kept for 30 days and then expires.
//
// Pure: the route, the daily run and the console all call in with what they hold. No I/O, no
// clock (today is passed in), no holiday file (the caller passes the list), so the same functions
// run in a test, on the server and in the browser.

import { rootOf } from './flex.js';
import { derivePosition } from './positions.js';
import { parseOptionSymbol } from './bookExposure.js';
import { optionRow, isDerivativeRow, legsOf, underlyingOf, hardDateCheck } from './instruments.js';

// ── STORAGE ──────────────────────────────────────────────────────────────────
export const INBOX_KEY = 'dvcap:journal:inbox:v1';          // Redis LIST — pending notes, RPUSH'd
export const PROCESSED_KEY = 'dvcap:journal:processed:v1';  // JSON — resolved notes, 30-day TTL
export const DRAFTS_KEY = 'dvcap:journal:drafts:v1';        // JSON — what the console shows
export const SEEN_KEY = 'dvcap:journal:seen:v1';            // JSON — orders already drafted
export const WHY_KEY = 'dvcap:journal:why:v1';              // JSON — why each waiting note has not matched
export const RATE_KEY = 'dvcap:journal:rate:v1';            // counter per hour
export const TOKEN_ENV = 'JOURNAL_INBOX_TOKEN';
export const TOKEN_HEADER = 'x-journal-token';

export const MAX_NOTE_BYTES = 4096;
export const RATE_PER_HOUR = 60;
export const PROCESSED_TTL_DAYS = 30;
export const SEEN_KEEP_DAYS = 45;          // longer than the Flex query's 30-day window
export const MAX_DRAFTS = 100;
// Trading days a note waits for its fill before it is listed as a note without one.
export const WAIT_TRADING_DAYS = 5;
// Dubai and New York disagree about the date of an evening trade, so ±1 trading day.
export const DATE_WINDOW = 1;
// Fills before the day the inbox went live are history, not unjournaled trades: the statement's
// 30-day window would otherwise open with a month of drafts nobody is going to write notes for.
export const INBOX_FROM = '2026-09-30';

export const NOTE_KINDS = Object.freeze(['open', 'close', 'trim', 'add', 'plan', 'amend']);
export const NOTE_TAGS = Object.freeze(['hedge', 'position', 'swing', 'intraday']);
export const INSTRUMENT_TYPES = Object.freeze(['STK', 'OPT', 'COMBO', 'FUT']);
// Kinds whose quantity is a guess: a plan says "~200", a trim says "some". Any quantity matches,
// and the difference is reported rather than refused.
const ANY_QTY = new Set(['plan', 'trim']);
const LEVEL_KEYS = ['take_profit', 'stop', 'invalidation', 'review', 'hard_date', 'decide_by'];
const TOP_KEYS = new Set(['id', 'kind', 'written_at', 'trade_date', 'instrument', 'expected', 'tag', 'rationale', 'levels', 'rules', 'supersedes']);

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const str = (v, max) => (v == null ? null : String(v).slice(0, max));

// ── THE NOTE ─────────────────────────────────────────────────────────────────
// Strict: an unknown top-level field or kind is refused rather than dropped, because a writer that
// thinks it recorded something and did not is the failure this is meant to remove.
export function validateNote(body) {
  const bad = (error) => ({ ok: false, error });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('the body must be one JSON note');
  const extra = Object.keys(body).filter(k => !TOP_KEYS.has(k));
  if (extra.length) return bad(`unknown field${extra.length > 1 ? 's' : ''}: ${extra.slice(0, 5).join(', ')}`);
  const id = String(body.id || '');
  if (!/^[a-z0-9][a-z0-9.-]{2,79}$/.test(id)) return bad('id must be 3–80 characters of a-z, 0-9, "-" or "."');
  if (!NOTE_KINDS.includes(body.kind)) return bad(`kind must be one of ${NOTE_KINDS.join(', ')}`);
  if (!isDay(body.trade_date)) return bad('trade_date must be YYYY-MM-DD');
  const written = String(body.written_at || '');
  if (written && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(written)) return bad('written_at must be an ISO UTC time');
  if (body.tag != null && !NOTE_TAGS.includes(body.tag)) return bad(`tag must be one of ${NOTE_TAGS.join(', ')}`);

  const out = { id, kind: body.kind, written_at: written || null, trade_date: body.trade_date,
    tag: body.tag ?? null, rationale: str(body.rationale, 1200), supersedes: str(body.supersedes, 48) };

  if (body.kind === 'amend') {
    if (!out.supersedes) return bad('an amend names the console trade it changes in supersedes');
  } else {
    const ins = body.instrument;
    if (!ins || typeof ins !== 'object') return bad('instrument is required');
    const type = String(ins.type || '').toUpperCase();
    if (!INSTRUMENT_TYPES.includes(type)) return bad(`instrument.type must be one of ${INSTRUMENT_TYPES.join(', ')}`);
    const symbol = String(ins.symbol || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9./]{0,11}$/.test(symbol)) return bad('instrument.symbol is not a symbol');
    const side = ins.side == null ? null : String(ins.side).toUpperCase();
    if (side != null && side !== 'BUY' && side !== 'SELL') return bad('instrument.side must be BUY or SELL');
    let legs = [];
    if (type === 'OPT' || type === 'COMBO') {
      if (!Array.isArray(ins.legs) || !ins.legs.length) return bad(`an ${type} note needs its legs`);
      if (ins.legs.length > 4) return bad('at most 4 legs');
      if (type === 'COMBO' && ins.legs.length < 2) return bad('a COMBO has two or more legs');
      if (type === 'OPT' && ins.legs.length !== 1) return bad('an OPT note has one leg — use COMBO for more');
      for (const l of ins.legs) {
        const right = String(l?.right || '').toUpperCase();
        const lside = String(l?.side || '').toUpperCase();
        const strike = num(l?.strike), ratio = num(l?.ratio) ?? 1;
        if (!['C', 'P'].includes(right) || !(strike > 0) || !isDay(l?.expiry) || !['BUY', 'SELL'].includes(lside) || !(ratio > 0 && ratio <= 10 && Number.isInteger(ratio))) {
          return bad('every leg needs right C|P, a strike, an expiry YYYY-MM-DD, side BUY|SELL and a whole ratio');
        }
        legs.push({ right, strike, expiry: l.expiry, side: lside, ratio });
      }
    }
    out.instrument = { type, symbol, ...(side ? { side } : {}), ...(legs.length ? { legs } : {}) };
  }

  if (body.expected != null) {
    const e = body.expected;
    if (typeof e !== 'object') return bad('expected must be an object');
    const qty = num(e.qty), price = num(e.price), tol = num(e.tolerance_pct);
    if (e.qty != null && !(qty > 0)) return bad('expected.qty must be above zero');
    if (e.price != null && !(price >= 0)) return bad('expected.price must be zero or above');
    if (e.tolerance_pct != null && !(tol >= 0 && tol <= 50)) return bad('expected.tolerance_pct must be 0–50');
    out.expected = { qty, price, tolerance_pct: tol ?? 3 };
  } else out.expected = { qty: null, price: null, tolerance_pct: 3 };

  const lv = body.levels;
  if (lv != null && (typeof lv !== 'object' || Array.isArray(lv))) return bad('levels must be an object');
  const levels = {};
  for (const [k, v] of Object.entries(lv || {})) {
    if (!LEVEL_KEYS.includes(k)) return bad(`unknown level ${k} — expected ${LEVEL_KEYS.join(', ')}`);
    if (v == null) continue;
    if ((k === 'hard_date' || k === 'decide_by') && !isDay(v)) return bad(`levels.${k} must be YYYY-MM-DD`);
    levels[k] = String(v).slice(0, 200);
  }
  out.levels = levels;
  if (body.rules != null && !Array.isArray(body.rules)) return bad('rules must be a list');
  out.rules = (body.rules || []).map(r => String(r).slice(0, 300)).filter(Boolean).slice(0, 8);
  return { ok: true, note: out };
}

export const noteBytes = (body) => new TextEncoder().encode(JSON.stringify(body ?? null)).length;

// ── TRADING DAYS ─────────────────────────────────────────────────────────────
const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export function isTradingDay(d, holidays = []) {
  const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays.includes(d);
}
// Trading days strictly after `a` up to and including `b`; negative when b precedes a.
export function tradingDaysBetween(a, b, holidays = []) {
  if (!isDay(a) || !isDay(b)) return null;
  if (a === b) return 0;
  const sign = a < b ? 1 : -1;
  let [lo, hi] = a < b ? [a, b] : [b, a];
  let n = 0;
  for (let d = addDays(lo, 1), guard = 0; d <= hi && guard < 800; d = addDays(d, 1), guard++) if (isTradingDay(d, holidays)) n++;
  return sign * n;
}
// Distance in trading days, where a weekend or holiday date counts as the session after it.
function sessionGap(noteDay, fillDay, holidays) {
  const snap = (d) => { let x = d; for (let g = 0; g < 10 && !isTradingDay(x, holidays); g++) x = addDays(x, 1); return x; };
  return tradingDaysBetween(snap(noteDay), snap(fillDay), holidays);
}

// ── THE STATEMENT'S ORDERS ───────────────────────────────────────────────────
// lib/flexTrades.js qualifies every trade id with the contract — `${order}:${conid}` — so the legs
// of one combo order share the part before the colon. That is the grouping: one ORDER, however
// many legs, is one event to match a note against.
const orderOf = (t) => { const id = String(t.tradeId || ''); const i = id.indexOf(':'); return i > 0 ? id.slice(0, i) : (id || `${t.date}|${t.time || ''}|${t.root}`); };

function legOf(t) {
  const right = t.right || null, strike = num(t.strike), expiry = t.expiry || null;
  if (right && strike && expiry) return { right, strike, expiry };
  const p = parseOptionSymbol(t.symbol);
  return p ? { right: p.type === 'call' ? 'C' : 'P', strike: p.strike, expiry: p.expiry } : null;
}
const gcd = (a, b) => { a = Math.round(a); b = Math.round(b); while (b) [a, b] = [b, a % b]; return Math.abs(a) || 1; };

// Flex stamps an execution "20260930;112631" (or ISO); minutes since the epoch, for nearness.
function minuteOf(time) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})[;T\s]?(\d{2}):?(\d{2})/.exec(String(time || ''));
  if (m) return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000);
  return null;
}

// ── A SPREAD IBKR REPORTED AS SEPARATE ORDERS ────────────────────────────────
// A spread legged in — or routed so each leg gets its own order id — reaches the statement as one
// single-leg order per leg, and the note (one spread) found nothing to match: 30 Sep's SPY 750/720.
// For a note with two or more legs, single-leg orders in the same name, on the same day, filled
// within LEG_PAIR_MIN of each other, that between them carry exactly the note's legs, are offered as
// one spread. Never more than that: a leg used here is one candidate, and two ways to assemble the
// note are two candidates, which the ordinary ambiguity rule then refuses to guess between.
export const LEG_PAIR_MIN = 15;
export function assembledSpreads(note, units = []) {
  const ins = note?.instrument;
  if (!ins || !Array.isArray(ins.legs) || ins.legs.length < 2) return [];
  const sym = ins.symbol.split('.')[0];
  const singles = units.filter(u => u.type === 'OPT' && u.legs.length === 1 && String(u.root).toUpperCase() === sym);
  const legMatch = (u, nl) => { const l = u.legs[0]; return l.right === nl.right && Math.abs(l.strike - nl.strike) < 1e-6 && l.expiry === nl.expiry && l.side === nl.side; };
  const out = [];
  const pick = (i, chosen) => {
    if (i === ins.legs.length) {
      const day = chosen[0].date, mins = chosen.map(u => u.minute);
      if (!chosen.every(u => u.date === day)) return;
      if (mins.every(v => v != null) && Math.max(...mins) - Math.min(...mins) > LEG_PAIR_MIN) return;
      out.push(combine(chosen));
      return;
    }
    for (const u of singles) if (!chosen.includes(u) && legMatch(u, ins.legs[i])) pick(i + 1, [...chosen, u]);
  };
  pick(0, []);
  return out;
}
function combine(parts) {
  const legs = parts.map(u => ({ ...u.legs[0] }));
  const unitQty = legs.reduce((a, l) => gcd(a, l.qty), legs[0].qty);
  for (const l of legs) l.ratio = Math.round(l.qty / unitQty);
  const net = (key) => legs.reduce((a, l) => a + (l.side === 'BUY' ? 1 : -1) * l.ratio * (l[key] ?? 0), 0);
  const rawNet = net('rawPrice'), effNet = net('price');
  const first = parts[0];
  return { orderId: parts.map(u => u.orderId).join('+'), parts: parts.map(u => u.orderId), root: first.root, currency: first.currency,
    date: first.date, tradeIds: parts.flatMap(u => u.tradeIds), multiplier: first.multiplier,
    commission: +parts.reduce((a, u) => a + (u.commission || 0), 0).toFixed(2), minute: first.minute,
    type: 'COMBO', legs, qty: unitQty, side: rawNet >= 0 ? 'BUY' : 'SELL',
    rawPrice: +Math.abs(rawNet).toFixed(4), price: +Math.abs(effNet).toFixed(4), assembled: true };
}

// Trades (lib/flexTrades.js parseTrades shape) → one unit per order.
export function orderUnits(trades = []) {
  const by = new Map();
  for (const t of trades || []) {
    const k = orderOf(t);
    by.set(k, [...(by.get(k) || []), t]);
  }
  const units = [];
  for (const [orderId, ts] of by) {
    const first = ts[0];
    const cat = String(first.assetCategory || '').toUpperCase();
    const isOpt = ts.every(t => ['OPT', 'FOP'].includes(String(t.assetCategory || '').toUpperCase()));
    const base = {
      orderId, root: first.root || rootOf(first), currency: first.currency || 'USD',
      date: ts.map(t => t.date).filter(Boolean).sort()[0] || null,
      tradeIds: ts.map(t => t.tradeId).filter(Boolean), multiplier: first.multiplier || 1,
      commission: +ts.reduce((a, t) => a + (t.commission || 0), 0).toFixed(2),
      minute: ts.map(t => minuteOf(t.time)).filter(v => v != null).sort((a, b) => a - b)[0] ?? null,
    };
    if (isOpt) {
      const legs = ts.map(t => ({ ...legOf(t), side: t.side === 'sell' ? 'SELL' : 'BUY', qty: t.qty, rawPrice: t.rawPrice ?? t.price, price: t.price, tradeId: t.tradeId }));
      if (legs.some(l => !l.right)) { units.push({ ...base, type: 'OTHER', legs: [], qty: null, price: null, side: null }); continue; }
      // Units of the combo: the legs' common factor. 2 × (1 : 1) is two spreads; 2 × (1 : 2) is two
      // ratio spreads with legs of 2 and 4.
      const unitQty = legs.reduce((a, l) => gcd(a, l.qty), legs[0].qty);
      for (const l of legs) l.ratio = Math.round(l.qty / unitQty);
      const net = (key) => legs.reduce((a, l) => a + (l.side === 'BUY' ? 1 : -1) * l.ratio * (l[key] ?? 0), 0);
      const rawNet = net('rawPrice'), effNet = net('price');
      units.push({ ...base, type: legs.length > 1 ? 'COMBO' : 'OPT', legs, qty: unitQty,
        // A debit is bought, a credit sold — IBKR quotes both positive.
        side: rawNet >= 0 ? 'BUY' : 'SELL', rawPrice: +Math.abs(rawNet).toFixed(4), price: +Math.abs(effNet).toFixed(4) });
      continue;
    }
    // Shares and futures: an order is one contract. Several executions at ORDER level are already
    // one row; at EXECUTION level they are summed here into one event at the average price.
    const qty = ts.reduce((a, t) => a + (t.qty || 0), 0);
    const avg = (key) => qty ? ts.reduce((a, t) => a + (t.qty || 0) * (t[key] ?? t.price ?? 0), 0) / qty : null;
    const sides = new Set(ts.map(t => t.side));
    units.push({ ...base, type: cat === 'FUT' ? 'FUT' : (cat === 'STK' || cat === 'ETF' || cat === 'FUND') ? 'STK' : 'OTHER',
      legs: [], qty, side: sides.size === 1 ? (first.side === 'sell' ? 'SELL' : 'BUY') : null,
      rawPrice: avg('rawPrice') == null ? null : +avg('rawPrice').toFixed(4), price: avg('price') == null ? null : +avg('price').toFixed(4),
      trades: ts.map(t => ({ tradeId: t.tradeId, side: t.side, qty: t.qty, price: t.price, date: t.date })) });
  }
  return units.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.orderId).localeCompare(String(b.orderId)));
}

// ── ONE NOTE AGAINST ONE ORDER ───────────────────────────────────────────────
// Returns null when it is not the same trade, else the comparisons the draft card shows.
const IMPLIED_SIDE = { open: 'BUY', add: 'BUY' };
export function matchNote(note, unit, { holidays = [] } = {}) {
  const ins = note.instrument;
  if (!ins || !unit || unit.type === 'OTHER') return null;
  if (String(unit.root).toUpperCase() !== ins.symbol.split('.')[0]) return null;
  // Date: ±1 trading day, except a plan, which waits for its fill up to five sessions later.
  const gap = sessionGap(note.trade_date, unit.date, holidays);
  if (gap == null || gap < -DATE_WINDOW || gap > (note.kind === 'plan' ? WAIT_TRADING_DAYS : DATE_WINDOW)) return null;
  // Instrument and legs, leg for leg: same right, strike, expiry, side, and ratio.
  if (ins.type === 'OPT' || ins.type === 'COMBO') {
    if (unit.type !== 'OPT' && unit.type !== 'COMBO') return null;
    if (unit.legs.length !== ins.legs.length) return null;
    const used = new Set();
    for (const nl of ins.legs) {
      const i = unit.legs.findIndex((ul, j) => !used.has(j) && ul.right === nl.right && Math.abs(ul.strike - nl.strike) < 1e-6
        && ul.expiry === nl.expiry && ul.side === nl.side && ul.ratio === nl.ratio);
      if (i < 0) return null;
      used.add(i);
    }
  } else {
    if (unit.type !== (ins.type === 'FUT' ? 'FUT' : 'STK')) return null;
    // Side for shares and futures: the note's own if it gave one, else what its kind implies. A
    // plan, trim or close with no side matches either way — the fill says which it was.
    const want = ins.side || IMPLIED_SIDE[note.kind] || (note.kind === 'trim' ? 'SELL' : null);
    if (want && unit.side !== want) return null;
  }
  const checks = [];
  const e = note.expected || {};
  if (e.qty != null) {
    const same = Math.abs(unit.qty - e.qty) < 1e-9;
    if (!same && !ANY_QTY.has(note.kind)) return null;
    checks.push({ field: 'qty', note: e.qty, ibkr: unit.qty, ok: same });
  }
  if (e.price != null && unit.rawPrice != null) {
    const tol = (e.tolerance_pct ?? 3) / 100;
    const ok = Math.abs(unit.rawPrice - e.price) <= Math.abs(e.price) * tol + 1e-9;
    if (!ok) return null;
    checks.push({ field: 'price', note: e.price, ibkr: unit.rawPrice, ok: true });
  }
  if (gap !== 0) checks.push({ field: 'date', note: note.trade_date, ibkr: unit.date, ok: true, soft: true });
  return { gap, checks };
}

// ── WHY A NOTE IS STILL WAITING ──────────────────────────────────────────────
// The same checks as matchNote, in the same order, but saying which one failed and by how much —
// so a note that sits unmatched explains itself on the console instead of leaving a guess. The
// order is how far a candidate got: a fill that matched the date, the legs and the side and failed
// only on price is a nearer miss than one in the wrong week, and the nearest is what is reported.
const STEPS = ['date', 'type', 'legs', 'side', 'qty', 'price'];
export function whyNot(note, unit, { holidays = [] } = {}) {
  const ins = note.instrument;
  if (!ins || !unit || unit.type === 'OTHER') return { step: -1, reason: 'not a comparable order' };
  const gap = sessionGap(note.trade_date, unit.date, holidays);
  const maxGap = note.kind === 'plan' ? WAIT_TRADING_DAYS : DATE_WINDOW;
  const fail = (step, reason) => ({ step: STEPS.indexOf(step), reason });
  if (gap == null || gap < -DATE_WINDOW || gap > maxGap) return fail('date', `filled ${unit.date}, outside ${note.trade_date} −${DATE_WINDOW}/+${maxGap} sessions`);
  if (ins.type === 'OPT' || ins.type === 'COMBO') {
    if (unit.type !== 'OPT' && unit.type !== 'COMBO') return fail('type', `a ${unit.type} order, the note is an option ${ins.type.toLowerCase()}`);
    const fmt = (L) => L.map(l => `${l.side} ${l.ratio > 1 ? l.ratio + '×' : ''}${l.strike}${l.right} ${l.expiry}`).join(' / ');
    if (unit.legs.length !== ins.legs.length) return fail('legs', `${unit.legs.length} leg${unit.legs.length === 1 ? '' : 's'} in IBKR's order (${fmt(unit.legs)}), ${ins.legs.length} in the note — if a spread's legs were filled as separate orders they cannot be matched as one`);
    const used = new Set();
    for (const nl of ins.legs) {
      const i = unit.legs.findIndex((ul, j) => !used.has(j) && ul.right === nl.right && Math.abs(ul.strike - nl.strike) < 1e-6 && ul.expiry === nl.expiry && ul.side === nl.side && ul.ratio === nl.ratio);
      if (i < 0) return fail('legs', `legs differ — IBKR ${fmt(unit.legs)}, note ${fmt(ins.legs)}`);
      used.add(i);
    }
  } else {
    if (unit.type !== (ins.type === 'FUT' ? 'FUT' : 'STK')) return fail('type', `a ${unit.type} order, the note is ${ins.type}`);
    const want = ins.side || IMPLIED_SIDE[note.kind] || (note.kind === 'trim' ? 'SELL' : null);
    if (want && unit.side !== want) return fail('side', `a ${String(unit.side).toLowerCase()}, the note expects a ${want.toLowerCase()}`);
  }
  const e = note.expected || {};
  if (e.qty != null && Math.abs(unit.qty - e.qty) >= 1e-9 && !ANY_QTY.has(note.kind)) return fail('qty', `quantity ${unit.qty}, the note expects ${e.qty}`);
  if (e.price != null && unit.rawPrice != null) {
    const tol = e.tolerance_pct ?? 3;
    const off = Math.abs(unit.rawPrice - e.price) / Math.abs(e.price || 1) * 100;
    if (off > tol + 1e-9) return fail('price', `net price ${fmtPx(unit.rawPrice)}, the note expects ${fmtPx(e.price)} ±${tol}% (${off.toFixed(1)}% off)`);
  }
  return null;
}

// The nearest miss among the statement's orders, as one line for the console.
export function explainWaiting(note, units = [], { holidays = [], claimedBy = () => null } = {}) {
  const sym = note.instrument?.symbol?.split('.')[0];
  if (!sym) return 'an amend waits for nothing — it is drafted on the next run';
  const same = [...units, ...assembledSpreads(note, units)].filter(u => String(u.root).toUpperCase() === sym);
  if (!same.length) return `no ${sym} orders in the statement yet — the fill may not be in IBKR's report until the day after it trades`;
  const tries = same.map(u => {
    const by = claimedBy(u);
    if (by) return { u, step: STEPS.length, reason: `the matching ${sym} order on ${u.date} was already claimed by note ${by}` };
    const w = whyNot(note, u, { holidays });
    return w ? { u, ...w } : { u, step: STEPS.length + 1, reason: 'matches — it will be drafted on the next run' };
  }).sort((a, b) => b.step - a.step
    // Equally near misses: the one on the note's own date first.
    || Math.abs(Date.parse(a.u.date) - Date.parse(note.trade_date)) - Math.abs(Date.parse(b.u.date) - Date.parse(note.trade_date)));
  const best = tries[0];
  return `${sym} order ${best.u.orderId} (${best.u.date}): ${best.reason}`;
}

// What the card and the channel call an order. No quantities or prices — those are the caller's to
// add where they are allowed.
export function unitLabel(u) {
  if (!u) return '?';
  if (u.type === 'OPT' || u.type === 'COMBO') {
    const exp = [...new Set(u.legs.map(l => l.expiry))];
    const strikes = u.legs.map(l => `${l.strike}${l.right}`).join('/');
    return `${u.root} ${exp.map(x => x.slice(5)).join('/')} ${strikes}`;
  }
  return u.root;
}

// A draft's fill: the statement's numbers, carried as the statement gave them.
const fillOf = (u) => ({ orderId: u.orderId, type: u.type, root: u.root, currency: u.currency, date: u.date, side: u.side,
  qty: u.qty, rawPrice: u.rawPrice, price: u.price, commission: u.commission, multiplier: u.multiplier,
  legs: u.legs.map(({ right, strike, expiry, side, ratio }) => ({ right, strike, expiry, side, ratio })),
  tradeIds: u.tradeIds, trades: u.trades || null, label: unitLabel(u) });
const noteOfDraft = (n) => ({ id: n.id, kind: n.kind, trade_date: n.trade_date, tag: n.tag, rationale: n.rationale,
  levels: n.levels, rules: n.rules, expected: n.expected, supersedes: n.supersedes, instrument: n.instrument || null });

// ── THE DAILY RUN ────────────────────────────────────────────────────────────
// notes     pending notes from the inbox (validated shape)
// trades    the statement's trades (parseTrades)
// known     trade ids the console already holds (a hand-entered fill the statement adopted is
//           journaled; the planner's own new fills are not — they have no rationale)
// seen      { orderId: { date, note } } — orders already drafted or claimed, so a dismissed
//           unjournaled fill is not offered again every morning for thirty days
// drafts    the current draft list, so a note that arrives after its fill upgrades the draft
//
// Returns the next draft list, which notes left the inbox and why, and the new seen map. Writes
// nothing.
export function processInbox({ notes = [], trades = [], known = new Set(), seen = {}, drafts = [], today, holidays = [], from = INBOX_FROM, now = new Date().toISOString() } = {}) {
  const units = orderUnits(trades).filter(u => u.date && u.date >= addDays(from, -3));
  const seenNext = { ...(seen || {}) };
  const byId = new Map((drafts || []).map(d => [d.id, d]));
  const leaving = [];          // { note, outcome }
  const counts = { drafted: 0, ambiguous: 0, unfilled: 0, amends: 0, unjournaled: 0, pending: 0 };
  const symbols = { drafted: [], ambiguous: [], unfilled: [], unjournaled: [] };
  const why = {};               // noteId → { at, reason } for every note still waiting
  // An order another note already claimed is not a candidate for this one.
  // An assembled spread is claimed if any of its legs is; claiming one claims every leg.
  const ids = (u) => u.parts || [u.orderId];
  const claimed = (u) => ids(u).some(id => seenNext[id]?.note);
  const claim = (u, noteId) => { for (const id of ids(u)) { seenNext[id] = { date: u.date, note: noteId }; byId.delete(`d-${id}`); } };

  for (const note of notes) {
    if (note.kind === 'amend') {
      byId.set(`m-${note.id}`, { id: `m-${note.id}`, kind: 'amend', state: 'DRAFT', created: now, supersedes: note.supersedes, note: noteOfDraft(note) });
      leaving.push({ note, outcome: 'amend-drafted' }); counts.amends++;
      continue;
    }
    const hits = [];
    for (const u of [...units, ...assembledSpreads(note, units)]) {
      if (claimed(u)) continue;
      const m = matchNote(note, u, { holidays });
      if (m) hits.push({ u, m });
    }
    const sym = note.instrument?.symbol;
    if (hits.length === 1) {
      const { u, m } = hits[0];
      const id = `d-${u.orderId}`;
      claim(u, note.id);   // first, so a leg already offered as unjournaled is withdrawn
      byId.set(id, { id, kind: 'fill', state: 'DRAFT', created: now, source: 'note', fill: fillOf(u), note: noteOfDraft(note), checks: m.checks });
      leaving.push({ note, outcome: 'drafted' }); counts.drafted++; symbols.drafted.push(sym);
    } else if (hits.length > 1) {
      const id = `a-${note.id}`;
      byId.set(id, { id, kind: 'ambiguous', state: 'DRAFT', created: now, note: noteOfDraft(note),
        candidates: hits.map(({ u, m }) => ({ fill: fillOf(u), checks: m.checks })) });
      for (const { u } of hits) claim(u, note.id);
      leaving.push({ note, outcome: 'ambiguous' }); counts.ambiguous++; symbols.ambiguous.push(sym);
    } else {
      const waited = tradingDaysBetween(note.trade_date, today, holidays);
      if (waited != null && waited >= WAIT_TRADING_DAYS) {
        const id = `n-${note.id}`;
        byId.set(id, { id, kind: 'unfilled', state: 'DRAFT', created: now, note: noteOfDraft(note), waited });
        leaving.push({ note, outcome: 'no-fill' }); counts.unfilled++; symbols.unfilled.push(sym);
      } else {
        counts.pending++;
        why[note.id] = { at: now, reason: explainWaiting(note, units, { holidays, claimedBy: (u) => seenNext[u.orderId]?.note || null }) };
      }
    }
  }

  // UNJOURNALED: an order no note claimed, that the console did not already have by hand, from the
  // day the inbox went live, and not offered before.
  for (const u of units) {
    if (u.date < from || seenNext[u.orderId] || u.type === 'OTHER') continue;
    if (u.tradeIds.some(t => known.has(String(t)))) continue;
    const id = `d-${u.orderId}`;
    byId.set(id, { id, kind: 'fill', state: 'DRAFT', created: now, source: 'unjournaled', fill: fillOf(u), note: null, checks: [] });
    seenNext[u.orderId] = { date: u.date, note: null };
    counts.unjournaled++; symbols.unjournaled.push(u.root);
  }

  // Seen entries outlive the statement window, then go.
  const cutoff = addDays(today, -SEEN_KEEP_DAYS);
  for (const [k, v] of Object.entries(seenNext)) if (!v?.date || v.date < cutoff) delete seenNext[k];

  const next = [...byId.values()].sort((a, b) => String(a.created).localeCompare(String(b.created))).slice(-MAX_DRAFTS);
  return { drafts: next, leaving, seen: seenNext, counts, symbols, why };
}

// The channel line: symbols and counts, nothing else. No rationale, levels, quantity or price.
export function journalLine({ counts = {}, symbols = {} } = {}) {
  const u = (xs) => [...new Set((xs || []).filter(Boolean))].join(', ');
  const bits = [];
  if (counts.drafted) bits.push(`${counts.drafted} journal draft${counts.drafted === 1 ? '' : 's'} to confirm (${u(symbols.drafted)})`);
  if (counts.unjournaled) bits.push(`${counts.unjournaled} unjournaled fill${counts.unjournaled === 1 ? '' : 's'} (${u(symbols.unjournaled)})`);
  if (counts.ambiguous) bits.push(`${counts.ambiguous} note${counts.ambiguous === 1 ? '' : 's'} matched more than one fill (${u(symbols.ambiguous)})`);
  if (counts.unfilled) bits.push(`${counts.unfilled} note${counts.unfilled === 1 ? '' : 's'} without a fill (${u(symbols.unfilled)})`);
  return bits.join(' · ');
}

// Processed notes: appended, pruned to 30 days. The key itself also expires, so an inbox that
// falls silent leaves nothing behind.
export function appendProcessed(list = [], entries = [], { now = new Date().toISOString() } = {}) {
  const cutoff = new Date(Date.parse(now) - PROCESSED_TTL_DAYS * 86400000).toISOString();
  return [...(Array.isArray(list) ? list : []), ...entries.map(e => ({ ...e, at: e.at || now }))]
    .filter(e => e && String(e.at) >= cutoff).slice(-500);
}

// ── THE CONSOLE'S COUNTERS ───────────────────────────────────────────────────
export function draftCounts(drafts = []) {
  const d = Array.isArray(drafts) ? drafts : [];
  return {
    toConfirm: d.filter(x => (x.kind === 'fill' && x.note) || x.kind === 'amend' || x.kind === 'ambiguous').length,
    unjournaled: d.filter(x => x.kind === 'fill' && !x.note).length,
    withoutFills: d.filter(x => x.kind === 'unfilled').length,
  };
}

// The comparison line on the card: "note expected 2 @ 4.40, IBKR filled 2 @ 4.40 ✓".
// Two decimals for an ordinary premium; significant figures for a tiny one (a yen FOP quotes
// 0.00004, which two decimals printed as 0.00).
export const fmtPx = (v) => (v == null || !Number.isFinite(+v) ? '?' : Math.abs(+v) >= 0.1 || +v === 0 ? (+v).toFixed(2) : String(+(+v).toPrecision(3)));
const px = fmtPx;
export function expectationText(draft) {
  const f = draft?.fill, e = draft?.note?.expected;
  if (!f) return null;
  const filled = `IBKR filled ${f.qty} @ ${px(f.rawPrice)}`;
  if (!e || (e.qty == null && e.price == null)) return { text: filled, ok: true };
  const q = draft.checks?.find(c => c.field === 'qty'), p = draft.checks?.find(c => c.field === 'price');
  const ok = (!q || q.ok) && (!p || p.ok);
  const said = `note expected ${e.qty ?? '?'}${e.price != null ? ` @ ${px(e.price)}` : ''}`;
  const approx = draft.note.kind === 'plan' || draft.note.kind === 'trim';
  return { text: `${said}, ${filled}${ok ? ' ✓' : q && !q.ok ? ` — note said ${approx ? '~' : ''}${e.qty}` : ''}`, ok };
}

// ── CONFIRMING A DRAFT, ON THE CONSOLE'S ROWS ────────────────────────────────
// Returns { rows, rowId, how } or { error }. `edits` are what Stu changed on the card: tag,
// rationale, levels, rules. The fill's numbers are never editable here — IBKR is the record.
//
//   annotated  the statement's own fills are already on a row (the planner records share trades),
//              so the note's tag, rationale and levels are attached to that row and nothing else
//   added      an open row holds this instrument, so the fill is appended to it
//   created    nothing holds it, so a row is opened from the fill
export function applyDraft(rows = [], draft, edits = {}, { today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!draft) return { error: 'no draft' };
  const n = { ...(draft.note || {}), ...Object.fromEntries(Object.entries(edits || {}).filter(([, v]) => v !== undefined)) };
  const annotate = (r) => {
    const out = { ...r };
    if (n.tag && ['hedge', 'position', 'swing', 'intraday'].includes(n.tag)) out.tag = n.tag;
    const why = String(n.rationale || '').trim();
    if (why) {
      const prior = String(r.thesis || '').trim();
      const stamp = `${n.trade_date || today} (${n.kind || 'note'}): ${why}`;
      // An opened-from-statement placeholder is replaced, not appended to.
      // The sync's own placeholders ("Opened from…", "Added from the IBKR statement…") are replaced.
      out.thesis = (!prior || /^(Opened|Added) from the IBKR statement/.test(prior) ? why : `${prior}\n— ${stamp}`).slice(0, 600);
    }
    const levels = n.levels || {};
    if (Object.keys(levels).length || (n.rules || []).length) {
      out.journal = { noteId: n.id || null, kind: n.kind || null, at: today,
        levels: Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, String(v).slice(0, 200)])),
        rules: (n.rules || []).slice(0, 8).map(x => String(x).slice(0, 300)) };
    }
    if (isDerivativeRow(r)) { const hd = clampHardDate(levels.hard_date, legsOf(r)); if (hd) out.hardDate = hd; }
    return out;
  };

  if (draft.kind === 'amend') {
    const i = rows.findIndex(r => r.id === draft.supersedes);
    if (i < 0) return { error: `no console trade with id ${draft.supersedes}` };
    const next = rows.slice(); next[i] = annotate(rows[i]);
    return { rows: next, rowId: rows[i].id, how: 'annotated' };
  }
  if (draft.kind !== 'fill' || !draft.fill) return { error: 'only a fill or an amend can be confirmed' };
  const f = draft.fill;

  // Already on a row: the planner recorded the statement's share fills this morning.
  const ids = new Set((f.tradeIds || []).map(String));
  const holder = rows.findIndex(r => (r.fills || []).some(x => x.tradeId && (ids.has(String(x.tradeId)) || String(x.tradeId) === String(f.orderId))));
  if (holder >= 0) {
    const next = rows.slice(); next[holder] = annotate(rows[holder]);
    return { rows: next, rowId: rows[holder].id, how: 'annotated' };
  }

  const isOpt = f.type === 'OPT' || f.type === 'COMBO';
  const fillSide = f.side === 'SELL' ? 'sell' : 'buy';
  const note = `IBKR order ${f.orderId}${draft.note ? `, journal note ${draft.note.id}` : ''}, commission included`;
  // A setup with no fills yet counts: the fill is what turns it into the position it was waiting for.
  const open = (r) => derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side }).status !== 'closed';
  if (isOpt) {
    // Legs as held: a debit is bought (row long, BUY legs long); a credit sold (row short, legs
    // written as the spread that was sold, so the combo mark stays positive).
    const debit = f.side !== 'SELL';
    const asHeld = (s) => (s === 'BUY') === debit ? 'long' : 'short';
    const legs = f.legs.map(l => ({ right: l.right, strike: l.strike, expiry: l.expiry, side: asHeld(l.side), ratio: l.ratio }));
    const key = (L) => L.map(l => `${l.right}${l.strike}${l.expiry}`).sort().join('|');
    const k = key(legs);
    // A closing order on an existing row has its legs the other way round; the contracts match.
    const i = rows.findIndex(r => isDerivativeRow(r) && underlyingOf(r) === f.root && key(legsOf(r)) === k && open(r));
    const fill = { id: `jr${String(f.orderId).slice(-8)}`, side: fillSide, qty: f.qty, price: f.price, date: f.date, note, tradeId: String(f.orderId).slice(0, 24) };
    if (i >= 0) {
      const next = rows.slice();
      const j = handEntered(rows[i], { side: fillSide, qty: f.qty, date: f.date, prices: [f.rawPrice, f.price] });
      if (j >= 0) {
        // Already typed in by hand: stamp IBKR's id on that fill and add nothing.
        const fills = rows[i].fills.map((x, k) => k === j ? { ...x, tradeId: fill.tradeId } : x);
        next[i] = annotate({ ...rows[i], fills });
        return { rows: next, rowId: rows[i].id, how: 'adopted' };
      }
      next[i] = annotate({ ...rows[i], fills: [...(rows[i].fills || []), fill] });
      return { rows: next, rowId: rows[i].id, how: 'added' };
    }
    const made = optionRow({ underlying: f.root, legs, side: debit ? 'long' : 'short', currency: f.currency || 'USD',
      hardDate: clampHardDate(n.levels?.hard_date, legs), id: `${f.root}-j${String(f.orderId).slice(-6)}` });
    if (made.error) return { error: made.error };
    const row = annotate({ ...made.row, fills: [fill], tags: ['journal'] });
    return { rows: [...rows, row], rowId: row.id, how: 'created' };
  }

  // Shares and futures the planner did not record (before the watermark, or a batch it discarded).
  const fills = (f.trades && f.trades.length ? f.trades : [{ tradeId: f.tradeIds?.[0], side: fillSide, qty: f.qty, price: f.price, date: f.date }])
    .map((t, j) => ({ id: `jr${String(t.tradeId || f.orderId).slice(-7)}${j}`, side: t.side === 'sell' ? 'sell' : 'buy', qty: t.qty, price: t.price, date: t.date || f.date, note, tradeId: t.tradeId ? String(t.tradeId).slice(0, 24) : null }));
  const i = rows.findIndex(r => !isDerivativeRow(r) && String(r.symbol).split('.')[0].toUpperCase() === f.root && (r.currency || 'USD') === (f.currency || 'USD') && open(r));
  if (i >= 0) {
    const next = rows.slice();
    const j = handEntered(rows[i], { side: fillSide, qty: f.qty, date: f.date, prices: [f.rawPrice, f.price] });
    if (j >= 0) {
      const stamped = rows[i].fills.map((x, k) => k === j ? { ...x, tradeId: fills[0].tradeId || String(f.orderId).slice(0, 24) } : x);
      next[i] = annotate({ ...rows[i], fills: stamped });
      return { rows: next, rowId: rows[i].id, how: 'adopted' };
    }
    next[i] = annotate({ ...rows[i], fills: [...(rows[i].fills || []), ...fills] });
    return { rows: next, rowId: rows[i].id, how: 'added' };
  }
  const row = annotate({ id: `${f.root}-j${String(f.orderId).slice(-6)}`, symbol: f.root, currency: f.currency || 'USD',
    side: fillSide === 'sell' ? 'short' : 'long', multiplier: f.multiplier || 1, margined: f.type === 'FUT',
    thesis: '', trade: '', levels: [], fills, tags: ['journal'] });
  return { rows: [...rows, row], rowId: row.id, how: 'created' };
}

// A FILL ALREADY TYPED IN BY HAND. The trade was placed, then entered on the console, then the
// statement arrived: without this, confirming the draft would record the same fill twice. Same side,
// same quantity, dated within three days (a weekend, and Dubai against New York), at a price within
// 2% of IBKR's (a hand entry is usually the headline print, without the commission). No trade id,
// since a fill that already carries one came from a statement. Returns its index or -1.
function handEntered(row, { side, qty, date, prices = [] }) {
  const days = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
  return (row.fills || []).findIndex(x => !x.tradeId && x.side === side && Math.abs(Number(x.qty) - qty) < 1e-9
    && isDay(x.date) && isDay(date) && days(x.date, date) <= 3
    && prices.some(p => p != null && Math.abs(Number(x.price) - p) <= Math.abs(p) * 0.02 + 1e-9));
}

// A note's hard date is often the expiry itself ("hard date 20 Nov" on a 20 Nov spread). The console
// will not hold a row to expiry day — its hard date is at latest the session before — so the note's
// date is stepped back to the last one the console accepts. The note's own words stay in `journal`.
function clampHardDate(hd, legs) {
  if (!isDay(hd)) return null;
  for (let d = hd, g = 0; g < 10; d = addDays(d, -1), g++) if (hardDateCheck(d, legs).ok) return d;
  return null;
}

// Promote one candidate of an ambiguous draft to an ordinary draft — Stu's choice, never inferred.
export function chooseCandidate(draft, orderId) {
  if (draft?.kind !== 'ambiguous') return null;
  const c = (draft.candidates || []).find(x => x.fill?.orderId === orderId);
  if (!c) return null;
  return { id: `d-${orderId}`, kind: 'fill', state: 'DRAFT', created: draft.created, source: 'note', fill: c.fill, note: draft.note, checks: c.checks };
}

