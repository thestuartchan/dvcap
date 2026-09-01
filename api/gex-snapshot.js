// api/gex-snapshot.js — the daily capture. Cron target.
//
// WHY PRE-OPEN. OCC settles open interest overnight, so Yahoo's `openInterest` field reflects the
// PRIOR session all through the following morning and only starts drifting once the day's trades
// begin clearing. Running at 09:00 ET captures settled numbers; running intraday captures a
// half-updated field that is neither yesterday's nor today's.
//
// WHY IT WRITES RAW AND COMPUTED. The raw chain goes to Redis because open interest cannot be
// re-fetched — Yahoo and OCC serve today only, and the signal is day-over-day ΔOI, so a day not
// captured is gone for good. Storing raw means the GEX computation can be revised later against
// data that would otherwise no longer exist. The computed row goes to the dated series because
// that is what the chart reads and it is small enough to keep forever.
import { snapshotSymbol } from '../lib/optionsChain.js';
import { gexSummary } from '../lib/gex.js';
import { fredLatest } from '../lib/fred.js';
import { kvConfigured, kvGetJson, kvSetJson } from '../lib/kv.js';
import { upsertByDate } from '../lib/series.js';
import { yahooDailyOHLC } from '../lib/yahoo.js';

export const GEX_SYMBOLS = ['SPY', 'QQQ'];
// Dividend yields. Not hardcoded rates — the RISK-FREE rate comes from FRED below — but a yield
// that moves a few basis points a year and affects gamma at the fourth decimal.
export const DIV_YIELD = Object.freeze({ SPY: 0.012, QQQ: 0.005 });
export const RAW_KEY = (sym, date) => `dvcap:gex:${sym}:${date}`;
export const SERIES_KEY = 'dvcap:gex:series:v1';
export const RAW_RETENTION_DAYS = 30;
export const RAW_INDEX_KEY = 'dvcap:gex:rawindex:v1';

// 20-day average dollar volume, for the normalisation that keeps the series comparable as the
// index level drifts. Derived from the same OHLC route the ATR module uses.
async function adv20Usd(symbol) {
  try {
    const bars = await yahooDailyOHLC(symbol, '3mo');
    // Dollar volume per bar, then the mean of the last 20. Close x volume, not volume alone: the
    // figure GEX is normalised against is money traded, and share counts are not comparable
    // across two names at different prices.
    const rows = bars.filter(b => b.volume > 0 && b.close > 0).slice(-20);
    // A short window gives a worse average, not a wrong one — but under ten bars it is a guess,
    // and the normalisation is better absent than fabricated.
    if (rows.length < 10) return null;
    return Math.round(rows.reduce((a, b) => a + b.close * b.volume, 0) / rows.length);
  } catch { return null; }
}

export default async function handler(req, res) {
  if (!kvConfigured()) return res.status(200).json({ ok: false, reason: 'KV not configured — nothing to write to' });

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const dry = req.query?.dry === '1';
  const symbols = String(req.query?.symbols || '').trim()
    ? String(req.query.symbols).split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : GEX_SYMBOLS;

  // THE RISK-FREE RATE COMES FROM FRED, never a constant. DTB3 is the 3-month bill on a discount
  // basis, quoted in percent; gamma needs a decimal. A missing rate is not fatal — gamma is very
  // insensitive to r at these tenors — but it is recorded so a row computed without one is known.
  let r = null, rateSource = null;
  try {
    const dtb3 = await fredLatest('DTB3');
    if (dtb3?.value != null && Number.isFinite(+dtb3.value)) { r = +dtb3.value / 100; rateSource = `DTB3 ${dtb3.date}`; }
  } catch { /* fall through with r null */ }

  const out = [];
  for (const symbol of symbols) {
    const snap = await snapshotSymbol(symbol, { now });
    if (!snap || snap.spot == null || !snap.contracts.length) {
      out.push({ symbol, ok: false, reason: 'no chain', failed: snap?.failed || null });
      continue;
    }
    const summary = gexSummary(snap.contracts, {
      S: snap.spot, r: r ?? 0, q: DIV_YIELD[symbol] ?? 0,
      now: now.toISOString(), date, symbol, advUsd: await adv20Usd(symbol),
    });
    summary.rate = r; summary.rateSource = rateSource;
    summary.divYield = DIV_YIELD[symbol] ?? 0;
    summary.expiries = snap.expiries.map(e => e.date);
    summary.partial = snap.failed.length > 0;

    if (!dry) {
      // Raw first. If the computed write fails the raw is still banked, and the raw is the half
      // that cannot be reconstructed.
      await kvSetJson(RAW_KEY(symbol, date), {
        symbol, date, asOf: snap.asOf, spot: snap.spot,
        expiries: snap.expiries, failed: snap.failed, contracts: snap.contracts,
      });
      const idx = (await kvGetJson(RAW_INDEX_KEY)) || [];
      const keep = [...new Set([...idx, `${symbol}:${date}`])].sort();
      // Prune past 30 days. The index is kept so pruning does not need a key scan.
      const cutoff = new Date(now.getTime() - RAW_RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
      const live = keep.filter(k => (k.split(':')[1] || '') >= cutoff);
      for (const k of keep.filter(k => !live.includes(k))) {
        const [s2, d2] = k.split(':');
        await kvSetJson(RAW_KEY(s2, d2), null);
      }
      await kvSetJson(RAW_INDEX_KEY, live);

      const series = (await kvGetJson(SERIES_KEY)) || {};
      series[symbol] = upsertByDate(series[symbol] || [], summary);
      await kvSetJson(SERIES_KEY, series);
    }
    out.push({ symbol, ok: true, contracts: snap.contracts.length, expiries: snap.expiries.length,
      failed: snap.failed, flip: summary.flipLevel, gexUsd: summary.gexUsd, wrote: !dry });
  }

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({ ok: true, date, rate: r, rateSource, dry, results: out });
}
