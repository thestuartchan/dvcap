// test/gexDays.test.mjs — gamma regime against the day's price action (lib/gexDays.js).
import { gexDays, scoreboard, gexSummary, todayTellInputs, ATR_SESSIONS } from '../lib/gexDays.js';

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
// Each day is labelled by its OPEN against the PREVIOUS capture's flip. Day 19's flip (101) is
// above day 20's open (100): short. Day 20's capture moves the flip to 99, below day 21's open.
const all = gexDays([cap(21, 101, 102), cap(19, 100, 101), cap(20, 100, 99), cap(5, 100, 101)], bars);
const days = [all.find(d => d.date === day(20)), all.find(d => d.date === day(21))];

eq('the first capture, and a day without its ATR window, are not scored', all.map(d => d.date), [day(19), day(20), day(21)]);
eq('a lone capture scores nothing', gexDays([cap(20, 100, 101)], bars), []);
eq('the whipsaw day: opened under the prior flip', [days[0].regime, days[0].flip, days[0].range, days[0].move, days[0].trend, days[0].wide, days[0].brokeWall], ['short', 101, 3.5, 0.25, false, true, true]);
eq('the trend day: opened above the prior flip — its own capture (below its own flip) does not decide it', [days[1].regime, days[1].flip, days[1].range, days[1].move, days[1].eff, days[1].trend], ['long', 99, 1.44, 1.27, 0.88, true]);
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
// 8 Oct, QQQ labelled at the open: medians alike; trend days 5 of 17 long opens, 1 of 8 short.
{
  const q = [
    ...[0.56, 0.74, 0.69, 0.53, 1.31, 0.75, 1.53, 0.84].map((r, k) => ({ ...mk('short', r, 0.33, k), trend: k === 7 })),
    ...[1.15, 0.64, 0.77, 0.57, 0.78, 1.85, 0.78, 0.97, 0.67, 1.03, 0.53, 0.57, 0.86, 0.72, 0.80, 0.38, 0.69].map((r, k) => ({ ...mk('long', r, 0.31, 30 + k), trend: [0, 5, 6, 7, 14].includes(k) })),
  ];
  const h = gexSummary(q);
  eq('trend days as a rate, not a count', h.headline, 'Typical days look alike in both regimes; trend days have come more often after a long-gamma open (29% of those days vs 13%).');
  ok('…and the line says both rates', /5 of 17 \(29%\) of long-gamma opens, 1 of 8 \(13%\) of short-gamma opens/.test(h.lines[1]));
  ok('the caveat says how days are labelled', /labelled by its open against the previous session's flip/.test(h.confidence));
}
eq('one regime too thin: no comparison drawn', gexSummary(set.slice(0, 12)).headline, null);
ok('…and it says why', /Not enough days in both regimes to compare: 9 below the flip, 3 above/.test(gexSummary(set.slice(0, 12)).lines[0]));
ok('walls that break most days are called magnets at most', /have not held as intraday limits/.test(gexSummary(set.map(x => ({ ...x, brokeWall: true }))).lines[2]));


// The tells per session, and today's.
{
  const vix = { [day(19)]: 15, [day(20)]: 17 }, vix3m = { [day(19)]: 18, [day(20)]: 18 };
  const firstHour = { [day(21)]: { open: 100, close: 101.5 }, [day(60)]: { open: 101, close: 99 } };
  const rows = gexDays([cap(19, 100, 101), cap(20, 100, 99), cap(21, 101, 102)], bars, { vix, vix3m, firstHour });
  const d21 = rows.find(r => r.date === day(21));
  eq('a session carries its pre-open tells', [d21.vixPrev, d21.vix3mPrev, d21.curve, d21.firstHourAtr, d21.openVsFlipAtr], [17, 18, 0.944, 0.64, 0.42]);
  const t = todayTellInputs({ bars: bars.slice(0, 60), vix: { [day(59)]: 15.08 }, vix3m: { [day(59)]: 17.72 }, firstHour, captures: [cap(59, 100, 98), cap(60, 99, 100)] });
  eq('today: the prior close, today\'s open and first hour, the flip from before today', [t.asOf, t.today, t.vixPrev, t.firstHourAtr, t.flip, t.flipDate], [day(59), day(60), 15.08, -1, 98, day(59)]);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
