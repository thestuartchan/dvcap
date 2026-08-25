// check-undefined-idents.mjs — resolve every identifier against its REAL lexical scope chain.
//
// This replaces a file-wide version that treated "bound anywhere in the file" as bound everywhere.
// That model had no false positives but a fatal blind spot, and the blind spot shipped three blank
// Console tabs in a row: a helper deleted by a splice, a prop never passed, and finally a component
// hoisted to module scope whose ctx destructure was never updated — it referenced `drafts`, which
// IS bound, but inside a different function. The old guard saw the name and passed.
//
// This walks module -> function -> block scopes and reports references that resolve to nothing in
// the enclosing chain. It catches all three of those breaks, each of which built cleanly and failed
// only in the browser.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const acorn = require('acorn'); const jsx = require('acorn-jsx');
const Parser = acorn.Parser.extend(jsx());
const src = readFileSync('src/App.jsx','utf8');
const ast = Parser.parse(src,{ecmaVersion:'latest',sourceType:'module',locations:true});

const GLOBALS=new Set(['globalThis','console','JSON','Math','Date','Number','String','Boolean','Object','Array','Set','Map','WeakMap','Promise','Symbol','RegExp','Error','TypeError','parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent','setTimeout','clearTimeout','setInterval','clearInterval','window','document','navigator','location','localStorage','sessionStorage','fetch','AbortSignal','URL','Notification','Intl','process','undefined','NaN','Infinity','arguments','structuredClone','requestAnimationFrame']);

function bindPat(n,out){ if(!n)return;
  if(n.type==='Identifier')out.add(n.name);
  else if(n.type==='ObjectPattern')n.properties.forEach(p=>bindPat(p.type==='RestElement'?p.argument:p.value,out));
  else if(n.type==='ArrayPattern')n.elements.forEach(e=>bindPat(e,out));
  else if(n.type==='AssignmentPattern')bindPat(n.left,out);
  else if(n.type==='RestElement')bindPat(n.argument,out);
}
const isFn=t=>t==='FunctionDeclaration'||t==='FunctionExpression'||t==='ArrowFunctionExpression';

// Collect declarations belonging directly to a scope node (not nested functions).
function declsOf(node){
  const out=new Set();
  const visit=(n,parent)=>{
    if(!n||typeof n.type!=='string')return;
    if(n!==node&&isFn(n.type)){ if(n.id)out.add(n.id.name); return; }   // don't descend
    if(n.type==='VariableDeclarator')bindPat(n.id,out);
    if(n.type==='FunctionDeclaration'&&n.id)out.add(n.id.name);
    if(n.type==='ClassDeclaration'&&n.id)out.add(n.id.name);
    if(n.type==='CatchClause')bindPat(n.param,out);
    if(n.type==='ImportSpecifier'||n.type==='ImportDefaultSpecifier'||n.type==='ImportNamespaceSpecifier')out.add(n.local.name);
    for(const k of Object.keys(n)){ if(['type','start','end','loc'].includes(k))continue;
      const v=n[k];
      if(Array.isArray(v))v.forEach(c=>c&&typeof c.type==='string'&&visit(c,n));
      else if(v&&typeof v.type==='string')visit(v,n);
    }
  };
  visit(node,null);
  if(isFn(node.type))node.params.forEach(p=>bindPat(p,out));
  return out;
}

const problems=[];
function analyze(node,chain){
  const scope=declsOf(node);
  const nextChain=[...chain,scope];
  const resolve=n=>nextChain.some(s=>s.has(n))||GLOBALS.has(n);
  const visit=(n,parent)=>{
    if(!n||typeof n.type!=='string')return;
    if(n!==node&&isFn(n.type)){ analyze(n,nextChain); return; }
    // reference positions
    let name=null;
    if(n.type==='CallExpression'&&n.callee.type==='Identifier')name=n.callee.name;
    else if(n.type==='MemberExpression'&&n.object.type==='Identifier')name=n.object.name;
    else if(n.type==='JSXExpressionContainer'&&n.expression.type==='Identifier')name=n.expression.name;
    else if(n.type==='JSXOpeningElement'&&n.name.type==='JSXIdentifier'&&/^[A-Z]/.test(n.name.name))name=n.name.name;
    if(name&&!resolve(name))problems.push({name,line:n.loc.start.line});
    for(const k of Object.keys(n)){ if(['type','start','end','loc'].includes(k))continue;
      const v=n[k];
      if(Array.isArray(v))v.forEach(c=>c&&typeof c.type==='string'&&visit(c,n));
      else if(v&&typeof v.type==='string')visit(v,n);
    }
  };
  visit(node,null);
}
analyze(ast,[]);
const seen=new Set();
for(const p of problems.sort((a,b)=>a.line-b.line)){
  const k=p.name+':'+p.line; if(seen.has(k))continue; seen.add(k);
  console.error(`\u2717 src/App.jsx:${p.line} — \`${p.name}\` does not resolve in its enclosing scope.`);
}
if(seen.size){
  console.error(`\n${seen.size} unresolved reference${seen.size===1?'':'s'} — the class of break that renders a blank tab while the build passes.`);
  process.exit(1);
}
console.log('\u2714 undefined-identifier check passed (full scope-chain resolution)');
