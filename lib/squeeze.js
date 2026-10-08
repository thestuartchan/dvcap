// lib/squeeze.js — SqueezeMetrics' published S&P 500 dealer-gamma estimate (GEX), daily since 2011.
//
// The one long gamma record available free: our own captures start on 1 Sep 2026 and open interest
// is not served historically, so the 15-year trend-day test (8 Oct) was run against this series.
// Their model and sign convention, not ours: it gives the regime's sign and size, not a flip level.
// Read raw from their CSV; market data only.
const URL_DIX = 'https://squeezemetrics.com/monitor/static/DIX.csv';

export function parseDix(text = '') {
  const lines = String(text).trim().split(/\r?\n/);
  const head = (lines.shift() || '').split(',');
  const di = head.indexOf('date'), gi = head.indexOf('gex');
  if (di < 0 || gi < 0) return [];
  return lines.map(l => l.split(',')).map(c => [c[di], Number(c[gi])]).filter(([d, g]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(g));
}
export async function fetchSqueezeGex({ timeoutMs = 9000 } = {}) {
  try {
    const r = await fetch(URL_DIX, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/csv' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, why: `SqueezeMetrics answered ${r.status}`, rows: [] };
    const rows = parseDix(await r.text());
    return { ok: rows.length > 0, rows, source: 'SqueezeMetrics DIX.csv (SPX GEX)' };
  } catch (e) { return { ok: false, why: String(e?.message || e).slice(0, 80), rows: [] }; }
}
// Where a day's GEX sits against the trailing year (252 sessions BEFORE it): 0 = the year's low.
// The series grows with the market, so the level is read as a percentile, never as dollars.
export function gexPercentile(rows = [], date, window = 252) {
  const i = rows.findIndex(([d]) => d === date);
  if (i < window) return null;
  const g = rows[i][1];
  return rows.slice(i - window, i).filter(([, x]) => x < g).length / window;
}
