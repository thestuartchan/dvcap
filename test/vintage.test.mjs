// test/vintage.test.mjs — one rule for "is this input late", applied to every gate.
import { fieldVintage, gateVintages, staleGateCaveat, mixedVintageNote,
         GATE_ROLE, CAVEAT_CAP } from '../lib/vintage.js';
import { expectedLagBizDays } from '../lib/read.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// 2026-09-10 was a Thursday. Before the FRED publish hour and after it — the same observation
// reads differently, and that is the whole point.
const BEFORE = new Date('2026-09-10T01:30:00Z');
const AFTER  = new Date('2026-09-10T13:30:00Z');

// ── LATE IS RELATIVE TO THE SERIES' OWN SCHEDULE, NOT TO TODAY ──────────────
// FRED publishes the prior business day during the US morning. A two-business-day-old print is
// ordinary before that and late after it. A rule of "older than today" would fire on every gate
// on every run, and a warning that is always on is not a warning.
{
  const twoDays = { value: 2.67, date: '2026-09-08', name: 'HY OAS' };
  eq('two business days is ordinary before the publish hour', fieldVintage(twoDays, 'oas', BEFORE).late, false);
  eq('and late after it', fieldVintage(twoDays, 'oas', AFTER).late, true);
  eq('the expected lag is the shared rule, not a second copy',
     [expectedLagBizDays(BEFORE), expectedLagBizDays(AFTER)], [2, 1]);
  const yesterday = { value: 2.71, date: '2026-09-09', name: 'HY OAS' };
  eq('yesterday is never late', fieldVintage(yesterday, 'oas', AFTER).late, false);
  eq('the age is in business days', fieldVintage(twoDays, 'oas', AFTER).bizDays, 2);
}

// ── THE SENTENCE NAMES WHAT THE GATE IS FOR ─────────────────────────────────
// "T10YIE is 2 days old" and "the inflation-expectations leg of the debasement read is 2 days old"
// are the same fact and only one of them tells a reader whether to care.
{
  const v = fieldVintage({ value: 2.4, date: '2026-09-08', name: '10Y BE' }, 'breakeven', AFTER);
  ok('the note names the series', /10Y BE has not printed since 2026-09-08/.test(v.note));
  ok('and the role it plays', /inflation-expectations leg of the debasement read/.test(v.note));
  eq('every wired gate has a role', Object.keys(GATE_ROLE).every(k => GATE_ROLE[k].length > 3), true);
  // A gate that is not late carries no note — a caveat that fires on an ordinary state is noise.
  eq('an on-time gate says nothing', fieldVintage({ value: 2.4, date: '2026-09-09', name: '10Y BE' }, 'breakeven', AFTER).note, null);
}

// ── A LIVE INPUT HAS NOTHING TO AGE ─────────────────────────────────────────
// Fields carrying `live: true` are today's number by construction (lib/liveRates.js). Skipped,
// not excused: the reading says live and the vintage question does not arise.
{
  const live = { value: 5.347, date: '2026-09-10', name: 'US 30Y', live: true, liveAsOf: '2026-09-10 15:14 UTC' };
  const v = fieldVintage(live, 'us30y', AFTER);
  eq('a live field is never late', v.late, false);
  eq('and says it is live', v.live, true);
  ok('carrying the minute', /15:14/.test(v.label));
  // The delayed twin of the same series, on the same morning, IS late.
  eq('while the delayed one is', fieldVintage({ value: 5.25, date: '2026-09-08', name: 'US 30Y' }, 'us30y', AFTER).late, true);
}

// ── NOTHING TO JUDGE IS NULL, NOT A VERDICT ─────────────────────────────────
{
  eq('a missing field has no vintage', fieldVintage(null, 'oas', AFTER), null);
  eq('nor one with no date', fieldVintage({ value: 2.6, name: 'HY OAS' }, 'oas', AFTER), null);
  eq('nor one with no value', fieldVintage({ date: '2026-09-08', name: 'HY OAS' }, 'oas', AFTER), null);
}

