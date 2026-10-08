// test/positionSearch.test.mjs — the console's position search (lib/positionSearch.js).
import { searchBook, matchScore } from '../lib/positionSearch.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const row = (id, symbol, extra = {}) => ({ id, symbol, derived: {}, ...extra });
const tabs = {
  WATCHING: [row('w1', 'NVDA', { thesis: 'buy the pullback to the 50-day' }), row('w2', 'BTC-USD')],
  OPEN: [
    row('o1', 'NVDA', { tag: 'growth' }),
    row('o2', 'NVDA', { underlying: 'NVDA', legs: [{ side: 'long', right: 'P', strike: 160, expiry: '2026-11-20' }] }),
    row('o3', 'MU'), row('o4', 'HL:SOL'), row('o5', 'GLD', { tag: 'hedge' }),
  ],
  CLOSED: [row('c1', 'AVGO')],
  ARCHIVED: [row('a1', 'NVDA'), row('a2', 'NVDA', { derived: { rolledInto: 'o2' } }), row('a3', 'MSFT')],
};
const ids = (r) => r.groups.map(g => [g.state, g.rows.map(x => x.id)]);

eq('a ticker finds it in every state, live first, rolled-out contracts left out',
  ids(searchBook(tabs, 'nvda')), [['OPEN', ['o1', 'o2']], ['WATCHING', ['w1']], ['ARCHIVED', ['a1']]]);
eq('the company name', ids(searchBook(tabs, 'micron')), [['OPEN', ['o3']]]);
eq('every word has to land: the NVDA put, not every NVDA row', ids(searchBook(tabs, 'nvda 160p')), [['OPEN', ['o2']]]);
eq('the tag', ids(searchBook(tabs, 'hedge')), [['OPEN', ['o5']]]);
eq('the thesis, last', ids(searchBook(tabs, 'pullback')), [['WATCHING', ['w1']]]);
eq('a closed trade from the last day', ids(searchBook(tabs, 'broadcom')), [['CLOSED', ['c1']]]);
const c = searchBook(tabs, 'sol');
eq('crypto is not searched, and is counted so the screen can say where it is', [c.total, c.cryptoSkipped], [0, 1]);
eq('BTC-USD too', searchBook(tabs, 'btc').cryptoSkipped, 1);
eq('an empty query finds nothing', searchBook(tabs, '  ').total, 0);
eq('the exact ticker outranks its start', matchScore(row('x', 'MU'), 'mu') > matchScore(row('y', 'MUB'), 'mu'), true);

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
