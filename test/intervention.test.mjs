// test/intervention.test.mjs — the two flags that used to be one boolean, and the leg scoping.
import { detectEvent, eventLive, regimeStatus, contamination, cleanLegs,
         sessionsBetween, EVENT_CFG, REGIME_CFG, GRADE, CURRENCIES } from '../lib/intervention.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// ── THE EVENT: FOUR CRITERIA, ALL REQUIRED ──────────────────────────────────
const FULL = { currency: 'JPY', changePct: -2.03, atrPct: 0.55, volume: 400, avgVolume20: 100, legSharePct: 102, minutesToNextRelease: 240 };
{
  const e = detectEvent(FULL);
  eq('a complete signature fires', e.fired, true);
  eq('and all four criteria are reported', e.criteria.length, 4);
  eq('with none unknown', e.unknownCount, 0);

  // Each criterion alone must be able to stop it.
  eq('a move under 2x ATR does not', detectEvent({ ...FULL, changePct: -1.0 }).fired, false);
  eq('volume under 3x does not', detectEvent({ ...FULL, volume: 200 }).fired, false);
  eq('a leg under 80% of DXY does not', detectEvent({ ...FULL, legSharePct: 60 }).fired, false);
  eq('a release inside 30 min does not', detectEvent({ ...FULL, minutesToNextRelease: 10 }).fired, false);
  // Boundaries are inclusive where the brief says "at least".
  ok('exactly 2x ATR qualifies', detectEvent({ ...FULL, changePct: -1.10 }).criteria[0].met === true);
  ok('exactly 3x volume qualifies', detectEvent({ ...FULL, volume: 300 }).criteria[1].met === true);
  ok('exactly 80% does NOT — the brief says more than', detectEvent({ ...FULL, legSharePct: 80 }).criteria[2].met === false);
  ok('exactly 30 minutes away qualifies', detectEvent({ ...FULL, minutesToNextRelease: 30 }).criteria[3].met === true);
  // Direction of the leg share is irrelevant; magnitude is what attributes the move.
  eq('a negative share reads by magnitude', detectEvent({ ...FULL, legSharePct: -102 }).criteria[2].met, true);
}
{
  // MISSING EVIDENCE IS NOT ABSENCE OF EVIDENCE. This is the whole reason the flag was manual.
  const partial = detectEvent({ currency: 'JPY', changePct: -2.03, atrPct: 0.55, legSharePct: 102 });
  eq('an unevaluable criterion cannot fire an event', partial.fired, false);
  eq('two criteria were met', partial.metCount, 2);
  eq('and two could not be judged', partial.unknownCount, 2);
  ok('the reason names them', partial.reason.includes('volume') && partial.reason.includes('release'));
  // Specifically: an unknown release calendar must NOT be read as "no release".
  eq('an unknown release calendar is not treated as clear',
    detectEvent({ ...FULL, minutesToNextRelease: null }).fired, false);
  // A zero or absent ATR cannot divide.
  eq('no ATR, no magnitude judgement', detectEvent({ ...FULL, atrPct: 0 }).criteria[0].met, null);
  eq('no volume average either', detectEvent({ ...FULL, avgVolume20: 0 }).criteria[1].met, null);
  eq('an empty call does not throw', detectEvent().fired, false);
}

// ── EVENTS ARE SHORT-LIVED ──────────────────────────────────────────────────
{
  eq('the day it fired it is live', eventLive({ firedOn: '2026-09-03' }, '2026-09-03'), true);
  eq('two sessions later it still is', eventLive({ firedOn: '2026-09-01' }, '2026-09-03'), true);
  eq('three sessions later it is not', eventLive({ firedOn: '2026-08-31' }, '2026-09-03'), false);
  eq('no event, not live', eventLive(null, '2026-09-03'), false);
  eq('the clear threshold is stated', EVENT_CFG.clearAfterSessions, 2);
  // Weekends are not sessions.
  eq('Friday to Monday is one session', sessionsBetween('2026-09-04', '2026-09-07'), 1);
  eq('a backwards range is refused', sessionsBetween('2026-09-07', '2026-09-04'), null);
}

