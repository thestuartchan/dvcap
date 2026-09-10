// test/fedpath.test.mjs — what a fed funds futures price is actually saying.
//
// The card showed three correct numbers and explained none of them: "3.955% implied · Dec-2026",
// "1.3 × 25bp HIKES priced vs EFFR 3.63%", "ZQ 96.045". Every line true, and together they still do
// not say what to do with "1.3 hikes" — which is not a thing that can happen. The Fed moves in
// quarter points, so a fractional count is a probability wearing the clothes of a forecast.
import { zqImpliedRate, zqMovesPriced, pathReading, ladder, article, STEP_PP, FLAT_MOVES, CAVEATS } from '../lib/fedpath.js';
import { assertObservational } from '../lib/read.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// The live board of 2026-09-10.
const EFFR = 3.63;

// ── the price ────────────────────────────────────────────────────────────────
{
  eq('ZQ is quoted as 100 minus the rate', zqImpliedRate(96.045), 3.955);
  eq('a quarter point is the unit', STEP_PP, 0.25);
  eq('and the move count is in those units', zqMovesPriced(3.955, EFFR), 1.3);
  eq('an unreadable price is not a rate', zqImpliedRate('x'), null);
  eq('and a missing EFFR is not a comparison', zqMovesPriced(3.955, null), null);
}

// ── the reading ──────────────────────────────────────────────────────────────
{
  // THE LIVE CASE. 1.3 quarter points above 3.63 sits between one hike (3.88) and two (4.13).
  const r = pathReading(3.955, EFFR, { contract: 'December' });
  eq('one whole move is fully priced', r.lower, 1);
  eq('with the second partway', r.upper, 2);
  eq('and the remainder stated as odds', r.oddsOfFurther, 30);
  ok('said in words a person uses', /One hike by December priced as near-certain, plus roughly a 30% chance of a further hike/.test(r.sentence));
  // NO FRACTIONAL MOVES IN THE SENTENCE. "1.3 hikes" is the thing being translated away; leaving it
  // in the prose would defeat the entire point.
  ok('and no fractional count survives into it', !/1\.3|0\.3 /.test(r.sentence));

  // Under one whole move the entire number is a probability, and saying "0 hikes plus 84%" would be
  // a worse way of putting that than the plain sentence.
  const sub = pathReading(zqImpliedRate(96.16), EFFR, { contract: 'December' });
  eq('below one move there is no whole move to name', sub.lower, 0);
  ok('so it reads as a single chance', /About an 84% chance of a single hike by December/.test(sub.sentence));

  // CUTS ARE THE SAME ARITHMETIC WITH THE OTHER SIGN, and the words have to follow.
  const cut = pathReading(3.20, EFFR, { contract: 'December' });
  eq('a lower implied rate is cuts', cut.direction, 'cut');
  ok('and never described as hikes', !/hike/i.test(cut.sentence));

  // FLAT IS A REAL STATE. Rounding 2bp into "0.1 hikes" invents a direction.
  const flat = pathReading(3.625, EFFR, { contract: 'December' });
  eq('a move under the floor is flat', flat.direction, 'flat');
  ok('and says so plainly', /exactly where it is now/.test(flat.sentence));
  ok('the floor is stated', FLAT_MOVES > 0);
  eq('no inputs, no reading', pathReading(null, EFFR), null);

  // "a 84% chance" reads as a typo. The article follows how the number is SPOKEN.
  eq('eight takes an', article(84), 'an');
  eq('eleven takes an', article(11), 'an');
  eq('eighteen takes an', article(18), 'an');
  eq('thirty takes a', article(30), 'a');
  eq('and ninety takes a', article(90), 'a');
}

// ── the arithmetic, shown ────────────────────────────────────────────────────
// The reader can check the sentence against the ladder instead of taking it on trust.
{
  const l = ladder(EFFR, { steps: 2 });
  eq('no moves is the rate itself', l[0], { moves: 0, rate: 3.63 });
  eq('one move is a quarter point up', l[1], { moves: 1, rate: 3.88 });
  eq('two is a half', l[2], { moves: 2, rate: 4.13 });
  // 3.955 sits 30% of the way from 3.88 to 4.13, which is what the sentence claims.
  ok('and the live figure sits where the words say', Math.abs((3.955 - 3.88) / 0.25 - 0.30) < 0.01);
  eq('an unreadable rate has no ladder', ladder('x'), []);
}

// ── what it does NOT say ─────────────────────────────────────────────────────
// The month-average point is the one that changes a reading. ZQ settles on the AVERAGE daily rate
// across the contract month, so a hike landing on the 16th counts for about half of December — the
// count is a floor on where the rate ends up, not an estimate of it.
{
  ok('there are caveats at all', CAVEATS.length >= 3);
  ok('the month-average settlement is one of them', CAVEATS.some(c => /average rate across the whole month/.test(c)));
  ok('so is it being an average across paths', CAVEATS.some(c => /not a forecast of one/.test(c)));
  ok('and the risk-neutral point', CAVEATS.some(c => /risk-neutral|term premium/.test(c)));
  // The card sits on a trading surface: an explanation is not licence to start advising.
  for (const c of CAVEATS) ok(`observational: "${c.slice(0, 40)}"`, assertObservational(c).ok);
  ok('and the reading itself is too', assertObservational(pathReading(3.955, EFFR, { contract: 'December' }).sentence).ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
