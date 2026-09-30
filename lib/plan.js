// lib/plan.js — the Playbook as a planner: posture by regime × conditions, and where each
// transition would move it.
//
// The posture table used to be keyed by one regime (the consensus engine's, or a pin). It is now a
// 4 × 4 grid: the measured regime down, the conditions band across. Calm and Caution are the
// per-regime allocations as written; Stress and Crisis add cash and hedges (BAND_TILTS). A cell can
// be tuned further (`overrides`, keyed "regime.band").
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

// ── THE CONDITIONS TILT ── Stress and Crisis carry more cash and more hedges than the regime's
// allocation. The extra is funded from deployment first, then core holds, then income, each only
// down to zero; Calm and Caution are the regime's allocation as written. Statuses follow: hedges
// ACTIVATE and deployment PAUSEs under either, and core holds REDUCE in a crisis.
export const BAND_TILTS = Object.freeze({
  stress: { add: { cash: 5, insurance: 3 }, status: { insurance: 'ACTIVATE', deploymentReady: 'PAUSE' } },
  crisis: { add: { cash: 10, insurance: 6 }, status: { insurance: 'ACTIVATE', deploymentReady: 'PAUSE', longTermHolds: 'REDUCE' } },
});
export const TILT_FUNDING = Object.freeze(['deploymentReady', 'longTermHolds', 'income']);
const fmtNum = (v) => String(Math.round(v * 10) / 10);
const fmtRange = (lo, hi) => (lo === hi ? `${fmtNum(lo)}%` : `${fmtNum(lo)}–${fmtNum(hi)}%`);

// One cell's buckets with a tilt applied. Returns the buckets and a line saying what moved.
export function tiltBuckets(base, tilt) {
  if (!tilt) return { buckets: base, moves: [] };
  const out = { ...base };
  const moves = [];
  let need = 0;
  for (const [k, d] of Object.entries(tilt.add || {})) {
    const rg = rangeOf(base[k]?.range);
    if (!rg) continue;
    out[k] = { ...base[k], range: fmtRange(rg[0] + d, rg[1] + d) };
    moves.push({ bucket: k, delta: d });
    need += d;
  }
  // Funding: deployment money first (it is stage-gated dry powder, and PAUSEs here anyway), then
  // core holds and income in proportion to their size. A funding bucket's range is SCALED, so its
  // midpoint falls by exactly what it gives and it never goes below zero.
  const give = (k, take) => {
    const rg = rangeOf(out[k]?.range);
    if (!rg || take <= 0) return 0;
    const mid = (rg[0] + rg[1]) / 2;
    const t = Math.min(take, mid);
    if (t <= 0) return 0;
    const f = 1 - t / mid;
    out[k] = { ...out[k], range: fmtRange(rg[0] * f, rg[1] * f) };
    moves.push({ bucket: k, delta: -Math.round(t * 10) / 10 });
    return t;
  };
  const [first, ...rest] = TILT_FUNDING;
  need -= give(first, need);
  if (need > 0) {
    const mids = rest.map(k => midOf(out[k]?.range) ?? 0);
    const tot = mids.reduce((a, x) => a + x, 0);
    if (tot > 0) rest.forEach((k, i) => give(k, Math.min(mids[i], need * mids[i] / tot)));
  }
  for (const [k, st] of Object.entries(tilt.status || {})) if (out[k]) out[k] = { ...out[k], status: st };
  return { buckets: out, moves };
}

// The 16 cells: the regime's allocation, the conditions tilt, then any tuned buckets over both.
export function postureGrid(allocations = {}, overrides = {}, { tilts = BAND_TILTS } = {}) {
  const grid = {};
  for (const r of REGIME_KEYS) {
    grid[r] = {};
    for (const b of BAND_KEYS) {
      const raw = allocations[r] || allocations.baseline || {};
      const t = tiltBuckets(raw, tilts?.[b]);
      const base = { ...raw, ...t.buckets };
      const ov = overrides[`${r}.${b}`] || {};
      const cell = { regime: r, band: b, tuned: Object.keys(ov).length > 0, tilt: t.moves.length ? t.moves : null };
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