// ── EVERY GATE, NOT JUST THE CREDIT ONE ─────────────────────────────────────
// The OAS caveat was right and it was the only one on the board. The 2-year, the breakeven, the
// 5y5y forward, the real yield and the term premium all reach decision functions from the same
// publication schedule with nothing attached.
{
  const macro = {
    oas:          { value: 2.71, date: '2026-09-09', name: 'HY OAS' },
    us2y:         { value: 4.39, date: '2026-09-08', name: 'US 2Y' },
    us10y:        { value: 4.92, date: '2026-09-10', name: 'US 10Y', live: true, liveAsOf: '2026-09-10 15:09 UTC' },
    us30y:        { value: 5.35, date: '2026-09-10', name: 'US 30Y', live: true, liveAsOf: '2026-09-10 15:09 UTC' },
    realYield:    { value: 2.31, date: '2026-09-04', name: '10Y Real' },
    breakeven:    { value: 2.44, date: '2026-09-08', name: '10Y BE' },
    fwdBreakeven: { value: 2.40, date: '2026-09-08', name: '5y5y fwd BE' },
  };
  const vs = gateVintages(macro, AFTER);
  eq('every gate present is read', vs.length, 7);
  eq('two of them are live', vs.filter(v => v.live).map(v => v.key), ['us10y', 'us30y']);
  eq('four are late', vs.filter(v => v.late).map(v => v.key).sort(), ['breakeven', 'fwdBreakeven', 'us2y', 'realYield'].sort());
  eq('and the credit gate is not, today', vs.find(v => v.key === 'oas').late, false);
  // An absent series is absent, not late.
  eq('a gate with no field is not invented', gateVintages({}, AFTER), []);
}

// ── THE CAVEATS ARE ONE FINDING, NOT SIX ────────────────────────────────────
// Confidence is graded by COUNTING caveats, so a day on which FRED publishes nothing would push
// six lines into the list and drive every brief to "low" for a single cause.
{
  const many = [
    { key: 'us2y', late: true, bizDays: 2, obsDate: '2026-09-08', note: 'a' },
    { key: 'breakeven', late: true, bizDays: 2, obsDate: '2026-09-08', note: 'b' },
    { key: 'realYield', late: true, bizDays: 4, obsDate: '2026-09-04', note: 'c' },
    { key: 'fwdBreakeven', late: true, bizDays: 2, obsDate: '2026-09-08', note: 'd' },
    { key: 'termPremium', late: true, bizDays: 2, obsDate: '2026-09-08', note: 'e' },
  ];
  const line = staleGateCaveat(many);
  ok('one line, with the count', /5 gates are reading stale observations/.test(line));
  ok('the oldest is named', /the oldest is 2026-09-04/.test(line));
  ok('and only a few are listed by name', (line.match(/\(\d+d\)/g) || []).length === CAVEAT_CAP);
  ok('with the rest counted', /and 2 more/.test(line));
  // A single late gate keeps its own sentence, which is more useful than a count of one.
  eq('one late gate gets its own note', staleGateCaveat([many[2]]), 'c');
  eq('and none gets nothing', staleGateCaveat([{ key: 'oas', late: false }]), null);
  eq('an empty list likewise', staleGateCaveat([]), null);
}

// ── COMPOSING A LIVE TICK WITH AN END-OF-DAY PRINT ──────────────────────────
// The debasement read compares gold and BTC, which tick all day, against a real yield and a
// breakeven that are settled prints. On a morning FRED has not published it is comparing this
// hour against the day before yesterday and calling the difference a regime.
{
  const vs = [
    { key: 'realYield', live: false, obsDate: '2026-09-08', bizDays: 2 },
    { key: 'breakeven', live: false, obsDate: '2026-09-09', bizDays: 1 },
  ];
  const note = mixedVintageNote(['gold', 'BTC'], vs, AFTER);
  ok('the mismatch is disclosed', /gold and BTC are live ticks/.test(note));
  ok('naming the oldest leg', /realYield is 2026-09-08/.test(note));
  ok('and saying it is structural rather than a fault', /an end-of-day series and a live tape always do/.test(note));
  // Nothing to disclose when everything is live, or when nothing is.
  eq('all-live composes cleanly', mixedVintageNote(['gold'], [{ key: 'us30y', live: true }], AFTER), null);
  eq('and no live leg means no mismatch to name', mixedVintageNote([], vs, AFTER), null);
  eq('a same-day print is not a mismatch',
     mixedVintageNote(['gold'], [{ key: 'realYield', live: false, obsDate: '2026-09-10', bizDays: 0 }], AFTER), null);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
