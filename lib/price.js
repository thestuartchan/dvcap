// lib/price.js — how a PRICE is rounded and how it is shown.
//
// Every quote was rounded with `price.toFixed(2)` the moment it left Yahoo. For an equity that is
// exactly right — cents are the unit a share trades in. For anything quoted below a dollar it is
// destruction, and it happened at the SOURCE, so nothing downstream could recover it.
//
// MJY (micro yen futures) prints 0.00641. Stored as 0.01, the console reported two buy zones at
// 0.006452 and 0.00629 as "35.48% below the last price" and "37.1% below" — they are 0.7% and 1.9%
// away. That is not a display complaint: the distance, the ±0.25% trigger tolerance, and the
// per-unit risk that sizes the position are all computed from the stored number, so the row was
// wrong about how close it was, would not have fired when it should, and would have sized off a
// stop distance inflated by more than an order of magnitude.
//
// So rounding is now a function of SCALE rather than a fixed two places. Prices at or above one
// unit keep the old behaviour exactly — no equity, index or ordinary future changes by a cent —
// and everything below it keeps significant figures instead of decimal places.

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// Significant figures kept when a quote is stored. Six is far more than any instrument here
// quotes to, which is the point: storage should not be where precision is decided.
export const QUOTE_SIG = 6;

// What to persist for a fetched quote. At or above 1.0 this is `toFixed(2)`, unchanged.
export function roundQuote(v) {
  const n = num(v);
  if (n == null) return null;
  const a = Math.abs(n);
  if (a === 0) return 0;
  if (a >= 1) return +n.toFixed(2);
  return +n.toPrecision(QUOTE_SIG);
}

// What to SHOW. Four significant figures below a dollar, trailing zeros trimmed but never below
// two decimals — so 0.006452 and 0.00629 read as themselves rather than collapsing to one string.
// The old display rule (`toFixed(4)` under 1.0) rendered them "0.0065" and "0.0063", which is
// legible and still wrong by enough to matter on a 1,250,000-multiplier contract.
export function fmtPrice(v, { dash = '—' } = {}) {
  const n = num(v);
  if (n == null) return dash;
  const a = Math.abs(n);
  if (a === 0) return '0.00';
  if (a >= 1) return n.toFixed(2);
  const dp = Math.min(10, 3 - Math.floor(Math.log10(a)));       // four significant figures
  return n.toFixed(dp).replace(/(\.\d\d[0-9]*?)0+$/, '$1');
}

// Two prices that are genuinely different must never render as the same string. Used by the tests
// to state that property directly rather than by listing examples of it.
export const distinctlyShown = (a, b) => fmtPrice(a) !== fmtPrice(b);
