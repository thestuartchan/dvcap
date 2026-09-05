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

const derive = (r) => derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side });
const withDerived = (rows) => rows.map(r => ({ ...r, derived: derive(r) }));
const T = (a) => `<Trade ${Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ')} />`;
const POS = (attrs) => parseStatement(`<OpenPosition ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')} levelOfDetail="SUMMARY" />`).positions;

// ── reading the section ──
// A saved query can emit the same trade three times: once per execution, once per order, once per
// closed lot. Reading all three triples every position.
const THREE = [
  T({ tradeID: '1', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 100, tradePrice: 107, ibCommission: -1, tradeDate: '20260821', levelOfDetail: 'EXECUTION' }),
  T({ tradeID: '2', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 100, tradePrice: 107, ibCommission: -1, tradeDate: '20260821', levelOfDetail: 'ORDER' }),
  T({ tradeID: '3', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 100, tradePrice: 107, ibCommission: -1, tradeDate: '20260821', levelOfDetail: 'CLOSED_LOT' }),
].join('');
eq('one trade, not three', parseTrades(THREE).length, 1);
eq('and it is the ORDER row', parseTrades(THREE)[0].tradeId, '2:HOOD');
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
  eq('an <Order> row is a trade too', parseTrades(asOrder).map(t => t.tradeId), ['15:HOOD']);
  eq('at order level of detail', parseTrades(asOrder)[0].levelOfDetail, 'ORDER');
  // The same order in both shapes is one trade, not two.
  const both = asOrder + T({ tradeID: '15', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 100, tradePrice: 107, ibCommission: -1, tradeDate: '20260821', levelOfDetail: 'ORDER' });
  eq('and is not counted twice', parseTrades(both).length, 1);
  // The container is not an element: <Trades count="1"> must not read as a trade.
  eq('the wrapper is not a row', tradeSections('<Trades count="1"><Trade tradeID="1" /></Trades>').Trade, 1);
  eq('and neither is a trade confirmation', tradeSections('<TradeConfirm tradeID="1" />').Trade, 0);
  eq('a diagnostic says what the document held', tradeSections(asOrder), { Trade: 0, Order: 1, TradeConfirm: 0, dropped: {} });
  // An <Order> row has no tradeID at all — it carries ibOrderID. The first attempt read all 177 of
  // them and then dropped every one for having no id, which from outside is indistinguishable from
  // the section being missing. So the diagnostic says WHY, not only how many survived.
  eq('an order id is an id', parseTrades('<Order ibOrderID="77" symbol="X" assetCategory="STK" currency="USD" multiplier="1" buySell="BUY" quantity="1" tradePrice="10" tradeDate="20260828" />')[0].tradeId, '77:X');
  eq('and a row with none says so', tradeSections('<Order symbol="X" assetCategory="STK" buySell="BUY" quantity="1" tradePrice="10" tradeDate="20260828" />').dropped, { noId: 1 });
  eq('a closed lot is counted as the wrong level', tradeSections(T({ tradeID: '1', symbol: 'X', assetCategory: 'STK', buySell: 'BUY', quantity: 1, tradePrice: 1, tradeDate: '20260821', levelOfDetail: 'CLOSED_LOT' })).dropped, { otherLevelOfDetail: 1 });
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
  eq('and what is after it is recorded', plan.apply.map(a => a.fill.tradeId), ['21:HOOD']);
}

