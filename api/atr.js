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
import { yahooDailyOHLCDetailed } from '../lib/yahoo.js';
import { atrSummary, ATR_PERIOD } from '../lib/atr.js';
import { FAMILIES, MULTIPLIER, familyOf, parentFamily, isIndexFamily, contractMonths, frontMonth } from '../lib/futuresContracts.js';
import { kvGetJson, kvSetJsonEx, kvConfigured } from '../lib/kv.js';
import holidays from '../data/holidays.json' with { type: 'json' };
import { CTA_MARKETS, ctaMarket, ctaSummary, nearestCut } from '../lib/cta.js';
import { marketState } from '../lib/sessions.js';

// ── ?cta=1 — THE TREND-FUND REPLICA ──────────────────────────────────────────
// Here rather than in a route of its own because the deployment is at Vercel's twelve-function
// cap, and this is the route that already turns public daily bars into a derived number. Two
// years of daily closes for six markets, one after another with a small gap (Yahoo throttles a
// burst), then lib/cta.js. Cached for half an hour: the model moves with the tape, but a trend
// fund's position does not change minute to minute and six chart fetches are not free.
const CTA_KEY = 'dvcap:cta:v1';
const CTA_TTL_S = 30 * 60;
async function buildCta() {
  if (kvConfigured()) {
    try { const c = await kvGetJson(CTA_KEY); if (c?.at && Date.now() - Date.parse(c.at) < CTA_TTL_S * 1000) return { ...c, cache: 'kv' }; } catch { /* a miss */ }
  }
  const markets = [];
  for (const [i, m] of CTA_MARKETS.entries()) {
    if (i > 0) await new Promise(r => setTimeout(r, 150));
    const d = await yahooDailyOHLCDetailed(m.symbol, '2y').catch(() => null);
    const base = { key: m.key, symbol: m.symbol, label: m.label, group: m.group, roll: m.roll };
    if (!d?.ok) { markets.push({ ...base, ok: false, reason: d?.status || 'fetch failed' }); continue; }
    const live = marketState(m.sessionSymbol || m.symbol) === 'open';
    const r = ctaMarket(d.bars.map(b => b.close), { live });
    markets.push({ ...base, date: d.bars.at(-1)?.date ?? null, ...r, cut: r.ok ? nearestCut(r) : null });
  }
  const out = { ok: markets.some(m => m.ok), markets, summary: ctaSummary(markets), at: new Date().toISOString() };
  if (out.ok && kvConfigured()) { try { await kvSetJsonEx(CTA_KEY, out, CTA_TTL_S); } catch { /* uncached is slower, not wrong */ } }
  return out;
}

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

export default async function handler(req, res) {
  const { tickers, period, future, cta } = req.query || {};
  if (String(cta || '') === '1') {
    try {
      res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
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
