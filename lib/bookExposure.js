// lib/bookExposure.js — what the book is actually carrying, in delta.
//
// ── THE FINDING THIS EXISTS TO SURFACE ───────────────────────────────────────
// Live account state, 2026-09-10: the broker's leverage line read 0.74×, premium at risk was
// $41,269 (19.6% of a $210,335 NLV), and delta-notional was roughly $737,000 — 3.5× NLV. The
// broker's own figure understates directional exposure by about a factor of five, because it
// counts long options at PREMIUM rather than at DELTA. One line, QQQ Oct16 730C ×20 at a 0.352
// delta, carries $499,000 — 2.37× NLV on its own. Nothing on this board showed that.
//
// Premium answers "what can be lost at expiry". Delta-notional answers "what am I carrying right
// now". On this account those two numbers differ by a factor of twelve, and only one of them is
// the question a risk tile is for.
//
// ── WHERE THE GREEKS COME FROM, AND WHY NOT FROM US ──────────────────────────
// The spec says: source greeks from the broker, do not compute Black-Scholes. The reasoning is
// right — a modelled delta carries an assumed rate and dividend and turns a summing exercise into
// a modelling one — and the broker's own API is not reachable from this deployment: it reads IBKR
// through Flex, which is an end-of-day XML statement and carries no greeks at all.
//
// So the greeks come from the EXCHANGE instead: CBOE publishes delta, gamma, theta and vega per
// contract on the same delayed feed this board already uses for the gamma walls (lib/cboe.js).
// They are published numbers, not ours — which is the property the spec was actually asking for.
// What is lost against the broker's own feed is ~15 minutes of freshness, and that is stated on
// the tile rather than hidden: `asOf` is carried on every reading and rendered.
//
// EVERY GREEK IS OPTIONAL AND ITS ABSENCE IS VISIBLE. A position whose contract the feed does not
// carry is counted at premium and listed as unpriced, never silently dropped and never guessed at
// — a book total that quietly omits its largest line is the failure this tile exists to fix.
//
// ── PRIVATE, AND IT STAYS PRIVATE ────────────────────────────────────────────
// This is positions, quantities and account value. It renders on the console and goes nowhere
// else: not into a pre-read, not into a Discord card, not into any public route.
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── THRESHOLDS ───────────────────────────────────────────────────────────────
// Judgement calls calibrated to a ~$210k personal account with a documented position-sizing
// weakness, not universal constants — so they are one object, overridable, and every reading says
// which number it was judged against.
import { isCashEquivalent } from './cashEquivalents.js';
import { familyOf, parentFamily, isIndexFamily } from './futuresContracts.js';
import { LEVERAGE, SWING, swingRoom, BOOK_LIMITS } from './leverage.js';
import { isExempt, SINGLE_NAME_EXEMPT } from './sizer.js';
// Sessions between two dates: weekdays, holidays out. Local rather than lib/catalyst.js's, which
// imports this file — a cycle that loads as an undefined export.
const sessionsBetween = (from, to, holidays = []) => {
  if (!from || !to || to <= from) return 0;
  const H = new Set(holidays);
  let n = 0;
  for (const d = new Date(from + 'T00:00:00Z'); ; ) {
    d.setUTCDate(d.getUTCDate() + 1);
    const s = d.toISOString().slice(0, 10);
    if (s > to) break;
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6 && !H.has(s)) n++;
  }
  return n;
};
import { futuresRoot, FUTURES_MULTIPLIER } from './futures.js';