// ── idempotence ──
// This is what allows a 30-day window, which is what makes a missed run heal itself.
{
  const t = parseTrades(T({ tradeID: '30', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 100, tradePrice: 107, ibCommission: -1, tradeDate: '20260828' }));
  const before = { id: 'HOOD-open', symbol: 'HOOD', fills: [] };
  const p1 = planTrades(withDerived([before]), t, { from: '2026-08-01' });
  const after = applyPlan([before], p1);
  eq('the first read records it', p1.apply.length, 1);
  eq('with the broker’s id on the fill', after[0].fills[0].tradeId, '30:HOOD');
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
  eq('the hand-entered fill is adopted, not duplicated', plan.adopt, [{ rowId: 'HOOD-open', fillId: 'f0', tradeId: '40:HOOD', root: 'HOOD' }]);
  eq('nothing is added', plan.apply, []);
  const after = applyPlan([typed], plan);
  eq('the position is unchanged', derive(after[0]).qty, 100);
  eq('and the fill now carries the id', after[0].fills[0].tradeId, '40:HOOD');
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

// ── day trades stay in the broker ──
// The console's scope is spot, swings and long holds. A statement window holds every scalp too, and
// left alone each one would open a row, fill it, close it in the same breath and file it in the
// archive — burying the swing record under exactly the trades that were kept out on purpose.
{
  const scalp = parseTrades(
    T({ tradeID: '100', symbol: 'TSLA', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 500, tradePrice: 400, ibCommission: -1, tradeDate: '20260828' }) +
    T({ tradeID: '101', symbol: 'TSLA', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'SELL', quantity: -500, tradePrice: 402, ibCommission: -1, tradeDate: '20260828' }));
  const plan = planTrades([], scalp, { from: '2026-08-01' });
  eq('a same-day round trip opens nothing', [plan.creates.length, plan.apply.length], [0, 0]);
  eq('and is counted as what it is', plan.skipped.dayTrades, 2);
  eq('silently — it is not a problem to report', plan.report, []);
}
{
  // The same round trip over two days is a SWING that never got recorded. Worth knowing about, so
  // it is reported — and not filed automatically, because a completed trade the console never saw
  // is a judgement call.
  const swing = parseTrades(
    T({ tradeID: '110', symbol: 'TSLA', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 500, tradePrice: 400, ibCommission: -1, tradeDate: '20260826' }) +
    T({ tradeID: '111', symbol: 'TSLA', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'SELL', quantity: -500, tradePrice: 402, ibCommission: -1, tradeDate: '20260828' }));
  const plan = planTrades([], swing, { from: '2026-08-01' });
  eq('a multi-day round trip is reported', plan.report.map(r => r.kind), ['round-trip-not-recorded']);
  eq('with the days it spanned', plan.report[0].dates, ['2026-08-26', '2026-08-28']);
  eq('and nothing is filed on its own', [plan.creates.length, plan.apply.length], [0, 0]);
}
{
  // A scalp in a symbol the console DOES hold is applied, because it moved a tracked position and
  // leaving it out would put the console's average cost at odds with the broker's.
  const held = { id: 'HOOD-open', symbol: 'HOOD', fills: [{ id: 'f0', side: 'buy', qty: 100, price: 107.01, date: '2026-08-21' }] };
  const inOut = parseTrades(
    T({ tradeID: '120', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 50, tradePrice: 110, ibCommission: 0, tradeDate: '20260828' }) +
    T({ tradeID: '121', symbol: 'HOOD', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'SELL', quantity: -50, tradePrice: 111, ibCommission: 0, tradeDate: '20260828' }));
  const plan = planTrades(withDerived([held]), inOut, { from: '2026-08-01' });
  eq('both legs land on the position they moved', plan.apply.length, 2);
  eq('and it is not counted as a day trade', plan.skipped.dayTrades, 0);
  eq('the position is back where it started', derive(applyPlan([held], plan)[0]).qty, 100);
}
{
  // A buy that is still held at the end of the window is a new position, not a scalp.
  const opened = parseTrades(
    T({ tradeID: '130', symbol: 'NVDA', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'BUY', quantity: 20, tradePrice: 180, ibCommission: -1, tradeDate: '20260828' }) +
    T({ tradeID: '131', symbol: 'NVDA', assetCategory: 'STK', currency: 'USD', multiplier: 1, buySell: 'SELL', quantity: -5, tradePrice: 182, ibCommission: -1, tradeDate: '20260828' }));
  const plan = planTrades([], opened, { from: '2026-08-01' });
  eq('a partial exit the same day is still a position', plan.creates.length, 1);
  eq('with both fills', plan.apply.length, 2);
  eq('and 15 left', derive(applyPlan([], plan)[0]).qty, 15);
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

// ── an order id is not unique per LEG ──
// A futures roll placed as a combo is ONE order against TWO contracts. The bare order id makes the
// Oct sell and the Dec buy the same trade, and deduplication throws one of them away — which is how
// a roll came back as two adoptions carrying one id.
{
  const roll = '<Order ibOrderID="73569665" conid="111" symbol="MGCV6" underlyingSymbol="MGC" assetCategory="FUT" currency="USD" multiplier="10" buySell="SELL" quantity="-1" tradePrice="4613.8" ibCommission="-1.24" tradeDate="20260826" />' +
               '<Order ibOrderID="73569665" conid="222" symbol="MGCZ6" underlyingSymbol="MGC" assetCategory="FUT" currency="USD" multiplier="10" buySell="BUY" quantity="1" tradePrice="4649.6" ibCommission="-1.24" tradeDate="20260826" />';
  const parsed = parseTrades(roll);
  eq('both legs of a combo survive', parsed.length, 2);
  eq('because the id is qualified by the contract', parsed.map(t => t.tradeId), ['73569665:111', '73569665:222']);
  eq('and they are still one order underneath', [...new Set(parsed.map(t => t.tradeId.split(':')[0]))], ['73569665']);
  // A plain single-leg order is unaffected.
  eq('a single-leg order keeps its shape', parseTrades('<Order ibOrderID="9" conid="5" symbol="HOOD" assetCategory="STK" currency="USD" multiplier="1" buySell="BUY" quantity="1" tradePrice="10" tradeDate="20260828" />')[0].tradeId, '9:5');
}

// ── the statement has one line per lot; the console can have several rows for it ──
// A rolled-out contract and the one that replaced it are two rows and one position. Checking each
// row against that single line failed the closed leg for holding nothing — which is precisely what
// a closed leg holds — and rejected an otherwise correct batch.
{
  const leg = { id: 'MGC-20260826', symbol: 'MGC', margined: true, multiplier: 10, fills: [
    { id: 'f0', side: 'buy', qty: 1, price: 4442.80464, date: '2026-08-17' },
    { id: 'f1', side: 'sell', qty: 1, price: 4613.70464, date: '2026-08-26' }] };
  const tip = { id: 'MGC-DEC26', symbol: 'MGC', margined: true, multiplier: 10, fills: [
    { id: 'f0', side: 'buy', qty: 1, price: 4649.70464, date: '2026-08-26' }] };
  const pos = POS({ symbol: 'MGCZ6', underlyingSymbol: 'MGC', assetCategory: 'FUT', currency: 'USD', multiplier: 10, position: 1, costBasisPrice: 4649.70464 });
  const v = verify([leg, tip], pos, { derive, roots: ['MGC'] });
  ok('the closed leg does not fail the batch', v.ok);
  eq('and nothing is reported', v.problems, []);
  // The check still bites: if the OPEN row is wrong, the batch is still rejected.
  const wrong = { ...tip, fills: [{ id: 'f0', side: 'buy', qty: 2, price: 4649.70464, date: '2026-08-26' }] };
  const bad = verify([leg, wrong], pos, { derive, roots: ['MGC'] });
  ok('a wrong open quantity is still caught', !bad.ok);
  eq('counting only what is open', [bad.problems[0].console, bad.problems[0].ibkr], [2, 1]);
  // Two OPEN rows in one symbol: quantity is checkable, a blended average is not.
  const twoOpen = [{ id: 'A', symbol: 'MGC', margined: true, multiplier: 10, fills: [{ id: 'f0', side: 'buy', qty: 1, price: 4000, date: '2026-08-01' }] },
                   { id: 'B', symbol: 'MGC', margined: true, multiplier: 10, fills: [{ id: 'f0', side: 'buy', qty: 1, price: 5000, date: '2026-08-02' }] }];
  const two = verify(twoOpen, POS({ symbol: 'MGCZ6', underlyingSymbol: 'MGC', assetCategory: 'FUT', currency: 'USD', multiplier: 10, position: 2, costBasisPrice: 4500 }), { derive, roots: ['MGC'] });
  ok('two open rows summing to the statement pass on quantity', two.ok);
}

// ── THE GATE ──
// The plan is applied to a copy and held against the Open Positions section of the SAME statement.
// This is what makes unattended ingestion acceptable: the two sections would have to be wrong in
// the same direction for a bad write to get through.
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
  eq('and the row it is about', bad.problems[0].ids, ['HOOD-open']);
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
  // An adoption changed nothing the reader did not already know, so the channel does not hear it.
  const adoptOnly = { adopt: [{ root: 'MGC' }], apply: [], creates: [], report: [] };
  eq('a matched-by-hand batch says nothing to the channel', summariseTrades(adoptOnly, { forChannel: true }), '');
  ok('but the endpoint still reports it', /matched 1/.test(summariseTrades(adoptOnly)));
  ok('and never the size', !/600/.test(line) && !/19\.975/.test(line));
}
eq('a fill carries the id that stops it being recorded twice', fillFrom({ tradeId: 'abc123', side: 'buy', qty: 1, price: 2, date: '2026-08-28' }).tradeId, 'abc123');

// ── THE GATE COMPARES AS OF THE STATEMENT'S DAY ─────────────────────────────
// verify() decides whether a whole batch is written. On 2026-09-02 it discarded one because ASTX
// had been sold down by hand after the 09-01 statement was cut — both sides right, nothing written.
{
  const derive = (r) => derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side });
  const pos = [{ root: 'ASTX', symbol: 'ASTX', qty: 500, costBasisPrice: 9.2, assetCategory: 'STK' }];
  const rowWith = (fills) => [{ id: 'astx', symbol: 'ASTX', fills }];
  const sold = rowWith([
    { side: 'buy',  qty: 500, price: 9.2,  date: '2026-09-01' },
    { side: 'sell', qty: 400, price: 10.6, date: '2026-09-02' },
  ]);

  eq('without a statement date the live quantity is compared, and fails',
    verify(sold, pos, { derive, roots: ['ASTX'] }).ok, false);
  const dated = verify(sold, pos, { derive, roots: ['ASTX'], asOf: '2026-09-01' });
  eq('re-derived to the statement day it passes', dated.ok, true);
  eq('with nothing left to report', dated.problems.length, 0);

  // THE HOLE THAT WAS LEFT. A BUY after the statement reconciles the quantity and moves the
  // average — 9.67 against a statement of 9.20 — so the batch was discarded on a cost basis nobody
  // disagreed about. Rewinding one field and not the other was not a fix.
  const bought = rowWith([
    { side: 'buy', qty: 500, price: 9.20, date: '2026-09-01' },
    { side: 'buy', qty: 100, price: 12.00, date: '2026-09-02' },
  ]);
  ok('the live average really has moved', Math.abs(derive(bought[0]).avgCost - 9.2) > 0.4);
  eq('and an add after the statement now passes the gate',
    verify(bought, pos, { derive, roots: ['ASTX'], asOf: '2026-09-01' }).ok, true);

  // Quantity back to the statement's figure but the average moved — the shape that slips past a
  // quantity-only check entirely.
  const churn = rowWith([
    { side: 'buy',  qty: 500, price: 9.20,  date: '2026-09-01' },
    { side: 'buy',  qty: 100, price: 12.00, date: '2026-09-02' },
    { side: 'sell', qty: 100, price: 12.50, date: '2026-09-02' },
  ]);
  eq('a round trip after the statement passes too',
    verify(churn, pos, { derive, roots: ['ASTX'], asOf: '2026-09-01' }).ok, true);

  // The gate must NOT have been loosened.
  const bad = verify(sold, [{ ...pos[0], qty: 900 }], { derive, roots: ['ASTX'], asOf: '2026-09-01' });
  eq('an unexplained gap still fails the gate', bad.ok, false);
  ok('and says it was rewound', bad.problems[0].why.includes('rewound to 2026-09-01'));
  eq('reporting the as-of figure', bad.problems[0].console, 500);
  eq('and the live one alongside it', bad.problems[0].liveNow, 100);
  eq('a cost the statement never claimed still fails',
    verify(bought, [{ ...pos[0], costBasisPrice: 7.5 }], { derive, roots: ['ASTX'], asOf: '2026-09-01' }).ok, false);

  // A row that has not traded since the statement is unaffected either way.
  const quiet = rowWith([{ side: 'buy', qty: 500, price: 9.2, date: '2026-09-01' }]);
  eq('a quiet row passes with a date', verify(quiet, pos, { derive, roots: ['ASTX'], asOf: '2026-09-01' }).ok, true);
  eq('and without one', verify(quiet, pos, { derive, roots: ['ASTX'] }).ok, true);
  const wrong = verify(quiet, [{ ...pos[0], qty: 250 }], { derive, roots: ['ASTX'], asOf: '2026-09-01' });
  eq('a real mismatch still fails', wrong.ok, false);
  ok('with the plain message, since nothing moved', !wrong.problems[0].why.includes('rewound'));
}

