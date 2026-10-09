// api/gex.js — ONE function, two modes.
//
// It was two routes. Vercel's Hobby plan caps a deployment at 12 Serverless Functions and this
// project has exactly 12 with them merged; as two it was 13 and the entire deployment stopped
// shipping, leaving the previous build live. /api/atr answered 200 while both GEX routes 404'd and
// nothing announced the cause. Splitting them again means finding that out the hard way a second
// time, so the mode is a query parameter and the work lives in lib/gexStore.js.
//
//   GET /api/gex?symbol=QQQ          read the stored series (default)
//   GET /api/gex?snapshot=1[&dry=1]  capture today's chain — the cron target
//   GET /api/gex?custom=INTC         one typed name, on demand, nothing stored (gated)
//   GET /api/g/<slug>/<ticker>       the read-only gamma JSON feed (vercel.json rewrites it to
//                                    ?feed=<slug>&symbol=<ticker>); the slug is the protection
//   GET /api/g/<slug>/crosscheck     the cross-check JSON under the same slug and limits: credit,
//                                    real yields, ACM term premium, breadth, auctions, CFTC, DIX,
//                                    AAII, Cboe put/call (lib/crossCheck.js, lib/crossCheckFeed.js)
//   GET /api/gex?feedslug=1          the feed's slug, minted on first ask (gated); POST &rotate=1
//                                    replaces it
//   POST /api/mcp/<token>            the gamma board as a read-only MCP connector for claude.ai
//                                    (vercel.json rewrites it to ?mcp=<token>; lib/gammaMcp.js). Its
//                                    own secret, MCP_CONNECTOR_TOKEN; a wrong one is a 404
import { createHash, randomBytes } from 'node:crypto';
import { kvConfigured, kvGetJson, kvSetJson, kvSetJsonEx, kvIncrEx, kvSetNxEx } from '../lib/kv.js';
import { gexFeedPayload, feedLeaks, slugMatches, rateBucket, FEED_TICKERS, FEED_RECOMPUTE_MIN, FEED_RATE_PER_HOUR, oiStaleReason, nyToday } from '../lib/gexFeed.js';
import { crossCheckPayload } from '../lib/crossCheckFeed.js';
import { handleRpc, dashboardFor, dashboardLeaks, tokenMatches, mcpRateBucket, toolOk, toolError, MCP_RATE_PER_MIN, MCP_TOKEN_ENV, MCP_TOKEN_MIN } from '../lib/gammaMcp.js';
import { crossCheckLeaks } from '../lib/crossCheck.js';
import { captureGex, readGex, settledGex, observeRoll, OCC_ROLL_LOG_KEY, OCC_HEALTH_KEY, GEX_SYMBOLS, CUSTOM_ROOT_RE,
         LAST_RECOMPUTE_KEY, LAST_RECOMPUTE_TTL_SEC, recomputeRecord, newerRecompute } from '../lib/gexStore.js';
import { instrumentKind } from '../lib/catalyst.js';
import { authorised, refusalReason } from '../lib/apiauth.js';
import { getQuotes } from '../lib/quotes.js';
import { marketState } from '../lib/sessions.js';
import { rollSummary, OCC_CONFIRM_MIN } from '../lib/occ.js';
import { healthSummary, transitionRuns, confirmMinVerdict } from '../lib/occHealth.js';

// ── THE SPOT A RECOMPUTE IS PRICED AT ────────────────────────────────────────
// The panel was fetching /api/prices and passing the result. That route returns the REGULAR
// print and never an extended-hours one, so pre-open it handed back the PRIOR CLOSE — 716.31
// against a live pre-market 707.94 on 2026-09-10, a 1.2% error, labelled `spotSource: caller`
// and therefore reported in the footer as the live spot. So the spot is resolved here, with the
// same getQuotes({ prepost }) call the pre-read uses: one definition of the current price.
async function resolveSpot(sym) {
  try {
    const [q] = await getQuotes([sym], { prepost: true });
    // Outside regular hours the extended print is the live one and the regular is yesterday's.
    // Inside them it is the other way round, and a stale ext must never override a live regular.
    const shut = marketState(sym) !== 'open';
    const px = (shut && q?.ext && !q.ext.stale && q.ext.price > 0) ? q.ext.price : q?.price;
    return Number.isFinite(+px) && +px > 0 ? +px : null;
  } catch { return null; }   // settledGex falls back to CBOE's, and the footer names it
}

