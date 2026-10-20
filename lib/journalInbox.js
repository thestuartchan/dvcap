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

import { rootOf, matchKey } from './flex.js';
// Prices keep their significant figures: a 6J option is quoted near 0.00003, and toFixed(4) made it 0.
import { roundQuote } from './price.js';
import { derivePosition } from './positions.js';
import { parseOptionSymbol } from './bookExposure.js';
import { optionRow, isDerivativeRow, legsOf, underlyingOf, hardDateCheck, instrumentOf, legLabel } from './instruments.js';

// ── STORAGE ──────────────────────────────────────────────────────────────────
export const INBOX_KEY = 'dvcap:journal:inbox:v1';          // Redis LIST — pending notes, RPUSH'd
export const PROCESSED_KEY = 'dvcap:journal:processed:v1';  // JSON — resolved notes, 30-day TTL
export const DRAFTS_KEY = 'dvcap:journal:drafts:v1';        // JSON — what the console shows
export const SEEN_KEY = 'dvcap:journal:seen:v1';            // JSON — orders already drafted
export const WHY_KEY = 'dvcap:journal:why:v1';              // JSON — why each waiting note has not matched
// How a note's level keys read on screen — the draft cards and the trade card's written rules.
export const LEVEL_LABEL = { take_profit: "Take profit", stop: "Stop", invalidation: "Invalidation", review: "Review", hard_date: "Hard date", decide_by: "Decide by" };
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
    // AN AMEND NAMES ITS TARGET ONE OF TWO WAYS. A console trade id in `supersedes` — which only
    // something that can read the console knows — or, when that is empty, the instrument itself,
    // resolved against the open trades when the note arrives (resolveAmend). `supersedes` wins
    // when both are given; the instrument is then ignored.
    if (!out.supersedes) {
      if (!body.instrument || typeof body.instrument !== 'object') return bad('an amend names its target: a console trade id in supersedes, or the instrument');
      const ins = parseInstrument(body.instrument, { amend: true });
      if (ins.error) return bad(ins.error);
      out.instrument = ins.instrument;
    }
  } else {
    if (!body.instrument || typeof body.instrument !== 'object') return bad('instrument is required');
    const ins = parseInstrument(body.instrument);
    if (ins.error) return bad(ins.error);
    out.instrument = ins.instrument;
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
    // In an amend, null REMOVES that level from the trade; elsewhere it is simply absent.
    if (v == null) { if (body.kind === 'amend') levels[k] = null; continue; }
    if ((k === 'hard_date' || k === 'decide_by') && !isDay(v)) return bad(`levels.${k} must be YYYY-MM-DD`);
    levels[k] = String(v).slice(0, 200);
  }
  out.levels = levels;
  if (body.rules != null && !Array.isArray(body.rules)) return bad('rules must be a list');
  out.rules = (body.rules || []).map(r => String(r).slice(0, 300)).filter(Boolean).slice(0, 8);
  // Whether the note said anything about rules — an amend's list REPLACES the trade's, so an amend
  // that leaves `rules` out must leave the trade's rules alone rather than empty them.
  out.rulesGiven = Array.isArray(body.rules);
  return { ok: true, note: out };
}

// One instrument, as a note names it. An amend may leave out a leg's side and ratio (it names a
// trade, not an order) and a future may carry the contract month (`expiry`: YYYY-MM).
function parseInstrument(ins, { amend = false } = {}) {
  const err = (error) => ({ error });
  const type = String(ins.type || '').toUpperCase();
  if (!INSTRUMENT_TYPES.includes(type)) return err(`instrument.type must be one of ${INSTRUMENT_TYPES.join(', ')}`);
  const symbol = String(ins.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9./]{0,11}$/.test(symbol)) return err('instrument.symbol is not a symbol');
  const side = ins.side == null ? null : String(ins.side).toUpperCase();
  if (side != null && side !== 'BUY' && side !== 'SELL') return err('instrument.side must be BUY or SELL');
  const legs = [];
  if (type === 'OPT' || type === 'COMBO') {
    if (!Array.isArray(ins.legs) || !ins.legs.length) return err(`an ${type} note needs its legs`);
    if (ins.legs.length > 4) return err('at most 4 legs');
    if (type === 'COMBO' && ins.legs.length < 2) return err('a COMBO has two or more legs');
    if (type === 'OPT' && ins.legs.length !== 1) return err('an OPT note has one leg — use COMBO for more');
    for (const l of ins.legs) {
      const right = String(l?.right || '').toUpperCase();
      const lside = l?.side == null && amend ? null : String(l?.side || '').toUpperCase();
      const strike = num(l?.strike), ratio = num(l?.ratio) ?? 1;
      if (!['C', 'P'].includes(right) || !(strike > 0) || !isDay(l?.expiry) || (lside !== null && !['BUY', 'SELL'].includes(lside)) || !(ratio > 0 && ratio <= 10 && Number.isInteger(ratio))) {
        return err(`every leg needs right C|P, a strike, an expiry YYYY-MM-DD${amend ? '' : ', side BUY|SELL'} and a whole ratio`);
      }
      legs.push({ right, strike, expiry: l.expiry, ...(lside ? { side: lside } : {}), ratio });
    }
  }
  const month = type === 'FUT' && ins.expiry != null ? String(ins.expiry).slice(0, 7) : null;
  if (month != null && !/^\d{4}-\d{2}$/.test(month)) return err('instrument.expiry for a future is the contract month, YYYY-MM');
  return { instrument: { type, symbol, ...(side ? { side } : {}), ...(legs.length ? { legs } : {}), ...(month ? { expiry: month } : {}) } };
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
  const singles = units.filter(u => u.type === 'OPT' && u.legs.length === 1 && sameRoot(u.root, sym));
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
export function combine(parts) {
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
    rawPrice: roundQuote(Math.abs(rawNet)), price: roundQuote(Math.abs(effNet)), assembled: true };
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
        side: rawNet >= 0 ? 'BUY' : 'SELL', rawPrice: roundQuote(Math.abs(rawNet)), price: roundQuote(Math.abs(effNet)) });
      continue;
    }
    // Shares and futures: an order is one contract. Several executions at ORDER level are already
    // one row; at EXECUTION level they are summed here into one event at the average price.
    const qty = ts.reduce((a, t) => a + (t.qty || 0), 0);
    const avg = (key) => qty ? ts.reduce((a, t) => a + (t.qty || 0) * (t[key] ?? t.price ?? 0), 0) / qty : null;
    const sides = new Set(ts.map(t => t.side));
    units.push({ ...base, type: cat === 'FUT' ? 'FUT' : (cat === 'STK' || cat === 'ETF' || cat === 'FUND') ? 'STK' : 'OTHER',
      legs: [], qty, side: sides.size === 1 ? (first.side === 'sell' ? 'SELL' : 'BUY') : null,
      rawPrice: roundQuote(avg('rawPrice')), price: roundQuote(avg('price')),
      trades: ts.map(t => ({ tradeId: t.tradeId, side: t.side, qty: t.qty, price: t.price, date: t.date })) });
  }
  return units.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.orderId).localeCompare(String(b.orderId)));
}