// ── AN ADOPTION IS NOT A CHANGE, SO IT CANNOT FAIL THE GATE ─────────────────
// 2026-09-03: a batch that opened TQQQ and recorded two of its fills was discarded in full because
// ARM disagreed with the statement. The plan's only involvement with ARM was matching five fills
// already entered by hand.
{
  const plan = {
    adopt: [{ root: 'ARM', rowId: 'arm', fillId: 'f1', tradeId: 't1' },
            { root: 'ARM', rowId: 'arm', fillId: 'f2', tradeId: 't2' }],
    apply: [{ root: 'TQQQ', rowId: 'tqqq', fill: { side: 'buy', qty: 1000, price: 69.4, date: '2026-09-03' } }],
    creates: [{ id: 'tqqq', symbol: 'TQQQ' }],
    report: [],
  };
  eq('only what the plan changes is verified', planTouches(plan).sort(), ['TQQQ']);
  ok('an adopted root is not in scope', !planTouches(plan).includes('ARM'));

  // WHY that is sound: adoption stamps a tradeId and moves no quantity or price, so the derived
  // position is identical before and after. Asserted rather than asserted-about.
  const rows = [{ id: 'arm', symbol: 'ARM', fills: [
    { id: 'f1', side: 'buy', qty: 10, price: 246.73, date: '2026-06-01' },
    { id: 'f2', side: 'sell', qty: 4, price: 240.00, date: '2026-08-01' }] }];
  const derive = (r) => derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side });
  const before = derive(rows[0]);
  const after = derive(applyPlan(rows, { ...plan, apply: [], creates: [] }).find(r => r.id === 'arm'));
  eq('adoption moves no quantity', after.qty, before.qty);
  eq('and no average cost', after.avgCost, before.avgCost);
  ok('it only stamps the trade id', applyPlan(rows, { ...plan, apply: [], creates: [] })
    .find(r => r.id === 'arm').fills.every(f => f.tradeId));

  // THE LINE THAT MUST NOT MOVE: a root the plan genuinely changes is still gated.
  const pos = [{ root: 'TQQQ', symbol: 'TQQQ', qty: 500, costBasisPrice: 69.4, assetCategory: 'STK' }];
  const applied = [{ id: 'tqqq', symbol: 'TQQQ', fills: [{ side: 'buy', qty: 1000, price: 69.4, date: '2026-09-03' }] }];
  const bad = verify(applied, pos, { derive, roots: planTouches(plan), asOf: '2026-09-03' });
  eq('a changed root that disagrees still fails', bad.ok, false);
  const good = verify(applied, [{ ...pos[0], qty: 1000 }], { derive, roots: planTouches(plan), asOf: '2026-09-03' });
  eq('and passes when it agrees', good.ok, true);

  // And a plan with nothing but adoptions has nothing to verify — which is correct, not a hole:
  // it changes nothing, so there is no new state to hold against the statement.
  eq('a pure-adoption plan verifies nothing', planTouches({ ...plan, apply: [], creates: [] }).length, 0);
}