// ── THE READ-ONLY FEED ───────────────────────────────────────────────────────
// For a consumer that cannot send an auth header. The slug (32 random bytes, minted below and
// kept in KV) is the protection; wrong slugs and unknown tickers are both a plain 404. Rate-limited
// per IP BEFORE the slug is checked, so guessing costs the same as asking. GET only, no CORS
// headers, never edge-cached (the Cache-Control at the top of the handler). The payload is built
// by lib/gexFeed.js from named gamma fields only, and refused outright if it ever contains a word
// on the brief's banned list.
const FEED_SLUG_KEY = 'dvcap:gex:feed:slug:v1';
const FEED_LOCK_KEY = (sym) => `dvcap:gex:feed:lock:v1:${sym}`;

// The board to serve: a recompute no older than FEED_RECOMPUTE_MIN if there is one — the panel's
// or this route's, they share LAST_RECOMPUTE_KEY — else a new one if the lock allows (at most one
// per ticker per FEED_RECOMPUTE_MIN, however many callers), else the newest thing on hand.
async function feedBoard(sym, now = Date.now()) {
  const stored = await readGex(sym).catch(() => null);
  // The row a recompute is shown with on the tab: the stored row with the recompute's on top.
  // A recompute on YESTERDAY's open interest (OCC's file not yet rolled) is served but marked, and
  // is not written over the store — the board stays yesterday's until today's file lands.
  const fromRecord = (rec) => ({ board: { ...rec, row: { ...(stored?.latest || {}), ...rec.row } }, mode: 'live_recompute', asOf: rec.at,
    source: rec.mode === 'repriced' ? (rec.capturedAt || rec.at) : (rec.iv?.asOf || rec.at),
    staleReason: oiStaleReason(rec.vintage, new Date(now)) });
  const kept = await kvGetJson(LAST_RECOMPUTE_KEY(sym)).catch(() => null);
  const age = kept?.at ? now - Date.parse(kept.at) : Infinity;
  if (age < FEED_RECOMPUTE_MIN * 60000) return fromRecord(kept);
  if (await kvSetNxEx(FEED_LOCK_KEY(sym), { at: new Date(now).toISOString() }, FEED_RECOMPUTE_MIN * 60)) {
    try {
      const out = await settledGex(sym, { spot: await resolveSpot(sym), expiries: stored?.latest?.expiries || null });
      const rec = recomputeRecord(sym, { ...out, mode: 'settled' });
      if (rec) {
        if (!oiStaleReason(rec.vintage, new Date(now))) { try { await kvSetJsonEx(LAST_RECOMPUTE_KEY(sym), rec, LAST_RECOMPUTE_TTL_SEC); } catch { /* served anyway */ } }
        return fromRecord(rec);
      }
    } catch { /* fall through to what is on hand */ }
  }
  const rec = newerRecompute(stored?.latest, kept);
  if (rec) return fromRecord(rec);
  if (stored?.latest) {
    return { board: { row: stored.latest, levels: stored.levels, grid: stored.grid, byStrike: stored.byStrike,
                      decay: null, crossCheck: stored.latest.crossCheck ?? null },
             mode: 'settled', asOf: stored.latest.asOf, source: stored.latest.asOf };
  }
  return { board: null };
}

