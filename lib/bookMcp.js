// lib/bookMcp.js — the open book as a read-only MCP connector, for the Position Desk.
//
// WHY (5 Nov 2026). The Position Desk artifact kept its own copy of the book: a daily Claude task
// read IBKR's positions and wrote quantities, costs and marks onto the Desk, while dvcap's console
// held the reconciled book — every fill from the Flex statement, the option ledger's leg-outs,
// rolls and splits, live or IBKR-close marks. Two copies of one book drift. This connector lets the
// Desk read dvcap's instead; the Desk keeps what is its own (books, rules, alert requests).
//
// POST /api/book/<token> (vercel.json rewrites it onto api/tradecard.js ?bookmcp=). Its OWN secret,
// BOOK_MCP_TOKEN, deliberately not the gamma connector's: that connector is attached to every
// scheduled task and promises "no account data", and a leak of one must not open the other. Unset
// or short → every request is a 404, never open.
//
// WHAT IT ANSWERS. Open positions only, through a whitelist (bookView): what is held, its structure,
// quantity, average cost, mark, unrealised P&L, hard exit date and levels. Never the fills, notes,
// thesis, tags, account equity or anything from the journal.
//
// 6 Nov 2026: also today's not-yet-booked fills as per-contract counts (lib/sameDayFills.js
// todayNet; no prices, no order ids), the Desk rule states dvcap judged at the close
// (lib/deskRules.js), and ONE write, put_desk_rules, which replaces dvcap's copy of the Desk's rules.
// It touches only that copy (DESK_RULES_KEY); the book stays read-only.
import { createHash } from 'node:crypto';
import { tokenMatches, handleRpc, toolOk, toolError } from './gammaMcp.js';
import { legsOf, legLabel } from './instruments.js';
import { legKeyOf } from './sameDayFills.js';
import { normalizeMirror } from './deskRules.js';

export const BOOK_TOKEN_ENV = 'BOOK_MCP_TOKEN';
export const BOOK_RATE_PER_MIN = 20;               // per IP
export const BOOK_SERVER_INFO = Object.freeze({ name: 'dvcap-book', version: '1.0.0' });
export const BOOK_INSTRUCTIONS = 'Stu\'s open positions as dvcap\'s trade console holds them (reconciled from IBKR Flex statements), with marks and unrealised P&L. get_positions lists them, with today\'s fills the book does not hold yet (unconfirmed, from IBKR\'s same-day report) and the Position Desk rule states dvcap judged at the last US close. put_desk_rules is the one write: it replaces the copy of the Desk\'s rules dvcap checks at the close; it never changes the book. Private account data: never post it to Discord or anywhere public.';
export const bookRateBucket = (ipHash, now = new Date()) => `dvcap:mcp:book:rl:v1:${ipHash}:${now.toISOString().slice(0, 16)}`;
export const ipHashOf = (ip) => createHash('sha256').update(String(ip || 'unknown')).digest('hex').slice(0, 16);
export const bookTokenMatches = (given, env = process.env) => tokenMatches(given, env?.[BOOK_TOKEN_ENV]);
export const BOOK_LOG_KEY = 'dvcap:mcp:book:requests:v1';

// ?bookcheck=1 (behind the dashboard login): is the secret deployed, long enough, and usable inside a
// URL path? A password-manager secret with / # ? % + or a space cannot be pasted into the connector
// URL and match — the most likely reason a connector that works with curl fails in claude.ai. The
// SHA-256 prefix lets the owner compare with a hash of what they hold; it cannot recover the secret.
export function bookSecretReport(env = process.env) {
  const t = String(env?.[BOOK_TOKEN_ENV] || '').trim();
  return {
    configured: t.length > 0, length: t.length, long_enough: t.length >= 32,
    url_safe: t.length > 0 && /^[A-Za-z0-9._~-]+$/.test(t),
    sha256_prefix: t ? createHash('sha256').update(t).digest('hex').slice(0, 8) : null,
    env: String(env?.VERCEL_ENV || 'unknown'),
  };
}
// One request as a shape for the log: time, method, whether the token matched, the JSON-RPC method
// and a few headers. Never the token, never an IP.
export function bookRequestShape(req, matched, now = new Date()) {
  const h = (k) => String(req?.headers?.[k] || '').slice(0, 80) || null;
  const b = req?.body && typeof req.body === 'object' ? req.body : null;
  const rpc = Array.isArray(b) ? b.map(x => x?.method).join(',') : b?.method ?? null;
  return { at: now.toISOString(), method: req?.method ?? null, matched: !!matched, rpc,
           accept: h('accept'), contentType: h('content-type'), protocol: h('mcp-protocol-version'),
           auth: !!req?.headers?.authorization, ua: h('user-agent') };
}

