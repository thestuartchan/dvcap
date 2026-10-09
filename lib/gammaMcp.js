// lib/gammaMcp.js — the gamma board as a read-only MCP connector, for the Market Read dashboard.
//
// POST /api/mcp/<token> (vercel.json rewrites it onto api/gex.js ?mcp=). claude.ai custom
// connectors offer "No sign in", so the path token is the protection — its own secret
// (MCP_CONNECTOR_TOKEN), separate from the gamma feed's, so either can be rotated alone.
//
// WHAT IT CAN REACH. Two tools, both built from the same board the gamma feed serves (feedBoard in
// api/gex.js → gexFeedPayload in lib/gexFeed.js), called in-process, so the numbers are the feed's.
// This module sees a board and a ticker and nothing else: no route here reads the book, the journal
// inbox or the manual-entry store, and the answers are checked for the feed's banned words before
// they leave.
//
// STATELESS. Every request stands alone (no Mcp-Session-Id, no server-sent stream): serverless
// invocations share no memory, and the three methods a connector needs — initialize, tools/list,
// tools/call — need none.
import { createHash, timingSafeEqual } from 'node:crypto';
import { gexFeedPayload, feedLeaks, nyToday, FEED_TICKERS } from './gexFeed.js';
import HOLIDAYS from '../data/holidays.json' with { type: 'json' };

// The tickers the connector serves. One list; a ticker added here must also be one the feed serves.
export const CONNECTOR_TICKERS = Object.freeze(['SPY', 'QQQ'].filter(t => FEED_TICKERS.includes(t)));
export const DEFAULT_BAND_PCT = 3.5;
export const BAND_PCT_MIN = 0.5, BAND_PCT_MAX = 20;
export const MCP_RATE_PER_MIN = 30;               // per IP
export const MCP_TOKEN_MIN = 32;
export const MCP_TOKEN_ENV = 'MCP_CONNECTOR_TOKEN';
export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
export const SERVER_INFO = Object.freeze({ name: 'dvcap-gamma', version: '1.0.0' });

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const r2 = (v) => num(v) == null ? null : +(+v).toFixed(2);
const bn = (v) => num(v) == null ? null : +(+v / 1e9).toFixed(2);
const mn = (v) => Math.round(v / 1e6) || 0;       // `|| 0`: no -0 in the JSON

// ── THE TOKEN ────────────────────────────────────────────────────────────────
// Constant time, and length-blind: both sides are hashed to 32 bytes before the comparison, so a
// wrong guess learns nothing about the token's length either. An unset or short secret matches
// nothing — the route is then a 404 for everyone, never open.
// Both sides are trimmed first: a value pasted into Vercel's settings can carry a trailing newline
// or space, and the URL never can — that mismatch is a 404 that looks exactly like a wrong token.
export function tokenMatches(given, want) {
  const w = String(want || '').trim();
  if (w.length < MCP_TOKEN_MIN) return false;
  const h = (s) => createHash('sha256').update(String(s || '').trim()).digest();
  return timingSafeEqual(h(given), h(w));
}
// The per-minute bucket a request counts against; the IP is hashed by the caller.
export const mcpRateBucket = (ipHash, now = new Date()) => `dvcap:mcp:rl:v1:${ipHash}:${now.toISOString().slice(0, 16)}`;

// ── STANDARD MONTHLY ─────────────────────────────────────────────────────────
// The third Friday of the month — or the Thursday before it when that Friday is a US market holiday
// (data/holidays.json), which is when the monthly settles instead.
const usClosed = new Set(HOLIDAYS?.US?.closed || []);
const isThirdFriday = (d) => d.getUTCDay() === 5 && d.getUTCDate() >= 15 && d.getUTCDate() <= 21;
export function isStandardMonthly(date) {
  const t = Date.parse(`${date || ''}T12:00:00Z`);
  if (!Number.isFinite(t)) return false;
  const d = new Date(t);
  if (isThirdFriday(d)) return !usClosed.has(String(date));
  const fri = new Date(t + 864e5);
  return d.getUTCDay() === 4 && isThirdFriday(fri) && usClosed.has(fri.toISOString().slice(0, 10));
}

