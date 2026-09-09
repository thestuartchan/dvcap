// test/scenarios.test.mjs — magnitude, vintage, and how long a scenario has been saying this.
import { evaluateScenarios, SCENARIO_CFG, ATR_GATE } from '../lib/scenarios.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const A = (rows) => rows.find(s => s.id === 'A');
const NOW = '2026-09-03T08:00:00Z';

// ── THE NOISE THAT WAS BEING READ AS CONFIRMATION ───────────────────────────
// Scenario A validated "TLT rising" on +0.10% and "10s30s not steepening" on −2bp against a 72bp
// spread, and rendered both as ticks.
{
  const noisy = evaluateScenarios({
    tlt: { value: 0.10, atr: 0.62, date: '2026-09-03' },
    tenThirtyDeltaBps: { value: -2, atr: 4.1, date: '2026-09-03' },
  }, undefined, { now: NOW });
  const a = A(noisy);
  eq('neither noise input counts', a.total, 0);
  eq('so nothing is confirmed', a.confirmed, false);
  eq('and both render neutral', a.neutral, 2);
  ok('a neutral is not a miss either', a.conditions.every(c => c.met === null));
  ok('and each says why', a.conditions.every(c => /below half an ATR/.test(c.reason)));
  ok('showing the floor it had to clear', a.conditions[0].display.includes('0.5×ATR'));
  eq('the gate is stated', ATR_GATE, 0.5);
}
{
  // The same inputs, genuinely large.
  const real = A(evaluateScenarios({
    tlt: { value: 0.95, atr: 0.62, date: '2026-09-03' },
    tenThirtyDeltaBps: { value: -6, atr: 4.1, date: '2026-09-03' },
  }, undefined, { now: NOW }));
  eq('real moves confirm', real.status, 'CONFIRMED');
  eq('both count', real.total, 2);
  ok('and the display carries the multiple of ATR', real.conditions[0].display.includes('×ATR'));

  // A REJECTION also has to clear the floor. A tick that cannot confirm cannot deny.
  const tiny = A(evaluateScenarios({
    tlt: { value: -0.10, atr: 0.62, date: '2026-09-03' },
    tenThirtyDeltaBps: { value: -6, atr: 4.1, date: '2026-09-03' },
  }, undefined, { now: NOW }));
  eq('a tiny move against the scenario is not a rejection', tiny.conditions[0].met, null);
  eq('only the real leg counts', tiny.total, 1);

  // Exactly half an ATR is the boundary.
  const at = A(evaluateScenarios({ tlt: { value: 0.31, atr: 0.62, date: 'd' } }, undefined, { now: NOW }));
  eq('exactly 0.5x ATR counts', at.conditions[0].met, true);
  const under = A(evaluateScenarios({ tlt: { value: 0.3099, atr: 0.62, date: 'd' } }, undefined, { now: NOW }));
  eq('a hair under does not', under.conditions[0].met, null);
}
{
  // NO ATR IS ALSO NEUTRAL — magnitude cannot be judged without a scale, and judging it anyway is
  // exactly what the old board did.
  const noScale = A(evaluateScenarios({ tlt: { value: 5.0, date: 'd' } }, undefined, { now: NOW }));
  eq('a big move with no ATR still does not count', noScale.conditions[0].met, null);
  ok('and says the scale is missing', noScale.conditions[0].reason.includes('no ATR'));
  // A bare number from an older caller behaves the same way rather than silently counting.
  eq('a legacy bare number is neutral', A(evaluateScenarios({ tlt: 5.0 }, undefined, { now: NOW })).conditions[0].met, null);
}
{
  // A LEVEL near its threshold is the same problem wearing different clothes.
  const rows = evaluateScenarios({
    us30y: { value: SCENARIO_CFG.hawkish30y + 0.001, atr: 0.06, date: 'd' },
  }, undefined, { now: NOW });
  const c = rows.find(s => s.id === 'C');
  eq('a level sitting on its threshold is neutral', c.conditions[0].met, null);
  ok('and says it is inside the daily range of the line', c.conditions[0].reason.includes('threshold'));
  const clear = evaluateScenarios({ us30y: { value: SCENARIO_CFG.hawkish30y + 0.10, atr: 0.06, date: 'd' } },
    undefined, { now: NOW }).find(s => s.id === 'C');
  eq('clear of it, the level counts', clear.conditions[0].met, true);
}