export const BOOK_TOOLS = Object.freeze([
  {
    name: 'get_positions',
    title: 'Open positions',
    description: 'Every open position in dvcap\'s trade console: id (stable, use it to match), symbol, instrument, side, structure (option legs), quantity, average cost, mark with its source and time, underlying price, unrealised P&L, hard exit date and levels. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'put_desk_rules',
    title: 'Send the Desk\'s rules to dvcap',
    description: 'Replaces dvcap\'s copy of the Position Desk\'s rules, which dvcap checks at 16:20 New York and posts newly hit rules to Stu\'s private Discord channel. Send every open Desk position: {deskId, dvcapId, name, group, side, rules:[{id, kind add|tp|stop|exit|review, text, level, symbol (TradingView ticker), cond, cadence, source stu|draft}]}. Optional watch: tickers of active Trading Ideas (no positions, no sizes), which dvcap adds to the private after-close flow check. Never changes the book.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['positions'],
      properties: { positions: { type: 'array', maxItems: 200, items: { type: 'object' } },
        watch: { type: 'array', maxItems: 60, items: { type: 'string' } } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
]);
export function checkBookArgs(name, args) {
  if (args != null && (typeof args !== 'object' || Array.isArray(args))) return { error: 'arguments must be an object' };
  if (name === 'put_desk_rules') {
    const extra = Object.keys(args || {}).filter(k => k !== 'positions' && k !== 'watch');
    if (extra.length) return { error: `unknown argument: ${extra[0]}` };
    const n = normalizeMirror(args || {});
    return n.error ? { error: n.error } : { args: n.mirror };
  }
  const extra = Object.keys(args || {});
  if (extra.length) return { error: `unknown argument: ${extra[0]}` };
  return { args: {} };
}

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const round = (v, dp) => num(v) == null ? null : +(+v).toFixed(dp);
// Prices keep six significant digits, not a fixed number of decimals: a yen futures option trades
// near 0.00005, and four decimals turned its cost and mark into 0 (5 Nov 2026).
const sig = (v) => num(v) == null ? null : +(+v).toPrecision(6);
const isoDay = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

// One snapshot row (api/tradecard.js snapshot: the row + derived + price + pnl) → what leaves.
// Built field by field: a field added to the console's rows later does not reach the connector
// until it is named here.
export function positionView(r) {
  const d = r?.derived || {};
  const legs = legsOf(r);
  const option = legs.length > 0;
  const firstFill = (d.fills || []).map(f => isoDay(f?.date)).filter(Boolean).sort()[0] || null;
  return {
    id: String(r?.id || ''),
    symbol: String(r?.symbol || '').toUpperCase(),
    instrument: option ? (legs.length > 1 ? 'option spread' : 'option') : r?.margined ? 'future' : 'stock',
    side: d.side === 'short' ? 'short' : 'long',
    structure: option ? legLabel(legs) : null,
    legs: option ? legs.map(l => ({ right: l.right, strike: num(l.strike), expiry: isoDay(l.expiry), side: l.side, ratio: num(l.ratio) ?? 1 })) : [],
    currency: String(r?.currency || 'USD').toUpperCase(),
    multiplier: num(d.multiplier) ?? num(r?.multiplier) ?? 1,
    qty: round(d.qty, 4),
    avgCost: sig(d.avgCost),
    mark: sig(r?.price),
    markSource: option ? (r?.markSource ?? null) : (num(r?.price) != null ? 'quote' : null),
    markAsOf: r?.markAsOf ?? null,
    underlying: sig(option ? r?.underlyingPx : r?.price),
    unrealized: num(r?.pnl?.unrealized) == null ? null : Math.round(r.pnl.unrealized),
    unrealizedPct: round(r?.pnl?.unrealizedPct, 2),
    marketValue: num(r?.pnl?.marketValue) == null ? null : Math.round(r.pnl.marketValue),
    opened: firstFill,
    hardDate: isoDay(r?.hardDate),
    levels: (Array.isArray(r?.levels) ? r.levels : []).map(lv => ({
      kind: String(lv?.kind || ''), at: num(lv?.at), to: num(lv?.to), on: lv?.on === 'underlying' ? 'underlying' : 'position',
    })).filter(lv => lv.kind && lv.at != null),
    levelHits: Array.isArray(r?.levelHits) ? r.levelHits.map(String).slice(0, 8) : [],
  };
}

// The tool's answer: open positions only (a setup with no fills is not held), sorted by symbol.
export function bookView(rows = [], { asOf = new Date().toISOString(), sameDay = null, checks = null } = {}) {
  const open = (Array.isArray(rows) ? rows : []).filter(r => r?.derived?.status === 'open' && num(r?.derived?.qty) > 0);
  const positions = open.map(positionView).sort((a, b) => a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id));
  const today = attachToday(positions, sameDay, asOf);
  return { asOf, count: positions.length, positions,
           ...(today ? { sameDay: today } : {}),
           ...(checks ? { deskChecks: checks } : {}),
           note: 'Marks: options from Cboe delayed quotes (live) or IBKR\'s close mark (close); shares and futures from the dashboard quote feed. A null mark means none was available.'
             + (today ? ' `today` on a position and sameDay.unbooked are fills from IBKR\'s same-day report the book does not hold yet: unconfirmed until tomorrow\'s statement. On a position, today.change is the change in its quantity (bought/sold count that position\'s held-long leg, or the held-short leg when it has none): book qty + today.change is the position now.' : '') };
}

// TODAY'S FILLS beside the book (lib/sameDayFills.js todayNet). Only today's New York date counts:
// yesterday's summary is what the book already took in this morning. Each contract is matched to
// at most one position, by option leg or by symbol; the rest is `unbooked`.
const nyDate = (iso) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso)); } catch { return null; } };
export function attachToday(positions, sameDay, asOf) {
  if (!sameDay || !Array.isArray(sameDay.items) || sameDay.date !== nyDate(asOf)) return null;
  const left = new Map(sameDay.items.map(i => [i.key, i]));
  for (const p of positions) {
    const legs = p.legs.length ? p.legs.map(l => ({ side: l.side, key: legKeyOf({ root: p.symbol, right: l.right, strike: l.strike, expiry: l.expiry }) }))
                               : [{ side: p.side, key: p.symbol }];
    const hits = legs.map(l => ({ ...l, item: left.get(l.key) })).filter(l => l.item);
    if (!hits.length) continue;
    hits.forEach(h => left.delete(h.key));
    // A spread's legs trade together, so one leg tells the spread's story: a leg HELD long grows the
    // position when bought (debit or credit spread alike); a leg held short grows it when sold.
    const lead = hits.find(h => h.side === 'long') || hits[0];
    const change = lead.side === 'short' ? -lead.item.net : lead.item.net;
    p.today = { bought: lead.item.bought, sold: lead.item.sold, change: +change.toFixed(4), contracts: hits.length };
  }
  const unbooked = [...left.values()].map(i => ({ symbol: i.root, instrument: i.instrument,
    contract: i.instrument === 'option' ? `${i.expiry} ${i.strike}${i.right}` : i.symbol, bought: i.bought, sold: i.sold, net: i.net }));
  return { asOf: sameDay.at, unbooked };
}

