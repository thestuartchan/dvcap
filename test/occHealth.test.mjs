// test/occHealth.test.mjs — was the map that went out actually sound, and would anyone know?
//
// Three nights of scheduled probes were spent chasing OCC's publication hour. Wrong target: the
// rung has never trusted a clock, it asks the file whether it rolled. The hour is diagnostic; the
// VERDICT is load-bearing, and the verdict was computed on every call and discarded on every call.
import { healthSample, appendHealth, healthSummary, grade, transitionRuns, confirmMinVerdict,
         HEALTH_MAX, SAME_WRITE_MAX_MIN } from '../lib/occHealth.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

// A settledGex result, sound in every respect, that each case below spoils one way.
const sound = {
  ok: true, spotSource: 'caller', expiriesUsed: ['a', 'b', 'c', 'd', 'e', 'f'],
  vintage: { fingerprint: '5793:13224816', rolledSinceClose: true, complete: true, shrank: false, unchangedMin: 240, rows: 5793 },
  oi: { coverage: 0.998, matched: 827, missingFromOcc: 0, deltaVsCboe: 0 },
  crossCheck: { ok: true, clean: true, verdict: 'agrees with CBOE on all 5 checks' },
  chain: { cached: false, ageMin: 0, ivBlackout: null },
};
const spoil = (patch) => healthSample({ ...sound, ...patch }, { symbol: 'QQQ', at: '2026-09-15T12:42:00Z', published: true });

// ── GRADED, BECAUSE "OK" IS NOT ONE QUESTION ────────────────────────────────
{
  eq('a sound book grades sound', spoil({}).grade, 'sound');
  eq('a book that never rolled is stale', spoil({ vintage: { ...sound.vintage, rolledSinceClose: false } }).grade, 'stale');
  eq('one that rolled but has not held is unconfirmed', spoil({ vintage: { ...sound.vintage, complete: null, unchangedMin: 4 } }).grade, 'unconfirmed');
  eq('one smaller than last time is suspect', spoil({ vintage: { ...sound.vintage, shrank: true } }).grade, 'suspect');
  eq('a second source disagreeing is disputed', spoil({ crossCheck: { ok: true, clean: false, verdict: 'disagrees with CBOE on put wall' } }).grade, 'disputed');
  eq('a reused vol surface is its own state', spoil({ chain: { ivBlackout: { ageMin: 37 } } }).grade, 'reusedIv');
  eq('thin coverage is its own state', spoil({ oi: { ...sound.oi, coverage: 0.62 } }).grade, 'thin');
  eq('a failed fetch is failed', healthSample({ ok: false, reason: 'OCC 503' }, { symbol: 'QQQ' }).grade, 'failed');
  // grade() is the whole rule in one place, and it is graded on the FLATTENED sample rather than on
  // a settledGex result — so a caller that records a sample from anywhere else gets the same verdict.
  eq('nothing at all grades failed rather than sound', grade(null), 'failed');
  eq('and the flattened shape grades on its own', grade({ ok: true, rolledSinceClose: true, complete: true, shrank: false, coverage: 0.99, crossCheckClean: true }), 'sound');

  // WORST FIRST, AND THE FIRST MATCH WINS. A stale book that ALSO disagrees with CBOE must report
  // as stale — folding the rarer and worse failure into the commoner one is how it goes unseen.
  eq('stale beats disputed', spoil({ vintage: { ...sound.vintage, rolledSinceClose: false },
    crossCheck: { ok: true, clean: false, verdict: 'x' } }).grade, 'stale');
  eq('suspect beats everything below it', spoil({ vintage: { ...sound.vintage, shrank: true, rolledSinceClose: false } }).grade, 'suspect');

  // NO CROSS-CHECK AT ALL IS A THIRD STATE, not a pass. A run where CBOE was unreachable has not
  // been verified against a second source and must not read as though it had.
  eq('an absent cross-check is null, not true', spoil({ crossCheck: { ok: false, reason: 'CBOE 504' } }).crossCheckClean, null);
  eq('and it does not by itself disqualify the book', spoil({ crossCheck: { ok: false } }).grade, 'sound');
}

