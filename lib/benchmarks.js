// lib/benchmarks.js — percentile + band context for gauges (P1.2). A bare "MOVE 71.26" says
// nothing without knowing whether that is high. Percentile answers "is this unusual" (vs its own
// history); the band answers "does it matter" (a calibrated level). Both, inline, on every gauge.
//
// The window MUST be stated: FRED restricts ICE BofA OAS to a rolling 3-year window, and three
// years of historically tight spreads produce a misleading percentile if the window isn't labelled.

// Percentile of `value` within a historical series (share at or below it). Series entries may be
// raw numbers or {value}. Needs a minimum sample so a thin series can't print a confident number.
export function percentileOf(value, series, minN = 30) {
  const xs = (series || []).map(r => (typeof r === 'number' ? r : r?.value)).filter(v => Number.isFinite(v));
  if (value == null || xs.length < minN) return null;
  const below = xs.filter(v => v <= value).length;
  return Math.round((below / xs.length) * 100);
}

// Calibrated absolute bands (ascending; last entry has no max).
export const BENCH_BANDS = Object.freeze({
  oas:  [{ max: 3.0, label: 'CALM' }, { max: 4.5, label: 'WATCHFUL' }, { max: 8.0, label: 'STRESSED' }, { label: 'RECESSIONARY' }],
  vix:  [{ max: 20, label: 'LOW' }, { max: 25, label: 'NORMAL' }, { max: 35, label: 'ELEVATED' }, { max: 50, label: 'HIGH' }, { label: 'EXTREME' }],
  move: [{ max: 80, label: 'CALM' }, { max: 120, label: 'NORMAL' }, { max: 150, label: 'ELEVATED' }, { label: 'EXTREME' }],
  ovx:  [{ max: 30, label: 'CALM' }, { max: 50, label: 'NORMAL' }, { max: 80, label: 'ELEVATED' }, { label: 'EXTREME' }],
  vkospi: [{ max: 25, label: 'NORMAL' }, { max: 35, label: 'ELEVATED' }, { max: 50, label: 'HIGH' }, { label: 'EXTREME' }],
});

export function bandOf(value, bands) {
  if (value == null || !bands) return null;
  for (const b of bands) if (b.max == null || value < b.max) return b.label;
  return bands[bands.length - 1]?.label ?? null;
}

// For levels with no era-stable absolute band (e.g. the 30Y yield), classify by percentile itself.
export function percentileBand(pct) {
  if (pct == null) return null;
  return pct >= 90 ? 'ELEVATED' : pct <= 10 ? 'LOW' : 'NORMAL';
}

// One call → { value, pct, window, band }. `byPct` bands off the percentile (yields); otherwise
// off the calibrated absolute bands.
export function benchmark(value, series, { bands = null, window = null, byPct = false } = {}) {
  if (value == null) return null;
  const pct = percentileOf(value, series);
  const band = byPct ? percentileBand(pct) : bandOf(value, bands);
  return { value: +(+value).toFixed(2), pct, window, band };
}