// ── THE REGIME: PERSISTENT, GRADED, THREE WAYS TO CLEAR ─────────────────────
const JPY = { currency: 'JPY', grade: GRADE.SUSPECTED, since: '2026-08-21', review: '2026-09-18' };
{
  const r = regimeStatus(JPY, { today: '2026-09-03' });
  eq('it is active', r.active, true);
  eq('and graded, never binary', r.grade, 'SUSPECTED');
  ok('and says what SUSPECTED costs to upgrade', r.reason.includes('MoF'));
  eq('an unset flag is simply absent', regimeStatus(null, { today: '2026-09-03' }).active, false);

  // Each clear condition, independently.
  eq('a manual clear clears it', regimeStatus(JPY, { today: '2026-09-03', manualClear: true }).active, false);
  eq('price beyond the level for 3 sessions clears it',
    regimeStatus(JPY, { today: '2026-09-03', sessionsBeyondDefended: 3 }).active, false);
  eq('but exactly 2 does not — the threshold is "more than"',
    regimeStatus(JPY, { today: '2026-09-03', sessionsBeyondDefended: 2 }).active, true);
  eq('11 quiet sessions clears it',
    regimeStatus(JPY, { today: '2026-09-03', sessionsSinceEvent: 11 }).active, false);
  eq('10 does not', regimeStatus(JPY, { today: '2026-09-03', sessionsSinceEvent: 10 }).active, true);
  ok('and the clear says which condition fired',
    regimeStatus(JPY, { today: '2026-09-03', sessionsSinceEvent: 11 }).reason.includes('no event signature'));
  // Unknown context never clears a flag — silence is not evidence the intervention stopped.
  eq('missing context leaves it standing',
    regimeStatus(JPY, { today: '2026-09-03', sessionsBeyondDefended: null, sessionsSinceEvent: null }).active, true);
  eq('the thresholds are stated', [REGIME_CFG.sustainSessions, REGIME_CFG.quietSessions], [2, 10]);
  // A grade the store does not recognise degrades to SUSPECTED rather than to CONFIRMED.
  eq('an unknown grade is not promoted', regimeStatus({ ...JPY, grade: 'DEFINITELY' }, { today: '2026-09-03' }).grade, 'SUSPECTED');
}

// ── CONTAMINATION IS SCOPED TO THE LEG ──────────────────────────────────────
// The structural point of the whole change.
{
  const state = { regimes: { JPY }, events: {}, context: {} };
  const c = contamination(state, '2026-09-03');
  eq('the yen leg is flagged', c.legs, ['JPY']);
  eq('the won is not', !!c.flagged.KRW, false);
  eq('and DXY is disqualified as a broad-dollar proxy', c.dxyUsable, false);
  ok('which the note explains rather than asserts', c.note.includes('not a broad-dollar proxy'));

  // THE LINE: a yen flag must not touch the euro.
  const legs = [{ vs: 'EUR', pct: -0.09 }, { vs: 'JPY', pct: -2.03 }, { vs: 'KRW', pct: -1.08 }];
  eq('EUR and KRW remain clean', cleanLegs(legs, c).map(l => l.vs), ['EUR', 'KRW']);
  ok('and the yen is the only one removed', cleanLegs(legs, c).every(l => l.vs !== 'JPY'));

  // Nothing flagged: DXY is usable again and every leg is clean.
  const none = contamination({ regimes: {}, events: {} }, '2026-09-03');
  eq('with no flags DXY is a proxy again', none.dxyUsable, true);
  eq('and nothing is filtered', cleanLegs(legs, none).length, 3);
  // A live EVENT contaminates too, not only a regime.
  const ev = contamination({ regimes: {}, events: { KRW: { firedOn: '2026-09-03' } } }, '2026-09-03');
  eq('a live event flags its leg', ev.legs, ['KRW']);
  const old = contamination({ regimes: {}, events: { KRW: { firedOn: '2026-08-01' } } }, '2026-09-03');
  eq('a stale event does not', old.legs, []);
  eq('both currencies are covered', CURRENCIES, ['JPY', 'KRW']);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
