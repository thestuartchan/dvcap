// test/read.test.mjs — the READ's confidence grading.
//
// lib/read.js had no test file, which is how the defect below survived: composeRead writes the
// paragraph at the bottom of every brief, in every region, every day, and nothing asserted anything
// about it.
//
// THE DEFECT. "US market shut — credit/VIX/NQ clauses are the prior US close" was pushed into
// `caveats`. All three crons fire outside US regular hours by design — Asia 18:42 ET, Europe 04:42,
// the US itself 08:42 — so it was true on every scheduled run of every region. Confidence is graded
// by COUNTING caveats (0 clean, 1 qualified, 2+ low), so that one permanent entry made "clean"
// unreachable and put every brief one caveat away from "low".
import { composeRead } from '../lib/read.js';
import { previousSessionDate } from '../lib/sessions.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// Enough state for creditSentence to produce something, which is what arms the prior-close branch.
const credit = { oas: 2.68, level: 'CALM', trend: 'FLAT', d1: 0.0, d5: 0.02 };
const hyg = { pct1d: -0.05 };
const base = { credit, hyg };

// ── THE ORDINARY CASE: SHUT, AND YESTERDAY ───────────────────────────────────
{
  const r = composeRead({ ...base, usRthOpen: false, usPrevSession: { date: '2026-09-09', daysBack: 1 } });
  ok('the prior close is stated as provenance', r.provenance.some(p => /prior US close/.test(p)));
  ok('and it appears in the text', /prior US close/.test(r.text));
  ok('but it is NOT a caveat', !r.caveats.some(c => /prior US close|market shut/i.test(c)));
  eq('so a shut US market alone grades clean', r.confidence, 'clean');
  ok('and the text says so', /Confidence clean/.test(r.text));
}

// ── WHAT ACTUALLY VARIES: A LONG GAP ─────────────────────────────────────────
{
  const r = composeRead({ ...base, usRthOpen: false, usPrevSession: { date: '2026-09-04', daysBack: 4 } });
  ok('a four-day-old close IS a caveat', r.caveats.some(c => /4 days back/.test(c)));
  ok('and it names the session date', r.caveats.some(c => /2026-09-04/.test(c)));
  eq('which degrades confidence', r.confidence, 'qualified');
  ok('the provenance is still stated alongside it', r.provenance.length > 0);
}

// ── THE GRADES ARE ALL REACHABLE AGAIN ───────────────────────────────────────
{
  const shut = { ...base, usRthOpen: false, usPrevSession: { date: '2026-09-09', daysBack: 1 } };
  eq('clean', composeRead(shut).confidence, 'clean');
  eq('qualified, on one real caveat',
     composeRead({ ...shut, staleNotes: ['one thing is stale'] }).confidence, 'qualified');
  eq('low, on two',
     composeRead({ ...shut, staleNotes: ['one thing is stale', 'so is another'] }).confidence, 'low');
  // The regression: before this, the permanent entry meant clean could not happen at all.
  ok('and clean is not reserved for an open US market',
     composeRead(shut).confidence === composeRead({ ...base, usRthOpen: true }).confidence);
}

// ── THE HELPER THE CAVEAT DEPENDS ON ─────────────────────────────────────────
// Wrong here and the caveat either never fires or fires every day, which is what it replaced.
{
  const at = (d) => previousSessionDate('SPY', new Date(`${d}T12:00:00Z`));
  eq('an ordinary Wednesday looks back one day', at('2026-09-09').daysBack, 1);
  eq('a Monday looks back over the weekend', at('2026-09-14'), { date: '2026-09-11', daysBack: 3 });
  // 2026-09-07 is Labor Day in data/holidays.json, so the Tuesday after reaches back to Friday.
  eq('the day after a holiday Monday reaches back four', at('2026-09-08'), { date: '2026-09-04', daysBack: 4 });
  // Thanksgiving Thursday 2026-11-26: the Friday half-day looks back to Wednesday.
  eq('a holiday mid-week is skipped too', at('2026-11-27'), { date: '2026-11-25', daysBack: 2 });
  // An unknown ticker falls through to the US default — deliberate in exchangeFor, not an accident,
  // so this asserts the default rather than a null. A symbol on a real other exchange resolves there.
  eq('an unknown ticker uses the US default', previousSessionDate('NOT_A_TICKER', new Date('2026-09-09T12:00:00Z')).daysBack, 1);
  ok('and a Hong Kong ticker resolves to its own calendar',
     previousSessionDate('0700.HK', new Date('2026-09-09T12:00:00Z')) != null);
}

// ── THE READ STAYS OBSERVATIONAL ─────────────────────────────────────────────
// Already asserted by lib/read.js's own guard; pinned here because the provenance sentence is new
// text going into every brief and it must not smuggle in a directive.
{
  const r = composeRead({ ...base, usRthOpen: false, usPrevSession: { date: '2026-09-04', daysBack: 4 } });
  const banned = /\b(buy|sell|go long|go short|add to|trim|overweight|underweight)\b/i;
  ok('the provenance sentence tells nobody what to do', !banned.test(r.provenance.join(' ')));
  ok('nor does the caveat', !banned.test(r.caveats.join(' ')));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
