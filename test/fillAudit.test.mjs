// test/fillAudit.test.mjs — the broker's fills against the console's.
import { sheetTime, sheetIdOf, sheetCsvUrl, parseCsv, parseBrokerFills, brokerKey, rowKey, auditFills, planFor, impliedEntry,
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
eq('981: it closes more than the console held, so it is a closed trade', [hk.missing[0].plan.action, hk.missing[0].plan.heldThen], ['closed-trade', 500]);
near('981: the entry implied from IBKR\'s realised P&L', hk.missing[0].plan.impliedEntry, (83750 - 67 - 9825.28) / 1000);
eq('MGC: both fills match within a day and 1%', A.instruments.find(i => i.key === 'fut:MGC').missing, []);
const br = A.instruments.find(i => i.key === 'BRNT');
eq('BRNT: 100 of 170 matched a day later; 70 missing, marked partial', br.missing.map(m => [m.qty, m.partOf]), [[70, 170]]);
eq('BRNT: a partial is added to the row, never a closed trade', br.missing[0].plan.action, 'add');
eq('BRNT: and has no implied entry', impliedEntry(br.missing[0], BR), null);
eq('what the console has no row for is counted, not audited', A.untracked.map(u => u.key).sort(), ['HYPE', 'TQQQ', 'opt:QQQ|2026-06-11|C|707']);
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

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