// ── ONE CONTRACT, SEVERAL NAMES ──────────────────────────────────────────────
// An option on a future reaches the statement under its future's month code — the yen options
// arrive as 6JZ6 — and a note names the product: 6J, or IBKR's own JPY, or the options root JPU.
// Strip a month+year tail (as rootOf does for futures), then map the CME FX names onto one.
// Anything else is compared as written.
const FX_ROOT = { JPY: '6J', JPU: '6J', EUR: '6E', GBP: '6B', CAD: '6C', AUD: '6A', CHF: '6S', MXN: '6M' };
const MONTH_TAIL = /^([A-Z0-9]{1,5}?)[FGHJKMNQUVXZ]\d{1,2}$/;
export function productRoot(sym) {
  const s = String(sym || '').trim().toUpperCase().split('.')[0];
  const m = MONTH_TAIL.exec(s);
  const base = m ? m[1] : s;
  return FX_ROOT[base] || FX_ROOT[s] || matchKey(base);
}
export const sameRoot = (unitRoot, noteSymbol) => {
  const a = String(unitRoot || '').toUpperCase(), b = String(noteSymbol || '').toUpperCase().split('.')[0];
  return a === b || productRoot(a) === productRoot(b);
};

// ── ONE NOTE AGAINST ONE ORDER ───────────────────────────────────────────────
// Returns null when it is not the same trade, else the comparisons the draft card shows.
const IMPLIED_SIDE = { open: 'BUY', add: 'BUY' };
export function matchNote(note, unit, { holidays = [] } = {}) {
  const ins = note.instrument;
  if (!ins || !unit || unit.type === 'OTHER') return null;
  if (!sameRoot(unit.root, ins.symbol)) return null;
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
  const same = [...units, ...assembledSpreads(note, units)].filter(u => sameRoot(u.root, sym));
  if (!same.length) return `no ${sym} orders in the statement yet — the fill may not be in IBKR's report until the day after it trades`;
  // AN ORDER ANOTHER NOTE CLAIMED IS NOT A NEAR MISS (7 Oct). It used to rank as the nearest one, so
  // the yen spread's close note, received hours before IBKR's report carried the closing legs, was
  // "waiting" on the 1 Oct opening order its open note had claimed — which read as a broken match.
  // Only unclaimed orders are compared; if every one is claimed, the new fill is not reported yet.
  // A SAME-DAY OPTION IS NOT A NEAR MISS for a note about a longer-dated trade (SPY, 9 Oct: a plan
  // for a Nov spread "waited" on that day's expired 772P). Kept only when the note is itself 0DTE.
  const noteZeroDte = (note.instrument?.legs || []).some(l => l.expiry === note.trade_date);
  const free = same.filter(u => !claimedBy(u) && (noteZeroDte || !((u.type === 'OPT' || u.type === 'COMBO') && u.legs.length && u.legs.every(l => l.expiry === u.date))));
  if (!free.length && same.every(u => claimedBy(u))) {
    const days = [...new Set(same.map(u => u.date))].sort().join(', ');
    return `no new ${sym} order in the statement yet (the ${days} ${same.length === 1 ? 'order belongs' : 'orders belong'} to other notes) — a fill reaches IBKR's report the morning after it trades`;
  }
  if (!free.length) return `no ${sym} order in the statement matches this yet — only same-day options, which a longer-dated note never matches`;
  const tries = free.map(u => {
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
export const fillOf = (u) => ({ orderId: u.orderId, type: u.type, root: u.root, currency: u.currency, date: u.date, side: u.side,
  qty: u.qty, rawPrice: u.rawPrice, price: u.price, commission: u.commission, multiplier: u.multiplier,
  legs: u.legs.map(({ right, strike, expiry, side, ratio }) => ({ right, strike, expiry, side, ratio })),
  tradeIds: u.tradeIds, trades: u.trades || null, label: unitLabel(u), minute: u.minute ?? null });
const noteOfDraft = (n) => ({ id: n.id, kind: n.kind, trade_date: n.trade_date, tag: n.tag, rationale: n.rationale,
  levels: n.levels, rules: n.rules, rulesGiven: n.rulesGiven ?? (Array.isArray(n.rules) && n.rules.length > 0),
  expected: n.expected, supersedes: n.supersedes, instrument: n.instrument || null });

// ── DAY TRADES ───────────────────────────────────────────────────────────────
// An order is a day trade when it expires the day it trades (0DTE), or when its contract was taken
// to flat within that session — every buy and sell of that contract that day net to zero. What is
// left open overnight is not a day trade, and is the only thing offered as an unjournaled fill.
const contractOf = (u) => (u.type === 'OPT' || u.type === 'COMBO')
  ? `${u.root}|${u.legs.map(l => `${l.right}${+l.strike}${l.expiry}`).sort().join(',')}` : `${u.root}|${u.currency || ''}`;
export function dayTradeOrders(units = []) {
  const out = new Set(), net = new Map();
  for (const u of units) {
    if ((u.type === 'OPT' || u.type === 'COMBO') && u.legs.length && u.legs.every(l => l.expiry === u.date)) out.add(u.orderId);
    if (u.qty == null || !u.side) continue;
    const k = `${contractOf(u)}@${u.date}`;
    const g = net.get(k) || { q: 0, ids: [] };
    g.q += (u.side === 'BUY' ? 1 : -1) * u.qty; g.ids.push(u.orderId); net.set(k, g);
  }
  for (const g of net.values()) if (Math.abs(g.q) < 1e-9 && g.ids.length > 1) g.ids.forEach(id => out.add(id));
  return out;
}

// ── ONE LEG OF AN OPEN SPREAD (14 Oct) ───────────────────────────────────────
// A straddle bought as one combo is one console row, but IBKR reported its exit as one single-leg
// order per leg — and the rest of the puts sold on their own. Matched as written (every leg, as a
// set) those fills found no row, and confirming one would have opened a new short call or put. Now:
//   legTargets   the open multi-leg rows a single-leg fill REDUCES (same contract, opposite way)
//   pairLegOuts  single-leg drafts that together make whole units of one row, same day, filled within
//                LEG_PAIR_MIN where timed → one draft, closed on that row as an ordinary combo fill
//   legOutOf     a single-leg fill left over: confirming splits the row (applyDraft) — and to divide
//                its cost it needs a same-day price for every leg, taken here while the fills are seen
const legSgn = (s) => (s === 'short' ? -1 : 1);
const sameContract = (a, b) => a && b && a.right === b.right && Math.abs(+a.strike - +b.strike) < 1e-6 && a.expiry === b.expiry;
export function legTargets(f, rows = []) {
  if (!f || f.type !== 'OPT' || (f.legs || []).length !== 1 || !f.side) return [];
  const l = f.legs[0], dir = f.side === 'BUY' ? 1 : -1, out = [];
  for (const r of rows || []) {
    if (!isDerivativeRow(r) || !sameRoot(f.root, underlyingOf(r))) continue;
    const L = legsOf(r);
    if (L.length < 2) continue;
    const pos = derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side });
    if (pos.status === 'closed' || !(pos.qty > 0)) continue;
    const rowSign = r.side === 'short' ? -1 : 1;
    L.forEach((leg, i) => {
      if (!sameContract(leg, l)) return;
      const held = rowSign * legSgn(leg.side);              // +1 long the contract, −1 short it
      if (dir !== -held) return;                             // the same way ADDS to the leg
      out.push({ rowId: r.id, label: rowLabel(r), leg: i, legs: L.length, units: pos.qty, legQty: pos.qty * leg.ratio,
                 basis: pos.avgCost, held: held > 0 ? 'long' : 'short', right: leg.right });
    });
  }
  return out;
}
const asPart = (d) => ({ orderId: d.fill.orderId, root: d.fill.root, currency: d.fill.currency, date: d.fill.date, tradeIds: d.fill.tradeIds || [],
  multiplier: d.fill.multiplier, commission: d.fill.commission || 0, minute: d.fill.minute ?? null,
  legs: [{ ...d.fill.legs[0], side: d.fill.side, qty: d.fill.qty, rawPrice: d.fill.rawPrice, price: d.fill.price }] });
export function pairLegOuts(drafts = [], rows = []) {
  let list = (drafts || []).slice();
  const made = [];
  for (const r of rows || []) {
    const L = legsOf(r);
    if (!isDerivativeRow(r) || L.length < 2) continue;
    for (let guard = 0; guard < 20; guard++) {
      const singles = list.filter(d => d.kind === 'fill' && d.source === 'unjournaled' && d.fill?.type === 'OPT');
      const per = L.map((_, i) => singles.filter(d => legTargets(d.fill, [r]).some(t => t.leg === i)));
      if (per.some(p => !p.length)) break;
      const units = legTargets(per[0][0].fill, [r])[0].units;
      let best = null;
      const pick = (i, chosen) => {
        if (i === L.length) {
          const u0 = chosen[0].fill.qty / L[0].ratio;
          if (!chosen.every((d, k) => Math.abs(d.fill.qty / L[k].ratio - u0) < 1e-9 && d.fill.date === chosen[0].fill.date)) return;
          if (u0 > units + 1e-9) return;
          const mins = chosen.map(d => d.fill.minute);
          const spread = mins.every(v => v != null) ? Math.max(...mins) - Math.min(...mins) : null;
          if (spread != null && spread > LEG_PAIR_MIN) return;
          const score = spread ?? LEG_PAIR_MIN + 1;          // timed and close beats untimed
          if (!best || score < best.score) best = { chosen, score };
          return;
        }
        for (const d of per[i]) if (!chosen.includes(d)) pick(i + 1, [...chosen, d]);
      };
      pick(0, []);
      if (!best) break;
      const parts = best.chosen.map(asPart);
      const u = combine(parts);
      const fill = { ...fillOf(u), minute: u.minute ?? null, ...(best.chosen.some(d => d.fill.provisional) ? { provisional: true } : {}),
        parts: parts.map(p => ({ orderId: p.orderId, leg: { right: p.legs[0].right, strike: p.legs[0].strike, expiry: p.legs[0].expiry },
          side: p.legs[0].side, qty: p.legs[0].qty, rawPrice: p.legs[0].rawPrice, price: p.legs[0].price, tradeIds: p.tradeIds })) };
      const d = { id: `d-${u.orderId}`, kind: 'fill', state: 'DRAFT', created: best.chosen.map(x => x.created).sort()[0], source: 'unjournaled',
        fill, note: null, checks: [], paired: { rowId: r.id, label: rowLabel(r) } };
      // Where its first leg stood, so the pair reads before a leg left over from the same spread.
      const at = Math.min(...best.chosen.map(x => list.indexOf(x)));
      list = list.filter(x => !best.chosen.includes(x));
      list.splice(Math.min(at, list.length), 0, d); made.push(d);
    }
  }
  return { drafts: list, made };
}
// The split's reference prices, one per leg of the row in its order: the legs sold TOGETHER that day
// when there were (one moment, one market), else each leg's same-day fill nearest in time, this
// fill's own price for its own leg. Missing a leg → no ref, and confirming says why.
export function legOutOf(d, drafts = [], rows = []) {
  const t = legTargets(d?.fill, rows);
  if (t.length !== 1) return t.length > 1 ? { ambiguous: t.map(x => ({ rowId: x.rowId, label: x.label })) } : null;
  const tg = t[0], r = rows.find(x => x.id === tg.rowId), L = legsOf(r);
  const px = (v) => (v == null ? null : +v);
  const pair = (drafts || []).find(x => x.paired?.rowId === r.id && x.fill?.date === d.fill.date && Array.isArray(x.fill.parts));
  let prices, from;
  if (pair) {
    prices = L.map(leg => px(pair.fill.parts.find(p => sameContract(p.leg, leg))?.rawPrice));
    from = `the legs sold together (IBKR orders ${pair.fill.parts.map(p => p.orderId).join(' + ')})`;
  } else {
    const same = (drafts || []).filter(x => x.fill?.type === 'OPT' && x.fill.legs?.length === 1 && x.fill.date === d.fill.date && sameRoot(x.fill.root, underlyingOf(r)));
    prices = L.map((leg, i) => {
      if (i === tg.leg) return px(d.fill.rawPrice ?? d.fill.price);
      const c = same.filter(x => sameContract(x.fill.legs[0], leg))
        .sort((a, b) => Math.abs((a.fill.minute ?? 0) - (d.fill.minute ?? 0)) - Math.abs((b.fill.minute ?? 0) - (d.fill.minute ?? 0)))[0];
      return px(c?.fill.rawPrice ?? c?.fill.price);
    });
    from = 'same-day fills on each leg';
  }
  const missing = L.filter((_, i) => !(prices[i] > 0)).map(leg => `${+leg.strike}${leg.right}`);
  return { rowId: r.id, label: tg.label, leg: tg.leg, right: tg.right, units: tg.units, legQty: tg.legQty,
           ref: missing.length ? null : { prices, from }, ...(missing.length ? { missing } : {}) };
}

// ── AN AMEND, BY INSTRUMENT ──────────────────────────────────────────────────
// Resolved when the note arrives — an amend needs no fill — against the console's OPEN trades.
// One match drafts a rule change on that trade; none lists the note as without a fill; two or more
// are ambiguous and nothing is drafted. Nothing applies until Stu confirms it on the console.
export const rowLabel = (r) => isDerivativeRow(r) ? `${underlyingOf(r)} ${legLabel(legsOf(r))}` : String(r.symbol || r.id);
export const instrumentLabel = (ins) => !ins ? '?' : ins.legs?.length
  ? `${ins.symbol} ${ins.legs.map(l => `${l.expiry} ${l.strike}${l.right}`).join(' / ')}` : `${ins.symbol}${ins.expiry ? ` ${ins.expiry}` : ''}`;
export function amendTargets(note, rows = []) {
  const ins = note?.instrument;
  if (!ins) return [];
  const open = (r) => derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side }).status === 'open';
  const sym = ins.symbol.toUpperCase();
  const base = sym.split('.')[0];
  // Numeric roots compare without leading zeros, as the IBKR sync does (lib/flex.js matchKey): a
  // note naming SMIC as IBKR does, "981", is the console's 0981.HK; "8" is 0008.HK.
  const norm = (x) => { const [root, ...rest] = String(x || '').toUpperCase().split('.'); return [matchKey(root), ...rest].join('.'); };
  const symOk = (r) => {
    const rs = String(r.symbol || '').toUpperCase();
    // "BRNT" matches the LSE line BRNT.L; "BRNT.L" must match exactly.
    return sym.includes('.') ? norm(rs) === norm(sym) : matchKey(rs.split('.')[0]) === matchKey(base);
  };
  const legKey = (l) => `${l.right}|${+l.strike}|${l.expiry}`;
  return rows.filter(r => {
    if (!open(r)) return false;
    const kind = instrumentOf(r);
    if (ins.type === 'STK') return kind === 'shares' && symOk(r);
    if (ins.type === 'FUT') return kind === 'future' && rootOf({ symbol: r.symbol, assetCategory: 'FUT' }) === base;
    if (kind !== 'option' && kind !== 'spread') return false;
    if (String(underlyingOf(r)).toUpperCase() !== base) return false;
    const have = legsOf(r).map(legKey).sort().join(','), want = ins.legs.map(legKey).sort().join(',');
    return have === want;
  });
}
export function resolveAmend(note, rows = [], { now = new Date().toISOString() } = {}) {
  const base = { state: 'DRAFT', created: now, note: noteOfDraft(note) };
  if (note.supersedes) {
    const r = rows.find(x => x.id === note.supersedes);
    return { outcome: 'amend-drafted', item: { ...base, id: `m-${note.id}`, kind: 'amend', supersedes: note.supersedes, target: r ? { id: r.id, label: rowLabel(r) } : null } };
  }
  const hits = amendTargets(note, rows);
  if (hits.length === 1) {
    return { outcome: 'amend-drafted', item: { ...base, id: `m-${note.id}`, kind: 'amend', supersedes: hits[0].id, target: { id: hits[0].id, label: rowLabel(hits[0]) } } };
  }
  if (!hits.length) {
    return { outcome: 'no-target', item: { ...base, id: `n-${note.id}`, kind: 'unfilled', reason: `amend: no open trade for ${instrumentLabel(note.instrument)}` } };
  }
  return { outcome: 'ambiguous', item: { ...base, id: `a-${note.id}`, kind: 'ambiguous', candidates: hits.map(r => ({ row: { id: r.id, label: rowLabel(r) } })) } };
}

