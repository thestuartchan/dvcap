// test/dayTradeJournal.test.mjs — the day-trading record: what the console's rules leave out.
import { parseBrokerFills } from '../lib/fillAudit.js';
import { nyDate, isoWeek, weekOf, mergeWeeks, journalReason, roundTripsFromSheet, roundTripsFromIbkr, toWeeks, FEED_FROM,
  contractFromDescription, contractKey, journalOrdersFromFlex } from '../lib/dayTradeJournal.js';
import { sendRequestUrl } from '../lib/flex.js';
import { hasJournalReadKey, hasServiceKey } from '../lib/apiauth.js';
import { journalRange } from '../api/flex-sync.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// ── dates ──
eq('New York date of a late UTC instant', nyDate('2026-10-06T02:30:00Z'), '2026-10-05');
eq('ISO weeks (Monday start; the Thursday decides the year)', [isoWeek('2026-10-05'), isoWeek('2026-10-11'), isoWeek('2027-01-01'), isoWeek('2026-01-01')], ['2026-W41', '2026-W41', '2026-W53', '2026-W01']);

// ── the rules ──
eq('under 24h is a day trade', journalReason({ kind: 'stock', underlying: 'NVDA', holdMin: 600 }), 'held under 24h');
eq('24h or more is the console\'s', journalReason({ kind: 'stock', underlying: 'NVDA', holdMin: 1440 }), null);
eq('an option opened at 1 DTE is a day trade however long it is held', journalReason({ kind: 'option', underlying: 'SPY', holdMin: 2000, dte: 1 }), 'opened at 1 DTE');
eq('a 2 DTE option held two days is the console\'s', journalReason({ kind: 'option', underlying: 'SPY', holdMin: 2880, dte: 2 }), null);
eq('a QQQ option is always here', journalReason({ kind: 'option', underlying: 'QQQ', holdMin: 30000, dte: 30 }), 'QQQ options are day-trade only');
eq('QQQ shares follow the 24h rule', journalReason({ kind: 'stock', underlying: 'QQQ', holdMin: 3000 }), null);

// ── from the sheet ──
const CSV = `"UID","Venue","DateTime (UTC)","Date","Symbol","Direction","Qty","Price","Realized PnL","Fee","Ccy"
"IBKR-1","IBKR","2026-09-01T10:00:00.000Z","2026-09-01","NVDA","BUY","10","100","0.00","-1.00","USD"
"IBKR-2","IBKR","2026-09-01T12:00:00.000Z","2026-09-01","NVDA","SELL","-10","101","9.00","-1.00","USD"
"IBKR-3","IBKR","2026-09-02T10:00:00.000Z","2026-09-02","AMD","BUY","10","100","0.00","-1.00","USD"
"IBKR-4","IBKR","2026-09-04T10:00:00.000Z","2026-09-04","AMD","SELL","-10","110","98.00","-1.00","USD"
"IBKR-5","IBKR","2026-08-12T10:00:00.000Z","2026-08-12","QQQ   260918C00754000","BUY","2","10","0.00","-1.00","USD"
"IBKR-6","IBKR","2026-09-01T10:00:00.000Z","2026-09-01","QQQ   260918C00754000","SELL","-2","5","-1001.00","-1.00","USD"
"IBKR-7","IBKR","2026-09-10T10:00:00.000Z","2026-09-10","981","BUY","1000","60","0.00","-10.00","HKD"
"IBKR-8","IBKR","2026-09-10T13:00:00.000Z","2026-09-10","981","SELL","-1000","61","990.00","-10.00","HKD"
"IBKR-9","IBKR","2026-10-05T10:00:00.000Z","2026-10-05","TSLA","BUY","1","100","0.00","-1.00","USD"
"IBKR-10","IBKR","2026-10-05T11:00:00.000Z","2026-10-05","TSLA","SELL","-1","101","0.00","-1.00","USD"
"HL-1","Hyperliquid","2026-09-03T10:00:00.000Z","2026-09-03","HYPE","Open Long","10","50","0.00","0.50","USDC"
"HL-2","Hyperliquid","2026-09-03T11:00:00.000Z","2026-09-03","HYPE","Close Long","-10","51","10.00","0.50","USDC"`;
const sheet = roundTripsFromSheet(parseBrokerFills(CSV).fills);
const by = Object.fromEntries(sheet.map(t => [t.underlying, t]));
eq('day trades and the QQQ option swing; the AMD swing, Hyperliquid and anything from the feed date are not', sheet.map(t => t.underlying).sort(), ['0981.HK', 'NVDA', 'QQQ'].sort());
eq('NVDA round trip', [by.NVDA.side, by.NVDA.holdMin, by.NVDA.avgIn, by.NVDA.avgOut, by.NVDA.pnl, by.NVDA.reason], ['long', 120, 100, 101, 9, 'held under 24h']);
eq('the QQQ option carries its contract', [by.QQQ.kind, by.QQQ.contract, by.QQQ.pnl, by.QQQ.reason], ['option', 'QQQ 2026-09-18 754C', -1001, 'QQQ options are day-trade only']);
eq('HKD converted at the peg', [by['0981.HK'].ccy, by['0981.HK'].pnl, by['0981.HK'].pnlUsd], ['HKD', 990, 126.92]);
ok('ids are stable and prefixed', by.NVDA.id === 'ib-IBKR-1');
ok('every row is before the feed date', sheet.every(t => t.date < FEED_FROM));

