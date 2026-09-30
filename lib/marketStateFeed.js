// lib/marketStateFeed.js — the raw series the market-state engine reads, fetched once and cached.
//
// Kept apart from api/indicators.js's main payload on purpose. That route already spends 33 FRED
// calls per load and has been throttled for it (see its fredFetch comment); these ~11 FRED
// histories and 8 Yahoo series ride on their own mode (?state=1) with a half-hour KV cache, so the
// Macro load does not get slower and the state screen does not pay for the Macro load.
//
// Everything is returned as ascending [{date, value}] series. The engine (lib/marketState.js) is a
// pure function of these, so the same inputs give the same state in the browser, the cron and the
// tests.
import { fredJsonEx } from './fred.js';
import { yahooDailyMap } from './yahoo.js';
import { kvGetJson, kvSetJsonEx, kvConfigured } from './kv.js';

export const STATE_FEED_KEY = 'dvcap:marketstate:inputs:v1';
export const STATE_FEED_TTL_S = 30 * 60;

// FRED series: [key, series id, years of history]. Percentiles are taken over two years, so the
// level series carry two; the funding and liquidity series only need their recent weeks.
export const FRED_STATE_SERIES = Object.freeze([
  ['hyOas',     'BAMLH0A0HYM2', 2],   // ICE BofA US High Yield OAS, %
  ['igOas',     'BAMLC0A0CM',   2],   // ICE BofA US Corporate (IG) OAS, %
  ['realYield', 'DFII10',       2],   // 10-year TIPS yield, %
  ['breakeven5','T5YIE',        1],   // 5-year breakeven, %
  ['termPremium','THREEFYTP10', 1],   // Kim-Wright 10-year term premium (Fed Board), % — not ACM
  ['sofr',      'SOFR',         0.5], // %
  ['effr',      'EFFR',         0.5], // %
  ['rrp',       'RRPONTSYD',    0.5], // overnight reverse repo, $bn
  ['tga',       'WTREGEN',      0.5], // Treasury General Account, $bn (weekly)
  ['fedAssets', 'WALCL',        0.5], // Fed total assets, $mn (weekly)
  ['reserves',  'WRESBAL',      0.5], // reserve balances, $bn (weekly)
  ['cpiCoreIdx','CPILFESL',     2],   // core CPI index level (monthly) — for m/m and 3-month annualised
  ['pceCoreIdx','PCEPILFE',     2],   // core PCE price index level (monthly)
]);

// Yahoo series: [key, symbol, range].
export const YAHOO_STATE_SERIES = Object.freeze([
  ['move',  '^MOVE',    '2y'],
  ['vix',   '^VIX',     '2y'],
  ['vix3m', '^VIX3M',   '2y'],
  ['vix9d', '^VIX9D',   '6mo'],
  ['dxy',   'DX-Y.NYB', '6mo'],
  ['rsp',   'RSP',      '6mo'],
  ['spy',   'SPY',      '6mo'],
  ['iwm',   'IWM',      '6mo'],
]);

const isoYearsAgo = (years, now) => new Date(now.getTime() - years * 365.25 * 864e5).toISOString().slice(0, 10);

export async function fetchFredSeries(id, start, { key = process.env.FRED_API_KEY, fred = fredJsonEx } = {}) {
  if (!key) return { ok: false, error: 'FRED_API_KEY not set', series: [] };
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&observation_start=${start}&sort_order=asc&api_key=${key}&file_type=json`;
  const { body, error } = await fred(url, `${id} (state)`);
  if (!body) return { ok: false, error: error || 'no body', series: [] };
  const series = (body.observations || [])
    .filter(o => o.value !== '.' && o.value !== '' && Number.isFinite(parseFloat(o.value)))
    .map(o => ({ date: o.date, value: parseFloat(o.value) }));
  return { ok: series.length > 0, error: series.length ? null : 'empty', series };
}

export function mapToSeries(map) {
  return Object.entries(map || {}).filter(([, v]) => Number.isFinite(v)).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, value]) => ({ date, value }));
}

// Fetches everything, in parallel within FRED's shared gate. One failing series is an entry in
// `errors`, never a failed call.
export async function fetchStateInputs({ now = new Date(), fred = fredJsonEx, yahoo = yahooDailyMap, key = process.env.FRED_API_KEY } = {}) {
  const errors = [];
  const series = {};
  await Promise.all([
    ...FRED_STATE_SERIES.map(async ([k, id, yrs]) => {
      const r = await fetchFredSeries(id, isoYearsAgo(yrs, now), { key, fred });
      series[k] = r.series;
      if (!r.ok) errors.push({ series: id, error: r.error });
    }),
    ...YAHOO_STATE_SERIES.map(async ([k, sym, range]) => {
      const m = await Promise.resolve().then(() => yahoo(sym, range)).catch(() => ({}));
      series[k] = mapToSeries(m);
      if (!series[k].length) errors.push({ series: sym, error: 'no data' });
    }),
  ]);
  return { at: now.toISOString(), series, errors };
}

// The cached form. A fresh copy is at most half an hour old; on a failed refresh the last good copy
// is served and marked, because a state computed from yesterday's inputs is better than none and
// worse than today's, and the screen should say which it is.
export async function stateInputs({ now = new Date(), fetcher = fetchStateInputs, kv = { configured: kvConfigured, get: kvGetJson, setEx: kvSetJsonEx } } = {}) {
  let cached = null;
  if (kv.configured()) {
    try { cached = await kv.get(STATE_FEED_KEY); } catch { cached = null; }
    const age = cached?.at ? (now.getTime() - Date.parse(cached.at)) / 1000 : Infinity;
    if (cached?.series && age >= 0 && age < STATE_FEED_TTL_S) return { ...cached, source: 'kv' };
  }
  const fresh = await fetcher({ now });
  const usable = Object.values(fresh.series).filter(s => s.length).length;
  if (usable >= 10) {
    if (kv.configured()) { try { await kv.setEx(STATE_FEED_KEY, fresh, 7 * 24 * 3600); } catch { /* served uncached */ } }
    return { ...fresh, source: 'live' };
  }
  if (cached?.series) return { ...cached, source: 'stale', refreshErrors: fresh.errors };
  return { ...fresh, source: 'live' };
}
