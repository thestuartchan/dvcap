// test/coverage.test.mjs — which tickers each part takes (lib/coverage.js). Fake symbols for the
// shapes; the real lists only where the point is that a restated list matches its source.
import { kindOf, priceSymbol, coverageFor, COVERAGE_LISTS, GAMMA_STORED, GAMMA_FEED_ONLY, GAMMA_CUSTOM_RE, REGION_TAPE_SYMBOLS } from '../lib/coverage.js';
import { GEX_SYMBOLS, FEED_ONLY_SYMBOLS, CUSTOM_ROOT_RE } from '../lib/gexStore.js';
import { REGION_TAPE } from '../lib/regionTape.js';
import { SC_UNIVERSE } from '../lib/supplyChain.js';
import { watchAliases, nextEarnings } from '../lib/tickerPage.js';
import EARNINGS_WATCH from '../data/earnings_watch.json' with { type: 'json' };

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// ── The restated lists match the server modules they copy ──
eq('stored gamma boards match lib/gexStore.js', [...GAMMA_STORED], [...GEX_SYMBOLS]);
eq('feed-only gamma matches lib/gexStore.js', [...GAMMA_FEED_ONLY], [...FEED_ONLY_SYMBOLS]);
eq('the custom-root shape matches lib/gexStore.js', GAMMA_CUSTOM_RE.source, CUSTOM_ROOT_RE.source);
eq('the tape strip matches lib/regionTape.js', REGION_TAPE_SYMBOLS,
  Object.fromEntries(Object.entries(REGION_TAPE).map(([k, r]) => [k, [...r.indices.map(i => i[0]), r.fx.sym]])));
eq('the supply-chain list is the live universe', COVERAGE_LISTS.find(l => l.id === 'supply').names, [...SC_UNIVERSE]);

// ── Shapes ──
eq('kinds by shape', ['XYZ', 'XYZ.B', 'XYZ-B', '^XYZ', 'XY=F', 'XYZ=X', 'XYZ-USD', '123456.KS', '1234.HK', '1234', 'SPX', 'XYZ1!'].map(kindOf),
  ['us', 'class', 'class', 'index', 'future', 'fx', 'crypto', 'foreign', 'foreign', 'foreign', 'index', 'other']);
eq('the price feed\'s spellings: a share class with a dash, bare index names with a caret', ['XYZ.B', 'XYZ-B', 'SPX', 'DXY', 'XYZ', '1234.HK'].map(priceSymbol),
  ['XYZ-B', 'XYZ-B', '^GSPC', 'DX-Y.NYB', 'XYZ', '1234.HK']);
eq('an exchange suffix is not a share class', [priceSymbol('XYZ.L'), priceSymbol('1234.T')], ['XYZ.L', '1234.T']);

// ── One symbol ──
const st = (sym) => Object.fromEntries(coverageFor(sym).map(r => [r.id, r.status]));
eq('an unknown US-shaped name: open sources only', st('QXZQ'), { price: 'try', sec: 'try', gamma: 'try', earnings: 'no', supply: 'no' });
eq('a non-US listing: price only', st('123456.KQ'), { price: 'try', sec: 'no', gamma: 'no', earnings: 'no', supply: 'no' });
eq('a future: no filings, no gamma', [st('QX=F').sec, st('QX=F').gamma], ['no', 'no']);
eq('SPX: gamma inside the S&P map, priced as ^GSPC', [st('SPX').gamma, coverageFor('SPX').find(r => r.id === 'price').why], ['yes', 'Yahoo, read as ^GSPC']);
eq('the stored boards are covered', GAMMA_STORED.map(s => st(s).gamma), GAMMA_STORED.map(() => 'yes'));
eq('every earnings-watch name has a date', EARNINGS_WATCH.names.every(n => st(n.sym).earnings === 'yes'), true);
eq('and the DART names by their KRX code', EARNINGS_WATCH.dart.every(n => st(`${n.code}.KS`).earnings === 'yes'), true);
eq('every supply-chain filer is covered', SC_UNIVERSE.every(s => st(s).supply === 'yes'), true);
eq('a ticker that is also a Go code says how to reach it', coverageFor('SM').find(r => r.id === 'go')?.why, '"SM" is also a Go code; type SM DES');
eq('nothing typed, nothing said', coverageFor(''), []);

// ── Earnings found by the watch's names and the automatic row's code ──
const w = EARNINGS_WATCH.names.find(n => (n.aliases || []).some(a => a.toUpperCase() !== n.sym));
const alias = w.aliases.find(a => a.toUpperCase() !== w.sym);
eq('the watch\'s aliases are known for its symbol', watchAliases(w.sym).includes(alias), true);
eq('a row titled by the alias is that symbol\'s, with no SEC name', nextEarnings([{ date: '2026-11-20', title: `${alias} earnings` }], w.sym, { today: '2026-10-19' })?.date, '2026-11-20');
eq('an automatic row matches by its code', nextEarnings([{ date: '2026-11-20', title: 'Quuxco results', kind: 'earn:QXZQ', auto: true }], 'QXZQ', { today: '2026-10-19' })?.date, '2026-11-20');
eq('a KRX code matches its .KS symbol', nextEarnings([{ date: '2026-11-20', title: 'Quuxco earnings (IR call)', kind: 'earn:123456', auto: true }], '123456.KS', { today: '2026-10-19' })?.date, '2026-11-20');
eq('another code does not', nextEarnings([{ date: '2026-11-20', title: 'Quuxco earnings', kind: 'earn:QXZR' }], 'QXZQ', { today: '2026-10-19' }), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