// ── SHORTS FROM THE STATEMENT ────────────────────────────────────────────────
// A sell in a symbol the console holds nothing open in was read as an error unconditionally, so the
// sync could never open a short from the broker — the direction most likely to arrive this way,
// since a short is the case least likely to have been typed in by hand first. It is still not
// guessed at: the statement reports a short as a NEGATIVE quantity, and only that creates the row.
{
  const SELL = T({ tradeID: 's1', symbol: 'IWM', assetCategory: 'STK', currency: 'USD', multiplier: 1,
                   buySell: 'SELL', quantity: 200, tradePrice: 240, ibCommission: 0, tradeDate: '20260901', levelOfDetail: 'ORDER' });
  const shortPos = POS({ symbol: 'IWM', assetCategory: 'STK', currency: 'USD', multiplier: 1, position: -200, costBasisPrice: 240 });
  const longPos  = POS({ symbol: 'IWM', assetCategory: 'STK', currency: 'USD', multiplier: 1, position: 200, costBasisPrice: 240 });

  const made = planTrades([], parseTrades(SELL), { from: '2026-08-01', positions: shortPos });
  eq('the statement says SHORT, so the row is created', made.creates.length, 1);
  eq('and it is a short row', made.creates[0].side, 'short');
  eq('with the sell applied to it', made.apply.length, 1);
  eq('and nothing reported', made.report.length, 0);
  const applied = applyPlan([], made);
  const d0 = derive(applied[0]);
  eq('it derives as 200 short at 240', [d0.qty, d0.avgCost, d0.side], [200, 240, 'short']);

  const notShort = planTrades([], parseTrades(SELL), { from: '2026-08-01', positions: longPos });
  eq('a LONG statement line does not create a short', notShort.creates.length, 0);
  eq('it is reported', notShort.report[0].kind, 'sell-with-no-position');
  ok('and says why it is not a short', /lists it LONG/.test(notShort.report[0].note));

  const noPos = planTrades([], parseTrades(SELL), { from: '2026-08-01' });
  eq('no statement evidence creates nothing', noPos.creates.length, 0);
  eq('and still reports', noPos.report[0].kind, 'sell-with-no-position');

  // A BUY against a root the statement holds SHORT is a COVER. Opening a long row for it would
  // book the buy as an entry and invert the trade completely.
  const BUY = T({ tradeID: 'b1', symbol: 'IWM', assetCategory: 'STK', currency: 'USD', multiplier: 1,
                  buySell: 'BUY', quantity: 200, tradePrice: 230, ibCommission: 0, tradeDate: '20260902', levelOfDetail: 'ORDER' });
  const cover = planTrades([], parseTrades(BUY), { from: '2026-08-01', positions: shortPos });
  eq('a buy against a short statement line creates nothing', cover.creates.length, 0);
  eq('it is reported as a cover', cover.report[0].kind, 'cover-with-no-position');
  eq('a buy with no short line still opens a long',
     planTrades([], parseTrades(BUY), { from: '2026-08-01' }).creates[0].side, 'long');
}

