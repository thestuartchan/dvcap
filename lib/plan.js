// lib/plan.js — the Playbook as a planner: posture by regime × conditions, and where each
// transition would move it.
//
// The posture table used to be keyed by one regime (the consensus engine's, or a pin). It is now a
// 4 × 4 grid: the measured regime down, the conditions band across. The grid is SEEDED from the
// per-regime allocations with every band equal, so adopting it moves nothing; a band column changes
// only when a cell is tuned (`overrides`, keyed "regime.band").
//
// Between regimes, the plan does not pick one. The blended posture is the probability-weighted
// midpoint of each bucket across the four rows at today's band — the same rule the sizing multiplier
// follows, so a close call plans between the two cases instead of jumping when the top one flips.
//
// PURE. Inputs are the allocation table (App's POSTURE_ALLOCATIONS), the market state
// (lib/marketState.js computeMarketState) and optional overrides.
import { CONDITION_SIZING } from './marketState.js';
import { REGIME_SIZING } from './sizing.js';

export const REGIME_KEYS = Object.freeze(['ref', 'inf', 'stag', 'def']);
export const BAND_KEYS = Object.freeze(['calm', 'caution', 'stress', 'crisis']);
export const BUCKETS = Object.freeze(['cash', 'insurance', 'income', 'longTermHolds', 'deploymentReady']);

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// "55–65%" → [55, 65]; "8%" → [8, 8]; anything else → null.
export function rangeOf(range) {
  const nums = String(range ?? '').replace(/%/g, '').split(/[–-]/).map(s => parseFloat(s.trim())).filter(Number.isFinite);
  if (!nums.length) return null;
  return nums.length >= 2 ? [nums[0], nums[1]] : [nums[0], nums[0]];
}
export const midOf = (range) => { const r = rangeOf(range); return r ? (r[0] + r[1]) / 2 : null; };

// The 16 cells. A cell is the regime's allocation with any tuned buckets laid over it.
export function postureGrid(allocations = {}, overrides = {}) {
  const grid = {};
  for (const r of REGIME_KEYS) {
    grid[r] = {};
    for (const b of BAND_KEYS) {
      const base = allocations[r] || allocations.baseline || {};
      const ov = overrides[`${r}.${b}`] || {};
      const cell = { regime: r, band: b, tuned: Object.keys(ov).length > 0 };
      for (const k of BUCKETS) cell[k] = ov[k] ? { ...base[k], ...ov[k] } : base[k] ?? null;
      cell.categoryNote = ov.categoryNote ?? base.categoryNote ?? null;
      grid[r][b] = cell;
    }
  }
  return grid;
}

// Probability-weighted posture at one band. Each bucket: the weighted low, midpoint and high, and
// the regime that carries the most weight (whose status and note are the ones to read).
export function blendedPosture(grid, probs, band) {
  if (!grid || !probs || !band) return null;
  const W = REGIME_KEYS.reduce((a, r) => a + (probs[r] ?? 0), 0);
  if (!(W > 0)) return null;
  const lead = [...REGIME_KEYS].sort((a, b) => (probs[b] ?? 0) - (probs[a] ?? 0))[0];
  const out = { band, lead, buckets: {} };
  for (const k of BUCKETS) {
    let lo = 0, hi = 0, w = 0;
    for (const r of REGIME_KEYS) {
      const rg = rangeOf(grid[r]?.[band]?.[k]?.range);
      const p = (probs[r] ?? 0) / W;
      if (!rg || !p) continue;
      lo += rg[0] * p; hi += rg[1] * p; w += p;
    }
    out.buckets[k] = w > 0 ? { lo: r1(lo / w), hi: r1(hi / w), mid: r1((lo + hi) / 2 / w), lead: grid[lead]?.[band]?.[k] ?? null } : null;
  }
  return out;
}

// Where a transition would put the state: the regime it points to (null = unchanged) and the band.
const bandStep = (band, n) => BAND_KEYS[Math.max(0, Math.min(BAND_KEYS.length - 1, BAND_KEYS.indexOf(band) + n))];
export function transitionTarget(t, state) {
  const band = state?.conditions?.band?.id ?? null;
  const g = state?.regime?.growth?.level ?? null;
  switch (t?.id) {
    case 'toStress': return { regime: null, band: 'stress' };
    case 'growthRolls': return { regime: /stagflation/i.test(t.title) ? 'stag' : 'def', band };
    case 'inflationUp': return { regime: g != null && g >= 0 ? 'inf' : 'stag', band };
    case 'hawkish': return { regime: null, band: band ? bandStep(band, 1) : null };
    case 'drain': return { regime: null, band: band ? bandStep(band, 1) : null };
    case 'easing': return { regime: null, band: band ? bandStep(band, -1) : null };
    case 'relief': return { regime: null, band: 'calm' };
    default: return { regime: null, band };
  }
}

// The posture and sizing a transition would lead to, against today's. A regime change is taken as
// that quadrant at full weight; a band change keeps today's regime mix.
export function transitionPlan(t, state, grid, { regimeSizing = REGIME_SIZING } = {}) {
  const probs = state?.regime?.available ? state.regime.probs : null;
  const band = state?.conditions?.band?.id ?? null;
  const to = transitionTarget(t, state);
  const toProbs = to.regime ? Object.fromEntries(REGIME_KEYS.map(r => [r, r === to.regime ? 100 : 0])) : probs;
  const now = blendedPosture(grid, probs, band);
  const then = blendedPosture(grid, toProbs, to.band);
  const regimeMult = (p) => p ? REGIME_KEYS.reduce((a, r) => a + (regimeSizing[r]?.mult ?? 0.6) * (p[r] ?? 0) / 100, 0) : null;
  const size = (p, b) => { const m = regimeMult(p); const c = b ? CONDITION_SIZING[b] : null; return m != null && c != null ? Math.round(m * c * 100) / 100 : null; };
  const moves = [];
  if (now && then) {
    for (const k of BUCKETS) {
      const a = now.buckets[k], b = then.buckets[k];
      if (a && b && Math.abs(b.mid - a.mid) >= 1) moves.push({ bucket: k, from: a.mid, to: b.mid, delta: r1(b.mid - a.mid) });
    }
  }
  return {
    to, moves,
    sizeFrom: size(probs, band), sizeTo: size(toProbs, to.band),
    status: to.regime && then ? Object.fromEntries(BUCKETS.map(k => [k, then.buckets[k]?.lead?.status ?? null])) : null,
  };
}

// A ranked list (income plays, hedges) ordered by its EXPECTED rank over the regime probabilities.
// `keys` maps regime → the item's rank field. Items missing a rank count as last.
export function expectedRank(items = [], probs = null, keys = {}) {
  if (!probs) return items.map((it, i) => ({ ...it, expRank: null, order: i }));
  const W = REGIME_KEYS.reduce((a, r) => a + (probs[r] ?? 0), 0) || 1;
  const worst = items.length + 1;
  return items
    .map((it, i) => ({ ...it, order: i, expRank: r1(REGIME_KEYS.reduce((a, r) => a + (it[keys[r]] ?? worst) * (probs[r] ?? 0), 0) / W) }))
    .sort((a, b) => a.expRank - b.expRank || a.order - b.order);
}
