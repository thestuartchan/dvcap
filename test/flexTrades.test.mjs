// test/flexTrades.test.mjs — turning the statement's Trades section into fills.
//
// The property that matters most is not that a trade is recorded correctly; it is that a trade
// recorded INcorrectly cannot reach the console. Every plan is applied to a copy and held against
// the Open Positions section of the same statement, and a batch that does not reconcile is
// discarded whole. Most of what follows is about that gate.
import { parseTrades, tradeSections, planTrades, applyPlan, verify, planTouches, summariseTrades, fillFrom } from '../lib/flexTrades.js';
import { parseStatement } from '../lib/flex.js';
import { derivePosition } from '../lib/positions.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const derive = (r) => derivePosition(r.fills || [], { multiplier: r.multiplier });
const withDerived = (rows) => rows.map(r => ({ ...r, derived: derive(r) }));
const T = (a) => `<Trade ${Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ')} />`;

// ── reading the section ──
// A saved query can emit the same trade three times: once per execution, once per order, once per
// closed lot. Reading all three triples every position.
const THREE = [
  T({ tradeID: '1', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 100, tradePrice: 107, ibCommission: -1, tradeDate: '20260821', levelOfDetail: 'EXECUTION' }),
  T({ tradeID: '2', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 100, tradePrice: 107, ibCommission: -1, tradeDate: '20260821', levelOfDetail: 'ORDER' }),
  T({ tradeID: '3', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 100, tradePrice: 107, ibCommission: -1, tradeDate: '20260821', levelOfDetail: 'CLOSED_LOT' }),
].join('');
eq('one trade, not three', parseTrades(THREE).length, 1);
eq('and it is the ORDER row', parseTrades(THREE)[0].tradeId, '2');
// Without ORDER rows, executions are the trade.
eq('executions are the fallback', parseTrades(THREE.replace(/levelOfDetail="ORDER"/, 'levelOfDetail="EXECUTION"').replace(/tradeID="3"[^>]*CLOSED_LOT"\s*\/>/, '')).length, 2);
// A closed lot is never a trade — it is an accounting view of one.
eq('closed lots alone are not trades', parseTrades(T({ tradeID: '9', symbol: 'X', assetCategory: 'STK', buySell: 'BUY', quantity: 1, tradePrice: 1, tradeDate: '20260821', levelOfDetail: 'CLOSED_LOT' })).length, 0);

// COMMISSION IN THE PRICE — the convention every fill in this console already follows: what the
// trade cost per unit, not the headline print. A buy pays it; a sell nets it out.
const buy = parseTrades(T({ tradeID: '10', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 100, tradePrice: 107, ibCommission: -1, tradeDate: '20260821' }))[0];
eq('a buy pays the commission', buy.price, 107.01);
const sell = parseTrades(T({ tradeID: '11', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'SELL', quantity: -100, tradePrice: 107, ibCommission: -1, tradeDate: '20260821' }))[0];
eq('a sell nets it out', sell.price, 106.99);
eq('and the side comes off buySell, not the sign alone', sell.side, 'sell');
// The multiplier belongs in the money, not the quoted price: a $3.00 premium, not $300 a contract.
const opt = parseTrades(T({ tradeID: '12', symbol: 'AVGO', assetCategory: 'OPT', currency: 'USD', multiplier: 100, buySell: 'BUY', quantity: 10, tradePrice: 2.55, ibCommission: -5, tradeDate: '20260826' }))[0];
eq('a contract price stays quoted', opt.price, 2.555);
// Corporate actions and FX conversions share the section and are not trades.
eq('only trades are trades', parseTrades(T({ tradeID: '13', symbol: 'X', assetCategory: 'STK', buySell: 'BUY', quantity: 1, tradePrice: 1, tradeDate: '20260821', transactionType: 'FracShareDist' })).length, 0);
eq('a trade with no id cannot be deduplicated, so it is not used', parseTrades(T({ symbol: 'X', assetCategory: 'STK', buySell: 'BUY', quantity: 1, tradePrice: 1, tradeDate: '20260821' })).length, 0);
eq('futures roots come back rolled up', parseTrades(T({ tradeID: '14', symbol: 'MGCZ6', underlyingSymbol: 'MGC', assetCategory: 'FUT', currency: 'USD', multiplier: 10, buySell: 'BUY', quantity: 1, tradePrice: 4649.6, ibCommission: -1, tradeDate: '20260826' }))[0].root, 'MGC');

// Some saved queries emit order-level rows as <Order> rather than <Trade levelOfDetail="ORDER">.
// Reading only one of the two answers "no trades in the statement" on a query that is correctly
// configured — the same silent zero as reading `position` and not `quantity`.
{
  const asOrder = '<Order tradeID="15" symbol="HOOD" assetCategory="STK" currency="USD" multiplier="1" buySell="BUY" quantity="100" tradePrice="107" ibCommission="-1" tradeDate="20260821" />';
  eq('an <Order> row is a trade too', parseTrades(asOrder).map(t => t.tradeId), ['15']);
  eq('at order level of detail', parseTrades(asOrder)[0].levelOfDetail, 'ORDER');
  // The same order in both shapes is one trade, not two.
  const both = asOrder + T({ tradeID: '15', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 100, tradePrice: 107, ibCommission: -1, tradeDate: '20260821', levelOfDetail: 'ORDER' });
  eq('and is not counted twice', parseTrades(both).length, 1);
  // The container is not an element: <Trades count="1"> must not read as a trade.
  eq('the wrapper is not a row', tradeSections('<Trades count="1"><Trade tradeID="1" /></Trades>').Trade, 1);
  eq('and neither is a trade confirmation', tradeSections('<TradeConfirm tradeID="1" />').Trade, 0);
  eq('a diagnostic says what the document held', tradeSections(asOrder), { Trade: 0, Order: 1, TradeConfirm: 0 });
}

// ── the watermark ──
// The console's history is bulk averages — one fill of 600 METU standing for three orders — and no
// individual order will ever match one. Ingesting the past would fail adoption on nearly every
// trade. So the broker is the record only from the day it is switched on.
{
  const old = T({ tradeID: '20', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 100, tradePrice: 107, ibCommission: -1, tradeDate: '20260801' });
  const now = T({ tradeID: '21', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 50, tradePrice: 110, ibCommission: -1, tradeDate: '20260828' });
  const row = { id: 'HOOD-open', symbol: 'HOOD', fills: [{ id: 'f0', side: 'buy', qty: 100, price: 107.01, date: '2026-08-21' }] };
  const plan = planTrades(withDerived([row]), parseTrades(old + now), { from: '2026-08-27' });
  eq('nothing before the watermark is touched', plan.skipped.beforeWatermark, 1);
  eq('and what is after it is recorded', plan.apply.map(a => a.fill.tradeId), ['21']);
}

// ── idempotence ──
// This is what allows a 30-day window, which is what makes a missed run heal itself.
{
  const t = parseTrades(T({ tradeID: '30', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 100, tradePrice: 107, ibCommission: -1, tradeDate: '20260828' }));
  const before = { id: 'HOOD-open', symbol: 'HOOD', fills: [] };
  const p1 = planTrades(withDerived([before]), t, { from: '2026-08-01' });
  const after = applyPlan([before], p1);
  eq('the first read records it', p1.apply.length, 1);
  eq('with the broker’s id on the fill', after[0].fills[0].tradeId, '30');
  const p2 = planTrades(withDerived(after), t, { from: '2026-08-01' });
  eq('the second read records nothing', [p2.apply.length, p2.adopt.length], [0, 0]);
  eq('and says why', p2.skipped.alreadyRecorded, 1);
}

// ── adoption ──
// A trade entered by hand has no id, so it looks new — and applying it would double the position.
{
  const t = parseTrades(T({ tradeID: '40', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 100, tradePrice: 107, ibCommission: -1, tradeDate: '20260828' }));
  const typed = { id: 'HOOD-open', symbol: 'HOOD', fills: [{ id: 'f0', side: 'buy', qty: 100, price: 107.01, date: '2026-08-28' }] };
  const plan = planTrades(withDerived([typed]), t, { from: '2026-08-01' });
  eq('the hand-entered fill is adopted, not duplicated', plan.adopt, [{ rowId: 'HOOD-open', fillId: 'f0', tradeId: '40', root: 'HOOD' }]);
  eq('nothing is added', plan.apply, []);
  const after = applyPlan([typed], plan);
  eq('the position is unchanged', derive(after[0]).qty, 100);
  eq('and the fill now carries the id', after[0].fills[0].tradeId, '40');
  // A price a little off — a remembered fill rather than an exact one — is still the same event.
  const near = { id: 'HOOD-open', symbol: 'HOOD', fills: [{ id: 'f0', side: 'buy', qty: 100, price: 107.2, date: '2026-08-28' }] };
  eq('a slightly different price still adopts', planTrades(withDerived([near]), t, { from: '2026-08-01' }).adopt.length, 1);
  // A different DAY, or a different size, is a different trade.
  const otherDay = { id: 'HOOD-open', symbol: 'HOOD', fills: [{ id: 'f0', side: 'buy', qty: 100, price: 107.01, date: '2026-08-27' }] };
  eq('a different day does not', planTrades(withDerived([otherDay]), t, { from: '2026-08-01' }).adopt.length, 0);
  const otherSize = { id: 'HOOD-open', symbol: 'HOOD', fills: [{ id: 'f0', side: 'buy', qty: 50, price: 107.01, date: '2026-08-28' }] };
  eq('nor does a different size', planTrades(withDerived([otherSize]), t, { from: '2026-08-01' }).adopt.length, 0);
  // Two identical hand-entered fills: which one is this trade? Unanswerable, so it is not answered.
  const twice = { id: 'HOOD-open', symbol: 'HOOD', fills: [
    { id: 'f0', side: 'buy', qty: 100, price: 107.01, date: '2026-08-28' },
    { id: 'f1', side: 'buy', qty: 100, price: 107.01, date: '2026-08-28' }] };
  const amb = planTrades(withDerived([twice]), t, { from: '2026-08-01' });
  eq('two identical candidates is ambiguous', amb.report.map(r => r.kind), ['ambiguous-adoption']);
  eq('and nothing is written on a guess', [amb.adopt.length, amb.apply.length], [0, 0]);
}

// ── exits, which is the whole reason this exists ──
{
  const held = { id: 'METU-open', symbol: 'METU', fills: [{ id: 'f0', side: 'buy', qty: 600, price: 18.06401, date: '2026-08-18' }] };
  const exit = parseTrades(T({ tradeID: '50', symbol: 'METU', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'SELL', quantity: -600, tradePrice: 19.975, ibCommission: 0, tradeDate: '20260827' }));
  const plan = planTrades(withDerived([held]), exit, { from: '2026-08-01' });
  const after = applyPlan([held], plan);
  eq('the sale is recorded', plan.apply.length, 1);
  eq('and the row closes itself, exactly as the button does', derive(after[0]).status, 'closed');
  eq('at the price the broker reported', derive(after[0]).avgExit, 19.975);
  eq('for the P&L the broker would report', derive(after[0]).realized, +(600 * (19.975 - 18.06401)).toFixed(2));
}
// A sale in a symbol with nothing open is never guessed at.
{
  const sale = parseTrades(T({ tradeID: '51', symbol: 'NVDA', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'SELL', quantity: -10, tradePrice: 180, ibCommission: -1, tradeDate: '20260828' }));
  const plan = planTrades([], sale, { from: '2026-08-01' });
  eq('a sell with no position is reported', plan.report.map(r => r.kind), ['sell-with-no-position']);
  eq('and nothing is invented to hold it', [plan.apply.length, plan.creates.length], [0, 0]);
}
// A buy in an unseen symbol opens a row — the same trust boundary the position sync already uses.
{
  const t = parseTrades(
    T({ tradeID: '60', symbol: 'NVDA', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 10, tradePrice: 180, ibCommission: -1, tradeDate: '20260828' }) +
    T({ tradeID: '61', symbol: 'NVDA', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 5, tradePrice: 182, ibCommission: -1, tradeDate: '20260829' }));
  const plan = planTrades([], t, { from: '2026-08-01', today: '2026-08-29' });
  eq('one row is opened, not two', plan.creates.length, 1);
  eq('and both buys land on it', plan.apply.filter(a => a.rowId === plan.creates[0].id).length, 2);
  const after = applyPlan([], plan);
  eq('with the right position', derive(after[0]).qty, 15);
  eq('tagged so its origin is obvious', plan.creates[0].tags, ['new', 'flex']);
}
// Two open rows in one symbol: the statement cannot say which a trade belongs to.
{
  const t = parseTrades(T({ tradeID: '70', symbol: 'METU', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 100, tradePrice: 20, ibCommission: -1, tradeDate: '20260828' }));
  const rows = withDerived([
    { id: 'METU-a', symbol: 'METU', fills: [{ id: 'f0', side: 'buy', qty: 100, price: 18, date: '2026-08-18' }] },
    { id: 'METU-b', symbol: 'METU', fills: [{ id: 'f0', side: 'buy', qty: 100, price: 19, date: '2026-08-20' }] }]);
  eq('an ambiguous row is declared', planTrades(rows, t, { from: '2026-08-01' }).report.map(r => r.kind), ['ambiguous-row']);
}
// Options and cash legs stay out, here as everywhere else.
{
  const t = parseTrades(
    T({ tradeID: '80', symbol: 'AVGO 260828C00360000', underlyingSymbol: 'AVGO', assetCategory: 'OPT', currency: 'USD', multiplier: 100, buySell: 'BUY', quantity: 10, tradePrice: 2.55, ibCommission: -5, tradeDate: '20260826' }) +
    T({ tradeID: '81', symbol: 'USFR', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 100, tradePrice: 50.4, ibCommission: -1, tradeDate: '20260826' }));
  const plan = planTrades([], t, { from: '2026-08-01' });
  eq('neither is ingested', [plan.apply.length, plan.creates.length], [0, 0]);
  eq('and both are counted as out of scope', plan.skipped.outOfScope, 2);
}

// ── THE GATE ──
// The plan is applied to a copy and held against the Open Positions section of the SAME statement.
// This is what makes unattended ingestion acceptable: the two sections would have to be wrong in
// the same direction for a bad write to get through.
const POS = (attrs) => parseStatement(`<OpenPosition ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')} levelOfDetail="SUMMARY" />`).positions;
{
  const held = { id: 'HOOD-open', symbol: 'HOOD', fills: [{ id: 'f0', side: 'buy', qty: 100, price: 107.01, date: '2026-08-21' }] };
  const t = parseTrades(T({ tradeID: '90', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 50, tradePrice: 110, ibCommission: -1, tradeDate: '20260828' }));
  const plan = planTrades(withDerived([held]), t, { from: '2026-08-01' });
  const after = applyPlan([held], plan);
  // 150 at a blended 108.01 — which is what the statement says, so the batch stands.
  const good = verify(after, POS({ symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, position: 150, costBasisPrice: 108.01 }), { derive, roots: planTouches(plan) });
  ok('a batch that reconciles is accepted', good.ok);
  // The statement says 200. Something is missing, so NONE of it is applied.
  const bad = verify(after, POS({ symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, position: 200, costBasisPrice: 108.01 }), { derive, roots: planTouches(plan) });
  ok('a quantity that does not reconcile is rejected', !bad.ok);
  eq('with both numbers', [bad.problems[0].console, bad.problems[0].ibkr], [150, 200]);
  // The quantity is right and the cost basis is not — a price read wrong is still a bad write.
  const badCost = verify(after, POS({ symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, position: 150, costBasisPrice: 120 }), { derive, roots: planTouches(plan) });
  ok('a cost basis that does not reconcile is rejected too', !badCost.ok);
  // A row that has acknowledged a permanent divergence is not re-litigated by the gate.
  const acked = after.map(r => ({ ...r, costBasisAck: 120 }));
  ok('unless the divergence was acknowledged', verify(acked, POS({ symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, position: 150, costBasisPrice: 120 }), { derive, roots: planTouches(plan) }).ok);
}
{
  // A closed-out position: the statement no longer lists it, and the fills must leave it flat.
  const held = { id: 'METU-open', symbol: 'METU', fills: [{ id: 'f0', side: 'buy', qty: 600, price: 18.06401, date: '2026-08-18' }] };
  const exit = parseTrades(T({ tradeID: '91', symbol: 'METU', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'SELL', quantity: -600, tradePrice: 19.975, ibCommission: 0, tradeDate: '20260827' }));
  const plan = planTrades(withDerived([held]), exit, { from: '2026-08-01' });
  const after = applyPlan([held], plan);
  ok('a full exit reconciles against a statement that no longer lists it', verify(after, [], { derive, roots: planTouches(plan) }).ok);
  // A PARTIAL sale the statement still shows as held — but at a size the fills do not produce.
  const half = parseTrades(T({ tradeID: '92', symbol: 'METU', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'SELL', quantity: -300, tradePrice: 19.975, ibCommission: 0, tradeDate: '20260827' }));
  const p2 = planTrades(withDerived([held]), half, { from: '2026-08-01' });
  const a2 = applyPlan([held], p2);
  ok('300 left reconciles with a statement saying 300', verify(a2, POS({ symbol: 'METU', assetCategory: 'STK', currency: 'USD', multiplier: 1, position: 300, costBasisPrice: 18.06401 }), { derive, roots: planTouches(p2) }).ok);
  ok('and not with one saying 600', !verify(a2, POS({ symbol: 'METU', assetCategory: 'STK', currency: 'USD', multiplier: 1, position: 600, costBasisPrice: 18.06401 }), { derive, roots: planTouches(p2) }).ok);
}
{
  // Only what the plan touched is checked. ARM's permanent FIFO divergence is not this batch's
  // business, and a gate that failed on it would block every unrelated trade for ever.
  const arm = { id: 'ARM-open', symbol: 'ARM', fills: [
    { id: 'f0', side: 'buy', qty: 8, price: 321.855, date: '2026-06-10' },
    { id: 'f1', side: 'buy', qty: 1, price: 409.17, date: '2026-06-22' },
    { id: 'f2', side: 'sell', qty: 8, price: 295.6375, date: '2026-07-07' }] };
  const hood = { id: 'HOOD-open', symbol: 'HOOD', fills: [{ id: 'f0', side: 'buy', qty: 100, price: 107.01, date: '2026-08-21' }] };
  const t = parseTrades(T({ tradeID: '93', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'SELL', quantity: -100, tradePrice: 110, ibCommission: 0, tradeDate: '20260828' }));
  const plan = planTrades(withDerived([arm, hood]), t, { from: '2026-08-01' });
  const after = applyPlan([arm, hood], plan);
  const positions = POS({ symbol: 'ARM', assetCategory: 'STK', currency: 'USD', multiplier: 1, position: 1, costBasisPrice: 409.260003 });
  ok('an untouched row’s known divergence does not block the batch', verify(after, positions, { derive, roots: planTouches(plan) }).ok);
}

// ── what the channel is told ──
// Symbols and counts. Quantities and prices never leave the console.
{
  const t = parseTrades(T({ tradeID: '99', symbol: 'METU', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'SELL', quantity: -600, tradePrice: 19.975, ibCommission: 0, tradeDate: '20260827' }));
  const held = { id: 'METU-open', symbol: 'METU', fills: [{ id: 'f0', side: 'buy', qty: 600, price: 18.06401, date: '2026-08-18' }] };
  const line = summariseTrades(planTrades(withDerived([held]), t, { from: '2026-08-01' }));
  ok('it names the symbol', /METU/.test(line));
  ok('and never the size', !/600/.test(line) && !/19\.975/.test(line));
}
eq('a fill carries the id that stops it being recorded twice', fillFrom({ tradeId: 'abc123', side: 'buy', qty: 1, price: 2, date: '2026-08-28' }).tradeId, 'abc123');

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
