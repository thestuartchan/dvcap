// api/gex.js — read side. The stored series, and optionally today's raw chain for the by-strike
// chart. Separate from the snapshot route so a page load can never trigger a capture.
import { kvConfigured, kvGetJson } from '../lib/kv.js';
import { RAW_KEY, SERIES_KEY, GEX_SYMBOLS } from './gex-snapshot.js';
import { walls } from '../lib/gex.js';

export default async function handler(req, res) {
  if (!kvConfigured()) return res.status(200).json({ available: false, reason: 'KV not configured' });
  const symbol = String(req.query?.symbol || 'QQQ').toUpperCase();
  if (!GEX_SYMBOLS.includes(symbol)) return res.status(400).json({ error: `unknown symbol ${symbol}` });

  const series = (await kvGetJson(SERIES_KEY)) || {};
  const rows = Array.isArray(series[symbol]) ? series[symbol] : [];
  const latest = rows.length ? rows[rows.length - 1] : null;

  // The by-strike profile is rebuilt from the raw chain rather than stored twice — it is a view of
  // the same numbers, and storing it would let the two drift apart.
  let byStrike = null;
  if (latest?.date) {
    const raw = await kvGetJson(RAW_KEY(symbol, latest.date));
    if (raw?.contracts?.length && raw.spot != null) {
      byStrike = walls(raw.contracts, {
        S: raw.spot, r: latest.rate ?? 0, q: latest.divYield ?? 0, now: raw.asOf,
      }).byStrike;
    }
  }

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({
    available: rows.length > 0, symbol, symbols: GEX_SYMBOLS,
    latest, series: rows.slice(-180), byStrike,
    // A one-row series cannot show day-over-day anything, and the panel says so rather than
    // drawing a single point and calling it a time series.
    days: rows.length,
  });
}
