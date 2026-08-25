// check-undefined-idents.mjs — catch identifiers that are DEFINED NOWHERE.
//
// Why this exists: a refactor spliced a block out of src/App.jsx and took three helper definitions
// with it (INSURANCE_TICKERS, reEsc, regimeFitFor). The remaining code still called them. Every
// other guard passed and vite built cleanly — an undefined free variable is perfectly valid
// JavaScript until it is evaluated — so the break surfaced only as a blank tab in the browser.
//
// Uses a REAL PARSER (acorn + acorn-jsx, already present via the vite toolchain). A regex-based
// version was tried twice and abandoned: prose inside nested template literals parsed as code, and
// the regex-literal-versus-division heuristic mangles JSX self-closing tags. Neither is fixable
// without a parser, and a guard with false positives gets disabled, which is worse than no guard.
//
// Scope model is deliberately FILE-WIDE: a name bound anywhere in the file counts as bound
// everywhere. That gives up shadowing and TDZ errors in exchange for zero false positives from
// ordinary locals — and it still catches the case that actually broke: a name bound nowhere at all.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const acorn = require('acorn');
const jsx = require('acorn-jsx');

const FILES = ['src/App.jsx'];
const Parser = acorn.Parser.extend(jsx());

// Legitimately free identifiers: language builtins and browser globals.
const KNOWN = new Set([
  'globalThis','console','JSON','Math','Date','Number','String','Boolean','Object','Array','Set','Map',
  'WeakMap','WeakSet','Promise','Symbol','BigInt','RegExp','Error','TypeError','RangeError','Proxy','Reflect',
  'parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent','encodeURI','decodeURI',
  'setTimeout','clearTimeout','setInterval','clearInterval','queueMicrotask','structuredClone','undefined',
  'window','document','navigator','location','history','localStorage','sessionStorage','fetch','Headers',
  'Request','Response','AbortController','AbortSignal','URL','URLSearchParams','Notification','Intl',
  'FormData','Blob','File','FileReader','IntersectionObserver','ResizeObserver','MutationObserver',
  'CustomEvent','Event','Image','Audio','performance','crypto','alert','confirm','prompt','matchMedia',
  'getComputedStyle','requestAnimationFrame','cancelAnimationFrame','process','NaN','Infinity','arguments',
]);

// Every name a pattern binds (handles destructuring, defaults, rest).
function bindPattern(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier': out.add(node.name); break;
    case 'ObjectPattern': for (const p of node.properties) bindPattern(p.type === 'RestElement' ? p.argument : p.value, out); break;
    case 'ArrayPattern': for (const e of node.elements) bindPattern(e, out); break;
    case 'AssignmentPattern': bindPattern(node.left, out); break;
    case 'RestElement': bindPattern(node.argument, out); break;
  }
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, visit); }
    else if (v && typeof v.type === 'string') walk(v, visit);
  }
}

let bad = 0;
for (const file of FILES) {
  const src = readFileSync(file, 'utf8');
  const ast = Parser.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });

  const bound = new Set();
  const uses = new Map();   // name -> first line

  walk(ast, (n) => {
    // ── bindings ──
    if (n.type === 'VariableDeclarator') bindPattern(n.id, bound);
    else if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') { if (n.id) bound.add(n.id.name); }
    else if (n.type === 'CatchClause') bindPattern(n.param, bound);
    else if (n.type === 'ImportDefaultSpecifier' || n.type === 'ImportNamespaceSpecifier') bound.add(n.local.name);
    else if (n.type === 'ImportSpecifier') bound.add(n.local.name);
    if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') {
      if (n.id) bound.add(n.id.name);
      for (const p of n.params) bindPattern(p, bound);
    }

    // ── uses ── only in positions where the identifier is genuinely a variable reference
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier') {
      if (!uses.has(n.callee.name)) uses.set(n.callee.name, n.callee.loc.start.line);
    }
    if (n.type === 'NewExpression' && n.callee.type === 'Identifier') {
      if (!uses.has(n.callee.name)) uses.set(n.callee.name, n.callee.loc.start.line);
    }
    // JSX element names: <Foo/> — lowercase names are intrinsic HTML tags, not variables.
    if (n.type === 'JSXOpeningElement' && n.name.type === 'JSXIdentifier' && /^[A-Z]/.test(n.name.name)) {
      if (!uses.has(n.name.name)) uses.set(n.name.name, n.name.loc.start.line);
    }
    // Spread of a bare identifier: {...foo}
    if (n.type === 'SpreadElement' && n.argument.type === 'Identifier') {
      if (!uses.has(n.argument.name)) uses.set(n.argument.name, n.argument.loc.start.line);
    }
    // Member access on a bare identifier: foo.bar / foo[bar]. This is how the deleted
    // INSURANCE_TICKERS map was referenced, and reading a property of an unbound name throws
    // exactly like calling one. Only the OBJECT is a variable reference; the property is not.
    if (n.type === 'MemberExpression' && n.object.type === 'Identifier') {
      if (!uses.has(n.object.name)) uses.set(n.object.name, n.object.loc.start.line);
    }
  });

  for (const [name, line] of [...uses].sort((a, b) => a[1] - b[1])) {
    if (bound.has(name) || KNOWN.has(name)) continue;
    console.error(`✗ ${file}:${line} — \`${name}\` is used but bound nowhere in the file and is not a known global.`);
    bad++;
  }
}

if (bad) {
  console.error(`\n${bad} undefined identifier${bad === 1 ? '' : 's'} — the class of break that renders a blank tab while the build passes.`);
  process.exit(1);
}
console.log('✔ undefined-identifier check passed (parsed; every called name is bound or a known global)');