// ── VINTAGE: A SCENARIO IS A DERIVED VALUE ──────────────────────────────────
// Scenario A validated a duration thesis using TLT from 12h ago against rate cards stale to 09-01.
{
  const mixed = A(evaluateScenarios({
    tlt: { value: 0.95, atr: 0.62, date: '2026-09-03' },
    tenThirtyDeltaBps: { value: -6, atr: 4.1, date: '2026-09-01' },
  }, undefined, { now: NOW }));
  eq('mixed vintages render UNVERIFIED', mixed.status, 'UNVERIFIED');
  eq('and never confirmed', mixed.confirmed, false);
  ok('with the disagreeing dates named', mixed.vintage.reason.includes('2026-09-01') && mixed.vintage.reason.includes('2026-09-03'));
  ok('naming the legs, not just "dates disagree"', mixed.vintage.reason.includes('TLT'));

  const matched = A(evaluateScenarios({
    tlt: { value: 0.95, atr: 0.62, date: '2026-09-03' },
    tenThirtyDeltaBps: { value: -6, atr: 4.1, date: '2026-09-03' },
  }, undefined, { now: NOW }));
  eq('matched vintages verify', matched.unverified, false);
  eq('and carry the shared date', matched.vintage.date, '2026-09-03');
  eq('and the check is marked as having run', matched.vintage.checked, true);

  // A single dated input has nothing to disagree with.
  const one = A(evaluateScenarios({ tlt: { value: 0.95, atr: 0.62, date: '2026-09-03' } }, undefined, { now: NOW }));
  eq('one input cannot be mismatched', one.unverified, false);
  // UNVERIFIED must not sort above a real finding.
  const rows = evaluateScenarios({
    tlt: { value: 0.95, atr: 0.62, date: '2026-09-03' },
    tenThirtyDeltaBps: { value: -6, atr: 4.1, date: '2026-09-01' },
    us30y: { value: 5.60, atr: 0.06, date: 'x' }, oas: { value: 3.9, atr: 0.1, date: 'x' },
  }, undefined, { now: NOW });
  ok('UNVERIFIED does not sort to the top', rows[0].id !== 'A');
  eq('a real confirmation does', rows[0].status, 'CONFIRMED');
}

// ── OBSERVATION, NOT INSTRUCTION ────────────────────────────────────────────
{
  const rows = evaluateScenarios({}, undefined, { now: NOW });
  ok('every scenario states what it would mean', rows.every(s => s.implication));
  ok('and the single observation that would break it', rows.every(s => s.falsifier));
  // The board describes state. No sizing, no entries, no exits in the new fields.
  const banned = /\b(buy|sell|add|trim|deploy|exit|size|position|allocate|stop)\b/i;
  ok('no implication issues an instruction', rows.every(s => !banned.test(s.implication)));
  ok('no falsifier does either', rows.every(s => !banned.test(s.falsifier)));
  ok('a falsifier is an observation, not a mood', rows.every(s => /\d|ATR|premium|rolling|basket|threshold/i.test(s.falsifier)));
}

// ── HOW LONG IT HAS SAID THIS ───────────────────────────────────────────────
{
  const live = { tlt: { value: 0.95, atr: 0.62, date: 'd' }, tenThirtyDeltaBps: { value: -6, atr: 4.1, date: 'd' } };
  const first = evaluateScenarios(live, undefined, { now: '2026-09-01T00:00:00Z' });
  eq('a first read stamps now', A(first).lastFlipped, '2026-09-01T00:00:00Z');

  const same = evaluateScenarios(live, undefined, { previous: first, now: '2026-09-03T08:00:00Z' });
  eq('an unchanged reading keeps its original stamp', A(same).lastFlipped, '2026-09-01T00:00:00Z');
  eq('and is not marked as having just turned', A(same).flippedNow, false);

  const flipped = evaluateScenarios({ ...live, tenThirtyDeltaBps: { value: 6, atr: 4.1, date: 'd' } },
    undefined, { previous: same, now: '2026-09-03T08:00:00Z' });
  eq('a changed reading restamps', A(flipped).lastFlipped, '2026-09-03T08:00:00Z');
  eq('and says it turned', A(flipped).flippedNow, true);
  // A refresh with no prior state must not claim a flip.
  eq('no previous, no flip claim', A(first).flippedNow, false);
}

