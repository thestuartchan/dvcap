// A component that is DEFINED but never MOUNTED.
//
// WHY THIS EXISTS. FillForm was written, wired into the shared ctx, given a save handler and a
// validation path — and no JSX ever rendered it. Every "Bought" / "Sold" / "record a fill" button
// set state that nothing displayed, so the entire fill-recording flow silently did nothing from the
// day the module was created. Vite built it. Every other guard passed it: an unmounted component is
// not an undefined reference, not a missing prop, and not a bad token. It is a component nobody
// calls, which is invisible to a compiler and obvious to a parser.
//
// The rule: a module-scope function whose name is Capitalised and which returns JSX must appear as
// <Name …> somewhere in the same file, or be exported for another file to mount. Anything else is
// dead UI.
import fs from 'node:fs';
import { Parser } from 'acorn';
import jsx from 'acorn-jsx';

const FILES = ['src/App.jsx', 'src/TradeConsole.jsx', 'src/ui.jsx'];
const P = Parser.extend(jsx());

// Does this function body produce JSX anywhere inside it?
function returnsJsx(node) {
  let found = false;
  (function walk(n) {
    if (found || !n || typeof n !== 'object') return;
    if (n.type === 'JSXElement' || n.type === 'JSXFragment') { found = true; return; }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && v.type) walk(v);
    }
  })(node);
  return found;
}

let bad = 0, checked = 0;
for (const file of FILES) {
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  const ast = P.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });

  const defined = new Map();   // name -> line
  const exported = new Set();
  const mounted = new Set();

  for (const node of ast.body) {
    const decl = node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration' ? node.declaration : node;
    const isExport = node !== decl;
    if (!decl) continue;
    if (decl.type === 'FunctionDeclaration' && decl.id && /^[A-Z]/.test(decl.id.name)) {
      if (returnsJsx(decl.body)) { defined.set(decl.id.name, decl.loc.start.line); if (isExport) exported.add(decl.id.name); }
    }
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id?.type !== 'Identifier' || !/^[A-Z]/.test(d.id.name)) continue;
        const init = d.init;
        if (!init) continue;
        if ((init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') && returnsJsx(init.body)) {
          defined.set(d.id.name, d.loc.start.line);
          if (isExport) exported.add(d.id.name);
        }
      }
    }
  }

  // Every <Name …> in the file, including member forms like <Foo.Bar />.
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'JSXOpeningElement') {
      let name = n.name;
      while (name && name.type === 'JSXMemberExpression') name = name.object;
      if (name?.type === 'JSXIdentifier') mounted.add(name.name);
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && v.type) walk(v);
    }
  })(ast);

  for (const [name, line] of defined) {
    checked++;
    if (mounted.has(name) || exported.has(name)) continue;
    console.error(`✘ ${file}:${line}  <${name}> is defined but never mounted — dead UI, or a render site that was lost in an edit`);
    bad++;
  }
}

if (bad) { console.error(`\n${bad} unmounted component${bad === 1 ? '' : 's'}.`); process.exit(1); }
console.log(`✔ dead-component check passed (${checked} components, all mounted or exported)`);