// ── THE DASHBOARD ROWS FOR ONE TICKER ────────────────────────────────────────
// board, mode, asOf, sourceSnapshot, today, staleReason: exactly what the feed route passes to
// gexFeedPayload — the levels ARE the feed's, reshaped. The ladder reads the board's full grid
// (every strike, not the heatmap's subset), with expiries before `today` dropped as the feed does.
// ── THE LEVELS, FROM THE FEED'S PAYLOAD ──────────────────────────────────────
// Keys, in reading order: spot, flip, wall, pin_hi, pin_lo, magnet (one row each), trap_near,
// trap_deep, pivot, em_hi, em_lo, net. A level the board lacks is omitted, never zeroed: no pin box
// on the board (its own rule found none) means no pin or magnet rows; no ATM vol (a stored capture
// carries none) means no ±1σ rows.
//   pin box   the front expiry's positive-gamma run around spot (p.pin_box), with its magnets — the
//             strikes inside it carrying the most gamma (gamma_bn each)
//   ±1σ       spot ± one standard deviation to the NEAREST expiry's close (spot × ATM vol × √years,
//             CBOE's surface): the next session's range after the close, today's rest during it
export function levelsFromPayload(ticker, p = {}) {
  const spot = num(p.spot);
  const levels = [];
  const add = (key, label, strike, gamma, extra = {}) => {
    if (key === 'net' ? gamma == null : strike == null) return;     // missing on the board: omit, never zero
    levels.push({ ticker, key, label, strike, gamma_bn: gamma, ...extra });
  };
  add('spot', 'Spot at board time', spot, null, { asof: p.as_of_utc, mode: p.mode });
  add('flip', 'Flip line', r2(p.flip?.line), null, { usable: p.flip?.usable ?? null, zone_lo: p.flip?.zone_lo ?? null, zone_hi: p.flip?.zone_hi ?? null });
  add('wall', 'Call wall', num(p.call_wall?.strike), bn(p.call_wall?.gamma));
  const pin = p.pin_box;
  if (pin) {
    add('pin_hi', 'Pin box top', num(pin.hi), null, { expiry: pin.expiry ?? null });
    add('pin_lo', 'Pin box bottom', num(pin.lo), null, { expiry: pin.expiry ?? null });
    for (const m of (pin.magnets || []).map(num).filter(v => v != null)) {
      add('magnet', 'Magnet', m, bn(pin.magnet_gamma?.[String(m)] ?? pin.magnet_gamma?.[m]), { expiry: pin.expiry ?? null });
    }
  }
  add('trap_near', 'Near trapdoor', num(p.trapdoor?.near?.strike), bn(p.trapdoor?.near?.gamma), { expiry: p.trapdoor?.near?.expiry ?? null });
  add('trap_deep', 'Deep trapdoor', num(p.trapdoor?.deep?.strike), bn(p.trapdoor?.deep?.gamma), { expiry: p.trapdoor?.deep?.expiry ?? null });
  add('pivot', 'Post-expiry pivot', r2(p.post_expiry_pivot?.to), null);
  const near = (p.expiries || [])[0];
  const sd = num(near?.move_1sd);
  if (spot != null && sd != null && sd > 0) {
    const extra = { expiry: near.date ?? null, atm_iv_pct: near.atm_iv_pct ?? null, move_1sd: sd };
    add('em_hi', '±1σ range, top', r2(spot + sd), null, extra);
    add('em_lo', '±1σ range, bottom', r2(spot - sd), null, extra);
  }
  add('net', 'Net gamma per 1%', null, bn(p.net_gex_per_1pct));
  return levels;
}

