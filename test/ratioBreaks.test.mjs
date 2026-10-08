// test/ratioBreaks.test.mjs — the Ratios panel's break tracker (lib/ratioBreaks.js), on synthetic
// series whose stages are known. The acceptance table of the 8 Oct brief, Part A §8.
import fs from 'node:fs';
import { freshBreaks } from '../lib/ratioBreakLog.js';
import { breakTimeline, stageChip, stageWords, tagOf, mergeBreakLogs, stageSummary, breakId, BAND, HELD_DAYS } from '../lib/ratioBreaks.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const pts = (vals) => vals.map((v, i) => ({ d: day(i), v }));
// BAND sessions wiggling between 1.00 and 1.02: the prior range is [1.00, 1.02].
const base = () => Array.from({ length: BAND + 5 }, (_, i) => (i % 2 ? 1.02 : 1.0));
const last = (t) => t.days.at(-1);

// 1 · One close below the range, the next back inside: day 1, then a failed break.
{
  const t = breakTimeline(pts([...base(), 0.98, 1.01]));
  eq('1 · the first close below is day 1', stageChip(t.days.at(-2)).text, '▼ Break · day 1');
  eq('1 · back inside the next day: a failed break', stageChip(last(t)).text, '↩ Failed break');
  eq('1 · the record: reached day 1, failed on that date', [t.breaks.length, t.breaks[0].reached, t.breaks[0].failed_date], [1, 'day1', day(BAND + 6)]);
  // Shown for five sessions, then Inside again.
  const after = breakTimeline(pts([...base(), 0.98, 1.01, 1.0, 1.02, 1.0, 1.02, 1.01]));
  eq('1 · the failed tag lasts five sessions, then Inside', after.days.slice(-6).map(d => d.stage), ['failed', 'failed', 'failed', 'failed', 'failed', 'inside']);
}

// 2 · Two consecutive closes below the frozen level: Confirmed.
{
  const t = breakTimeline(pts([...base(), 0.98, 0.985]));
  eq('2 · the second consecutive close below: Confirmed', stageChip(last(t)).text, `▼ Confirmed · day 2 of ${HELD_DAYS}`);
  eq('2 · judged against the frozen edge', last(t).level, 1.0);
  eq('2 · and said so in the summary', stageWords(last(t)), '▼ Confirmed (day 2)');
}

// 3 · Five sessions beyond the FROZEN level while the rolling band moves under it. Day 1 closes at
// 0.95, so from day 2 the rolling 60-day low is 0.95 and 0.97–0.99 read as "inside" — the frozen
// 1.00 is what they are judged against, and they are all below it.
{
  const vals = [...base(), 0.95, 0.97, 0.98, 0.99, 0.985, 0.98];
  const t = breakTimeline(pts(vals));
  ok('3 · (the rolling band would call day 3 inside)', vals[BAND + 7] > 0.95);
  eq('3 · stages through the break', t.days.slice(-6).map(d => d.stage), ['day1', 'confirmed', 'confirmed', 'confirmed', 'held', 'held']);
  eq('3 · Held 5d, with the day count after it', stageChip(last(t)).text, `▼ Held ${HELD_DAYS}d · day 6`);
  // A Held break that closes back inside has ENDED — not failed.
  const end = breakTimeline(pts([...vals, 1.01]));
  eq('3 · back inside after Held: ended, with its length', stageChip(last(end)).text, '↩ Break ended after 6 days');
  // A trend: Held, then a fresh close below the CURRENT 60-day range starts a new break.
  const trend = breakTimeline(pts([...vals, 0.94]));
  eq('3 · a held break gives way to a fresh range break', [stageChip(last(trend)).text, trend.breaks.length, trend.breaks[0].reached, trend.breaks[0].superseded_date], ['▼ Break · day 1', 2, 'held', day(BAND + 11)]);
  // Not before Held: during confirmation the frozen level governs alone.
  const early = breakTimeline(pts([...base(), 0.98, 0.97]));
  eq('3 · before Held a lower close is the same break', [early.breaks.length, last(early).stage], [1, 'confirmed']);
  eq('3 · the record keeps what it reached', [end.breaks[0].reached, end.breaks[0].ended_date, end.breaks[0].failed_date], ['held', day(BAND + 11), null]);
}

// 4 · A flat ratio whose band edge rises 3% into it: tagged a window roll. An old low of 0.94 sits
// just inside the window five sessions ago and has aged out of today's.
{
  const n = BAND + 20, i = n - 1;
  const vals = Array.from({ length: n }, (_, k) => (k % 2 ? 0.985 : 0.975));
  vals[i - 63] = 0.94;
  for (let k = i - 5; k < i; k++) vals[k] = 0.97;
  vals[i] = 0.968;
  const p = pts(vals);
  const t = breakTimeline(p);
  eq('4 · a break below on the last day', last(t).stage, 'day1');
  eq('4 · tagged a window roll', last(t).tag, 'window roll');
  eq('4 · with the note', tagOf(p, i, 'below').note, `The range narrowed as the ${day(i - 63)} low dropped out; the ratio itself moved −0.2% in 5 days.`);
  eq('4 · and in the summary words', stageWords(last(t)), '▼ day 1 (window roll)');
  // The same break with the ratio moving is a price move.
  const moved = vals.slice(); for (let k = i - 5; k < i; k++) moved[k] = 0.99; moved[i] = 0.96;
  eq('4 · a ratio that moved is a price move', tagOf(pts(moved), i, 'below').tag, 'price move');
}

