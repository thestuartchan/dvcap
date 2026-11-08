// test/routeDispatch.test.mjs — routes grouped by domain behind one function each (lib/routes/dispatch.js).
// The map, the rewrites in vercel.json and the dispatchers in api/ must agree, or an old URL 404s.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { ROUTES, dispatch } from '../lib/routes/dispatch.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
const rewrite = (src) => vercel.rewrites.find(r => r.source === src)?.destination ?? null;
for (const [route, fn] of Object.entries(ROUTES)) {
  eq(`/api/${route} rewrites to /api/${fn}`, rewrite(`/api/${route}`), `/api/${fn}?route=${route}`);
  eq(`${route}: its module is in lib/routes/`, existsSync(`lib/routes/${route}.js`), true);
  eq(`${route}: no api/${route}.js left to shadow the rewrite`, existsSync(`api/${route}.js`), false);
  const d = readFileSync(`api/${fn}.js`, 'utf8');
  eq(`${route}: api/${fn}.js imports it`, d.includes(`'../lib/routes/${route}.js'`), true);
}
const handlers = readdirSync('lib/routes').filter(f => f.endsWith('.js') && f !== 'dispatch.js').map(f => f.replace(/\.js$/, '')).sort();
eq('every module in lib/routes/ is a mapped route', handlers, Object.keys(ROUTES).sort());
eq('every function config names a file that exists', Object.keys(vercel.functions).filter(f => !existsSync(f)), []);

// The dispatcher itself.
const res = () => { const r = { code: 200, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
{
  let seen = null;
  const h = dispatch('demo', { one: (req) => { seen = { ...req.query }; return 'ran'; } });
  const out = await h({ query: { route: 'one', symbol: 'FAKE' } }, res());
  eq('a known route runs its handler', out, 'ran');
  eq('and the handler sees the query without `route`', seen, { symbol: 'FAKE' });
  const r = res(); await h({ query: { symbol: 'FAKE' } }, r);
  eq('no route is a 404 naming the routes', [r.code, r.body.routes], [404, ['/api/one']]);
  const r2 = res(); await h({ query: { route: 'toString' } }, r2);
  eq('an inherited property name is not a route', r2.code, 404);
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
