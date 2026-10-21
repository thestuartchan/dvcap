// A fill already on the console is not offered again (lib/journalInbox.js, after combos are joined).
// On 21 Oct a spread confirmed into the console another way, and fills typed in by hand, stayed in
// the unjournaled list sync after sync. Made-up tickers, order ids and prices throughout.
import { parseTradeConfirms } from '../lib/flexTrades.js';
import { processInbox } from '../lib/journalInbox.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

const tc = (rows) => `<FlexQueryResponse queryName="same-day" type="TCF"><FlexStatements count="1"><FlexStatement accountId="U0000000" fromDate="20261012" toDate="20261012" period="Today"><TradeConfirms>${rows.join('')}</TradeConfirms></FlexStatement></FlexStatements></FlexQueryResponse>`;
const opt = (o) => `<TradeConfirm accountId="U0000000" currency="USD" assetCategory="OPT" symbol="${o.u} x" conid="${o.conid}" underlyingSymbol="${o.u}" multiplier="100" strike="${o.k}" expiry="20261218" putCall="${o.r}" tradeID="" tradeDate="20261012" dateTime="20261012;${o.t}" buySell="${o.side}" quantity="${o.side === 'SELL' ? -o.q : o.q}" price="${o.px}" commission="-1.05" orderID="${o.oid}" levelOfDetail="ORDER" transactionType="ExchTrade" />`;
const stk = (o) => `<TradeConfirm accountId="U0000000" currency="USD" assetCategory="STK" symbol="${o.u}" conid="${o.conid}" multiplier="1" tradeID="" tradeDate="20261012" dateTime="20261012;${o.t}" buySell="${o.side}" quantity="${o.side === 'SELL' ? -o.q : o.q}" price="${o.px}" commission="-1.00" orderID="${o.oid}" levelOfDetail="ORDER" transactionType="ExchTrade" />`;

const TODAY = '2026-10-12';
const trades = parseTradeConfirms(tc([
  opt({ u: 'XYZ', conid: 101, k: 440, r: 'C', side: 'BUY', q: 1, px: 32.97, oid: 9001, t: '101205' }),
  opt({ u: 'XYZ', conid: 102, k: 500, r: 'C', side: 'SELL', q: 1, px: 14.26, oid: 9002, t: '101205' }),
  stk({ u: 'ABC', conid: 201, side: 'BUY', q: 200, px: 68.30, oid: 9101, t: '110000' }),
  stk({ u: 'LMN', conid: 301, side: 'SELL', q: 8, px: 714.00, oid: 9201, t: '120000' }),
  stk({ u: 'QRS', conid: 401, side: 'BUY', q: 10, px: 50.00, oid: 9301, t: '100000' }),
  stk({ u: 'QRS', conid: 401, side: 'BUY', q: 10, px: 50.00, oid: 9302, t: '140000' }),
]));
const run = (rows, drafts = [], seen = {}) => processInbox({ trades, today: TODAY, from: '2026-10-01', provisional: true, rows, drafts, seen });

// Sync 1: nothing on the console, every fill offered.
const first = run([]);
const offered = (r) => r.drafts.filter(d => d.source === 'unjournaled').map(d => d.fill.orderId).sort();
eq('sync 1 offers the spread, both shares and the two QRS buys', offered(first), ['9001+9002', '9101', '9201', '9301', '9302']);

// Between syncs: the spread confirmed another way (its id on the console), ABC typed by hand a day
// "later" in Dubai with the price including commission, LMN typed at a price 5% off, one QRS typed.
const spread = { id: 'r1', symbol: 'XYZ', side: 'long', instrument: 'option', multiplier: 100,
  legs: [{ right: 'C', strike: 440, expiry: '2026-12-18', side: 'long', ratio: 1 }, { right: 'C', strike: 500, expiry: '2026-12-18', side: 'short', ratio: 1 }],
  fills: [{ id: 'f1', side: 'buy', qty: 1, price: 18.73, date: TODAY, tradeId: '9001+9002' }] };
const abc = { id: 'r2', symbol: 'ABC', side: 'long', fills: [{ id: 'f1', side: 'buy', qty: 200, price: 68.305, date: '2026-10-13' }] };
const lmn = { id: 'r3', symbol: 'LMN', side: 'long', fills: [{ id: 'f0', side: 'buy', qty: 8, price: 650, date: '2026-09-01', tradeId: 'old1' }, { id: 'f1', side: 'sell', qty: 8, price: 750, date: TODAY }] };
const qrs = { id: 'r4', symbol: 'QRS', side: 'long', fills: [{ id: 'f1', side: 'buy', qty: 10, price: 50.01, date: TODAY }] };
const second = run([spread, abc, lmn, qrs], first.drafts, first.seen);
eq('sync 2: the spread the console holds by id is withdrawn', second.drafts.some(d => d.fill?.orderId === '9001+9002'), false);
eq('…ABC typed by hand, next Dubai date, price with commission, is withdrawn', second.drafts.some(d => d.fill?.orderId === '9101'), false);
eq('…LMN typed 5% off the fill stays offered', second.drafts.some(d => d.fill?.orderId === '9201'), true);
eq('…one typed QRS buy takes one of the two QRS orders, not both', second.drafts.filter(d => d.fill?.root === 'QRS').length, 1);
eq('…and the withdrawn orders read as already in the console', ['9001', '9002', '9101'].map(o => second.fate[o]), ['known', 'known', 'known']);

// Sync 3: nothing withdrawn comes back.
const third = run([spread, abc, lmn, qrs], second.drafts, second.seen);
eq('sync 3: still only LMN and one QRS', offered(third).length, 2);

// A typed fill that two orders would both fit is not guessed between.
const twoTyped = { ...qrs, fills: [qrs.fills[0], { ...qrs.fills[0], id: 'f2' }] };
eq('two typed QRS fills absorb the two QRS orders', run([twoTyped], first.drafts, first.seen).drafts.filter(d => d.fill?.root === 'QRS').length, 0);

const otherRow = { ...qrs, id: 'r5', fills: [{ ...qrs.fills[0], id: 'g1' }] };
eq('a typed fill on each of two QRS rows is a question: both orders stay offered', run([qrs, otherRow], first.drafts, first.seen).drafts.filter(d => d.fill?.root === 'QRS').length, 2);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