// ── from the IBKR feed ──
const T = (id, sym, cls, side, size, price, time, pnl = 0, order = id) => ({ trade_id: id, order_id: order, symbol: sym, sec_type: cls, side, size, price, trade_time: time, realized_pnl: pnl, commission: 1, currency: 'USD' });
const trades = [
  T(1, 'QQQ', 'OPT', 'BUY', 5, 2.0, '2026-10-05T14:00:00Z'),
  T(2, 'QQQ', 'OPT', 'SELL', 5, 2.5, '2026-10-05T15:00:00Z', 248),
  T(3, 'SPY', 'OPT', 'BUY', 4, 7.85, '2026-10-05T14:00:00Z', 0, 50),     // spread leg, ordered alone, still open
  T(4, 'SPY', 'OPT', 'SELL', 4, 3.83, '2026-10-05T14:00:01Z', 0, 51),
  T(5, 'SPY', 'OPT', 'BUY', 1, 1.0, '2026-10-06T14:00:00Z'),             // a scalp on its own
  T(6, 'SPY', 'OPT', 'SELL', 1, 1.2, '2026-10-06T14:30:00Z', 19),
  T(7, 'WFC', 'OPT', 'SELL', 10, 1.5, '2026-10-06T14:00:00Z', 30),        // trims a held option
  T(8, 'WFC', 'OPT', 'BUY', 10, 1.4, '2026-10-06T15:00:00Z'),
  T(9, 'AAPL', 'STK', 'BUY', 10, 200, '2026-10-05T14:00:00Z', 0, 60),     // a combo order: both sides
  T(10, 'AAPL', 'STK', 'SELL', 10, 201, '2026-10-05T14:00:00Z', 9, 60),
  T(11, 'TSLA', 'STK', 'BUY', 10, 100, '2026-10-05T14:00:00Z'),
  T(12, 'TSLA', 'STK', 'SELL', 10, 110, '2026-10-07T14:00:00Z', 99),      // two days: a swing
  T(13, 'USD.HKD', 'CASH', 'BUY', 1000, 7.8, '2026-10-05T14:00:00Z'),
];
const positions = [
  { contract_description: "SPY Nov20'26 750 PUT @AMEX", position: 4, average_price: 7.846, asset_class: 'OPT' },
  { contract_description: "SPY Nov20'26 720 PUT @AMEX", position: -4, average_price: 3.8257, asset_class: 'OPT' },
  { contract_description: "WFC Oct23'26 89 CALL @AMEX", position: 30, average_price: 1.12, asset_class: 'OPT' },
];
const feed = roundTripsFromIbkr({ trades, positions });
eq('the feed: QQQ and the SPY scalp only', feed.map(t => [t.symbol, t.pnl, t.reason]), [['QQQ options', 248, 'held under 24h'], ['SPY options', 19, 'held under 24h']]);
eq('feed rows are flagged and dated', [feed[0].source, feed[0].id, feed[0].date, feed[0].holdMin], ['ibkr', 'ib-1', '2026-10-05', 60]);
eq('nothing before the feed date', roundTripsFromIbkr({ trades: trades.slice(0, 2), positions: [], since: '2026-10-06' }).length, 0);

