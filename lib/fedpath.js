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

// ── THE NEXT MEETING, PRICED ─────────────────────────────────────────────────
// "September hike odds" was a number copied by hand from FedWatch on 2026-08-24 — and it kept
// rendering for a month after the September meeting had hiked. The same answer is in the ZQ curve
// this file already reads, so it is derived instead: for each decision, the contract for the first
// month AFTER it with no decision of its own settles wholly at the post-meeting rate, so
// (implied − EFFR) / 25bp is the market's expected move AT that meeting. Where no such month is on
// the curve, the meeting month itself is used with the day-weighting the average implies.
//
// Decision days (the second day of each meeting), from federalreserve.gov/monetarypolicy/
// fomccalendars.htm as published 2026-09-27. A meeting past the end of this list reads as unknown,
// never as the last one repeated.
export const FOMC_DECISIONS = Object.freeze([
  '2026-10-28', '2026-12-09',
  '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08',
]);

const monthOf = (iso) => String(iso).slice(0, 7);
const nextMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const daysIn = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

// `feed` is api/indicators' fedPathFeed: { effr, contracts: [{ month: 'YYYY-MM', impliedRate, ok }] }.
export function nextMeetingOdds(feed, { today = new Date().toISOString().slice(0, 10), decisions = FOMC_DECISIONS } = {}) {
  const effr = Number(feed?.effr);
  if (!Number.isFinite(effr)) return null;
  const meeting = decisions.find(d => d > today);
  if (!meeting) return null;
  const byMonth = new Map((feed?.contracts || []).filter(c => c?.ok !== false && Number.isFinite(Number(c?.impliedRate))).map(c => [c.month, c]));
  const decMonths = new Set(decisions.map(monthOf));
  let post = null, method = null, contract = null;
  const after = nextMonth(monthOf(meeting));
  if (!decMonths.has(after) && byMonth.has(after)) {
    contract = byMonth.get(after); post = Number(contract.impliedRate); method = 'the month after, which holds no meeting';
  } else if (byMonth.has(monthOf(meeting))) {
    // The move takes effect the day after the decision: d days at the old rate, N − d at the new.
    contract = byMonth.get(monthOf(meeting));
    const N = daysIn(monthOf(meeting)), d = Number(meeting.slice(8, 10));
    if (N - d < 3) return null;   // two days of weight is noise, not a price
    post = (Number(contract.impliedRate) - (d / N) * effr) * N / (N - d);
    method = 'the meeting month, day-weighted';
  }
  if (post == null) return null;
  const moves = +((post - effr) / STEP_PP).toFixed(2);
  const pct = (x) => Math.max(0, Math.min(100, Math.round(x * 100)));
  return {
    meeting, contract: contract.label || contract.month, method, effr, impliedPost: +post.toFixed(3), moves,
    hikePct: moves > 0 ? pct(moves) : 0, cutPct: moves < 0 ? pct(-moves) : 0,
    asOf: contract.date || feed.asOf || null,
  };
}
