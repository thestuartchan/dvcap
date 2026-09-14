// test/regimeVintage.test.mjs — how much of the consensus behind the regime is still alive, and
// what that is allowed to change: the sizer's multiplier, the action card's conviction, and what
// the decision log remembers. Warn, never block — a decayed consensus makes the number smaller and
// says why; nothing here refuses.
import { consensusAlive, regimeVintage, CONSENSUS_DECAYED_BELOW, CONSENSUS_EXPIRED_BELOW } from '../lib/regimeVintage.js';
import { regimeMultiplier, UNCERTAINTY_HAIRCUT } from '../lib/sizing.js';
import { deriveAction } from '../lib/status.js';
import { decisionEntry } from '../lib/decisions.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

const row = (name, weight, recency, prob = 20, extra = {}) => ({ name, weight, recency, prob, asOf: '2026-06-30', ...extra });

// ── ALIVE IS A SHARE OF NOMINAL WEIGHT ───────────────────────────────────────
{
  const a = consensusAlive([row('A', 0.3, 1), row('B', 0.3, 1), row('C', 0.4, 1)]);
  eq('every source fresh is fully alive', a.alive, 1);
  const b = consensusAlive([row('A', 0.3, 1), row('B', 0.3, 0.5), row('C', 0.4, 0)]);
  eq('half of B and none of C leaves 45% of the weight standing', b.alive, 0.45);
  eq('and names the decayed sources with their factors', b.decayed.map(d => `${d.name}:${d.recency}`), ['B:0.5', 'C:0']);
  eq('an archived source counts for nothing either way', consensusAlive([row('A', 0.3, 1), row('B', 0.7, 0, 20, { archived: true })]).alive, 1);
  eq('a source with no probability is not consensus', consensusAlive([row('A', 0.3, 1), row('B', 0.7, 1, null)]).alive, 1);
  eq('no usable source at all is null, not zero', consensusAlive([]).alive, null);
}

// ── THE GRADE AND THE HAIRCUT ────────────────────────────────────────────────
{
  eq('fully alive is fresh with no haircut', [regimeVintage({ alive: 1 }).grade, regimeVintage({ alive: 1 }).haircut], ['fresh', 1]);
  eq(`below ${CONSENSUS_DECAYED_BELOW} is decayed`, regimeVintage({ alive: 0.6 }).grade, 'decayed');
  eq('and a decayed consensus is haircut by its own share, floored at the uncertainty haircut', regimeVintage({ alive: 0.6 }).haircut, 0.7);
  eq('a milder decay takes a milder cut', regimeVintage({ alive: 0.72 }).haircut, 0.72);
  eq(`below ${CONSENSUS_EXPIRED_BELOW} is expired at the floor`, [regimeVintage({ alive: 0.1 }).grade, regimeVintage({ alive: 0.1 }).haircut], ['expired', UNCERTAINTY_HAIRCUT]);
  eq('an undated consensus is unknown, treated like expired', [regimeVintage({}).grade, regimeVintage({}).haircut], ['unknown', UNCERTAINTY_HAIRCUT]);
  const due = regimeVintage({ alive: 0.9, refreshDue: true, staleNote: '2 months stale' });
  eq('a refresh that is due makes a fresh-looking consensus decayed', due.grade, 'decayed');
  eq('with the haircut from its own share, not the floor', due.haircut, 0.9);
  ok('and the note says both things', /consensus 90% alive/.test(due.note) && /refresh due, inputs 2 months stale/.test(due.note));
  eq('only a fresh consensus carries conviction', [regimeVintage({ alive: 1 }).conviction, due.conviction, regimeVintage({ alive: 0.1 }).conviction], [true, false, false]);
}

// ── THE SIZER: ONE UNRESOLVED REGIME, NOT TWO ────────────────────────────────
{
  const fresh = regimeVintage({ alive: 1 });
  eq('a fresh consensus changes nothing', regimeMultiplier({ regimeId: 'ref', vintage: fresh }).mult, 1);
  const decayed = regimeVintage({ alive: 0.6 });
  const m = regimeMultiplier({ regimeId: 'ref', vintage: decayed });
  eq('a decayed consensus takes the haircut', m.mult, 0.7);
  ok('and the reason names it with the share', /consensus decayed \(60% alive\) → ×0\.7 uncertainty haircut/.test(m.reasons[m.reasons.length - 1]));
  const both = regimeMultiplier({ regimeId: 'ref', contested: true, vintage: decayed });
  eq('contested AND decayed is one haircut, not two stacked', both.mult, 0.7);
  ok('with both reasons on one line', /regime contested \+ consensus decayed/.test(both.reasons[both.reasons.length - 1]));
  const deeper = regimeMultiplier({ regimeId: 'ref', contested: true, vintage: regimeVintage({ alive: 0.72 }) });
  eq('and the deeper of the two cuts is the one taken', deeper.mult, 0.7);
  eq('credit stress still caps first, then the haircut applies', regimeMultiplier({ regimeId: 'ref', creditDanger: true, vintage: decayed }).mult, 0.28);
  eq('the multiplier reports the vintage it was computed under', m.vintage, { grade: 'decayed', alive: 0.6 });
  eq('no vintage at all is the old behaviour exactly', regimeMultiplier({ regimeId: 'stag', contested: true }).mult, 0.42);
}

// ── THE ACTION CARD: A DECAYED CONSENSUS NAMES THE REGIME, IT DOES NOT ARGUE ─
{
  const base = { oas: 2.7, regimeLabel: 'Stagflation', regimePct: 55, regimeContested: false, labourVerdict: 'GREEN', labourSevere: false };
  eq('a fresh 55% regime argues for Stage 2', deriveAction({ ...base, regimeConviction: true }).stage, 2);
  const stale = deriveAction({ ...base, regimeConviction: false });
  eq('the same regime on a decayed consensus does not', stale.stage, 1);
  ok('and the card says so on the regime line', /consensus decayed — not arguing/.test(stale.inputs.find(i => i.name === 'regime').value));
  eq('the default is conviction, so no caller changes behaviour by omission', deriveAction(base).stage, 2);
}

// ── THE DECISION LOG REMEMBERS THE VINTAGE ───────────────────────────────────
{
  const e = decisionEntry({ row: { id: 'r1', symbol: 'QQQ', side: 'long' }, derived: { qty: 0 }, fill: { side: 'buy', qty: 10, price: 100 },
    suggestion: { mult: 0.7 }, regime: { regimeId: 'stag', vintage: regimeVintage({ alive: 0.6 }) }, action: 'taken' });
  eq('the grade is recorded beside the multiplier', [e.regimeId, e.regimeMult, e.regimeVintage, e.consensusAlive], ['stag', 0.7, 'decayed', 0.6]);
  const f = decisionEntry({ row: { id: 'r1', symbol: 'QQQ', side: 'long' }, derived: { qty: 0 }, fill: { side: 'buy', qty: 10, price: 100 }, suggestion: { mult: 1 }, regime: { regimeId: 'ref' }, action: 'taken' });
  eq('and is null, not invented, when the console did not have one', [f.regimeVintage, f.consensusAlive], [null, null]);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
