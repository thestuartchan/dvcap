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
const FILES = ['src/App.jsx', 'src/TradeConsole.jsx', 'src/ui.jsx'];

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

// ── COMPONENTS THAT DO NOT TAKE CHILDREN ─────────────────────────────────────
// A second silent failure, from the same family and caught by none of the checks above.
//
// <Btn onClick={look} disabled={!ready}>{busy ? "…" : "Size it"}</Btn> — ui.jsx's Btn renders
// `{label}` and never touches `children`, so that button shipped with NO TEXT ON IT. It is not a
// crash, nothing throws, the build passes and the undefined-prop check is right not to fire: an
// absent `label` renders nothing, which is legal. The position sizer went out with an unlabelled,
// colourless button nobody could see, and stayed that way until a screenshot arrived.
//
// Statically decidable: if a component's props pattern has no `children` and no rest element, any
// element written with non-whitespace children is throwing that content away.
function childlessComponents(ast) {
  const out = new Map();   // name → line, for components that ignore children
  const consider = (name, fn) => {
    if (!/^[A-Z]/.test(name || '') || !fn) return;
    const param = fn.params[0];
    // NO PARAMS AT ALL still cannot render children.
    if (param && param.type !== 'ObjectPattern') return;         // `props` — unknowable, skip
    if (param) {
      for (const pr of param.properties) {
        if (pr.type === 'RestElement') return;                   // {...rest} may forward children
        if (pr.type === 'Property' && (pr.key?.name === 'children' || pr.value?.name === 'children')) return;
      }
    }
    out.set(name, fn.loc?.start.line ?? 0);
  };
  for (const n of ast.body) {
    if (n.type === 'FunctionDeclaration') consider(n.id?.name, n);
    if (n.type === 'ExportNamedDeclaration' && n.declaration?.type === 'FunctionDeclaration') {
      consider(n.declaration.id?.name, n.declaration);
    }
    const decls = n.type === 'VariableDeclaration' ? n
                : (n.type === 'ExportNamedDeclaration' && n.declaration?.type === 'VariableDeclaration') ? n.declaration : null;
    for (const d of decls?.declarations || []) {
      if (d.id?.type !== 'Identifier') continue;
      const fn = d.init;
      if (fn?.type === 'ArrowFunctionExpression' || fn?.type === 'FunctionExpression') consider(d.id.name, fn);
    }
  }
  return out;
}

// A child that is only whitespace or a comment carries nothing and is not a mistake.
const carriesContent = (c) =>
  (c.type === 'JSXText' && c.value.trim() !== '')
  || c.type === 'JSXElement' || c.type === 'JSXFragment'
  || (c.type === 'JSXExpressionContainer' && c.expression.type !== 'JSXEmptyExpression');

let bad = 0;
// Components are collected across ALL the files first, because the one that started this is
// defined in ui.jsx and called in TradeConsole.jsx — a per-file pass could never have seen it.
const childless = new Map();
for (const file of FILES) {
  const ast = Parser.parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  for (const [name, line] of childlessComponents(ast)) childless.set(name, { file, line });
}

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
    if (n.type === 'JSXElement' && n.openingElement.name.type === 'JSXIdentifier') {
      const name = n.openingElement.name.name;
      const def = childless.get(name);
      if (def && n.children.some(carriesContent)) {
        console.error(`✗ ${file}:${n.loc.start.line} — <${name}> is given children, but ${def.file}:${def.line} never renders them. They are dropped silently.`);
        bad++;
      }
    }
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
  console.error(`\n${bad} problem${bad === 1 ? '' : 's'} — the class of break that renders a blank tab, or an invisible button, while the build passes.`);
  process.exit(1);
}
console.log(`✔ required-prop check passed (every dereferenced prop is supplied at each call site; ${childless.size} childless components checked for dropped children)`);
