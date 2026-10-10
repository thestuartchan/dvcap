// test/dayTradeJournal.test.mjs — the day-trading record: what the console's rules leave out.
import { parseBrokerFills } from '../lib/fillAudit.js';
import { nyDate, isoWeek, weekOf, mergeWeeks, journalReason, roundTripsFromSheet, roundTripsFromIbkr, toWeeks, FEED_FROM } from '../lib/dayTradeJournal.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
