// lib/hkexSouthbound.js — the aggregate Southbound net, read from HKEX's own daily statistics.
//
// It was hand-entered (lib/southbound.js explains why: no clean HKEX API, and a scraper that breaks
// silently is worse than none). HKEX does publish one stable file per trading day for the Stock
// Connect daily statistics page — www.hkex.com.hk/eng/csm/DailyStat/data_tab_daily_YYYYMMDDe.js,
// a `tabData = [...]` JSON array, one entry per channel. The two Southbound channels (SSE and SZSE
// Southbound) each carry Buy Turnover and Sell Turnover in HK$ MILLIONS. Net = buy − sell, summed
// across both, reported in HK$ BILLIONS to match the panel's unit.
//
// A day where both channels read zero is a day Southbound did not trade (a mainland holiday — e.g.
// 2026-09-25, Mid-Autumn) and is skipped, never recorded as a flat day. A file that is not there
// yet (today, before publication) is simply absent. Nothing is ever interpolated.
import { kvGetJson, kvSetJson, kvConfigured } from './kv.js';

export const HKEX_DAILY_URL = (ymd) => `https://www.hkex.com.hk/eng/csm/DailyStat/data_tab_daily_${ymd}e.js`;
export const SB_CACHE_KEY = 'dvcap:southbound:hkex:v1';
export const SB_LOOKBACK_DAYS = 40;     // calendar days fetched back — ~25 sessions, room for the 20d window

const num = (s) => { const v = Number(String(s ?? '').replace(/,/g, '')); return Number.isFinite(v) ? v : null; };

// One file → { date, sse, szse, aggregateNet (HK$ bn) } | { date, closed: true } | null (unreadable).
export function parseDailyStat(text) {
  let tab;
  try { tab = JSON.parse(String(text || '').replace(/^\s*tabData\s*=\s*/, '').replace(/;\s*$/, '')); } catch { return null; }
  if (!Array.isArray(tab)) return null;
  const leg = (market) => {
    const t = tab.find(x => x?.market === market);
    const table = t?.content?.find(c => c?.style === 1)?.table;
    const cols = table?.schema?.[0];
    const vals = table?.tr?.map(r => r?.td?.[0]?.[0]);
    if (!Array.isArray(cols) || !Array.isArray(vals)) return null;
    const at = (name) => { const i = cols.indexOf(name); return i >= 0 ? num(vals[i]) : null; };
    const buy = at('Buy Turnover'), sell = at('Sell Turnover');
    if (buy == null || sell == null) return null;
    return { date: t.date, buy, sell };
  };
  const sse = leg('SSE Southbound'), szse = leg('SZSE Southbound');
  if (!sse || !szse) return null;
  const date = sse.date || szse.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return null;
  if (sse.buy === 0 && sse.sell === 0 && szse.buy === 0 && szse.sell === 0) return { date, closed: true };
  const netMn = (sse.buy - sse.sell) + (szse.buy - szse.sell);
  return {
    date,
    aggregateNet: +(netMn / 1000).toFixed(2),
    sse: { buy: sse.buy, sell: sse.sell }, szse: { buy: szse.buy, sell: szse.sell },
    turnover: +((sse.buy + sse.sell + szse.buy + szse.sell) / 1000).toFixed(2),
    source: 'hkex',
  };
}

// Weekdays back from `today` (HKT date string), newest first.
export function candidateDays(today, n = SB_LOOKBACK_DAYS) {
  const out = [];
  const d = new Date(today + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

// The series, oldest first, as the panel's southboundTrend expects rows: { date, aggregateNet }.
// Days before today are final once read and are cached for good; today is re-asked each time.
export async function fetchSouthbound({ now = new Date(), fetchImpl = fetch, kv = kvConfigured() } = {}) {
  const today = new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 10);   // HKT
  const cache = (kv ? await kvGetJson(SB_CACHE_KEY).catch(() => null) : null) || { days: {} };
  const days = { ...(cache.days || {}) };
  const want = candidateDays(today);
  const missing = want.filter(d => !(d in days) || d === today);
  let fetched = 0, failed = 0;
  for (let i = 0; i < missing.length; i += 8) {
    await Promise.all(missing.slice(i, i + 8).map(async (d) => {
      try {
        const r = await fetchImpl(HKEX_DAILY_URL(d.replace(/-/g, '')), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) { if (r.status === 404 && d < today) days[d] = { date: d, closed: true, note: 'no file' }; else failed++; return; }
        const row = parseDailyStat(await r.text());
        if (!row) { failed++; return; }
        fetched++;
        if (row.date !== d) return;                 // HKEX served another day's file under this name
        if (d < today || !row.closed) days[d] = row; // an all-zero TODAY may simply be early
      } catch { failed++; }
    }));
  }
  const keep = Object.fromEntries(Object.entries(days).filter(([d]) => want.includes(d) || d >= want[want.length - 1]));
  if (kv && fetched) await kvSetJson(SB_CACHE_KEY, { days: keep, at: now.toISOString() }).catch(() => {});
  const series = Object.values(keep).filter(r => r && !r.closed && Number.isFinite(r.aggregateNet))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(r => ({ date: r.date, aggregateNet: r.aggregateNet, turnover: r.turnover, source: 'hkex' }));
  return { ok: series.length > 0, series, latest: series[series.length - 1] || null, unit: 'HK$ bn', fetched, failed, asOf: now.toISOString(),
           source: 'HKEX Stock Connect daily statistics (data_tab_daily)' };
}

// Manual rows win for the day they cover (an operator correction), auto rows fill every other
// day; the SMIC holding, which HKEX's daily file does not carry, is only ever manual.
export function mergeSouthbound(auto = [], manual = []) {
  const byDate = new Map();
  for (const r of auto || []) if (r?.date) byDate.set(r.date, { ...r });
  for (const r of manual || []) {
    if (!r?.date) continue;
    const a = byDate.get(r.date) || { date: r.date };
    byDate.set(r.date, { ...a, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v != null && v !== '')), source: r.aggregateNet != null && r.aggregateNet !== '' ? 'manual' : (a.source || 'manual') });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