// ── A CONCLUSION IS NOT A STANDING ASSERTION ────────────────────────────────
// `consequence` is the one field on the board that tells the reader what to do, and it was
// rendered on every card regardless of whether the scenario held. On the 2026-09-03 board every
// scenario was UNREADABLE and all six printed an instruction — including A "Duration leg
// validated" beside B "Skip the bond leg", which cannot both be true.
{
  const noisy = evaluateScenarios({
    tlt: { value: 0.10, atr: 0.62, date: '2026-09-03' },
    tenThirtyDeltaBps: { value: -2, atr: 4.1, date: '2026-09-03' },
  }, undefined, { now: NOW });
  ok('the board is unreadable on that data', noisy.every(s => s.status === 'UNREADABLE'));
  ok('so nothing is confirmed', noisy.every(s => !s.confirmed));
  // The card renders `consequence && confirmed`, so this is the condition that suppresses it.
  eq('and no scenario qualifies to state one', noisy.filter(s => s.consequence && s.confirmed).length, 0);
  // A and B are mutually exclusive by construction — they must never both qualify.
  const both = noisy.filter(s => (s.id === 'A' || s.id === 'B') && s.confirmed);
  eq('A and B can never both hold', both.length === 2, false);
  // Implication is the unconfirmed reading, and it makes no claim of validation.
  const a = A(noisy);
  ok('an unconfirmed card still says what it would mean', !!a.implication);
  ok('without asserting it has happened', !/validated|on track/i.test(a.implication));

  // And where a scenario DOES hold, the consequence is available as before.
  const real = A(evaluateScenarios({
    tlt: { value: 0.95, atr: 0.62, date: 'd' }, tenThirtyDeltaBps: { value: -6, atr: 4.1, date: 'd' },
  }, undefined, { now: NOW }));
  eq('a confirmed scenario keeps its consequence', real.confirmed && !!real.consequence, true);
  // An UNVERIFIED scenario must not qualify either — mixed vintages are not a conclusion.
  const unver = A(evaluateScenarios({
    tlt: { value: 0.95, atr: 0.62, date: '2026-09-03' },
    tenThirtyDeltaBps: { value: -6, atr: 4.1, date: '2026-09-01' },
  }, undefined, { now: NOW }));
  eq('an unverified scenario states no consequence', unver.confirmed, false);
}

// ── SUPPRESSING EVIDENCE MUST NOT STRENGTHEN A CONCLUSION ───────────────────
// The ATR gate turned a real-but-small reading into a neutral, and neutrals were excluded from the
// denominator — so every input the gate silenced made the scenario EASIER to confirm. Measured on
// the 2026-09-03 board with the real TLT floor of 0.40%: Scenario A read CONFIRMED 1/1 with the
// duration leg it is named for suppressed.
{
  const a = A(evaluateScenarios({
    tlt: { value: 0.10, atr: 0.792, date: 'd' },            // the real measured TLT floor
    tenThirtyDeltaBps: { value: -2, atr: 3.0, date: 'd' },
  }, undefined, { now: NOW }));
  eq('the readable leg still agrees', [a.met, a.total], [1, 1]);
  eq('but the scenario is not confirmed', a.confirmed, false);
  eq('it is INCOMPLETE, which is a different message from PARTIAL', a.status, 'INCOMPLETE');
  eq('and the duration leg is the one that was suppressed', a.conditions[0].met, null);
  eq('so no consequence is stated', !!(a.consequence && a.confirmed), false);

  // The property, not just the example: silencing an input can never raise the verdict.
  const both = A(evaluateScenarios({
    tlt: { value: 0.95, atr: 0.792, date: 'd' },
    tenThirtyDeltaBps: { value: -6, atr: 3.0, date: 'd' },
  }, undefined, { now: NOW }));
  eq('with both legs readable and agreeing it confirms', both.status, 'CONFIRMED');
  ok('and confirming is strictly harder than being incomplete', both.confirmed && !a.confirmed);

  // A missing feed is disqualifying for the same reason a too-small move is.
  const missing = A(evaluateScenarios({
    tenThirtyDeltaBps: { value: -6, atr: 3.0, date: 'd' },
  }, undefined, { now: NOW }));
  eq('an absent input also blocks confirmation', missing.confirmed, false);
  eq('and reports the same way', missing.status, 'INCOMPLETE');

  // PARTIAL still means what it meant: readable evidence that disagrees.
  const mixed = A(evaluateScenarios({
    tlt: { value: -0.95, atr: 0.792, date: 'd' },
    tenThirtyDeltaBps: { value: -6, atr: 3.0, date: 'd' },
  }, undefined, { now: NOW }));
  eq('disagreeing but readable evidence is PARTIAL', mixed.status, 'PARTIAL');
  eq('with everything readable', mixed.allReadable, true);
}