export function dashboardFor(ticker, board, { mode = 'settled', asOf = null, sourceSnapshot = null, today, staleReason = null, bandPct = DEFAULT_BAND_PCT } = {}) {
  const p = gexFeedPayload(ticker, board, { mode, asOf, sourceSnapshot, today, staleReason });
  const spot = num(p.spot);
  const levels = levelsFromPayload(ticker, p);

  // The ladder: per strike, the total split into the nearest expiry, the nearest standard monthly
  // and everything else. When the nearest IS the monthly it is counted once, as the monthly.
  // The trading date the feed used: given, or the board's own New York date.
  const day = today ?? (p.as_of_utc ? nyToday(new Date(p.as_of_utc)) : null);
  const cells = (board?.grid?.cells || []).filter(c => num(c?.strike) != null && num(c?.netGexUsd) != null && (!day || String(c.expiry) >= day));
  const expiries = [...new Set(cells.map(c => String(c.expiry)))].sort();
  const monthlyExpiry = expiries.find(isStandardMonthly) ?? null;
  const nearExpiry = expiries[0] ?? null;
  const nearIsMonthly = nearExpiry != null && nearExpiry === monthlyExpiry;
  const by = new Map();
  for (const c of cells) {
    const k = +c.strike;
    if (spot == null || Math.abs(k / spot - 1) * 100 > bandPct + 1e-9) continue;
    const s = by.get(k) || { total: 0, near: 0, monthly: 0 };
    const v = +c.netGexUsd;
    s.total += v;
    if (String(c.expiry) === monthlyExpiry) s.monthly += v;
    else if (!nearIsMonthly && String(c.expiry) === nearExpiry) s.near += v;
    by.set(k, s);
  }
  const ladder = [...by.entries()].sort((a, b) => b[0] - a[0]).map(([strike, s]) => {
    const gamma = mn(s.total), near = mn(s.near), monthly = mn(s.monthly);
    // `other` is what is left, so the three always sum to the total exactly.
    return { ticker, strike, gamma_mn: gamma, near_mn: near, monthly_mn: monthly, other_mn: gamma - near - monthly,
             dist_pct: r2((strike / spot - 1) * 100),
             near_expiry: nearIsMonthly ? monthlyExpiry : nearExpiry, monthly_expiry: monthlyExpiry };
  });

  const meta = { as_of_utc: p.as_of_utc, source_snapshot_utc: p.source_snapshot_utc, mode: p.mode, spot,
                 ...(p.stale_reason ? { stale_reason: p.stale_reason } : {}) };
  return { levels, ladder, meta };
}

// The dashboard answer's own leak check. Its rows carry a field NAMED "key" (spot, flip, wall…),
// which the feed's banned list would flag; the field name is set here and is not data, so it is
// taken out before the words are checked. Every value is still checked.
export const dashboardLeaks = (obj) => feedLeaks(JSON.stringify(obj).replace(/"key":/g, '"k":'));

