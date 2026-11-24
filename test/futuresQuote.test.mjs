// lib/futuresQuote.js — futures Yahoo does not list, quoted on their exact TradingView contract.
import { tvFutureSymbol, tvSpecFor, monthCode } from '../lib/futuresQuote.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w); if (a === b) { pass++; console.log('✅', n); } else { fail++; console.log('❌', n, ' got', a, 'want', b); } };

eq('a month from an ISO expiry', monthCode('2027-03-11'), 'H2027');
eq('a month from a compact expiry', monthCode('20261210'), 'Z2026');
eq('no expiry, no month', monthCode(null), null);
eq('the OSE Micro Nikkei on its contract month', tvFutureSymbol('N225MC', '2027-03-11'), 'OSE:NK225MCH2027');
eq('without an expiry, the front month', tvFutureSymbol('N225MC'), 'OSE:NK225MC1!');
eq('the =F spelling resolves too', tvFutureSymbol('N225MC=F'), 'OSE:NK225MC1!');
eq('a root Yahoo carries is left alone', tvFutureSymbol('MNQ', '2026-12-18'), null);
eq('the allow-list takes a contract month', tvSpecFor('OSE:NK225MCH2027')?.currency, 'JPY');
eq('and the front month', !!tvSpecFor('OSE:NK225MC1!'), true);
eq('but nothing else on TradingView', tvSpecFor('NASDAQ:AAPL'), null);
eq('nor a lookalike suffix', tvSpecFor('OSE:NK225MCH2027X'), null);
console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exit(1);
