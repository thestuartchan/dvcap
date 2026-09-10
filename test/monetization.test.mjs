// test/monetization.test.mjs — software vs hardware, the AI monetization gate.
import { monetizationGate, spreadSeries, spreadAtrPp, cumSpread, runLength,
         MONETIZATION_SYMS, SPREAD_GATE, PURITY_GATE, PURITY_CLEAN,
         CONFIRM_SESSIONS, STATES } from '../lib/monetization.js';
import { monetizationLine } from '../lib/briefSections.js';
import { assertObservational } from '../lib/read.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// A synthetic history whose spread is a steady ±2pp, so the mean absolute daily spread — the
// scale everything here is measured against — is exactly 2.
const hist = (spreads) => spreads.map((v, i) => ({ date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`, a: v, b: 0, spread: v }));
const FLAT = hist(Array.from({ length: 60 }, (_, i) => (i % 2 ? 2 : -2)));

// ── THE SPREAD SERIES IS BUILT ON SHARED DATES ──────────────────────────────
// An unaligned pair silently compares a Tuesday to a Wednesday.
{
  const A = [{ date: '2026-09-07', close: 100 }, { date: '2026-09-08', close: 101 }, { date: '2026-09-09', close: 102 }];
  const B = [{ date: '2026-09-07', close: 50 },  { date: '2026-09-09', close: 49 }];
  const s = spreadSeries(A, B);
  eq('only shared dates produce a row', s.map(r => r.date), ['2026-09-09']);
  // 100 → 102 is +2%; 50 → 49 is −2%. Both legs step the same two sessions.
  eq('and both legs step the same interval', [s[0].a, s[0].b], [2, -2]);
  eq('so the spread is their difference', s[0].spread, 4);
  eq('a single shared date yields nothing', spreadSeries([{ date: 'd', close: 1 }], [{ date: 'd', close: 1 }]), []);
  eq('and a bad close is skipped rather than divided by', spreadSeries([{ date: 'a', close: 0 }, { date: 'b', close: 1 }], [{ date: 'a', close: 1 }, { date: 'b', close: 1 }]), []);
}

// ── THE SCALE, AND WHAT IT ACTUALLY MEASURES ────────────────────────────────
// The spread is ALREADY a daily change, measured from zero, so its true-range analogue is its own
// absolute value and the ATR reduces to the mean absolute daily spread. Running an ATR over it as
// though it were a price series would measure how much the SPREAD moves day to day — which makes
// a persistently wide gap look small, and is the wrong question.
{
  eq('a steady ±2pp pair has a 2pp normal day', spreadAtrPp(FLAT), 2);
  eq('a widening gap raises it, not lowers it', spreadAtrPp(hist(Array(60).fill(5))), 5);
  eq('too little history has no scale at all', spreadAtrPp(hist([1, 2, 3])), null);
}

// ── THE CUMULATIVE SERIES IS THE INDICATOR; THE 1d IS THE TICK ──────────────
{
  const drift = hist(Array.from({ length: 60 }, () => 1));
  eq('20 sessions of +1pp is +20pp', cumSpread(drift, 20), 20);
  eq('and 60 is +60pp', cumSpread(drift, 60), 60);
  eq('a window with too little in it says nothing', cumSpread(hist([1, 2]), 20), null);
  eq('the run counts sessions holding sign', runLength(hist([-1, 1, 1, 1])), 3);
  eq('a flip resets it', runLength(hist([1, 1, 1, -1])), 1);
  eq('and a zero breaks it', runLength(hist([1, 1, 0])), 0);
}

// ── MOVING TOGETHER IS THE DEFAULT, AND IT IS EARNED ────────────────────────
// Below half its own normal day the pair has said nothing, and a line that fires every morning is
// a line a reader stops seeing.
{
  const m = monetizationGate({ soft: -0.5, hard: -0.6, pure: -0.5, softHard: FLAT, softPure: FLAT });
  eq('a 0.1pp gap against a 2pp normal day is nothing', m.candidate, STATES.TOGETHER);
  ok('and it says why in its own units', /inside 0\.5×ATR/.test(m.why));
  eq('with the multiple carried', m.atrMult, 0.1);
  ok('the gate is a named constant', SPREAD_GATE > 0 && SPREAD_GATE < 1);
  // No history means no scale, and a gap cannot be called large without one.
  const noScale = monetizationGate({ soft: 3, hard: -3, pure: 3, softHard: [], softPure: [] });
  eq('no history, no verdict', noScale.candidate, STATES.TOGETHER);
  ok('and it says that is why', /no scale/.test(noScale.why));
}

// ── THE PEAK-AI SIGNATURE ───────────────────────────────────────────────────
// Hardware leading while software FALLS: infrastructure spend not appearing in software revenue.
{
  const m = monetizationGate({ soft: -2.5, hard: 0.5, pure: -2.4, softHard: FLAT, softPure: FLAT });
  eq('hardware leading with software down is the unmonetized state', m.candidate, STATES.UNMONETIZED);
  eq('and it reads amber', m.tone, 'amber');
  // Both up with hardware ahead is the ordinary 2023–25 regime, not a warning.
  const running = monetizationGate({ soft: 0.4, hard: 2.5, pure: 0.4, softHard: FLAT, softPure: FLAT });
  eq('both up with hardware ahead is just the cycle running', running.candidate, STATES.RUNNING);
  ok('and it is not amber', running.tone !== 'amber');
}

// ── THE MODULE'S MAIN JOB: TWO KINDS OF SOFTWARE LEADERSHIP ─────────────────
// IGV holds Microsoft and Oracle — two of the largest AI infrastructure SPENDERS — so part of it
// is the same capex trade it is being measured against. WCLD is mid-cap pure SaaS with no
// hyperscalers, and the gap between them says which kind of lead this is.
{
  // WCLD with it: genuine broad software strength.
  const genuine = monetizationGate({ soft: 2.5, hard: -0.5, pure: 2.4, softHard: FLAT, softPure: FLAT });
  eq('software leading with WCLD participating is rotation', genuine.candidate, STATES.ROTATION);
  eq('and the purity check passes', genuine.purity.state, 'OK');
  ok('saying the move is broad', /broad software, not megacap/.test(genuine.purity.note));

  // WCLD left behind: the megacaps are carrying IGV, which is the unmonetized state in disguise.
  const disguised = monetizationGate({ soft: 2.5, hard: -0.5, pure: 0.1, softHard: FLAT, softPure: FLAT });
  eq('software leading with WCLD lagging badly is NOT rotation', disguised.candidate, STATES.UNMONETIZED);
  eq('the purity check names it', disguised.purity.state, 'CONTAMINATED');
  ok('and the reason says the strength is not broad', /not broad/.test(disguised.purity.note));
  ok('the label says it was wearing the other one', /wearing a rotation label/.test(disguised.why));

  // Between the two gates is neither, and says so rather than picking.
  const between = monetizationGate({ soft: 2.5, hard: -0.5, pure: 1.0, softHard: FLAT, softPure: FLAT });
  eq('in between is WATCH', between.purity.state, 'WATCH');
  eq('and the candidate stays rotation', between.candidate, STATES.ROTATION);
  ok('the two purity gates are ordered', PURITY_CLEAN < PURITY_GATE);
  // A negative gap is stated as a magnitude — "ahead by −0.54pp" is what the signed value reads as.
  const wcldAhead = monetizationGate({ soft: 2.5, hard: -0.5, pure: 4.0, softHard: FLAT, softPure: FLAT });
  ok('WCLD ahead is said without a signed magnitude', !/by -/.test(wcldAhead.purity.note));

  // No WCLD print at all: the check cannot run, and the absence is stated rather than assumed away.
  const blind = monetizationGate({ soft: 2.5, hard: -0.5, pure: null, softHard: FLAT, softPure: [] });
  eq('no purity print, no purity verdict', blind.purity.state, 'unknown');
  ok('and it says what cannot be told apart', /cannot be told from a megacap one/.test(blind.purity.note));
}

// ── NOTHING IS LABELLED OFF ONE SESSION ─────────────────────────────────────
// This pair produces a dramatic-looking number on any volatile day, and a board that shouts on one
// session of rotation is worse than no module at all.
{
  const oneDay = [...FLAT.slice(0, 59), { date: '2026-09-10', a: 2.5, b: -0.5, spread: 3 }];
  const m = monetizationGate({ soft: 2.5, hard: -0.5, pure: 2.4, softHard: oneDay, softPure: FLAT });
  eq('the candidate is named', m.candidate, STATES.ROTATION);
  eq('but the state carries the pending flag', m.state, 'ROTATION TO SOFTWARE (pending)');
  eq('and it is not confirmed', m.confirmed, false);
  ok('with the count of what is needed', /1 session in this direction — 5 are needed/.test(m.pending));
  eq('the requirement is a named constant', CONFIRM_SESSIONS, 5);

  const fiveDays = [...FLAT.slice(0, 55), ...Array.from({ length: 5 }, (_, i) => ({ date: `2026-09-0${i + 5}`, a: 2.5, b: -0.5, spread: 3 }))];
  const held = monetizationGate({ soft: 2.5, hard: -0.5, pure: 2.4, softHard: fiveDays, softPure: FLAT });
  eq('five sessions in one direction confirms it', held.confirmed, true);
  eq('and the flag goes', held.state, STATES.ROTATION);
  eq('with nothing pending', held.pending, null);
  // MOVING TOGETHER needs no confirmation — it is the absence of a claim, not a claim.
  const quiet = monetizationGate({ soft: -0.5, hard: -0.6, pure: -0.5, softHard: oneDay, softPure: FLAT });
  eq('the default state is not held pending', quiet.confirmed, true);
}

// ── THE RATES CONFOUND, TESTED RATHER THAN ASSUMED ──────────────────────────
// Software is longer duration than semis, so on a hawkish day it should UNDERPERFORM. When it
// outperforms into rising yields the duration explanation is ruled out and the read is cleaner.
{
  const cleaner = monetizationGate({ soft: 2.5, hard: -0.5, pure: 2.4, softHard: FLAT, softPure: FLAT,
    thirtyRising: true, thirtySource: 'live ^TYX' });
  eq('software ahead into a rising 30-year rules rates out', cleaner.ratesRuledOut, true);
  ok('and says why', /longer-duration leg/.test(cleaner.ratesNote));
  ok('naming which 30-year answered', cleaner.thirtySource === 'live ^TYX');

  const notRuled = monetizationGate({ soft: 2.5, hard: -0.5, pure: 2.4, softHard: FLAT, softPure: FLAT, thirtyRising: false });
  eq('with yields falling it is not ruled out', notRuled.ratesRuledOut, false);
  ok('and the note says so rather than going quiet', /not ruled out/.test(notRuled.ratesNote));

  // It only applies where software is the one leading — this is the sole place the module gets
  // MORE confident, and it needs both halves.
  const hardLead = monetizationGate({ soft: -2.5, hard: 0.5, pure: -2.4, softHard: FLAT, softPure: FLAT, thirtyRising: true });
  eq('it does not apply when hardware leads', hardLead.ratesRuledOut, null);
  eq('and no unrelated 30-year makes it null', monetizationGate({ soft: 2.5, hard: -0.5, pure: 2.4, softHard: FLAT, softPure: FLAT }).ratesRuledOut, null);
}

// ── A MISSING LEG IS A MISSING RUNG, NOT A GUESS ────────────────────────────
{
  const m = monetizationGate({ soft: 2, hard: null, softHard: FLAT });
  eq('no hardware print, no rung', m.available, false);
  ok('and it names both instruments it needs', /IGV/.test(m.note) && /SMH/.test(m.note));
  eq('the three tickers are the ones specified', MONETIZATION_SYMS, { software: 'IGV', purity: 'WCLD', hardware: 'SMH' });
  // SKYY and PSJ are hyperscaler-heavy — the same contamination as IGV and worse.
  ok('and no hyperscaler-heavy substitute crept in',
     !Object.values(MONETIZATION_SYMS).some(t => ['SKYY', 'PSJ'].includes(t)));
}

// ── THE BRIEF LINE, RENDERED IN FULL ────────────────────────────────────────
// The golden fixtures capture a moving-together day, so this is where the line is actually looked
// at. See the waiver in test/prereadRender.test.mjs, which points here.
{
  eq('a moving-together day renders no line',
     monetizationLine(monetizationGate({ soft: -0.5, hard: -0.6, pure: -0.5, softHard: FLAT, softPure: FLAT })), null);
  eq('and an unavailable rung renders none either', monetizationLine({ available: false }), null);

  const oneDay = [...FLAT.slice(0, 59), { date: '2026-09-10', a: 2.5, b: -0.5, spread: 3 }];
  const line = monetizationLine(monetizationGate({
    soft: 2.5, hard: -0.5, pure: 2.4, softHard: oneDay, softPure: FLAT,
    thirtyRising: true, thirtySource: 'live ^TYX' }));
  ok('the line opens with its own marker', line.startsWith('🧩 '));
  ok('carrying both legs', /\*\*IGV\*\* \+2\.5% · \*\*SMH\*\* -0\.5%/.test(line));
  ok('the spread in points AND in its own volatility', /\+3pp \(1\.5×ATR\)/.test(line));
  ok('the candidate label with its pending flag', /\*\*ROTATION TO SOFTWARE\*\* — 1 session in this direction/.test(line));
  ok('the cumulative series, not only the tick', /20d [+-]/.test(line));
  ok('and the rates confound where it applies', /longer-duration leg/.test(line));

  // A confirmed state drops the pending clause and states the label.
  const fiveDays = [...FLAT.slice(0, 55), ...Array.from({ length: 5 }, (_, i) => ({ date: `2026-09-0${i + 5}`, a: 2.5, b: -0.5, spread: 3 }))];
  const held = monetizationLine(monetizationGate({ soft: 2.5, hard: -0.5, pure: 2.4, softHard: fiveDays, softPure: FLAT }));
  ok('a confirmed state is stated plainly', /\*\*ROTATION TO SOFTWARE\*\*/.test(held) && !/pending/.test(held));
  // The contamination finding reaches the brief, because it changes the label.
  const disguised = monetizationLine(monetizationGate({ soft: 2.5, hard: -0.5, pure: 0.1, softHard: fiveDays, softPure: FLAT }));
  ok('a contaminated lead says so in the brief', /the megacap holdings are carrying it/.test(disguised));

  for (const t of [line, held, disguised]) ok(`observational: "${t.slice(0, 34)}"`, assertObservational(t).ok);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