export const EXPOSURE_LIMITS = Object.freeze({
  // The book's limits are lib/leverage.js BOOK_LIMITS — the sizer reads the same object.
  target: BOOK_LIMITS.target,             // × NLV — at or above: TARGET
  positionMax: BOOK_LIMITS.positionMax,   // × NLV — position book over this: ELEVATED
  swingMax: BOOK_LIMITS.swingMax,         // × NLV — swing bucket over this: ELEVATED
  ceiling: BOOK_LIMITS.ceiling,           // × NLV — total over this: OVER CEILING
  singleNamePct: BOOK_LIMITS.singleNamePct,   // % NLV per underlying, exempt list honoured
  thetaPctPerDay: 0.25,   // % of NLV per day
  // The book is heavily correlated US tech, so diversification does close to nothing and the book
  // vol is very nearly the exposure ratio times the underlying's. Both numbers are stated because
  // the estimate is only as good as they are.
  underlyingVol: 0.18,    // annualised, the assumption behind est. book vol
  correlation: 0.75,
  volTargetLo: 0.20, volTargetHi: 0.25,
});

// ── LEVERAGED ETFs ───────────────────────────────────────────────────────────
// AAPU is 2× AAPL. Counted at 1.0 delta the book total understates by the whole leveraged half of
// the position, which is exactly the kind of quiet understatement this tile exists to remove. A
// row may state its own multiple; this table only fills a gap, and the same reasoning as
// lib/futures.js applies — a wrong default is worse than a missing one, so an unknown leveraged
// name is flagged rather than assumed to be 1×.
// One table, in lib/leverage.js, shared with the sizer — the factor a held TQQQ is counted at is
// the factor a TQQQ about to be bought is sized at. 7709.HK joined it on 2026-09-22: it had been
// counted at cost, and its delta-notional is twice that.
export const LEVERAGED_ETF = Object.freeze(Object.fromEntries(Object.entries(LEVERAGE).map(([k, v]) => [k, v.factor])));

// ── CASH-LIKE ETFs ───────────────────────────────────────────────────────────
// USFR is a floating-rate Treasury fund. Counted at 1.0 delta it put $53,000 — a quarter of NLV —
// into the book's delta-notional and the sizer's "now 0.67× NLV", as if a T-bill wrapper moved
// with the market. It does not; its market delta is nil. Held OUT of delta-notional and named
// as a cash leg, so the tile shows what the book is carrying and separately what it is parking.
// The row may still state its own delta, which wins.
// The list itself is lib/cashEquivalents.js, shared with the IBKR sync and the card. `isCashLike`
// takes a ticker or a whole row, so a non-US line (IB01.L, or IB01 with its LSEETF listing) and a
// directly held bill (assetCategory BILL) are recognised as well as the US tickers.
export const isCashLike = (symbolOrRow) => isCashEquivalent(symbolOrRow);

export function equityDelta(symbol, stated = null, row = null) {
  const s = num(stated);
  if (s != null) return { delta: s, source: 'row' };
  const k = String(symbol || '').toUpperCase();
  if (isCashLike(row ? { ...row, symbol } : k)) return { delta: 0, source: 'cash-like ETF' };
  if (Object.prototype.hasOwnProperty.call(LEVERAGED_ETF, k)) {
    return { delta: LEVERAGED_ETF[k], source: 'leveraged-etf table' };
  }
  return { delta: 1, source: 'ordinary equity' };
}

// ── OPTION SYMBOLS ───────────────────────────────────────────────────────────
// Flex reports options in the OCC 21-character form — root padded to six, then YYMMDD, then C or
// P, then the strike in thousandths on eight digits. The console and hand-entered rows use
// shorter forms. Parsed rather than pattern-matched loosely, because a misread strike is a silent
// order-of-magnitude error in every number below it.
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