// JSON-RPC over the shared plumbing (lib/gammaMcp.js handleRpc) with this connector's tools.
// `snapshot()` resolves to the rows bookView reads.
// `extras()` resolves to { sameDay, checks } (both optional); `putRules(mirror)` stores the Desk's
// rules and resolves to { ok, count }.
export function bookRpc(msg, { snapshot, extras = async () => ({}), putRules = null, now = () => new Date() }) {
  const callTool = async (name, args) => {
    if (name === 'put_desk_rules') {
      if (!putRules) return toolError('rule store unavailable');
      try {
        const r = await putRules(args);
        return r?.ok ? toolOk({ ok: true, positions: args.positions.length, rules: args.positions.reduce((n, p) => n + p.rules.length, 0), watch: (args.watch || []).length, checkedAt: '16:20 New York, US trading days' }) : toolError('rule store unavailable');
      } catch { return toolError('rule store unavailable'); }
    }
    if (name !== 'get_positions') return toolError(`unknown tool: ${name}`);
    try {
      const [rows, more] = await Promise.all([snapshot(), extras().catch(() => ({}))]);
      return toolOk(bookView(rows, { asOf: now().toISOString(), sameDay: more?.sameDay ?? null, checks: more?.checks ?? null }));
    } catch { return toolError('book unavailable'); }
  };
  return handleRpc(msg, { callTool, tools: BOOK_TOOLS, check: checkBookArgs, info: BOOK_SERVER_INFO, instructions: BOOK_INSTRUCTIONS });
}
