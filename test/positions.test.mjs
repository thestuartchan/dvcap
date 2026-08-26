// Regression tests for lib/positions.js — fill-based accounting for scaled spot/swing positions.
import { splitIntoTrades, collapseFills, derivePosition, positionPnl, levelHit, distancePct, summarize, realizedCurve } from '../lib/positions.js';
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

// ── lifetime averages survive the exit (the archive's entry/exit columns) ──
const rt = derivePosition([
  {date:'2026-08-05', side:'buy',  qty:200, price:21.405003},
  {date:'2026-08-07', side:'sell', qty:200, price:21.393403},
]);
eq('round trip is closed', rt.status, 'closed');
eq('avgCost cleared once flat', rt.avgCost, null);
eq('avgEntry survives the exit', rt.avgEntry, 21.405003);
eq('avgExit survives the exit', rt.avgExit, 21.393403);
eq('realised reconciles to the broker', rt.realized, -2.32);

// Averages are weighted by SIZE, not by fill count — the whole point of collapsing a scaled
// entry into one figure is that a 596-lot and a 4-lot must not count equally.
const wt = derivePosition([
  {date:'2026-08-18', side:'buy', qty:596, price:18.059},
  {date:'2026-08-18', side:'buy', qty:4,   price:18.06},
]);
eq('weighted entry, not the mean of prices', wt.avgEntry, 18.059007);
eq('spent tracks buy notional', wt.spent, 10835.4);
eq('no exit yet', wt.avgExit, null);

// A scale-out reports the average of what actually left, not of the whole position.
const so = derivePosition([
  {date:'2026-08-01', side:'buy',  qty:100, price:10},
  {date:'2026-08-02', side:'buy',  qty:100, price:20},
  {date:'2026-08-03', side:'sell', qty:50,  price:30},
]);
eq('entry averages both buys', so.avgEntry, 15);
eq('exit averages only the sold', so.avgExit, 30);
eq('still open', so.status, 'open');

// A setup has no averages at all rather than zeroes, so the UI can print "—".
const st = derivePosition([]);
eq('setup has no entry', st.avgEntry, null);
eq('setup has no exit', st.avgExit, null);

// ── contract multiplier: money scales, quoted prices and percentages do not ──
const opt = derivePosition([
  {date:'2026-07-28', side:'buy',  qty:8, price:2.98894},
  {date:'2026-07-30', side:'sell', qty:8, price:2.39914},
], {multiplier: 100});
eq('option entry stays a PREMIUM', opt.avgEntry, 2.98894);
eq('option exit stays a PREMIUM', opt.avgExit, 2.39914);
eq('realised is in DOLLARS', opt.realized, -471.84);
eq('spent is in dollars', opt.spent, 2391.15);
eq('multiplier reported back', opt.multiplier, 100);

// The same fills without a multiplier must be 100x smaller — proving the scaling is real and
// that every existing equity row is untouched by this change.
const asShares = derivePosition(opt.fills);
eq('default multiplier is 1', asShares.multiplier, 1);
eq('shares realised is 1/100th', asShares.realized, -4.72);
eq('shares entry identical', asShares.avgEntry, opt.avgEntry);

// Live P&L: dollars scale, the percentage move in the premium does not.
const live = derivePosition([{date:'2026-08-01', side:'buy', qty:2, price:5}], {multiplier: 100});
const lp = positionPnl(live, 7.5);
eq('option market value in dollars', lp.marketValue, 1500);
eq('option unrealised in dollars', lp.unrealized, 500);
eq('percentage is the premium move', lp.unrealizedPct, 50);
eq('shares percentage matches', positionPnl(derivePosition(live.fills), 7.5).unrealizedPct, 50);

// A nonsense multiplier falls back to 1 rather than zeroing or NaN-ing the whole book.
eq('zero multiplier rejected', derivePosition(live.fills, {multiplier: 0}).multiplier, 1);
eq('junk multiplier rejected', derivePosition(live.fills, {multiplier: 'x'}).multiplier, 1);

// ── splitting a symbol into separate trades ──
const METU = [
  {id:'a', date:'2026-08-05', side:'buy',  qty:40,  price:21.425},
  {id:'b', date:'2026-08-05', side:'buy',  qty:160, price:21.4},
  {id:'c', date:'2026-08-07', side:'sell', qty:200, price:21.3944},
  {id:'d', date:'2026-08-18', side:'buy',  qty:596, price:18.064},
  {id:'e', date:'2026-08-18', side:'buy',  qty:4,   price:18.065},
];
const trips = splitIntoTrades(METU);
eq('METU is two trades, not one', trips.length, 2);
eq('first trade is the round trip', trips[0].map(f=>f.id).join(''), 'abc');
eq('second trade is the open one', trips[1].map(f=>f.id).join(''), 'de');
eq('first trade closes flat', derivePosition(trips[0]).status, 'closed');
eq('second trade is open', derivePosition(trips[1]).status, 'open');
eq('realised follows the closed one', derivePosition(trips[0]).realized, -2.12);
eq('and none follows the open one', derivePosition(trips[1]).realized, 0);

