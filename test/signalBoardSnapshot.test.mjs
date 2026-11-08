// test/signalBoardSnapshot.test.mjs — the Signal Board's daily row, now on the scheduler and in Redis
// (lib/signalBoardSnapshot.js; build step 6 retired the committing GitHub workflow). No network.
import { runSnapshot, sessionRanges, SNAPSHOT_MAX_ROWS } from '../lib/signalBoardSnapshot.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const noBars = async () => [];
const payload = (date, phase = 'pre-open') => ({ ok: true, board: { rows: [] }, trade_day: { phase, target: date }, today: date });

{
  const r = await runSnapshot({ rows: [] }, { payload: payload('2026-11-09'), bars: noBars, pause: 0 });
  eq('a pre-open run adds the day\'s row', [r.ok, r.store.rows.map(x => x.date), r.summary.row?.target], [true, ['2026-11-09'], '2026-11-09']);
  const again = await runSnapshot(r.store, { payload: payload('2026-11-09'), bars: noBars, pause: 0 });
  eq('one row per date: a second run replaces it', again.store.rows.length, 1);
  const next = await runSnapshot(again.store, { payload: payload('2026-11-10'), bars: noBars, pause: 0 });
  eq('rows stay in date order', next.store.rows.map(x => x.date), ['2026-11-09', '2026-11-10']);
}
{
  const r = await runSnapshot({ rows: [{ date: '2026-11-06' }] }, { payload: payload('2026-11-09', 'in session'), bars: noBars, pause: 0 });
  eq('in session: no row, not a failure, and it says why', [r.ok, r.store.rows.length, r.note], [true, 1, 'the US session is open, so no row from this run; scoring only']);
  const bad = await runSnapshot({ rows: [] }, { payload: { ok: false }, bars: noBars, pause: 0 });
  eq('no board served: a failure that says so, nothing changed', [bad.ok, bad.why, bad.store.rows.length], [false, 'the board was not served', 0]);
  const so = await runSnapshot({ rows: [{ date: '2026-11-06' }] }, { scoreOnly: true, bars: noBars, pause: 0 });
  eq('score only: no board needed, no row added', [so.ok, so.store.rows.length], [true, 1]);
  const failing = await runSnapshot({ rows: [] }, { payload: payload('2026-11-09'), bars: async () => { throw new Error('feed down'); }, pause: 0 });
  eq('a bar feed that fails still saves the row (scoring waits for the next run)', [failing.ok, failing.store.rows.length], [true, 1]);
}
{
  const rows = Array.from({ length: SNAPSHOT_MAX_ROWS }, (_, i) => ({ date: `2020-01-01T${String(i).padStart(4, '0')}` }));
  const r = await runSnapshot({ rows }, { payload: payload('2026-11-09'), bars: noBars, pause: 0 });
  eq('the history is capped, the newest kept', [r.store.rows.length, r.store.rows.at(-1).date], [SNAPSHOT_MAX_ROWS, '2026-11-09']);
}
{
  const px = [{ date: '2026-11-05', open: 100, high: 102, low: 99, close: 101 }, { date: '2026-11-06', open: 101, high: 103, low: 100, close: 102 }];
  const iv = [{ date: '2026-11-04', close: 20 }, { date: '2026-11-05', close: 25 }];
  const s = sessionRanges(px, iv);
  eq('a session range is measured against the previous close\'s implied move', +s['2026-11-05'].toFixed(3), +((3 / 100) / (20 / 100 / Math.sqrt(252))).toFixed(3));
  eq('and uses the vol of the close before it, not the same day', +s['2026-11-06'].toFixed(3), +((3 / 101) / (25 / 100 / Math.sqrt(252))).toFixed(3));
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
