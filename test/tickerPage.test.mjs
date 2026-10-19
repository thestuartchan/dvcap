// test/tickerPage.test.mjs — the ticker page's reads (lib/tickerPage.js). Fake tickers, made-up figures.
import { linesFor, ratioContext, nextEarnings, chartOf, money, cleanSymbol } from '../lib/tickerPage.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const rows = [
  { id: 1, symbol: 'XYZ', side: 'long', status: 'open', thesis: 'made-up thesis' },
  { id: 2, symbol: 'XYZ 2026-12-18 50C', side: 'long', status: 'watching' },
  { id: 3, symbol: 'XYZ', side: 'long', status: 'closed' },
  { id: 4, symbol: 'ABC', side: 'short', status: 'open' },
  { id: 5, symbol: 'spread', underlying: 'xyz', side: 'long', status: 'open', legs: [{}, {}] },
];
eq('your line: open and watched rows on the underlying, options and spreads included', linesFor(rows, 'xyz').map(r => [r.id, r.status, r.legs]), [[1, 'open', 0], [2, 'watching', 0], [5, 'open', 2]]);
eq('nothing for a name not in the book, or no book at all', [linesFor(rows, 'QRS'), linesFor(null, 'XYZ')], [[], []]);

eq('a ratio leg is found on its card, with its side', ratioContext('META').cards.map(c => [c.id, c.side]), [['nvda-meta', 'denominator'], ['smh-spenders', 'denominator']]);
eq('a ladder rung', ratioContext('IWM').ladder.rung, 4);
eq('SMH carries the concentration tell; a stranger carries nothing', [ratioContext('SMH').concentration, ratioContext('XYZ')], [true, { cards: [], ladder: null, concentration: false }]);

const events = [
  { date: '2026-10-01', title: 'XYZ Q3 earnings', region: 'US' },
  { date: '2026-11-05', title: 'Xyzzy Corp Q3 earnings (AC)', region: 'US', time: '16:05', tz: 'America/New_York' },
  { date: '2026-11-20', symbol: 'XYZ', title: 'XYZ earnings', auto: true, estimated: true, source: 'nasdaq.com' },
  { date: '2026-11-02', title: 'US ISM manufacturing', region: 'US' },
];
eq('the next earnings row by name, not one already past', nextEarnings(events, 'XYZ', { name: 'XYZZY CORP', today: '2026-10-19' }), { date: '2026-11-05', time: '16:05', tz: 'America/New_York', title: 'Xyzzy Corp Q3 earnings (AC)', estimated: false, source: 'hand-kept' });
eq('or by the symbol an automatic row carries, marked estimated', nextEarnings(events.slice(2), 'XYZ', { today: '2026-10-19' }).estimated, true);
eq('a ticker inside another word does not match', nextEarnings([{ date: '2026-11-01', title: 'ABCXYZ earnings' }], 'XYZ', { today: '2026-10-19' }), null);

const c = chartOf([['2026-01-02', 10], ['2026-01-05', 12], ['2026-01-06', 11]], { w: 100, h: 50, pad: 0 });
eq('the chart spans the box and reports its own range', [c.d, c.lo, c.hi, c.hiDate, c.ch1d, c.ch1y], ['M0.0,50.0 L50.0,0.0 L100.0,25.0', 10, 12, '2026-01-05', -8.33, 10]);
eq('one point is no chart', chartOf([['2026-01-02', 10]]), null);
eq('money', [money(82886000000), money(-4.12e8), money(4.27, { perShare: true }), money(null)], ['$82.9B', '−$412.0M', '4.27', '—']);
eq('symbols are cleaned', cleanSymbol(' brk.b '), 'BRK.B');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
