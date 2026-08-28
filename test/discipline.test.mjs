// test/discipline.test.mjs — the add-to-a-loser check.
//
// The condition has to be exactly the one the record measured and no wider, because a warning that
// fires on ordinary scaling-in stops being read within a week.
import { addToLoser, ADD_TO_LOSER_EVIDENCE } from '../lib/discipline.js';
import { derivePosition, positionPnl } from '../lib/positions.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const pos = (fills, price, multiplier = 1) => {
  const derived = derivePosition(fills, { multiplier });
  return { derived, pct: positionPnl(derived, price).unrealizedPct };
};

// INTC: 30 at 98.72, marked at 91.34. Buying more is the pattern.
{
  const { derived, pct } = pos([{ side: 'buy', qty: 30, price: 98.723337, date: '2026-08-05' }], 91.34);
  const hit = addToLoser({ derived, pct, side: 'buy' });
  ok('a buy into a position that is down fires', hit);
  eq('and calls it the second buy', hit.addNumber, 2);
  eq('with the drawdown as it stands', hit.drawdownPct, -7.48);
  eq('and the average it is measured from', hit.avgCost, 98.723337);
}
// The same position in profit does not fire. Adding to a winner is a different act with a different
// record, and folding them together would make the warning meaningless.
{
  const { derived, pct } = pos([{ side: 'buy', qty: 10, price: 234.82, date: '2026-06-12' }], 256.04);
  eq('a buy into a winner is silent', addToLoser({ derived, pct, side: 'buy' }), null);
}
// A SELL is never this pattern, whatever the position is doing.
{
  const { derived, pct } = pos([{ side: 'buy', qty: 30, price: 98.72, date: '2026-08-05' }], 91.34);
  eq('selling out of a loser is not adding to one', addToLoser({ derived, pct, side: 'sell' }), null);
}
// A FIRST buy cannot be an add. This is the case that would fire on every new position if the
// condition were written as "the price is below something".
{
  const { derived, pct } = pos([], 91.34);
  eq('opening a position is not an add', addToLoser({ derived, pct, side: 'buy' }), null);
}
// Nor is one where the position exists but has no live mark — a missing price is not a loss.
{
  const { derived, pct } = pos([{ side: 'buy', qty: 30, price: 98.72, date: '2026-08-05' }], null);
  eq('no price, no judgement', addToLoser({ derived, pct, side: 'buy' }), null);
}
// Exactly flat does not fire either — the record is about losing positions, not unchanged ones.
{
  const { derived, pct } = pos([{ side: 'buy', qty: 10, price: 100, date: '2026-08-05' }], 100);
  eq('flat is not down', addToLoser({ derived, pct, side: 'buy' }), null);
}
// The add COUNT is the number of buys, not the number of fills: selling part and buying back is
// still a second buy.
{
  const { derived, pct } = pos([
    { side: 'buy', qty: 30, price: 100, date: '2026-08-01' },
    { side: 'buy', qty: 20, price: 95, date: '2026-08-03' },
    { side: 'sell', qty: 10, price: 96, date: '2026-08-04' }], 90);
  eq('this would be the third buy', addToLoser({ derived, pct, side: 'buy' }).addNumber, 3);
  eq('two so far', addToLoser({ derived, pct, side: 'buy' }).priorBuys, 2);
}
// Below-the-average is REPORTED but is not the condition. A buy above the average in a position
// that is still underwater is the same behaviour: more capital into a losing idea.
{
  const deep = pos([{ side: 'buy', qty: 30, price: 100, date: '2026-08-01' }], 90);
  eq('a fill under the average is marked', addToLoser({ ...deep, side: 'buy', fillPrice: 88 }).belowAverage, true);
  // Barely underwater, and the fill prints back above the average on a bounce. Still the same act:
  // more capital into a position that has not worked.
  const shallow = pos([{ side: 'buy', qty: 30, price: 100, date: '2026-08-01' }], 99.5);
  eq('a fill above the average still fires', addToLoser({ ...shallow, side: 'buy', fillPrice: 100.5 }).addNumber, 2);
  eq('and is marked as not below', addToLoser({ ...shallow, side: 'buy', fillPrice: 100.5 }).belowAverage, false);
  eq('with no fill price, no claim either way', addToLoser({ ...deep, side: 'buy' }).belowAverage, null);
}
// The evidence is point-in-time and says so. A figure the console cannot recompute must carry the
// date it was derived, or it becomes folklore.
ok('the finding is dated', /^\d{4}-\d{2}-\d{2}$/.test(ADD_TO_LOSER_EVIDENCE.asOf));
eq('and the cohorts add up to the record', ADD_TO_LOSER_EVIDENCE.cohortTrades + ADD_TO_LOSER_EVIDENCE.restTrades, 106);
ok('the cohort lost more than the record did', Math.abs(ADD_TO_LOSER_EVIDENCE.cohortPnl) > 16399);

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
