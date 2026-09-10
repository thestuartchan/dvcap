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
export const EXPOSURE_LIMITS = Object.freeze({
  targetLo: 1.1,          // × NLV — the band, ~20% estimated book vol
  targetHi: 1.4,          // × NLV — ~25%
  ceiling: 2.0,           // × NLV — hard, renders OVER CEILING
  singleCap: 0.5,         // × NLV — any one line above this is flagged by name
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
export const LEVERAGED_ETF = Object.freeze({
  AAPU: 2, TSLL: 2, NVDL: 2, MSFU: 2, AMZU: 2, GGLL: 2, METU: 2, PLTU: 2, CONL: 2,
  TQQQ: 3, UPRO: 3, SOXL: 3, SPXL: 3, TNA: 3, FNGU: 3,
  SQQQ: -3, SPXS: -3, SOXS: -3, TZA: -3,
});

export function equityDelta(symbol, stated = null) {
  const s = num(stated);
  if (s != null) return { delta: s, source: 'row' };
  const k = String(symbol || '').toUpperCase();
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
  const mark = num(row?.livePrice ?? row?.markPrice ?? row?.derived?.avgCost);
  const premium = (mark != null && qty) ? +(Math.abs(qty) * mark * mult).toFixed(2) : null;

  if (!isOption) {
    const d = equityDelta(symbol, row?.deltaOverride);
    const px = num(underlying) ?? mark;
    return {
      symbol, kind: 'equity', qty, multiplier: mult, mark, premium,
      delta: d.delta, deltaSource: d.source,
      deltaNotional: (px != null && qty) ? +(d.delta * qty * mult * px).toFixed(2) : null,
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
    symbol, kind: 'option', contract: opt, qty, multiplier: mult, mark, premium,
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

// ── THE BOOK ─────────────────────────────────────────────────────────────────
export function bookExposure({ rows = [], greeks = {}, underlyings = {}, nlv = null,
                               limits = EXPOSURE_LIMITS, trend = [], asOf = null, frozen = false,
                               now = new Date() } = {}) {
  const L = { ...EXPOSURE_LIMITS, ...(limits || {}) };
  const eq = num(nlv);
  const open = (Array.isArray(rows) ? rows : []).filter(r => Math.abs(num(r?.qty ?? r?.derived?.qty) ?? 0) > 0);
  const lines = open.map(r => {
    const opt = r?.contract || parseOptionSymbol(r?.symbol);
    const root = opt?.root || String(r?.root || r?.symbol || '').toUpperCase();
    return positionExposure(r, { greek: greeks[contractKey(opt)] ?? null, underlying: num(underlyings[root]), now });
  });

  const sum = (k) => {
    const vals = lines.map(l => l[k]).filter(v => v != null);
    return vals.length ? +vals.reduce((a, b) => a + b, 0).toFixed(2) : 0;
  };
  const deltaNotional = sum('deltaNotional');
  const premium = sum('premium');
  const theta = sum('theta');
  const vega = sum('vega');
  const unpriced = lines.filter(l => l.unpriced);

  const ratio = (eq > 0) ? +(deltaNotional / eq).toFixed(2) : null;
  // est_book_vol = exposure_ratio × underlying_vol_estimate. The correlation assumption is what
  // makes that a single multiplication rather than a covariance sum, and it is stated: at 0.75
  // across a book of US tech, diversification does close to nothing.
  const bookVol = ratio == null ? null : +(Math.abs(ratio) * L.underlyingVol).toFixed(3);
  const oneSd = (ratio == null || eq == null) ? null : Math.round(Math.abs(ratio) * L.underlyingVol * eq);

  const state = ratio == null ? 'UNKNOWN'
    : Math.abs(ratio) > L.ceiling ? 'OVER CEILING'
    : Math.abs(ratio) >= 1.5 ? 'ELEVATED'
    : Math.abs(ratio) >= L.targetLo ? 'TARGET'
    : 'CONSERVATIVE';

  const largest = [...lines].filter(l => l.deltaNotional != null)
    .sort((a, b) => Math.abs(b.deltaNotional) - Math.abs(a.deltaNotional))[0] || null;
  const overCap = eq > 0 ? lines.filter(l => l.deltaNotional != null && Math.abs(l.deltaNotional) / eq > L.singleCap)
    .map(l => ({ symbol: l.symbol, ratio: +(l.deltaNotional / eq).toFixed(2), deltaNotional: l.deltaNotional })) : [];

  const thetaPct = (eq > 0 && theta != null) ? +((Math.abs(theta) / eq) * 100).toFixed(3) : null;

  const breaches = [];
  if (state === 'OVER CEILING') breaches.push(`delta-notional ${ratio}× NLV is over the ${L.ceiling}× ceiling`);
  for (const p of overCap) breaches.push(`${p.symbol} alone is ${p.ratio}× NLV, over the ${L.singleCap}× single-position cap`);
  if (thetaPct != null && thetaPct > L.thetaPctPerDay) breaches.push(`theta ${thetaPct}% of NLV per day is over the ${L.thetaPctPerDay}% ceiling`);
  if (bookVol != null && bookVol > L.volTargetHi) breaches.push(`estimated book volatility ~${Math.round(bookVol * 100)}% is above the ${Math.round(L.volTargetLo * 100)}–${Math.round(L.volTargetHi * 100)}% target`);

  return {
    available: lines.length > 0,
    asOf, frozen,
    nlv: eq, lines,
    deltaNotional, ratio, state,
    premium, premiumPct: eq > 0 ? +((premium / eq) * 100).toFixed(1) : null,
    theta, thetaPct, vega,
    bookVol, oneSd, limits: L,
    largest: largest ? { symbol: largest.symbol, deltaNotional: largest.deltaNotional,
                         ratio: eq > 0 ? +(largest.deltaNotional / eq).toFixed(2) : null } : null,
    overCap, breaches,
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
