// lib/crossCheckFeed.js — the server-side fetchers behind the cross-check JSON (lib/crossCheck.js).
//
// Each source is fetched here because the reader's own tools cannot reach it: a CSV served as
// binary, a JS-rendered page, a legacy .xls, a rate-limited API. Every fetcher returns the block's
// computed fields or throws; lib/crossCheck.js turns a throw into `unavailable` for that block only.
// Keys stay in the environment (FRED_API_KEY is read by lib/marketStateFeed.js and never returned).
import { fetchFredSeries } from './marketStateFeed.js';
import { yahooDailyMap } from './yahoo.js';
import { tenorOf } from './auctions.js';
import { COT_BASE, TFF, DISAGG } from './cot.js';
import { readXls } from './xls.js';
import { kvConfigured, kvGetJson, kvSetJsonEx } from './kv.js';
import {
  buildCrossCheck, computeCredit, computeRealYields, computeTermPremium, computeBreadth, computeAuctions,
  computeCotMarket, parseDixCsv, computeDix, parseCboeDaily, computePutCall, computeAaii,
} from './crossCheck.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const KV_PREFIX = 'dvcap:xc:v1:';
const since = (days, now) => new Date(now.getTime() - days * 864e5).toISOString().slice(0, 10);
async function get(url, { timeoutMs = 15000, as = 'json' } = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: as === 'json' ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${r.status} from source`);
  return as === 'json' ? r.json() : as === 'text' ? r.text() : new Uint8Array(await r.arrayBuffer());
}
async function fred(id, now) {
  const r = await fetchFredSeries(id, since(60, now));
  if (!r.ok) throw new Error(`FRED ${id}: ${r.error}`);
  return r.series;
}

// ── THE NY FED'S ACM TERM PREMIUM ── ACMTermPremium.xls, sheet "ACM Daily", column ACMTP10; the
// dates are text like "28-Sep-2026".
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
export function acmDate(v) {
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
  const m = /^(\d{1,2})-([A-Z][a-z]{2})-(\d{4})$/.exec(String(v || '').trim());
  return m && MON[m[2]] ? `${m[3]}-${String(MON[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
export function acmSeries(book, { sheet = 'ACM Daily', column = 'ACMTP10', last = 40 } = {}) {
  const sh = book.sheets.find(s => s.name === sheet) || book.sheets.find(s => /daily/i.test(s.name));
  if (!sh) throw new Error(`no "${sheet}" sheet`);
  let col = -1, dateCol = 0;
  for (let c = 0; c < 64; c++) { const h = sh.cells.get(`0,${c}`); if (h === column) col = c; if (h === 'DATE') dateCol = c; }
  if (col < 0) throw new Error(`no ${column} column`);
  const out = [];
  for (let r = Math.max(1, sh.maxRow - last + 1); r <= sh.maxRow; r++) {
    const d = acmDate(sh.cells.get(`${r},${dateCol}`)), v = sh.cells.get(`${r},${col}`);
    if (d && Number.isFinite(v)) out.push({ date: d, value: v });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ── TREASURY AUCTIONS ── recent coupon auctions with the bidder split; the direct share is
// computed here because lib/auctions.js does not carry it.
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
export function tdRow(row) {
  const comp = n(row.competitiveAccepted);
  const share = (v) => (n(v) != null && comp > 0 ? Math.round((n(v) / comp) * 1000) / 10 : null);
  return {
    cusip: row.cusip || null, type: row.securityType || null, tenor: tenorOf(row), term: row.securityTerm || null,
    auctionDate: typeof row.auctionDate === 'string' ? row.auctionDate.slice(0, 10) : null, reopening: row.reopening === 'Yes',
    highYield: n(row.highYield), bidToCover: n(row.bidToCoverRatio),
    indirectPct: share(row.indirectBidderAccepted), directPct: share(row.directBidderAccepted), dealerPct: share(row.primaryDealerAccepted),
  };
}

// ── CFTC ── four markets, 60 weeks, two datasets. Codes verified against the live API 2026-09-30.
export const XC_COT = Object.freeze([
  { key: 'wti',    dataset: DISAGG, code: '067651', trader: 'managed money',   long: 'm_money_positions_long_all', short: 'm_money_positions_short_all' },
  { key: 'gold',   dataset: DISAGG, code: '088691', trader: 'managed money',   long: 'm_money_positions_long_all', short: 'm_money_positions_short_all' },
  { key: 'jpy',    dataset: TFF,    code: '097741', trader: 'leveraged funds', long: 'lev_money_positions_long',   short: 'lev_money_positions_short' },
  { key: 'ust10y', dataset: TFF,    code: '043602', trader: 'leveraged funds', long: 'lev_money_positions_long',   short: 'lev_money_positions_short' },
]);
async function cot(now) {
  const markets = {};
  for (const ds of [DISAGG, TFF]) {
    const ms = XC_COT.filter(m => m.dataset === ds);
    const fields = [...new Set(['report_date_as_yyyy_mm_dd', 'cftc_contract_market_code', ...ms.flatMap(m => [m.long, m.short])])];
    const where = `cftc_contract_market_code in(${ms.map(m => `'${m.code}'`).join(',')}) AND report_date_as_yyyy_mm_dd >= '${since(60 * 7, now)}T00:00:00.000'`;
    const rows = await get(`${COT_BASE}/${ds}.json?${new URLSearchParams({ $select: fields.join(','), $where: where, $order: 'report_date_as_yyyy_mm_dd', $limit: '2000' })}`);
    if (!Array.isArray(rows)) throw new Error('unexpected CFTC response');
    for (const m of ms) {
      const s = rows.filter(r => r.cftc_contract_market_code === m.code)
        .map(r => ({ date: String(r.report_date_as_yyyy_mm_dd || '').slice(0, 10), net: n(r[m.long]) != null && n(r[m.short]) != null ? n(r[m.long]) - n(r[m.short]) : null }))
        .filter(r => r.date && r.net != null).sort((a, b) => a.date.localeCompare(b.date));
      markets[m.key] = computeCotMarket(s, { trader: m.trader });
    }
  }
  const dates = Object.values(markets).map(m => m?.report_date).filter(Boolean).sort();
  if (!dates.length) throw new Error('no CFTC rows');
  return { report_date: dates[dates.length - 1], markets, note: 'net = long − short contracts; managed money for commodities, leveraged funds for JPY and 10Y' };
}

// ── CBOE PUT/CALL ── one JSON per session; the history is kept in KV and filled backwards, at most
// `perCall` sessions a refresh, so the one-year rank sharpens over the first few refreshes (the
// block says how many sessions it ranks over). Holidays answer 404 and are remembered as such.
const PC_HIST_KEY = `${KV_PREFIX}putcall-history`;
async function putCall(now, { perCall = 90, concurrency = 8 } = {}) {
  let store = { rows: [], none: [] };
  if (kvConfigured()) { try { store = (await kvGetJson(PC_HIST_KEY)) || store; } catch { /* start empty */ } }
  const have = new Set([...store.rows.map(r => r.date), ...store.none]);
  const want = [];
  for (let t = now.getTime() - 864e5; want.length < 400 && t > now.getTime() - 370 * 864e5; t -= 864e5) {
    const d = new Date(t); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const iso = d.toISOString().slice(0, 10); if (!have.has(iso)) want.push(iso);
  }
  const batch = want.slice(0, perCall);
  let firstErr = null;
  for (let i = 0; i < batch.length; i += concurrency) {
    await Promise.all(batch.slice(i, i + concurrency).map(async (d) => {
      try {
        const j = await get(`https://cdn.cboe.com/data/us/options/market_statistics/daily/${d}_daily_options`, { timeoutMs: 8000 });
        const row = parseCboeDaily(j, d);
        if (row) store.rows.push(row); else store.none.push(d);
      } catch (e) {
        if (/^40[34]/.test(String(e.message))) store.none.push(d); else firstErr = firstErr || e;
      }
    }));
  }
  const cut = new Date(now.getTime() - 380 * 864e5).toISOString().slice(0, 10);
  store.rows = [...new Map(store.rows.filter(r => r.date >= cut).map(r => [r.date, r])).values()].sort((a, b) => a.date.localeCompare(b.date));
  store.none = [...new Set(store.none.filter(d => d >= cut))];
  if (kvConfigured() && batch.length) { try { await kvSetJsonEx(PC_HIST_KEY, store, 30 * 86400); } catch { /* next refresh refetches */ } }
  const out = computePutCall(store.rows);
  if (!out) throw firstErr || new Error('no Cboe sessions');
  return { ...out, source: 'Cboe daily market statistics', backfill_pending_sessions: Math.max(0, want.length - batch.length) };
}

// ── AAII ── best effort. The survey spreadsheet is behind a bot wall more often than not; a 403
// is reported as the block's error and nothing is done to get round it.
async function aaii() {
  const bytes = await get('https://www.aaii.com/files/surveys/sentiment.xls', { as: 'bytes', timeoutMs: 15000 });
  const book = readXls(bytes);
  const sh = book.sheets[0];
  const rows = [];
  for (let r = 0; r <= sh.maxRow; r++) {
    const d = sh.cells.get(`${r},0`), b = sh.cells.get(`${r},1`), ne = sh.cells.get(`${r},2`), be = sh.cells.get(`${r},3`);
    if (typeof d === 'number' && d > 30000 && [b, ne, be].every(Number.isFinite)) rows.push({ date: acmDate(d), bullish: b, neutral: ne, bearish: be });
  }
  const out = computeAaii(rows);
  if (!out) throw new Error('survey sheet not in the expected layout');
  return out;
}

export const CROSSCHECK_SOURCES = Object.freeze({
  credit: async ({ now }) => computeCredit(await fred('BAMLH0A0HYM2', now)),
  real_yields: async ({ now }) => computeRealYields({ real: await fred('DFII10', now), breakeven: await fred('T10YIE', now) }),
  term_premium: async () => computeTermPremium(acmSeries(readXls(await get('https://www.newyorkfed.org/medialibrary/media/research/data_indicators/ACMTermPremium.xls', { as: 'bytes', timeoutMs: 20000 })))),
  breadth: async () => computeBreadth({ rsp: await yahooDailyMap('RSP', '1mo'), spy: await yahooDailyMap('SPY', '1mo') }),
  auctions: async ({ today }) => {
    const base = 'https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json';
    const lists = await Promise.all([['Note', 60], ['Bond', 20], ['TIPS', 20], ['FRN', 12]].map(([t, k]) => get(`${base}&type=${t}&pagesize=${k}`)));
    return computeAuctions(lists.flat().filter(Boolean).map(tdRow), today);
  },
  positioning: async ({ now }) => cot(now),
  gamma_independent: async () => computeDix(parseDixCsv(await get('https://squeezemetrics.com/monitor/static/DIX.csv', { as: 'text' }))),
  sentiment_aaii: async () => aaii(),
  put_call: async ({ now }) => putCall(now),
});

export const kvBlockCache = {
  get: async (b) => (kvConfigured() ? kvGetJson(`${KV_PREFIX}${b}`) : null),
  set: async (b, v) => (kvConfigured() ? kvSetJsonEx(`${KV_PREFIX}${b}`, v, 8 * 86400) : null),
};

export async function crossCheckPayload({ now = new Date() } = {}) {
  return buildCrossCheck({ sources: CROSSCHECK_SOURCES, cache: kvBlockCache, now, timeoutMs: 25000 });
}
