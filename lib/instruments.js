// lib/instruments.js — options and multi-leg spreads in the journal (panel brief, console rework, Step 2).
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// The console recorded share fills only. On 2026-09-23 the book held SOFI 500 shares, shown as
// 3.9% of equity, and SOFI Nov20 17/20 ×15 — invisible. Real SOFI delta was ~7% of NLV. Every
// options line that went wrong this month (AVGO, INTC, IRM, QQQ) was invisible to the console in
// the same way: the exposure tile could see them through the greeks feed, the journal could not.
//
// ── THE MODEL ────────────────────────────────────────────────────────────────
// A row carries `instrument`: shares | option | spread | future. An option or a spread carries
// `legs` — one to four of { right: 'C'|'P', strike, expiry, side: 'long'|'short', ratio } on one
// underlying — and the row's `symbol` IS the underlying, so quotes, names and grouping all key off
// it. The contract is described by the legs, not by the symbol string.
//
// FILLS ARE AT THE COMBO PRICE. A vertical bought at 0.85 is one fill: qty 15, price 0.85, and the
// row's multiplier (100) turns that into money exactly as lib/positions.js already does for a
// single option. P&L = (combo mark − fill) × 100 × qty, realised on close, partial closes allowed —
// none of which needed a new engine, only a mark to feed the old one.
//
// THE MARK IS LIVE WHERE THE FEED GIVES IT, ELSE STATED. Per-leg marks and deltas come from the
// same CBOE feed the exposure tile reads (lib/cboe.js pickCboeGreeks): the combo mark is the signed
// sum of the leg marks, the net delta the signed sum of the leg deltas. When a leg is unpriced the
// row says which and what it fell back to — a typed mark, then the last fill — because a spread
// silently marked at its entry is a P&L of zero that looks like a fact.
//
// HARD EXIT DATE. Every option and spread row carries one, defaulting to expiry − 7 days and
// editable, never later than the trading day before expiry. From that morning the row flags red.
// Legacy rows (a hand-entered symbol like "QQQ Oct16'26 730C" at ×100) are read as a one-leg
// option without being rewritten, so nothing stored changes shape until it is edited.
//
// Isomorphic: lib/flexTrades.js asks it which rows the statement planner must leave alone, and
// lib/tradecard.js asks it which rows never reach Discord.
import { parseOptionSymbol, contractKey } from './bookExposure.js';
import { modelledDelta } from './blackscholes.js';
import { sideOf, dirSign } from './side.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

export const INSTRUMENTS = Object.freeze(['shares', 'option', 'spread', 'future']);
export const INSTRUMENT_LABEL = Object.freeze({ shares: 'Shares', option: 'Option', spread: 'Spread', future: 'Future' });
export const LEG_RIGHTS = Object.freeze(['C', 'P']);
export const LEG_SIDES = Object.freeze(['long', 'short']);
export const MAX_LEGS = 4;
export const OPTION_MULTIPLIER = 100;
export const HARD_DATE_DEFAULT_DAYS = 7;
// What a level on an option row watches: the combo mark (the default), or the underlying.
export const LEVEL_ON = Object.freeze(['combo', 'underlying']);

// ── WHICH KIND OF ROW ────────────────────────────────────────────────────────
export function instrumentOf(row) {
  const explicit = String(row?.instrument || '').toLowerCase();
  if (INSTRUMENTS.includes(explicit)) return explicit;
  if (row?.margined) return 'future';
  // A legacy option row: the symbol names the contract and the multiplier is the option's.
  if (parseOptionSymbol(row?.symbol)) return 'option';
  return 'shares';
}
export const isDerivativeRow = (row) => { const i = instrumentOf(row); return i === 'option' || i === 'spread'; };

