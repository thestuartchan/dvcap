// test/bookMcp.test.mjs — the book connector for the Position Desk (lib/bookMcp.js, api/tradecard.js serveBookMcp).
// Fake tickers only.
import { positionView, bookView, bookRpc, bookTokenMatches, bookSecretReport, bookRequestShape, BOOK_TOKEN_ENV } from '../lib/bookMcp.js';
import { handleRpc, TOOLS } from '../lib/gammaMcp.js';
import { derivePosition, positionPnl } from '../lib/positions.js';
import { serveBookMcp } from '../api/tradecard.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const TOKEN = 'b'.repeat(40);
const env = { [BOOK_TOKEN_ENV]: TOKEN };
const withSnap = (r, price, extra = {}) => {
  const derived = derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side });
  return { ...r, derived, price, pnl: positionPnl(derived, price), ...extra };
};
const spread = withSnap({
  id: 'zzq-1', symbol: 'zzq', multiplier: 100, side: 'long', currency: 'USD', hardDate: '2026-12-11',
  legs: [{ right: 'C', strike: 50, expiry: '2026-12-18', side: 'long' }, { right: 'C', strike: 60, expiry: '2026-12-18', side: 'short' }],
  fills: [{ date: '2026-10-01', side: 'buy', qty: 2, price: 3 }],
  levels: [{ kind: 'stop', at: 1.5 }, { kind: 'target', at: 55, on: 'underlying' }],
  thesis: 'private thesis', note: 'private note', tags: ['private'],
}, 4.25, { markSource: 'live', markAsOf: '2026-11-05T15:00:00Z', underlyingPx: 57.1, levelHits: ['target ZZQ 55 reached'] });
const shares = withSnap({ id: 'zzs-1', symbol: 'ZZS', multiplier: 1, side: 'long', fills: [{ date: '2026-09-02', side: 'buy', qty: 10, price: 20 }, { date: '2026-09-20', side: 'buy', qty: 10, price: 22 }] }, 25);
const closed = withSnap({ id: 'zzc-1', symbol: 'ZZC', multiplier: 1, fills: [{ date: '2026-08-01', side: 'buy', qty: 5, price: 10 }, { date: '2026-08-09', side: 'sell', qty: 5, price: 12 }] }, 13);
const setup = withSnap({ id: 'zzu-1', symbol: 'ZZU', multiplier: 1, fills: [], levels: [{ kind: 'entry', at: 9 }] }, 9);

// ── WHAT LEAVES ──────────────────────────────────────────────────────────────
{
  const v = positionView(spread);
  eq('a spread: the whitelist and nothing else', Object.keys(v).sort(),
     ['avgCost', 'currency', 'hardDate', 'id', 'instrument', 'legs', 'levelHits', 'levels', 'mark', 'markAsOf', 'markSource', 'marketValue', 'multiplier', 'opened', 'qty', 'side', 'structure', 'symbol', 'underlying', 'unrealized', 'unrealizedPct'].sort());
  const s = JSON.stringify(v);
  ok('no fills, thesis, note or tags', !/private|fills/.test(s));
  eq('it reads as the console reads it', [v.symbol, v.instrument, v.qty, v.avgCost, v.mark, v.markSource, v.underlying], ['ZZQ', 'option spread', 2, 3, 4.25, 'live', 57.1]);
  eq('unrealised in whole dollars', [v.unrealized, v.unrealizedPct], [250, 41.67]);
  eq('legs, hard date, levels, opened', [v.legs.length, v.legs[1].side, v.hardDate, v.levels.map(l => `${l.kind}:${l.on}`), v.opened],
     [2, 'short', '2026-12-11', ['stop:position', 'target:underlying'], '2026-10-01']);
  const sh = positionView(shares);
  eq('shares: quoted mark, the underlying is its own price', [sh.instrument, sh.structure, sh.qty, sh.avgCost, sh.markSource, sh.underlying, sh.unrealized], ['stock', null, 20, 21, 'quote', 25, 80]);
}
{
  const b = bookView([shares, closed, setup, spread], { asOf: '2026-11-05T16:00:00Z' });
  eq('open positions only, sorted by symbol', b.positions.map(p => p.id), ['zzq-1', 'zzs-1']);
  eq('with a count and an as-of', [b.count, b.asOf], [2, '2026-11-05T16:00:00Z']);
}

