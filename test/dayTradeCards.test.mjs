// test/dayTradeCards.test.mjs — a console card whose round trip was a day trade (lib/dayTradeCards.js).
// A straddle and a call bought one afternoon onto console cards, sold the next morning inside 24
// hours: the sales went to the journal and the cards were left open. Made-up tickers, order ids,
// contracts and sizes.
import { parseTradeConfirms } from '../lib/flexTrades.js';
import { orderUnits } from '../lib/journalInbox.js';
import { journaledDayTrades, dayTradeLine, heldText } from '../lib/dayTradeCards.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const xml = (rows) => `<FlexQueryResponse queryName="t" type="TCF"><FlexStatements count="1"><FlexStatement accountId="U0000000" fromDate="20261019" toDate="20261023" period="x"><TradeConfirms>${rows.join('')}</TradeConfirms></FlexStatement></FlexStatements></FlexQueryResponse>`;
const opt = (o) => `<TradeConfirm accountId="U0000000" currency="USD" assetCategory="OPT" symbol="${o.root} x" conid="${o.k}${o.pc}" underlyingSymbol="${o.root}" multiplier="100" strike="${o.k}" expiry="${o.exp || '20261023'}" putCall="${o.pc}" tradeID="" tradeDate="${o.d}" dateTime="${o.d};${o.t}" buySell="${o.side}" quantity="${o.side === 'SELL' ? -o.q : o.q}" price="${o.px}" commission="-1.05" orderID="${o.oid}" levelOfDetail="ORDER" transactionType="ExchTrade" />`;
const units = (rows) => orderUnits(parseTradeConfirms(xml(rows)));

const leg = (right, strike, side = 'long') => ({ right, strike, expiry: '2026-10-23', side, ratio: 1 });
const card = (id, root, legs, fills, qty) => ({ id, instrument: legs.length > 1 ? 'spread' : 'option', symbol: root, underlying: root, side: 'long', legs, multiplier: 100, fills, derived: { status: 'open', qty } });

// AAA: a straddle bought as one combo order Wednesday 13:45, each leg sold on its own Thursday 13:34.
const aaa = [
  opt({ root: 'AAA', k: 705, pc: 'C', side: 'BUY', q: 2, px: 12.1, d: '20261021', t: '134500', oid: 8001 }),
  opt({ root: 'AAA', k: 705, pc: 'P', side: 'BUY', q: 2, px: 12.5, d: '20261021', t: '134500', oid: 8001 }),
  opt({ root: 'AAA', k: 705, pc: 'C', side: 'SELL', q: 2, px: 15.0, d: '20261022', t: '133400', oid: 8002 }),
  opt({ root: 'AAA', k: 705, pc: 'P', side: 'SELL', q: 2, px: 8.6, d: '20261022', t: '133400', oid: 8003 }),
];
const aaaCard = card('aaa-straddle', 'AAA', [leg('C', 705), leg('P', 705)], [{ id: 'f1', side: 'buy', qty: 2, price: 24.6, date: '2026-10-21', tradeId: '8001' }], 2);
// BBB: calls bought Wednesday 14:04, trimmed twice that afternoon (on the card), the rest sold Thursday 13:37.
const bbb = [
  opt({ root: 'BBB', k: 109, pc: 'C', side: 'BUY', q: 50, px: 0.91, d: '20261021', t: '140400', oid: 8101 }),
  opt({ root: 'BBB', k: 109, pc: 'C', side: 'SELL', q: 25, px: 1.10, d: '20261021', t: '143000', oid: 8102 }),
  opt({ root: 'BBB', k: 109, pc: 'C', side: 'SELL', q: 20, px: 1.05, d: '20261021', t: '143700', oid: 8103 }),
  opt({ root: 'BBB', k: 109, pc: 'C', side: 'SELL', q: 5, px: 1.20, d: '20261022', t: '133700', oid: 8104 }),
];
const bbbCard = card('bbb-call', 'BBB', [leg('C', 109)], [
  { id: 'f1', side: 'buy', qty: 50, price: 0.91, date: '2026-10-21', tradeId: '8101' },
  { id: 'f2', side: 'sell', qty: 25, price: 1.10, date: '2026-10-21', tradeId: '8102' },
  { id: 'f3', side: 'sell', qty: 20, price: 1.05, date: '2026-10-21', tradeId: '8103' }], 5);

const found = journaledDayTrades([aaaCard, bbbCard], units([...aaa, ...bbb]));
eq('both cards are named as day trades, with the day they closed and how long they were held',
  found.map(d => [d.rowId, d.root, d.opened, d.closed, heldText(d.heldMin)]),
  [['aaa-straddle', 'AAA', '2026-10-21', '2026-10-22', '23h49m'], ['bbb-call', 'BBB', '2026-10-21', '2026-10-22', '23h33m']]);
eq('the straddle is named by both legs', found[0].contract, '2026-10-23 C 705 / 2026-10-23 P 705');
eq('the line says remove, not close at 0', /Remove this card; don't close it at 0/.test(dayTradeLine(found[1])), true);

// Held past 24 hours: a swing. The card's sale was simply not recorded — not this case.
const late = [aaa[0], aaa[1], opt({ root: 'AAA', k: 705, pc: 'C', side: 'SELL', q: 2, px: 15, d: '20261022', t: '135000', oid: 8002 }),
  opt({ root: 'AAA', k: 705, pc: 'P', side: 'SELL', q: 2, px: 8.6, d: '20261022', t: '133400', oid: 8003 })];
eq('one leg held past 24 hours: not a day trade', journaledDayTrades([aaaCard], units(late)), []);

// Still held at IBKR: only one leg sold.
eq('a leg still open at IBKR: not this case', journaledDayTrades([aaaCard], units(aaa.slice(0, 3))), []);

// The card already holds its close: it is closed, nothing to say.
const closedCard = { ...bbbCard, derived: { status: 'closed', qty: 0 } };
eq('a card already closed is left alone', journaledDayTrades([closedCard], units(bbb)), []);

// A card whose opening order is not in the statement's window cannot be judged.
const oldCard = card('bbb-old', 'BBB', [leg('C', 109)], [{ id: 'f1', side: 'buy', qty: 5, price: 0.5, date: '2026-09-01', tradeId: '7000' }], 5);
eq('the opening order is not in the statement: left alone', journaledDayTrades([oldCard], units(bbb)), []);

// A hand-entered card with no IBKR ids: left alone rather than guessed at.
const handCard = card('bbb-hand', 'BBB', [leg('C', 109)], [{ id: 'f1', side: 'buy', qty: 50, price: 0.91, date: '2026-10-21' }], 50);
eq('no order id on the card: left alone', journaledDayTrades([handCard], units(bbb)), []);

// Share rows are the planner's: it applies every trade in a held root, so they never orphan.
eq('a share row is never a candidate', journaledDayTrades([{ id: 's', symbol: 'CCC', side: 'long', fills: [{ side: 'buy', qty: 10, price: 5, date: '2026-10-21', tradeId: '1' }], derived: { status: 'open', qty: 10 } }], units(bbb)), []);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
