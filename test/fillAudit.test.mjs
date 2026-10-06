// test/fillAudit.test.mjs — the broker's fills against the console's.
import { possibleDuplicates, tradesOf, undoCarryOver, isCarryOverFill, segments, swingRow, consoleSymbolOf, sheetTime, sheetIdOf, sheetCsvUrl, parseCsv, parseBrokerFills, brokerKey, rowKey, auditFills, planFor, impliedEntry,
         effectivePrice, fillFromBroker, closedTradeRow } from '../lib/fillAudit.js';
import { derivePosition } from '../lib/positions.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const near = (n, g, w, tol = 1e-6) => ok(`${n} (${g} ≈ ${w})`, g != null && Math.abs(g - w) <= tol);

// ── the sheet ──
eq('a pasted link gives the id', sheetIdOf('https://docs.google.com/spreadsheets/d/1sGoe_r8bTitQTvjuwRU-lnH5alDLhplMWD_MYGJJ5Pk/edit?usp=sharing'), '1sGoe_r8bTitQTvjuwRU-lnH5alDLhplMWD_MYGJJ5Pk');
eq('a bare id is kept; junk is null', [sheetIdOf('abcdefghijklmnopqrstuvwxyz'), sheetIdOf('hello')], ['abcdefghijklmnopqrstuvwxyz', null]);
ok('the CSV url names the tab', sheetCsvUrl('X'.repeat(25)).endsWith('&sheet=Fills%20(auto)'));
eq('CSV: quotes, commas and doubled quotes', parseCsv('"a","b,c","d""e"\n1,2,3\n'), [['a', 'b,c', 'd"e'], ['1', '2', '3']]);

const CSV = `"UID","Venue","DateTime (UTC)","Date","Symbol","Direction","Qty","Price","Realized PnL","Fee","Ccy"
"IBKR-110276026","IBKR","2026-07-10T02:21:00.000Z","2026-07-10","981","SELL","-1,000","83.75","9,825.28","-67.00","HKD"
"IBKR-122609107","IBKR","2026-09-30T03:35:00.000Z","2026-09-30","981","BUY","500","60.5","0.00","-24.20","HKD"
"IBKR-1","IBKR","2026-08-17T10:44:00.000Z","2026-08-17","MGCV6","BUY","1","4,442.7","0.00","-0.96","USD"
"IBKR-2","IBKR","2026-08-26T13:56:00.000Z","2026-08-26","MGCV6","SELL","-1","4,613.8","1,708.91","-0.96","USD"
"IBKR-3","IBKR","2026-09-01T14:00:00.000Z","2026-09-01","BRNTl","BUY","170","95.35","0.00","-3.00","USD"
"IBKR-4","IBKR","2026-06-11T14:00:00.000Z","2026-06-11","QQQ   260611C00707000","BUY","5","2.39","0.00","-3.00","USD"
"IBKR-5","IBKR","2026-06-11T15:00:00.000Z","2026-06-11","USD.HKD","BUY","1000","7.8","0.00","0","HKD"
"IBKR-6","IBKR","2026-06-12T15:00:00.000Z","2026-06-12","TQQQ","BUY","150","74.1","0.00","-1","USD"
"HL-9","Hyperliquid","2026-06-06T14:24:04.102Z","2026-06-06","HYPE","Open Long","32.47","58.5","0.00","0.28","USDC"
"x","IBKR","","","FOO","","","",""`;
const P = parseBrokerFills(CSV);
eq('every fill parsed; the blank row dropped', [P.fills.length, P.dropped, P.error], [9, 1, null]);
eq('a sale is a sell of a positive quantity, commas read', [P.fills[0].side, P.fills[0].qty, P.fills[0].realized], ['sell', 1000, 9825.28]);
eq('Hyperliquid Open Long is a buy', P.fills.at(-1).side, 'buy');
eq('a tab without the columns says so', parseBrokerFills('"a","b"\n1,2').error, 'the tab has no uid, symbol, dir, qty, price column — is it "Fills (auto)"?');

