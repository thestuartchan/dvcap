// test/goCommands.test.mjs — the Go bar's line → view (lib/goCommands.js).
import { GO_FUNCTIONS, parseGo, suggestGo, pushRecent } from '../lib/goCommands.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const go = (l) => { const r = parseGo(l); return r && (r.tab ? [r.tab, r.symbol] : [r.action]); };
eq('a code goes to its view', go('ECO'), ['calendar', null]);
eq('a bare ticker opens its page; one that starts a code does not', [go('XYZ'), go('nvda'), go('he'), go('pl')], [['ticker', 'XYZ'], ['ticker', 'NVDA'], null, null]);
eq('DES either way round', [go('XYZ DES'), go('des xyz')], [['ticker', 'XYZ'], ['ticker', 'XYZ']]);
eq('case and spacing do not matter', go('  eco '), ['calendar', null]);
eq('the plain word works too', [go('calendar'), go('hedges'), go('smart money')], [['calendar', null], ['insurance', null], ['street', null]]);
eq('the terminal\'s own codes land where they would', [go('WEI'), go('OMON'), go('PORT'), go('BTMM')], [['global', null], ['gex', null], ['console', null], ['drivers', null]]);
eq('a ticker and a function, either order', [go('QQQ GEX'), go('gex spy'), go('XYZ gamma')], [['gex', 'QQQ'], ['gex', 'SPY'], ['gex', 'XYZ']]);
eq('a terminal-style line is read past its filler', go('XYZ US Equity GEX <GO>'), ['gex', 'XYZ']);
eq('a Hong Kong code is a ticker', go('7709 GEX'), ['gex', '7709']);
eq('a ticker on a view that takes none is not a command', go('ECO QQQ'), null);
eq('actions', [go('dark'), go('REFRESH')], [['theme:dark'], ['refresh']]);
eq('nonsense is nothing', [go(''), go('zzz qqq yyy')], [null, null]);
eq('every view has a unique code', new Set(GO_FUNCTIONS.map(f => f.code)).size, GO_FUNCTIONS.length);

const titles = (l, o) => suggestGo(l, o).map(r => r.title);
eq('a prefix suggests the views it starts, before reading it as a ticker', [titles('he').slice(0, 2).sort(), titles('he')[2]], [['Data health', 'Hedges'], 'HE Ticker page']);
eq('the exact command comes first', titles('ECO')[0], 'Calendar');
eq('a bare ticker offers its ticker page first, then Gamma', suggestGo('XYZ').map(r => [r.title, !!r.soon]), [['XYZ Ticker page', false], ['XYZ Gamma', false]]);
eq('a ticker with a partial function completes it', titles('QQQ G')[0], 'QQQ Gamma');
eq('an empty line lists recent first, then every view', suggestGo('', { recent: ['QQQ GEX'] }).slice(0, 2).map(r => [r.title, !!r.recent]), [['QQQ Gamma', true], ['Daily Overview', false]]);

eq('recent keeps the newest first, no repeats, five at most', pushRecent(['ECO', 'QQQ GEX', 'PORT', 'RAT', 'DRV'], 'calendar'), ['ECO', 'QQQ GEX', 'PORT', 'RAT', 'DRV']);
eq('a new one goes on top and the oldest falls off', pushRecent(['ECO', 'QQQ GEX', 'PORT', 'RAT', 'DRV'], 'spy gex'), ['SPY GEX', 'ECO', 'QQQ GEX', 'PORT', 'RAT']);
eq('a line that means nothing is not kept', pushRecent(['ECO'], 'zzz yyy'), ['ECO']);

eq('HAND opens the hand-entry list in Data health', (() => { const r = parseGo('hand'); return [r.tab, r.anchor, r.title]; })(), ['health', 'hand-entry', 'Hand-kept inputs']);
eq('and the plain words reach it too', [parseGo('inputs')?.code, parseGo('hand-kept')?.code], ['HAND', 'HAND']);
eq('COV opens the coverage list in Data health', (() => { const r = parseGo('coverage'); return [r.tab, r.anchor, r.code]; })(), ['health', 'coverage', 'COV']);
eq('the price feed\'s spellings are tickers: index, future, share class, crypto, a Korea code', [go('^XYZ DES'), go('XY=F DES'), go('XYZ-B DES'), go('XYZ-USD GEX'), go('123456.KS')],
  [['ticker', '^XYZ'], ['ticker', 'XY=F'], ['ticker', 'XYZ-B'], ['gex', 'XYZ-USD'], ['ticker', '123456.KS']]);
eq('beside DES or GEX a word that is also a code is the ticker', [go('SM DES'), go('des cal'), go('ECO GEX')], [['ticker', 'SM'], ['ticker', 'CAL'], ['gex', 'ECO']]);
eq('but two ticker views together are nothing', go('DES GEX'), null);
eq('a code alone is still the code', [go('SM'), go('CAL')], [['street', null], ['calendar', null]]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
