// lib/calendarAutoFetch.js — fetch the automatic calendar's sources and keep the answer for 12 hours.
//
// lib/calendarAuto.js parses; this fetches. One KV copy serves every request for 12 hours, so the
// central banks' and agencies' pages are read a couple of times a day rather than on every load.
// A source that fails keeps the rest; when everything fails, the last good copy is served and says
// how old it is. Public schedules only — nothing about the account touches this.
import { buildAutoCalendar, AUTO_SOURCES, FRED_RELEASES, WATCH, latestStatementUrl, parseFomcStatement } from './calendarAuto.js';
import { fredReleaseDates } from './fred.js';
import { kvGetJson, kvSetJsonEx, kvConfigured } from './kv.js';
import { fetchDartEarnings } from './dartEarnings.js';

export const CAL_AUTO_KEY = 'dvcap:calendar:auto:v3';   // v2: earnings rows and the latest FOMC decision; v3: Korea earnings (DART)
export const CAL_AUTO_TTL_S = 12 * 3600;
// THE WATCH IS ~100 NAMES now that the pre-read watchlist's US names ride along (lib/universeAdded.js):
// one Nasdaq request each, asked sixteen at a time rather than all at once, so the feed is not hit with
// a hundred requests in the same instant and a slow one does not hold a hundred sockets open.
export const EARNINGS_CONCURRENCY = 16;
export async function pooled(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}
const UA = 'Mozilla/5.0 (compatible; dvcap-calendar; +https://dvcap.vercel.app)';

// Nasdaq's public JSON API closes the connection on a self-identifying script User-Agent and
// answers a browser's, the same as Yahoo does for the quote reads in api/indicators.js. Market
// data only; nothing is sent but the symbol.
const NASDAQ_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
async function earningsFor(sym, fetchImpl) {
  try {
    const r = await fetchImpl(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(sym)}/earnings-date`,
      { headers: { 'User-Agent': NASDAQ_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) { return { error: String(e?.message || e).slice(0, 120) }; }
}

async function page(url, fetchImpl) {
  try {
    const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return { html: await r.text() };
  } catch (e) { return { error: String(e?.message || e).slice(0, 120) }; }
}

// `fredDates` is injectable for the same reason `fetchImpl` and `kv` are: the build runs the tests
// with the deployment's FRED key and KV present, and a test that reaches the real FRED (or writes
// the real cache) answers differently there than anywhere else — 18 Oct 2026, the build that merged
// this failed on Vercel and passed everywhere else. `dartEarnings` likewise: the deployment holds
// DART_API_KEY and a test run there would otherwise reach DART.
export async function autoCalendar({ now = new Date(), fetchImpl = fetch, kv = { configured: kvConfigured, get: kvGetJson, setEx: kvSetJsonEx }, fredDates = fredReleaseDates, dartEarnings = fetchDartEarnings } = {}) {
  let cached = null;
  if (kv.configured()) {
    try { cached = await kv.get(CAL_AUTO_KEY); } catch { cached = null; }
    const age = cached?.at ? (now - Date.parse(cached.at)) / 1000 : Infinity;
    if (cached?.events && age >= 0 && age < CAL_AUTO_TTL_S) return { ...cached, cache: 'kv' };
  }
  const from = new Date(now.getTime() - 3 * 86400000).toISOString().slice(0, 10);
  const names = Object.keys(AUTO_SOURCES);
  const pages = Object.fromEntries(await Promise.all(names.map(async n => [n, await page(AUTO_SOURCES[n], fetchImpl)])));
  const [fred, earnings, fomcLatest, dart] = await Promise.all([
    fredDates(Object.keys(FRED_RELEASES), { from }).catch(e => ({ dates: {}, errors: { all: String(e?.message || e) } })),
    pooled(WATCH, EARNINGS_CONCURRENCY, async w => [w.sym, await earningsFor(w.sym, fetchImpl)]).then(Object.fromEntries),
    // The decision in force: the newest statement the FOMC calendar page links.
    (async () => {
      const at = latestStatementUrl(pages.fomc?.html);
      if (!at) return null;
      const p = await page(at.url, fetchImpl);
      return p.html ? parseFomcStatement(p.html, at) : null;
    })(),
    dartEarnings({ fetchImpl, now }).catch(e => ({ events: [], source: { ok: false, error: String(e?.message || e).slice(0, 120) } })),
  ]);
  const built = buildAutoCalendar({ pages, fred, earnings, dart, from });
  const out = { at: now.toISOString(), events: built.events, sources: built.sources, fomcLatest };
  if (!built.events.length && cached?.events?.length) return { ...cached, cache: 'stale', sources: built.sources };
  if (kv.configured() && built.events.length) { try { await kv.setEx(CAL_AUTO_KEY, out, CAL_AUTO_TTL_S); } catch { /* uncached is slower, not wrong */ } }
  return { ...out, cache: 'live' };
}
