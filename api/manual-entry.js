// api/manual-entry.js — manual/derived series that have no keyless feed.
//   • fedPath  (P6.2) — 30-day fed funds futures (ZQ). No free feed exists: IBKR has no
//     stateless auth and its futures data is ~20-min delayed, so this is a daily hand entry.
//   • intervention (F3) — coordinated-FX-intervention flag. Manual because no keyless feed
//     reports intervention in real time; MOF/BOK confirmations arrive after the fact, so an
//     inferred flag would manufacture certainty from a wide daily move.
//   • oasRecon (P2.5) — the OAS/HYG reconciliation log. Establishes whether the live proxy is
//     actually predictive, so the card can be demoted or dropped on evidence rather than
//     trusted by habit.
// Both live in one endpoint to stay inside the 12-function Hobby cap (this is the 8th).

import { kvGetJson, kvSetJson, kvConfigured, CONSOLE_KEY, FLEX_NOTE_KEY } from '../lib/kv.js';
import { prereadStatus } from '../lib/preread.js';
import { localDateIn, localMinutesOfDay } from '../lib/sessions.js';
import { UNIVERSE } from '../data/universe.js';
// The endpoint that posts the briefs owns this key; read-only here.
const PREREAD_LAST_KEY = 'dvcap:preread:last:v1';
import { appendDecision, overrideStats, DECISIONS_KEY, ACTIONS } from '../lib/decisions.js';
import { GUARD_STATES } from '../lib/guards.js';
import { sideOf } from '../lib/side.js';
import { PLAUSIBLE_SEC_YIELD, parseYieldValue, parseIssuerDate } from '../lib/fundYield.js';
import { SEC_YIELD_TICKERS } from '../lib/cashyield.js';
import { authorised, hasSessionCookie, refuse } from '../lib/apiauth.js';
import { fetchHlAccount, fetchHlSpot, fetchSpotContext, fetchHyperliquid } from '../lib/hyperliquid.js';
import { fetchWallets } from '../lib/wallet.js';

const DATA_PATH = 'data/manual_entry.json';

// ── Where each kind of state lives ───────────────────────────────────────────
// GIT (data/manual_entry.json): curated macro inputs — fedPath, oasRecon, intervention, recession
//   overrides, southbound. Version history is a FEATURE here: you want to see when a recession
//   override changed and what it was before.
// REDIS (Upstash, lib/kv.js): the trade console — setups, levels, fills, settings.
//   Personal, high-churn, and a permanent diffable history of a real book is a liability, not a
//   feature. Redis writes replace; nothing accumulates.
// Until the Upstash env vars exist, console reads fall back to whatever is already in the git
// store (so nothing is lost on migration) and writes stay local to the browser.
async function readConsole(gitFallback) {
  if (kvConfigured()) {
    const kv = await kvGetJson(CONSOLE_KEY);
    if (kv) return { ...kv, _store: 'kv' };
    // First run after wiring Upstash: nothing in Redis yet, so serve (and thereby migrate) the
    // copy already committed to git. The next save writes it to Redis.
    if (gitFallback) return { ...gitFallback, _store: 'git-fallback' };
    return { rows: [], settings: {}, _store: 'kv-empty' };
  }
  return { ...(gitFallback || { rows: [], settings: {} }), _store: 'git' };
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dvcap-manual-entry',
  };
}

async function readStore() {
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${DATA_PATH}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders() });
  const emptyConsole = () => ({ rows: [], settings: {} });
  if (!r.ok) return { store: { fedPath: { latest: null, series: [] }, oasRecon: [], intervention: null, recession: {}, secYields: {}, console: emptyConsole() }, sha: null };
  const meta = await r.json();
  let store = { fedPath: { latest: null, series: [] }, oasRecon: [], intervention: null, recession: {}, secYields: {}, console: emptyConsole() };
  try { store = JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8')); } catch { /* default */ }
  store.fedPath ||= { latest: null, series: [] };
  store.fedPath.series ||= [];
  store.oasRecon ||= [];
  store.intervention ??= null;
  store.secYields ||= {};
  store.recession ||= {};   // manual overrides for the Wall Street recession sources
  store.southbound ||= { series: [] };   // HKEX Southbound Stock Connect daily flow (hand-entered)
  store.southbound.series ||= [];
  store.console ||= emptyConsole();       // trade console — setups / positions / settings
  store.console.rows ||= [];
  store.console.settings ||= {};
  return { store, sha: meta.sha };
}