export function parseOptionSymbol(sym) {
  const raw = String(sym || '').trim().toUpperCase();
  if (!raw) return null;
  // OCC 21-char, with or without the padding spaces: ROOT + YYMMDD + C|P + 8-digit strike.
  const occ = /^([A-Z][A-Z0-9.]{0,5})\s*(\d{6})([CP])(\d{8})$/.exec(raw.replace(/\s+/g, ' ').replace(/ (?=\d{6}[CP])/g, ''));
  if (occ) {
    return { root: occ[1], expiry: `20${occ[2].slice(0, 2)}-${occ[2].slice(2, 4)}-${occ[2].slice(4, 6)}`,
             type: occ[3] === 'C' ? 'call' : 'put', strike: +occ[4] / 1000, form: 'occ' };
  }
  // Compact: "QQQ 261016C730" / "QQQ261016C730.5"
  const compact = /^([A-Z][A-Z0-9.]{0,5})\s*(\d{6})\s*([CP])\s*(\d+(?:\.\d+)?)$/.exec(raw);
  if (compact) {
    return { root: compact[1], expiry: `20${compact[2].slice(0, 2)}-${compact[2].slice(2, 4)}-${compact[2].slice(4, 6)}`,
             type: compact[3] === 'C' ? 'call' : 'put', strike: +compact[4], form: 'compact' };
  }
  // Human: "QQQ Oct16'26 730C" / "QQQ OCT 16 2026 730 C" / "QQQ 2026-10-16 C730"
  const iso = /^([A-Z][A-Z0-9.]{0,5})\s+(\d{4})-(\d{2})-(\d{2})\s*([CP])\s*(\d+(?:\.\d+)?)$/.exec(raw);
  if (iso) {
    return { root: iso[1], expiry: `${iso[2]}-${iso[3]}-${iso[4]}`,
             type: iso[5] === 'C' ? 'call' : 'put', strike: +iso[6], form: 'iso' };
  }
  const human = /^([A-Z][A-Z0-9.]{0,5})\s+([A-Z]{3})\s*(\d{1,2})'?\s*(\d{2,4})\s+(\d+(?:\.\d+)?)\s*([CP])$/.exec(raw);
  if (human && MONTHS[human[2]]) {
    const yr = human[4].length === 2 ? `20${human[4]}` : human[4];
    return { root: human[1], expiry: `${yr}-${String(MONTHS[human[2]]).padStart(2, '0')}-${String(human[3]).padStart(2, '0')}`,
             type: human[6] === 'C' ? 'call' : 'put', strike: +human[5], form: 'human' };
  }
  return null;
}

export const contractKey = (c) => c ? `${c.root}|${c.expiry}|${c.type === 'call' ? 'C' : 'P'}|${c.strike}` : null;

