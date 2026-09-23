// check-theme-tokens.mjs — the theme's build gate (panel brief, console rework, Step 1).
//
// "No component references a raw hex." The three palettes live in src/index.css and every
// colour a component draws is a token from lib/tokens.js, so that <html data-theme> can swap the
// whole dashboard between light, soft and dark by changing one attribute. A hex in a component
// is a colour that will not change with the theme: invisible on light, wrong on dark, and found
// by whoever opens that tab at night. This fails the build the moment one appears.
//
// Three checks:
//   1. No hex colour literal in src/**, in the lib/ modules that carry UI colour, or in the
//      stylesheets outside the palette block. A PR number in a comment ("since #140") is not
//      a colour: comments are stripped first, and a hex has to sit inside a string or a CSS value.
//   2. Every var(--x) that lib/tokens.js names is defined in ALL THREE palettes, and every
//      --x the palettes define is named by a token (nothing orphaned either way).
//   3. No palette value is pure white or black, except the light palette, which is the old
//      dashboard byte for byte and is allowed to be what it was.
import { readFileSync, readdirSync } from 'fs';
import { join, extname } from 'path';
import { C, P } from '../lib/tokens.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const rel = (f) => f.slice(ROOT.length);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (['.js', '.jsx', '.css'].includes(extname(e.name))) out.push(p);
  }
  return out;
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/.*$/gm, '$1');

const violations = [];

// 1. Hex literals.
const UI_LIB = ['assets.js', 'regimes.js', 'regimeState.js', 'status.js', 'tokens.js'];
const files = walk(join(ROOT, 'src')).concat(walk(join(ROOT, 'lib')).filter(f => UI_LIB.some(n => f.endsWith('/' + n))));
const HEX = /#[0-9A-Fa-f]{3,8}\b/g;
for (const file of files) {
  let src = readFileSync(file, 'utf8');
  if (file.endsWith('index.css')) {
    // The palette block is where the hexes are SUPPOSED to be. Everything after it is not.
    const end = src.indexOf('/* ── Reset');
    src = end > 0 ? src.slice(end) : src;
  }
  stripComments(src).split('\n').forEach((line, i) => {
    for (const m of line.matchAll(HEX)) {
      const inString = file.endsWith('.css') || /["'`]/.test(line.slice(0, m.index)) ;
      if (!inString) continue;
      violations.push(`${rel(file)}:${i + 1}  raw hex ${m[0]} — name a token from lib/tokens.js (C.* semantic, P.* identity)`);
    }
  });
}

// 2. Tokens ↔ palettes.
const css = readFileSync(join(ROOT, 'src/index.css'), 'utf8');
const blocks = {};
for (const m of css.matchAll(/:root(?:,\s*:root\[data-theme="(\w+)"\]|\[data-theme="(\w+)"\])\s*\{([\s\S]*?)\}/g)) {
  const name = m[1] || m[2];
  blocks[name] = new Map([...m[3].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(x => [x[1], x[2].trim()]));
}
for (const t of ['light', 'soft', 'dark']) if (!blocks[t]) violations.push(`src/index.css  no palette block for data-theme="${t}"`);
const named = new Map();
for (const [k, v] of Object.entries(C)) named.set(v.match(/var\((--[\w-]+)\)/)[1], 'C.' + k);
for (const [k, v] of Object.entries(P)) named.set(v.match(/var\((--[\w-]+)\)/)[1], 'P.' + k);
for (const [t, vars] of Object.entries(blocks)) {
  for (const [cssVar, name] of named) if (!vars.has(cssVar)) violations.push(`src/index.css  ${name} → ${cssVar} is not defined in the ${t} palette`);
  for (const cssVar of vars.keys()) if (!named.has(cssVar) && cssVar !== 'color-scheme') violations.push(`src/index.css  ${cssVar} in the ${t} palette is named by no token`);
  // 3. No pure white or black outside the light palette.
  if (t !== 'light') for (const [cssVar, v] of vars) if (/^#(fff(fff)?|000(000)?)$/i.test(v)) violations.push(`src/index.css  ${cssVar} is pure ${v} in the ${t} palette`);
}

if (violations.length) {
  console.error(`\n✖ theme-token check FAILED — ${violations.length} violation(s):\n`);
  for (const v of violations) console.error('   ' + v);
  console.error('\n  Colours are tokens (lib/tokens.js) resolved by the palettes in src/index.css. A hex in a component does not change with the theme.\n');
  process.exit(1);
}
console.log(`✔ theme-token check passed (${named.size} tokens × ${Object.keys(blocks).length} palettes; no raw hex in ${files.length} files)`);
