// test/gammaMcpRoute.test.mjs — the /api/mcp/<token> route: a wrong token is a 404, tools/list lists two.
//
// Environment-independent on purpose (scripts/check-env-independent.mjs): the token is set here,
// and any store the environment points at is removed, so the route never reaches the network.
for (const k of Object.keys(process.env)) if (/upstash\.io/.test(process.env[k] || '')) delete process.env[k];
const TOKEN = 'test-token-' + 'a'.repeat(40);
process.env.MCP_CONNECTOR_TOKEN = TOKEN;
const { default: handler } = await import('../api/gex.js');

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

function call({ method = 'POST', token, body } = {}) {
  const req = { method, query: { mcp: token }, headers: { 'content-type': 'application/json' }, body };
  return new Promise((resolve) => {
    const res = { code: 200, headers: {}, body: undefined,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.code = c; return this; },
      json(o) { this.body = o; resolve(this); return this; },
      send(s) { this.body = typeof s === 'string' ? JSON.parse(s) : s; resolve(this); return this; },
      end() { resolve(this); return this; } };
    handler(req, res);
  });
}

const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
eq('a wrong token is a 404', (await call({ token: 'b'.repeat(51), body: list })).code, 404);
eq('no token is a 404', (await call({ token: '', body: list })).code, 404);
eq('…even a GET', (await call({ method: 'GET', token: 'nope' })).code, 404);
eq('the right token, GET: 405 (no stream offered)', (await call({ method: 'GET', token: TOKEN })).code, 405);
const r = await call({ token: TOKEN, body: list });
eq('tools/list: 200 and exactly the two tools', [r.code, r.body.result.tools.map(t => t.name)], [200, ['get_gamma_dashboard', 'get_gamma_board']]);
eq('a notification: 202, no body', (await call({ token: TOKEN, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).code, 202);
const batch = await call({ token: TOKEN, body: [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }] });
eq('a batch gets a batch back', batch.body.map(x => x.id), [1, 2]);
const nostore = await call({ token: TOKEN, body: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_gamma_board', arguments: { ticker: 'SPY' } } } });
eq('no store: the tool says so plainly', [nostore.body.result.isError, nostore.body.result.content[0].text], [true, 'board unavailable']);
eq('nothing is cached on the way', r.headers['cache-control'], 'private, no-store');

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