// ── MULTI-FILL: a short built and covered over several trades ────────────────
{
  const mk = (id, bs, q, px, date) => T({ tradeID: id, symbol: 'XLE', assetCategory: 'STK', currency: 'USD',
    multiplier: 1, buySell: bs, quantity: q, tradePrice: px, ibCommission: 0, tradeDate: date, levelOfDetail: 'ORDER' });
  const shortPos = POS({ symbol: 'XLE', assetCategory: 'STK', currency: 'USD', multiplier: 1, position: -150, costBasisPrice: 91 });
  const trades = parseTrades(mk('x1','SELL',100,90,'20260901') + mk('x2','SELL',100,92,'20260902') + mk('x3','BUY',50,85,'20260903'));
  const plan = planTrades([], trades, { from: '2026-08-01', positions: shortPos });
  eq('three trades land on ONE created row', [plan.creates.length, plan.apply.length], [1, 3]);
  eq('the row is short', plan.creates[0].side, 'short');
  const rows = applyPlan([], plan);
  const d1 = derive(rows[0]);
  eq('150 short at the blended 91', [d1.qty, Math.round(d1.avgCost)], [150, 91]);
  ok('the cover at 85 booked a gain', d1.realized > 0);
  eq('and the batch verifies against the statement',
     verify(rows.map(r => ({ ...r, derived: derive(r) })), shortPos, { derive, roots: planTouches(plan) }).problems, []);
  // The cost-basis gate still bites on a short: this fixture originally claimed 90 against a true
  // blended 91 and the batch was refused, which is the behaviour worth keeping a test on.
  const wrongBasis = POS({ symbol: 'XLE', assetCategory: 'STK', currency: 'USD', multiplier: 1, position: -150, costBasisPrice: 90 });
  eq('a short whose basis disagrees is still refused',
     verify(rows.map(r => ({ ...r, derived: derive(r) })), wrongBasis, { derive, roots: planTouches(plan) }).ok, false);
}

