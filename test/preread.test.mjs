// test/preread.test.mjs — the delivery window.
import { localDateIn } from '../lib/sessions.js';
//
// The whole daily brief hangs on this arithmetic and it had never been pinned. The Asia brief was
// skipped on 2026-08-28; the endpoint was healthy and the schedule correct, and the only structural
// fragility in the path was that every region's cron fired at sinceOpen = 0 — the first accepted
// value, with no tolerance at all on the early side.
import { prereadWindow } from '../api/preread.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const at = (h, m, target) => prereadWindow(h * 60 + m, target);

// Asia: target 07:00 HKT, cron at 22:45 UTC = 06:45 local.
ok('the scheduled firing delivers', at(6, 45, 7).accept);
eq('and sits inside the window rather than on its edge', at(6, 45, 7).sinceOpen, 5);

// THE FAILURE THIS CLOSES. Before the grace, the window opened at 06:45 exactly, so a cron one
// minute early was a whole day's brief lost — silently, because nothing recorded that it should
// have run.
ok('a firing one minute early still delivers', at(6, 44, 7).accept);
ok('and five minutes early', at(6, 40, 7).accept);
ok('but not six', !at(6, 39, 7).accept);

// Late tolerance is unchanged: the assemble-and-post takes a few seconds, and Vercel crons drift.
ok('forty minutes late still delivers', at(7, 25, 7).accept);
ok('an hour late does not', !at(7, 40, 7).accept);

// THE DST PAIR MUST STAY MUTUALLY EXCLUSIVE. EU and US schedule both candidate UTC hours and let
// this gate pick one; if both passed, the brief would post twice.
{
  const first = at(8, 45, 9), second = at(9, 45, 9);   // exactly 60 local minutes apart
  eq('exactly one of the two candidates delivers', [first.accept, second.accept], [true, false]);
  // The span is what guarantees it — grace plus window must never reach the 60-minute separation.
  ok('the span cannot reach the candidates’ separation', first.span <= 60);
}
// The same, stated as a property rather than an example: no target hour admits both candidates.
ok('no target hour admits both', Array.from({ length: 24 }, (_, t) =>
  !(prereadWindow(t * 60 - 15 - 5, t).accept && prereadWindow(t * 60 - 15 - 5 + 60, t).accept)).every(Boolean));

// Window boundaries are half-open, so the arithmetic has no ambiguous minute.
{
  const w = prereadWindow(0, 7);
  eq('open is lead+grace before the target', w.open, 7 * 60 - 20);
  eq('and close is span past it', w.close, w.open + w.span);
  ok('the first minute is in', prereadWindow(w.open, 7).accept);
  ok('and the closing minute is out', !prereadWindow(w.close, 7).accept);
}

// ── THE DEDUPE HAS TO ASK IN THE REGION'S DAY ───────────────────────────────
// The schedule is now a poll: many attempts per window, and the gate accepts whichever lands
// inside it. That is only safe because a region that has already delivered today refuses the
// later attempts — and "today" has to mean the region's calendar day, not UTC's.
{
  // 23:10 UTC on 2026-09-02. Hong Kong is already on the 3rd; New York is still on the 2nd. The
  // Asia pre-read targets 07:00 HKT, so it fires in exactly this band — a UTC-dated check would
  // call the second attempt a new day and post the brief twice.
  const t = new Date('2026-09-02T23:10:00Z');
  eq('UTC and Hong Kong disagree about the date here', localDateIn('Asia/Hong_Kong', t), '2026-09-03');
  eq('and New York does not', localDateIn('America/New_York', t), '2026-09-02');
  ok('which is the whole reason the check is per-region',
    localDateIn('Asia/Hong_Kong', t) !== t.toISOString().slice(0, 10));

  // Two attempts inside one Asia window must agree they are the same day.
  const a1 = new Date('2026-09-02T23:07:00Z'), a2 = new Date('2026-09-02T23:39:00Z');
  eq('two attempts in one window are one day', localDateIn('Asia/Hong_Kong', a1), localDateIn('Asia/Hong_Kong', a2));
  // And the next day's window must not be.
  eq('the next day is a different day', localDateIn('Asia/Hong_Kong', new Date('2026-09-03T23:07:00Z')), '2026-09-04');

  // DST is the other thing this must survive: London's local date is unaffected by the BST/GMT
  // switch, which is precisely why the cron pairs could be deleted.
  eq('London in BST', localDateIn('Europe/London', new Date('2026-09-02T08:07:00Z')), '2026-09-02');
  eq('London in GMT', localDateIn('Europe/London', new Date('2026-11-03T09:07:00Z')), '2026-11-03');
  // Just before local midnight in GMT, UTC and London agree; the point is it never throws or drifts.
  eq('and across a year boundary', localDateIn('Europe/London', new Date('2027-01-01T00:30:00Z')), '2027-01-01');

  eq('a nonsense zone yields null rather than a wrong date',
    (() => { try { return localDateIn('Not/AZone', t); } catch { return null; } })(), null);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
