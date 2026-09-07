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
//   DISPLAY is where a decision belongs, and it is a decision about SCALE, not about digits.
//   Eight significant figures was the first answer and it was wrong above a dollar: an average
//   cost is a weighted mean of fills, so it arrives with as many decimals as the arithmetic
//   produced, and the card printed "avg 63.921452" and "avg 246.72567" — six and five decimals of
//   division residue, read as though they were precision. Nobody holds a basis to a hundredth of a
//   cent and no decision turns on one.
//
//   At or above a unit, TWO DECIMALS. That is what a share, an index, a future and a coin at four
//   figures are all quoted in, and it is what a reader expects. Below a unit the same two decimals
//   destroy the number — MJY at 0.0064 becomes 0.01 — so significant figures take over there.
//   The boundary needs no instrument hint: the things that need more digits are the things priced
//   under a dollar, which is exactly where the rule already changes.

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

export const STORE_SIG = 12;    // not a precision decision — just float-noise normalisation
export const DISPLAY_SIG = 8;   // where the decision actually is
export const MIN_DP = 2;        // an ordinary price never reads as "18.1"
// How far past two decimals a price is allowed to go above a dollar. Two is right for a share,
// which is quoted in cents and nothing finer. A coin is not: XRP prints 2.4471 and the two hundred
// and fortieth of a percent between that and 2.45 is a real quote, not arithmetic residue. The
// caller says which it is holding — this file knows numbers, not instruments.
export const CRYPTO_MAX_DP = 4;
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
export function fmtPrice(v, { dash = '—', maxDp = MIN_DP } = {}) {
  const n = num(v);
  if (n == null) return dash;
  const a = Math.abs(n);
  if (a === 0) return '0.00';
  // At or above a unit: `maxDp` decimals, trailing zeros trimmed back to the two-decimal floor —
  // so a coin shows 2.4471 and 106.05, not 106.0500. Below a unit: significant figures, where two
  // decimals would erase the value entirely.
  const cap = Math.max(MIN_DP, Math.min(MAX_DP, Number.isFinite(+maxDp) ? +maxDp : MIN_DP));
  const out = a >= 1
    ? n.toFixed(cap).replace(/(\.\d\d[0-9]*?)0+$/, '$1')
    : n.toFixed(dpFor(a, DISPLAY_SIG)).replace(/(\.\d\d[0-9]*?)0+$/, '$1');
  // A NON-ZERO PRICE MUST NEVER READ AS ZERO — the same rule the level distances follow. Below
  // about 1e-10 no decimal string survives the cap, so the format changes rather than the claim.
  return (+out === 0) ? n.toExponential(4) : out;
}

// Two prices that are genuinely different must never render as the same string. Stated here so the
// tests can assert the property rather than a list of examples of it.
export const distinctlyShown = (a, b) => fmtPrice(a) !== fmtPrice(b);
