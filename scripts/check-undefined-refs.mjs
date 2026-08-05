// check-undefined-refs.mjs — build gate for identifiers used but never bound.
//
// Why this exists: `vite build` compiles a bare `useMemo(...)` without complaint, because an
// undefined global is only an error at RUNTIME. The result is a ReferenceError thrown during
// render, above the error boundary, which unmounts the entire tree — a blank page from a
// green build. That has now happened twice.
//
// Scope is deliberately narrow: hook-shaped calls (useX) and React named exports. These are
// the ones that get used mid-file, far from the import line, and they fail catastrophically
// rather than locally. A general undefined-identifier checker is a type system's job, and a
// gate that reports maybes is a gate people switch off.

import { readFileSync, readdirSync } from 'fs';
import { join, extname } from 'path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const REACT_EXPORTS = ['Component', 'Fragment', 'createContext', 'forwardRef', 'memo', 'lazy', 'Suspense'];

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
for (const file of walk(join(ROOT, 'src'))) {
  const src = readFileSync(file, 'utf8');
  const rel = file.slice(ROOT.length);

  // Everything bound in this module: imports, declarations, function params of any shape.
  const bound = new Set();
  for (const m of src.matchAll(/import\s+(?:([\w$]+)\s*,\s*)?\{([^}]*)\}\s*from/g)) {
    if (m[1]) bound.add(m[1]);
    for (const part of m[2].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) bound.add(name);
    }
  }
  for (const m of src.matchAll(/import\s+([\w$]+)\s+from/g)) bound.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var|function|class)\s+([\w$]+)/g)) bound.add(m[1]);

  // Hook-shaped calls and React named exports used as JSX or values.
  const used = new Map();
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;             // comments describe, they don't run
    for (const m of line.matchAll(/\b(use[A-Z][\w$]*)\s*\(/g)) {
      if (!used.has(m[1])) used.set(m[1], i + 1);
    }
    for (const name of REACT_EXPORTS) {
      if (new RegExp(`(?:extends|<)\\s*${name}\\b`).test(line) && !used.has(name)) used.set(name, i + 1);
    }
  });

  for (const [name, line] of used) {
    if (!bound.has(name)) {
      violations.push(`${rel}:${line}  '${name}' is used but never imported or declared — this throws at render, not at build`);
    }
  }
}

if (violations.length) {
  console.error(`\n✖ undefined-reference check FAILED — ${violations.length} violation(s):\n`);
  for (const v of violations) console.error('   ' + v);
  console.error('\n  An unbound hook is a blank page, not a console warning. Import it.\n');
  process.exit(1);
}
console.log('✔ undefined-reference check passed (hooks + React exports all bound)');
