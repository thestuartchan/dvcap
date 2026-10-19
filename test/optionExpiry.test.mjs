// test/optionExpiry.test.mjs — closing a console option IBKR booked as expired (lib/optionExpiry.js).
// Fake ticker, made-up contracts and sizes.
import { parseOptionEae, eaeSectionPresent, expiryCloses, applyExpiryCloses } from '../lib/optionExpiry.js';
import { reconcile, parseStatement } from '../lib/flex.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const EAE = (rows) => `<FlexStatement><OptionEAE>${rows.map(r => `<OptionEAE ${Object.entries(r).map(([k, v]) => `${k}="${v}"`).join(' ')} />`).join('')}</OptionEAE></FlexStatement>`;
const xml = EAE([
  { symbol: 'XYZ   261016C00100000', underlyingSymbol: 'XYZ', putCall: 'C', strike: '100', expiry: '20261016', date: '20261016', transactionType: 'Expiration', quantity: '-4' },
  { symbol: 'XYZ   261016P00090000', underlyingSymbol: 'XYZ', putCall: 'P', strike: '90', expiry: '20261016', date: '20261016', transactionType: 'Assignment', quantity: '2' },
]);
eq('the section is recognised, empty or not', [eaeSectionPresent(xml), eaeSectionPresent('<OptionEAE />'), eaeSectionPresent('<Trades/>')], [true, true, false]);
eq('each event with its contract and kind', parseOptionEae(xml).map(e => [e.root, e.right, e.strike, e.expiry, e.type]),
  [['XYZ', 'C', 100, '2026-10-16', 'expiration'], ['XYZ', 'P', 90, '2026-10-16', 'assignment']]);

const row = (id, legs, side = 'long', qty = 4) => ({ id, symbol: 'XYZ', underlying: 'XYZ', side, legs, fills: [{ id: 'f0', side: side === 'long' ? 'buy' : 'sell', qty, price: 1.5, date: '2026-10-14' }],
  derived: { status: 'open', qty } });
const call = row('xyz-call', [{ right: 'C', strike: 100, expiry: '2026-10-16', side: 'long', ratio: 1 }]);
const put = row('xyz-put', [{ right: 'P', strike: 90, expiry: '2026-10-16', side: 'long', ratio: 1 }], 'short', 2);
const miss = (c, ids) => ({ kind: 'option-missing-at-broker', root: 'XYZ', contract: 'label', c, ids });
const missing = [miss({ root: 'XYZ', expiry: '2026-10-16', type: 'call', strike: 100 }, ['xyz-call']), miss({ root: 'XYZ', expiry: '2026-10-16', type: 'put', strike: 90 }, ['xyz-put'])];

const out = expiryCloses([call, put], missing, { eae: parseOptionEae(xml), present: true, asOf: '2026-10-16' });
eq('an Expiration closes the row at 0, on the date IBKR booked it, for the whole open size',
  out.closes.map(c => [c.rowId, c.fill.side, c.fill.qty, c.fill.price, c.fill.date]), [['xyz-call', 'sell', 4, 0, '2026-10-16']]);
eq('an assignment is left for a person — it delivered shares', out.waiting.map(w => [w.id, w.kind]), [['xyz-put', 'option-exercised']]);
eq('without the section nothing closes, and it says which section to add', (() => {
  const o = expiryCloses([call], [missing[0]], { eae: [], present: false, asOf: '2026-10-16' });
  return [o.closes.length, o.waiting[0].kind, /Option Exercises, Assignments and Expirations/.test(o.waiting[0].note)];
})(), [0, 'expiry-unrecorded', true]);
eq('a contract not yet expired is not touched', expiryCloses([call], [missing[0]], { eae: parseOptionEae(xml), present: true, asOf: '2026-10-15' }), { closes: [], waiting: [] });
eq('the section silent on a contract leaves it for a person', expiryCloses([call], [missing[0]], { eae: [], present: true, asOf: '2026-10-16' }).waiting.map(w => w.kind), ['expiry-not-in-statement']);
{
  const spread = row('xyz-vert', [{ right: 'C', strike: 100, expiry: '2026-10-16', side: 'long', ratio: 1 }, { right: 'C', strike: 110, expiry: '2026-10-16', side: 'short', ratio: 1 }]);
  const eae2 = parseOptionEae(EAE([{ underlyingSymbol: 'XYZ', putCall: 'C', strike: '100', expiry: '20261016', date: '20261016', transactionType: 'Expiration', quantity: '-4' }]));
  const legMiss = [miss({ root: 'XYZ', expiry: '2026-10-16', type: 'call', strike: 100 }, ['xyz-vert']), miss({ root: 'XYZ', expiry: '2026-10-16', type: 'call', strike: 110 }, ['xyz-vert'])];
  eq('a spread closes only when every leg has an Expiration', expiryCloses([spread], legMiss, { eae: eae2, present: true, asOf: '2026-10-16' }).waiting.map(w => w.kind), ['expiry-not-in-statement']);
}
{
  const closes = expiryCloses([call], [missing[0]], { eae: parseOptionEae(xml), present: true, asOf: '2026-10-16' }).closes;
  const once = applyExpiryCloses([call], closes);
  eq('the closing fill is appended once, never twice', [once[0].fills.length, applyExpiryCloses(once, closes)[0].fills.length], [2, 2]);
}

// ── The journal's options are not added to the console ──
{
  const pos = (sym, under, strike) => `<OpenPosition symbol="${sym}" underlyingSymbol="${under}" assetCategory="OPT" currency="USD" multiplier="100" position="8" costBasisPrice="1.66" strike="${strike}" expiry="20261016" putCall="C" holdingPeriodDateTime="20261014;101500" />`;
  const { positions } = parseStatement(pos('QQQ   261016C00740000', 'QQQ', 740) + pos('XYZ   261016C00100000', 'XYZ', 100));
  const rec = reconcile([], positions, { asOf: '2026-10-14' });
  eq('a QQQ option (day trade by kind) is left to the journal; another name is added', [rec.adds.map(r => r.underlying || r.symbol), rec.report.filter(r => r.kind === 'daytrade-option').map(r => r.root)], [['XYZ'], ['QQQ']]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
