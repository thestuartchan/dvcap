// test/preread.test.mjs — the delivery window.
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

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