// ── ONE POSITION ─────────────────────────────────────────────────────────────
// `greek` is the exchange's published reading for this contract; `underlying` is the spot the
// delta is applied to. Either missing is stated, never assumed.
export function positionExposure(row, { greek = null, underlying = null, now = new Date() } = {}) {
  const qty = num(row?.qty ?? row?.derived?.qty) ?? 0;
  const symbol = row?.symbol ?? null;
  const opt = row?.contract || parseOptionSymbol(symbol);
  const isOption = !!opt || String(row?.assetCategory || '').toUpperCase() === 'OPT';
  const mult = num(row?.multiplier) ?? (isOption ? 100 : 1);
  // The feed's own mark for the contract beats the row's cost as a premium figure: a leg of a
  // spread (lib/instruments.js exposureLines) carries no price of its own, and pricing it at the
  // combo's average would put the whole spread's cost on every leg.
  const mark = num(row?.livePrice ?? row?.markPrice ?? (isOption ? greek?.mark ?? greek?.bid : null) ?? row?.derived?.avgCost);
  // PREMIUM IS AN OPTION'S NUMBER. This was computed for every row, so "premium at risk" summed
  // the market value of every share and futures line into it — $398,338, 187.9% of NLV, on a
  // book whose only option was five XLE calls worth about $5,200. A share has a market value;
  // it has no premium.
  const premium = (isOption && mark != null && qty) ? +(Math.abs(qty) * mark * mult).toFixed(2) : null;

  if (!isOption) {
    const d = equityDelta(symbol, row?.deltaOverride, row);
    const px = num(underlying) ?? mark;
    // A futures row's root is its family's PARENT — MCL and CL, MGC and GC are one underlying for
    // the single-name line — read off the symbol, or off the multiplier the row carries.
    const fam = familyOf(symbol);
    const isFut = !!fam || (mult > 1 && FUTURES_MULTIPLIER[futuresRoot(symbol)] != null);
    return {
      symbol, root: isFut ? parentFamily(fam || futuresRoot(symbol)) : (String(row?.root || symbol || '').toUpperCase().trim() || null),
      kind: isFut ? 'future' : 'equity', qty, multiplier: mult, mark, premium, underlying: px,
      delta: d.delta, deltaSource: d.source, cashLike: d.source === 'cash-like ETF',
      deltaNotional: (px != null && qty) ? +(d.delta * qty * mult * px).toFixed(2) : null,
      // What the cash leg is worth, so the book can say what it is parking as well as carrying.
      marketValue: (px != null && qty) ? +(qty * mult * px).toFixed(2) : null,
      theta: 0, vega: 0, dte: null, distanceToStrikePct: null, unpriced: px == null,
    };
  }

  const S = num(underlying);
  const delta = num(greek?.delta);
  const dte = opt?.expiry ? Math.round((Date.parse(`${opt.expiry}T21:00:00Z`) - now.getTime()) / 86400000) : null;
  // Signed by the position: a short call is short delta. Quantity carries the sign.
  const deltaNotional = (delta != null && S != null && qty)
    ? +(delta * qty * mult * S).toFixed(2) : null;
  return {
    symbol, root: opt?.root || String(row?.root || '').toUpperCase().trim() || null,
    kind: 'option', contract: opt, qty, multiplier: mult, mark, premium, underlying: S,
    delta, deltaSource: delta == null ? null : 'exchange',
    deltaNotional,
    // Per-DAY theta, in money, signed by the position. The feed quotes it per share per day.
    theta: (num(greek?.theta) != null && qty) ? +(num(greek.theta) * qty * mult).toFixed(2) : null,
    vega: (num(greek?.vega) != null && qty) ? +(num(greek.vega) * qty * mult).toFixed(2) : null,
    gamma: num(greek?.gamma),
    dte,
    distanceToStrikePct: (S != null && opt?.strike > 0) ? +(((opt.strike - S) / S) * 100).toFixed(2) : null,
    // THE ABSENCE IS THE POINT. A line the feed did not carry is counted at premium and named, so
    // a book total can never quietly omit its largest position.
    unpriced: delta == null || S == null,
    unpricedWhy: delta == null ? 'no published delta for this contract' : S == null ? 'no underlying price' : null,
  };
}

// ── PER UNDERLYING, NOT PER POSITION ─────────────────────────────────────────
// 30 INTC shares plus 6 INTC calls is one number. The sizer's single-name cap is tested against
// it (lib/sizer.js), and it is where a covered call shows up as the reduction it is: a short call's
// delta-notional is negative by the sign of its quantity, so it comes off the shares' worth.
// Keyed by root; `shares` is the equity legs' delta-notional, `options` the option legs', and
// `shareEquivalent` the total expressed in shares of the underlying at its price.
export function byUnderlying(lines = [], { nlv = null } = {}) {
  const eq = num(nlv);
  const m = new Map();
  for (const l of Array.isArray(lines) ? lines : []) {
    const root = l?.root || (l?.contract?.root) || String(l?.symbol || '').toUpperCase().trim();
    if (!root || l.cashLike) continue;
    const g = m.get(root) || { root, deltaNotional: 0, shares: 0, options: 0, lines: 0, unpriced: 0, underlying: null, optionLines: 0 };
    g.lines++;
    if (l.unpriced || l.deltaNotional == null) g.unpriced++;
    else if (l.kind === 'option') { g.options += l.deltaNotional; g.deltaNotional += l.deltaNotional; g.optionLines++; }
    else { g.shares += l.deltaNotional; g.deltaNotional += l.deltaNotional; }
    if (g.underlying == null && l.underlying != null) g.underlying = l.underlying;
    m.set(root, g);
  }
  const out = {};
  for (const g of m.values()) {
    out[g.root] = {
      ...g,
      deltaNotional: +g.deltaNotional.toFixed(2), shares: +g.shares.toFixed(2), options: +g.options.toFixed(2),
      shareEquivalent: g.underlying > 0 ? Math.round(g.deltaNotional / g.underlying) : null,
      pctNlv: eq > 0 ? +((g.deltaNotional / eq) * 100).toFixed(1) : null,
    };
  }
  return out;
}