// ZQ is quoted as 100 − implied average fed funds for the contract month.
export function zqImpliedRate(price) {
  if (price == null || !Number.isFinite(+price)) return null;
  return +(100 - Number(price)).toFixed(4);
}
// Moves vs current EFFR, in 25bp increments. Sign carries direction: + = hikes priced.
export function zqMovesPriced(impliedRate, effr) {
  if (impliedRate == null || effr == null) return null;
  return +((impliedRate - effr) / 0.25).toFixed(2);
}

// ── Console (Tier 3) sanitizers ──────────────────────────────────────────────
// The console syncs its full state wholesale (the browser owns it); we bound every field so a
// synced payload can never bloat the committed store file. cs = capped string, cn = number-or-null.
const cs = (v, max = 200) => (v == null ? null : String(v).slice(0, max));
const cn = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
// v2 shape: a row is a SETUP or a POSITION, distinguished only by whether it has fills. Levels are
// watch targets (buy/sell/stop, optionally a zone); fills are the trade record. Everything else —
// quantity, average cost, realised P&L, open vs closed — is DERIVED client-side by
// lib/positions.js, so nothing computed is trusted from the payload.
function sanitizeLevel(l) {
  if (!l || typeof l !== 'object') return null;
  const kind = ['buy', 'sell', 'stop'].includes(l.kind) ? l.kind : null;
  if (!kind) return null;
  const at = cn(l.at);
  if (at == null) return null;                       // a level without a price is not a level
  return { id: cs(l.id, 16) || Math.random().toString(36).slice(2, 8), kind, at, to: cn(l.to), note: cs(l.note, 160) };
}
function sanitizeFill(f) {
  if (!f || typeof f !== 'object') return null;
  const side = (f.side === 'buy' || f.side === 'sell') ? f.side : null;
  const qty = cn(f.qty), price = cn(f.price);
  if (!side || qty == null || qty <= 0 || price == null || price < 0) return null;
  return { id: cs(f.id, 16) || Math.random().toString(36).slice(2, 8), side, qty, price, date: cs(f.date, 12), note: cs(f.note, 200),
    // IBKR's own trade id, when the fill came from a statement rather than a keystroke. It is what
    // makes ingestion idempotent — a trade already carrying its id is never applied twice, which is
    // what allows the Flex query to use a 30-day window and heal a missed run.
    tradeId: cs(f.tradeId, 24) || null };
}
function sanitizeRow(r) {
  if (!r || typeof r !== 'object') return null;
  const sym = cs(r.symbol, 24);
  if (!sym) return null;
  return {
    id: cs(r.id, 48) || `${sym}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: sym.toUpperCase(),
    currency: /^[A-Z]{3}$/.test(String(r.currency || '').toUpperCase()) ? String(r.currency).toUpperCase() : 'USD',
    thesis: cs(r.thesis, 600),
    // Short label that distinguishes two trades in the SAME symbol (one archived, one open).
    trade: cs(r.trade, 40),
    // DIRECTION. Persisted rather than inferred: every P&L, R, and level-breach rule downstream
    // needs it, and the one thing it must never be re-derived from is where the stop sits — a
    // short's ordinary stop is above entry, which is exactly the geometry that reads as a
    // locked-in gain on a long. Absent means long, so every row written before this is unchanged.
    side: sideOf(r.side) ?? 'long',
    // Leverage, for a perp. Only meaningful on a margined venue, and only used to ESTIMATE a
    // liquidation price for a position that does not exist yet — a real one uses the exchange's
    // own figure. Bounded to what any venue offers so a typo cannot produce a plausible number.
    leverage: (Number.isFinite(+r.leverage) && +r.leverage >= 1 && +r.leverage <= 125) ? +r.leverage : null,
    // Contract multiplier (1 for shares, 100 for a US option). Money figures scale by it; prices
    // stay quoted, so an option archives at its premium rather than a per-contract dollar amount.
    multiplier: (Number.isFinite(+r.multiplier) && +r.multiplier > 0 && +r.multiplier <= 100000) ? +r.multiplier : 1,
    // Optional pinned FX rate for this row — units of its currency per 1 USD, matching the quote
    // convention. Absent means "use the live rate".
    fxRate: (Number.isFinite(+r.fxRate) && +r.fxRate > 0) ? +r.fxRate : null,
    // Futures and anything else held on margin: market value is notional, not capital committed,
    // so it is kept out of every weight and cash figure.
    margined: !!r.margined,
    // The contract this one replaced. A futures roll is one continuous trade that the broker has to
    // book as two contracts; this is how the console is told they are the same position. See
    // applyRolls in lib/positions.js — it is declared rather than inferred, because "sold one and
    // bought another the same day" is also what closing a trade and opening a different one looks
    // like.
    rolledFrom: cs(r.rolledFrom, 48) || null,
    // The IBKR cost basis for a position where the two accountings legitimately disagree — the
    // console is average-cost, IBKR reports the lots it actually matched, and after a partial exit
    // they diverge permanently (ARM: 331.56 here, 409.26 there). Recording the broker's number
    // accepts that difference; the daily reconciliation stops flagging it, and starts again the day
    // IBKR reports something other than this.
    costBasisAck: cn(r.costBasisAck),
    // The ticker the QUOTE feed knows this by, when it differs from the display symbol.
    quoteSymbol: cs(r.quoteSymbol, 24),
    sizeMode: (r.sizeMode === 'risk' || r.sizeMode === 'allocation') ? r.sizeMode : null,
    targetPct: cn(r.targetPct),
    tranches: cn(r.tranches),
    levels: Array.isArray(r.levels) ? r.levels.map(sanitizeLevel).filter(Boolean).slice(0, 12) : [],
    fills: Array.isArray(r.fills) ? r.fills.map(sanitizeFill).filter(Boolean).slice(0, 200) : [],
    tags: Array.isArray(r.tags) ? r.tags.map(t => cs(t, 24)).filter(Boolean).slice(0, 8) : [],
  };
}

// Bounded like every other stored shape. A decision arrives from the browser and is kept for ever,
// so nothing unbounded may enter it.
function sanitizeDecision(d) {
  const pick = ['at', 'id', 'symbol', 'side', 'positionSide', 'sizeMode', 'intent', 'regimeId'];
  const nums = ['takenQty', 'consideredQty', 'recommendedQty', 'overrideRatio', 'effPct', 'riskAtSize',
                'multiplier', 'stopAt', 'fillPrice', 'addNumber', 'priorBuys', 'unrealisedPctBefore', 'regimeMult'];
  const out = {};
  for (const k of pick) out[k] = cs(d[k], k === 'symbol' ? 24 : 48);
  for (const k of nums) out[k] = cn(d[k]);
  // THE ALLOWLIST IS THE POINT, so new fields have to be added here on purpose — a delete-list
  // would have let these through silently and would fail open on the next one. P1's guard states,
  // and what was actually done about them.
  out.action = ACTIONS.includes(d.action) ? d.action : 'opened';
  out.guardWorst = cs(d.guardWorst, 8);
  out.guardBreached = Array.isArray(d.guardBreached) ? d.guardBreached.map(x => cs(x, 24)).filter(Boolean).slice(0, 8) : null;
  // States only, and only ones this build knows about — an unrecognised id or a non-state value is
  // dropped rather than stored, so the log cannot be used to write arbitrary keys into Redis.
  out.guards = null;
  if (d.guards && typeof d.guards === 'object' && !Array.isArray(d.guards)) {
    const g = {};
    for (const [k, v] of Object.entries(d.guards)) {
      if (/^[a-zA-Z]{1,24}$/.test(k) && GUARD_STATES.includes(v)) g[k] = v;
    }
    out.guards = Object.keys(g).length ? g : null;
  }
  out.stopSet = !!d.stopSet;
  out.addToLoser = !!d.addToLoser;
  out.prevClosedWasWin = typeof d.prevClosedWasWin === 'boolean' ? d.prevClosedWasWin : null;
  out.warnings = Array.isArray(d.warnings) ? d.warnings.map(w => cs(w, 160)).filter(Boolean).slice(0, 6) : [];
  out.reason = cs(d.reason, 400);
  return out;
}

function sanitizeConsoleSettings(s) {
  if (!s || typeof s !== 'object') return {};
  const out = {
    alertsEnabled: !!s.alertsEnabled,
    equity: cn(s.equity), equityAsOf: cs(s.equityAsOf, 12), baseRiskPct: cn(s.baseRiskPct), targetPct: cn(s.targetPct),
    baseCurrency: /^[A-Z]{3}$/.test(String(s.baseCurrency || '').toUpperCase()) ? String(s.baseCurrency).toUpperCase() : 'USD',
    // The date from which the BROKER is the record of what was traded. Fills before it are whatever
    // the console already holds — mostly bulk averages that no individual order will ever match —
    // and are left alone. Set once, when trade ingestion is switched on.
    flexTradesFrom: cs(s.flexTradesFrom, 12),
  };
  if (s.sizing && typeof s.sizing === 'object') {
    out.sizing = {};
    for (const k of ['ref', 'inf', 'stag', 'def']) {
      const m = cn(s.sizing[k]);
      if (m != null) out.sizing[k] = Math.max(0, Math.min(3, m));   // clamp the multiplier to 0–3x
    }
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // THE MIDDLEWARE DOES NOT COVER THIS. It matches `/` only, so this route served the whole
    // trade console — fills, cost basis and settings.equity — to anyone who asked. See lib/apiauth.
    if (!(await authorised(req))) return refuse(res);
    if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
      return res.status(200).json({ fedPath: { latest: null, series: [] }, oasRecon: [], intervention: null, note: 'store not configured' });
    }
    try {
      const { store } = await readStore();
      const full = String(req.query?.decisions || '') === 'full';
      // THREE READS, ONE COPY OF THE METADATA. The perp book, the exchange's spot ledger and the
      // on-chain wallet are three different things about one address; the last two both need the
      // spot universe and its prices, which is a 270KB payload. Fetched once here and handed to
      // both, rather than each pulling its own.
      // ── THE HEAVY HALF IS OPT-IN ────────────────────────────────────────────
      // This block reads the perp book, the spot ledger and six chains of wallet, and it ran on
      // EVERY GET. The dashboard has eleven call sites on this endpoint and only the trade console
      // looks at any of it — the others want `intervention`, `fedPath`, `southbound`, `recession`
      // or `oasRecon`, and each of them was paying twelve Alchemy requests for a field it never
      // read. One page load could fire that several times over, from separate panels, in separate
      // serverless invocations.
      //
      // That is what exhausted the Alchemy allowance, and it is why the concurrency gate added
      // earlier did not save it: the gate bounds one invocation, and these were many.
      //
      // Absent the flag the response simply omits those fields. Every consumer already guards them
      // (`j?.wallet?.chains ? … : null`), because they were always allowed to fail.
      const wantLive = String(req.query?.live || '') === '1';
      const [hlAccount, spotCtx, hlMarkets] = wantLive
        ? await Promise.all([fetchHlAccount(), fetchSpotContext(), fetchHyperliquid()])
        : [null, null, null];
      const [hlSpot, wallet] = wantLive
        ? await Promise.all([
            fetchHlSpot({ context: spotCtx }),
            // Six chains, each one multicall, all in parallel. The perp marks price them: a ticker
            // lookup put ARB at 0.000629 against the venue's 0.16753, which is the same collision
            // this codebase already refuses for perps.
            fetchWallets({ spotMeta: spotCtx.meta, spotPrices: spotCtx.prices, markets: hlMarkets.markets }),
          ])
        : [null, null];
      const fullLog = full && kvConfigured() ? (await kvGetJson(DECISIONS_KEY)) || [] : null;
      // NOT edge-cached. This response now carries the trade console — real positions and cost
      // basis — and a shared s-maxage cache would both hold private state at the edge and serve a
      // stale book to a second device, defeating the cross-device sync this store exists for.
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({
        fedPath: { latest: store.fedPath.latest, series: store.fedPath.series.slice(-120) },
        oasRecon: store.oasRecon.slice(-180),
        intervention: store.intervention,
        secYields: store.secYields || {},
        recession: store.recession,
        southbound: { series: store.southbound.series.slice(-60) },
        // Console comes from Redis when configured, else the git copy (migration path).
        console: await readConsole(store.console),
        // Served alongside the console rather than inside them: the POST replaces the console
        // object wholesale, so a note kept in there would be wiped by the next browser save.
        flexSync: kvConfigured() ? await kvGetJson(FLEX_NOTE_KEY) : null,
        // ── REAL PERP POSITIONS, IF AN ADDRESS IS CONFIGURED ──────────────────────────────────
        // Served HERE and not from api/prices: this route is authenticated and `private,
        // no-store`, and a liquidation price is size and leverage restated. The price route is
        // edge-cached and shared, which is where the console's own positions were leaking from
        // until this morning.
        // Absent configuration this reports { configured: false } rather than an empty list — a
        // book of nothing and a book nobody asked for are different answers.
        hyperliquid: hlAccount,
        // ── AND WHAT THE WALLET HOLDS OUTRIGHT ────────────────────────────────────────────────
        // A perp is a position; spot is a balance, some of it locked in resting orders. Two
        // different animals, so two sections rather than one merged list. Served from this
        // authenticated, `private, no-store` route for the same reason the perp book is: a
        // holdings list is size, and size is one of the four quantities lib/tradecard.js exists
        // to keep off anything public.
        hyperliquidSpot: hlSpot,
        // ── AND WHAT THE WALLET HOLDS ON CHAIN ────────────────────────────────────────────────
        // A third thing again: coins at the address itself, across every chain it exists on —
        // which the exchange knows nothing about. Moving them onto Hyperliquid is a bridge
        // transaction, not a transfer between accounts, so a merged number would answer a
        // question nobody asks.
        wallet,
        // WHETHER THE BRIEFS ACTUALLY ARRIVED. Carried on the console's own payload so a missed
        // pre-read is visible where the reader already is, instead of being discovered days later
        // as an absence in a chat channel.
        preread: kvConfigured()
          ? prereadStatus((await kvGetJson(PREREAD_LAST_KEY)) || {}, { regions: UNIVERSE, localDateIn, localMinutesOfDay })
          : null,
        // Stats only, not the log. The console needs to show the pattern, not re-read every
        // decision ever taken on every page load. The full array is served ONLY when explicitly
        // asked for (?decisions=full), which the audit view does once when it is opened — it
        // carries symbols, sizes and fill prices, so it is opt-in rather than riding along on
        // every page load. The response is already `private, no-store`.
        decisions: kvConfigured() ? overrideStats(await kvGetJson(DECISIONS_KEY)) : null,
        ...(full && kvConfigured() ? { decisionLog: fullLog } : {}),
        kv: { configured: kvConfigured() },
      });
    } catch (e) {
      return res.status(200).json({ fedPath: { latest: null, series: [] }, oasRecon: [], intervention: null, error: String(e?.message || e) });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
  // The same signed session the GET requires. This was its own copy of the literal-cookie regex,
  // which is how a constant ends up in five files and gets fixed in one.
  if (!(await hasSessionCookie(req))) return refuse(res);
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return res.status(500).json({ error: 'GITHUB_TOKEN / GITHUB_REPO not configured' });
  }

  const { fedPath, oasRecon, intervention, recession, southbound, secYield, console: consoleIn, decision } = req.body || {};

  // ── ONE DECISION, APPENDED ──────────────────────────────────────────────────
  // Its own branch and its own key, deliberately. A decision is written the moment a fill is
  // recorded, which is not when the console syncs — and the console object is REPLACED wholesale on
  // sync, so a log kept inside it would be destroyed by the next save. Append-only, capped, and
  // never rewritten: the point of the log is that it says what was decided at the time.
  if (decision && typeof decision === 'object') {
    if (!kvConfigured()) return res.status(200).json({ decision: { stored: 'none' } });
    const log = await kvGetJson(DECISIONS_KEY);
    const next = appendDecision(log, sanitizeDecision(decision));
    const wrote = await kvSetJson(DECISIONS_KEY, next);
    return res.status(wrote ? 200 : 502).json({ decision: { stored: wrote ? 'kv' : 'failed', n: next.length } });
  }
  const { store, sha } = await readStore();
  const saved = [];

  // ── P6.2 fed path ──
  if (fedPath && fedPath.price != null) {
    const price = Number(fedPath.price);
    if (!Number.isFinite(price) || price <= 90 || price >= 101) {
      return res.status(422).json({ error: `ZQ price ${fedPath.price} is out of range — expected ~90–101 (100 minus the implied rate)` });
    }
    const date = String(fedPath.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const impliedRate = zqImpliedRate(price);
    const row = {
      date, contract: fedPath.contract || null, price, impliedRate,
      effr: fedPath.effr ?? null,
      movesPriced: zqMovesPriced(impliedRate, fedPath.effr ?? null),
      enteredAt: new Date().toISOString(),
    };
    store.fedPath.series = [...store.fedPath.series.filter(r => r.date !== date), row]
      .sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
    store.fedPath.latest = row;
    saved.push('fedPath');
  }

  // ── A FUND'S 30-DAY SEC YIELD, BY HAND ──
  // SGOV's is fetched from iShares. USFR's cannot be: WisdomTree sits behind a Cloudflare bot
  // challenge that answers 403 to every automated route — the product page, the API path and the
  // holdings CSV alike. It is not a dead URL; it loads fine in a browser, which is exactly the case
  // manual entry exists for.
  //
  // VALIDATED THE SAME WAY THE FETCHED ONE IS. A hand-typed figure is not more trustworthy than a
  // scraped one, and the digit most likely to be wrong is the one a person just typed. The bounds
  // are lib/fundYield.js's, so both routes refuse the same numbers.
  if (secYield && secYield.ticker) {
    const ticker = String(secYield.ticker).trim().toUpperCase();
    if (!SEC_YIELD_TICKERS.includes(ticker)) {
      return res.status(422).json({ error: `${ticker} is not a fund this card tracks — expected one of ${SEC_YIELD_TICKERS.join(', ')}` });
    }
    // Parsed, not Number()'d — so the API accepts "3.68%" exactly as the form does. Two entry
    // paths that disagree about what a yield looks like is two rules to remember.
    const value = parseYieldValue(secYield.value);
    if (!Number.isFinite(value) || value < PLAUSIBLE_SEC_YIELD.lo || value > PLAUSIBLE_SEC_YIELD.hi) {
      return res.status(422).json({ error: `${secYield.value} is not a plausible 30-day SEC yield — expected ${PLAUSIBLE_SEC_YIELD.lo}–${PLAUSIBLE_SEC_YIELD.hi}%` });
    }
    // The AS-OF IS THE FUND'S, NOT TODAY'S. The issuer publishes a figure dated to a business day
    // that is usually a day or two back, and stamping it with the moment it was typed would make a
    // two-day-old number look current — the exact defect this whole card is being fixed for.
    // Any of the forms the issuer pages print, normalised to ISO here.
    const asOf = parseIssuerDate(secYield.asOf) || '';
    if (!asOf) {
      return res.status(422).json({ error: `as-of "${secYield.asOf}" is not a date — copy the "as of" shown beside the yield on the issuer's page` });
    }
    const today = new Date().toISOString().slice(0, 10);
    if (asOf > today) return res.status(422).json({ error: `as-of ${asOf} is in the future` });
    store.secYields = { ...(store.secYields || {}), [ticker]: {
      value: +value.toFixed(2), asOf, enteredAt: new Date().toISOString(),
      // The bill rate on the figure's own date, so the proxy reconciliation measures the MODEL and
      // not the bill having moved since — same reason SEC_YIELDS carries dtb3AtAsOf.
      dtb3AtAsOf: Number.isFinite(Number(secYield.dtb3AtAsOf)) ? Number(secYield.dtb3AtAsOf) : null,
    } };
    saved.push('secYields');
  }

  // ── P2.5 reconciliation ──
  // Appended when a delayed OAS observation finally publishes: compare its direction to what
  // the HYG proxy said on that same date.
  if (Array.isArray(oasRecon) && oasRecon.length) {
    for (const r of oasRecon) {
      if (!r?.date) continue;
      const row = {
        date: String(r.date).slice(0, 10),
        hyg_chg: r.hyg_chg ?? null,
        hyg_qqq_divergence: r.hyg_qqq_divergence ?? null,
        oas_actual_chg: r.oas_actual_chg ?? null,
        direction_agreed: (r.hyg_chg != null && r.oas_actual_chg != null)
          // HYG DOWN implies credit stress => OAS should WIDEN. Opposite signs = agreement.
          ? (Math.sign(r.hyg_chg) !== Math.sign(r.oas_actual_chg))
          : null,
        loggedAt: new Date().toISOString(),
      };
      store.oasRecon = [...store.oasRecon.filter(x => x.date !== row.date), row]
        .sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
    }
    saved.push('oasRecon');
  }

  // ── F3 intervention flag ──
  // Tested with != null rather than truthiness: this is a TOGGLE, so an explicit false must be
  // storable. A truthy test would accept turning it on and silently no-op turning it off.
  if (intervention != null) {
    const active = !!intervention.active;
    const since = intervention.since ? String(intervention.since).slice(0, 10) : null;
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return res.status(422).json({ error: `intervention.since '${intervention.since}' is not YYYY-MM-DD` });
    }
    store.intervention = active
      ? { active: true, since: since || new Date().toISOString().slice(0, 10),
          note: intervention.note ? String(intervention.note).slice(0, 300) : null,
          setAt: new Date().toISOString() }
      // Clearing records WHEN it was cleared and what window it closed. A flag that simply
      // vanishes leaves the episode unauditable afterwards, and the window is the useful part.
      : { active: false, since: null, note: null, clearedAt: new Date().toISOString(),
          previousSince: store.intervention?.since ?? null };
    saved.push(active ? 'intervention:on' : 'intervention:off');
  }

  // ── Recession-source manual overrides ──
  // Keyed by the source name exactly as it appears in RECESSION_SOURCES, so an entry here
  // replaces that row's probability/as-of on the client. A cleared entry (clear:true) removes
  // the override and lets the static/auto value show through again — the same toggle discipline
  // as the intervention flag, so an override can be un-set rather than only overwritten.
  if (recession && recession.name) {
    const name = String(recession.name).slice(0, 80);
    if (recession.clear) {
      delete store.recession[name];
      saved.push('recession:clear:' + name);
    } else {
      const asOf = recession.asOf ? String(recession.asOf).slice(0, 10) : null;
      if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
        return res.status(422).json({ error: `recession.asOf '${recession.asOf}' is not YYYY-MM-DD` });
      }
      const prob = recession.probability != null ? String(recession.probability).slice(0, 16) : null;
      if (prob != null && !/\d/.test(prob)) {
        return res.status(422).json({ error: `recession.probability '${recession.probability}' has no number to parse` });
      }
      store.recession[name] = {
        probability: prob,
        asOf,
        notes: recession.notes ? String(recession.notes).slice(0, 500) : null,
        enteredAt: new Date().toISOString(),
      };
      saved.push('recession:' + name);
    }
  }

  // ── Southbound Stock Connect daily flow ──
  // One row per HK trading day: aggregate net (HKD bn, + = net buy) and the SMIC 0981.HK net.
  // Upsert by date so a re-entry corrects rather than duplicates; the client computes 5d/20d
  // trends from the series. No live HKEX feed is clean enough to trust — hand-entered like KOFIA.
  if (southbound && southbound.date) {
    const date = String(southbound.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(422).json({ error: `southbound.date '${southbound.date}' is not YYYY-MM-DD` });
    }
    const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
    const row = {
      date,
      aggregateNet: num(southbound.aggregateNet),   // HKD bn — daily Southbound net buy (a flow)
      smicHolding: num(southbound.smicHolding),     // SMIC 0981.HK Southbound holding, % of issued (a LEVEL, read off CCASS)
      notes: southbound.notes ? String(southbound.notes).slice(0, 300) : null,
      enteredAt: new Date().toISOString(),
    };
    if (row.aggregateNet == null && row.smicHolding == null) {
      return res.status(422).json({ error: 'southbound needs at least an aggregateNet or smicHolding number' });
    }
    store.southbound.series = [...store.southbound.series.filter(r => r.date !== date), row]
      .sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
    saved.push('southbound:' + date);
  }

  // ── Console (Tier 3) — full-state sync, to REDIS not git ──
  // The browser owns the console state and syncs the whole object; we replace wholesale (bounded
  // by the sanitizers + slice caps) rather than upserting rows. Absent sub-keys keep what's stored,
  // so a settings-only save doesn't wipe the watchlist. This deliberately does NOT touch the git
  // store — a real book's positions and cost basis should not accrue permanent version history.
  let consoleResult = null;
  if (consoleIn && typeof consoleIn === 'object') {
    const prev = await readConsole(store.console);
    const rows = Array.isArray(consoleIn.rows)
      ? consoleIn.rows.map(sanitizeRow).filter(Boolean).slice(0, 200)
      : (prev.rows || []);
    const settings = consoleIn.settings ? sanitizeConsoleSettings(consoleIn.settings) : (prev.settings || {});
    const payload = { rows, settings, updatedAt: new Date().toISOString() };

    if (kvConfigured()) {
      const ok = await kvSetJson(CONSOLE_KEY, payload);
      consoleResult = ok ? { stored: 'kv' } : { stored: 'failed', error: 'Redis write failed — state kept locally in your browser' };
    } else {
      consoleResult = { stored: 'none', error: 'cross-device sync not configured (KV_REST_API_URL / KV_REST_API_TOKEN unset) — saved locally in this browser only' };
    }
    if (consoleResult.stored === 'kv') saved.push('console→kv');

    // Push the Discord card the moment the book changes. Awaited rather than fired and forgotten,
    // because a serverless function is frozen the instant it responds and a detached promise would
    // simply never run — but wrapped, because a Discord outage must not turn a successful save into
    // a failed one. The console is the record; the card is a notification about it.
    if (consoleResult.stored === 'kv') {
      try {
        const { refresh } = await import('./tradecard.js');
        const proto = req.headers['x-forwarded-proto'] || 'https';
        consoleResult.discord = await refresh(`${proto}://${req.headers.host}`);
      } catch (e) {
        console.error('tradecard refresh after save', e?.message || e);
        consoleResult.discord = { error: 'card refresh failed — the save itself is fine' };
      }
    }
  }

  // A console-only save has nothing to commit to git — return the KV result directly.
  const gitSaves = saved.filter(s => s !== 'console→kv');
  if (!gitSaves.length) {
    if (consoleResult) {
      return res.status(consoleResult.stored === 'failed' ? 502 : 200)
        .json({ ok: consoleResult.stored === 'kv', console: consoleResult });
    }
    return res.status(400).json({ error: 'nothing to save' });
  }

  // Console state is owned by Redis — strip it so a macro save never re-commits a real book.
  if (kvConfigured()) delete store.console;
  const content = Buffer.from(JSON.stringify(store, null, 2) + '\n', 'utf8').toString('base64');
  const w = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${DATA_PATH}`, {
    method: 'PUT', headers: ghHeaders(),
    body: JSON.stringify({
      message: `Manual entry — ${gitSaves.join(', ')} @ ${new Date().toISOString().slice(0, 10)}`,
      content, branch: process.env.GITHUB_BRANCH || 'main', ...(sha ? { sha } : {}),
    }),
  });
  if (!w.ok) return res.status(502).json({ error: 'GitHub commit failed', detail: (await w.text()).slice(0, 300) });
  return res.status(200).json({ ok: true, saved, console: consoleResult, fedPath: store.fedPath.latest, reconRows: store.oasRecon.length });
}
