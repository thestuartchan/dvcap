// test/lotbasis.test.mjs — the two cost bases a partially exited position has.
//
// This engine is average-cost and deliberately so: a sell never moves avgCost, which is what keeps
// R multiples and scale-out percentages comparable across a position's whole life. A broker
// reporting the same position matches the sale to specific lots — FIFO unless the account says
// otherwise — and reports what the REMAINING lots cost. Both are right. They cannot be equal.
//
// Built against the real ARM row as it stood 2026-09-09, so the numbers below are the ones on the
// screen rather than invented ones that happen to divide nicely.
import { derivePosition, fifoOpenLots } from '../lib/positions.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const near = (n, g, w, tol) => { const good = g != null && Math.abs(g - w) <= tol;
  console.log(`${good ? '✅' : '❌'} ${n}` + (good ? '' : `  got ${g} want ${w} ±${tol}`)); good ? pass++ : fail++; };

const ARM = [
  { side: 'buy',  qty: 8, price: 321.855,  date: '2026-06-10' },
  { side: 'buy',  qty: 1, price: 409.17,   date: '2026-06-22' },
  { side: 'sell', qty: 8, price: 295.6375, date: '2026-07-07' },
  { side: 'buy',  qty: 9, price: 237.3,    date: '2026-09-03' },
];

// ── the real row, both ways ──────────────────────────────────────────────────
{
  const d = derivePosition(ARM, { side: 'long' });
  // The average-cost engine, unchanged. Pinned because the new field must not perturb it.
  eq('10 shares remain', d.qty, 10);
  eq('average cost is unmoved by the sale', d.avgCost, 246.725667);
  near('and the realised loss is the sale against it', d.realized, -287.35, 0.01);

  // FIFO: the sale of 8 consumes the FIRST 8 shares, at 321.855 — not a pro-rata slice.
  eq('the lot basis is what remains after FIFO', d.fifoBasis, 254.487);
  eq('and the surviving lots are named', d.fifoLots,
    [{ qty: 1, price: 409.17, date: '2026-06-22' }, { qty: 9, price: 237.3, date: '2026-09-03' }]);
  // The oldest lot went entirely; the middle one is untouched.
  ok('the consumed lot is gone', !d.fifoLots.some(l => l.price === 321.855));

  // The two bases must NOT be equal — that is the whole finding.
  ok('the two bases differ', d.avgCost !== d.fifoBasis);
  near('by 7.76 a share', d.fifoBasis - d.avgCost, 7.761333, 1e-5);
  // Direction matters: FIFO removed the 8-share 321.855 lot, leaving the single 409.17 share as a
  // tenth of a smaller position, which lifts the remainder above the lifetime average.
  ok('the lot basis is the higher of the two here', d.fifoBasis > d.avgCost);

  // What IBKR actually reported that day, and why it is not exactly the FIFO figure: $1.18 of
  // commission on the 09-03 buy, carried in their basis and not in the fill price here.
  const IBKR = 254.605003;
  near('IBKR sits just above FIFO', (IBKR - d.fifoBasis) * 10, 1.18, 0.01);
}

// ── when it is meaningful, and when it is noise ──────────────────────────────
{
  // Nothing sold: the two bases are identical by construction, so printing both would be noise.
  const open = derivePosition(ARM.filter(f => f.side === 'buy'), { side: 'long' });
  eq('an unexited position reports no lot basis', open.fifoBasis, null);
  eq('nor its lots', open.fifoLots, null);
  ok('though it still has an average cost', open.avgCost > 0);

  // Fully closed: nothing remains to have a basis.
  const shut = derivePosition([...ARM, { side: 'sell', qty: 10, price: 264, date: '2026-09-09' }], { side: 'long' });
  eq('a closed position reports no lot basis', shut.fifoBasis, null);
}

// ── the mechanics ────────────────────────────────────────────────────────────
{
  // A close that eats PART of a lot leaves the remainder at its own price — not re-averaged.
  const partial = fifoOpenLots([
    { side: 'buy', qty: 10, price: 100, date: '2026-01-01' },
    { side: 'buy', qty: 10, price: 200, date: '2026-01-02' },
    { side: 'sell', qty: 5, price: 150, date: '2026-01-03' },
  ], { side: 'long' });
  eq('a half-eaten lot keeps its own price', partial.lots, [
    { qty: 5, price: 100, date: '2026-01-01' }, { qty: 10, price: 200, date: '2026-01-02' }]);
  near('and the basis weights what is left', partial.basis, (5 * 100 + 10 * 200) / 15, 1e-6);

  // Date order decides FIFO, not the order the fills were typed in.
  const shuffled = fifoOpenLots([
    { side: 'sell', qty: 5, price: 150, date: '2026-01-03' },
    { side: 'buy', qty: 10, price: 200, date: '2026-01-02' },
    { side: 'buy', qty: 10, price: 100, date: '2026-01-01' },
  ], { side: 'long' });
  eq('fills are sorted by date before matching', shuffled.lots, partial.lots);

  // A SHORT opens on a sell, so FIFO consumes the oldest SELLS when it is bought back.
  const short = fifoOpenLots([
    { side: 'sell', qty: 10, price: 100, date: '2026-01-01' },
    { side: 'sell', qty: 10, price: 200, date: '2026-01-02' },
    { side: 'buy', qty: 10, price: 150, date: '2026-01-03' },
  ], { side: 'short' });
  eq('a short consumes its oldest sells', short.lots, [{ qty: 10, price: 200, date: '2026-01-02' }]);
  eq('leaving that basis', short.basis, 200);

  // Closing more than was ever opened is a data error the average-cost path already clamps and
  // warns about. Counted here rather than thrown, so the two engines report the same shape.
  const over = fifoOpenLots([
    { side: 'buy', qty: 5, price: 100, date: '2026-01-01' },
    { side: 'sell', qty: 8, price: 150, date: '2026-01-02' },
  ], { side: 'long' });
  eq('an oversell empties the lots', over.lots, []);
  eq('reports no basis', over.basis, null);
  eq('and counts the excess rather than throwing', over.overSold, 3);

  // Degenerate input must not throw.
  eq('no fills is an empty book', fifoOpenLots([], { side: 'long' }).basis, null);
  eq('nor does a null call', fifoOpenLots(null, { side: 'long' }).basis, null);
  // Priceless or quantity-less rows are dropped, matching the average-cost path's own filter.
  eq('an incomplete fill is ignored',
    fifoOpenLots([{ side: 'buy', qty: 5, date: '2026-01-01' }, { side: 'buy', qty: 2, price: 50, date: '2026-01-02' }], { side: 'long' }).basis, 50);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
