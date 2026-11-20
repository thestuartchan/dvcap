// lib/regimeNames.js — the ONE set of names for the four growth × inflation regimes.
//
// Every surface that names a regime reads it from here: the measured regime (lib/marketState.js),
// the measured quadrant (lib/quadrant.js), the Street's consensus table (lib/regimes.js), the
// sizing table (lib/sizing.js) and the one-day price-action read (lib/regimeState.js). Before
// 20 Nov 2026 each carried its own copy, and the names did not match the usual convention:
// "Reflationary growth" was used for growth firm + inflation cool, which most frameworks call
// Goldilocks, and "Inflationary boom" for growth firm + inflation hot, which most call reflation.
//
// The ids stay as they were (ref / inf / stag / def): the regime log, Redis rows and the sizing
// keys are stored by id, so renaming the labels changes no stored data.
//
//   id    growth   inflation   name
//   ref   firm     cool        Goldilocks
//   inf   firm     hot         Reflation
//   stag  weak     hot         Stagflation
//   def   weak     cool        Deflation
export const REGIME_NAMES = Object.freeze({
  ref:  Object.freeze({ id: 'ref',  label: 'Goldilocks',  read: 'growth firm, inflation cool' }),
  inf:  Object.freeze({ id: 'inf',  label: 'Reflation',   read: 'growth firm, inflation hot' }),
  stag: Object.freeze({ id: 'stag', label: 'Stagflation', read: 'growth weakening, inflation hot' }),
  def:  Object.freeze({ id: 'def',  label: 'Deflation',   read: 'growth weakening, inflation cool' }),
});

export const REGIME_IDS = Object.freeze(['ref', 'inf', 'stag', 'def']);
export const regimeName = (id) => REGIME_NAMES[id]?.label ?? null;