// ── THE LOOP CLOSES ON WHAT WAS PUBLISHED ───────────────────────────────────
// Panel traffic at 3am is worth recording and says nothing about whether the brief was right. The
// brief is the thing that reaches a reader and cannot be taken back.
{
  const at = (d, g, published = true, symbol = 'QQQ') => ({ at: d, symbol, published, grade: g, rung: 'occ', unchangedMin: 300 });
  const NOW = new Date('2026-09-19T14:00:00Z');
  const log = [
    at('2026-09-15T12:42:00Z', 'sound'),
    at('2026-09-16T12:42:00Z', 'sound'),
    at('2026-09-17T12:42:00Z', 'stale'),
    at('2026-09-18T12:42:00Z', 'sound'),
    at('2026-09-19T12:42:00Z', 'sound'),
    at('2026-09-17T03:30:00Z', 'stale', false),     // a sample, not a publish
    at('2026-09-17T03:31:00Z', 'unconfirmed', false),
  ];
  const h = healthSummary(log, { days: 30, now: NOW });
  eq('every sample is counted', h.n, 7);
  eq('but only publishes are judged', h.published, 5);
  eq('four of five sound', [h.sound, h.soundPct], [4, 80]);
  // EXCEPTIONS ARE LISTED, NOT COUNTED. A rate cannot be acted on; the date and the reason can.
  eq('the exception is named with its date', h.exceptions.map(e => [e.at.slice(0, 10), e.grade]), [['2026-09-17', 'stale']]);
  ok('and says what went wrong', /had not rolled/.test(h.exceptions[0].detail));
  ok('the note carries the ratio', /4 of 5 published maps sound over 30 days/.test(h.note));

  // AN EMPTY WINDOW IS NOT A PASS. A rate over nothing is how a monitor that stopped receiving
  // data reads as healthy — which is the failure this file exists to make impossible.
  const none = healthSummary([], { days: 30, now: NOW });
  eq('no publishes means no rate', none.soundPct, null);
  ok('and it says why rather than reporting 100%', /no published map recorded/.test(none.note));
  const old = healthSummary([at('2026-01-01T12:42:00Z', 'sound')], { days: 30, now: NOW });
  eq('samples outside the window are excluded', old.published, 0);
  eq('and again no rate is invented', old.soundPct, null);

  // Per symbol, because one root failing while the other is fine is a different problem and a
  // combined rate hides it.
  const mixed = healthSummary([...log, at('2026-09-15T12:42:00Z', 'disputed', true, 'SPY')], { days: 30, now: NOW, symbol: 'SPY' });
  eq('a symbol is judged on its own rows', [mixed.published, mixed.sound], [1, 0]);

  eq('the log is bounded', appendHealth(Array.from({ length: HEALTH_MAX }, (_, i) => ({ at: `${i}` })), spoil({})).length, HEALTH_MAX);
  eq('nothing to append leaves it alone', appendHealth([1], null), [1]);
}

// ── ATOMIC OR PROGRESSIVE, WITHOUT A SAMPLING GRID ──────────────────────────
// The question that seemed to need minute-resolution sampling through a roll nobody can predict.
// It does not: an atomic settlement produces ONE transition, a progressive one produces several,
// and the span between first and last is the write duration.
{
  const roll = (to, symbol = 'QQQ') => ({ symbol, to, from: to, bracketMin: 1 });
  const nightly = transitionRuns([roll('2026-09-15T01:05:00Z'), roll('2026-09-16T02:31:00Z'), roll('2026-09-17T01:12:00Z')]);
  eq('three nights, three settlements', nightly.settlements, 3);
  eq('each a single step', [nightly.atomic, nightly.progressive], [3, 0]);
  eq('so there is no write span to report', nightly.minWriteSpanMin, null);
  ok('and it is described as consistent-with, not proven', /consistent with an atomic write/.test(nightly.note));

  // TWO TRANSITIONS INSIDE ONE SETTLEMENT is a progressive write, and its span is the floor
  // OCC_CONFIRM_MIN has to clear or the stability check passes a half-written file.
  const split = transitionRuns([roll('2026-09-15T01:05:00Z'), roll('2026-09-15T01:38:00Z'), roll('2026-09-16T02:31:00Z')]);
  eq('the two close together are one settlement', split.settlements, 2);
  eq('one of them progressive', split.progressive, 1);
  eq('spanning 33 minutes', split.minWriteSpanMin, 33);
  ok('reported as a floor, never as a duration', /which is a floor and not a duration/.test(split.note));
  // A DAY APART IS TWO NIGHTS, not one long write.
  ok('the grouping window is hours, not days', SAME_WRITE_MAX_MIN < 24 * 60);

  // ── WHAT THE EVIDENCE PERMITS SAYING ABOUT OCC_CONFIRM_MIN ────────────────
  eq('nothing observed is unmeasured', confirmMinVerdict(transitionRuns([]), 20).verdict, 'unmeasured');
  // THE REFUSAL THAT MATTERS. "We never saw a progressive write" and "progressive writes do not
  // happen" are different statements, and cutting the window on the first would be acting on an
  // absence of looking hard enough.
  const v = confirmMinVerdict(nightly, 20);
  eq('single-step settlements do not justify a cut', v.verdict, 'consistent-with-atomic');
  ok('and it says so in terms', /is NOT evidence that a progressive one cannot happen/.test(v.note));
  ok('so the current value stands', /20min stands rather than being cut on an absence/.test(v.note));
  // A write longer than the window IS actionable, in the other direction.
  eq('a 33min write against a 20min window is too low', confirmMinVerdict(split, 20).verdict, 'too low');
  eq('and inside a 60min window it is covered', confirmMinVerdict(split, 60).verdict, 'covered');
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
