// lib/calendarAutoFetch.js — fetch the automatic calendar's sources and keep the answer for 12 hours.
//
// lib/calendarAuto.js parses; this fetches. One KV copy serves every request for 12 hours, so the
// central banks' and agencies' pages are read a couple of times a day rather than on every load.
// A source that fails keeps the rest; when everything fails, the last good copy is served and says
// how old it is. Public schedules only — nothing about the account touches this.
import { buildAutoCalendar, AUTO_SOURCES, FRED_RELEASES } from './calendarAuto.js';
import { fredReleaseDates } from './fred.js';
import { kvGetJson, kvSetJsonEx, kvConfigured } from './kv.js';

export const CAL_AUTO_KEY = 'dvcap:calendar:auto:v1';
export const CAL_AUTO_TTL_S = 12 * 3600;
const UA = 'Mozilla/5.0 (compatible; dvcap-calendar; +https://dvcap.vercel.app)';

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
// this failed on Vercel and passed everywhere else.
export async function autoCalendar({ now = new Date(), fetchImpl = fetch, kv = { configured: kvConfigured, get: kvGetJson, setEx: kvSetJsonEx }, fredDates = fredReleaseDates } = {}) {
  let cached = null;
  if (kv.configured()) {
    try { cached = await kv.get(CAL_AUTO_KEY); } catch { cached = null; }
    const age = cached?.at ? (now - Date.parse(cached.at)) / 1000 : Infinity;
    if (cached?.events && age >= 0 && age < CAL_AUTO_TTL_S) return { ...cached, cache: 'kv' };
  }
  const from = new Date(now.getTime() - 3 * 86400000).toISOString().slice(0, 10);
  const names = Object.keys(AUTO_SOURCES);
  const pages = Object.fromEntries(await Promise.all(names.map(async n => [n, await page(AUTO_SOURCES[n], fetchImpl)])));
  const fred = await fredDates(Object.keys(FRED_RELEASES), { from }).catch(e => ({ dates: {}, errors: { all: String(e?.message || e) } }));
  const built = buildAutoCalendar({ pages, fred, from });
  const out = { at: now.toISOString(), events: built.events, sources: built.sources };
  if (!built.events.length && cached?.events?.length) return { ...cached, cache: 'stale', sources: built.sources };
  if (kv.configured() && built.events.length) { try { await kv.setEx(CAL_AUTO_KEY, out, CAL_AUTO_TTL_S); } catch { /* uncached is slower, not wrong */ } }
  return { ...out, cache: 'live' };
}
