// lib/fedpath.js — what a fed funds futures price is actually saying.
//
// ── THE CARD SHOWED THREE TRUE NUMBERS AND EXPLAINED NONE OF THEM ────────────
//   3.955% implied · Dec-2026
//   1.3 × 25bp HIKES priced vs EFFR 3.63%
//   ZQ 96.045 (100 − price = implied rate)
//
// Every line is correct. Together they still do not say what a reader is supposed to do with
// "1.3 hikes", which is not a thing that can happen — the Fed moves in quarter points, so a
// fractional count is a probability wearing the clothes of a forecast.
//
// ── WHAT THE CONTRACT SETTLES ON, AND WHY IT MATTERS ─────────────────────────
// ZQ settles to the AVERAGE daily effective fed funds rate across the contract MONTH — not the rate
// at the end of it. That is not a technicality:
//
//   - A hike that lands before the month starts counts for all of it.
//   - A hike on the 16th counts for about half.
//
// So a December contract implying 1.3 hikes is consistent with more than 1.3 hikes having happened
// by New Year's Eve, if any of them land inside December. The count is a floor on where the rate
// ends up, not an estimate of it, and the card said nothing about that.
//
// ── AND IT IS AN AVERAGE ACROSS PATHS ────────────────────────────────────────
// 1.3 can be "one hike certain plus a 30% chance of a second", or "65% chance of two and nothing
// otherwise". Those are different trades and the number cannot tell them apart. What it CAN say is
// which whole moves it brackets, and how far between them it sits — which is the honest reading and
// the one this file produces.
//
// It is also RISK-NEUTRAL: term premium is inside the price, so it is not a clean probability. The
// card says so rather than implying the market has a view it can be held to.

// The Fed moves in quarter points. Everything here is expressed in them because that is the unit
// the decision is actually taken in.
export const STEP_PP = 0.25;

// ZQ is quoted as 100 − the implied average rate for the contract month.
export function zqImpliedRate(price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  return +(100 - p).toFixed(4);
}

// Moves vs current EFFR, in quarter points. Sign carries direction: + = hikes priced.
export function zqMovesPriced(impliedRate, effr) {
  if (impliedRate == null || effr == null) return null;
  const a = Number(impliedRate), b = Number(effr);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return +((a - b) / STEP_PP).toFixed(2);
}

// Below this the contract is not pricing a move, it is pricing noise, and rounding it into "0.1
// hikes" invents a direction. A tenth of a quarter point is 2.5bp.
export const FLAT_MOVES = 0.1;

// ── THE READING ──────────────────────────────────────────────────────────────
// Brackets the fractional count between the two whole moves it sits between, and states the
// remainder as what it is: the market's odds on the further one.
export function pathReading(impliedRate, effr, { contract = null } = {}) {
  const moves = zqMovesPriced(impliedRate, effr);
  if (moves == null) return null;
  const dir = moves > 0 ? 'hike' : 'cut';
  const mag = Math.abs(moves);
  const when = contract ? ` by ${contract}` : '';

  if (mag < FLAT_MOVES) {
    return {
      moves, direction: 'flat', lower: 0, upper: 0, oddsOfFurther: null,
      sentence: `The market expects the Fed to be exactly where it is now${when} — no move priced either way.`,
    };
  }

  const lower = Math.floor(mag);              // whole moves fully priced
  const upper = Math.ceil(mag);               // the one it is partway toward
  const odds = Math.round((mag - lower) * 100);
  const word = (n) => n === 1 ? `one ${dir}` : `${n} ${dir}s`;

  let sentence;
  if (lower === 0) {
    // Less than one whole move: the entire number is a probability.
    sentence = `About ${article(odds)} ${odds}% chance of a single ${dir}${when}, and nothing more — the rest of the price is the Fed staying put.`;
  } else if (odds < 10) {
    sentence = `${cap(word(lower))}${when}, priced as near-certain, with nothing meaningful beyond it.`;
  } else {
    sentence = `${cap(word(lower))}${when} priced as near-certain, plus roughly ${article(odds)} ${odds}% chance of a further ${dir}.`;
  }
  return { moves, direction: dir, lower, upper, oddsOfFurther: odds, sentence };
}

const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;

// "a 84% chance" reads as a typo. The article follows how the number is SPOKEN, not how it is
// spelled: eight, eleven and eighteen take "an", and so does anything beginning with them.
export function article(n) {
  const s = String(Math.abs(Math.round(n)));
  return (s[0] === '8' || s === '11' || s === '18' || s.startsWith('11') || s.startsWith('18')) ? 'an' : 'a';
}

// The rate the contract implies if exactly N whole moves land BEFORE the contract month begins —
// the reference points the fractional reading sits between, so a reader can check the arithmetic
// rather than take the sentence on trust.
export function ladder(effr, { steps = 3 } = {}) {
  const b = Number(effr);
  if (!Number.isFinite(b)) return [];
  return Array.from({ length: steps + 1 }, (_, i) => ({ moves: i, rate: +(b + i * STEP_PP).toFixed(3) }));
}

// The three things the number does NOT say, stated once so the card cannot imply them.
export const CAVEATS = Object.freeze([
  'the contract settles on the average rate across the whole month, so a move landing mid-month counts for only part of it — the count is a floor on where the rate ends up, not an estimate of it',
  'it is an average across every path the market is weighing, not a forecast of one — the same number can mean one certain move or a coin flip on two',
  'it is risk-neutral: term premium sits inside the price, so the odds it implies are not quite probabilities',
]);