// An amend that found no trade when it arrived is tried again on each daily run: the trade may have
// been opened since, or the matcher learned a name it did not know (981 for 0981.HK, 5 Oct). A draft
// that now resolves is replaced; one that still does not is left exactly as it was.
export function retryAmends(drafts = [], rows = [], { now = new Date().toISOString() } = {}) {
  let changed = 0;
  const next = (drafts || []).map(d => {
    if (d?.kind !== 'unfilled' || d.note?.kind !== 'amend' || !d.note?.instrument) return d;
    const { item } = resolveAmend(d.note, rows, { now });
    if (item.kind === 'unfilled') return d;
    changed++;
    return item;
  });
  return { drafts: next, changed };
}

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
// `provisional` marks every fill drafted here as coming from the SAME-DAY report (a Trade
// Confirmation query, api/flex-sync.js ?tc=1): confirmed, it is written provisional until the next
// statement adopts it (lib/sameDayFills.js). `skipUnjournaled` keeps an order out of the unjournaled
// drafts without marking it seen — the same-day path's extra day-trade rules. `fate` says what
// happened to each order, for the console's one-line answer.
// A CLOSE FOR LEGS ALREADY CLOSED (SLV, 16 Oct). A straddle legged out over days: the puts were
// sold into the CPI break and taken off the row then, and the close note written after the last
// leg still named the whole straddle. IBKR's order had the one call leg, so the note waited for a
// two-leg order that would never come, and held that call back from being offered on its own. A
// close or trim note now matches on the legs the book still holds open on that name; the legs
// already gone are said on the draft. The note's price was for every leg it named, so it is not
// compared, and the draft is never an exact match: it is confirmed by hand. With no open row on
// the name, or every leg still open, the note is matched as written.
export function closeView(note, rows = []) {
  const ins = note?.instrument;
  if (!(note?.kind === 'close' || note?.kind === 'trim') || !ins || (ins.legs || []).length < 2 || !rows?.length) return note;
  const open = [];
  for (const r of rows) {
    if (!isDerivativeRow(r) || !sameRoot(underlyingOf(r), ins.symbol)) continue;
    const pos = derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side });
    if (pos.status === 'closed' || !(pos.qty > 0)) continue;
    open.push(...legsOf(r));
  }
  if (!open.length) return note;
  const keep = ins.legs.filter(l => open.some(o => sameContract(o, l)));
  if (!keep.length || keep.length === ins.legs.length) return note;
  const { price: _price, tolerance_pct: _tol, ...expected } = note.expected || {};
  return { ...note, instrument: { ...ins, legs: keep }, expected, closedEarlier: ins.legs.filter(l => !keep.includes(l)) };
}
const legsText = (L) => L.map(l => `${l.ratio > 1 ? l.ratio + '×' : ''}${l.strike}${l.right} ${l.expiry}`).join(' / ');