async function serveFeed(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }
  const ip = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || String(req.headers?.['x-real-ip'] || '') || 'unknown';
  const ipHash = createHash('sha256').update(ip).digest('hex').slice(0, 16);
  const n = await kvIncrEx(rateBucket(ipHash), 3600);
  if (n != null && n > FEED_RATE_PER_HOUR) {
    const d = new Date(); const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((next - d.getTime()) / 1000))));
    return res.status(429).json({ error: `limit is ${FEED_RATE_PER_HOUR} requests an hour` });
  }
  const stored = await kvGetJson(FEED_SLUG_KEY).catch(() => null);
  if (!slugMatches(req.query?.feed, stored?.slug)) return res.status(404).json({ error: 'not found' });
  const sym = String(req.query?.symbol || '').trim().toUpperCase();
  // The cross-check rides the same slug, limit and refusal rule. Always 200: a source that fails is
  // a block marked unavailable, never a failed response.
  if (sym === 'CROSSCHECK') {
    const body = JSON.stringify(await crossCheckPayload());
    if (crossCheckLeaks(body).length) return res.status(500).json({ error: 'refused' });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(body);
  }
  if (!FEED_TICKERS.includes(sym)) return res.status(404).json({ error: 'not found' });
  const { board, mode, asOf, source, staleReason } = await feedBoard(sym);
  if (!board) return res.status(503).json({ error: 'no board yet' });
  const body = JSON.stringify(gexFeedPayload(sym, board, { mode, asOf, sourceSnapshot: source, today: nyToday(), staleReason }));
  if (feedLeaks(body).length) return res.status(500).json({ error: 'refused' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(200).send(body);
}

// ── THE MCP CONNECTOR ────────────────────────────────────────────────────────
// Streamable HTTP, stateless: each POST carries one JSON-RPC message (or a batch) and gets JSON
// back; there is no session and no server-sent stream, so GET and DELETE are 405. Rate-limited per
// IP before the token is checked, as the feed is; a wrong or unset token is a plain 404. The tools
// call feedBoard and the feed's payload builder in-process — the same board, the same numbers.
async function mcpTool(name, args) {
  const today = nyToday();
  if (name === 'get_gamma_board') {
    const { board, mode, asOf, source, staleReason } = await feedBoard(args.ticker);
    if (!board) return toolError('board unavailable');
    const out = gexFeedPayload(args.ticker, board, { mode, asOf, sourceSnapshot: source, today, staleReason });
    return feedLeaks(JSON.stringify(out)).length ? toolError('board unavailable') : toolOk(out);
  }
  // get_gamma_dashboard: the tickers in parallel; one that has no board is named in meta and the
  // rest still answer. Only when none do is it an error.
  const parts = await Promise.all(args.tickers.map(async (t) => {
    try {
      const { board, mode, asOf, source, staleReason } = await feedBoard(t);
      return board ? [t, dashboardFor(t, board, { mode, asOf, sourceSnapshot: source, today, staleReason, bandPct: args.band_pct })] : [t, null];
    } catch { return [t, null]; }
  }));
  if (!parts.some(([, d]) => d)) return toolError('board unavailable');
  const out = { levels: [], ladder: [], meta: {} };
  for (const [t, d] of parts) {
    if (!d) { out.meta[t] = { unavailable: 'board unavailable' }; continue; }
    out.levels.push(...d.levels); out.ladder.push(...d.ladder); out.meta[t] = d.meta;
  }
  return dashboardLeaks(out).length ? toolError('board unavailable') : toolOk(out);
}

// THE LAST 20 CONNECTOR REQUESTS, AS SHAPES. claude.ai's connector check answered "404" while a
// POST with the right token listed both tools (9 Oct), so what the checker actually sends has to be
// seen rather than guessed. Recorded: time, method, whether the token matched, any path after it,
// the JSON-RPC method and a few headers. Never the token, never an IP. Read with ?mcpcheck=1.
const MCP_LOG_KEY = 'dvcap:mcp:requests:v1';
async function logMcp(req, matched) {
  if (!kvConfigured()) return;
  try {
    const h = (k) => String(req.headers?.[k] || '').slice(0, 80) || null;
    const b = req.body && typeof req.body === 'object' ? req.body : null;
    const rpc = Array.isArray(b) ? b.map(x => x?.method).join(',') : b?.method ?? null;
    const entry = { at: new Date().toISOString(), method: req.method, matched, rest: String(req.query?.mcprest || '') || null, rpc,
                    accept: h('accept'), contentType: h('content-type'), protocol: h('mcp-protocol-version'), session: !!req.headers?.['mcp-session-id'],
                    auth: !!req.headers?.authorization, ua: h('user-agent') };
    const log = (await kvGetJson(MCP_LOG_KEY).catch(() => null)) || [];
    await kvSetJsonEx(MCP_LOG_KEY, [...log, entry].slice(-20), 7 * 86400);
  } catch { /* a log that fails must not fail the request */ }
}

async function serveMcp(req, res) {
  if (kvConfigured()) {
    const ip = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || String(req.headers?.['x-real-ip'] || '') || 'unknown';
    const n = await kvIncrEx(mcpRateBucket(createHash('sha256').update(ip).digest('hex').slice(0, 16)), 60).catch(() => null);
    if (n != null && n > MCP_RATE_PER_MIN) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: `limit is ${MCP_RATE_PER_MIN} requests a minute` }); }
  }
  const matched = tokenMatches(req.query?.mcp, process.env[MCP_TOKEN_ENV]);
  await logMcp(req, matched);
  if (!matched) return res.status(404).json({ error: 'not found' });
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); } }
  const callTool = (name, args) => (kvConfigured() ? mcpTool(name, args) : Promise.resolve(toolError('board unavailable')));
  const msgs = Array.isArray(body) ? body : [body];
  const out = (await Promise.all(msgs.map(m => handleRpc(m, { callTool })))).filter(Boolean);
  if (!out.length) return res.status(202).end();    // notifications only
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(200).send(JSON.stringify(Array.isArray(body) ? out : out[0]));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  // Before the KV check: a wrong token is a 404 whether or not the store is configured.
  if (req.query?.mcp != null) return serveMcp(req, res);
  // ?mcpcheck=1 — is a connector token deployed, and is it the one you hold? Answers whether it is
  // set, its length and the first 8 hex of its SHA-256: enough to compare with a hash computed on
  // your own machine, never enough to recover or use the token.
  if (String(req.query?.mcpcheck || '') === '1') {
    const t = String(process.env[MCP_TOKEN_ENV] || '').trim();
    return res.status(200).json({ configured: t.length > 0, length: t.length, long_enough: t.length >= MCP_TOKEN_MIN,
      sha256_prefix: t ? createHash('sha256').update(t).digest('hex').slice(0, 8) : null,
      recent: kvConfigured() ? ((await kvGetJson(MCP_LOG_KEY).catch(() => null)) || []).slice(-20).reverse() : null });
  }
  if (!kvConfigured()) return res.status(200).json({ available: false, ok: false, reason: 'KV not configured' });

  if (req.query?.feed != null) return serveFeed(req, res);

  // The feed's slug, for the signed-in Gamma tab to show. Minted on first ask; POST &rotate=1
  // replaces it, which retires the old URL at once.
  if (String(req.query?.feedslug || '') === '1') {
    if (!(await authorised(req))) return res.status(401).json({ ok: false, error: 'unauthorised', why: refusalReason(req) });
    let cur = await kvGetJson(FEED_SLUG_KEY).catch(() => null);
    const rotate = req.method === 'POST' && String(req.query?.rotate || '') === '1';
    if (!cur?.slug || rotate) {
      cur = { slug: randomBytes(32).toString('base64url'), createdAt: new Date().toISOString() };
      if (!(await kvSetJson(FEED_SLUG_KEY, cur))) return res.status(500).json({ ok: false, error: 'could not store the slug' });
    }
    return res.status(200).json({ ok: true, createdAt: cur.createdAt, paths: FEED_TICKERS.map(t => `/api/g/${cur.slug}/${t}`) });
  }

  if (String(req.query?.snapshot || '') === '1') {
    const symbols = String(req.query?.symbols || '').trim()
      ? String(req.query.symbols).split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
      : GEX_SYMBOLS;
    // `session` lets the workflow be explicit rather than relying on the clock; `dry=1` computes
    // and returns without writing, which is what the panel's live-refresh button uses.
    const session = ['open', 'close'].includes(String(req.query?.session || '')) ? String(req.query.session) : null;
    // The CBOE cross-check runs by default and can be turned off for a fast read — it is a 4-5MB
    // CDN fetch, which is cheap but not free, and a caller that only wants the flip should not pay
    // for a second opinion it is going to ignore.
    const compare = String(req.query?.compare ?? '') !== '0';
    const dry = req.query?.dry === '1';
    const out = await captureGex({ symbols, dry, session, compare });
    // The panel's fallback rung — Yahoo, when the settled book cannot answer. Kept the same way as
    // the settled recompute (LAST_RECOMPUTE_KEY), for the same reason; a scheduled capture writes
    // the series itself and has nothing to keep.
    if (dry && out?.ok && await authorised(req)) {
      for (const r of out.results || []) {
        const rec = recomputeRecord(r.symbol, r);
        if (rec) { try { await kvSetJsonEx(LAST_RECOMPUTE_KEY(r.symbol), rec, LAST_RECOMPUTE_TTL_SEC); } catch { /* the board still returns */ } }
      }
    }
    return res.status(200).json(out);
  }

  // GET /api/gex?settled=1&symbol=QQQ[&spot=716.5]  — today's settled book, recomputed at a spot.
  //
  // THE PANEL'S REFRESH BUTTON HAD NOTHING GOOD TO CALL. It used ?snapshot=1&dry=1, which reads
  // Yahoo — and Yahoo serves NO open interest before the US open, so the one time of day a trader
  // reaches for a fresh gamma map was the one time it could not produce one, and the panel fell
  // back to repricing yesterday's stored chain. This reads OCC's settled open interest against
  // CBOE's implied-vol surface and recomputes gamma here at whatever spot is passed in, so a
  // refresh at 08:00 and one at 15:00 both describe today's book at the price it is trading at.
  //
  // It never writes. captureGex owns the daily series, and a second writer racing it would put two
  // vintages under one date.
  // ── THE ROLL LOG ──────────────────────────────────────────────────────────
  // `?rolls=1` reads what has been observed; `&probe=1` also TAKES an observation first, which is
  // the cheap way to sample overnight: it fetches OCC and fingerprints it and does not solve a
  // gamma profile, so it costs one 280KB fetch rather than a full recompute.
  //
  // Every settled recompute records too — this endpoint exists so a sampler does not have to pay
  // for a map nobody is going to look at.
  // ── DID WHAT WENT OUT HOLD UP? ────────────────────────────────────────────
  // The loop this closes is not "when does OCC publish" — the rung has never trusted a clock, it
  // asks the file whether it rolled. It is "has the brief ever gone out on a book that was not
  // sound, and would anyone know". Every verdict is recorded now; this reads them back.
  if (String(req.query?.health || '') === '1') {
    const days = Math.min(180, Math.max(1, Number(req.query?.days) || 30));
    const [log, rolls] = await Promise.all([
      kvGetJson(OCC_HEALTH_KEY).then(v => v || []).catch(() => []),
      kvGetJson(OCC_ROLL_LOG_KEY).then(v => v || []).catch(() => []),
    ]);
    // Per root as well as combined — transitionRuns partitions by symbol internally, but a caller
    // reading one root's write shape should not have to trust that it did.
    const runs = transitionRuns(rolls);
    return res.status(200).json({
      mode: 'health', at: new Date().toISOString(), days,
      // The whole book, and each symbol, because one symbol failing while the other is fine is a
      // different problem from both failing and a combined rate hides it.
      overall: healthSummary(log, { days }),
      bySymbol: Object.fromEntries(GEX_SYMBOLS.map(s2 => [s2, healthSummary(log, { days, symbol: s2 })])),
      // ATOMIC OR PROGRESSIVE, with no sampling grid — a settlement written in one step produces
      // one transition, one written in several produces several, and the span between the first
      // and last is the floor OCC_CONFIRM_MIN has to clear.
      write: runs,
      writeBySymbol: Object.fromEntries(GEX_SYMBOLS.map(s2 => [s2, transitionRuns(rolls, { symbol: s2 })])),
      confirmMin: confirmMinVerdict(runs, OCC_CONFIRM_MIN),
      rolls: rollSummary(rolls, { againstUtc: '12:42' }),
    });
  }

  if (String(req.query?.rolls || '') === '1') {
    const syms = String(req.query?.symbols || req.query?.symbol || '').trim()
      ? String(req.query.symbols || req.query.symbol).split(',').map(x => x.trim().toUpperCase()).filter(Boolean)
      : GEX_SYMBOLS;
    const probed = [];
    if (String(req.query?.probe || '') === '1') {
      for (const sym of syms) { try { probed.push(await observeRoll(sym)); } catch (e) { probed.push({ symbol: sym, ok: false, why: String(e?.message || e) }); } }
    }
    const log = (await kvGetJson(OCC_ROLL_LOG_KEY)) || [];
    const against = /^\d{2}:\d{2}$/.test(String(req.query?.against || '')) ? String(req.query.against) : '12:42';
    return res.status(200).json({
      mode: 'rolls', at: new Date().toISOString(), against,
      probed: probed.length ? probed : undefined,
      // Per symbol AND combined: the two roots publish together on every observation so far, and a
      // summary that merged them would hide the night they did not.
      summary: Object.fromEntries(syms.map(s => [s, rollSummary(log, { symbol: s, againstUtc: against })])),
      log,
    });
  }

  // GET /api/gex?custom=INTC[&spot=110.5] — ONE NAME, ON DEMAND, TO PLAN A TRADE. The settled rung
  // (OCC open interest on CBOE's vol surface, repriced at the live spot) run over a typed root.
  // Nothing is stored beyond a chain cache that expires: no series, no snapshot, no pre-read, no
  // Discord, no roll or health bookkeeping — those describe the book pair. Gated, because which
  // names are being planned is the book, and because an open relay to a 4.5MB CDN document is not
  // something a public route should be.
  const customQ = String(req.query?.custom || '').trim().toUpperCase();
  if (customQ) {
    if (!(await authorised(req))) return res.status(401).json({ ok: false, error: 'unauthorised', why: refusalReason(req) });
    if (!CUSTOM_ROOT_RE.test(customQ)) return res.status(200).json({ ok: false, symbol: customQ, reason: 'not an options root — letters only, up to six (the underlying, not the contract)' });
    const spotIn = Number(req.query?.spot);
    let spot = Number.isFinite(spotIn) && spotIn > 0 ? spotIn : null;
    if (spot == null) {
      try {
        const [q] = await getQuotes([customQ], { prepost: true });
        const shut = marketState(customQ) !== 'open';
        const px = (shut && q?.ext && !q.ext.stale && q.ext.price > 0) ? q.ext.price : q?.price;
        spot = Number.isFinite(+px) && +px > 0 ? +px : null;
      } catch { spot = null; }
    }
    try {
      const out = await settledGex(customQ, { spot, record: false });
      return res.status(200).json({ mode: 'custom', symbol: customQ, kind: instrumentKind(customQ), at: new Date().toISOString(), ...out });
    } catch (e) {
      return res.status(200).json({ ok: false, symbol: customQ, reason: String(e?.message || e) });
    }
  }

  if (String(req.query?.settled || '') === '1') {
    const syms = String(req.query?.symbols || req.query?.symbol || '').trim()
      ? String(req.query.symbols || req.query.symbol).split(',').map(x => x.trim().toUpperCase()).filter(Boolean)
      : GEX_SYMBOLS;
    const bad = syms.filter(x => !GEX_SYMBOLS.includes(x));
    if (bad.length) return res.status(400).json({ error: `unknown symbol ${bad.join(', ')}` });
    // The spot is the server's (resolveSpot, above). An explicit ?spot= still wins — it is how a
    // caller asks "what would the book look like at X" — but nothing has to pass one.
    const spotIn = Number(req.query?.spot);
    const spotFor = async (sym) => (Number.isFinite(spotIn) && spotIn > 0 && syms.length === 1) ? spotIn : resolveSpot(sym);
    const results = [];
    // KEPT, NOT WRITTEN INTO THE SERIES. A signed-in recompute of the book pair is saved on its own
    // expiring key so the next page load shows it rather than the older scheduled capture (see
    // LAST_RECOMPUTE_KEY). Signed-in only: an anonymous caller does not get to decide what the
    // panel opens on.
    // A what-if (?spot=) is never kept: it is a board at a price nobody is trading at.
    const keep = !(Number.isFinite(spotIn) && spotIn > 0) && await authorised(req);
    // BEFORE OCC'S FILE FOR TODAY ROLLS (~06:00–07:00 ET) a recompute is yesterday's book repriced:
    // it is returned with staleReason 'oi_not_published' and NOT kept, so the stored board stays
    // yesterday's. The pre-open workflow (gex-recompute.yml) relies on this at 07:15 ET.
    for (const sym of syms) {
      // The stored row's expiries, so the settled map covers the same book as the series it sits
      // beside — otherwise the two disagree about the flip for reasons that are about coverage.
      const stored = await readGex(sym).catch(() => null);
      const out = await settledGex(sym, {
        spot: await spotFor(sym),
        expiries: stored?.latest?.expiries || null,
      });
      const staleReason = oiStaleReason(out?.vintage);
      results.push({ symbol: sym, ...out, ...(staleReason ? { staleReason } : {}) });
      const rec = keep && !staleReason ? recomputeRecord(sym, { ...out, mode: 'settled' }) : null;
      if (rec) { try { await kvSetJsonEx(LAST_RECOMPUTE_KEY(sym), rec, LAST_RECOMPUTE_TTL_SEC); } catch { /* the board still returns */ } }
    }
    return res.status(200).json({ mode: 'settled', at: new Date().toISOString(), results });
  }

  const symbol = String(req.query?.symbol || 'QQQ').toUpperCase();
  if (!GEX_SYMBOLS.includes(symbol)) return res.status(400).json({ error: `unknown symbol ${symbol}` });
  const stored = await readGex(symbol);
  const rec = await kvGetJson(LAST_RECOMPUTE_KEY(symbol)).catch(() => null);
  return res.status(200).json({ ...stored, recompute: newerRecompute(stored.latest, rec) });
}
