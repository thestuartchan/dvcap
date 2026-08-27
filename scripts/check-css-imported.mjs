// A stylesheet nobody imports.
//
// WHY THIS EXISTS. src/App.css held every console animation, the reduced-motion handling, and the
// four responsive rules that cannot be written inline because inline styles beat stylesheet rules.
// It was never imported. Vite does not complain — an unreferenced .css file is simply not part of
// the bundle — so the build passed, the tests passed, all six other guards passed, and the archive
// rendered its desktop table and its mobile card list on top of each other because the rule hiding
// one of them was in a file the browser never loaded.
//
// The rule: every .css file under src/ must be imported by at least one .js/.jsx in the project.
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'src';
const sheets = fs.readdirSync(SRC).filter(f => f.endsWith('.css'));
const code = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (/\.[jt]sx?$/.test(e.name)) code.push(fs.readFileSync(p, 'utf8'));
  }
})(SRC);

let bad = 0;
for (const sheet of sheets) {
  // Matches `import './App.css'` and `import "../src/App.css"` alike.
  const re = new RegExp(`import\\s+['"][^'"]*${sheet.replace('.', '\\.')}['"]`);
  if (code.some(c => re.test(c))) continue;
  console.error(`✘ src/${sheet} is never imported — its rules are not in the bundle and silently do nothing`);
  bad++;
}
if (bad) { console.error(`\n${bad} orphaned stylesheet${bad === 1 ? '' : 's'}.`); process.exit(1); }
console.log(`✔ stylesheet check passed (${sheets.length} sheet${sheets.length === 1 ? '' : 's'}, all imported)`);