// ── THE FALSIFIER IS SCORED, NOT NARRATED ────────────────────────────────────
// Observed on the live board 2026-09-09: KM rendered "2/3 · one leg away" while both halves of its
// own falsifier were true ON THE SAME SCREEN — CSOP 7709 units −7.2% (still falling) and VKOSPI
// −3.36%, which the Korea panel itself labelled "rolling over" and independently called
// EXHAUSTING. The break condition was grey prose; nothing evaluated it.
{
  const KM = (live) => evaluateScenarios(live).find(s => s.id === 'KM');

  // The board exactly as it was.
  const observed = KM({
    korea: { volBand: 'EXTREME', volRolling: true, date: '2026-09-09' },
    units7709: { value: -7.2, atr: 2.0, date: '2026-09-09' },
  });
  eq('the observed KM board is BROKEN', observed.status, 'BROKEN');
  eq('and flagged on the object', observed.broken, true);
  // The count that was misleading is still computed and still true — it is demoted, not deleted.
  eq('the entry count is unchanged', [observed.met, observed.total], [2, 3]);
  eq('both break legs fired', [observed.breakMet, observed.breakTotal], [2, 2]);
  ok('and each is named', observed.brokenBy.length === 2);
  ok('the vol leg by name', observed.brokenBy.some(b => /VKOSPI rolling over/.test(b)));
  ok('the units leg by name', observed.brokenBy.some(b => /units still falling/.test(b)));
  // THE POINT OF THE WHOLE CHANGE: it must not sort or read as "close to firing".
  eq('a broken scenario is not close to firing', observed.proximity, -1);
  ok('and cannot be confirmed', !observed.confirmed);

  // Still live: the seller is going but the vol has not rolled. Same units, one flag flipped.
  const running = KM({
    korea: { volBand: 'EXTREME', volRolling: false, date: '2026-09-09' },
    units7709: { value: -7.2, atr: 2.0, date: '2026-09-09' },
  });
  eq('with VKOSPI not yet rolled it is CONFIRMED, not broken', running.status, 'CONFIRMED');
  eq('nothing broke', running.broken, false);
  eq('and the entry count went UP, not down', running.met, 3);

  // Vol rolled but the selling stopped: the conjunction is half true and must NOT break it.
  const halfway = KM({
    korea: { volBand: 'EXTREME', volRolling: true, date: '2026-09-09' },
    units7709: { value: +3.1, atr: 2.0, date: '2026-09-09' },
  });
  eq('one leg of an "all" falsifier is not a break', halfway.broken, false);
  eq('though it is counted', halfway.breakMet, 1);

  // A conjunction with an unreadable leg is UNKNOWN, not satisfied. Letting a dark input count as
  // met would retire scenarios for having no data, which is the opposite of the intent.
  const blind = KM({ korea: { volBand: 'EXTREME', volRolling: true, date: '2026-09-09' } });
  eq('an "all" break with a missing leg does not fire', blind.broken, false);
  ok('and the scenario keeps its normal status', blind.status !== 'BROKEN');
}