// ── TOOLS ────────────────────────────────────────────────────────────────────
const SNAPSHOT = 'Each board is the one the dvcap gamma feed serves: a live recompute (OCC settled open interest on CBOE implied vol, repriced at the current spot, at most 5 minutes old) when one can be made, otherwise the last settled capture. meta.<ticker>.mode says which: "live_recompute" or "settled"; stale_reason appears when the open interest is the prior session\'s. Market data only: no account, position or trade data.';
export const TOOLS = Object.freeze([
  {
    name: 'get_gamma_dashboard',
    description: `Dealer gamma levels and a strike ladder for SPY and QQQ, shaped for a dashboard. levels: spot, flip line (with its zone), call wall, the pin box (top, bottom) and its magnets, near and deep trapdoors, post-expiry pivot, the ±1σ range to the nearest expiry's close (from ATM vol), and net gamma per 1% move (gamma_bn in $bn per 1% move; a level the board lacks is omitted, never zeroed). ladder: every strike within ±band_pct% of spot, highest first, with net gamma in $M per 1% move split into the nearest expiry, the nearest standard monthly and the rest. ${SNAPSHOT}`,
    inputSchema: {
      type: 'object',
      properties: {
        tickers: { type: 'array', items: { type: 'string', enum: [...CONNECTOR_TICKERS] }, description: `Default ${JSON.stringify(CONNECTOR_TICKERS)}.` },
        band_pct: { type: 'number', minimum: BAND_PCT_MIN, maximum: BAND_PCT_MAX, description: `Ladder half-width, % of spot. Default ${DEFAULT_BAND_PCT}.` },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Gamma dashboard', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_gamma_board',
    description: `The full dvcap gamma board for one ticker, exactly as the gamma feed returns it: flip line and zone, call wall, put support, trapdoors, pin box, balance, expiries with ATM vol, the heatmap strikes, post-expiry pivot, the CBOE cross-check and the risk-free rate. For written reads. ${SNAPSHOT}`,
    inputSchema: {
      type: 'object',
      properties: { ticker: { type: 'string', enum: [...CONNECTOR_TICKERS] } },
      required: ['ticker'],
      additionalProperties: false,
    },
    annotations: { title: 'Gamma board', readOnlyHint: true, openWorldHint: false },
  },
]);

// Argument checks, with plain messages. Returns { args } or { error }.
export function checkArgs(name, a = {}) {
  const args = a && typeof a === 'object' && !Array.isArray(a) ? a : {};
  const tick = (t) => String(t ?? '').trim().toUpperCase();
  if (name === 'get_gamma_board') {
    const t = tick(args.ticker);
    if (!t) return { error: 'ticker is required' };
    if (!CONNECTOR_TICKERS.includes(t)) return { error: `ticker not allowed: ${t}` };
    return { args: { ticker: t } };
  }
  if (name === 'get_gamma_dashboard') {
    let tickers = args.tickers == null ? [...CONNECTOR_TICKERS] : args.tickers;
    if (!Array.isArray(tickers) || !tickers.length) return { error: 'tickers must be a non-empty list' };
    tickers = [...new Set(tickers.map(tick))];
    const bad = tickers.filter(t => !CONNECTOR_TICKERS.includes(t));
    if (bad.length) return { error: `ticker not allowed: ${bad.join(', ')}` };
    const band = args.band_pct == null ? DEFAULT_BAND_PCT : num(args.band_pct);
    if (band == null || band < BAND_PCT_MIN || band > BAND_PCT_MAX) return { error: `band_pct must be between ${BAND_PCT_MIN} and ${BAND_PCT_MAX}` };
    return { args: { tickers, band_pct: band } };
  }
  return { error: `unknown tool: ${String(name)}` };
}

// A tool result: one JSON text block. Errors are a plain sentence, never a stack.
export const toolOk = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], isError: false });
export const toolError = (msg) => ({ content: [{ type: 'text', text: String(msg) }], isError: true });

// ── JSON-RPC ─────────────────────────────────────────────────────────────────
// One message in, one response out (null for a notification). `callTool(name, args)` does the work
// and resolves to a tool result; it is passed in so this stays free of the store.
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
export async function handleRpc(msg, { callTool }) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'invalid request');
  const isNote = !('id' in msg);
  if (isNote) return null;                         // notifications/initialized and the like: nothing to say
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    const asked = String(params?.protocolVersion || '');
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'Read-only dealer gamma boards for SPY and QQQ from dvcap. get_gamma_dashboard for levels and a strike ladder; get_gamma_board for the full board. No account data.',
    } };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = params?.name;
    if (!TOOLS.some(t => t.name === name)) return rpcError(id, -32602, `unknown tool: ${String(name)}`);
    const checked = checkArgs(name, params?.arguments);
    if (checked.error) return { jsonrpc: '2.0', id, result: toolError(checked.error) };
    let result;
    try { result = await callTool(name, checked.args); } catch { result = toolError('board unavailable'); }
    return { jsonrpc: '2.0', id, result };
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}
