// lib/ismFetch.js — fetch ISM's PMI releases from PR Newswire and keep them three hours in KV.
// Parsing and the hand-entry merge are in lib/ismFeed.js (pure, shared with the app).
import { kvGetJson, kvSetJsonEx, kvConfigured } from './kv.js';
import { ISM_NEWSROOM_URL, ISM_MONTHS_BACK, ismLinksFromNewsroom, ismFromRelease, ismSeries } from './ismFeed.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const CACHE_KEY = 'dvcap:ism:prn:v1';
const CACHE_S = 3 * 3600;

export async function fetchIsmFeed({ fetchImpl = fetch, kv = kvConfigured() } = {}) {
  if (kv) {
    try { const c = await kvGetJson(CACHE_KEY); if (c?.ok) return { ...c, cache: 'kv' }; } catch { /* a miss */ }
  }
  const get = async (url) => {
    const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`${new URL(url).pathname.slice(0, 60)} → HTTP ${r.status}`);
    return r.text();
  };
  try {
    const links = ismLinksFromNewsroom(await get(ISM_NEWSROOM_URL));
    const want = ['manufacturing', 'services'].flatMap(k => links.filter(l => l.kind === k).slice(0, ISM_MONTHS_BACK));
    if (!want.length) throw new Error('no PMI releases on the ISM newsroom page');
    const errors = [], releases = [];
    for (const l of want) {
      try {
        const r = ismFromRelease(await get(l.url), l.kind);
        if (r) releases.push({ ...r, period: l.period, url: l.url }); else errors.push(`${l.kind} ${l.period}: the release did not read`);
      } catch (e) { errors.push(`${l.kind} ${l.period}: ${String(e?.message || e).slice(0, 80)}`); }
    }
    const series = ismSeries(releases);
    const latest = series.filter(r => r.manufacturing != null).at(-1) || null;
    if (!latest) throw new Error(errors[0] || 'no manufacturing release read');
    const out = { ok: true, latest, series, at: new Date().toISOString(), errors, sources: releases.map(r => r.url) };
    if (kv) { try { await kvSetJsonEx(CACHE_KEY, out, CACHE_S); } catch { /* uncached is slower, not wrong */ } }
    return out;
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}
