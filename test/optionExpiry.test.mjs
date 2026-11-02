// test/optionExpiry.test.mjs — reading IBKR's exercises/assignments/expirations (lib/optionExpiry.js);
// what is done with them is tested in test/optionLedger.test.mjs.
// Fake ticker, made-up contracts and sizes.
import { parseOptionEae, eaeSectionPresent } from '../lib/optionExpiry.js';
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

// ── The journal's options are not added to the console ──
{
  const pos = (sym, under, strike) => `<OpenPosition symbol="${sym}" underlyingSymbol="${under}" assetCategory="OPT" currency="USD" multiplier="100" position="8" costBasisPrice="1.66" strike="${strike}" expiry="20261016" putCall="C" holdingPeriodDateTime="20261014;101500" />`;
  const { positions } = parseStatement(pos('QQQ   261016C00740000', 'QQQ', 740) + pos('XYZ   261016C00100000', 'XYZ', 100));
  const rec = reconcile([], positions, { asOf: '2026-10-14' });
  eq('a QQQ option (day trade by kind) is left to the journal; another name is added', [rec.adds.map(r => r.underlying || r.symbol), rec.report.filter(r => r.kind === 'daytrade-option').map(r => r.root)], [['XYZ'], ['QQQ']]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