// ── THE LEGS ─────────────────────────────────────────────────────────────────
const isoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
export function normalizeLeg(l) {
  if (!l || typeof l !== 'object') return null;
  const right = String(l.right || l.type || '').toUpperCase().startsWith('P') ? 'P' : String(l.right || l.type || '').toUpperCase().startsWith('C') ? 'C' : null;
  const strike = num(l.strike);
  const expiry = isoDate(l.expiry) ? String(l.expiry) : null;
  const side = l.side === 'short' ? 'short' : l.side === 'long' ? 'long' : null;
  const ratio = num(l.ratio) ?? 1;
  if (!right || !(strike > 0) || !expiry || !side || !(ratio > 0)) return null;
  return { right, strike, expiry, side, ratio: Math.round(ratio) || 1 };
}

// The legs of a row, however it was written. A legacy option symbol yields one long leg.
export function legsOf(row) {
  if (Array.isArray(row?.legs) && row.legs.length) return row.legs.map(normalizeLeg).filter(Boolean).slice(0, MAX_LEGS);
  const p = parseOptionSymbol(row?.symbol);
  if (p) return [{ right: p.type === 'put' ? 'P' : 'C', strike: p.strike, expiry: p.expiry, side: 'long', ratio: 1 }];
  return [];
}

export function underlyingOf(row) {
  const u = String(row?.underlying || '').trim().toUpperCase();
  if (u) return u;
  const p = parseOptionSymbol(row?.symbol);
  if (p) return p.root;
  return String(row?.symbol || '').trim().toUpperCase().split(/[\s|]/)[0] || null;
}

export const legContract = (root, leg) => ({ root, expiry: leg.expiry, type: leg.right === 'P' ? 'put' : 'call', strike: leg.strike });
export const legKey = (root, leg) => contractKey(legContract(root, leg));
const legSign = (leg) => (leg.side === 'short' ? -1 : 1);

// ── WORDS FOR THE CONTRACT ───────────────────────────────────────────────────
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const expiryLabel = (iso, { year = true } = {}) => {
  if (!isoDate(iso)) return String(iso || '');
  const [y, m, d] = iso.split('-');
  return `${MON[+m - 1]}${+d}${year ? `'${y.slice(2)}` : ''}`;
};
const fmtK = (k) => (Number.isInteger(k) ? String(k) : String(+k.toFixed(2)));

// "Nov20'26 17/20 C" for a vertical, "Oct16'26 730C" for a single, legs listed for anything else.
export function legLabel(legs = [], { year = true } = {}) {
  const L = (legs || []).map(normalizeLeg).filter(Boolean);
  if (!L.length) return '';
  const shape = spreadShape(L);
  if (L.length === 1) return `${expiryLabel(L[0].expiry, { year })} ${fmtK(L[0].strike)}${L[0].right}`;
  if (shape === 'vertical') {
    const sorted = [...L].sort((a, b) => a.strike - b.strike);
    return `${expiryLabel(L[0].expiry, { year })} ${sorted.map(l => fmtK(l.strike)).join('/')} ${L[0].right}`;
  }
  return L.map(l => `${l.side === 'short' ? '−' : '+'}${l.ratio > 1 ? l.ratio + '×' : ''}${expiryLabel(l.expiry, { year })} ${fmtK(l.strike)}${l.right}`).join(' ');
}

// ── THE SHAPE ────────────────────────────────────────────────────────────────
// Only the shapes whose risk is defined by construction are named; anything else is 'other' and
// gets no max-loss claim, which is better than a wrong one.
export function spreadShape(legs = []) {
  const L = (legs || []).map(normalizeLeg).filter(Boolean);
  if (L.length === 1) return 'single';
  if (L.length !== 2) return L.length ? 'other' : 'none';
  const [a, b] = L;
  const oneEach = a.side !== b.side && a.ratio === 1 && b.ratio === 1;
  if (!oneEach) return 'other';
  if (a.right === b.right && a.expiry === b.expiry && a.strike !== b.strike) return 'vertical';
  if (a.right === b.right && a.expiry !== b.expiry && a.strike === b.strike) return 'calendar';
  if (a.right === b.right && a.expiry !== b.expiry && a.strike !== b.strike) return 'diagonal';
  return 'other';
}

