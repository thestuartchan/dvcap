// test/fredCache.test.mjs — one FRED answer per window, across invocations.
// 2026-09-21: a Macro tab load fired ~150 FRED requests in one minute against a 120/min key and
// the newest legs came back 429. The gate bounds one invocation; the cache is what bounds a page.
import { fredJsonEx, fredCacheKey, isFredMetaUrl, FRED_OBS_TTL_S, FRED_META_TTL_S } from '../lib/fred.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

const OBS = 'https://api.stlouisfed.org/fred/series/observations?series_id=ICSA&sort_order=desc&limit=16&api_key=SECRET&file_type=json';
const META = 'https://api.stlouisfed.org/fred/series?series_id=ICSA&api_key=SECRET&file_type=json';
const memKv = () => { const m = new Map(); return { configured: () => true, get: async k => m.get(k) ?? null, setEx: async (k, v, s) => { m.set(k, { ...v, _ttl: s }); }, m }; };
const noKv = { configured: () => false };
const T0 = Date.parse('2026-09-21T07:00:00Z');
const okResp = (body) => ({ ok: true, status: 200, json: async () => body });
const counting = (impl) => { const f = async (url) => { f.calls++; return impl(url); }; f.calls = 0; return f; };

// ── THE KEY ──────────────────────────────────────────────────────────────────
{
  ok('the key does not contain the api key', !fredCacheKey(OBS).includes('SECRET'));
  eq('two keys for the same request differ only by api key are one', fredCacheKey(OBS), fredCacheKey(OBS.replace('SECRET', 'OTHER')));
  ok('and a different request is a different key', fredCacheKey(OBS) !== fredCacheKey(OBS.replace('limit=16', 'limit=30')));
  eq('a metadata url is recognised', [isFredMetaUrl(META), isFredMetaUrl(OBS)], [true, false]);
  ok('the ttls: a quarter hour and a week', FRED_OBS_TTL_S === 900 && FRED_META_TTL_S === 7 * 86400);
}

// ── HIT, MISS, EXPIRY ────────────────────────────────────────────────────────
{
  const kv = memKv();
  const fetcher = counting(async () => okResp({ observations: [{ date: '2026-09-17', value: '231000' }] }));
  const a = await fredJsonEx(OBS, 'ICSA', { kv, fetcher, now: () => T0 });
  eq('first call fetches and stores', [a.source, a.body.observations[0].value, fetcher.calls, kv.m.get(fredCacheKey(OBS))?._ttl], ['live', '231000', 1, FRED_OBS_TTL_S]);
  const b = await fredJsonEx(OBS, 'ICSA', { kv, fetcher, now: () => T0 + 5 * 60000 });
  eq('five minutes later it is served from the store', [b.source, fetcher.calls], ['kv', 1]);
  const c = await fredJsonEx(OBS, 'ICSA', { kv, fetcher, now: () => T0 + 16 * 60000 });
  eq('sixteen minutes later it fetches again', [c.source, fetcher.calls], ['live', 2]);
  const m = await fredJsonEx(META, 'ICSA (title check)', { kv, fetcher, now: () => T0 });
  eq('a title check is kept for a week', kv.m.get(fredCacheKey(META))?._ttl, FRED_META_TTL_S);
  ok('…and returned', m.source === 'live');
  const m2 = await fredJsonEx(META, 'ICSA (title check)', { kv, fetcher, now: () => T0 + 3 * 86400000 });
  eq('three days on, still from the store', m2.source, 'kv');
}

// ── A FAILED FETCH SERVES THE LAST GOOD BODY ─────────────────────────────────
{
  const kv = memKv();
  let good = true;
  const fetcher = counting(async () => good ? okResp({ observations: [{ value: '1' }] }) : ({ ok: false, status: 429, json: async () => ({}) }));
  await fredJsonEx(OBS, 'ICSA', { kv, fetcher, now: () => T0 });
  good = false;
  const s = await fredJsonEx(OBS, 'ICSA', { kv, fetcher, now: () => T0 + 20 * 60000, tries: 2 });
  eq('after the window, a 429 serves the stale copy and says so', [s.source, s.error, s.body.observations[0].value, fetcher.calls], ['stale', 'HTTP 429', '1', 3]);
  const kv2 = memKv();
  const n = await fredJsonEx(OBS, 'ICSA', { kv: kv2, fetcher, now: () => T0, tries: 1 });
  eq('with nothing stored a failure is a failure', [n.source, n.body, n.error], [null, null, 'HTTP 429']);
  ok('and nothing bad is stored', kv2.m.size === 0);
  // A 400 is not retried: the request itself is wrong.
  const bad = counting(async () => ({ ok: false, status: 400, json: async () => ({}) }));
  const b = await fredJsonEx(OBS, 'ICSA', { kv: memKv(), fetcher: bad, tries: 3 });
  eq('a 400 is asked once', [b.error, bad.calls], ['HTTP 400', 1]);
}

// ── NO STORE: EVERY CALL FETCHES, NOTHING BREAKS ─────────────────────────────
{
  const fetcher = counting(async () => okResp({ observations: [] }));
  await fredJsonEx(OBS, 'ICSA', { kv: noKv, fetcher });
  const r = await fredJsonEx(OBS, 'ICSA', { kv: noKv, fetcher });
  eq('without a store each call fetches', [r.source, fetcher.calls], ['live', 2]);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
