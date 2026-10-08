// api/atr.js — daily ATR per symbol, for the pre-trade guard panel.
//
// SEPARATE FROM /api/prices ON PURPOSE. Price is a 2-minute number and the console refetches it
// on every symbol change; ATR is a DAILY one computed from a year of bars. Putting it on the hot
// path would mean pulling 250 bars per symbol every couple of minutes to recompute a figure that
// cannot have moved. This route caches for six hours and serves last-good for a day.
//
// FUTURES: pass the SPECIFIC CONTRACT (MGCZ26=F), never the continuous symbol (GC=F). A roll gap
// is a discontinuity between two different instruments and true range scores it as a real day's
// move — measured, it inflates ATR to 2.4x on the day and is still a third too wide a trading
// month later, which is exactly the month the new contract is being sized in.
import { yahooDailyOHLCDetailed, yahooDailyCloses, yahooFirstHour } from '../lib/yahoo.js';
import { fetchSqueezeGex } from '../lib/squeeze.js';
import { atrSummary, ATR_PERIOD } from '../lib/atr.js';
import { FAMILIES, MULTIPLIER, familyOf, parentFamily, isIndexFamily, contractMonths, frontMonth } from '../lib/futuresContracts.js';
import { kvGetJson, kvSetJsonEx, kvConfigured } from '../lib/kv.js';
import holidays from '../data/holidays.json' with { type: 'json' };
import { buildCta } from '../lib/ctaBook.js';
import { readBreakLog, updateBreakLog } from '../lib/ratioBreakLog.js';
import { fetchEarningsHistory } from '../lib/earnings.js';
import { earningsReactions } from '../lib/holdTypes.js';
import { lastSettledSession } from '../lib/ratios.js';
import { authorised, refusalReason } from '../lib/apiauth.js';


// ── ?future=CL — A CONTRACT FAMILY, RESOLVED ─────────────────────────────────
// The months still trading, each with the feed's last close, the exchange's last trading day and
// the roll-by; the front month named rather than assumed; the ATR off the continuous contract.
// Cached ten minutes per family, because it is six feed calls and the answer does not move faster.
// The feed has no expiry metadata for a dated month, so the dates come from the exchange rules in
// lib/futuresContracts.js, each tested against a known contract.
const FUTURE_KEY = (fam) => `dvcap:futures:v1:${fam}`;
const FUTURE_TTL_S = 10 * 60;
async function resolveFuture(raw, p) {
  const fam = familyOf(raw);
  if (!fam) {
    // Not a known family: say what the feed makes of it, and let the caller set a multiplier.
    const d = await yahooDailyOHLCDetailed(String(raw).toUpperCase(), '1y').catch(() => null);
    return { ok: false, reason: 'unknown futures family — set the contract multiplier by hand', symbol: String(raw).toUpperCase(),
             name: d?.name ?? null, quoteType: d?.quoteType ?? null, atr: d?.ok ? atrSummary(d.bars, p) : null };
  }
  if (kvConfigured()) {
    try { const c = await kvGetJson(FUTURE_KEY(fam)); if (c?.at && Date.now() - Date.parse(c.at) < FUTURE_TTL_S * 1000) return { ...c, cache: 'kv' }; } catch { /* a miss */ }
  }
  const info = FAMILIES[fam];
  const today = new Date().toISOString().slice(0, 10);
  const months = contractMonths(fam, { today, count: 5, holidays: holidays.US?.closed || [] });
  const priced = [];
  for (const m of months) {
    if (!m.symbol) { priced.push({ ...m, price: null }); continue; }
    const d = await yahooDailyOHLCDetailed(m.symbol, '5d').catch(() => null);
    priced.push({ ...m, price: d?.ok ? d.bars.at(-1)?.close ?? null : null, priceDate: d?.ok ? d.bars.at(-1)?.date ?? null : null, name: d?.name ?? null });
    await new Promise(r => setTimeout(r, 120));
  }
  // The ATR off the continuous front contract, which is what the sizer's range is measured on.
  const contSym = `${info.alias || fam}=F`;
  const cont = await yahooDailyOHLCDetailed(contSym, '1y').catch(() => null);
  const atr = cont?.ok ? atrSummary(cont.bars, p) : null;
  const front = frontMonth(priced.filter(m => m.price != null)) || frontMonth(priced);
  const out = {
    ok: true, family: fam, parent: parentFamily(fam), label: info.label, unit: info.unit, multiplier: MULTIPLIER[fam] ?? null,
    micro: info.micro ? { family: info.micro, multiplier: MULTIPLIER[info.micro] ?? null } : null,
    physical: !!info.physical, index: isIndexFamily(fam), exchange: info.exchange || FAMILIES[info.alias]?.exchange || null, note: info.note ?? null,
    months: priced, front, continuous: contSym, name: cont?.name ?? null,
    atr: atr ? { ...atr, name: cont?.name ?? null, quoteType: cont?.quoteType ?? null } : null,
    at: new Date().toISOString(),
  };
  if (kvConfigured()) { try { await kvSetJsonEx(FUTURE_KEY(fam), out, FUTURE_TTL_S); } catch { /* uncached is slower, not wrong */ } }
  return out;
}

