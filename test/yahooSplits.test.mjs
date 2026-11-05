// test/yahooSplits.test.mjs — re-applying splits Yahoo has only half applied (lib/yahoo.js adjustSplits).
//
// 6 Nov 2026: SOXX split 3-for-1 on 5 Nov and Yahoo's history came back mixed — closes before 2 Nov
// divided by 3, 2–4 Nov still at ~450, 5 Nov at ~132. The Signal Board read SOXX as 37% under its
// 20-day average and scored +171% three-session returns.
import { adjustSplits, splitEvents } from '../lib/yahoo.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const r2 = x => Math.round(x * 100) / 100;
const closes = rows => rows.map(r => r2(r.close));

const split = [{ date: '2026-11-05', ratio: 3 }];
const mixed = [
  { date: '2026-10-29', close: 171.29 }, { date: '2026-10-30', close: 157.17 },
  { date: '2026-11-02', close: 453.65 }, { date: '2026-11-03', close: 465.00 }, { date: '2026-11-04', close: 450.41 },
  { date: '2026-11-05', close: 131.90 },
];
eq('the 5 Nov SOXX history: only the unadjusted 2–4 Nov bars are divided', closes(adjustSplits(mixed, split)),
  [171.29, 157.17, 151.22, 155, 150.14, 131.9]);

const full = [{ date: '2026-11-03', close: 155 }, { date: '2026-11-04', close: 150.14 }, { date: '2026-11-05', close: 131.9 }];
eq('an already adjusted history passes through unchanged (no double split)', closes(adjustSplits(full, split)), [155, 150.14, 131.9]);

const raw = [{ date: '2026-11-03', close: 465, high: 470, low: 460, open: 462, volume: 100 }, { date: '2026-11-05', close: 131.9 }];
const a = adjustSplits(raw, split)[0];
eq('OHLC scale with the close; volume scales up', [r2(a.open), r2(a.high), r2(a.low), r2(a.close), a.volume], [154, 156.67, 153.33, 155, 300]);

eq('no split events: rows returned as they came', adjustSplits(mixed, []) === mixed, true);

const rev = [{ date: '2026-06-01', close: 10 }, { date: '2026-06-02', close: 101 }];
eq('a 1-for-10 reverse split multiplies the earlier bar', closes(adjustSplits(rev, [{ date: '2026-06-02', ratio: 0.1 }])), [100, 101]);

eq('splitEvents reads Yahoo events (3:1 dated by its UTC day)',
  splitEvents({ events: { splits: { 1793889000: { date: 1793889000, numerator: 3, denominator: 1, splitRatio: '3:1' } } } }),
  [{ date: '2026-11-05', ratio: 3 }]);
eq('splitEvents: no events block → none', splitEvents({}), []);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
