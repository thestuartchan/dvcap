// test/yahooCloses.test.mjs — when is a daily bar settled (lib/yahoo.js yahooDailyCloses)?
//
// 17 Oct 2026: the factor panel read "→ 2026-10-15" on Saturday morning. The feed's trading day
// for futures, the dollar index and FX is the whole calendar day, so a settled Friday was held
// back until 00:15 New York — and the panel's calendar is the days every factor has a close.
import { yahooDailyCloses, nyAtUtc } from '../lib/yahoo.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

const Z = (iso) => Date.parse(iso) / 1000;
// A chart answer: daily bars at 00:00 New York (04:00Z in EDT), the last one `lastDate`.
function chart({ dates, regStart, regEnd, mt }) {
  return { chart: { result: [{
    meta: { gmtoffset: -14400, regularMarketTime: Z(mt), regularMarketPrice: 99, shortName: 'X',
            currentTradingPeriod: { regular: { start: Z(regStart), end: Z(regEnd) } } },
    timestamp: dates.map(d => Z(`${d}T04:00:00Z`)),
    indicators: { quote: [{ close: dates.map((_, i) => 90 + i) }] },
  }] } };
}
const withFeed = async (body, now) => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body });
  try { return (await yahooDailyCloses('XX=F', '1mo', { now: Date.parse(now) })).closes.at(-1)[0]; } finally { globalThis.fetch = real; }
};

eq('17:15 New York is 21:15Z in October (EDT)', new Date(nyAtUtc('2026-10-16', 17, 15)).toISOString(), '2026-10-16T21:15:00.000Z');
eq('and 22:15Z after the 1 Nov change (EST)', new Date(nyAtUtc('2026-11-06', 17, 15)).toISOString(), '2026-11-06T22:15:00.000Z');

// Friday 16 Oct, a futures day (00:00–23:59 New York).
const fri = chart({ dates: ['2026-10-14', '2026-10-15', '2026-10-16'], regStart: '2026-10-16T04:00:00Z', regEnd: '2026-10-17T03:59:00Z', mt: '2026-10-16T20:59:58Z' });
eq('Friday 16:30 New York: still trading, Friday left out', await withFeed(fri, '2026-10-16T20:30:00Z'), '2026-10-15');
eq('Friday 17:20 New York: settled, Friday in', await withFeed(fri, '2026-10-16T21:20:00Z'), '2026-10-16');
eq('Saturday 07:36 Dubai (Friday 23:36 New York): Friday in — the 17 Oct case', await withFeed(fri, '2026-10-17T03:36:00Z'), '2026-10-16');

// Thursday 15 Oct: the Globex evening reopens at 18:00 and writes into Thursday's bar.
const thu = chart({ dates: ['2026-10-14', '2026-10-15'], regStart: '2026-10-15T04:00:00Z', regEnd: '2026-10-16T03:59:00Z', mt: '2026-10-15T22:30:00Z' });
eq('Thursday 17:30 New York: settled, Thursday in', await withFeed(thu, '2026-10-15T21:30:00Z'), '2026-10-15');
eq('Thursday 19:00 New York: the evening is live in that bar, so it is left out', await withFeed(thu, '2026-10-15T23:00:00Z'), '2026-10-14');
eq('Friday 00:20 New York: past the old rule, Thursday in', await withFeed(thu, '2026-10-16T04:20:00Z'), '2026-10-15');

// A stock: the regular session is 09:30–16:00, unchanged.
const stock = chart({ dates: ['2026-10-15', '2026-10-16'], regStart: '2026-10-16T13:30:00Z', regEnd: '2026-10-16T20:00:00Z', mt: '2026-10-16T19:00:00Z' });
eq('a stock at 15:00 New York: left out', await withFeed(stock, '2026-10-16T19:00:00Z'), '2026-10-15');
eq('a stock at 16:20 New York: in, as before', await withFeed({ ...stock, chart: { result: [{ ...stock.chart.result[0], meta: { ...stock.chart.result[0].meta, regularMarketTime: Z('2026-10-16T20:00:00Z') } }] } }, '2026-10-16T20:20:00Z'), '2026-10-16');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