// A scale-out that never reaches flat is ONE trade, however many fills it has.
eq('partial exit does not split', splitIntoTrades([
  {date:'2026-08-01', side:'buy',  qty:200, price:10},
  {date:'2026-08-02', side:'sell', qty:50,  price:12},
  {date:'2026-08-03', side:'buy',  qty:100, price:11},
]).length, 1);
eq('no fills, no trades', splitIntoTrades([]).length, 0);
// A closing leg with no recorded entry is its own trade, not a short.
const orphan = splitIntoTrades([
  {date:'2026-08-19', side:'sell', qty:150, price:10.56},
  {date:'2026-08-20', side:'buy',  qty:100, price:9},
]);
eq('leading sell stands alone', orphan.length, 2);
eq('and does not go short', orphan[0].length, 1);

// ── collapsing fills, only when it is arithmetically safe ──
const c1 = collapseFills(trips[0]);
eq('collapses 3 fills to 2', `${c1.from}->${c1.to}`, '3->2');
eq('weighted, not averaged', c1.fills[0].price, 21.405);
eq('sell survives intact', c1.fills[1].qty, 200);
eq('collapse was exact', c1.exact, true);
eq('no P&L drift', c1.delta, 0);

const c2 = collapseFills(trips[1]);
eq('two buys become one', c2.to, 1);
eq('weighted buy price', c2.fills[0].price, 18.064007);

// A CLOSED trade is order-independent: everything bought is sold, so interleaving cannot move
// realised P&L and the collapse must come back exact however tangled the fills were.
const tangled = collapseFills([
  {date:'2026-08-01', side:'buy',  qty:100, price:10},
  {date:'2026-08-02', side:'sell', qty:100, price:20},
  {date:'2026-08-03', side:'buy',  qty:100, price:30},
  {date:'2026-08-04', side:'sell', qty:100, price:40},
]);
eq('closed trade collapses exactly', tangled.exact, true);
eq('closed trade keeps its P&L', tangled.delta, 0);

// An OPEN trade that has already sold part is the real hazard: the sell was measured against the
// average at that moment, and folding a later buy into one bulk average moves it. The function
// must SAY so rather than quietly rewriting the trade.
const risky = collapseFills([
  {date:'2026-08-01', side:'buy',  qty:100, price:10},
  {date:'2026-08-02', side:'sell', qty:50,  price:20},
  {date:'2026-08-03', side:'buy',  qty:100, price:30},
]);
eq('open + partial sell flagged inexact', risky.exact, false);
eq('and reports the drift', risky.delta, -500);

// Multiplier is respected when checking exactness.
eq('option collapse stays exact', collapseFills([
  {date:'2026-07-28', side:'buy',  qty:5, price:3},
  {date:'2026-07-28', side:'buy',  qty:3, price:3.2},
  {date:'2026-07-30', side:'sell', qty:8, price:2.4},
], {multiplier: 100}).exact, true);

// ── the percentage that matches the money ──
const simple = derivePosition([{date:'2026-08-18', side:'buy', qty:600, price:18.064007}]);
const sp = positionPnl(simple, 19.66);
eq('total return = price move when nothing sold', sp.totalPct, sp.unrealizedPct);
eq('and it is the right number', sp.totalPct, 8.84);   // matches the expanded card

// After a scale-out the two diverge, and totalPct is the one that pairs with the money.
const scaled = derivePosition([
  {date:'2026-08-01', side:'buy',  qty:200, price:10},
  {date:'2026-08-05', side:'sell', qty:100, price:15},
]);
const scp = positionPnl(scaled, 12);
eq('realised on the half sold', scaled.realized, 500);
eq('unrealised on the half held', scp.unrealized, 200);
eq('total money', scp.total, 700);
eq('price move from average cost', scp.unrealizedPct, 20);
eq('return on everything deployed', scp.totalPct, 35);

eq('a setup has no return', positionPnl(derivePosition([]), 10).totalPct, null);

console.log(fail?`\n❌ ${fail} FAILED`:`\n✅ ALL ${pass} PASSED`);
process.exit(fail?1:0);