const hk = (positions) => roundTripsFromIbkr({ positions,
  trades: [{ ...T(20, '981', 'STK', 'BUY', 500, 60, '2026-10-06T02:00:00Z'), currency: 'HKD' }, { ...T(21, '981', 'STK', 'SELL', 500, 61, '2026-10-06T05:00:00Z', 490), currency: 'HKD' }] }).map(t => [t.symbol, t.pnlUsd]);
eq('a scalp on top of a held Hong Kong position is the console\'s', hk([{ contract_description: '981 @SEHK', position: 1000, average_price: 65, asset_class: 'STK' }]), []);
eq('a flat Hong Kong scalp is named as the console names it', hk([]), [['0981.HK', 62.82]]);

// ── weeks ──
const weeks = toWeeks([...sheet, ...feed]);
eq('one document per closing week, in order', weeks.map(w => w.week), ['2026-W36', '2026-W37', '2026-W41']);
const w41 = weeks.at(-1);
eq('a week totals its trades', [w41.count, w41.pnlUsd, w41.source], [2, 267, 'ibkr']);
eq('the QQQ swing files under the week it closed', weeks[0].trades.map(t => t.underlying).sort(), ['NVDA', 'QQQ']);

eq('a Sunday-evening futures close is next week\'s; a Saturday close is this week\'s', [weekOf({ kind: 'future', closeDate: '2026-10-11' }), weekOf({ kind: 'future', closeDate: '2026-10-10' })], ['2026-W42', '2026-W41']);
const merged = mergeWeeks(weeks, [{ ...feed[1], pnl: 20, pnlUsd: 20 }, { ...feed[0], id: 'ib-99', closeDate: '2026-10-08', openedAt: '2026-10-08T14:00:00Z', closedAt: '2026-10-08T15:00:00Z' }]);
eq('a merge replaces by id and adds the new', [merged.at(-1).count, merged.at(-1).pnlUsd, merged.length], [3, 516, 3]);
const again = mergeWeeks(weeks, [{ ...feed[0], id: 'ib-77', pnl: 250, pnlUsd: 250 }]);
eq('the same feed round trip under another id replaces the stored copy and keeps its id', [again.at(-1).count, again.at(-1).trades.map(t => t.id), again.at(-1).pnlUsd], [2, ['ib-1', feed[1].id], 269]);
{
  // One order filled on two exchanges in the same second, listed in either order: the same id.
  const split = (order) => roundTripsFromIbkr({ positions: [], trades: order([
    T(40, 'QQQ', 'OPT', 'BUY', 15, 0.97, '2026-10-06T14:48:05Z', 0, 70), T(31, 'QQQ', 'OPT', 'BUY', 15, 0.97, '2026-10-06T14:48:05Z', 0, 70),
    T(52, 'QQQ', 'OPT', 'SELL', 30, 1.28, '2026-10-06T15:23:39Z', 900, 71)]) }).map(t => t.id);
  eq('a spread\'s legs closed as two orders are not a round trip', roundTripsFromIbkr({ positions: [], trades: [
    T(60, 'JPY', 'FOP', 'BUY', 2, 5e-7, '2026-10-07T18:58:46Z', 277.22, 80), T(61, 'JPY', 'FOP', 'SELL', 2, 3.5e-6, '2026-10-07T19:08:33Z', -672.78, 81)] }), []);
  eq('a split fill gives one id whichever way the broker lists it', [split(x => x), split(x => [x[1], x[0], x[2]])], [['ib-31'], ['ib-31']]);
}