// ── THE MARK ─────────────────────────────────────────────────────────────────
// `greeks` is keyed by contractKey as the feed returns it. A leg's mark is the feed's theo, else
// the bid/ask midpoint, else its bid. Returns the combo mark as a signed net (debit positive) with
// every leg's own reading, so the row can say which leg it could not price.
const feedMark = (g) => {
  if (!g) return null;
  const theo = num(g.mark);
  if (theo != null && theo > 0) return theo;
  const bid = num(g.bid), ask = num(g.ask);
  if (bid != null && ask != null && ask >= bid) return +((bid + ask) / 2).toFixed(4);
  return bid != null ? bid : null;
};

export function comboMark(root, legs = [], greeks = {}) {
  const L = (legs || []).map(normalizeLeg).filter(Boolean);
  if (!L.length) return { mark: null, legs: [], missing: [], complete: false };
  const out = L.map(leg => {
    const key = legKey(root, leg);
    const g = greeks?.[key] || null;
    const mark = feedMark(g);
    return { key, leg, mark, delta: num(g?.delta), theta: num(g?.theta), iv: num(g?.iv), priced: mark != null };
  });
  const missing = out.filter(x => !x.priced).map(x => x.key);
  const mark = missing.length ? null : +out.reduce((a, x) => a + legSign(x.leg) * x.leg.ratio * x.mark, 0).toFixed(4);
  return { mark, legs: out, missing, complete: missing.length === 0 };
}

// The combo mark the row will be valued at, and where it came from — live, typed, or the last
// fill. Stated because a spread marked at its own entry has a P&L of exactly zero, which reads as
// "flat" when it means "unknown".
export function markOf(row, { greeks = {} } = {}) {
  const root = underlyingOf(row);
  const legs = legsOf(row);
  const live = comboMark(root, legs, greeks);
  if (live.mark != null) return { value: live.mark, source: 'live', legs: live.legs, missing: [] };
  const manual = num(row?.mark);
  if (manual != null) return { value: manual, source: 'manual', legs: live.legs, missing: live.missing };
  const fills = (row?.fills || []).filter(f => num(f?.price) != null).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const last = fills.length ? num(fills[fills.length - 1].price) : null;
  if (last != null) return { value: last, source: 'fill', legs: live.legs, missing: live.missing };
  return { value: null, source: null, legs: live.legs, missing: live.missing };
}

// ── THE GREEKS OF THE COMBO ──────────────────────────────────────────────────
// Net delta per share of underlying: Σ sign × ratio × leg delta. A leg the feed priced but gave no
// delta for is modelled from its mark and the spot, and the whole reading is then labelled
// modelled — never silently. A leg with neither is a hole, and the delta is null rather than a
// partial sum that looks like a total.
export function comboGreeks(root, legs = [], greeks = {}, { spot = null, now = new Date() } = {}) {
  const L = (legs || []).map(normalizeLeg).filter(Boolean);
  if (!L.length) return { delta: null, source: null, theta: null, missing: [] };
  let delta = 0, theta = 0, thetaOk = true, source = 'live';
  const missing = [];
  for (const leg of L) {
    const g = greeks?.[legKey(root, leg)] || null;
    let d = num(g?.delta);
    if (d == null) {
      const m = feedMark(g);
      const S = num(spot);
      const mod = (m != null && S != null) ? modelledDelta({ S, K: leg.strike, expiry: leg.expiry, mark: m, right: leg.right, now: now.toISOString() }) : null;
      if (mod) { d = mod.delta; source = 'modelled'; }
    }
    if (d == null) { missing.push(legKey(root, leg)); continue; }
    delta += legSign(leg) * leg.ratio * d;
    const t = num(g?.theta);
    if (t == null) thetaOk = false; else theta += legSign(leg) * leg.ratio * t;
  }
  if (missing.length) return { delta: null, source: null, theta: null, missing };
  return { delta: +delta.toFixed(4), source, theta: thetaOk ? +theta.toFixed(4) : null, missing: [] };
}

