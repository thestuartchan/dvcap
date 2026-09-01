// lib/gexStore.js — the GEX capture and read, and the keys they share.
//
// WHY THIS IS A LIB AND NOT TWO API ROUTES. Vercel's Hobby plan caps a deployment at 12 Serverless
// Functions. Adding api/gex.js and api/gex-snapshot.js took this project from 11 to 13, and the
// whole deployment silently stopped shipping — the live site kept serving the previous build, so
// /api/atr answered 200 while both new routes 404'd and nothing anywhere said why. That is the
// second free-tier cap to bite in a day, after the 2-cron limit that took the US pre-read dark.
//
// So the two routes collapse into one function with a mode, and the work moves here where it can
// be read and tested independently of the HTTP shell.
import { snapshotSymbol } from './optionsChain.js';
import { gexSummary, walls } from './gex.js';
import { fredLatest } from './fred.js';
import { kvGetJson, kvSetJson } from './kv.js';
import { upsertByDate } from './series.js';
import { yahooDailyOHLC } from './yahoo.js';

export const GEX_SYMBOLS = ['SPY', 'QQQ'];
// Dividend yields. The RISK-FREE rate comes from FRED below and is never hardcoded; these move a
// few basis points a year and affect gamma at the fourth decimal.
export const DIV_YIELD = Object.freeze({ SPY: 0.012, QQQ: 0.005 });
export const RAW_KEY = (sym, date) => `dvcap:gex:${sym}:${date}`;
export const SERIES_KEY = 'dvcap:gex:series:v1';
export const RAW_INDEX_KEY = 'dvcap:gex:rawindex:v1';
export const RAW_RETENTION_DAYS = 30;

// 20-day average dollar volume — close x volume, not share count, because the figure GEX is
// normalised against is money traded and share counts are not comparable across two names at
// different prices. Under ten bars it is a guess, and the normalisation is better absent.
export async function adv20Usd(symbol) {
  try {
    const bars = await yahooDailyOHLC(symbol, '3mo');
    const rows = bars.filter(b => b.volume > 0 && b.close > 0).slice(-20);
    if (rows.length < 10) return null;
    return Math.round(rows.reduce((a, b) => a + b.close * b.volume, 0) / rows.length);
  } catch { return null; }
}

// The daily capture. Writes raw first — if the computed write fails the raw is still banked, and
// the raw is the half that cannot be reconstructed at any price.
export async function captureGex({ symbols = GEX_SYMBOLS, dry = false, now = new Date() } = {}) {
  const date = now.toISOString().slice(0, 10);

  let r = null, rateSource = null;
  try {
    const dtb3 = await fredLatest('DTB3');
    if (dtb3?.value != null && Number.isFinite(+dtb3.value)) { r = +dtb3.value / 100; rateSource = `DTB3 ${dtb3.date}`; }
  } catch { /* gamma is very insensitive to r at these tenors; a null is recorded, not fatal */ }

  const results = [];
  for (const symbol of symbols) {
    const snap = await snapshotSymbol(symbol, { now });
    if (!snap || snap.spot == null || !snap.contracts.length) {
      results.push({ symbol, ok: false, reason: 'no chain', failed: snap?.failed || null });
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
    summary.ivRejected = snap.ivRejected ?? null;

    if (!dry) {
      await kvSetJson(RAW_KEY(symbol, date), {
        symbol, date, asOf: snap.asOf, spot: snap.spot,
        expiries: snap.expiries, failed: snap.failed, contracts: snap.contracts,
      });
      const idx = (await kvGetJson(RAW_INDEX_KEY)) || [];
      const keep = [...new Set([...idx, `${symbol}:${date}`])].sort();
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
    results.push({ symbol, ok: true, contracts: snap.contracts.length, expiries: snap.expiries.length,
      failed: snap.failed, ivRejected: snap.ivRejected ?? null,
      flip: summary.flipLevel, gexUsd: summary.gexUsd, wrote: !dry });
  }
  return { ok: true, date, rate: r, rateSource, dry, results };
}

// The read side. The by-strike profile is rebuilt from the raw chain rather than stored twice —
// it is a view of the same numbers, and storing it would let the two drift apart.
export async function readGex(symbol) {
  const series = (await kvGetJson(SERIES_KEY)) || {};
  const rows = Array.isArray(series[symbol]) ? series[symbol] : [];
  const latest = rows.length ? rows[rows.length - 1] : null;
  let byStrike = null;
  if (latest?.date) {
    const raw = await kvGetJson(RAW_KEY(symbol, latest.date));
    if (raw?.contracts?.length && raw.spot != null) {
      byStrike = walls(raw.contracts, { S: raw.spot, r: latest.rate ?? 0, q: latest.divYield ?? 0, now: raw.asOf })
        .byStrike;
    }
  }
  return { available: rows.length > 0, symbol, symbols: GEX_SYMBOLS, latest, series: rows.slice(-180), byStrike, days: rows.length };
}
