// check-required-props.mjs — catch a JSX call site that omits a prop the component will DEREFERENCE.
//
// Why: the Console rendered blank twice from this one mistake. Most recently <NumCommit dk="equity">
// was rendered without its `drafts` store, so `drafts[dk]` threw "Cannot read properties of
// undefined (reading 'equity')". The build passed, the undefined-identifier guard passed (the name
// IS bound — as a parameter), and the failure only appeared in the browser.
//
// JavaScript has no notion of a "required" prop, so a destructured parameter without a default is
// not automatically required — `title` may legitimately be undefined. The check is therefore
// narrowed to props that are used in a way that THROWS when undefined:
//   • member access — drafts[dk], ctx.foo
//   • called as a function — setDraft(...)
// A prop with a default is never required. An element using spread ({...props}) is skipped, since
// what it carries cannot be known statically.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const acorn = require('acorn');
const jsx = require('acorn-jsx');
const Parser = acorn.Parser.extend(jsx());
const FILES = ['src/App.jsx'];

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, visit, node); }
    else if (v && typeof v.type === 'string') walk(v, visit, node);
  }
}

let bad = 0;
for (const file of FILES) {
  const src = readFileSync(file, 'utf8');
  const ast = Parser.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });

  // Module-scope components: const Name = ({ ...destructured }) => ..., Name starting uppercase.
  const comps = new Map();
  for (const n of ast.body) {
    if (n.type !== 'VariableDeclaration') continue;
    for (const d of n.declarations) {
      if (d.id?.type !== 'Identifier' || !/^[A-Z]/.test(d.id.name)) continue;
      const fn = d.init;
      if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')) continue;
      const param = fn.params[0];
      if (param?.type !== 'ObjectPattern') continue;
      const noDefault = new Set();
      for (const p of param.properties) {
        if (p.type !== 'Property') continue;
        if (p.value.type === 'AssignmentPattern') continue;      // has a default → optional
        if (p.value.type === 'Identifier') noDefault.add(p.value.name);
      }
      // Of those, keep only the ones dereferenced in the body — undefined there is a crash.
      const deref = new Set();
      walk(fn.body, (x) => {
        if (x.type === 'MemberExpression' && x.object.type === 'Identifier' && noDefault.has(x.object.name)) deref.add(x.object.name);
        if (x.type === 'CallExpression' && x.callee.type === 'Identifier' && noDefault.has(x.callee.name)) deref.add(x.callee.name);
      });
      if (deref.size) comps.set(d.id.name, deref);
    }
  }

  walk(ast, (n) => {
    if (n.type !== 'JSXOpeningElement' || n.name.type !== 'JSXIdentifier') return;
    const req = comps.get(n.name.name);
    if (!req) return;
    if (n.attributes.some(a => a.type === 'JSXSpreadAttribute')) return;   // unknowable statically
    const given = new Set(n.attributes.filter(a => a.type === 'JSXAttribute').map(a => a.name.name));
    for (const p of req) {
      if (given.has(p)) continue;
      console.error(`✗ ${file}:${n.loc.start.line} — <${n.name.name}> is missing \`${p}\`, which it dereferences. This throws at render.`);
      bad++;
    }
  });
}

if (bad) {
  console.error(`\n${bad} missing required prop${bad === 1 ? '' : 's'} — the class of break that renders a blank tab while the build passes.`);
  process.exit(1);
}
console.log('✔ required-prop check passed (every dereferenced prop is supplied at each call site)');