// ── DEFINED RISK ─────────────────────────────────────────────────────────────
// For a single leg and for a vertical, max loss / max profit / breakeven follow from the strikes
// and the net price alone. Anything else returns nulls with the shape named — a calendar's max
// profit depends on where vol is at the front expiry, which is a model, not a fact.
// `net` is the combo price per share (debit positive), `qty` contracts.
export function definedRisk(legs = [], net, { qty = 1, multiplier = OPTION_MULTIPLIER } = {}) {
  const L = (legs || []).map(normalizeLeg).filter(Boolean);
  const n = num(net), q = Math.abs(num(qty) ?? 1), m = num(multiplier) ?? OPTION_MULTIPLIER;
  const shape = spreadShape(L);
  const money = (perShare) => (perShare == null ? null : +(perShare * m * q).toFixed(2));
  const none = { shape, debit: n != null ? n >= 0 : null, maxLoss: null, maxProfit: null, breakeven: null, width: null, unlimited: null };
  if (n == null || !L.length) return none;
  if (shape === 'single') {
    const [l] = L;
    const long = l.side === 'long';
    const price = Math.abs(n);
    if (long) {
      return { ...none, debit: true, maxLoss: money(price), maxProfit: l.right === 'C' ? null : money(l.strike - price),
               unlimited: l.right === 'C' ? 'profit' : null, breakeven: +(l.right === 'C' ? l.strike + price : l.strike - price).toFixed(4) };
    }
    return { ...none, debit: false, maxProfit: money(price), maxLoss: l.right === 'C' ? null : money(l.strike - price),
             unlimited: l.right === 'C' ? 'loss' : null, breakeven: +(l.right === 'C' ? l.strike + price : l.strike - price).toFixed(4) };
  }
  if (shape === 'vertical') {
    const [a, b] = L;
    const width = Math.abs(a.strike - b.strike);
    const price = Math.abs(n);
    const long = L.find(l => l.side === 'long'), short = L.find(l => l.side === 'short');
    const isCall = a.right === 'C';
    // A debit vertical is long the strike that is worth more: the lower call, the higher put.
    const debit = isCall ? long.strike < short.strike : long.strike > short.strike;
    if (n !== 0 && ((n > 0) !== debit)) {
      // The price sign disagrees with the strikes — the fill was typed the wrong way round. Say so
      // rather than produce a max profit that is a max loss.
      return { ...none, width, debit, mismatch: `a ${isCall ? 'call' : 'put'} vertical long the ${long.strike} and short the ${short.strike} is a ${debit ? 'debit' : 'credit'} — the net price should be ${debit ? 'positive' : 'negative'}` };
    }
    if (debit) {
      return { ...none, width, debit: true, maxLoss: money(price), maxProfit: money(width - price),
               breakeven: +(isCall ? long.strike + price : long.strike - price).toFixed(4) };
    }
    return { ...none, width, debit: false, maxProfit: money(price), maxLoss: money(width - price),
             breakeven: +(isCall ? short.strike + price : short.strike - price).toFixed(4) };
  }
  if (shape === 'calendar' || shape === 'diagonal') {
    // A debit calendar cannot lose more than it cost; its upside is not a number.
    return { ...none, maxLoss: n > 0 ? money(n) : null, note: `a ${shape}'s max profit depends on front-month vol at expiry — not stated` };
  }
  return none;
}

// ── DATES ────────────────────────────────────────────────────────────────────
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isWeekend = (iso) => { const w = new Date(`${iso}T00:00:00Z`).getUTCDay(); return w === 0 || w === 6; };
const prevTradingDay = (iso, holidays = []) => { const H = new Set(holidays); let d = addDays(iso, -1); while (isWeekend(d) || H.has(d)) d = addDays(d, -1); return d; };

