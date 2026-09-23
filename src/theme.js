// src/theme.js — the palette, and nothing else.
//
// It lived in ui.jsx beside the shared components, which tripped react-refresh: a module that
// exports both components and plain values cannot be hot-reloaded reliably, so every edit to a
// colour forced a full remount and lost whatever state the page was holding.
//
// The names now live in lib/tokens.js (the server-side modules that carry colours import them
// from there) and the values in src/index.css, one block per theme. This module is the browser's
// door to both: C for the semantic tokens, P for the identity palette, alpha()/tint() for the
// ramps that used to be built by hand from a hex.
export { C, P, alpha, tint, THEMES, DEFAULT_THEME, THEME_KEY } from '../lib/tokens.js';
