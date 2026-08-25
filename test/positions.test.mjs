// Regression tests for lib/positions.js — fill-based accounting for scaled spot/swing positions.
import { derivePosition, positionPnl, levelHit, distancePct, summarize, realizedCurve } from '../lib/positions.js';
let pass=0,fail=0;
const eq=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);console.log(`${ok?'✅':'❌'} ${n}`+(ok?'':`  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`));ok?pass++:fail++;};

// ── lifecycle is derived ──
eq('no fills -> setup', derivePosition([]).status, 'setup');
eq('setup has no qty', derivePosition([]).qty, 0);

// ── scale IN: weighted average cost ──
const scaledIn = derivePosition([
  {date:'2026-08-01', side:'buy', qty:100, price:10},
  {date:'2026-08-10', side:'buy', qty:100, price:20},
]);
eq('scale-in qty', scaledIn.qty, 200);
eq('scale-in avg cost', scaledIn.avgCost, 15);
eq('scale-in still open', scaledIn.status, 'open');
eq('scale-in nothing realised', scaledIn.realized, 0);

// ── THE KEY CASE: open AND realising at the same time ──
const partial = derivePosition([
  {date:'2026-08-01', side:'buy',  qty:300, price:10},
  {date:'2026-08-15', side:'sell', qty:100, price:15},   // scale out a third at +50%
]);
eq('partial: still open', partial.status, 'open');
eq('partial: qty remaining', partial.qty, 200);
eq('partial: realised', partial.realized, 500);          // 100 x (15-10)
eq('partial: avg cost UNCHANGED by the sell', partial.avgCost, 10);
eq('partial: flagged partiallyRealised', partial.partiallyRealised, true);
eq('partial: return measured on capital taken out', partial.realizedPct, 50);

// unrealised rides on the remainder
const pnl = positionPnl(partial, 18);
eq('unrealised on remainder', pnl.unrealized, 1600);     // 200 x (18-10)
eq('realised preserved', pnl.realized, 500);
eq('total P&L', pnl.total, 2100);
eq('market value', pnl.marketValue, 3600);

// ── full exit closes it ──
const closed = derivePosition([
  {date:'2026-08-01', side:'buy',  qty:100, price:10},
  {date:'2026-08-10', side:'sell', qty:100, price:12},
]);
eq('full exit -> closed', closed.status, 'closed');
eq('closed qty zero', closed.qty, 0);
eq('closed realised', closed.realized, 200);
eq('closed avg cost cleared', closed.avgCost, null);
eq('no unrealised when flat', positionPnl(closed, 99).unrealized, null);

// ── fills apply in DATE order regardless of array order ──
const outOfOrder = derivePosition([
  {date:'2026-08-10', side:'buy', qty:100, price:20},
  {date:'2026-08-01', side:'buy', qty:100, price:10},
]);
eq('date-ordered avg cost', outOfOrder.avgCost, 15);

// ── overselling is a data error, clamped and reported ──
const over = derivePosition([
  {date:'2026-08-01', side:'buy',  qty:50, price:10},
  {date:'2026-08-02', side:'sell', qty:80, price:12},
]);
eq('oversell clamps to held', over.qty, 0);
eq('oversell realises only what was held', over.realized, 100);
eq('oversell warns', over.warnings.length, 1);

// ── an incomplete fill is RETAINED, not silently dropped ──
// This is the bug that put nine held positions in "Setups": the import knew the price but not the
// quantity, and dropping the fill quietly reclassified a real position as an untaken idea.
const incomplete = derivePosition([{id:'f0', side:'buy', qty:null, price:107.01}]);
eq('incomplete fill keeps position OPEN', incomplete.status, 'open');
eq('incomplete fill flagged', incomplete.needsQty, true);
eq('incomplete fill retained', incomplete.incomplete.length, 1);
eq('incomplete fill not counted as a real fill', incomplete.nFills, 0);
eq('no average invented from it', incomplete.avgCost, null);
// Once the quantity is supplied it becomes an ordinary fill.
const repaired = derivePosition([{id:'f0', side:'buy', qty:100, price:107.01}]);
eq('repaired -> not flagged', repaired.needsQty, false);
eq('repaired -> avg cost', repaired.avgCost, 107.01);

// ── junk fills are dropped, not guessed ──
eq('drops malformed fills', derivePosition([{side:'buy',qty:'abc',price:10},{side:'nope',qty:1,price:1}]).nFills, 0);

// ── levels: zones and directions ──
eq('buy zone hit inside range', levelHit({kind:'buy',at:92,to:96}, 94), true);
eq('buy zone missed outside',   levelHit({kind:'buy',at:92,to:96}, 99), false);
eq('buy point hit below',       levelHit({kind:'buy',at:100}, 98), true);
eq('sell target hit above',     levelHit({kind:'sell',at:120}, 121), true);
eq('sell target not yet',       levelHit({kind:'sell',at:120}, 119), false);
eq('stop breached below',       levelHit({kind:'stop',at:90}, 89), true);
eq('stop intact',               levelHit({kind:'stop',at:90}, 95), false);
eq('no price -> no hit',        levelHit({kind:'buy',at:100}, null), false);
eq('distance to level %',       distancePct({at:110}, 100), 10);

// ── roll-up excludes what it cannot convert rather than mixing currencies ──
const rows=[
  {symbol:'A', currency:'USD', derived:derivePosition([{date:'1',side:'buy',qty:10,price:10},{date:'2',side:'sell',qty:10,price:12}]), pnl:{unrealized:null,marketValue:null}},
  {symbol:'B', currency:'HKD', derived:derivePosition([{date:'1',side:'buy',qty:10,price:10}]), pnl:{unrealized:100,marketValue:1000}},
];
const idOnly = summarize(rows, (v,ccy) => ccy==='USD'? v : null);
eq('closed counted', idOnly.closed, 1);
eq('open counted', idOnly.open, 1);
eq('unconvertible excluded from totals', idOnly.unrealized, 0);
eq('unconverted counted', idOnly.unconverted, 1);
eq('win rate on closed only', idOnly.winRate, 100);

// ── realised curve accrues per SELL, cumulatively ──
const curve = realizedCurve([
 {symbol:'A', currency:'USD', derived:derivePosition([
   {date:'2026-08-01',side:'buy',qty:200,price:10},
   {date:'2026-08-05',side:'sell',qty:100,price:15},
   {date:'2026-08-09',side:'sell',qty:100,price:20},
 ])},
], v=>v);
eq('curve points = sells', curve.length, 2);
eq('curve first gain', curve[0].gain, 500);
eq('curve cumulative', curve[1].cumulative, 1500);

console.log(fail?`\n❌ ${fail} FAILED`:`\n✅ ALL ${pass} PASSED`);
process.exit(fail?1:0);