export const nearestExpiry = (legs = []) => (legs || []).map(normalizeLeg).filter(Boolean).map(l => l.expiry).sort()[0] || null;
export const dteOf = (legs = [], today = new Date().toISOString().slice(0, 10)) => {
  const e = nearestExpiry(legs);
  if (!e) return null;
  return Math.round((Date.parse(`${e}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
};
// expiry − 7 days, pulled back to the Friday if that lands on a weekend.
export function defaultHardDate(legs = [], { days = HARD_DATE_DEFAULT_DAYS, holidays = [] } = {}) {
  const e = nearestExpiry(legs);
  if (!e) return null;
  let d = addDays(e, -days);
  const H = new Set(holidays);
  while (isWeekend(d) || H.has(d)) d = addDays(d, -1);
  return d;
}
// The latest a hard date may be: the trading day before the nearest expiry.
export const hardDateLimit = (legs = [], { holidays = [] } = {}) => { const e = nearestExpiry(legs); return e ? prevTradingDay(e, holidays) : null; };
export function hardDateCheck(hardDate, legs = [], { holidays = [] } = {}) {
  const limit = hardDateLimit(legs, { holidays });
  if (!legs?.length) return { ok: true, limit: null, reason: null };
  if (!isoDate(hardDate)) return { ok: false, limit, reason: 'a hard exit date is required on every option and spread row' };
  if (limit && hardDate > limit) return { ok: false, limit, reason: `no later than ${limit}, the trading day before expiry` };
  return { ok: true, limit, reason: null };
}

// ── EVERYTHING THE ROW SHOWS, IN ONE PLACE ───────────────────────────────────
// `row` carries `derived` from lib/positions.js (qty, avgCost). `greeks`/`spots` are the feed's.
export function optionDerived(row, { greeks = {}, spots = {}, nlv = null, today = new Date().toISOString().slice(0, 10), holidays = [], now = new Date() } = {}) {
  const instrument = instrumentOf(row);
  if (instrument !== 'option' && instrument !== 'spread') return null;
  const root = underlyingOf(row);
  const legs = legsOf(row);
  const qty = num(row?.derived?.qty) ?? 0;
  const mult = num(row?.multiplier) ?? OPTION_MULTIPLIER;
  const spot = num(spots?.[root]) ?? num(row?.underlyingPrice);
  const mark = markOf(row, { greeks });
  const g = comboGreeks(root, legs, greeks, { spot, now });
  // Signed by the row's direction: a short row (sold the combo) carries the opposite delta.
  const dir = dirSign(sideOf(row?.side) ?? 'long');
  const netDelta = g.delta == null ? null : +(g.delta * dir).toFixed(4);
  const deltaNotional = (netDelta != null && spot != null && qty) ? +(Math.abs(netDelta) * spot * mult * qty).toFixed(2) : null;
  const eq = num(nlv);
  const entry = num(row?.derived?.avgCost) ?? num(row?.derived?.avgEntry);
  const risk = definedRisk(legs, entry ?? mark.value, { qty: qty || 1, multiplier: mult });
  const hardDate = isoDate(row?.hardDate) ? row.hardDate : defaultHardDate(legs, { holidays });
  const hd = hardDateCheck(hardDate, legs, { holidays });
  const expiry = nearestExpiry(legs);
  const dte = dteOf(legs, today);
  // Premium at risk: what a debit position can lose in full; for a credit, the defined max loss.
  const premiumAtRisk = (mark.value != null && qty) ? (mark.value >= 0 ? +(mark.value * mult * qty).toFixed(2) : risk.maxLoss) : null;
  return {
    instrument, underlying: root, legs, shape: spreadShape(legs), label: legLabel(legs), multiplier: mult,
    spot, mark: mark.value, markSource: mark.source, legMarks: mark.legs, unpriced: mark.missing,
    netDelta, deltaSource: g.source, theta: g.theta == null ? null : +(g.theta * dir * mult * (qty || 1)).toFixed(2),
    deltaNotional, pctNlv: (deltaNotional != null && eq > 0) ? +((deltaNotional / eq) * 100).toFixed(1) : null,
    premiumAtRisk,
    maxLoss: risk.maxLoss, maxProfit: risk.maxProfit, breakeven: risk.breakeven, unlimited: risk.unlimited ?? null, riskNote: risk.note ?? risk.mismatch ?? null,
    expiry, dte, hardDate, hardDateDefault: !isoDate(row?.hardDate) || row.hardDate === defaultHardDate(legs, { holidays }), hardDateOk: hd.ok, hardDateLimit: hd.limit, hardDateReason: hd.reason,
    hardDateReached: !!(hardDate && today >= hardDate && qty > 0),
    expired: !!(expiry && today > expiry && qty > 0),
  };
}

// ── FOR THE EXPOSURE BOOK ────────────────────────────────────────────────────
// lib/bookExposure.js prices one contract per row. A spread is one row and several contracts, so
// it is handed over as one pseudo-row per leg — quantity signed by the leg's side and the row's
// direction, multiplier the option's — and the book sums them under the underlying like any
// other option line. A share or futures row passes through untouched.
export function exposureLines(row) {
  if (!isDerivativeRow(row)) return [row];
  const root = underlyingOf(row);
  const legs = legsOf(row);
  const qty = num(row?.derived?.qty ?? row?.qty) ?? 0;
  const dir = dirSign(sideOf(row?.side) ?? 'long');
  const mult = num(row?.multiplier) ?? OPTION_MULTIPLIER;
  return legs.map((leg, i) => ({
    id: `${row.id}:leg${i}`, symbol: `${root} ${expiryLabel(leg.expiry)} ${fmtK(leg.strike)}${leg.right}`,
    root, contract: legContract(root, leg), multiplier: mult,
    qty: qty * leg.ratio * legSign(leg) * dir,
    // No avgCost: the combo's average is not a leg's price, and the book would otherwise count
    // every leg of a 0.85 vertical at 0.85. A leg the feed cannot mark is counted unpriced.
    derived: { qty: qty * leg.ratio * legSign(leg) * dir, status: row.derived?.status, firstDate: row.derived?.firstDate },
    bucket: row.bucket, currency: row.currency,
  }));
}

// ── A NEW ROW ────────────────────────────────────────────────────────────────
// What "Add a trade" builds: an option or spread row on the underlying, its legs, the option
// multiplier, the default hard date, and — when a net price and quantity were given — its first
// fill at the combo price. Returns { row } or { error } and never a half-built row.
export function optionRow({ underlying, legs = [], side = 'long', qty = null, price = null, date = null, currency = 'USD', thesis = '', hardDate = null, id = null } = {}) {
  const root = String(underlying || '').trim().toUpperCase();
  if (!root) return { error: 'an underlying is required' };
  const L = (legs || []).map(normalizeLeg).filter(Boolean);
  if (!L.length) return { error: 'at least one leg — right, strike, expiry and long/short' };
  if (L.length > MAX_LEGS) return { error: `at most ${MAX_LEGS} legs` };
  if ((legs || []).length !== L.length) return { error: 'every leg needs a right, a strike above zero, an expiry date and long/short' };
  const instrument = L.length === 1 ? 'option' : 'spread';
  const q = num(qty), p = num(price);
  if ((q != null) !== (p != null)) return { error: 'a first fill needs both a quantity and a net price' };
  if (q != null && !(q > 0)) return { error: 'quantity must be above zero' };
  const hd = isoDate(hardDate) ? hardDate : defaultHardDate(L);
  const chk = hardDateCheck(hd, L);
  if (!chk.ok) return { error: chk.reason };
  const sd = sideOf(side) ?? 'long';
  const rid = id || `${root}-${Math.random().toString(36).slice(2, 8)}`;
  const fills = q != null ? [{ id: Math.random().toString(36).slice(2, 8), date: date || new Date().toISOString().slice(0, 10),
    side: sd === 'short' ? 'sell' : 'buy', qty: q, price: p, note: `${legLabel(L)} at the combo price` }] : [];
  return { row: { id: rid, symbol: root, underlying: root, instrument, legs: L, side: sd, currency, thesis, levels: [], fills, tags: [],
                  multiplier: OPTION_MULTIPLIER, hardDate: hd } };
}

// The wording for a level on an option row. 'sell' is the profit target and 'buy' the entry, as on
// a share row; what differs is WHAT is watched, and the pill says so.
export function optionLevelVocab(kind, on = 'combo') {
  const what = on === 'underlying' ? 'underlying' : 'combo mark';
  if (kind === 'stop') return { label: 'STOP', verb: `${what} breaks below`, noun: 'stop' };
  if (kind === 'sell') return { label: 'TP', verb: `${what} rises to`, noun: 'target' };
  return { label: 'ENTRY', verb: `${what} falls to`, noun: 'entry' };
}