// 5 · Backfill over a long series: records exist, forward fields filled where data allows.
{
  const vals = [];
  let x = 1;
  for (let k = 0; k < 500; k++) { x *= Math.exp(0.012 * Math.sin(k / 9) + (k % 3 ? 0.004 : -0.007)); vals.push(+x.toFixed(5)); }
  const spy = pts(vals.map((v, k) => 100 + k * 0.1));
  const t = breakTimeline(pts(vals), { ratio: 'TEST', spy });
  ok('5 · the backfill finds breaks', t.breaks.length > 3);
  const early = t.breaks[0], late = t.breaks.at(-1);
  ok('5 · an early break has every forward field', Object.values(early.fwd_ratio_change).every(v => v != null) && Object.values(early.fwd_spy_change).every(v => v != null));
  eq('5 · d5 is the ratio from its day-1 close', early.fwd_ratio_change.d5, +((vals[pts(vals).findIndex(p => p.d === early.day1_date) + 5] / early.day1_close - 1) * 100).toFixed(2));
  ok('5 · a break near the end leaves the days it has not had blank', late.day1_date < day(480) || late.fwd_ratio_change.d20 === null);
  eq('5 · a record carries market data only', Object.keys(early).sort(), ['day1_close', 'day1_date', 'days_beyond', 'direction', 'ended_date', 'failed_date', 'fwd_ratio_change', 'fwd_spy_change', 'break_level', 'note', 'ratio', 'reached', 'superseded_date', 'tag'].sort());
}

// 6 · The stage summary against a hand count.
{
  const r = (reached, direction, d10, d20, tag = 'price move', k = 0) => ({ ratio: 'X', direction, day1_date: day(k), tag, reached, fwd_ratio_change: { d5: null, d10, d20 } });
  const log = [
    r('day1', 'below', 1, 2, 'price move', 1),       // went against a below break
    r('confirmed', 'below', -3, -5, 'price move', 2),// continued
    r('held', 'below', -4, -6, 'window roll', 3),    // continued
    r('held', 'above', 2, -1, 'price move', 4),      // d10 continued, d20 reversed
    r('confirmed', 'above', null, null, 'window roll', 5),
  ];
  const s = stageSummary(log);
  const row = (stage, tag) => s.find(x => x.stage === stage && x.tag === tag);
  eq('6 · day 1, all: every break counts', [row('day1', 'all').n, row('day1', 'all').d10, row('day1', 'all').d20], [5, { n: 4, pct: 75 }, { n: 4, pct: 50 }]);
  eq('6 · confirmed, all: four reached it', [row('confirmed', 'all').n, row('confirmed', 'all').d20], [4, { n: 3, pct: 67 }]);
  eq('6 · held: two, median d20 in the break direction', [row('held', 'all').n, row('held', 'all').medianD20], [2, 2.5]);
  eq('6 · split by tag', [row('held', 'window roll').n, row('held', 'price move').n, row('confirmed', 'window roll').n], [1, 1, 2]);
}

// The log is append-only: a later run fills and promotes, never removes.
{
  const a = { ratio: 'X', direction: 'below', day1_date: '2024-01-02', reached: 'day1', failed_date: null, fwd_ratio_change: { d5: -1, d10: null, d20: null } };
  const b = { ...a, reached: 'confirmed', fwd_ratio_change: { d5: -1, d10: -2, d20: null } };
  const old = { ratio: 'Y', direction: 'above', day1_date: '2023-01-02', reached: 'held' };
  const m = mergeBreakLogs([a, old], [b]);
  eq('log · a record past the closes window is kept', m.map(breakId), ['X|below|2024-01-02', 'Y|above|2023-01-02']);
  eq('log · promoted and filled', [m[0].reached, m[0].fwd_ratio_change.d10], ['confirmed', -2]);
  eq('log · never demoted', mergeBreakLogs([b], [a])[0].reached, 'confirmed');
}


// 7 · The public log is market data only: built from closes, importing nothing that reads the book.
{
  const src = fs.readFileSync(new URL('../lib/ratioBreakLog.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort();
  eq('7 · the log module imports prices, ratios and the store only', imports, ['./kv.js', './ratioBreaks.js', './ratios.js', './yahoo.js']);
  const series = (f) => Array.from({ length: 300 }, (_, k) => [day(k), f(k)]);
  const closes = Object.fromEntries(['NVDA', 'META', 'SMH', 'MSFT', 'GOOGL', 'AMZN', 'MU', 'CRWV', 'RSP', 'SPY', 'IWM', 'XLY', 'XLP'].map((s, j) => [s, series(k => 100 + j + 5 * Math.sin(k / (7 + j)))]));
  const recs = freshBreaks(closes, { now: Date.parse(day(299) + 'T22:00:00Z') });
  ok('7 · every card yields records from closes alone', recs.length > 0 && new Set(recs.map(r => r.ratio)).size === 7);
  ok('7 · no record carries a quantity, a position or a value', recs.every(r => !Object.keys(r).some(k => /qty|quantity|position|nlv|equity|exposure|value/i.test(k))));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