// ── THE BOOK ─────────────────────────────────────────────────────────────────
export function bookExposure({ rows = [], greeks = {}, underlyings = {}, nlv = null,
                               limits = EXPOSURE_LIMITS, trend = [], asOf = null, frozen = false,
                               now = new Date(), holidays = [], cashBook = null, toBase = null, exempt = SINGLE_NAME_EXEMPT } = {}) {
  const L = { ...EXPOSURE_LIMITS, ...(limits || {}) };
  const eq = num(nlv);
  const open = (Array.isArray(rows) ? rows : []).filter(r => Math.abs(num(r?.qty ?? r?.derived?.qty) ?? 0) > 0);
  // ── ONE CURRENCY ── NLV is in the base currency, so every money figure on a line is too. A line is
  // priced in its own currency (0981.HK in HKD); without this the HK book was summed as if HK$ were
  // dollars — 0981.HK showed "Δ HK$61,300 (28.5% NLV)" on a $215k account where the truth was ~3.6%.
  // `toBase(amount, currency)` is the console's own FX (lib/fxrates.js convert). A line with no rate
  // is UNPRICED and named, never summed unconverted.
  const MONEY = ['marketValue', 'deltaNotional', 'premium', 'theta', 'vega'];
  const lines = open.map(r => {
    const opt = r?.contract || parseOptionSymbol(r?.symbol);
    const root = opt?.root || String(r?.root || r?.symbol || '').toUpperCase();
    const l = positionExposure(r, { greek: greeks[contractKey(opt)] ?? null, underlying: num(underlyings[root]), now });
    const ccy = String(r?.currency || 'USD').toUpperCase();
    l.currency = ccy;
    if (typeof toBase === 'function') {
      const rate = toBase(1, ccy);
      if (!(Number.isFinite(rate) && rate > 0)) {
        for (const k of MONEY) l[k] = null;
        l.unpriced = true; l.unpricedWhy = `no ${ccy} exchange rate`;
      } else if (rate !== 1) {
        for (const k of MONEY) if (l[k] != null) l[k] = +(l[k] * rate).toFixed(2);
        l.fxRate = rate;
      }
    }
    return l;
  });

  // ── WHICH BUCKET ─────────────────────────────────────────────────────────
  // A leveraged or inverse ETF and an index future held overnight default to the SWING bucket;
  // everything else is the position book. A row may say otherwise (`bucket`). A swing trade still
  // open on its fourth session is re-classified into the position book without asking and marked,
  // so the panel can say so and the log can carry it — standing preference: apply first, tell after.
  const today = now.toISOString().slice(0, 10);
  const rowOf = new Map(open.map((r, i) => [i, r]));
  lines.forEach((l, i) => {
    const r = rowOf.get(i) || {};
    const leveraged = l.kind === 'equity' && l.deltaSource === 'leveraged-etf table';
    const indexFut = l.kind === 'future' && isIndexFamily(l.root);
    const wants = r.bucket === 'swing' || r.bucket === 'position' ? r.bucket : (leveraged || indexFut) ? 'swing' : 'position';
    const opened = r.derived?.firstDate || r.openedAt || null;
    const sessions = opened ? sessionsBetween(String(opened).slice(0, 10), today, holidays) + 1 : null;
    const reclassified = wants === 'swing' && sessions != null && sessions > SWING.maxSessions;
    l.bucket = reclassified ? 'position' : wants;
    l.sessionsHeld = sessions;
    l.reclassified = reclassified;
    l.leveraged = leveraged;
  });
  const sum = (k) => {
    const vals = lines.map(l => l[k]).filter(v => v != null);
    return vals.length ? +vals.reduce((a, b) => a + b, 0).toFixed(2) : 0;
  };
  const deltaNotional = sum('deltaNotional');
  // THETA AND VEGA ARE NULL UNTIL A GREEK ARRIVES. A book with an open long call printed
  // "Theta/day $0" while the tile beside it said "awaiting greeks" — a false "no decay" from an
  // empty sum. With option lines and none of them priced yet, the number is unknown, not zero.
  const optionLines = lines.filter(l => l.kind === 'option');
  const greeksIn = optionLines.some(l => l.theta != null || l.vega != null);
  const premium = optionLines.length ? sum('premium') : 0;
  const theta = optionLines.length && !greeksIn ? null : sum('theta');
  const vega = optionLines.length && !greeksIn ? null : sum('vega');
  const unpriced = lines.filter(l => l.unpriced);
  const cashLines = lines.filter(l => l.cashLike);
  const cashLegs = {
    value: +cashLines.reduce((a, l) => a + (l.marketValue ?? 0), 0).toFixed(2),
    symbols: cashLines.map(l => String(l.symbol).trim()),
    pctNlv: null,
  };

  const ratio = (eq > 0) ? +(deltaNotional / eq).toFixed(2) : null;
  if (eq > 0) cashLegs.pctNlv = +((cashLegs.value / eq) * 100).toFixed(1);

  // ── CASH & EQUIVALENTS, AND THE BROKER'S OWN LEVERAGE ──────────────────────
  // Two leverage numbers, because they answer different questions and were being read as one:
  //   book   delta-notional ÷ NLV with cash equivalents at zero — what the 1.2× rule is about;
  //   ibkr   gross position value ÷ NLV, cash equivalents INCLUDED, futures excluded (IBKR counts a
  //          future's P&L, not its notional) — what IBKR's own screen shows. A $300k IB01 purchase
  //          lifts the second and leaves the first exactly where it was.
  // The cash book (the IBKR statement's USD cash, T-bill funds, IB01 and bills, at market) is the
  // record when the sync has written one; otherwise the console's own cash rows stand in.
  const bookLines = (cashBook?.lines || []).filter(l => num(l.value) != null);
  const inBook = new Set(bookLines.map(l => String(l.symbol || '').toUpperCase().split(/[.\s]/)[0]));
  const consoleCash = cashLines.filter(l => !inBook.has(String(l.symbol || '').toUpperCase().split(/[.\s]/)[0]))
    .map(l => ({ symbol: String(l.symbol).trim(), kind: 'fund', value: l.marketValue ?? 0, source: 'console' }));
  const eqLines = [...bookLines.map(l => ({ symbol: l.symbol, kind: l.kind || 'fund', value: num(l.value), source: 'statement', expiry: l.expiry ?? null })), ...consoleCash];
  const usdCash = num(cashBook?.usdCash);
  const eqValue = eqLines.reduce((a, l) => a + (l.value ?? 0), 0);
  const cashEquivalents = {
    total: +(eqValue + (usdCash ?? 0)).toFixed(2),
    equivalents: +eqValue.toFixed(2),
    usdCash: usdCash ?? null,
    usdCashNote: usdCash == null ? (cashBook ? (cashBook.cashSource || 'not in the statement') : 'no IBKR statement read yet') : null,
    lines: eqLines,
    asOf: cashBook?.asOf ?? null,
    pctNlv: eq > 0 ? +(((eqValue + (usdCash ?? 0)) / eq) * 100).toFixed(1) : null,
  };
  // Gross position value: every non-cash, non-futures line at market (options at premium), plus the
  // cash equivalents themselves (but not USD cash, which IBKR does not count as a position).
  const grossBook = lines.filter(l => !l.cashLike && l.kind !== 'future')
    .reduce((a, l) => a + Math.abs(l.kind === 'option' ? (l.premium ?? 0) : (l.marketValue ?? 0)), 0);
  const ibkrGross = +(grossBook + eqValue).toFixed(2);
  const leverage = {
    book: { ratio, basis: 'delta-notional ÷ NLV, cash equivalents excluded — the 1.2× rule' },
    ibkr: { ratio: eq > 0 ? +(ibkrGross / eq).toFixed(2) : null, gross: ibkrGross,
            basis: 'gross position value ÷ NLV, cash equivalents included, futures excluded — as IBKR shows it' },
  };
  // est_book_vol = exposure_ratio × underlying_vol_estimate. The correlation assumption is what
  // makes that a single multiplication rather than a covariance sum, and it is stated: at 0.75
  // across a book of US tech, diversification does close to nothing.
  const bookVol = ratio == null ? null : +(Math.abs(ratio) * L.underlyingVol).toFixed(3);
  const oneSd = (ratio == null || eq == null) ? null : Math.round(Math.abs(ratio) * L.underlyingVol * eq);

  // The two budgets against the one ceiling, computed before the state so the state can read them.
  const bucketSum = (b) => +lines.filter(l => l.bucket === b && l.deltaNotional != null && !l.cashLike).reduce((a, l) => a + l.deltaNotional, 0).toFixed(2);
  const positionUsd = bucketSum('position'), swingUsd = bucketSum('swing');
  const room = swingRoom({ nlv: eq, positionUsd, swingUsd, L: { ...SWING, positionMax: L.positionMax, swingMax: L.swingMax } });
  const bucketOver = room.positionOverUsd > 0 || (room.swingX != null && room.swingX > L.swingMax);
  const state = ratio == null ? 'UNKNOWN'
    : Math.abs(ratio) > L.ceiling ? 'OVER CEILING'
    : bucketOver ? 'ELEVATED'
    : Math.abs(ratio) >= L.target ? 'TARGET'
    : 'CONSERVATIVE';

  const largest = [...lines].filter(l => l.deltaNotional != null)
    .sort((a, b) => Math.abs(b.deltaNotional) - Math.abs(a.deltaNotional))[0] || null;
  // ONE SINGLE-NAME CAP: the sizer's — per underlying (shares and options together), at
  // singleNamePct of NLV, with the index ETFs and index futures on the exempt list shown, not flagged.
  const byU = byUnderlying(lines, { nlv: eq });
  const overCap = eq > 0 ? Object.values(byU)
    .filter(g => !isExempt(g.root, exempt) && Math.abs(g.deltaNotional) / eq * 100 > L.singleNamePct)
    .map(g => ({ symbol: g.root, ratio: +(g.deltaNotional / eq).toFixed(2), pct: +(Math.abs(g.deltaNotional) / eq * 100).toFixed(1), deltaNotional: g.deltaNotional })) : [];

  const thetaPct = (eq > 0 && theta != null) ? +((Math.abs(theta) / eq) * 100).toFixed(3) : null;

  const breaches = [];
  if (state === 'OVER CEILING') breaches.push(`delta-notional ${ratio}× NLV is over the ${L.ceiling}× ceiling`);
  if (room.positionOverUsd > 0) breaches.push(`position book ${room.positionX}× NLV is over its ${L.positionMax}× limit`);
  if (room.swingX != null && room.swingX > L.swingMax) breaches.push(`swing bucket ${room.swingX}× NLV is over its ${L.swingMax}× limit`);
  for (const p of overCap) breaches.push(`${p.symbol} is ${p.pct}% of NLV, over the ${L.singleNamePct}% single-name cap`);
  if (thetaPct != null && thetaPct > L.thetaPctPerDay) breaches.push(`theta ${thetaPct}% of NLV per day is over the ${L.thetaPctPerDay}% ceiling`);
  if (bookVol != null && bookVol > L.volTargetHi) breaches.push(`estimated book volatility ~${Math.round(bookVol * 100)}% is above the ${Math.round(L.volTargetLo * 100)}–${Math.round(L.volTargetHi * 100)}% target`);

  return {
    available: lines.length > 0,
    asOf, frozen,
    nlv: eq, lines,
    deltaNotional, ratio, state,
    premium, premiumPct: eq > 0 ? +((premium / eq) * 100).toFixed(1) : null,
    theta, thetaPct, vega,
    // Whether any option line has a greek yet; the tile prints "awaiting" rather than $0 until then.
    greeksPending: optionLines.length > 0 && !greeksIn,
    optionLines: optionLines.length,
    bookVol, oneSd, limits: L,
    largest: largest ? { symbol: largest.symbol, root: largest.root ?? null, deltaNotional: largest.deltaNotional,
                         ratio: eq > 0 ? +(largest.deltaNotional / eq).toFixed(2) : null,
                         overCap: overCap.some(o => o.symbol === (largest.root ?? largest.symbol)) } : null,
    overCap, breaches,
    // Shares and options summed per root — what the sizer's single-name cap is tested against.
    byUnderlying: byU,
    // The two budgets against the one ceiling. Position book ≤ 1.2×, swing ≤ 0.3×, reserved.
    buckets: { ...room,
               swingLines: lines.filter(l => l.bucket === 'swing').map(l => ({ symbol: l.symbol, deltaNotional: l.deltaNotional, sessionsHeld: l.sessionsHeld })),
               reclassified: lines.filter(l => l.reclassified).map(l => ({ symbol: l.symbol, sessionsHeld: l.sessionsHeld, deltaNotional: l.deltaNotional })) },
    // Held out of delta-notional and named: the cash legs the book is parking.
    cashLegs,
    cashEquivalents,
    leverage,
    unpriced: unpriced.map(l => ({ symbol: l.symbol, why: l.unpricedWhy })),
    trend: trendRead(trend, ratio),
    // The broker's own line, for the comparison that is the whole point of the tile.
    note: 'delta-notional, not premium — the broker\'s leverage line counts long options at what they cost, not at what they control',
  };
}

