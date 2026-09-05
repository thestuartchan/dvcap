// lib/price.js — how a PRICE is rounded and how it is shown.
//
// Every quote was rounded with `price.toFixed(2)` the moment it left Yahoo. For an equity that is
// exactly right — cents are the unit a share trades in. For anything quoted below a dollar it is
// destruction, and it happened at the SOURCE, so nothing downstream could recover it. MJY (micro
// yen futures) prints 0.00641; stored as 0.01, the console reported buy zones 0.7% and 1.9% from
// the tape as 35% and 37% away, and sized the position off a stop distance inflated eightfold.
//
// ── WHY NOT JUST ADD TWO MORE DECIMAL PLACES ─────────────────────────────────────────────────
// Because that moves the cliff instead of removing it. `toFixed(4)` still renders SHIB, PEPE and
// BONK — all quoted around 1e-5 to 1e-6 — as exactly ZERO, and it still rounds MJY's 0.0064105 to
// 0.0064, which is a 0.7% error on a contract with a 1,250,000 multiplier. Any fixed number of
// decimal places encodes an assumption about scale, and this book spans BTC at 111,000 to SHIB at
// 0.0000089: eleven orders of magnitude. There is no number of decimals that serves both.
//
// SIGNIFICANT FIGURES have no such assumption, which is the whole reason to use them. So:
//
//   STORAGE does not decide precision at all. Twelve significant figures is far beyond what any
//   venue quotes and exists only to normalise floating-point representation — the stored number is
//   the quote. An earlier version of this file kept `toFixed(2)` above $1 "to avoid a regression",
//   which quietly cost XRP its real 2.4471 by storing 2.45. Refusing to round is simpler and has
//   no such edge.
//
//   DISPLAY is where a decision belongs, and it is eight significant figures with a floor of two
//   decimals: enough for BTC to keep its cents and for SHIB to keep its digits, without printing a
//   tail of zeros on an ordinary share.

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

export const STORE_SIG = 12;    // not a precision decision — just float-noise normalisation
export const DISPLAY_SIG = 8;   // where the decision actually is
export const MIN_DP = 2;        // an ordinary price never reads as "18.1"
export const MAX_DP = 12;

// What to persist for a fetched quote. Deliberately loses nothing a venue could have meant.
export function roundQuote(v) {
  const n = num(v);
  if (n == null) return null;
  if (n === 0) return 0;
  return +n.toPrecision(STORE_SIG);
}

// Decimal places that give `sig` significant figures at this magnitude.
const dpFor = (a, sig) => Math.min(MAX_DP, Math.max(MIN_DP, sig - 1 - Math.floor(Math.log10(a))));

// What to SHOW. Trailing zeros are trimmed below the two-decimal floor, so 0.006452 and 0.00629
// read as themselves where `toFixed(4)` collapsed them to "0.0065" and "0.0063".
export function fmtPrice(v, { dash = '—' } = {}) {
  const n = num(v);
  if (n == null) return dash;
  const a = Math.abs(n);
  if (a === 0) return '0.00';
  const out = n.toFixed(dpFor(a, DISPLAY_SIG)).replace(/(\.\d\d[0-9]*?)0+$/, '$1');
  // A NON-ZERO PRICE MUST NEVER READ AS ZERO — the same rule the level distances follow. Below
  // about 1e-10 no decimal string survives the cap, so the format changes rather than the claim.
  return (+out === 0) ? n.toExponential(4) : out;
}

// Two prices that are genuinely different must never render as the same string. Stated here so the
// tests can assert the property rather than a list of examples of it.
export const distinctlyShown = (a, b) => fmtPrice(a) !== fmtPrice(b);