// ── THE PROTOCOL ─────────────────────────────────────────────────────────────
{
  const snapshot = async () => [spread, shares, closed];
  const init = await bookRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { snapshot });
  eq('its own server name', init.result.serverInfo.name, 'dvcap-book');
  ok('and it says the data is private', /private/i.test(init.result.instructions));
  const list = await bookRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { snapshot });
  eq('one tool', list.result.tools.map(t => t.name), ['get_positions']);
  const call = await bookRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_positions', arguments: {} } }, { snapshot });
  eq('get_positions answers the open book', JSON.parse(call.result.content[0].text).positions.map(p => p.symbol), ['ZZQ', 'ZZS']);
  const bad = await bookRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_positions', arguments: { all: true } } }, { snapshot });
  ok('an unknown argument is refused', bad.result.isError);
  const gamma = await bookRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_gamma_board', arguments: {} } }, { snapshot });
  ok('the gamma tools are not reachable here', gamma.error?.code === -32602);
  const down = await bookRpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_positions' } }, { snapshot: async () => { throw new Error('x'); } });
  eq('a failed read is a tool error, not a crash', [down.result.isError, down.result.content[0].text], [true, 'book unavailable']);
}
{
  // The gamma connector is unchanged by the shared plumbing.
  const init = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { callTool: async () => null });
  eq('gamma: same server and promise', [init.result.serverInfo.name, /No account data/.test(init.result.instructions)], ['dvcap-gamma', true]);
  const list = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { callTool: async () => null });
  eq('gamma: same tools', list.result.tools.map(t => t.name), TOOLS.map(t => t.name));
  ok('and no book tool among them', !list.result.tools.some(t => t.name === 'get_positions'));
}

// ── THE DOOR ─────────────────────────────────────────────────────────────────
function fakeRes() {
  const r = { code: null, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = typeof b === 'string' ? JSON.parse(b) : b; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
const req = (token, body, method = 'POST') => ({ method, query: { bookmcp: token }, headers: { host: 'example.test' }, body });
{
  const snap = async () => [spread];
  const listMsg = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  let r = fakeRes(); await serveBookMcp(req(TOKEN, listMsg), r, { env: {}, snap });
  eq('no secret set: 404 for everyone', r.code, 404);
  r = fakeRes(); await serveBookMcp(req('short', listMsg), r, { env: { [BOOK_TOKEN_ENV]: 'short' }, snap });
  eq('a short secret matches nothing', r.code, 404);
  r = fakeRes(); await serveBookMcp(req('x'.repeat(40), listMsg), r, { env, snap });
  eq('a wrong token: 404', r.code, 404);
  r = fakeRes(); await serveBookMcp(req(TOKEN, null, 'GET'), r, { env, snap });
  eq('the right token, GET: 405', r.code, 405);
  r = fakeRes(); await serveBookMcp(req(TOKEN, listMsg), r, { env, snap });
  eq('the right token, POST: the tool list', [r.code, r.body.result.tools[0].name], [200, 'get_positions']);
  ok('never cached', r.headers['Cache-Control'] === 'private, no-store');
  let reads = 0;
  r = fakeRes(); await serveBookMcp(req(TOKEN, [1, 2].map(id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_positions' } }))), r, { env, snap: async () => { reads++; return [spread]; } });
  eq('a batch reads the book once', [r.body.length, reads], [2, 1]);
  ok('the gamma token does not open it', !bookTokenMatches(TOKEN, { MCP_CONNECTOR_TOKEN: TOKEN }));
}

// ── THE CHECK PAGE ───────────────────────────────────────────────────────────
{
  eq('unset', [bookSecretReport({}).configured, bookSecretReport({}).sha256_prefix], [false, null]);
  const good = bookSecretReport({ [BOOK_TOKEN_ENV]: 'Ab3-_.~' + 'x'.repeat(30) + '\n', VERCEL_ENV: 'production' });
  eq('a URL-safe secret, trailing newline trimmed', [good.configured, good.length, good.long_enough, good.url_safe, good.env], [true, 37, true, true, 'production']);
  ok('never the secret itself', !JSON.stringify(good).includes('xxxxxxxxxx'));
  eq('symbols a URL cannot carry are flagged', ['a/b', 'a#b', 'a?b', 'a%b', 'a+b', 'a b'].map(c => bookSecretReport({ [BOOK_TOKEN_ENV]: c + 'y'.repeat(32) }).url_safe), [false, false, false, false, false, false]);
  const shape = bookRequestShape({ method: 'POST', headers: { accept: 'application/json', 'x-forwarded-for': '1.2.3.4' }, query: { bookmcp: TOKEN }, body: { jsonrpc: '2.0', id: 1, method: 'initialize' } }, false, new Date('2026-11-05T20:00:00Z'));
  eq('the log keeps a shape', [shape.method, shape.matched, shape.rpc, shape.accept], ['POST', false, 'initialize', 'application/json']);
  ok('never the token or the IP', !/b{20}|1\.2\.3\.4/.test(JSON.stringify(shape)));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
