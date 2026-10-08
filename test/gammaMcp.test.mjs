// test/gammaMcp.test.mjs — the gamma MCP connector: levels and ladder from a board, the rules, the RPC.
import fs from 'node:fs';
import { dashboardFor, dashboardLeaks, isStandardMonthly, checkArgs, tokenMatches, handleRpc, TOOLS, CONNECTOR_TICKERS, toolOk } from '../lib/gammaMcp.js';
import { gexFeedPayload } from '../lib/gexFeed.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

// SPY at the 2026-10-08 close, market data only (see its _note).
const board = JSON.parse(fs.readFileSync(new URL('./fixtures-gamma-board-spy.json', import.meta.url)));
const opts = { mode: 'live_recompute', asOf: board._asOf, sourceSnapshot: board._asOf, today: '2026-10-08' };
const d = dashboardFor('SPY', board, opts);
const feed = gexFeedPayload('SPY', board, opts);

// ── Levels ──
eq('the seven level keys, in order', d.levels.map(l => l.key), ['spot', 'flip', 'wall', 'trap_near', 'trap_deep', 'pivot', 'net']);
eq('the same numbers as the gamma feed', d.levels.map(l => [l.key, l.strike]),
  [['spot', feed.spot], ['flip', feed.flip.line], ['wall', feed.call_wall.strike], ['trap_near', feed.trapdoor.near.strike],
   ['trap_deep', feed.trapdoor.deep.strike], ['pivot', feed.post_expiry_pivot.to], ['net', null]]);
eq('gamma in $bn per 1%, two places', d.levels.filter(l => l.gamma_bn != null).map(l => [l.key, l.gamma_bn]),
  [['wall', +(feed.call_wall.gamma / 1e9).toFixed(2)], ['trap_near', +(feed.trapdoor.near.gamma / 1e9).toFixed(2)],
   ['trap_deep', +(feed.trapdoor.deep.gamma / 1e9).toFixed(2)], ['net', +(feed.net_gex_per_1pct / 1e9).toFixed(2)]]);
eq('spot carries its time and mode; trapdoors their expiry', [d.levels[0].asof, d.levels[0].mode, d.levels[3].expiry, d.levels[4].expiry],
  [feed.as_of_utc, 'live_recompute', feed.trapdoor.near.expiry, feed.trapdoor.deep.expiry]);
eq('meta', d.meta, { as_of_utc: feed.as_of_utc, source_snapshot_utc: feed.source_snapshot_utc, mode: 'live_recompute', spot: 774.64 });

// ── Ladder ──
const L = d.ladder;
ok('every strike within ±3.5% of spot, and only those', L.length > 20 && L.every(r => Math.abs(r.strike / 774.64 - 1) * 100 <= 3.5)
  && board.byStrike.filter(b => Math.abs(b.strike / 774.64 - 1) * 100 <= 3.5).every(b => L.some(r => r.strike === b.strike)));
ok('highest strike first', L.every((r, i) => i === 0 || r.strike < L[i - 1].strike));
ok('the sum rule: near + monthly + other = total, every row', L.every(r => r.near_mn + r.monthly_mn + r.other_mn === r.gamma_mn));
eq('nearest expiry Fri 9 Oct, monthly the third Friday (16 Oct)', [L[0].near_expiry, L[0].monthly_expiry], ['2026-10-09', '2026-10-16']);
const wallRow = L.find(r => r.strike === feed.call_wall.strike);
eq('the call wall strike on the ladder is the wall\'s gamma, in $M', wallRow.gamma_mn, Math.round(feed.call_wall.gamma / 1e6));
eq('dist_pct = (strike / spot − 1) × 100, two places', wallRow.dist_pct, +((780 / 774.64 - 1) * 100).toFixed(2));
eq('a wider band, more strikes', dashboardFor('SPY', board, { ...opts, bandPct: 6 }).ladder.length > L.length, true);

// When the nearest expiry IS the monthly (16 Oct, the morning of): counted once, as the monthly.
{
  const m = dashboardFor('SPY', board, { ...opts, today: '2026-10-16' });
  ok('nearest = monthly: near_mn is 0 on every row', m.ladder.length > 0 && m.ladder.every(r => r.near_mn === 0));
  ok('…and near_expiry equals monthly_expiry', m.ladder.every(r => r.near_expiry === '2026-10-16' && r.monthly_expiry === '2026-10-16'));
  ok('…and the sum rule still holds', m.ladder.every(r => r.near_mn + r.monthly_mn + r.other_mn === r.gamma_mn));
}