const MAX_SYMBOLS = 24;   // the console asks for its open rows, not a universe

// ── ?history=1&tickers=A,B — DAILY CLOSES, FOR THE FACTOR PANEL ──────────────
// The one mode here that returns the bars rather than a summary of them: the console regresses the
// book's daily P&L on seven factors (lib/factorExposure.js) and needs each line's closes and each
// factor's. Closes only, as [date, close] pairs — the smallest shape that answers the question.
// Public like the rest of this route: a ticker's price history is not account state, and nothing
// here says what is held or how much. Three at a time: the keyless feed refuses a burst of thirty,
// and one at a time is thirty round trips.
const HISTORY_MAX = 40;
// 2y for the ratio cards (lib/ratios.js), whose 1-year percentile and 1-year z-score of 20-day
// changes need a full year of history BEFORE the first day they describe.
const HISTORY_RANGES = new Set(['3mo', '6mo', '1y', '2y']);
async function closeHistory(list, range) {
  const out = {};
  for (let i = 0; i < list.length; i += 3) {
    if (i > 0) await new Promise(r => setTimeout(r, 120));
    await Promise.all(list.slice(i, i + 3).map(async (sym) => {
      try {
        // Closes only, settled only: a finished day the feed left blank is filled from its official
        // close, and a session still trading is left out (lib/yahoo.js yahooDailyCloses).
        const d = await yahooDailyCloses(sym, range);
        out[sym] = d.ok
          ? { status: 'ok', closes: d.closes, name: d.name ?? null }
          : { status: d.status, httpStatus: d.httpStatus ?? null };
      } catch (e) {
        out[sym] = { status: 'fetch-failed', error: String(e?.name || e).slice(0, 60) };
      }
    }));
  }
  return out;
}