export function processInbox({ notes = [], trades = [], known = new Set(), seen = {}, drafts = [], today, holidays = [], from = INBOX_FROM, now = new Date().toISOString(), provisional = false, skipUnjournaled = null, rows = [] } = {}) {
  const units = orderUnits(trades).filter(u => u.date && u.date >= addDays(from, -3));
  const seenNext = { ...(seen || {}) };
  const byId = new Map((drafts || []).map(d => [d.id, d]));
  const leaving = [];          // { note, outcome }
  const counts = { drafted: 0, ambiguous: 0, unfilled: 0, amends: 0, unjournaled: 0, pending: 0 };
  const symbols = { drafted: [], ambiguous: [], unfilled: [], unjournaled: [] };
  const why = {};               // noteId → { at, reason } for every note still waiting
  const fate = {};              // orderId → matched | ambiguous | unjournaled | seen | known | dayTrade | excluded | other
  const fill = (u) => (provisional ? { ...fillOf(u), provisional: true } : fillOf(u));
  // An order another note already claimed is not a candidate for this one.
  // An assembled spread is claimed if any of its legs is; claiming one claims every leg.
  const ids = (u) => u.parts || [u.orderId];
  const claimed = (u) => ids(u).some(id => seenNext[id]?.note);
  const claim = (u, noteId, how = 'matched') => { for (const id of ids(u)) { seenNext[id] = { date: u.date, note: noteId }; byId.delete(`d-${id}`); fate[id] = how; } };

  for (const note of notes) {
    if (note.kind === 'amend') {
      byId.set(`m-${note.id}`, { id: `m-${note.id}`, kind: 'amend', state: 'DRAFT', created: now, supersedes: note.supersedes, note: noteOfDraft(note) });
      leaving.push({ note, outcome: 'amend-drafted' }); counts.amends++;
      continue;
    }
    const view = closeView(note, rows);
    const earlier = view.closedEarlier ? [{ field: 'legs', ok: true, soft: true, note: note.instrument.legs.length, ibkr: view.instrument.legs.length, closedEarlier: legsText(view.closedEarlier) }] : [];
    const hits = [];
    for (const u of [...units, ...assembledSpreads(view, units)]) {
      if (claimed(u)) continue;
      const m = matchNote(view, u, { holidays });
      if (m) hits.push({ u, m: earlier.length ? { ...m, checks: [...m.checks, ...earlier] } : m });
    }
    const sym = note.instrument?.symbol;
    if (hits.length === 1) {
      const { u, m } = hits[0];
      const id = `d-${u.orderId}`;
      claim(u, note.id);   // first, so a leg already offered as unjournaled is withdrawn
      // A LEG ALREADY ON THE CONSOLE (WFC, 12 Oct): a spread legged in reached the report one leg at a
      // time, the first leg was confirmed on its own, and the assembled spread then carried it again.
      // The draft still exists — the note did describe these orders — but it says so, it is never an
      // exact match, and applyDraft refuses to record the leg a second time.
      const onConsole = u.assembled ? ids(u).filter(x => known.has(String(x))) : [];
      const checks = onConsole.length ? [...m.checks, { field: 'recorded', ok: false, note: 'separate', ibkr: onConsole.join('+') }] : m.checks;
      byId.set(id, { id, kind: 'fill', state: 'DRAFT', created: now, source: 'note', fill: fill(u), note: noteOfDraft(note), checks,
        ...(onConsole.length ? { recordedParts: onConsole } : {}) });
      leaving.push({ note, outcome: 'drafted' }); counts.drafted++; symbols.drafted.push(sym);
    } else if (hits.length > 1) {
      const id = `a-${note.id}`;
      byId.set(id, { id, kind: 'ambiguous', state: 'DRAFT', created: now, note: noteOfDraft(note),
        candidates: hits.map(({ u, m }) => ({ fill: fill(u), checks: m.checks })) });
      for (const { u } of hits) claim(u, note.id, 'ambiguous');
      leaving.push({ note, outcome: 'ambiguous' }); counts.ambiguous++; symbols.ambiguous.push(sym);
    } else {
      const waited = tradingDaysBetween(note.trade_date, today, holidays);
      if (waited != null && waited >= WAIT_TRADING_DAYS) {
        const id = `n-${note.id}`;
        byId.set(id, { id, kind: 'unfilled', state: 'DRAFT', created: now, note: noteOfDraft(note), waited });
        leaving.push({ note, outcome: 'no-fill' }); counts.unfilled++; symbols.unfilled.push(sym);
      } else {
        counts.pending++;
        const reason = explainWaiting(view, units, { holidays, claimedBy: (u) => ids(u).map(id => seenNext[id]?.note).find(Boolean) || null });
        // ALREADY HELD (SPY, 9 Oct). A plan or open note for an instrument an open console trade already
        // holds is usually that trade's updated plan, sent as the wrong kind: it waits for a fill that
        // never comes. Said, with the trade named, so the console can offer to treat it as a rule change.
        const held = (note.kind === 'plan' || note.kind === 'open') ? amendTargets(note, rows) : [];
        why[note.id] = held.length
          ? { at: now, held: held.map(r => ({ id: r.id, label: rowLabel(r) })),
              reason: `you already hold this — ${held.map(r => `${rowLabel(r)} (${r.id})`).join(', ')}. If this note updates that trade, treat it as a rule change; if it is a new trade, it waits for its fill. (${reason})` }
          : { at: now, reason };
      }
    }
  }

  // UNJOURNALED: an order no note claimed, that the console did not already have by hand, from the
  // day the inbox went live, and not offered before — and NOT A DAY TRADE. Day trades stay out of
  // the console by decision (the console is the swing and position book); offering each 0DTE
  // scalp as a draft asked for that decision again, fill by fill. A draft from before this rule
  // that is now a day trade is withdrawn.
  const day = dayTradeOrders(units);
  for (const [id, d] of byId) if (d.source === 'unjournaled' && day.has(d.fill?.orderId)) byId.delete(id);
  // A LEG OF A SPREAD STILL BEING LEGGED IN is not an unjournaled fill. A single-leg option order
  // whose contract and side are one leg of a spread note still waiting, in the same name and inside
  // that note's dates, is held back — and a draft offered for it earlier is withdrawn — until the
  // other leg arrives and the note takes both, or the note leaves without them.
  const leaving_ = new Set(leaving.map(l => l.note.id));
  const spreadNotes = notes.filter(n => n.kind !== 'amend' && !leaving_.has(n.id)).map(n => closeView(n, rows)).filter(n => (n.instrument?.legs?.length || 0) >= 2);
  const legOfWaitingSpread = (u) => u.type === 'OPT' && u.legs.length === 1 && spreadNotes.some(n => {
    if (!sameRoot(u.root, n.instrument.symbol)) return false;
    const gap = sessionGap(n.trade_date, u.date, holidays);
    if (gap == null || gap < -DATE_WINDOW || gap > (n.kind === 'plan' ? WAIT_TRADING_DAYS : DATE_WINDOW)) return false;
    const l = u.legs[0];
    return n.instrument.legs.some(nl => nl.right === l.right && Math.abs(nl.strike - l.strike) < 1e-6 && nl.expiry === l.expiry && nl.side === l.side);
  });
  for (const u of units) {
    if (u.date < from) continue;
    if (seenNext[u.orderId]?.note) { fate[u.orderId] = fate[u.orderId] || 'seen'; continue; }
    // Already on a console row — by its qualified id, or by the bare order id an option fill carries.
    if (known.has(String(u.orderId)) || u.tradeIds.some(t => known.has(String(t)))) { fate[u.orderId] = 'known'; continue; }
    if (legOfWaitingSpread(u)) {
      if (byId.get(`d-${u.orderId}`)?.source === 'unjournaled') byId.delete(`d-${u.orderId}`);
      delete seenNext[u.orderId];
      fate[u.orderId] = 'awaitingPair'; continue;
    }
    if (seenNext[u.orderId]) { fate[u.orderId] = fate[u.orderId] || 'seen'; continue; }
    if (u.type === 'OTHER') { fate[u.orderId] = 'other'; continue; }
    if (day.has(u.orderId)) { counts.dayTrades = (counts.dayTrades || 0) + 1; fate[u.orderId] = 'dayTrade'; continue; }
    if (skipUnjournaled && skipUnjournaled(u)) { fate[u.orderId] = 'excluded'; continue; }
    const id = `d-${u.orderId}`;
    fate[u.orderId] = 'unjournaled';
    byId.set(id, { id, kind: 'fill', state: 'DRAFT', created: now, source: 'unjournaled', fill: fill(u), note: null, checks: [] });
    seenNext[u.orderId] = { date: u.date, note: null };
    counts.unjournaled++; symbols.unjournaled.push(u.root);
  }

  // LEGGED OUT OF AN OPEN SPREAD (legTargets above). Drafts written before fills carried their minute
  // get it from today's units; then legs that make whole units of one open row become one draft, and
  // a leg left over is marked with the row it splits and the prices to split it at.
  const unitById = new Map(units.map(u => [u.orderId, u]));
  for (const [id, d] of byId) {
    if (d.source === 'unjournaled' && d.fill && d.fill.minute == null && unitById.get(d.fill.orderId)?.minute != null) byId.set(id, { ...d, fill: { ...d.fill, minute: unitById.get(d.fill.orderId).minute } });
  }
  if ((rows || []).length) {
    const lo = pairLegOuts([...byId.values()], rows);
    if (lo.made.length) {
      byId.clear(); for (const d of lo.drafts) byId.set(d.id, d);
      for (const d of lo.made) for (const p of d.fill.parts) { fate[p.orderId] = 'paired'; seenNext[p.orderId] = { date: d.fill.date, note: null }; }
      counts.paired = (counts.paired || 0) + lo.made.length;
    }
    const all = [...byId.values()];
    for (const [id, d] of byId) {
      if (d.source !== 'unjournaled' || d.fill?.type !== 'OPT' || d.legOut?.ref) continue;
      const lo2 = legOutOf(d, all, rows);
      if (lo2) byId.set(id, { ...d, legOut: lo2 });
    }
  }

  // Seen entries outlive the statement window, then go.
  const cutoff = addDays(today, -SEEN_KEEP_DAYS);
  for (const [k, v] of Object.entries(seenNext)) if (!v?.date || v.date < cutoff) delete seenNext[k];

  const next = [...byId.values()].sort((a, b) => String(a.created).localeCompare(String(b.created))).slice(-MAX_DRAFTS);
  return { drafts: next, leaving, seen: seenNext, counts, symbols, why, fate, units: units.map(u => ({ orderId: u.orderId, type: u.type, root: u.root, date: u.date })) };
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
    toConfirm: d.filter(x => (x.kind === 'fill' && x.note) || (x.kind === 'ambiguous' && !x.candidates?.[0]?.row)).length,
    // Rule changes on existing trades — an amend, or an amend that named more than one trade.
    ruleChanges: d.filter(x => x.kind === 'amend' || (x.kind === 'ambiguous' && !!x.candidates?.[0]?.row)).length,
    unjournaled: d.filter(x => x.kind === 'fill' && !x.note).length,
    withoutFills: d.filter(x => x.kind === 'unfilled').length,
  };
}

