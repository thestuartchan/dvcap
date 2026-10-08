// test/gexDays.test.mjs — gamma regime against the day's price action (lib/gexDays.js).
import { gexDays, scoreboard, gexSummary, ATR_SESSIONS } from '../lib/gexDays.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

const day = (i) => new Date(Date.UTC(2026, 6, 1) + i * 86400000).toISOString().slice(0, 10);
// Flat bars with a 2-point true range: the ATR before any day is 2.
const bars = Array.from({ length: 60 }, (_, i) => ({ date: day(i), open: 100, high: 101, low: 99, close: 100 }));
const at = (i, o, h, l, c) => { bars[i] = { date: day(i), open: o, high: h, low: l, close: c }; };
at(20, 100, 104, 97, 100.5);   // short gamma: wide (3.5 ATR), little net move — whipsaw
at(21, 100, 103.2, 99.8, 103); // long gamma: a trend day (1.5 ATR, 88% kept)
const cap = (i, spot, flip, extra = {}) => ({ date: day(i), spot, flipLevel: flip, callWall: 102, putWall: 98, gexPctOfAdv: spot < flip ? -10 : 10, ...extra });
const days = gexDays([cap(20, 100, 101), cap(21, 101, 100), cap(5, 100, 101)], bars);

eq('a day needs the ATR window behind it', days.map(d => d.date), [day(20), day(21)]);
eq('the whipsaw day', [days[0].regime, days[0].range, days[0].move, days[0].trend, days[0].wide, days[0].brokeWall], ['short', 3.5, 0.25, false, true, true]);
eq('the trend day — its ATR carries the wide day before it', [days[1].regime, days[1].range, days[1].move, days[1].eff, days[1].trend], ['long', 1.44, 1.27, 0.88, true]);
eq('the ATR is the 14 sessions before the day', ATR_SESSIONS, 14);

// A scoreboard on medians, and the summary that reads it.
const mk = (regime, range, move, k) => ({ date: day(k), regime, range, move, eff: move / range, trend: move >= 0.6 && move / range >= 0.6, wide: range >= 1.2, brokeWall: range > 1 });
const set = [
  ...[0.95, 1.31, 0.75, 1.53, 0.97, 1.03, 0.69, 0.74, 0.56].map((r, k) => mk('short', r, 0.3, k)),
  ...[1.15, 0.77, 1.85, 0.78, 0.84, 0.57, 0.72, 0.80, 0.38].map((r, k) => mk('long', r, r > 1 ? 0.9 * r : 0.4, 20 + k)),
];
const sb = scoreboard(set);
eq('medians by regime', [sb.short.n, sb.short.range, sb.long.n, sb.long.range], [9, 0.95, 9, 0.78]);
eq('trend days counted by regime', [sb.long.trend, sb.short.trend], [2, 0]);
const s = gexSummary(set, { spot: 757.73, flipLevel: 751.06 }, { symbol: 'QQQ' });
eq('the headline: wider and choppier in short gamma', s.headline, 'Short gamma has meant wider, choppier days; long gamma, steadier direction.');
ok('the numbers behind it', /^Median range: 0\.95 ATR on short-gamma days vs 0\.78 on long-gamma days \(\+22%\)/.test(s.lines[0]));
eq('where today sits, and what days like it did', s.now, 'Now: QQQ 757.73 is 0.9% above the flip (751.06), so long gamma — a thin cushion; a 0.9% move down changes the regime. Long-gamma days so far: median range 0.78 ATR, open→close 0.4.');
ok('how much of a record it is', /^18 sessions — too few sessions to read yet/.test(s.confidence));
// 8 Oct, QQQ: medians alike, five of six trend days in long gamma around quieter long-gamma days.
{
  const q = [
    ...[0.94, 0.56, 0.64, 0.74, 0.69, 1.31, 0.75, 1.53, 0.78, 0.97, 1.03, 0.53, 0.69].map((r, k) => ({ ...mk('short', r, 0.3, k), trend: k === 9 })),
    ...[1.15, 0.77, 0.53, 0.57, 1.85, 0.78, 0.84, 0.67, 0.57, 0.86, 0.72, 0.80, 0.38].map((r, k) => ({ ...mk('long', r, 0.18, 30 + k), trend: [0, 4, 5, 6, 11].includes(k) })),
  ];
  eq('the trend days lead when the medians are alike', gexSummary(q).headline, 'Typical days look alike in both regimes, the trend days have come in long gamma (5 of 6), around otherwise quieter long-gamma days.');
}
eq('one regime too thin: no comparison drawn', gexSummary(set.slice(0, 12)).headline, null);
ok('…and it says why', /Not enough days in both regimes to compare: 9 below the flip, 3 above/.test(gexSummary(set.slice(0, 12)).lines[0]));
ok('walls that break most days are called magnets at most', /have not held as intraday limits/.test(gexSummary(set.map(x => ({ ...x, brokeWall: true }))).lines[2]));

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
