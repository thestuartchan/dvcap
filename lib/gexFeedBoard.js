// lib/gexFeedBoard.js — WHICH gamma board the feed, the connector and the Signal Board serve.
//
// Moved out of api/gex.js (20 Oct 2026) unchanged, so the Signal Board's conflict flag reads the SAME
// board the get_gamma_* tools serve (lib/signalBoard.js gammaView / tradeConflict) instead of fetching
// gamma a second, different way. api/gex.js imports it back; nothing about the selection changed.
// Market data only: options-chain aggregates for public tickers.
import { kvGetJson, kvSetJsonEx, kvSetNxEx } from './kv.js';
import { oiStaleReason, nyToday, FEED_RECOMPUTE_MIN } from './gexFeed.js';
import { readGex, settledGex, recomputeRecord, newerRecompute, LAST_RECOMPUTE_KEY, LAST_RECOMPUTE_TTL_SEC, YAHOO_SYMBOL } from './gexStore.js';
import { wallRoll } from './wallRoll.js';
import { getQuotes } from './quotes.js';
import { marketState } from './sessions.js';

// ── THE SPOT A RECOMPUTE IS PRICED AT ────────────────────────────────────────
// The panel was fetching /api/prices and passing the result. That route returns the REGULAR
// print and never an extended-hours one, so pre-open it handed back the PRIOR CLOSE — 716.31
// against a live pre-market 707.94 on 2026-09-10, a 1.2% error, labelled `spotSource: caller`
// and therefore reported in the footer as the live spot. So the spot is resolved here, with the
// same getQuotes({ prepost }) call the pre-read uses: one definition of the current price.
export async function resolveSpot(sym0) {
  // SPX is the index; its quote is ^GSPC. An index has no extended session, so outside the session
  // its last print is the close.
  const sym = YAHOO_SYMBOL[sym0] || sym0;
  try {
    const [q] = await getQuotes([sym], { prepost: true });
    // Outside regular hours the extended print is the live one and the regular is yesterday's.
    // Inside them it is the other way round, and a stale ext must never override a live regular.
    const shut = marketState(sym) !== 'open';
    const px = (shut && q?.ext && !q.ext.stale && q.ext.price > 0) ? q.ext.price : q?.price;
    return Number.isFinite(+px) && +px > 0 ? +px : null;
  } catch { return null; }   // settledGex falls back to CBOE's, and the footer names it
}

const FEED_LOCK_KEY = (sym) => `dvcap:gex:feed:lock:v1:${sym}`;

// The board to serve: a recompute no older than FEED_RECOMPUTE_MIN if there is one — the panel's
// or this route's, they share LAST_RECOMPUTE_KEY — else a new one if the lock allows (at most one
// per ticker per FEED_RECOMPUTE_MIN, however many callers), else the newest thing on hand.
// `recompute: false` never mints a new recompute: it serves a kept one or the stored board (the public
// Signal Board route reads this way, so it can never cost a chain fetch).
export async function feedBoard(sym, now = Date.now(), { recompute = true } = {}) {
  const out = await feedBoardOnly(sym, now, { recompute });
  return { ...out, wallRoll: out.stored?.series?.length ? wallRoll(out.stored.series, { today: nyToday(), symbol: sym }) : null };
}
async function feedBoardOnly(sym, now, { recompute = true } = {}) {
  const stored = await readGex(sym).catch(() => null);
  // The row a recompute is shown with on the tab: the stored row with the recompute's on top.
  // A recompute on YESTERDAY's open interest (OCC's file not yet rolled) is served but marked, and
  // is not written over the store — the board stays yesterday's until today's file lands.
  const fromRecord = (rec) => ({ board: { ...rec, row: { ...(stored?.latest || {}), ...rec.row } }, mode: 'live_recompute', asOf: rec.at,
    source: rec.mode === 'repriced' ? (rec.capturedAt || rec.at) : (rec.iv?.asOf || rec.at),
    staleReason: oiStaleReason(rec.vintage, new Date(now)) });
  const kept = await kvGetJson(LAST_RECOMPUTE_KEY(sym)).catch(() => null);
  const age = kept?.at ? now - Date.parse(kept.at) : Infinity;
  if (age < FEED_RECOMPUTE_MIN * 60000) return { ...fromRecord(kept), stored };
  if (recompute && await kvSetNxEx(FEED_LOCK_KEY(sym), { at: new Date(now).toISOString() }, FEED_RECOMPUTE_MIN * 60)) {
    try {
      const out = await settledGex(sym, { spot: await resolveSpot(sym), expiries: stored?.latest?.expiries || null });
      const rec = recomputeRecord(sym, { ...out, mode: 'settled' });
      if (rec) {
        if (!oiStaleReason(rec.vintage, new Date(now))) { try { await kvSetJsonEx(LAST_RECOMPUTE_KEY(sym), rec, LAST_RECOMPUTE_TTL_SEC); } catch { /* served anyway */ } }
        return { ...fromRecord(rec), stored };
      }
    } catch { /* fall through to what is on hand */ }
  }
  const rec = newerRecompute(stored?.latest, kept);
  if (rec) return { ...fromRecord(rec), stored };
  if (stored?.latest) {
    return { board: { row: stored.latest, levels: stored.levels, grid: stored.grid, byStrike: stored.byStrike,
                      decay: null, crossCheck: stored.latest.crossCheck ?? null },
             mode: 'settled', asOf: stored.latest.asOf, source: stored.latest.asOf, stored };
  }
  return { board: null };
}
