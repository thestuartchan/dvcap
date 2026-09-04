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
import { gexSummary, walls, gammaGrid } from './gex.js';
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

// TWO SESSIONS, ONE ROW, AND THE FIRST ONE WINS.
//
// The first run of the day reads open interest that OCC settled overnight, and it is the reading
// worth keeping. It is NOT a pre-open run and has not been since the schedule moved to 15:15 UTC:
// Yahoo does not serve open interest before the US open, which is the whole reason it moved. The
// evening run reads the same day late,
// after that day's expiries have decayed, and it produces a materially different picture: measured
// on 2026-09-01 across the close, net GEX halved (−$5.07B to −$2.75B), the flip moved four points
// and the fragility zone tripled from 6.5 to 17.1 points, turning a usable read into an unusable
// one.
//
// upsertByDate replaced the row wholesale, so the evening reading overwrote the morning one and
// every historical row would have been the wrong vintage — permanently, since open interest is not
// served historically anywhere. The pre-open figures are now canonical and the close is stored
// BESIDE them, which also makes the open-to-close change readable instead of destroying it.
//
// If the pre-open run failed, the close run writes canonical and says so via `vintage`. Losing the
// day entirely because the first of two runs missed would be a worse trade than a labelled one.
export function sessionFor(now = new Date()) {
  // Before 17:00 UTC is pre-open or intraday for the US; after is the close run.
  return now.getUTCHours() < 17 ? 'open' : 'close';
}

const CLOSE_FIELDS = ['asOf', 'spot', 'gexUsd', 'gexUsdInverse', 'flipLevel', 'flipZoneLo', 'flipZoneHi',
  'flipFragile', 'flipSpread', 'callWall', 'putWall', 'oiWeightedIv', 'callOi', 'putOi'];

export async function captureGex({ symbols = GEX_SYMBOLS, dry = false, now = new Date(), session = null } = {}) {
  const date = now.toISOString().slice(0, 10);
  const sess = session === 'open' || session === 'close' ? session : sessionFor(now);

  let r = null, rateSource = null;
  try {
    const dtb3 = await fredLatest('DTB3');
    if (dtb3?.value != null && Number.isFinite(+dtb3.value)) { r = +dtb3.value / 100; rateSource = `DTB3 ${dtb3.date}`; }
  } catch { /* gamma is very insensitive to r at these tenors; a null is recorded, not fatal */ }

  const results = [];
  for (const symbol of symbols) {
    const snap = await snapshotSymbol(symbol, { now });
    // A chain with no open interest is not a chain. Gamma exposure IS open interest weighted by
    // gamma — with every weight at zero the aggregate is zero, the flip is undefined and the walls
    // are wherever the tie-break lands. Writing that row would put a fabricated zero into a series
    // that cannot be rebuilt, so the day is skipped and the reason is reported verbatim.
    if (!snap || snap.spot == null || !snap.ok) {
      results.push({ symbol, ok: false,
        reason: snap?.reason || 'no chain',
        contractsSeen: snap?.contractsSeen ?? 0, withOi: snap?.withOi ?? 0,
        failed: snap?.failed || null });
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
      const rows = series[symbol] || [];
      const existing = rows.find(r => r?.date === date);
      let row;
      if (sess === 'close' && existing && existing.vintage === 'open') {
        // Overlay only. The canonical pre-open figures are left exactly as they were.
        const close = {};
        for (const k of CLOSE_FIELDS) close[k] = summary[k] ?? null;
        row = { ...existing, close };
      } else {
        row = { ...summary, vintage: sess, close: existing?.close ?? null };
      }
      series[symbol] = upsertByDate(rows, row);
      await kvSetJson(SERIES_KEY, series);
    }
    results.push({ symbol, ok: true, session: sess, contracts: snap.contracts.length, expiries: snap.expiries.length,
      failed: snap.failed, ivRejected: snap.ivRejected ?? null,
      flip: summary.flipLevel, gexUsd: summary.gexUsd, wrote: !dry,
      // The whole row comes back, because the panel's live recompute renders from this rather than
      // from storage — a "refresh" that returned only two headline numbers and dropped the walls
      // would be a downgrade dressed as an update. byStrike only on a dry run: it is ~140 rows and
      // the scheduled writes have no reader for it.
      row: summary,
      byStrike: dry ? walls(snap.contracts, { S: snap.spot, r: r ?? 0, q: DIV_YIELD[symbol] ?? 0, now: now.toISOString() }).byStrike : null,
      grid: dry ? gammaGrid(snap.contracts, { S: snap.spot, r: r ?? 0, q: DIV_YIELD[symbol] ?? 0, now: now.toISOString() }) : null });
  }
  return { ok: true, date, session: sess, rate: r, rateSource, dry, results };
}

// The read side. The by-strike profile is rebuilt from the raw chain rather than stored twice —
// it is a view of the same numbers, and storing it would let the two drift apart.
export async function readGex(symbol) {
  const series = (await kvGetJson(SERIES_KEY)) || {};
  const rows = Array.isArray(series[symbol]) ? series[symbol] : [];
  const latest = rows.length ? rows[rows.length - 1] : null;
  let byStrike = null, grid = null;
  if (latest?.date) {
    const raw = await kvGetJson(RAW_KEY(symbol, latest.date));
    if (raw?.contracts?.length && raw.spot != null) {
      const opts = { S: raw.spot, r: latest.rate ?? 0, q: latest.divYield ?? 0, now: raw.asOf };
      byStrike = walls(raw.contracts, opts).byStrike;
      // Same contracts, the dimension walls() collapses. It answers whether the headline walls are
      // a level several expiries agree on or one expiry's book about to expire.
      grid = gammaGrid(raw.contracts, opts);
    }
  }
  return { available: rows.length > 0, symbol, symbols: GEX_SYMBOLS, latest, series: rows.slice(-180), byStrike, grid, days: rows.length };
}
