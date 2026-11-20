// lib/ismFetch.js — fetch ISM's PMI releases from PR Newswire and keep them three hours in KV.
// Parsing and the hand-entry merge are in lib/ismFeed.js (pure, shared with the app).
import { kvGetJson, kvSetJsonEx, kvConfigured } from './kv.js';
import { ISM_NEWSROOM_URL, ISM_MONTHS_BACK, ismLinksFromNewsroom, ismFromRelease, ismSeries } from './ismFeed.js';

// An honest user agent (20 Nov 2026). The page answers a plain client from outside; from the
// server it has answered 403 since November. A refusal is not worked around (no browser disguise,
// no proxy): the leg says so and the month is entered by hand on Ops › Needs you.
const UA = 'dvcap-research/1.0 (personal market dashboard; reads ISM PMI releases)';
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
    const msg = String(e?.message || e);
    const refused = /HTTP 40[13]/.test(msg);
    return { ok: false, refused, error: (refused ? `PR Newswire refused dvcap's server (${msg.match(/HTTP 40[13]/)[0]}) — enter the month on Ops › Needs you` : msg).slice(0, 160) };
  }
}
