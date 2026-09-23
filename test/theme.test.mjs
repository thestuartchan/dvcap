// test/theme.test.mjs — the theme tokens (panel brief, console rework, Step 1).
//
// Three things the brief makes checkable: the SOFT palette carries the brief's values, the LIGHT
// palette is the old dashboard byte for byte (so "toggle back to Light" changes nothing), and no
// palette but Light has a pure white or black in it. Plus the mechanics: every token names a
// variable every palette defines, the status states resolve to the semantic tokens, and the two
// ramps that used to parse a hex now produce a color-mix() the browser can evaluate.
import { readFileSync } from 'fs';
import { C, P, alpha, tint, THEMES, DEFAULT_THEME, THEME_KEY } from '../lib/tokens.js';
import { STATUS, STATUS_HEXES } from '../lib/status.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const palettes = {};
for (const m of css.matchAll(/:root(?:,\s*:root\[data-theme="(\w+)"\]|\[data-theme="(\w+)"\])\s*\{([\s\S]*?)\}/g)) {
  palettes[m[1] || m[2]] = Object.fromEntries([...m[3].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(x => [x[1], x[2].trim().toUpperCase()]));
}
const varOf = (token) => token.match(/^var\((--[\w-]+)\)$/)?.[1];

// ── THE SOFT PALETTE IS THE BRIEF'S ─────────────────────────────────────────
{
  const brief = {
    '--bg-app': '#F3F4F6', '--bg-surface': '#FAFAFA', '--bg-inset': '#F0F1F3', '--border': '#E3E5E8',
    '--text-primary': '#1F2937', '--text-secondary': '#5B6472', '--text-muted': '#8A93A0',
    '--accent': '#2F4FB3', '--pos': '#2E7D5B', '--neg': '#7A4FB0', '--warn': '#B7791F', '--danger': '#B3423D',
    '--pos-bg': '#E7F2EC', '--neg-bg': '#EDE7F5',
  };
  for (const [k, v] of Object.entries(brief)) eq(`soft ${k} is the brief's ${v}`, palettes.soft[k], v);
  ok('soft is the default: the :root block IS the soft block', /:root,\s*:root\[data-theme="soft"\]/.test(css));
  eq('and the code agrees on the default', DEFAULT_THEME, 'soft');
  eq('the three themes, in the order the toggle shows them', THEMES, ['light', 'soft', 'dark']);
  ok('the storage key is versioned like the others', /_v\d+$/.test(THEME_KEY));
}

// ── THE LIGHT PALETTE IS THE OLD DASHBOARD, BYTE FOR BYTE ───────────────────
// These are the values src/theme.js and lib/status.js carried before the tokens, transcribed
// here rather than read from git so a later "tidy" of the light palette fails loudly.
{
  const before = {
    bg: '#F2F3F7', surf: '#FFFFFF', bdr: '#E4E7F0', bdrMd: '#C9D0E4',
    text: '#1C1F2E', mid: '#4B5068', muted: '#7C82A0', lbl: '#9CA3C0',
    green: '#166534', gBg: '#F0FDF4', gBdr: '#86EFAC',
    amber: '#92400E', aBg: '#FFFBEB', aBdr: '#FCD34D',
    red: '#991B1B', rBg: '#FEF2F2', rBdr: '#FCA5A5',
    purple: '#6B21A8', pBg: '#FAF5FF', pBdr: '#D8B4FE',
    blue: '#1E40AF', blBg: '#EFF6FF', blBdr: '#BFDBFE',
    // lib/status.js ELEVATED, and the whites the components wrote by hand
    orange: '#C2410C', oBg: '#FFF7ED', oBdr: '#FDBA74', onFill: '#FFFFFF', onHero: '#FFFFFF', inset: '#F9FAFB',
    // the signal card's gradients
    heroDanger1: '#991B1B', heroDanger2: '#B91C1C', heroAlert1: '#92400E', heroAlert2: '#B45309',
    heroWatch1: '#334155', heroWatch2: '#1E293B', heroNeutral1: '#166534', heroNeutral2: '#15803D',
    heroContested1: '#4B5068', heroContested2: '#2F3444',
  };
  for (const [k, v] of Object.entries(before)) eq(`light C.${k} is still ${v}`, palettes.light[varOf(C[k])], v);
  // A sample of the identity palette: the fund and chart colours the tabs carried as literals.
  const identity = { amber700: '#B45309', emerald700: '#047857', blue700: '#1D4ED8', violet600: '#7C3AED', teal700: '#0F766E', bitcoin: '#F7931A', orange200: '#FED7AA', gray500: '#6B7280', red600: '#DC2626', green500: '#22C55E' };
  for (const [k, v] of Object.entries(identity)) eq(`light P.${k} is still ${v}`, palettes.light[varOf(P[k])], v);
}

// ── EVERY TOKEN, EVERY PALETTE; NO PURE WHITE OR BLACK OFF LIGHT ────────────
{
  const all = { ...C, ...P };
  for (const t of THEMES) {
    const missing = Object.entries(all).filter(([, v]) => !palettes[t]?.[varOf(v)]).map(([k]) => k);
    eq(`${t} defines every token`, missing, []);
    if (t !== 'light') {
      const pure = Object.entries(palettes[t]).filter(([, v]) => /^#(FFF(FFF)?|000(000)?)$/.test(v)).map(([k]) => k);
      eq(`${t} has no pure white or black`, pure, []);
    }
  }
  ok('every token is a var() reference, never a colour', Object.values(all).every(v => /^var\(--[\w-]+\)$/.test(v)));
  eq('the semantic and identity names do not collide', Object.keys(C).filter(k => k in P), []);
  ok('dark opts the browser chrome in too', /data-theme="dark"\][\s\S]*?color-scheme:\s*dark/.test(css));
}

// ── DARK IS DARK, SOFT IS SOFTER ────────────────────────────────────────────
{
  const lum = (hex) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  ok('dark ground is dark', lum(palettes.dark['--bg-app']) < 0.1);
  ok('dark text is light', lum(palettes.dark['--text-primary']) > 0.7);
  ok('dark surfaces sit above the ground', lum(palettes.dark['--bg-surface']) > lum(palettes.dark['--bg-app']));
  ok('soft surfaces sit above the ground too', lum(palettes.soft['--bg-surface']) > lum(palettes.soft['--bg-app']));
  ok('soft ground is no longer white', palettes.soft['--bg-app'] !== '#FFFFFF' && palettes.soft['--bg-surface'] !== '#FFFFFF');
  // "Lower the contrast one notch": the soft text is lighter than the old near-black.
  ok('soft primary text is lighter than the old', lum(palettes.soft['--text-primary']) > lum(palettes.light['--text-primary']));
  // And status hues stay in their hue: green stays green, purple stays purple, on every palette.
  const hue = (hex) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min; if (!d) return 0; let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return h * 60; };
  for (const t of THEMES) {
    const hp = hue(palettes[t]['--pos']), hn = hue(palettes[t]['--neg']);
    ok(`${t} pos is a green (hue ${hp.toFixed(0)})`, hp > 90 && hp < 180);
    ok(`${t} neg is a purple (hue ${hn.toFixed(0)})`, hn > 240 && hn < 300);
  }
}

