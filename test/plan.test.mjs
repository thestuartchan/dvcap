// test/plan.test.mjs — posture by regime × conditions, blended between regimes, and where each transition moves it.
import { rangeOf, midOf, tiltBuckets, BAND_TILTS, postureGrid, blendedPosture, transitionTarget, transitionPlan, expectedRank, REGIME_KEYS, BAND_KEYS, BUCKETS } from '../lib/plan.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const row = (cash, ins, inc, lt, dep, st = 'HOLD') => ({
  cash: { range: cash, status: st, note: 'c' }, insurance: { range: ins, status: 'ACTIVATE', note: 'i' },
  income: { range: inc, status: 'HOLD', note: 'n' }, longTermHolds: { range: lt, status: 'HOLD', note: 'l' },
  deploymentReady: { range: dep, status: 'PAUSE', note: 'd' }, categoryNote: 'x',
});
const ALLOC = {
  baseline: row('55–65%', '0–3%', '8–12%', '15–20%', '5–10%'),
  stag: row('50–60%', '8–15%', '12–18%', '12–18%', '0–5%'),
  def: row('60–70%', '10–18%', '8–12%', '8–12%', '0–3%'),
  ref: row('25–35%', '0–3%', '12–18%', '25–35%', '20–30%', 'DEPLOY'),
  inf: row('40–50%', '5–10%', '15–20%', '15–20%', '5–10%'),
};
{
  eq('ranges parse, en dash or hyphen, single values too', [rangeOf('55–65%'), rangeOf('0-3%'), rangeOf('8%'), rangeOf('n/a')], [[55, 65], [0, 3], [8, 8], null]);
  eq('midpoints', [midOf('55–65%'), midOf('0–3%')], [60, 1.5]);
}
const grid = postureGrid(ALLOC);
{
  eq('sixteen cells', REGIME_KEYS.flatMap(r => BAND_KEYS.map(b => grid[r][b])).length, 16);
  eq('Calm and Caution are the regime\'s allocation as written', REGIME_KEYS.every(r => ['calm', 'caution'].every(b => BUCKETS.every(k => grid[r][b][k] === ALLOC[r][k]))), true);
  eq('Stress adds 5pp cash and 3pp hedges to every regime', REGIME_KEYS.map(r => [midOf(grid[r].stress.cash.range) - midOf(ALLOC[r].cash.range), midOf(grid[r].stress.insurance.range) - midOf(ALLOC[r].insurance.range)]),
     [[5, 3], [5, 3], [5, 3], [5, 3]]);
  eq('Crisis adds 10pp and 6pp', [midOf(grid.stag.crisis.cash.range) - 55, midOf(grid.stag.crisis.insurance.range) - 11.5], [10, 6]);
  eq('the tilt is funded, not conjured: the midpoints sum to what they did', REGIME_KEYS.every(r => ['stress', 'crisis'].every(b =>
     Math.abs(BUCKETS.reduce((a, k) => a + midOf(grid[r][b][k].range), 0) - BUCKETS.reduce((a, k) => a + midOf(ALLOC[r][k].range), 0)) < 0.2)), true);
  eq('deployment funds it first — reflation stress takes all 8pp from there', [grid.ref.stress.deploymentReady.range, grid.ref.stress.longTermHolds.range], ['13.6–20.4%', '25–35%']);
  eq('then core and income share the rest in proportion — never below zero', [grid.stag.crisis.deploymentReady.range, grid.stag.crisis.longTermHolds.range, grid.stag.crisis.income.range, grid.def.crisis.longTermHolds.range],
     ['0%', '6.6–9.9%', '6.6–9.9%', '2.2–3.3%']);
  eq('statuses follow: hedges activate, deployment pauses, core reduces in a crisis', [grid.ref.stress.insurance.status, grid.ref.stress.deploymentReady.status, grid.ref.crisis.longTermHolds.status, grid.ref.stress.longTermHolds.status],
     ['ACTIVATE', 'PAUSE', 'REDUCE', 'HOLD']);
  eq('a tilted cell says what moved', grid.ref.stress.tilt, [{ bucket: 'cash', delta: 5 }, { bucket: 'insurance', delta: 3 }, { bucket: 'deploymentReady', delta: -8 }]);
  eq('no tilt, no change', tiltBuckets(ALLOC.stag, null).buckets, ALLOC.stag);
  eq('the tilts are the ones agreed', [BAND_TILTS.stress.add, BAND_TILTS.crisis.add], [{ cash: 5, insurance: 3 }, { cash: 10, insurance: 6 }]);
  const tuned = postureGrid(ALLOC, { 'stag.stress': { cash: { range: '60–70%', status: 'HOLD', note: 'more cash under stress' } } });
  eq('a tuned cell changes only itself', [tuned.stag.stress.cash.range, tuned.stag.stress.tuned, tuned.stag.caution.cash.range, tuned.stag.caution.tuned], ['60–70%', true, '50–60%', false]);
}
{
  const one = blendedPosture(grid, { ref: 0, inf: 0, stag: 100, def: 0 }, 'caution');
  eq('a certain regime blends to its own ranges', [one.buckets.cash.lo, one.buckets.cash.hi, one.buckets.cash.mid, one.lead], [50, 60, 55, 'stag']);
  // Today's read: 27 / 20 / 22 / 31.
  const b = blendedPosture(grid, { ref: 27, inf: 20, stag: 22, def: 31 }, 'caution');
  eq('between regimes: cash is the probability-weighted midpoint', b.buckets.cash.mid, 49.4);
  eq('…insurance too', b.buckets.insurance.mid, 8.8);
  eq('…and the leading regime\'s notes are the ones carried', [b.lead, b.buckets.cash.lead.status], ['def', 'HOLD']);
  eq('no probabilities, no blend', blendedPosture(grid, null, 'calm'), null);
}
const state = {
  regime: { available: true, probs: { ref: 27, inf: 20, stag: 22, def: 31 }, growth: { level: -0.03 } },
  conditions: { band: { id: 'caution' } },
};
{
  eq('stress: same regimes, stress band', transitionTarget({ id: 'toStress' }, state), { regime: null, band: 'stress' });
  eq('growth rolling into stagflation', transitionTarget({ id: 'growthRolls', title: 'Growth rolls over → Stagflation' }, state), { regime: 'stag', band: 'caution' });
  eq('inflation up with growth below zero is stagflation', transitionTarget({ id: 'inflationUp' }, state).regime, 'stag');
  eq('hawkish and drain step the band up; easing steps it down; relief is calm',
     ['hawkish', 'drain', 'easing', 'relief'].map(id => transitionTarget({ id }, state).band), ['stress', 'stress', 'calm', 'calm']);
  eq('crisis does not step past crisis', transitionTarget({ id: 'drain' }, { ...state, conditions: { band: { id: 'crisis' } } }).band, 'crisis');
}
{
  const s = transitionPlan({ id: 'toStress' }, state, grid);
  eq('to stress: +5pp cash, +3pp hedges on the blend, sizing ×0.55 → ×0.41', [s.moves.map(m => [m.bucket, m.delta]), s.sizeFrom, s.sizeTo],
     [[['cash', 5], ['insurance', 3], ['income', -1.7], ['longTermHolds', -1.7], ['deploymentReady', -4.7]], 0.55, 0.41]);
  const g = transitionPlan({ id: 'growthRolls', title: 'Growth rolls over → Stagflation' }, state, grid);
  eq('into stagflation: insurance up, deployment down, size ×0.48',
     [g.moves.find(m => m.bucket === 'insurance')?.delta, g.moves.find(m => m.bucket === 'deploymentReady')?.delta, g.sizeTo], [2.7, -6.8, 0.48]);
  eq('…with the destination\'s statuses', g.status.deploymentReady, 'PAUSE');
}
{
  const items = [{ n: 'A', rank: 1, defRank: 5, refRank: 5, infRank: 1 }, { n: 'B', rank: 3, defRank: 1, refRank: 2, infRank: 4 }, { n: 'C', rank: 2, defRank: 2, refRank: 1, infRank: 2 }];
  const keys = { stag: 'rank', def: 'defRank', ref: 'refRank', inf: 'infRank' };
  eq('expected rank over today\'s probabilities', expectedRank(items, state.regime.probs, keys).map(x => [x.n, x.expRank]), [['C', 1.7], ['B', 2.3], ['A', 3.3]]);
  eq('a certain regime ranks by its own column', expectedRank(items, { stag: 100 }, keys).map(x => x.n), ['A', 'C', 'B']);
  eq('no probabilities keeps the declared order', expectedRank(items, null, keys).map(x => x.n), ['A', 'B', 'C']);
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