// ── the sheet's clock: IBKR rows are New York time labelled Z ──
eq('981\'s sale: 02:21 "Z" in the sheet is 06:21 UTC, as IBKR has it', sheetTime('2026-07-10T02:21:00.000Z', { venue: 'IBKR', currency: 'HKD' }), { time: '2026-07-10T06:21:00.000Z', date: '2026-07-10' });
eq('a Hong Kong morning trade the sheet put on the previous day is back on its own', sheetTime('2026-09-16T21:45:00.000Z', { venue: 'IBKR', currency: 'HKD' }), { time: '2026-09-17T01:45:00.000Z', date: '2026-09-17' });
eq('a US trade keeps its New York date', sheetTime('2026-10-02T15:57:00.000Z', { venue: 'IBKR', currency: 'USD' }), { time: '2026-10-02T19:57:00.000Z', date: '2026-10-02' });
eq('in winter the shift is five hours', sheetTime('2026-12-01T10:00:00.000Z', { venue: 'IBKR', currency: 'USD' }).time, '2026-12-01T15:00:00.000Z');
eq('Hyperliquid rows are the UTC they say', sheetTime('2026-06-06T14:24:04.102Z', { venue: 'Hyperliquid', currency: 'USDC' }), { time: '2026-06-06T14:24:04.102Z', date: '2026-06-06' });
eq('the parser applies it', P.fills[0].time, '2026-07-10T06:21:00.000Z');

// ── keys ──
eq('981 and 0981.HK are one instrument', [brokerKey({ symbol: '981' }).key, rowKey({ symbol: '0981.HK' }).key], ['981', '981']);
eq('MGCV6 and a margined MGC row are one', [brokerKey({ symbol: 'MGCV6' }).key, rowKey({ symbol: 'MGC', margined: true, multiplier: 10 }).key], ['fut:MGC', 'fut:MGC']);
eq('BRNTl and BRNT.L are one', [brokerKey({ symbol: 'BRNTl' }).key, rowKey({ symbol: 'BRNT.L' }).key], ['BRNT', 'BRNT']);
eq('an FX conversion is out of scope', brokerKey({ symbol: 'USD.HKD' }), null);
eq('an OCC option and a one-leg row are one contract',
   [brokerKey({ symbol: 'QQQ   260611C00707000' }).key, rowKey({ symbol: 'QQQ', underlying: 'QQQ', instrument: 'option', legs: [{ right: 'C', strike: 707, expiry: '2026-06-11', side: 'long' }] }).key],
   ['opt:QQQ|2026-06-11|C|707', 'opt:QQQ|2026-06-11|C|707']);
eq('a spread is not checked', rowKey({ symbol: 'QQQ', instrument: 'spread', legs: [{ right: 'C', strike: 700, expiry: '2026-06-11', side: 'long' }, { right: 'C', strike: 710, expiry: '2026-06-11', side: 'short' }] }).key, null);
ok('a stock ending in a month letter is not a future', brokerKey({ symbol: 'ASTX' }).kind === 'equity' && brokerKey({ symbol: '7709' }).kind === 'equity');

// ── 0981.HK as the console had it on 5 Oct ──
const HK = { id: 'hk', symbol: '0981.HK', currency: 'HKD', side: 'long', multiplier: 1, fills: [
  { id: 'a', side: 'buy', qty: 500, price: 63.921452, date: '2026-07-10', note: 'bulk average of the IBKR fills for this trade, commissions included' },
  { id: 'b', side: 'buy', qty: 500, price: 60.5, date: '2026-09-30', tradeId: '122609107:12345' },
] };
const MGC = { id: 'mgc', symbol: 'MGC', margined: true, multiplier: 10, side: 'long', fills: [
  { id: 'm1', side: 'buy', qty: 1, price: 4442.796, date: '2026-08-17' }, { id: 'm2', side: 'sell', qty: 1, price: 4613.7, date: '2026-08-26' } ] };
