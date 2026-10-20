// lib/narrativeFeed.js — the Signal Board's Narrative input: how much of the world's news is about the AI
// build-out, and the tone of it, from the GDELT DOC 2.0 API.
//
// WHY GDELT. Free, no sign-up, no credential, and NOT a model: GDELT counts the articles its crawlers
// match to a query, with the day's total article count beside it (so the count becomes a share of all
// coverage), and scores tone with a fixed word dictionary (positive minus negative word share). Nothing
// here calls an LLM or an embedding (scripts/check-no-llm-feeds.mjs). Daily resolution back to 2017-01.
//
// THE QUERY is NARRATIVE_QUERY below: the story Crown tracks — AI capex, data centres, hyperscaler
// spending, AI chips — English-language sources only. "data center" also catches non-AI coverage; from
// 2023 the AI build-out dominates it, and the coverage measure is a change in share, not a level.
//
// RATE LIMITS. GDELT asks for one request every five seconds per address and answers 429 otherwise; a
// serverless address is shared, so 429s happen. The two series (article count, tone) are cached
// separately in KV for NARRATIVE_FRESH_S, each refreshed alone, the second only after a 5.5-second gap
// and not at all after a 429 or a timeout (GDELT tarpits a throttled address), each with a 12-second
// timeout. On a failed refresh the last good copy is served (for up to NARRATIVE_KEEP_S). With nothing
// usable the row reads "not available" and the board carries on without it.
//
// Market data only: no account, book or journal store is read on this path.
import { kvGetJson, kvSetJsonEx, kvConfigured } from './kv.js';

export const GDELT_DOC_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
export const NARRATIVE_QUERY = '("data center" OR "data centers" OR hyperscaler OR hyperscalers OR "AI capex" OR "AI chip" OR "AI chips" OR "AI spending" OR "AI infrastructure") sourcelang:english';
export const NARRATIVE_CACHE_ID = 'dvcap:signalboard:narrative:v1';
export const NARRATIVE_FRESH_S = 3 * 3600;        // the daily series change once a day; three hours is plenty
export const NARRATIVE_KEEP_S = 4 * 86400;        // last good copy kept this long
export const NARRATIVE_LOOKBACK_D = 75;           // 20 + 20 days of coverage plus the tone windows and slack
const GAP_MS = 5500;

const ymd = (d) => d.toISOString().slice(0, 10);
const gdeltStamp = (d) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);

export function gdeltUrl(mode, { now = new Date(), days = NARRATIVE_LOOKBACK_D, start = null, end = null, query = NARRATIVE_QUERY } = {}) {
  const s = start || new Date(now.getTime() - days * 864e5);
  const e = end || now;
  const p = new URLSearchParams({ query, mode, format: 'json', timelinesmooth: '0', startdatetime: gdeltStamp(s), enddatetime: gdeltStamp(e) });
  return `${GDELT_DOC_URL}?${p}`;
}

// GDELT's timeline JSON → ascending [{date, ...}]. timelinevolraw carries {value: matching articles,
// norm: all articles monitored that day}; timelinetone {value: average tone}. Days GDELT did not
// collect (norm 0) are dropped, and so is the current UTC day, which is still filling.
export function parseTimeline(json, mode, { now = new Date() } = {}) {
  const data = json?.timeline?.[0]?.data;
  if (!Array.isArray(data)) return [];
  const today = ymd(now);
  const out = [];
  for (const x of data) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(x?.date || ''));
    if (!m) continue;
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    if (date >= today) continue;
    const v = Number(x.value);
    if (!Number.isFinite(v)) continue;
    if (mode === 'timelinevolraw') {
      const norm = Number(x.norm);
      if (!(norm > 0) || !(v > 0)) continue;   // a zero day is a collection gap, not zero coverage
      out.push({ date, count: v, norm });
    } else out.push({ date, tone: v });
  }
  return out;
}

// Join the two parsed series on date: [{date, count, norm, tone}].
export function joinNarrative(vol = [], tone = []) {
  const t = new Map((tone || []).map(o => [o.date, o.tone]));
  return (vol || []).filter(o => t.has(o.date)).map(o => ({ date: o.date, count: o.count, norm: o.norm, tone: t.get(o.date) }));
}

async function fetchMode(mode, { now, fetchImpl }) {
  const r = await fetchImpl(gdeltUrl(mode, { now }), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw Object.assign(new Error(`GDELT ${mode} HTTP ${r.status}`), { status: r.status });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`GDELT ${mode}: not JSON (rate limited?)`); }
  const rows = parseTimeline(j, mode, { now });
  if (!rows.length) throw new Error(`GDELT ${mode}: no rows`);
  return rows;
}

let memo = null;   // per-instance copy when KV is not configured (local runs)

// { at, series: [{date, count, norm, tone}], errors: [], source: 'kv'|'live'|'stale'|'none' }.
export async function narrativeInputs({ now = new Date(), fetchImpl = (...a) => fetch(...a), sleep = (ms) => new Promise(r => setTimeout(r, ms)),
  kv = { configured: kvConfigured, get: kvGetJson, setEx: kvSetJsonEx } } = {}) {
  let cached;
  try { cached = kv.configured() ? await kv.get(NARRATIVE_CACHE_ID) : memo; } catch { cached = memo; }
  const age = (p) => (p?.at ? (now.getTime() - Date.parse(p.at)) / 1000 : Infinity);
  const parts = { vol: cached?.vol ?? null, tone: cached?.tone ?? null };
  const errors = [];
  let fetched = 0, limited = false;
  for (const [k, mode] of [['vol', 'timelinevolraw'], ['tone', 'timelinetone']]) {
    if (age(parts[k]) >= 0 && age(parts[k]) < NARRATIVE_FRESH_S) continue;
    const name = `GDELT ${k === 'vol' ? 'coverage' : 'tone'}`;
    // After a 429 the second request would only extend the penalty: skip it, keep its last good copy.
    if (limited) { errors.push({ series: name, error: 'skipped: rate limited or timed out on the request before' }); }
    else {
      if (fetched) await sleep(GAP_MS);
      fetched++;
      try { parts[k] = { at: now.toISOString(), rows: await fetchMode(mode, { now, fetchImpl }) }; continue; }
      catch (e) {
        // GDELT tarpits a throttled address (a 429 after ~15s), so a timeout counts as throttled too.
        limited = e?.status === 429 || e?.name === 'TimeoutError' || e?.name === 'AbortError';
        errors.push({ series: name, error: String(e?.message || e).slice(0, 80) });
      }
    }
    if (!(age(parts[k]) < NARRATIVE_KEEP_S)) parts[k] = null;
  }
  if (fetched && (parts.vol || parts.tone)) {
    const rec = { vol: parts.vol, tone: parts.tone };
    memo = rec;
    try { if (kv.configured()) await kv.setEx(NARRATIVE_CACHE_ID, rec, NARRATIVE_KEEP_S); } catch { /* served uncached */ }
  }
  const series = parts.vol && parts.tone ? joinNarrative(parts.vol.rows, parts.tone.rows) : [];
  const source = !series.length ? 'none' : !fetched ? 'kv' : errors.length ? 'stale' : 'live';
  const at = [parts.vol?.at, parts.tone?.at].filter(Boolean).sort()[0] ?? null;
  return { at, series, errors, source };
}