// The ATR gate applies to breaks exactly as it does to entries — a break called off a move too
// small to read is the same error a confirmation would be, and more expensive, because it retires
// a scenario rather than raising one.
{
  const tiny = evaluateScenarios({
    korea: { volBand: 'EXTREME', volRolling: true, date: '2026-09-09' },
    units7709: { value: -0.1, atr: 2.0, date: '2026-09-09' },
  }).find(s => s.id === 'KM');
  eq('a sub-ATR fall does not break it', tiny.broken, false);
  eq('the leg is neutral, not false', tiny.breakConditions.find(c => /still falling/.test(c.label)).met, null);
}

// Break vintage is checked over the BREAK's own inputs. Entry legs disagreeing on their dates says
// nothing about whether the disproof is composable, and letting that veto would leave a dead
// scenario reading "one leg away" for a reason that has nothing to do with it.
{
  const mixed = evaluateScenarios({
    korea: { volBand: 'EXTREME', volRolling: true, date: '2026-09-01' },
    units7709: { value: -7.2, atr: 2.0, date: '2026-09-09' },
  }).find(s => s.id === 'KM');
  eq('break inputs from different days do not break it', mixed.broken, false);
  eq('and that is stated', mixed.breakUnverified, true);
  // `dates` is keyed BY CONDITION LABEL, not a list — so the reader can see which input is stale
  // rather than only that something is. Both legs must appear, with their own dates.
  eq('both break inputs are named with their dates', mixed.breakVintage.dates,
    { 'VKOSPI rolling over': '2026-09-01', '7709 units still falling': '2026-09-09' });
  ok('and the reason spells it out', /observation dates disagree/.test(mixed.breakVintage.reason));
}

// "either horizon" is a DISJUNCTION and must not be collapsed into the conjunction rule.
{
  const cp = (ah) => evaluateScenarios({ ah }).find(s => s.id === 'CP');
  eq('CP breaks on either horizon', cp({ d5: +1.8, d20: -0.1, atr: 0.5 }).breakMode, 'any');
  eq('one widening horizon is enough', cp({ d5: +1.8, d20: -2.4, atr: 0.5 }).broken, true);
  eq('the other horizon alone likewise', cp({ d5: -2.4, d20: +1.8, atr: 0.5 }).broken, true);
  eq('both compressing does not break it', cp({ d5: -1.8, d20: -2.4, atr: 0.5 }).broken, false);
  // An "any" break tolerates a dark leg, unlike "all" — one met leg is the whole claim.
  eq('an "any" break fires with the other leg missing', cp({ d5: +1.8, atr: 0.5 }).broken, true);
}

// C's falsifier is also a disjunction, and its second leg is categorical.
{
  const c = (live) => evaluateScenarios(live).find(s => s.id === 'C');
  const basketMixed = [{ name: 'TLT', dir: 'rising', date: '2026-09-09' }, { name: 'GLD', dir: 'falling', date: '2026-09-09' }, { name: 'IWM', dir: 'falling', date: '2026-09-09' }];
  eq('the basket breaking up ends C', c({ basket: basketMixed }).broken, true);
  const basketAll = basketMixed.map(b => ({ ...b, dir: 'falling' }));
  eq('a basket still selling together does not', c({ basket: basketAll }).broken, false);
}

// Every scenario has one. A board where half the cards can be disproved and half cannot is a board
// that quietly stops checking the ones that cannot.
{
  const all = evaluateScenarios({});
  eq('all six scenarios are present', all.length, 6);
  ok('and every one carries a scored break block', all.every(s => Array.isArray(s.breakConditions) && s.breakConditions.length > 0));
  ok('each with a declared mode', all.every(s => s.breakMode === 'all' || s.breakMode === 'any'));
  ok('and the prose falsifier is kept alongside it', all.every(s => typeof s.falsifier === 'string' && s.falsifier.length > 0));
  // With no inputs at all nothing can break — silence is not a disproof.
  ok('an empty board breaks nothing', all.every(s => s.broken === false));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
