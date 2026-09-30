// lib/interventionFeed.js — fetches and caches what lib/interventionAuto.js reads.
//
// Two clocks. The price scan (15-minute USD/JPY and DXY for a month, daily highs for three) is
// cached for ten minutes: an operation is a same-session event and the flag should appear within
// the quarter-hour. The Ministry of Finance files (the daily CSV and the latest monthly totals)
// change a few times a month and are cached for six hours. Either can fail on its own; the result
// says which, and a failed MoF fetch leaves events SUSPECTED rather than guessing a confirmation.
import { yahooBars } from './yahoo.js';
import { kvConfigured, kvGetJson, kvSetJsonEx } from './kv.js';
import { scanYen, parseMofCsv, parseMofMonthly, parseMofMonthlyIndex, autoState } from './interventionAuto.js';

export const SCAN_KEY = 'dvcap:intervention:scan:v1';
export const MOF_KEY = 'dvcap:intervention:mof:v1';
const MOF_BASE = 'https://www.mof.go.jp/english/policy/international_policy/reference/feio/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function cached(key, ttlS, fn) {
  if (kvConfigured()) {
    try { const c = await kvGetJson(key); if (c?.at && Date.now() - Date.parse(c.at) < ttlS * 1000) return c; } catch { /* a miss */ }
  }
  const fresh = await fn();
  if (fresh?.ok && kvConfigured()) { try { await kvSetJsonEx(key, fresh, 7 * 86400); } catch { /* uncached is slower, not wrong */ } }
  if (!fresh?.ok && kvConfigured()) { try { const c = await kvGetJson(key); if (c) return { ...c, stale: true, error: fresh?.error }; } catch { /* nothing kept */ } }
  return fresh;
}

export async function fetchScan() {
  const [jpy, dxy, daily] = await Promise.all([
    yahooBars('JPY=X', { range: '1mo', interval: '15m' }),
    yahooBars('DX-Y.NYB', { range: '1mo', interval: '15m' }),
    yahooBars('JPY=X', { range: '3mo', interval: '1d' }),
  ]);
  if (!jpy.length) return { ok: false, error: 'no USD/JPY bars', at: new Date().toISOString() };
  const cut = Date.now() / 1000 - 60 * 86400;
  const highs = daily.filter(b => b.t >= cut).map(b => b.h ?? b.c).filter(Number.isFinite);
  const high60 = highs.length ? Math.max(...highs, ...jpy.map(b => b.h ?? b.c)) : null;
  return { ok: true, at: new Date().toISOString(), high60, bars: jpy.length, dxyBars: dxy.length,
    events: scanYen({ jpy: jpy.map(b => ({ t: b.t, c: b.c })), dxy: dxy.map(b => ({ t: b.t, c: b.c })), high60 }) };
}

async function getText(url, latin1 = false) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return latin1 ? new TextDecoder('latin1').decode(await r.arrayBuffer()) : r.text();
}
export async function fetchMof() {
  try {
    const [csvText, idx] = await Promise.all([
      getText(MOF_BASE + 'foreign_exchange_intervention_operations.csv', true),
      getText(MOF_BASE + 'monthly/index.html'),
    ]);
    const csv = parseMofCsv(csvText);
    // The monthly releases after the CSV's last quarter are the ones that can say anything new.
    const pages = parseMofMonthlyIndex(idx).slice(0, 4);
    const monthly = (await Promise.all(pages.map(p => getText(`${MOF_BASE}monthly/${p}e.html`).then(parseMofMonthly).catch(() => null)))).filter(Boolean);
    if (!csv.days.length && !monthly.length) return { ok: false, error: 'MoF files parsed empty', at: new Date().toISOString() };
    // Only the recent daily rows are kept: the scan looks back a month, the display a year.
    const yearAgo = new Date(Date.now() - 400 * 86400e3).toISOString().slice(0, 10);
    return { ok: true, at: new Date().toISOString(), csv: { coveredThrough: csv.coveredThrough, days: csv.days.filter(d => d.date >= yearAgo) }, monthly };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), at: new Date().toISOString() };
  }
}

// The automatic flag, ready for contamination(): { state, events, active, latest, headline, sources }.
export async function interventionAuto({ today = new Date().toISOString().slice(0, 10) } = {}) {
  const [scan, mof] = await Promise.all([cached(SCAN_KEY, 10 * 60, fetchScan), cached(MOF_KEY, 6 * 3600, fetchMof)]);
  const out = autoState(scan?.ok ? scan.events : [], mof?.ok ? mof : {}, today);
  return {
    ...out,
    // What the MoF has published lately, for the panel: daily operations and monthly totals.
    mof: mof?.ok ? { coveredThrough: mof.csv?.coveredThrough ?? null, days: mof.csv?.days ?? [], monthly: mof.monthly ?? [], at: mof.at, stale: !!mof.stale } : null,
    sources: {
      scan: scan?.ok ? { at: scan.at, high60: scan.high60, bars: scan.bars, stale: !!scan.stale } : { error: scan?.error || 'scan failed' },
      mof: mof?.ok ? { at: mof.at, stale: !!mof.stale } : { error: mof?.error || 'MoF fetch failed' },
    },
  };
}
