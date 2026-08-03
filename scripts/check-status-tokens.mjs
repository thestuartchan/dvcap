// check-status-tokens.mjs — I.5 build gate.
//
// Fails the build if a STATUS colour is hardcoded in a status-rendering context instead of
// coming from the token set in lib/status.js.
//
// SCOPE, stated plainly so this stays honest rather than becoming noise that gets disabled:
// the dashboard uses colour for several vocabularies, and only ONE of them is status.
// Category/identity palettes — fund colours, position markers (● ◐ ✕), chart series, the
// allocation REDUCE/HOLD map — legitimately reuse the same hues and are NOT in scope. This
// check governs the two places the spec actually rules on:
//
//   1. Accent bars  (I.2: a card has a bar iff it carries a status badge, same colour)
//   2. Status triples `color/bg/bdr`  (the badge + interpretation-panel shape)
//
// Anything else would require unifying vocabularies the spec did not ask for, and a check
// that fails for reasons the spec doesn't endorse is a check people delete.

import { readFileSync, readdirSync } from 'fs';
import { join, extname } from 'path';
import { STATUS } from '../lib/status.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const STATUS_HEXES = new Set(
  Object.values(STATUS).flatMap(s => [s.color, s.bg, s.bdr]).map(h => h.toLowerCase())
);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (['.js', '.jsx'].includes(extname(e.name))) out.push(p);
  }
  return out;
}

const violations = [];
for (const file of walk(join(ROOT, 'src')).concat(walk(join(ROOT, 'lib')))) {
  if (file.endsWith('status.js')) continue;            // the token definition itself
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const rel = file.slice(ROOT.length);

    // 1. Accent bars must never carry a raw hex — they must resolve from a token.
    const bar = line.match(/border(?:Left)?:\s*"(\d+)px solid\s+(#[0-9A-Fa-f]{3,6})/);
    if (bar && Number(bar[1]) >= 3) {
      violations.push(`${rel}:${i + 1}  accent bar uses a hardcoded hex ${bar[2]} — use STATUS[...].color`);
    }

    // 2. A status triple must be expressed as a state token, not three hexes.
    const triple = line.match(/color:\s*"(#[0-9A-Fa-f]{6})"\s*,\s*bg:\s*"(#[0-9A-Fa-f]{6})"\s*,\s*bdr:\s*"(#[0-9A-Fa-f]{6})"/);
    if (triple) {
      const [, c, bg, bdr] = triple.map(x => typeof x === 'string' ? x.toLowerCase() : x);
      // Only a triple made of STATUS hexes is a status triple. Identity palettes (blue,
      // purple, teal, bitcoin orange) are a different vocabulary and pass through.
      if (STATUS_HEXES.has(c) && STATUS_HEXES.has(bg) && STATUS_HEXES.has(bdr)) {
        violations.push(`${rel}:${i + 1}  hardcoded status triple ${c}/${bg}/${bdr} — return state:"BENIGN|WATCH|ELEVATED|DANGER" instead`);
      }
    }
  });
}

// 3. The four states must be defined in exactly one place.
const dupes = walk(join(ROOT, 'lib')).concat(walk(join(ROOT, 'src')))
  .filter(f => !f.endsWith('status.js'))
  .filter(f => /BENIGN[\s\S]{0,80}WATCH[\s\S]{0,80}ELEVATED[\s\S]{0,80}DANGER/.test(readFileSync(f, 'utf8')));
for (const d of dupes) violations.push(`${d.slice(ROOT.length)}  re-declares the four status states — import them from lib/status.js`);

if (violations.length) {
  console.error(`\n✖ status-token check FAILED — ${violations.length} violation(s):\n`);
  for (const v of violations) console.error('   ' + v);
  console.error('\n  I.5: status colours come from lib/status.js. Category palettes are exempt by design.\n');
  process.exit(1);
}
console.log(`✔ status-token check passed (${STATUS_HEXES.size} token hexes; accent bars + status triples clean)`);
