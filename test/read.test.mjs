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
import { composeRead, scopeToRegion, renderReadLines } from '../lib/read.js';
import { previousSessionDate } from '../lib/sessions.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// Enough state for creditSentence to produce something, which is what arms the prior-close branch.
// The REAL shapes. d1/d5 are objects ({ to, delta, basis }), not numbers — the first draft of this
// fixture used bare numbers and the assertions that did not touch them still passed, which is
// exactly how a fixture drifts away from the thing it stands in for.
const credit = { oas: 2.68, level: 'CALM', word: 'FLAT', d1: { to: 2.68, delta: 0, basis: '1d' }, d5: { delta: 0.02, dir: 'flat' } };
const hyg = { available: true, changePct: -0.05, pct1d: -0.05 };
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

// ── THE READ IS SCOPED TO ITS REGION ─────────────────────────────────────────
// It was not. Every brief got the same paragraph, so a European reader at 09:00 London was told
// "Flips if retail stops absorbing foreign selling" — the Korea thesis, as the headline conditional
// of their own brief — and carried a KRW gauge among their tripwires. On 2026-09-08, 42% of the EU
// brief was byte-identical to the US one and this was the largest shared block.
{
  const full = {
    ...base,
    korea: { won: { level: 1340.5, flip: 1491, aboveFlip: false }, vol: { level: 50.55, band: 'EXTREME', dir: 'rising' } },
    kofiaLatest: { foreignNet: { value: 632 }, retailNet: { value: -3033 } },
    leaning: { tripped: 1, usable: 3, unavailable: ['KRW > flip'], items: [
      { name: 'OAS widening', tripped: false, scenario: 'Hawkish / Disorderly' },
      { name: 'KRW > 1491',   tripped: null,  scenario: 'Korea flight' },
      { name: 'VIX rising',   tripped: false, scenario: 'Vol / Disorderly' },
      { name: 'NQ lower low', tripped: true,  scenario: 'Vol / Disorderly' },
    ] },
  };
  const labels = (r) => composeRead(full, { region: r }).structured.rows.map(x => x.label);

  eq('Asia keeps its own block', labels('asia').includes('KOREA'), true);
  eq('Europe does not', labels('eu').includes('KOREA'), false);
  eq('nor does the US', labels('us').includes('KOREA'), false);

  // The words, not just the row — the flip conditional and the retail thesis were prose.
  for (const r of ['eu', 'us']) {
    const out = composeRead(full, { region: r });
    ok(`no Korea language reaches the ${r} brief`, !/korea|KRW|retail|won\b/i.test(out.text));
    ok(`nor its flip conditional (${r})`, !out.structured.flipsIf);
  }
  ok('Asia still has the flip conditional', !!composeRead(full, { region: 'asia' }).structured.flipsIf);

  // THE COUNT MUST FOLLOW THE LIST. Leaving "1/4" beside three listed gauges would be a worse bug
  // than the one being fixed.
  const eu = composeRead(full, { region: 'eu' }).structured.rows.find(x => x.label === 'TRIPWIRES');
  eq('the tripwire count is recomputed from what is left', eu.state, '1/3');
  ok('and the KRW gauge is not among them', !/KRW/i.test(JSON.stringify(composeRead(full, { region: 'eu' }).structured)));

  // Second-order, and the reason it is worth doing properly: the unavailable KOREAN gauge was
  // counting as a caveat against a European brief.
  eq('Europe is no longer downgraded by a gauge that never applied to it',
     composeRead(full, { region: 'eu' }).confidence, 'clean');
  ok('while Asia, which the gauge does apply to, still carries it',
     composeRead(full, { region: 'asia' }).caveats.some(c => /gauge/.test(c)));

  // No region named means no filtering — the dashboard path is unchanged.
  eq('an unscoped call is untouched', scopeToRegion(full, null), full);
  eq('and asia is a pass-through', scopeToRegion(full, 'asia'), full);
}

// ── AND IT RENDERS AS LINES ──────────────────────────────────────────────────
// One 700-character paragraph was the largest and least scannable block in the brief.
{
  const out = composeRead({ ...base, usRthOpen: false, usPrevSession: { date: '2026-09-04', daysBack: 4 } });
  const lines = renderReadLines(out);
  ok('there is more than one line', lines.length > 1);
  ok('each gauge is its own bullet', lines.some(l => l.startsWith('• Credit')));
  ok('carrying the state as the implication', /• Credit · \*\*CALM/.test(lines.join('\n')));
  ok('and the detail as the data', /OAS 2\.68/.test(lines.join('\n')));
  ok('the qualifiers are one muted line at the end', /^_.*confidence/.test(lines[lines.length - 1]));
  ok('and no line is a paragraph', lines.every(l => l.length < 320));

  eq('nothing composed means nothing rendered', renderReadLines(null), []);
  eq('and neither does a read with no structure', renderReadLines({ structured: null }), []);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