// ── THE STATUS STATES RESOLVE TO THE SEMANTIC TOKENS ────────────────────────
{
  eq('BENIGN is pos', [STATUS.BENIGN.color, STATUS.BENIGN.bg, STATUS.BENIGN.bdr], [C.green, C.gBg, C.gBdr]);
  eq('WATCH is warn', [STATUS.WATCH.color, STATUS.WATCH.bg, STATUS.WATCH.bdr], [C.amber, C.aBg, C.aBdr]);
  eq('ELEVATED is elevated', [STATUS.ELEVATED.color, STATUS.ELEVATED.bg, STATUS.ELEVATED.bdr], [C.orange, C.oBg, C.oBdr]);
  eq('DANGER is danger', [STATUS.DANGER.color, STATUS.DANGER.bg, STATUS.DANGER.bdr], [C.red, C.rBg, C.rBdr]);
  eq('the allow-list is twelve token strings', STATUS_HEXES.length, 12);
  ok('and none of them is a hex', STATUS_HEXES.every(v => v.startsWith('var(')));
}

// ── THE RAMPS ───────────────────────────────────────────────────────────────
// A token cannot be parsed, so the alpha ramps are built by the browser. Both entry points
// accept a fraction or the old two-hex-digit suffix, and say the same thing either way.
{
  eq('alpha at a fraction', alpha(C.blue, 0.5), 'color-mix(in srgb, var(--accent) 50%, transparent)');
  eq('alpha at the old suffix', alpha(C.blue, 0x80), 'color-mix(in srgb, var(--accent) 50%, transparent)');
  eq('the faintest pill tint', alpha(C.green, 0x0D), 'color-mix(in srgb, var(--pos) 5%, transparent)');
  eq('a full cell is the token itself', tint(C.purple, 1), 'color-mix(in srgb, var(--neg) 100%, transparent)');
  eq('tint and alpha are the same function', tint, alpha);
  ok('an identity colour can be tinted too', alpha(P.bitcoin, 0x20).includes('var(--c-bitcoin) 13%'));
}

// ── THE FIRST PAINT ─────────────────────────────────────────────────────────
// index.html applies the stored choice before React mounts, from the same key, accepting only
// the three names. A typo in storage falls through to the default rather than to nothing.
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ok('index.html reads the same key', html.includes(`localStorage.getItem("${THEME_KEY}")`));
  for (const t of THEMES) ok(`and accepts "${t}"`, html.includes(`t === "${t}"`));
  ok('and sets the attribute the palettes key on', html.includes('setAttribute("data-theme", t)'));
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  ok('the header carries the toggle', /<ThemeToggle theme=\{theme\} setTheme=\{setTheme\} \/>/.test(app));
  ok('the default theme carries no attribute, so the :root block applies', /theme === DEFAULT_THEME\) document\.documentElement\.removeAttribute\("data-theme"\)/.test(app));
  ok('and the choice is persisted under the key', app.includes('localStorage.setItem(THEME_KEY, t)'));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