// A board with no trapdoor: every cell positive. The rows are omitted, never sent as zeros.
{
  const pos = JSON.parse(JSON.stringify(board));
  for (const c of pos.grid.cells) c.netGexUsd = Math.abs(c.netGexUsd);
  for (const b of pos.byStrike) b.netGexUsd = Math.abs(b.netGexUsd);
  const keys = dashboardFor('SPY', pos, opts).levels.map(l => l.key);
  ok('no trapdoor on the board: trap rows omitted', !keys.includes('trap_near') && !keys.includes('trap_deep'));
  ok('…the rest still there', ['spot', 'flip', 'wall', 'net'].every(k => keys.includes(k)));
  ok('…and no level carries a zero standing in for a missing one', dashboardFor('SPY', pos, opts).levels.every(l => l.strike !== 0 && l.gamma_bn !== 0));
}

// ── Monthly expiry ──
eq('third Fridays', ['2026-10-16', '2026-11-20', '2026-12-18'].map(isStandardMonthly), [true, true, true]);
eq('not monthlies', ['2026-10-09', '2026-10-15', '2026-10-23', 'nonsense'].map(isStandardMonthly), [false, false, false, false]);

// ── Arguments ──
eq('the allowlist', CONNECTOR_TICKERS, ['SPY', 'QQQ']);
eq('a ticker that is not allowed', checkArgs('get_gamma_board', { ticker: 'tsla' }), { error: 'ticker not allowed: TSLA' });
eq('…in a dashboard list too', checkArgs('get_gamma_dashboard', { tickers: ['SPY', 'IWM'] }), { error: 'ticker not allowed: IWM' });
eq('defaults', checkArgs('get_gamma_dashboard', {}), { args: { tickers: ['SPY', 'QQQ'], band_pct: 3.5 } });
eq('band_pct bounds', checkArgs('get_gamma_dashboard', { band_pct: 50 }).error, 'band_pct must be between 0.5 and 20');

// ── Leak check ──
eq('the "key" field name is not a leak', dashboardLeaks(d), []);
eq('…a banned word in a value is', dashboardLeaks({ levels: [{ key: 'net', label: 'position size' }] }), ['position']);

// ── Token ──
const T = 'x'.repeat(43);
eq('token: right, wrong, wrong length, unset, short secret', [tokenMatches(T, T), tokenMatches('y'.repeat(43), T), tokenMatches('x', T), tokenMatches(T, undefined), tokenMatches('abc', 'abc')],
  [true, false, false, false, false]);

// ── JSON-RPC ──
{
  const calls = [];
  const callTool = async (name, args) => { calls.push([name, args]); return toolOk({ ok: 1 }); };
  const init = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, { callTool });
  eq('initialize: echoes a version it supports, offers tools', [init.result.protocolVersion, !!init.result.capabilities.tools, init.result.serverInfo.name], ['2025-03-26', true, 'dvcap-gamma']);
  eq('an unknown version gets the latest', (await handleRpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, { callTool })).result.protocolVersion, '2025-06-18');
  eq('a notification gets no reply', await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, { callTool }), null);
  eq('tools/list: exactly the two tools', (await handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { callTool })).result.tools.map(t => t.name), ['get_gamma_dashboard', 'get_gamma_board']);
  ok('every tool says it is read-only and carries no account data', TOOLS.every(t => t.annotations.readOnlyHint && /no account/i.test(t.description)));
  const bad = await handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_gamma_board', arguments: { ticker: 'NVDA' } } }, { callTool });
  eq('a disallowed ticker: isError with a plain message, the tool never called', [bad.result.isError, bad.result.content[0].text, calls.length], [true, 'ticker not allowed: NVDA', 0]);
  const good = await handleRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_gamma_dashboard', arguments: { tickers: ['qqq'] } } }, { callTool });
  eq('a good call: the checked arguments reach the tool', [good.result.isError, calls[0]], [false, ['get_gamma_dashboard', { tickers: ['QQQ'], band_pct: 3.5 }]]);
  const boom = await handleRpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_gamma_board', arguments: { ticker: 'SPY' } } }, { callTool: async () => { throw new Error('secret stack'); } });
  eq('a tool that throws: a plain message, never the stack', [boom.result.isError, boom.result.content[0].text], [true, 'board unavailable']);
  eq('an unknown method', (await handleRpc({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, { callTool })).error.code, -32601);
  eq('an unknown tool', (await handleRpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_positions' } }, { callTool })).error.code, -32602);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
