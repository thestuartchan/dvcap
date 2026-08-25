// lib/kv.js — Upstash Redis over its REST API, for state that must persist across DEVICES but
// must NOT accumulate history.
//
// WHY THIS EXISTS. The manual-entry store commits to data/manual_entry.json in the repo, which is
// right for curated macro inputs — a recession override or a ZQ print is something you want to see
// the revision history of. It is wrong for the trade console: positions, cost basis and a journal
// are personal, change constantly, and a permanent diffable git history of them is a liability
// rather than a feature. Redis writes REPLACE, so nothing accumulates.
//
// Deliberately no SDK. Upstash's REST API is a bearer-token HTTPS endpoint, so raw fetch keeps this
// project's zero-backend-dependency discipline (package.json carries only react/react-dom/recharts)
// and avoids a cold-start cost on a Hobby function.
//
// Env (both auto-injected by the Vercel ↔ Upstash integration):
//   KV_REST_API_URL    e.g. https://xxx-yyy-12345.upstash.io
//   KV_REST_API_TOKEN  bearer token
// Absent → every call returns null / false and the caller falls back to its previous store. The
// console therefore keeps working on localStorage before the integration is added.

// Credential DISCOVERY rather than fixed names. Vercel's Upstash integration lets you set a custom
// env-var prefix at install time (STORAGE_…, REDIS_…, KV_…), so hard-coding KV_REST_API_URL would
// leave the console silently unsynced if any other prefix was chosen — a setup failure that looks
// identical to "not installed yet". Instead: prefer the canonical names, then fall back to scanning
// for any *_REST_API_URL pointing at upstash.io and its matching token.
//
// Only an HTTPS endpoint is accepted. Upstash also provisions a `rediss://` protocol URL for TCP
// clients; passing that to fetch() would fail, so the scheme check is load-bearing, not cosmetic.
const isRestUrl = (v) => typeof v === 'string' && /^https:\/\//.test(v) && /upstash\.io/.test(v);

function discover() {
  const env = process.env;
  for (const [u, t] of [
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  ]) {
    if (isRestUrl(env[u]) && env[t]) return { url: env[u], token: env[t] };
  }
  // Any prefix: match <PREFIX>_REST_API_URL with a sibling <PREFIX>_REST_API_TOKEN.
  for (const key of Object.keys(env)) {
    if (!/REST_API_URL$/.test(key) || !isRestUrl(env[key])) continue;
    const prefix = key.replace(/REST_API_URL$/, '');
    const token = env[`${prefix}REST_API_TOKEN`];
    if (token) return { url: env[key], token };
  }
  // Last resort: any upstash REST URL plus any REST token, whatever they are named.
  const url = Object.keys(env).find(k => isRestUrl(env[k]));
  const tok = Object.keys(env).find(k => /REST_API_TOKEN$|REST_TOKEN$/.test(k) && env[k]);
  if (url && tok) return { url: env[url], token: env[tok] };
  return { url: null, token: null };
}

const URL_ENV = () => discover().url;
const TOK_ENV = () => discover().token;

export const kvConfigured = () => { const d = discover(); return !!(d.url && d.token); };

// One Redis command via the generic REST endpoint: POST body ["SET","key","value"].
// Returns the `result` field, or null on any failure — a KV outage must degrade the console to
// its local copy, never surface as a 500 that takes the whole manual-entry endpoint down.
async function command(args) {
  const { url, token } = discover();
  if (!url || !token) return null;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) {
      console.error('KV command failed', args[0], r.status);
      return null;
    }
    const j = await r.json();
    return j?.result ?? null;
  } catch (e) {
    console.error('KV command error', args[0], e?.message || e);
    return null;
  }
}

// Read a JSON value. Returns null when unset, unconfigured, or unparseable — all of which mean
// "no server copy", which the caller handles identically.
export async function kvGetJson(key) {
  const raw = await command(['GET', key]);
  if (raw == null) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

// Write a JSON value. Returns true only on a confirmed OK, so the caller can tell the user
// honestly whether the state actually synced or is still only local.
export async function kvSetJson(key, value) {
  const res = await command(['SET', key, JSON.stringify(value)]);
  return res === 'OK' || res === true;
}

// Namespaced key for the trade console's state.
export const CONSOLE_KEY = 'dvcap:console:v1';
