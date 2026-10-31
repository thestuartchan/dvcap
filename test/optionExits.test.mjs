// test/optionExits.test.mjs — an option card closed at IBKR whose exit never reached the console
// (lib/optionExits.js). Made-up tickers, order ids, contracts and sizes.
import { parseTradeConfirms } from '../lib/flexTrades.js';
import { orderUnits } from '../lib/journalInbox.js';
import { statementExits, exitLine, exitFix } from '../lib/optionExits.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const near = (n, g, w, tol = 0.03) => eq(n, Math.abs(g - w) <= tol ? 'ok' : g, 'ok');

const xml = (rows) => `<FlexQueryResponse queryName="t" type="TCF"><FlexStatements count="1"><FlexStatement accountId="U0000000" fromDate="20261019" toDate="20261029" period="x"><TradeConfirms>${rows.join('')}</TradeConfirms></FlexStatement></FlexStatements></FlexQueryResponse>`;
const opt = (o) => `<TradeConfirm accountId="U0000000" currency="USD" assetCategory="OPT" symbol="${o.root} x" conid="${o.root}${o.k}${o.pc}" underlyingSymbol="${o.root}" multiplier="100" strike="${o.k}" expiry="20261030" putCall="${o.pc}" tradeID="" tradeDate="${o.d}" dateTime="${o.d};${o.t || '150000'}" buySell="${o.side}" quantity="${o.side === 'SELL' ? -o.q : o.q}" price="${o.px}" commission="0" orderID="${o.oid}" levelOfDetail="ORDER" transactionType="ExchTrade" />`;
const units = (rows) => orderUnits(parseTradeConfirms(xml(rows)));

const leg = (right, strike, side = 'long') => ({ right, strike, expiry: '2026-10-30', side, ratio: 1 });
const card = (id, root, side, legs, fills, qty) => ({ id, instrument: legs.length > 1 ? 'spread' : 'option', symbol: root, underlying: root, side, legs, multiplier: 100, fills, derived: { status: 'open', qty } });
const missing = (root, legs) => legs.map(l => ({ kind: 'option-missing-at-broker', root, c: { root, expiry: l.expiry, type: l.right === 'P' ? 'put' : 'call', strike: l.strike } }));

// CCC: a strangle bought as one combo Monday (on the card), each leg sold on its own Thursday.
const cccLegs = [leg('P', 520), leg('C', 545)];
const ccc = [
  opt({ root: 'CCC', k: 520, pc: 'P', side: 'BUY', q: 2, px: 4.0, d: '20261026', oid: 9001 }),
  opt({ root: 'CCC', k: 545, pc: 'C', side: 'BUY', q: 2, px: 4.5, d: '20261026', oid: 9001 }),
  opt({ root: 'CCC', k: 545, pc: 'C', side: 'SELL', q: 2, px: 6.0, d: '20261029', t: '143000', oid: 9002 }),
  opt({ root: 'CCC', k: 520, pc: 'P', side: 'SELL', q: 2, px: 1.5, d: '20261029', t: '143100', oid: 9003 }),
];
const cccCard = card('ccc-strangle', 'CCC', 'long', cccLegs, [{ id: 'f1', side: 'buy', qty: 2, price: 8.5, date: '2026-10-26', tradeId: '9001' }], 2);
const [x] = statementExits([cccCard], units(ccc), missing('CCC', cccLegs));
eq('a long strangle sold leg by leg: found, as a sale of the whole card, dated the last order', [x?.rowId, x?.fill.side, x?.fill.qty, x?.fill.date, x?.fill.orders], ['ccc-strangle', 'sell', 2, '2026-10-29', ['9002', '9003']]);
near('…at the legs\' combined price', x?.fill.price, 7.5);
eq('the trade id carries both orders, so the card stays matched to IBKR', x?.fill.tradeId, '9002+9003');
eq('the banner line names the day and the orders', /closed at IBKR on 2026-10-29 \(orders 9002, 9003\)/.test(exitLine(x)), true);
const fx = exitFix(x);
eq('the fix the "Record it" button opens the fill form with', [fx.side, fx.fills[0].qty, fx.fills[0].date, fx.fills[0].tradeId], ['reduce', 2, '2026-10-29', '9002+9003']);

// DDD: a put credit spread (row short, legs written as the spread sold) bought back as one combo.
const dddLegs = [leg('P', 55, 'long'), leg('P', 48, 'short')];
const ddd = [
  opt({ root: 'DDD', k: 55, pc: 'P', side: 'SELL', q: 3, px: 2.2, d: '20261020', oid: 9101 }),
  opt({ root: 'DDD', k: 48, pc: 'P', side: 'BUY', q: 3, px: 0.7, d: '20261020', oid: 9101 }),
  opt({ root: 'DDD', k: 55, pc: 'P', side: 'BUY', q: 3, px: 0.8, d: '20261028', oid: 9102 }),
  opt({ root: 'DDD', k: 48, pc: 'P', side: 'SELL', q: 3, px: 0.2, d: '20261028', oid: 9102 }),
];
const dddCard = card('ddd-pcs', 'DDD', 'short', dddLegs, [{ id: 'f1', side: 'sell', qty: 3, price: 1.5, date: '2026-10-20', tradeId: '9101' }], 3);
const [y] = statementExits([dddCard], units(ddd), missing('DDD', dddLegs));
eq('a credit spread bought back: a buy of the card', [y?.fill.side, y?.fill.qty, y?.fill.orders], ['buy', 3, ['9102']]);
near('…at the net debit paid', y?.fill.price, 0.6);

// What it must leave alone.
eq('only part sold: not a clean exit', statementExits([cccCard], units(ccc.slice(0, 3).concat(opt({ root: 'CCC', k: 520, pc: 'P', side: 'SELL', q: 1, px: 1.5, d: '20261029', oid: 9003 }))), missing('CCC', cccLegs)), []);
eq('one leg still at IBKR: not this case', statementExits([cccCard], units(ccc), missing('CCC', [cccLegs[0]])), []);
eq('sold more than the card held (a reversal): left alone', statementExits([cccCard], units([...ccc.slice(0, 3), opt({ root: 'CCC', k: 520, pc: 'P', side: 'SELL', q: 3, px: 1.5, d: '20261029', oid: 9003 })]), missing('CCC', cccLegs)), []);
eq('added to before going flat: left alone', statementExits([cccCard], units([...ccc.slice(0, 2), opt({ root: 'CCC', k: 545, pc: 'C', side: 'BUY', q: 1, px: 5, d: '20261027', oid: 9004 }), ...ccc.slice(2)]), missing('CCC', cccLegs)), []);
const twin = { ...cccCard, id: 'ccc-other', fills: [{ id: 'g1', side: 'buy', qty: 2, price: 8.4, date: '2026-10-26' }] };
eq('a contract on two open cards cannot say which it closed', statementExits([cccCard, twin], units(ccc), missing('CCC', cccLegs)), []);
const onCard = { ...cccCard, fills: [...cccCard.fills, { id: 'f2', side: 'sell', qty: 2, price: 7.5, date: '2026-10-29', tradeId: '9002+9003' }] };
eq('the exit already on the card is not offered again', statementExits([onCard], units(ccc), missing('CCC', cccLegs)), []);
eq('a card the day-trade check already named is skipped', statementExits([cccCard], units(ccc), missing('CCC', cccLegs), { skip: new Set(['ccc-strangle']) }), []);
eq('a closed card is left alone', statementExits([{ ...cccCard, derived: { status: 'closed', qty: 0 } }], units(ccc), missing('CCC', cccLegs)), []);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