// ── THE TREND IS THE MOST IMPORTANT ROW ──────────────────────────────────────
// A single reading says where the book is. The series says it arrived there gradually without
// anyone deciding to, which is what exposure creep looks like and what a point-in-time number
// cannot show.
export const TREND_WINDOW = 20;
export const TREND_MIN = 5;   // readings below which a direction is not claimed

export function trendRead(series = [], today = null) {
  const rows = (Array.isArray(series) ? series : [])
    .filter(r => r && r.date && num(r.ratio) != null)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-TREND_WINDOW);
  if (rows.length < TREND_MIN) {
    return { available: false, n: rows.length, need: TREND_MIN,
             note: `${rows.length} of ${TREND_MIN} daily readings — the direction is not claimed until there are enough of them` };
  }
  const first = num(rows[0].ratio);
  const last = today != null ? num(today) : num(rows[rows.length - 1].ratio);
  const delta = +(last - first).toFixed(2);
  const dir = delta > 0.1 ? 'rising' : delta < -0.1 ? 'falling' : 'flat';
  return {
    available: true, n: rows.length, from: first, to: last, delta, dir,
    arrow: dir === 'rising' ? '▲' : dir === 'falling' ? '▼' : '■',
    note: `${first}× → ${last}× over ${rows.length} sessions`,
    series: rows.map(r => ({ date: r.date, ratio: num(r.ratio) })),
  };
}
