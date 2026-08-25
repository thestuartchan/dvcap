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

const URL_ENV = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
const TOK_ENV = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;

export const kvConfigured = () => !!(URL_ENV() && TOK_ENV());

// One Redis command via the generic REST endpoint: POST body ["SET","key","value"].
// Returns the `result` field, or null on any failure — a KV outage must degrade the console to
// its local copy, never surface as a 500 that takes the whole manual-entry endpoint down.
async function command(args) {
  const url = URL_ENV(), token = TOK_ENV();
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