const BR = { id: 'br', symbol: 'BRNT.L', side: 'long', fills: [{ id: 'x', side: 'buy', qty: 100, price: 95.37, date: '2026-09-02' }] };
const A = auditFills([HK, MGC, BR], P.fills);
const hk = A.instruments.find(i => i.key === '981');
eq('the window is the sheet\'s', [A.from, A.to], ['2026-06-06', '2026-09-30']);
eq('981: the 10 Jul sale is missing; the 30 Sep buy matched on trade id', hk.missing.map(m => `${m.side} ${m.qty} ${m.date}`), ['sell 1000 2026-07-10']);
eq('981: the bulk-average buy is reported as not seen at the broker', hk.unseen.map(u => u.fillId), ['a']);
eq('981: a trade of its own — none of it in the console — so it is a closed trade', [hk.missing[0].plan.action, hk.missing[0].plan.heldThen], ['closed-trade', 0]);
near('981: the entry implied from IBKR\'s realised P&L', hk.missing[0].plan.impliedEntry, (83750 - 67 - 9825.28) / 1000);
eq('MGC: both fills match within a day and 1%', A.instruments.find(i => i.key === 'fut:MGC').missing, []);
const br = A.instruments.find(i => i.key === 'BRNT');
eq('BRNT: 100 of 170 matched a day later; 70 missing, marked partial', br.missing.map(m => [m.qty, m.partOf]), [[70, 170]]);
eq('BRNT: a partial is added to the row, never a closed trade', br.missing[0].plan.action, 'add');
eq('BRNT: and has no implied entry', impliedEntry(br.missing[0], BR), null);
eq('no row: crypto is out of scope; a 0DTE option bought and expired the same day is a day trade', [A.outOfScope, A.dayTrades.trades >= 1], [{ crypto: 1 }, true]);
eq('no row, still held at the end: left to the daily sync, which adds held positions', A.heldNoRow.map(h => h.symbol), ['TQQQ']);
eq('missing count', A.missingCount, 2);