// The comparison line on the card: "note expected 2 @ 4.40, IBKR bought 2 @ 4.40 ✓".
// Two decimals for an ordinary premium; significant figures for a tiny one (a yen FOP quotes
// 0.00004, which two decimals printed as 0.00).
export const fmtPx = (v) => (v == null || !Number.isFinite(+v) ? '?' : Math.abs(+v) >= 0.1 || +v === 0 ? (+v).toFixed(2) : String(+(+v).toPrecision(3)));
const px = fmtPx;
export function expectationText(draft) {
  const f = draft?.fill, e = draft?.note?.expected;
  if (!f) return null;
  // Which way it went, said: a closing sale and an opening buy read alike as "filled 4 @ 0.25".
  const verb = f.side === 'SELL' ? 'sold' : f.side === 'BUY' ? 'bought' : 'filled';
  const filled = `IBKR ${verb} ${f.qty} @ ${px(f.rawPrice)}`;
  const lg = draft.checks?.find(c => c.field === 'legs' && c.closedEarlier);
  if (lg) {
    const qn = draft.checks?.find(c => c.field === 'qty');
    return { text: `${filled} — the note named ${lg.note} legs; ${lg.closedEarlier} ${lg.note - lg.ibkr === 1 ? 'was' : 'were'} already closed on the book, so this closes the rest${e?.price != null ? ` (the note's price was for all ${lg.note} legs, not compared)` : ''}${qn && !qn.ok ? ` — note said ${e.qty}` : ''}`, ok: !qn || qn.ok };
  }
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
    const next = rows.slice(); next[i] = amendRow(rows[i], n, today);
    return { rows: next, rowId: rows[i].id, how: 'amended' };
  }
  if (draft.kind !== 'fill' || !draft.fill) return { error: 'only a fill or an amend can be confirmed' };
  const f = draft.fill;
  // A SPREAD ASSEMBLED FROM SEPARATE ORDERS, one of which is already on the console as its own trade:
  // confirming would record that leg twice. Refused, naming the row — removing it (it is this
  // spread's leg) and confirming again records the spread once.
  const parts = String(f.orderId).split('+');
  if (parts.length > 1) {
    const dup = rows.find(r => (r.fills || []).some(x => x.tradeId && parts.includes(String(x.tradeId).split(':')[0])));
    if (dup) return { error: `one leg of this spread (IBKR order ${parts.find(p => (dup.fills || []).some(x => String(x.tradeId || '').split(':')[0] === p))}) is already on the console as ${dup.id} — confirming would record it twice. Delete ${dup.id} (it is this spread's leg), then confirm.` };
  }

  // Already on a row: the planner recorded the statement's share fills this morning.
  const ids = new Set((f.tradeIds || []).map(String));
  const holder = rows.findIndex(r => (r.fills || []).some(x => x.tradeId && (ids.has(String(x.tradeId)) || String(x.tradeId) === String(f.orderId))));
  if (holder >= 0) {
    const next = rows.slice(); next[holder] = annotate(rows[holder]);
    return { rows: next, rowId: rows[holder].id, how: 'annotated' };
  }

  const isOpt = f.type === 'OPT' || f.type === 'COMBO';
  const fillSide = f.side === 'SELL' ? 'sell' : 'buy';
  // FROM THE SAME-DAY REPORT: provisional until the next statement adopts it by IBKR's order id
  // (lib/sameDayFills.js adoptProvisional), which also corrects it if the statement differs.
  const prov = f.provisional ? { provisional: { since: f.date } } : {};
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
    const fill = { id: `jr${String(f.orderId).slice(-8)}`, side: fillSide, qty: f.qty, price: f.price, date: f.date, note, tradeId: String(f.orderId).slice(0, 24), ...prov };
    if (i >= 0) {
      const next = rows.slice();
      const j = handEntered(rows[i], { side: fillSide, qty: f.qty, date: f.date, prices: [f.rawPrice, f.price] });
      if (j >= 0) {
        // Already typed in by hand: stamp IBKR's id on that fill and add nothing.
        const fills = rows[i].fills.map((x, k) => k === j ? { ...x, tradeId: fill.tradeId, ...prov } : x);
        next[i] = annotate({ ...rows[i], fills });
        return { rows: next, rowId: rows[i].id, how: 'adopted' };
      }
      next[i] = annotate({ ...rows[i], fills: [...(rows[i].fills || []), fill] });
      return { rows: next, rowId: rows[i].id, how: 'added' };
    }
    // NO ROW HOLDS THESE LEGS AS A SET (14 Oct): a pair sold together onto rows already split leg by
    // leg, or one leg of an open spread sold on its own — which splits that spread.
    const lo = legOutApply(rows, draft, { fill, today });
    if (lo) return lo;
    const made = optionRow({ underlying: f.root, legs, side: debit ? 'long' : 'short', currency: f.currency || 'USD', multiplier: f.multiplier,
      hardDate: clampHardDate(n.levels?.hard_date, legs), id: `${f.root}-j${String(f.orderId).slice(-6)}` });
    if (made.error) return { error: made.error };
    const row = annotate({ ...made.row, fills: [fill], tags: ['journal'] });
    return { rows: [...rows, row], rowId: row.id, how: 'created' };
  }

  // Shares and futures the planner did not record (before the watermark, or a batch it discarded).
  const fills = (f.trades && f.trades.length ? f.trades : [{ tradeId: f.tradeIds?.[0], side: fillSide, qty: f.qty, price: f.price, date: f.date }])
    .map((t, j) => ({ id: `jr${String(t.tradeId || f.orderId).slice(-7)}${j}`, side: t.side === 'sell' ? 'sell' : 'buy', qty: t.qty, price: t.price, date: t.date || f.date, note, tradeId: t.tradeId ? String(t.tradeId).slice(0, 24) : null, ...prov }));
  const i = rows.findIndex(r => !isDerivativeRow(r) && String(r.symbol).split('.')[0].toUpperCase() === f.root && (r.currency || 'USD') === (f.currency || 'USD') && open(r));
  if (i >= 0) {
    const next = rows.slice();
    const j = handEntered(rows[i], { side: fillSide, qty: f.qty, date: f.date, prices: [f.rawPrice, f.price] });
    if (j >= 0) {
      const stamped = rows[i].fills.map((x, k) => k === j ? { ...x, tradeId: fills[0].tradeId || String(f.orderId).slice(0, 24), ...prov } : x);
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

// ── LEGGING OUT, ON THE CONSOLE'S ROWS (14 Oct) ─────────────────────────────
// Returns { rows, rowId, how, message } or { error }, or null when neither case applies.
//
// SPLIT. One leg of an open multi-leg row sold on its own leaves a position the row cannot hold — a
// straddle with its puts gone is a row of calls. So every unit still held moves out of the row into
// one single-leg row per leg, and the sale is then recorded on its leg's row. The move is a TRANSFER,
// not a trade: one entry closing the spread row AT ITS OWN AVERAGE COST (so it books no profit or
// loss — what the spread already realised stays where it was) and one opening each leg row, every one
// marked `transfer: true` with no IBKR id. The cost is divided in proportion to the legs' same-day
// prices (legOutOf), scaled so the legs' net is exactly the spread's cost: P&L in total is unchanged
// by the split; only which leg it is booked on is a convention, and the entries say which.
const fmtN = (v) => String(+(+v).toFixed(4));
export function legOutApply(rows, draft, { fill, today }) {
  const f = draft.fill;
  // A pair sold together, onto rows already split leg by leg.
  if (f.type === 'COMBO' && Array.isArray(f.parts) && f.parts.length === (f.legs || []).length) {
    const openLeg = (p) => rows.findIndex(r => isDerivativeRow(r) && legsOf(r).length === 1 && sameRoot(f.root, underlyingOf(r)) && sameContract(legsOf(r)[0], p.leg)
      && derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side }).status !== 'closed');
    const at = f.parts.map(openLeg);
    if (at.every(i => i >= 0) && new Set(at).size === at.length) {
      const next = rows.slice();
      f.parts.forEach((p, k) => {
        const r = next[at[k]];
        const fl = { id: `jr${String(p.orderId).slice(-7)}${k}`, side: p.side === 'SELL' ? 'sell' : 'buy', qty: p.qty, price: p.price ?? p.rawPrice, date: f.date,
          note: `IBKR order ${p.orderId} (sold with ${f.parts.filter(x => x !== p).map(x => x.orderId).join(', ')}), commission included`,
          tradeId: String(p.orderId).slice(0, 24), ...(f.provisional ? { provisional: { since: f.date } } : {}) };
        next[at[k]] = { ...r, fills: [...(r.fills || []), fl] };
      });
      return { rows: next, rowId: next[at[0]].id, how: 'added', message: `Fills added to ${at.map(i => next[i].id).join(' and ')} ✓` };
    }
    return null;
  }
  if (f.type !== 'OPT') return null;
  const t = legTargets(f, rows);
  if (!t.length) return null;
  if (t.length > 1) return { error: `this leg belongs to ${t.length} open trades (${t.map(x => x.rowId).join(', ')}) — nothing was split` };
  const tg = t[0], ri = rows.findIndex(r => r.id === tg.rowId), R = rows[ri], L = legsOf(R);
  if (f.qty > tg.legQty + 1e-9) return { error: `sells ${f.qty} of a leg ${R.id} holds ${tg.legQty} of — nothing was split` };
  const ref = draft.legOut?.rowId === R.id ? draft.legOut.ref : null;
  if (!ref) return { error: `can't split ${R.id} yet: it needs a same-day price for every leg to divide its cost${draft.legOut?.missing ? ` (none for ${draft.legOut.missing.join(', ')})` : ''}. Confirm the order that sold the legs together first, or sync again.` };
  const pos = derivePosition(R.fills || [], { multiplier: R.multiplier, side: R.side });
  const U = pos.qty, B = pos.avgCost;
  const net = L.reduce((a, leg, i) => a + legSgn(leg.side) * leg.ratio * ref.prices[i], 0);
  if (!(net > 0) || !(B > 0)) return { error: `can't divide ${R.id}'s cost by these prices — nothing was split` };
  const k = B / net;
  const basis = L.map((_, i) => +(ref.prices[i] * k).toFixed(6));
  const date = f.date || today;
  const rowSign = R.side === 'short' ? -1 : 1;
  const taken = new Set(rows.map(r => r.id));
  const legId = (leg) => { let id = `${R.id}-${fmtN(leg.strike)}${leg.right}`; for (let n = 2; taken.has(id); n++) id = `${R.id}-${fmtN(leg.strike)}${leg.right}${n}`; taken.add(id); return id; };
  const split = `split from ${R.id} on ${date} when one leg was sold on its own — ${U} unit${U === 1 ? '' : 's'} at its average ${fmtN(B)}, divided by ${ref.from} (${L.map((leg, i) => `${fmtN(leg.strike)}${leg.right} ${fmtN(ref.prices[i])}`).join(' / ')})`;
  const legRows = L.map((leg, i) => {
    const held = rowSign * legSgn(leg.side) > 0 ? 'long' : 'short';
    const { id: _id, legs: _l, fills: _f, levels: _lv, derived: _d, instrument: _in, ...rest } = R;
    return { ...rest, id: legId(leg), splitFrom: R.id, instrument: 'option', legs: [{ right: leg.right, strike: leg.strike, expiry: leg.expiry, side: 'long', ratio: 1 }],
      side: held, levels: [], tags: [...new Set([...(R.tags || []), 'split'])],
      thesis: `${String(R.thesis || '').trim()}\n— ${date}: ${split}.`.trim().slice(0, 600),
      fills: [{ id: `tx${i}${String(f.orderId).slice(-5)}`, side: held === 'long' ? 'buy' : 'sell', qty: U * leg.ratio, price: basis[i], date, transfer: true,
        note: `transfer in: ${split} — ${fmtN(leg.strike)}${leg.right} at ${fmtN(basis[i])}, no profit or loss` }] };
  });
  const out = { id: `tx${String(f.orderId).slice(-6)}`, side: rowSign > 0 ? 'sell' : 'buy', qty: U, price: B, date, transfer: true,
    note: `transfer out: ${U} unit${U === 1 ? '' : 's'} moved to ${legRows.map(r => r.id).join(' and ')} at the average cost — no profit or loss` };
  const next = rows.slice();
  next[ri] = { ...R, fills: [...(R.fills || []), out] };
  const j = tg.leg;
  legRows[j] = { ...legRows[j], fills: [...legRows[j].fills, fill] };
  next.push(...legRows);
  return { rows: next, rowId: legRows[j].id, how: 'split', split: { from: R.id, into: legRows.map(r => r.id) },
           message: `Split ${R.id} into ${legRows.map(r => r.id).join(' and ')}; the sale is on ${legRows[j].id} ✓` };
}

// A FILL ALREADY TYPED IN BY HAND. The trade was placed, then entered on the console, then the
// statement arrived: without this, confirming the draft would record the same fill twice. Same side,
// same quantity, dated within three days (a weekend, and Dubai against New York), at a price within
// 2% of IBKR's (a hand entry is usually the headline print, without the commission). No trade id,
// since a fill that already carries one came from a statement, and never a split's transfer entry.
// Returns its index or -1.
function handEntered(row, { side, qty, date, prices = [] }) {
  const days = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
  return (row.fills || []).findIndex(x => !x.tradeId && !x.transfer && x.side === side && Math.abs(Number(x.qty) - qty) < 1e-9
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

// A RULE CHANGE. Levels merge key by key — a key sent as null removes that level — and a rules
// list, when the note gives one, REPLACES the trade's. The rationale is appended, dated, so the
// thesis keeps its history; the tag is set when the note names one.
export function amendRow(r, n, today = new Date().toISOString().slice(0, 10)) {
  const out = { ...r };
  if (n.tag && ['hedge', 'position', 'swing', 'intraday'].includes(n.tag)) out.tag = n.tag;
  const why = String(n.rationale || '').trim();
  if (why) {
    const prior = String(r.thesis || '').trim();
    out.thesis = (!prior || /^(Opened|Added) from the IBKR statement/.test(prior) ? why : `${prior}\n— ${n.trade_date || today} (amend): ${why}`).slice(0, 600);
  }
  const old = r.journal || {};
  const levels = { ...(old.levels || {}) };
  for (const [k, v] of Object.entries(n.levels || {})) { if (v == null) delete levels[k]; else levels[k] = String(v).slice(0, 200); }
  const rules = n.rulesGiven ? (n.rules || []).slice(0, 8).map(x => String(x).slice(0, 300)) : (old.rules || []);
  out.journal = { noteId: n.id || old.noteId || null, kind: 'amend', at: today, levels, rules };
  if (isDerivativeRow(r) && n.levels?.hard_date) { const hd = clampHardDate(n.levels.hard_date, legsOf(r)); if (hd) out.hardDate = hd; }
  return out;
}

// Promote one candidate of an ambiguous draft to an ordinary draft — Stu's choice, never inferred.
export function chooseCandidate(draft, orderId) {
  if (draft?.kind !== 'ambiguous') return null;
  // An ambiguous AMEND lists console trades; choosing one drafts the rule change on it.
  const byRow = (draft.candidates || []).find(x => x.row?.id === orderId);
  if (byRow) return { id: `m-${draft.note?.id}`, kind: 'amend', state: 'DRAFT', created: draft.created, supersedes: byRow.row.id, target: byRow.row, note: draft.note };
  const c = (draft.candidates || []).find(x => x.fill?.orderId === orderId);
  if (!c) return null;
  return { id: `d-${orderId}`, kind: 'fill', state: 'DRAFT', created: draft.created, source: 'note', fill: c.fill, note: draft.note, checks: c.checks };
}


// ── CONFIRM ALL EXACT MATCHES ────────────────────────────────────────────────
// One click for the drafts that need no judgement: a fill with a note, from ONE IBKR order, whose
// every check passed exactly — legs, ratio and side (a draft only exists once those match), the
// quantity to the unit (never a plan or trim, whose quantity is approximate by design), the price
// inside the note's tolerance, and filled on the note's own date. Everything else — ambiguous
// drafts, unjournaled fills, notes without fills, rule changes, a spread assembled from separate
// orders, any ✗ or ⚠ — stays one by one. Returns { ok, why } so the panel can say what was left.
export function exactMatch(d) {
  if (!d || d.kind !== 'fill' || !d.fill || !d.note || d.source !== 'note') return { ok: false, why: 'not a fill with a note' };
  if (d.note.kind === 'amend') return { ok: false, why: 'a rule change' };
  if (ANY_QTY.has(d.note.kind)) return { ok: false, why: `a ${d.note.kind} — its quantity is approximate` };
  if (String(d.fill.orderId).includes('+')) return { ok: false, why: 'assembled from separate orders' };
  if (d.fill.statementMissing || d.fill.statementDiffers) return { ok: false, why: 'the statement disagrees with the same-day report' };
  const checks = d.checks || [];
  const q = checks.find(c => c.field === 'qty'), p = checks.find(c => c.field === 'price');
  if (!q || !q.ok) return { ok: false, why: 'quantity not checked exactly' };
  if (!p || !p.ok) return { ok: false, why: 'price not checked against the note' };
  if (checks.some(c => !c.ok || c.soft)) return { ok: false, why: 'a check is not exact' };
  const exp = expectationText(d);
  if (!exp?.ok) return { ok: false, why: 'the expectation line is not ✓' };
  return { ok: true, why: null };
}
export const bulkCandidates = (drafts = []) => (Array.isArray(drafts) ? drafts : []).filter(d => exactMatch(d).ok);

// "FCX Nov 75/85C ×8 @ 2.70" — what the confirmation list names each trade by.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function bulkLabel(d) {
  const f = d?.fill;
  if (!f) return '?';
  const qp = `×${f.qty} @ ${fmtPx(f.rawPrice ?? f.price)}`;
  if ((f.type === 'OPT' || f.type === 'COMBO') && f.legs?.length) {
    const exps = [...new Set(f.legs.map(l => l.expiry))];
    const when = exps.map(e => MON[+e.slice(5, 7) - 1] || e).join('/');
    const rights = [...new Set(f.legs.map(l => l.right))];
    const strikes = rights.length === 1 ? `${f.legs.map(l => +l.strike).join('/')}${rights[0]}` : f.legs.map(l => `${+l.strike}${l.right}`).join('/');
    return `${f.root} ${when} ${strikes} ${qp}`;
  }
  return `${f.root} ${f.side === 'SELL' ? 'sell' : 'buy'} ${qp}`;
}
export function bulkSummary(drafts = []) {
  const list = bulkCandidates(drafts);
  return list.length ? `${list.length} trade${list.length === 1 ? '' : 's'}: ${list.map(bulkLabel).join(', ')}` : '';
}