// ── ONE CONTRACT AT A TIME (17 Oct 2026) ──
// The feed calls every option fill by its underlying. A 1-DTE call bought on Wednesday, partly sold
// Thursday and expired for the rest (booked overnight) kept the underlying's combined position
// open across two separate day trades, which vanished into one multi-day "trade". Fake ticker,
// made-up sizes and prices.
eq('the connector\'s position line names the contract', contractFromDescription("XYZ Oct15'26 100 CALL @AMEX"), { root: 'XYZ', expiry: '2026-10-15', right: 'C', strike: 100 });
eq('a put, and a share line is not a contract', [contractKey(contractFromDescription("XYZ Oct16'26 90.5 PUT @CBOE")), contractFromDescription('XYZ')], ['XYZ|2026-10-16|P|90.5', null]);
{
  const T = (id, order, side, size, price, time, realized = 0) => ({ trade_id: id, order_id: order, symbol: 'XYZ', sec_type: 'OPT', side, size, price, trade_time: time, realized_pnl: realized, commission: 1, currency: 'USD' });
  const trades = [
    T('a1', 11, 'BUY', 10, 1.00, '2026-10-14T15:00:00Z'),
    T('b1', 12, 'BUY', 5, 1.00, '2026-10-15T14:00:00Z'),
    T('b2', 13, 'SELL', 5, 1.50, '2026-10-15T14:30:00Z', 245),
    T('a2', 14, 'SELL', 6, 0.40, '2026-10-15T15:00:00Z', -365),
    T('c1', 15, 'BUY', 3, 2.00, '2026-10-16T14:00:00Z'),
    T('c2', 16, 'SELL', 3, 3.00, '2026-10-16T14:20:00Z', 297),
    T('a3', 17, 'SELL', 4, 0, '2026-10-17T05:00:00Z', -400),          // the expiry booking
  ];
  const C = { root: 'XYZ', expiry: '2026-10-15', right: 'C', strike: 100 }, P1 = { root: 'XYZ', expiry: '2026-10-16', right: 'P', strike: 95 }, P2 = { ...P1, strike: 90 };
  const O = (orderId, c, side, qty, price, date) => ({ orderId, ...c, side, qty, price, date });
  const orders = [O('11', C, 'buy', 10, 1.00, '2026-10-14'), O('12', P1, 'buy', 5, 1.00, '2026-10-15'), O('13', P1, 'sell', 5, 1.50, '2026-10-15'),
                  O('14', C, 'sell', 6, 0.40, '2026-10-15'), O('15', P2, 'buy', 3, 2.00, '2026-10-16'), O('16', P2, 'sell', 3, 3.00, '2026-10-16')];
  const positions = [{ contract_description: "XYZ Oct16'26 90 PUT @AMEX", position: 0, average_price: 0, asset_class: 'OPT' }];
  const merged = roundTripsFromIbkr({ trades, positions, since: '2026-10-01' });
  eq('by underlying alone it is one trade, held past a day, and drops out of the journal', merged.length, 0);
  const report = {};
  const split = roundTripsFromIbkr({ trades, positions, since: '2026-10-01', contracts: orders, report });
  eq('by contract it is three', split.map(r => [r.contract, r.reason]), [
    ['XYZ 2026-10-15 100C', 'opened at 1 DTE'], ['XYZ 2026-10-16 95P', 'held under 24h'], ['XYZ 2026-10-16 90P', 'held under 24h']]);
  eq('the expiry booking closes the call it belongs to', split[0].closedAt, '2026-10-17T05:00:00Z');
  eq('each keeps IBKR\'s own realised P&L', split.map(r => r.pnlUsd), [-765, 245, 297]);
  eq('and the three add up to what the merged trade was', split.reduce((a, r) => a + r.pnlUsd, 0), -765 + 245 + 297);
  eq('the first keeps the merged trade\'s id, so a re-run replaces the stored row', split[0].id, 'ib-a1');
  eq('nothing was left grouped', report.unresolvedRoots, []);
  // The statement's order ids are not the feed's: the order itself is matched instead.
  const noIds = orders.map(o => ({ ...o, orderId: `x${o.orderId}` }));
  eq('matched on date, side, size and price when the ids do not meet', roundTripsFromIbkr({ trades, positions, since: '2026-10-01', contracts: noIds }).map(r => r.contract),
    ['XYZ 2026-10-15 100C', 'XYZ 2026-10-16 95P', 'XYZ 2026-10-16 90P']);
  // One order the statement does not have: the underlying is not half split, it falls back whole.
  const r2 = {};
  roundTripsFromIbkr({ trades, positions, since: '2026-10-01', contracts: orders.filter(o => o.orderId !== '15'), report: r2 });
  eq('a fill with no contract leaves its underlying grouped, and says so', r2.unresolvedRoots, ['XYZ']);
  // Two candidate statement orders for one feed order: no guess.
  const twin = [...noIds, { ...noIds[4], orderId: 'dup', strike: 85 }];
  const r3 = {};
  roundTripsFromIbkr({ trades, positions, since: '2026-10-01', contracts: twin, report: r3 });
  eq('an ambiguous match is not guessed at', r3.unresolvedRoots, ['XYZ']);
}
{
  const flexRows = [
    { assetCategory: 'OPT', orderId: '7', root: 'XYZ   261016P00095000', symbol: 'XYZ   261016P00095000', side: 'buy', qty: 2, rawPrice: 1.1, price: 1.11, date: '2026-10-16' },
    { assetCategory: 'STK', orderId: '8', root: 'XYZ', symbol: 'XYZ', side: 'buy', qty: 5, rawPrice: 10, date: '2026-10-16' },
  ];
  eq('the statement\'s option orders, contract read from the OCC symbol; shares left out', journalOrdersFromFlex(flexRows),
    [{ orderId: '7', root: 'XYZ', expiry: '2026-10-16', right: 'P', strike: 95, side: 'buy', qty: 2, price: 1.1, date: '2026-10-16' }]);
}