// ── THE GATE MUST SEE DIRECTION ──────────────────────────────────────────────
// The console keeps quantity as a magnitude with the side in its own field; the statement signs it.
// Comparing Math.abs() to Math.abs() said a console LONG of 300 agreed with a broker SHORT of 300 —
// the one disagreement this gate exists to catch and the only one it could not see.
{
  const longRow = { id: 'r1', symbol: 'SPY', side: 'long', multiplier: 1,
    fills: [{ id: 'f1', side: 'buy', qty: 300, price: 500, date: '2026-09-01' }] };
  const shortRow = { id: 'r2', symbol: 'SPY', side: 'short', multiplier: 1,
    fills: [{ id: 'f1', side: 'sell', qty: 300, price: 500, date: '2026-09-01' }] };
  const brokerShort = POS({ symbol: 'SPY', assetCategory: 'STK', currency: 'USD', multiplier: 1, position: -300, costBasisPrice: 500 });
  const brokerLong  = POS({ symbol: 'SPY', assetCategory: 'STK', currency: 'USD', multiplier: 1, position: 300, costBasisPrice: 500 });
  const bad = verify(withDerived([longRow]), brokerShort, { derive, roots: ['SPY'] });
  eq('a long against a broker short is REFUSED', bad.ok, false);
  ok('and says which way each side points', /console holds this LONG/.test(bad.problems[0].why) && /statement reports it SHORT/.test(bad.problems[0].why));
  eq('the same quantities the right way round pass',
     verify(withDerived([longRow]), brokerLong, { derive, roots: ['SPY'] }).problems, []);
  eq('a short against a broker long is REFUSED too',
     verify(withDerived([shortRow]), brokerLong, { derive, roots: ['SPY'] }).ok, false);
  eq('and matched to a broker short it passes',
     verify(withDerived([shortRow]), brokerShort, { derive, roots: ['SPY'] }).problems, []);
}

// A short round trip inside one day is still a day trade and still stays in the broker.
{
  const mk = (id, bs, q, px) => T({ tradeID: id, symbol: 'TSLA', assetCategory: 'STK', currency: 'USD',
    multiplier: 1, buySell: bs, quantity: q, tradePrice: px, ibCommission: -1, tradeDate: '20260901', levelOfDetail: 'ORDER' });
  const plan = planTrades([], parseTrades(mk('d1','SELL',50,400) + mk('d2','BUY',50,390)), { from: '2026-08-01' });
  eq('a short scalp is skipped like a long one', [plan.creates.length, plan.skipped.dayTrades], [0, 2]);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