// ── the closed trade it would record reproduces IBKR's realised P&L exactly ──
const row = closedTradeRow(hk.missing[0], HK, { from: A.from });
const d = derivePosition(row.fills, { multiplier: 1, side: 'long' });
near('the closed 981 trade realises what IBKR says', d.realised ?? d.realized ?? d.realizedPnl, 9825.28, 0.01);
eq('it is closed, opened at the start of the history', [d.status, row.fills[0].date, row.symbol, row.currency], ['closed', '2026-06-06', '0981.HK', 'HKD']);
ok('it says where its entry came from', /implied from IBKR's realised P&L/.test(row.fills[0].note) && row.thesis.split(' ').length > 3);

// ── prices ──
near('a buy\'s effective price includes the fee', effectivePrice({ side: 'buy', qty: 500, price: 60.5, fee: -24.2 }), 60.5484);
near('a sell\'s excludes it', effectivePrice({ side: 'sell', qty: 1, price: 4613.8, fee: -0.96 }, 10), 4613.704);
eq('a broker fill carries its uid as the trade id', fillFromBroker({ uid: 'IBKR-3', venue: 'IBKR', side: 'buy', qty: 70, price: 95.35, fee: -3, date: '2026-09-01' }).tradeId, 'IBKR-3');
// …so a second audit matches it on the id and does not report it again.
const BR2 = { ...BR, fills: [...BR.fills, fillFromBroker({ ...br.missing[0] })] };
eq('after adding, the audit is clean', auditFills([BR2], P.fills.filter(f => f.symbol === 'BRNTl')).missingCount, 0);
// A sale fully inside what the row held is just added.
const OPEN = { id: 'o', symbol: 'AAPL', side: 'long', fills: [{ id: 'f', side: 'buy', qty: 100, price: 200, date: '2026-07-01' }] };
eq('a sale within what was held is added to the row', planFor({ side: 'sell', qty: 40, date: '2026-08-01', price: 210, realized: 400 }, [OPEN]), { action: 'add', rowId: 'o' });

// ── the console's scope rules, judged as of each trade's date ──
{
  const f = (uid, symbol, side, qty, price, time, extra = {}) => ({ uid, venue: 'IBKR', symbol, side, qty, price, time, date: time.slice(0, 10), currency: 'USD', fee: -1, realized: 0, ...extra });
  const BR = [
    // AMD, no console row: a same-day round trip (day trade) and a three-day swing.
    f('d1', 'AMD', 'buy', 100, 150, '2026-07-01T14:00:00Z'), f('d2', 'AMD', 'sell', 100, 152, '2026-07-01T19:00:00Z', { realized: 198 }),
    f('s1', 'AMD', 'buy', 50, 140, '2026-07-06T14:00:00Z'), f('s2', 'AMD', 'sell', 50, 155, '2026-07-09T15:00:00Z', { realized: 748 }),
    // USFR, no row: cash, out.
    f('c1', 'USFR', 'buy', 100, 50.4, '2026-07-01T14:00:00Z'),
    // NVDA: a June scalp before the console row existed (out), then a scalp while held (in).
    f('n1', 'NVDA', 'buy', 10, 120, '2026-06-20T14:00:00Z'), f('n2', 'NVDA', 'sell', 10, 121, '2026-06-20T16:00:00Z', { realized: 8 }),
    f('n3', 'NVDA', 'buy', 100, 130, '2026-08-01T14:00:00Z'),
    f('n4', 'NVDA', 'buy', 20, 140, '2026-08-20T14:00:00Z'), f('n5', 'NVDA', 'sell', 20, 141, '2026-08-20T17:00:00Z', { realized: 18 }),
    // 7709: three buys the console holds as one "bulk average" fill.
    f('h1', '7709', 'buy', 300, 50, '2026-07-14T02:00:00Z', { currency: 'HKD' }), f('h2', '7709', 'buy', 300, 51, '2026-07-15T02:00:00Z', { currency: 'HKD' }),
    f('h3', '7709', 'buy', 200, 51, '2026-07-16T02:00:00Z', { currency: 'HKD' }),
    // XOM, no row: shares bought before the history, sold inside it — IBKR booked the P&L.
    f('x1', 'XOM', 'sell', 40, 110, '2026-07-20T15:00:00Z', { realized: 400 }),
  ];
  const ROWS = [
    { id: 'nv', symbol: 'NVDA', side: 'long', fills: [{ id: 'a', side: 'buy', qty: 100, price: 130, date: '2026-08-01' }] },
    { id: 'hk7709', symbol: '7709.HK', currency: 'HKD', side: 'long', fills: [{ id: 'b', side: 'buy', qty: 800, price: 50.65, date: '2026-07-16', note: 'bulk average' }] },
  ];
  const R = auditFills(ROWS, BR);
  eq('a same-day round trip with no position is a day trade, left out', [R.dayTrades.trades >= 1, R.instruments.some(i => i.missing.some(m => m.uid === 'd1'))], [true, false]);
  eq('a multi-day round trip with no row is a swing, offered not filed', R.swings.map(w => [w.symbol, w.from, w.to, w.realized]), [['AMD', '2026-07-06', '2026-07-09', 748]]);
  eq('cash with no row is out', R.outOfScope['cash equivalents'], 1);
  const nv = R.instruments.find(i => i.key === 'NVDA');
  eq('NVDA: the June scalp, before the console held it, is a day trade; the August scalp while held is in',
     [nv.missing.map(m => m.uid), R.dayTrades.trades], [['n4', 'n5'], 2]);
  eq('NVDA: the in-position scalp is added to the row', nv.missing.map(m => m.plan.action), ['add', 'add']);
  eq('7709: three buys absorbed by the bulk-average fill — nothing to add, nothing unseen',
     [R.instruments.find(i => i.key === '7709')?.missing.length ?? 0, R.instruments.find(i => i.key === '7709')?.unseen.length ?? 0], [0, 0]);
  const xom = R.instruments.find(i => i.key === 'XOM');
  eq('XOM: a sale of pre-history shares is a closed trade with an implied entry', [xom.noRow, xom.missing[0].plan.action], [true, 'closed-trade']);
  near('…entry implied from the realised P&L', xom.missing[0].plan.impliedEntry, (110 * 40 - 1 - 400) / 40);
  const xr = closedTradeRow(xom.missing[0], null, { from: R.from });
  eq('…and the row it would record has the console\'s name and closes flat', [xr.symbol, derivePosition(xr.fills, { side: 'long' }).status], ['XOM', 'closed']);
  const sw = swingRow(R.swings[0]);
  near('the AMD swing row realises what IBKR booked', derivePosition(sw.fills, { side: 'long' }).realised ?? derivePosition(sw.fills, { side: 'long' }).realized, 748, 0.01);
  eq('segments: flat-to-flat, a day, a swing, a pre-history close',
     segments([BR[0], BR[1], BR[2], BR[3], BR[13]]).map(g => g.kind), ['day', 'swing', 'pre-history-close']);
  eq('console names', [consoleSymbolOf({ symbol: '981', currency: 'HKD' }), consoleSymbolOf({ symbol: 'BRNTl' }), consoleSymbolOf({ symbol: 'MGCZ6' })], ['0981.HK', 'BRNT.L', 'MGC']);
  ok('a futures swing with an unknown multiplier is not recorded blind', swingRow({ fills: [f('z1', 'ZZZZZ6', 'buy', 1, 10, '2026-07-01T14:00:00Z'), f('z2', 'ZZZZZ6', 'sell', 1, 11, '2026-07-03T14:00:00Z')], from: '2026-07-01', to: '2026-07-03', rowLike: null }) === null);
}

// ── undo removes exactly what the carry-over wrote ──
{
  const added = fillFromBroker({ uid: 'IBKR-77', venue: 'IBKR', side: 'buy', qty: 5, price: 10, fee: -1, date: '2026-07-01' });
  const hand = { id: 'bfx', side: 'buy', qty: 1, price: 1, date: '2026-07-02', note: 'typed by hand' };   // a "bf" id, but not ours
  const rowsIn = [
    { id: 'keep', symbol: 'AAPL', fills: [{ id: 'f1', side: 'buy', qty: 10, price: 200, date: '2026-07-01' }, added, hand] },
    closedTradeRow({ uid: 'IBKR-9', venue: 'IBKR', side: 'sell', qty: 10, price: 50, fee: -1, realized: 100, date: '2026-07-10', currency: 'USD', partOf: null }, { symbol: 'XOM', side: 'long', multiplier: 1 }, { from: '2026-06-06' }),
    { id: 'other', symbol: 'MSFT', tags: ['flex'], fills: [{ id: 'g', side: 'buy', qty: 1, price: 1, date: '2026-07-01', tradeId: '123:4' }] },
  ];
  ok('a carry-over fill is recognised; a hand fill with a similar id is not', isCarryOverFill(added) && !isCarryOverFill(hand));
  const u = undoCarryOver(rowsIn);
  eq('undo drops the carried-over row and fill, keeps everything else', [u.removedRows, u.removedFills, u.touched, u.rows.map(r => r.id), u.rows[0].fills.map(f => f.id)],
     [1, 1, ['keep'], ['keep', 'other'], ['f1', 'bfx']]);
  eq('undo twice changes nothing more', [undoCarryOver(u.rows).removedRows, undoCarryOver(u.rows).removedFills], [0, 0]);
  ok('a carry-over fill fits what the store keeps (id ≤16, tradeId ≤24, note ≤200)', added.id.length <= 16 && added.tradeId.length <= 24 && added.note.length <= 200
     && rowsIn[1].fills.every(f => f.id.length <= 16 && String(f.note).length <= 200) && rowsIn[1].id.length <= 48 && rowsIn[1].thesis.length <= 600);
}

// ── trade by trade, cut with IBKR's realised P&L ──
{
  const t = A.instruments.find(i => i.key === '981').trades;
  eq('981 as trades: the 10 Jul sale is a CLOSED LONG from before the history (the sheet\'s Trades tab calls it a short), then an open buy',
     t.map(x => [x.kind, x.side, x.from, x.qty, x.realized]), [['pre-history-close', 'long', '2026-07-10', 1000, 9825.28], ['open', 'long', '2026-09-30', 500, 0]]);
  eq('…the missing sale sits under its trade; the recorded buy has nothing missing', t.map(x => x.missing.length), [1, 0]);
  const mg = tradesOf([P.fills[2], P.fills[3]], []);
  eq('a round trip is one closed trade with both averages', mg.map(x => [x.kind, x.side, x.avgIn, x.avgOut, x.realized, x.dayTrade]), [['closed', 'long', 4442.7, 4613.8, 1708.91, false]]);
}

// ── options with no console row: the console's option rules ──
{
  const o = (uid, sym, side, qty, price, time, extra = {}) => ({ uid, venue: 'IBKR', symbol: sym, side, qty, price, time, date: time.slice(0, 10), currency: 'USD', fee: -1, realized: 0, ...extra });
  const SW = 'AMD   260821C00180000', ODTE = 'SPY   260709P00600000', EXP = 'XOP   260918C00150000';
  const R = auditFills([], [
    o('a1', SW, 'buy', 5, 4.0, '2026-07-20T14:00:00Z'), o('a2', SW, 'sell', 5, 6.5, '2026-07-27T15:00:00Z', { realized: 1248 }),   // a 5-week call, 1 week held
    o('b1', ODTE, 'buy', 10, 1.2, '2026-07-08T19:00:00Z'), o('b2', ODTE, 'sell', 10, 1.5, '2026-07-09T14:00:00Z', { realized: 298 }),   // 1DTE held overnight
    o('c1', EXP, 'buy', 2, 3.0, '2026-08-20T14:00:00Z'),                                                                                  // expired, no close
    o('z9', 'MSFT', 'buy', 1, 1, '2026-09-30T14:00:00Z'),                                                                                 // sets the history's end
  ]);
  eq('a multi-day option swing is offered; the 1DTE one held overnight is a day trade', [R.swings.map(w => w.symbol), R.dayTrades.trades], [['AMD 2026-08-21 180C', 'XOP 2026-09-18 150C'], 1]);
  const amd = swingRow(R.swings[0]);
  eq('…as the console builds an option row: underlying, one long leg, ×100', [amd.symbol, amd.instrument, amd.legs.map(l => [l.right, l.strike, l.expiry, l.side]), amd.multiplier, amd.side],
     ['AMD', 'option', [['C', 180, '2026-08-21', 'long']], 100, 'long']);
  near('…and realises what IBKR booked', derivePosition(amd.fills, { multiplier: 100, side: 'long' }).realised ?? derivePosition(amd.fills, { multiplier: 100, side: 'long' }).realized, 1248, 0.02);
  const xop = swingRow(R.swings[1]);
  eq('an option past expiry with no close is closed at zero on its expiry, and says so', [xop.fills.at(-1).side, xop.fills.at(-1).price, xop.fills.at(-1).date, /expired 2026-09-18/.test(xop.fills.at(-1).note), isCarryOverFill(xop.fills.at(-1))],
     ['sell', 0, '2026-09-18', true, true]);
  eq('…closed, at the premium paid lost', [derivePosition(xop.fills, { multiplier: 100, side: 'long' }).status, Math.round(derivePosition(xop.fills, { multiplier: 100, side: 'long' }).realized ?? derivePosition(xop.fills, { multiplier: 100, side: 'long' }).realised)], ['closed', -601]);
}

// ── what the first real run showed (6 Oct) ──
{
  const q = (uid, symbol, side, qty, price, time, extra = {}) => ({ uid, venue: 'IBKR', symbol, side, qty, price, time, date: time.slice(0, 10), currency: 'USD', fee: -1, realized: 0, ...extra });
  const BR = [
    // TQQQ: two buys four days apart that the console holds as one "1,000 @ 69.40" dated the first day…
    q('t1', 'TQQQ', 'buy', 500, 70.55, '2026-08-20T14:00:00Z'), q('t2', 'TQQQ', 'buy', 500, 68.2395, '2026-08-24T14:00:00Z'),
    q('t3', 'TQQQ', 'sell', 1000, 69.45, '2026-08-24T19:00:00Z', { realized: 42 }),
    // …then a same-day round trip while the broker was flat, and a two-day swing.
    q('t4', 'TQQQ', 'buy', 1000, 72.85, '2026-08-27T14:00:00Z'), q('t5', 'TQQQ', 'sell', 1000, 73.2, '2026-08-27T18:00:00Z', { realized: 350 }),
    q('t6', 'TQQQ', 'buy', 700, 72.02, '2026-09-08T19:00:00Z'), q('t7', 'TQQQ', 'sell', 700, 71.75, '2026-09-09T14:00:00Z', { realized: -190 }),
    // AVGO shares, and a share-typed AVGO row holding option fills.
    q('v1', 'AVGO', 'buy', 25, 355.19, '2026-10-02T15:57:00Z'),
  ];
  const ROWS = [
    { id: 'tq', symbol: 'TQQQ', side: 'long', fills: [{ id: 'a', side: 'buy', qty: 1000, price: 69.400203, date: '2026-08-20' }, { id: 'b', side: 'sell', qty: 1000, price: 69.45, date: '2026-08-24' }] },
    { id: 'av', symbol: 'AVGO', side: 'long', fills: [{ id: 'c', side: 'buy', qty: 25, price: 355.23, date: '2026-10-02' }] },
    { id: 'avo', symbol: 'AVGO', side: 'long', multiplier: 100, fills: [{ id: 'd', side: 'buy', qty: 10, price: 2.554549, date: '2026-08-26' }, { id: 'e', side: 'sell', qty: 10, price: 4.582563, date: '2026-08-27' }] },
  ];
  const R = auditFills(ROWS, BR);
  const tq = R.instruments.find(i => i.key === 'TQQQ');
  eq('a bulk fill dated at the trade\'s first fill absorbs the later buy too', tq.unseen, []);
  eq('the same-day round trip with the broker flat is a day trade; the two-day one a swing; nothing to add', [tq.missing.length, tq.trades.map(t => t.status)], [0, ['recorded', 'day', 'swing']]);
  eq('…and the swing is offered as its own row', R.swings.map(w => [w.symbol, w.from, w.to]), [['TQQQ', '2026-09-08', '2026-09-09']]);
  eq('an option kept on a share row (×100, no contract) is not held against the shares', [R.unchecked.map(u => u.rowId), R.instruments.find(i => i.key === 'AVGO')?.unseen ?? []], [['avo'], []]);
}

// ── a swing realises exactly what IBKR booked, whatever the sheet's fees ──
{
  const o = (uid, side, qty, price, date, fee, realized = 0) => ({ uid, venue: 'IBKR', symbol: 'INTC  261002C00115000', side, qty, price, date, time: date + 'T16:00:00Z', currency: 'USD', fee, realized });
  const sw = { key: 'k', symbol: 'INTC 2026-10-02 115C', from: '2026-09-09', to: '2026-09-17', realized: 380.98, rowLike: null,
               fills: [o('IBKR-119519528', 'buy', 1, 3.7, '2026-09-09', -1.03), o('IBKR-119519638', 'buy', 5, 3.7, '2026-09-09', -3.07), o('IBKR-120804132', 'sell', 6, 4.35, '2026-09-17', -4.17, 380.98)] };
  const row = swingRow(sw);
  const d = derivePosition(row.fills, { multiplier: 100, side: 'long' });
  near('INTC 115C: the console realises IBKR\'s 380.98, not the sheet-fee 381.73', d.realized ?? d.realised, 380.98, 0.005);
  ok('…and the adjusted fill says so', /adjusted -0\.75 so the trade's P&L equals IBKR's/.test(row.fills.at(-1).note) && row.fills.at(-1).note.length <= 200);
  eq('the row: INTC, one 115 call, Oct 2, archived carry-over', [row.symbol, row.instrument, row.legs[0].strike, row.legs[0].right, row.legs[0].expiry, row.tags], ['INTC', 'option', 115, 'C', '2026-10-02', ['broker-fills']]);
}

// ── the second real run (6 Oct): spreads, a contract-less option row, bulk beside day trades ──
{
  const q = (uid, symbol, side, qty, price, time, extra = {}) => ({ uid, venue: 'IBKR', symbol, side, qty, price, time, date: time.slice(0, 10), currency: 'USD', fee: -1, realized: 0, ...extra });
  const BR = [
    // TQQQ 20 Aug: a morning round trip, then the swing the console holds as one bulk buy.
    q('d1', 'TQQQ', 'buy', 300, 71.0, '2026-08-20T13:40:00Z'), q('d2', 'TQQQ', 'sell', 300, 71.2, '2026-08-20T14:10:00Z', { realized: 59 }),
    q('t1', 'TQQQ', 'buy', 500, 70.55, '2026-08-20T18:00:00Z'), q('t2', 'TQQQ', 'buy', 500, 68.2395, '2026-08-24T14:00:00Z'),
    q('t3', 'TQQQ', 'sell', 1000, 69.45, '2026-08-24T19:00:00Z', { realized: 42 }),
    // The SOFI call spread, held as a spread row.
    q('s1', 'SOFI  261120C00017000', 'buy', 15, 1.33, '2026-09-24T15:00:00Z'), q('s2', 'SOFI  261120C00020000', 'sell', 15, 0.47, '2026-09-24T15:00:00Z'),
    // AVGO 360C, kept in the console on a share row at x100 with no contract.
    q('a1', 'AVGO  260828C00360000', 'buy', 4, 2.5, '2026-08-26T15:00:00Z'), q('a2', 'AVGO  260828C00360000', 'buy', 6, 2.59, '2026-08-26T16:00:00Z'),
    q('a3', 'AVGO  260828C00360000', 'sell', 10, 4.58, '2026-08-27T15:00:00Z', { realized: 2027 }),
    // An AMD put swing, with a console AMD share row trading the same week.
    q('p1', 'AMD   260821P00460000', 'buy', 1, 9.0, '2026-07-20T15:00:00Z'), q('p2', 'AMD   260821P00460000', 'sell', 1, 11.9, '2026-07-27T15:00:00Z', { realized: 283 }),
    q('z9', 'MSFT', 'buy', 1, 1, '2026-09-30T14:00:00Z'),
  ];
  const ROWS = [
    { id: 'tq', symbol: 'TQQQ', side: 'long', fills: [{ id: 'a', side: 'buy', qty: 1000, price: 69.400203, date: '2026-08-20' }, { id: 'b', side: 'sell', qty: 1000, price: 69.45, date: '2026-08-24' }] },
    { id: 'sofi', symbol: 'SOFI', underlying: 'SOFI', instrument: 'spread', multiplier: 100, side: 'long',
      legs: [{ right: 'C', strike: 17, expiry: '2026-11-20', side: 'long', ratio: 1 }, { right: 'C', strike: 20, expiry: '2026-11-20', side: 'short', ratio: 1 }],
      fills: [{ id: 'c', side: 'buy', qty: 15, price: 0.86, date: '2026-09-24' }] },
    { id: 'avo', symbol: 'AVGO', side: 'long', multiplier: 100, fills: [{ id: 'd', side: 'buy', qty: 10, price: 2.554549, date: '2026-08-26' }, { id: 'e', side: 'sell', qty: 10, price: 4.582563, date: '2026-08-27' }] },
    { id: 'amd', symbol: 'AMD', side: 'long', fills: [{ id: 'f', side: 'buy', qty: 20, price: 150, date: '2026-07-22' }] },
  ];
  const R = auditFills(ROWS, BR);
  const tq = R.instruments.find(i => i.key === 'TQQQ');
  eq('TQQQ: the bulk buy finds its two fills inside its own trade, past the morning round trip', [tq?.missing.length ?? 0, tq?.unseen ?? []], [0, []]);
  eq('the spread\'s legs are its own — not "no console row", not swings', [R.inSpread.map(x => x.contract).sort(), R.heldNoRow.some(h => /SOFI/.test(h.symbol)), R.swings.some(w => /SOFI/.test(w.symbol))],
     [['SOFI 2026-11-20 17C', 'SOFI 2026-11-20 20C'], false, false]);
  eq('the AVGO share row at x100 is that 360C — recorded, not offered again', [R.adopted.map(a => [a.rowId, a.contract]), R.swings.some(w => /AVGO/.test(w.symbol)), R.unchecked.map(u => u.rowId)],
     [[['avo', 'AVGO 2026-08-28 360C']], false, ['sofi']]);
  const amd = R.swings.find(w => /AMD/.test(w.symbol));
  eq('a swing on an underlying the console traded those days names that row', amd.possibleDup.map(d => d.rowId), ['amd']);
  eq('…and one with nothing nearby names none', possibleDuplicates(ROWS, 'INTC', '2026-09-09', '2026-09-17'), []);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
