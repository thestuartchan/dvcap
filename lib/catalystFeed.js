// catalystFeed.js — the catalyst window's inputs, assembled: the ONE macro calendar, the earnings
// feed (cached a day per name, with when it was fetched), the hand-kept read-across map, and the US
// holiday list. lib/catalyst.js decides; this only gathers. The route is api/flex-sync.js
// ?catalyst=SYM — on the account route because the function count is at the cap, and gated for
// the same reason the greeks are: which names are being sized is the book.
//
// THE FEED. Nasdaq's analyst endpoint (Zacks-sourced, keyless) says "is expected to report" for a
// company-confirmed date and "is estimated to report … derived from an algorithm" for a projected
// one, so the confirmed/estimated flag the brief asks for is the vendor's own wording, not a
// guess. The answer is cached in KV per name for 24h and served with its fetchedAt so the panel
// can say how old it is; a feed ERROR falls back to the last cached answer rather than nothing,
// stamped with the time it was actually fetched, and with no cache it reads "unavailable — check
// manually". Nothing here is an LLM or a search summary.
import readAcrossMap from '../data/readacross.json' with { type: 'json' };
import holidays from '../data/holidays.json' with { type: 'json' };
import { eventsBetween } from './calendar.js';
import { fetchEarnings } from './earnings.js';
import { kvGetJson, kvSetJson, kvConfigured } from './kv.js';
import { catalystWindow, monthlyOpex, earningsNameFor, readAcrossFor, TAIL_DAYS } from './catalyst.js';

export const EARNINGS_KEY = (sym) => `dvcap:earnings:v1:${String(sym || '').toUpperCase()}`;
export const EARNINGS_TTL_MS = 24 * 3600 * 1000;
// Stocks have no expiry: the window for "next earnings" looks this far ahead.
export const STOCK_LOOKAHEAD_DAYS = 120;

const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const DEFAULT_KV = { configured: kvConfigured, get: kvGetJson, set: kvSetJson };

// One name's earnings answer, cached. `fetcher` and `kv` are injectable so the cache logic is
// testable without the network or Redis.
export async function earningsCached(symbol, { fetcher = fetchEarnings, kv = DEFAULT_KV, now = Date.now(), ttlMs = EARNINGS_TTL_MS } = {}) {
  const sym = String(symbol || '').toUpperCase().trim();
  if (!sym) return null;
  const key = EARNINGS_KEY(sym);
  let cached = null;
  if (kv.configured()) {
    try { cached = await kv.get(key); } catch { cached = null; }
    const age = cached?.fetchedAt ? now - Date.parse(cached.fetchedAt) : Infinity;
    if (Number.isFinite(age) && age >= 0 && age < ttlMs) return { ...cached, cache: 'kv' };
  }
  const fresh = await fetcher(sym);
  const feedError = !fresh?.ok && /^feed error/.test(String(fresh?.why || ''));
  // A vendor answer — a date, "hasn't provided", or "not a single name" — is worth remembering
  // for a day. A transport failure is not; the last real answer is served instead, its own
  // fetchedAt intact so the display can date it.
  if (feedError && cached) return { ...cached, cache: 'kv-stale', stale: true };
  if (!feedError && kv.configured()) { try { await kv.set(key, fresh); } catch { /* the answer still returns */ } }
  return { ...fresh, cache: feedError ? 'none' : 'fresh' };
}

// Which side of the calendar a symbol trades on. The calendar carries region + scope:'global';
// a US name wants US and global events, an HK or KS code wants ASIA and global.
export function regionFor(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (/\.(HK|KS|KQ|TW|T|SS|SZ)$/.test(s) || /^\d{4,6}$/.test(s)) return 'ASIA';
  if (/\.(L|DE|PA|AS|MI|MC|SW|ST)$/.test(s)) return 'EU';
  return 'US';
}

// The macro leg: tier-1 calendar events for the region plus global ones, and the generated monthly
// opex dates (the calendar does not carry them). Deduplicated on date+title.
export function macroFor(symbol, from, to) {
  const R = regionFor(symbol);
  const seen = new Set();
  const out = [];
  for (const e of [...eventsBetween(from, to), ...monthlyOpex(from, to)]) {
    if ((e.tier ?? 2) > 1) continue;
    if (e.region && e.region !== R && e.scope !== 'global' && !e.generated) continue;
    const k = `${e.date}|${String(e.title).toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ date: e.date, title: e.title, tier: e.tier ?? 1, region: e.region ?? null, scope: e.scope ?? null, time: e.time ?? null, generated: !!e.generated });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// The whole lookup. Returns the catalystWindow plus the macro list the sizer's own expiry check
// consumes, so one call feeds both.
export async function catalystLookup({ symbol, expiry = null, kind = 'option', today = iso(new Date()), fetcher, kv, now, map = readAcrossMap } = {}) {
  const sym = String(symbol || '').toUpperCase().trim();
  if (!sym) return { ok: false, reason: 'no symbol' };
  const isOption = kind === 'option' && /^\d{4}-\d{2}-\d{2}$/.test(expiry || '');
  const to = isOption ? addDays(expiry, TAIL_DAYS) : addDays(today, STOCK_LOOKAHEAD_DAYS);
  const macro = macroFor(sym, today, to);
  const name = earningsNameFor(sym);
  const keys = readAcrossFor(sym, map);
  const opts = { fetcher, kv, now };
  const [own, ...readAcross] = await Promise.all([
    name ? earningsCached(name, opts) : Promise.resolve(null),
    ...keys.map(k => earningsCached(k, opts).then(a => (a ? { key: k, ...a } : null))),
  ]);
  const w = catalystWindow({ symbol: sym, kind: isOption ? 'option' : 'stock', expiry: isOption ? expiry : null, today,
                             macro, own, readAcross: readAcross.filter(Boolean), holidays: holidays.US?.closed || [] });
  return { ok: true, ...w, macro, readAcrossKeys: keys };
}
