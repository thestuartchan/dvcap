// lib/tokens.js — the colour vocabulary, as names. The values live in src/index.css.
//
// A component never names a hex. It names a token — C.green, P.amber700 — and the token is a CSS
// custom property that <html data-theme> resolves to one of three palettes (light, soft, dark).
// That is the whole mechanism: the palette is swapped by changing one attribute, and nothing in
// the tree re-renders for it. The cost is that a token is no longer a colour the JavaScript can
// read — nothing can parse "var(--pos)" into an rgb triple — so the two places that used to
// derive an alpha ramp from a hex (the GEX heat cells, the "+ '18'" pill tints) go through
// alpha() and tint() below, which lean on color-mix() and stay inside CSS.
//
// This file is isomorphic on purpose: lib/status.js, lib/regimes.js and lib/assets.js carry the
// colours of their states and funds, and they are imported by the server too. A var() string is
// as harmless there as a hex was; nothing on the server ever drew with either.

// ── SEMANTIC ─────────────────────────────────────────────────────────────────
// Surfaces, text, the five status hues (accent, pos, neg, warn, elevated, danger) with their
// tinted background and border, and the hero-card gradients. The names match the panel brief.
export const C = Object.freeze({
  bg: 'var(--bg-app)',
  surf: 'var(--bg-surface)',
  inset: 'var(--bg-inset)',
  bdr: 'var(--border)',
  bdrMd: 'var(--border-strong)',
  text: 'var(--text-primary)',
  mid: 'var(--text-secondary)',
  muted: 'var(--text-muted)',
  lbl: 'var(--text-label)',
  onFill: 'var(--on-fill)',
  blue: 'var(--accent)',
  blBg: 'var(--accent-bg)',
  blBdr: 'var(--accent-bdr)',
  green: 'var(--pos)',
  gBg: 'var(--pos-bg)',
  gBdr: 'var(--pos-bdr)',
  purple: 'var(--neg)',
  pBg: 'var(--neg-bg)',
  pBdr: 'var(--neg-bdr)',
  amber: 'var(--warn)',
  aBg: 'var(--warn-bg)',
  aBdr: 'var(--warn-bdr)',
  orange: 'var(--elevated)',
  oBg: 'var(--elevated-bg)',
  oBdr: 'var(--elevated-bdr)',
  red: 'var(--danger)',
  rBg: 'var(--danger-bg)',
  rBdr: 'var(--danger-bdr)',
  heroDanger1: 'var(--hero-danger-1)',
  heroDanger2: 'var(--hero-danger-2)',
  heroAlert1: 'var(--hero-alert-1)',
  heroAlert2: 'var(--hero-alert-2)',
  heroWatch1: 'var(--hero-watch-1)',
  heroWatch2: 'var(--hero-watch-2)',
  heroNeutral1: 'var(--hero-neutral-1)',
  heroNeutral2: 'var(--hero-neutral-2)',
  heroContested1: 'var(--hero-contested-1)',
  heroContested2: 'var(--hero-contested-2)',
  onHero: 'var(--on-hero)',
  metricBg: 'var(--bg-metric)',
  metricBdr: 'var(--border-metric)',
});

// ── IDENTITY ─────────────────────────────────────────────────────────────────
// Fund colours, chart series, category pills, regime hues: colour used to tell things APART, not
// to say how bad they are. Named after the palette shade they were transcribed from, so the light
// theme reproduces the old dashboard exactly and the other two derive from it by one rule.
export const P = Object.freeze({
  emerald700: 'var(--c-emerald-700)',
  cyan600: 'var(--c-cyan-600)',
  cyan700: 'var(--c-cyan-700)',
  sky500: 'var(--c-sky-500)',
  navy700: 'var(--c-navy-700)',
  teal700: 'var(--c-teal-700)',
  green700: 'var(--c-green-700)',
  green600: 'var(--c-green-600)',
  blue700: 'var(--c-blue-700)',
  slate800: 'var(--c-slate-800)',
  green500: 'var(--c-green-500)',
  blue600: 'var(--c-blue-600)',
  slate850: 'var(--c-slate-850)',
  slate700: 'var(--c-slate-700)',
  gray700: 'var(--c-gray-700)',
  blue500: 'var(--c-blue-500)',
  indigo700: 'var(--c-indigo-700)',
  slate600: 'var(--c-slate-600)',
  indigo600: 'var(--c-indigo-600)',
  grey555: 'var(--c-grey-555)',
  violet800: 'var(--c-violet-800)',
  teal300: 'var(--c-teal-300)',
  indigo500: 'var(--c-indigo-500)',
  gray500: 'var(--c-gray-500)',
  violet700: 'var(--c-violet-700)',
  emerald300: 'var(--c-emerald-300)',
  orange900: 'var(--c-orange-900)',
  violet600: 'var(--c-violet-600)',
  red900: 'var(--c-red-900)',
  grey888: 'var(--c-grey-888)',
  violet500: 'var(--c-violet-500)',
  grey999: 'var(--c-grey-999)',
  yellow700: 'var(--c-yellow-700)',
  emerald200: 'var(--c-emerald-200)',
  amber700: 'var(--c-amber-700)',
  red700: 'var(--c-red-700)',
  green200: 'var(--c-green-200)',
  rose700: 'var(--c-rose-700)',
  pink700: 'var(--c-pink-700)',
  violet300: 'var(--c-violet-300)',
  amber600: 'var(--c-amber-600)',
  red600: 'var(--c-red-600)',
  green100: 'var(--c-green-100)',
  gray200: 'var(--c-gray-200)',
  yellow500: 'var(--c-yellow-500)',
  emerald50: 'var(--c-emerald-50)',
  red500: 'var(--c-red-500)',
  teal50: 'var(--c-teal-50)',
  amber500: 'var(--c-amber-500)',
  violet50: 'var(--c-violet-50)',
  bitcoin: 'var(--c-bitcoin)',
  orange500: 'var(--c-orange-500)',
  amber200: 'var(--c-amber-200)',
  red200: 'var(--c-red-200)',
  rose200: 'var(--c-rose-200)',
  orange200: 'var(--c-orange-200)',
  yellow50: 'var(--c-yellow-50)',
  mOrange200: 'var(--c-m-orange-200)',
  mOrange100: 'var(--c-m-orange-100)',
  rose50: 'var(--c-rose-50)',
  mOrange50: 'var(--c-m-orange-50)',
  bitcoinBg: 'var(--c-bitcoin-bg)',

});

// A colour at partial opacity, for pill tints and rings. `a` is 0–1, or the old two-hex-digit
// suffix as a number (0x18) — both read as "this much of the colour over whatever is beneath".
export const alpha = (color, a) => `color-mix(in srgb, ${color} ${Math.round((a > 1 ? a / 255 : a) * 100)}%, transparent)`;
// The same thing named for the heat cells, where the alpha IS the value.
export const tint = alpha;

// Which theme names are real. "soft" is the default; "light" is the palette the dashboard had
// before the tokens; "dark" is the same tokens on a dark ground.
export const THEMES = Object.freeze(['light', 'soft', 'dark']);
export const DEFAULT_THEME = 'soft';
export const THEME_KEY = 'theme_v1';