// ── THE ROUTE'S EDGES ──
ok('the statement request carries IBKR\'s date override when asked', /&fd=20261012&td=20261016&v=3$/.test(sendRequestUrl('t', 'q', { from: '2026-10-12', to: '2026-10-16' })));
ok('and not otherwise', !/fd=/.test(sendRequestUrl('t', 'q')));
eq('a window is required, ordered, and bounded', [journalRange({}).error != null, journalRange({ from: '2026-10-16', to: '2026-10-12' }).error != null,
  journalRange({ from: '2026-01-01', to: '2026-10-16' }).error != null, journalRange({ from: '2026-10-12', to: '2026-10-16' })],
  [true, true, true, { from: '2026-10-12', to: '2026-10-16' }]);
{
  const keep = { ...process.env };
  const req = (h) => ({ headers: h, query: {} });
  process.env.JOURNAL_READ_KEY = 'read-key-123'; process.env.TRADECARD_KEY = 'service-key-456'; delete process.env.TRADECARD_SECRET; delete process.env.JOURNAL_INBOX_TOKEN;
  ok('the journal key opens the journal read', hasJournalReadKey(req({ 'x-journal-key': 'read-key-123' })));
  ok('a wrong key does not', !hasJournalReadKey(req({ 'x-journal-key': 'read-key-124' })));
  ok('the service key does not open it', !hasJournalReadKey(req({ 'x-journal-key': 'service-key-456' })));
  ok('and the journal key is never a service key', !hasServiceKey(req({ 'x-tradecard-key': 'read-key-123' })));
  process.env.TRADECARD_KEY = 'read-key-123';
  ok('set to the same value as the service key, it opens nothing', !hasJournalReadKey(req({ 'x-journal-key': 'read-key-123' })));
  delete process.env.JOURNAL_READ_KEY;
  ok('unset, it lets nobody in', !hasJournalReadKey(req({ 'x-journal-key': '' })));
  for (const k of ['JOURNAL_READ_KEY', 'TRADECARD_KEY']) { if (k in keep) process.env[k] = keep[k]; else delete process.env[k]; }
}