export default async function handler(req, res) {
  const { tickers, period, future, cta, history, range, ratios, reactions } = req.query || {};
  // ── ?reactions=SYM — THE LAST FOUR EARNINGS MOVES (the sizer's Event hold type) ──
  // Report dates from Nasdaq's earnings-surprise table; each move measured from daily closes
  // (lib/holdTypes.js earningsReactions). Market data only.
  if (reactions) {
    const sym = String(reactions).trim().toUpperCase().slice(0, 20);
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    const [h, d] = await Promise.all([fetchEarningsHistory(sym), yahooDailyOHLCDetailed(sym, '2y').catch(() => null)]);
    if (!h.ok) return res.status(200).json({ ok: false, symbol: sym, why: h.why });
    if (!d?.ok) return res.status(200).json({ ok: false, symbol: sym, dates: h.dates, why: `no daily bars — ${d?.status || 'fetch failed'}` });
    const r = earningsReactions(d.bars, h.dates);
    return res.status(200).json({ ok: r.reactions.length > 0, symbol: sym, ...r, dates: h.dates, source: `${h.source} dates · daily closes` });
  }
  // ── ?ratios=1 — THE RATIOS BREAK LOG (lib/ratioBreakLog.js) ──
  // GET: the stored log, market data only. &write=1 recomputes every break from two years of closes
  // and merges it in — the daily run (.github/workflows/ratio-breaks.yml), key-gated because it
  // writes.
  if (String(ratios || '') === '1') {
    if (String(req.query?.write || '') === '1') {
      res.setHeader('Cache-Control', 'private, no-store');
      if (!(await authorised(req))) return res.status(401).json({ ok: false, error: 'unauthorised', why: refusalReason(req) });
      try { return res.status(200).json(await updateBreakLog()); }
      catch (e) { return res.status(200).json({ ok: false, reason: String(e?.message || e).slice(0, 160) }); }
    }
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json(await readBreakLog());
  }
  // ── ?squeeze=1 — SqueezeMetrics' daily SPX dealer-gamma estimate (lib/squeeze.js), the last
  // ~2 years, for the Gamma tab's percentile tell. Market data only.
  if (String(req.query?.squeeze || '') === '1') {
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    const sq = await fetchSqueezeGex();
    return res.status(200).json({ ok: sq.ok, why: sq.why ?? null, source: sq.source ?? null, rows: sq.rows.slice(-520) });
  }
  if (String(history || '') === '1') {
    if (!tickers) return res.status(400).json({ error: 'Missing tickers' });
    const list = [...new Set(String(tickers).split(',').map(t => t.trim()).filter(Boolean))].slice(0, HISTORY_MAX);
    const rg = HISTORY_RANGES.has(String(range)) ? String(range) : '6mo';
    // &ohlc=1 — the whole bar, [date, open, high, low, close], for the Gamma tab's day measures
    // (lib/gexDays.js). US sessions settled only: a session still trading has no range yet.
    if (String(req.query?.ohlc || '') === '1') {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
      const settled = lastSettledSession();
      const out = {};
      for (const sym of list.slice(0, 6)) {
        const d = await yahooDailyOHLCDetailed(sym, rg).catch(() => null);
        out[sym] = d?.ok ? { status: 'ok', bars: d.bars.filter(b => b.date <= settled && b.open != null).map(b => [b.date, b.open, b.high, b.low, b.close]) } : { status: d?.status || 'fetch-failed' };
        // &firsthour=1: each session's 09:30–10:30 bar, today's included once it exists.
        if (String(req.query?.firsthour || '') === '1' && !sym.startsWith('^') && out[sym].status === 'ok') out[sym].firstHour = await yahooFirstHour(sym, '3mo');
      }
      return res.status(200).json({ range: rg, settled, at: new Date().toISOString(), symbols: out });
    }
    // An hour: the last bar is today's and moves until the close; the rest never will.
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
    return res.status(200).json({ range: rg, at: new Date().toISOString(), symbols: await closeHistory(list, rg) });
  }
  if (String(cta || '') === '1') {
    try {
      // NO stale-while-revalidate. Vercel's CDN serves a stale copy however old it is while it
      // revalidates, so the first request after a quiet night got the previous morning's book —
      // the 09:15 ET alert routine IS that first request, and on 2 Oct it was handed 1 Oct 12:57Z.
      // The book is already cached for 30 minutes in KV (lib/ctaBook.js); five more at the edge.
      res.setHeader('Cache-Control', 's-maxage=300');
      return res.status(200).json(await buildCta());
    } catch (e) {
      return res.status(200).json({ ok: false, reason: String(e?.message || e) });
    }
  }
  if (future) {
    const p0 = Number.isFinite(+period) && +period > 1 ? Math.trunc(+period) : ATR_PERIOD;
    try {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).json(await resolveFuture(String(future).trim(), p0));
    } catch (e) {
      return res.status(200).json({ ok: false, reason: String(e?.message || e) });
    }
  }
  if (!tickers) return res.status(400).json({ error: 'Missing tickers' });
  const list = [...new Set(String(tickers).split(',').map(t => t.trim()).filter(Boolean))].slice(0, MAX_SYMBOLS);
  const p = Number.isFinite(+period) && +period > 1 ? Math.trunc(+period) : ATR_PERIOD;

  const out = {};
  for (let i = 0; i < list.length; i++) {
    // Same 120ms stagger as api/prices.js — the keyless endpoint refuses a burst.
    if (i > 0) await new Promise(r => setTimeout(r, 120));
    const sym = list[i];
    try {
      const d = await yahooDailyOHLCDetailed(sym, '1y');
      if (!d.ok) { out[sym] = { status: d.status, httpStatus: d.httpStatus ?? null, error: d.error ?? null }; continue; }
      const s = atrSummary(d.bars, p);
      // EVERY SYMBOL GETS A KEY. Omitting it made "we could not reach Yahoo", "Yahoo has never
      // heard of this ticker" and "this listed three weeks ago" identical to the client, which
      // then had one sentence for all three. A status is always present; `atr` may be null.
      // The resolved name rides on every answer, ok or not: the thing to know about a wrong
      // instrument is its name, and a short history is the case where nothing else says it.
      const who = { name: d.name ?? null, quoteType: d.quoteType ?? null, exchange: d.exchange ?? null };
      out[sym] = s.atr != null
        ? { status: 'ok', ...s, ...who }
        : { status: 'short-history', bars: d.bars.length, needed: p + 1, period: p, ...who };
    } catch (e) {
      out[sym] = { status: 'fetch-failed', error: String(e?.name || e).slice(0, 60) };
    }
  }

  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
  return res.status(200).json(out);
}
