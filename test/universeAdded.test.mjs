// test/universeAdded.test.mjs — names added from the dashboard (lib/universeAdded.js). Made-up symbols.
import { regionOf, isUsSingle, canAdd, addEntry, removeEntry, EARNINGS_NAMES, ADD_LISTS } from '../lib/universeAdded.js';
import { WATCH_UNIVERSE } from '../data/watchUniverse.js';
import { SC_UNIVERSE } from '../lib/supplyChain.js';
import { WATCH } from '../lib/calendarAuto.js';
import EARNINGS_WATCH from '../data/earnings_watch.json' with { type: 'json' };
import ADDED from '../data/universe_added.json' with { type: 'json' };

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// ── Shapes ──
eq('regions by suffix', ['QXZQ', 'QXZQ-B', '1234.HK', '123456.KS', '1234.T', 'QXZ.L', 'QXZ.PA', '^QXZ', 'QX=F', 'QXZ-USD'].map(regionOf),
  ['us', 'us', 'asia', 'asia', 'asia', 'eu', 'eu', null, null, null]);
eq('a US single name; not an ETF, a future or a foreign listing', [isUsSingle('QXZQ'), isUsSingle('SPY'), isUsSingle('QX=F'), isUsSingle('1234.HK')], [true, false, false, false]);
eq('which lists could take a symbol', [canAdd('QXZQ'), canAdd('1234.HK'), canAdd('^QXZ')],
  [{ earnings: true, supply: true, watch: true }, { earnings: false, supply: false, watch: true }, { earnings: false, supply: false, watch: false }]);

// ── Editing the file ──
const empty = { earnings: [], supply: [], watch: { us: [], eu: [], asia: [] } };
const a1 = addEntry(empty, 'earnings', 'qxzq', { name: 'Quux Corp', today: '2026-10-20' });
eq('add to the earnings watch: an entry the calendar reads', [a1.changed, a1.file.earnings], [true, [{ sym: 'QXZQ', name: 'Quux Corp', aliases: ['Quux Corp'], region: 'US', tier: 2, added: '2026-10-20' }]]);
eq('adding it again changes nothing', addEntry(a1.file, 'earnings', 'QXZQ').changed, false);
eq('a name is kept to plain characters', addEntry(empty, 'earnings', 'QXZQ', { name: 'Quux <script>' }).file.earnings[0].name, 'Quux script');
eq('the supplier map takes the symbol', addEntry(empty, 'supply', 'QXZQ').file.supply, ['QXZQ']);
eq('the watchlist files it under its region', addEntry(empty, 'watch', '1234.HK', { name: 'Quux HK', today: '2026-10-20' }).file.watch.asia, [{ sym: '1234.HK', name: 'Quux HK', added: '2026-10-20' }]);
eq('refused: a foreign listing on the earnings watch', addEntry(empty, 'earnings', '1234.HK').error, '1234.HK is not a US-listed single company');
eq('refused: an index on the watchlist', addEntry(empty, 'watch', '^QXZ').error, '^QXZ is not a symbol');
eq('refused: a future on the watchlist', addEntry(empty, 'watch', 'QX=F').error, 'QX=F is not a symbol');
eq('refused: crypto on the watchlist', addEntry(empty, 'watch', 'QXZ-USD').error, 'QXZ-USD has no pre-read region');
eq('refused: an unknown list', addEntry(empty, 'nope', 'QXZQ').error, 'unknown list nope');
eq('remove takes it off, and only it', removeEntry(addEntry(a1.file, 'earnings', 'QXZR').file, 'earnings', 'QXZQ').file.earnings.map(e => e.sym), ['QXZR']);
eq('removing what is not there changes nothing', removeEntry(empty, 'watch', 'QXZQ').changed, false);
eq('three lists', ADD_LISTS, ['earnings', 'supply', 'watch']);

// ── The merged lists ──
eq('the earnings watch keeps every name the file has, first', EARNINGS_NAMES.slice(0, EARNINGS_WATCH.names.length).map(n => n.sym), EARNINGS_WATCH.names.map(n => n.sym));
eq('…then takes the watchlist\'s US single names, once each', EARNINGS_NAMES.filter(n => n.from === 'watchlist').every(n => WATCH_UNIVERSE.us.includes(n.sym) && isUsSingle(n.sym)), true);
eq('no symbol twice', new Set(EARNINGS_NAMES.map(n => n.sym)).size, EARNINGS_NAMES.length);
eq('the calendar reads the merged list', WATCH, EARNINGS_NAMES);
eq('every added supply name is in the map\'s universe', (ADDED.supply || []).every(s => SC_UNIVERSE.includes(s)), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