// ── AN OPTION HELD TO A WORTHLESS EXPIRY (19 Oct 2026) ──
// The feed books the expiry as a sale at 0 with a realised P&L of 0, so a long that lost its whole
// premium read as breaking even. It is counted from its cash instead. Fake ticker, made-up figures.
{
  const T = (id, order, side, size, price, time, realized = 0, fee = 1) => ({ trade_id: id, order_id: order, symbol: 'XYZ', sec_type: 'OPT', side, size, price,
    net_amount: size * price * 100, trade_time: time, realized_pnl: realized, commission: fee, currency: 'USD' });
  const C = { root: 'XYZ', expiry: '2026-10-16', right: 'C', strike: 50 };
  const orders = [{ orderId: '21', ...C, side: 'buy', qty: 4, price: 1.5, date: '2026-10-16' }, { orderId: '22', ...C, side: 'sell', qty: 1, price: 2.0, date: '2026-10-16' }];
  const run = (trades) => roundTripsFromIbkr({ trades, positions: [], since: '2026-10-01', contracts: orders });
  const worthless = run([T('e1', 21, 'BUY', 4, 1.5, '2026-10-16T15:00:00Z'), T('e2', null, 'SELL', 4, 0, '2026-10-17T05:00:00Z', 0, 0)]);
  eq('a worthless expiry loses the premium and the commission, not nothing', [worthless.length, worthless[0]?.pnl, worthless[0]?.expired], [1, -601, true]);
  const partly = run([T('f1', 21, 'BUY', 4, 1.5, '2026-10-16T15:00:00Z'), T('f2', 22, 'SELL', 1, 2.0, '2026-10-16T16:00:00Z', 49),
    T('f3', null, 'SELL', 3, 0, '2026-10-17T05:00:00Z', 0, 0)]);
  eq('part sold, the rest expired: the sale\'s proceeds less the whole cost', partly[0]?.pnl, 200 - 600 - 2);
  const booked = run([T('g1', 21, 'BUY', 4, 1.5, '2026-10-16T15:00:00Z'), T('g2', null, 'SELL', 4, 0, '2026-10-17T05:00:00Z', -601, 0)]);
  eq('when IBKR did book the loss, its own figure stands, unmarked', [booked[0]?.pnl, booked[0]?.expired ?? null], [-601, null]);
}

// ── AN EXERCISE OR ASSIGNMENT IS NOT A TRADE (31 Oct 2026) ──
// The feed books the option leaving at 0 and the shares it delivers under the same order id. A put
// spread held from before, both legs in the money at expiry: the long put exercised (sold at 0,
// shares sold at the strike), the short put assigned (bought at 0, shares bought at the strike).
// Fake ticker, made-up figures.
{
  const T = (id, order, cls, side, size, price, time, realized = 0, fee = 0) => ({ trade_id: id, order_id: order, symbol: 'XYZ', sec_type: cls, side, size, price,
    net_amount: size * price * (cls === 'STK' ? 1 : 100), trade_time: time, realized_pnl: realized, commission: fee, currency: 'USD' });
  const at = '2026-10-31T03:01:46Z';
  const delivery = [T('x1', 31, 'OPT', 'SELL', 2, 0, at), T('x2', 31, 'STK', 'SELL', 200, 45, at),
    T('x3', 32, 'OPT', 'BUY', 2, 0, at), T('x4', 32, 'STK', 'BUY', 200, 50, at)];
  eq('the legs and their shares, flat to flat under one root: no round trip', roundTripsFromIbkr({ trades: delivery, positions: [], since: '2026-10-01' }), []);
  // Expiry bookings of two legs held from before, in orders of their own: they pair up while the
  // underlying is grouped, but nothing was traded.
  const legs = [T('y1', 41, 'OPT', 'SELL', 3, 0, at), T('y2', 42, 'OPT', 'BUY', 3, 0, at)];
  eq('bookings at 0 alone are not a round trip', roundTripsFromIbkr({ trades: legs, positions: [], since: '2026-10-01' }), []);
  // An option bought that day and exercised at the close: its value went into the shares, so it is
  // not a worthless expiry and is left out rather than counted at its full premium.
  const held = [T('z1', 51, 'OPT', 'BUY', 1, 2.5, '2026-10-30T19:00:00Z', 0, 1), T('z2', 52, 'OPT', 'SELL', 1, 0, at), T('z3', 52, 'STK', 'SELL', 100, 50, at)];
  eq('a same-day option exercised is not counted as a total loss', roundTripsFromIbkr({ trades: held, positions: [], since: '2026-10-01' }), []);
  // The worthless expiry still counts: a booking at 0 with no delivery in its order.
  const lost = roundTripsFromIbkr({ trades: [T('w1', 61, 'OPT', 'BUY', 1, 2.5, '2026-10-30T19:00:00Z', 0, 1), T('w2', null, 'OPT', 'SELL', 1, 0, at)], positions: [], since: '2026-10-01' });
  eq('…while a worthless expiry still loses its premium', [lost.length, lost[0]?.pnl, lost[0]?.expired], [1, -251, true]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
