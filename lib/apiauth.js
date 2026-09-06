// lib/apiauth.js — who is allowed to call an API route.
//
// THE MIDDLEWARE ONLY GATES `/`. middleware.js matches the app shell and serves a login page to
// anyone without the cookie, which makes the DASHBOARD feel protected — and protects none of the
// routes under /api, because the matcher never sees them. Each route has to check for itself, and
// the ones that did were the ones somebody remembered.
//
// Verified against production on 2026-09-06, unauthenticated, from outside:
//
//   GET /api/manual-entry  -> 200, the whole trade console: 37 rows with fills, cost basis, and
//                             settings.equity — the account balance itself.
//   GET /api/flex-sync     -> 200, the IBKR account, its positions and their summary.
//   GET /api/tradecard     -> 200, and it does not merely read: it rebuilds and POSTS the Discord
//                             card, because its check returns true when no secret is configured.
//
// Those four quantities — equity, position size, absolute P&L, share of book — are exactly what
// lib/tradecard.js refuses to publish, enforced there by construction and by test. The card was
// guarded with care while the endpoint underneath it served the same numbers to anyone who asked.
//
// FAIL CLOSED. The tradecard check read `if (!want) return true` — no secret configured, everyone
// welcome — which is the shape that turns a missing environment variable into an open door.

export const AUTH_COOKIE = 'mwd_auth=true';

// The dashboard session cookie, set by api/login.js.
export function hasSessionCookie(req) {
  return /(^|;\s*)mwd_auth=true(;|$)/.test(req?.headers?.cookie || '');
}

// A machine caller (a cron) presenting a shared secret. Absent configuration this is FALSE, never
// true — a route with no secret set is not a route everyone may call.
//
// ONE NAME, TWO PLACES. The workflow sends `secrets.TRADECARD_KEY` and the server read
// `TRADECARD_SECRET`: the same value under two names, in two systems, which is a configuration
// task nobody can hold in their head. TRADECARD_KEY is now the name on BOTH sides. TRADECARD_SECRET
// is still accepted so an existing deployment does not break the moment this ships.
export const SERVICE_KEY_ENVS = ['TRADECARD_KEY', 'TRADECARD_SECRET'];

export function hasServiceKey(req, envNames = SERVICE_KEY_ENVS) {
  const names = Array.isArray(envNames) ? envNames : [envNames];
  const got = String(req?.query?.key ?? req?.headers?.['x-tradecard-key'] ?? req?.headers?.['x-api-key'] ?? '').trim();
  if (!got) return false;
  for (const n of names) {
    const want = String(process.env[n] || '').trim();
    if (want && got.length === want.length && got === want) return true;
  }
  return false;
}

// Is a machine caller able to authenticate at all? Used to say WHY a cron is being refused —
// "no key configured" and "wrong key" are different problems and only one is the caller's.
export const serviceKeyConfigured = () => SERVICE_KEY_ENVS.some(n => String(process.env[n] || '').trim());

// The gate. A browser session, or a service key when one is configured.
export function authorised(req, { serviceEnv = SERVICE_KEY_ENVS } = {}) {
  return hasSessionCookie(req) || (serviceEnv ? hasServiceKey(req, serviceEnv) : false);
}

// The refusal a CRON should see: it names which side is unconfigured, because a workflow log
// saying "unauthorised" tells whoever reads it nothing about what to change.
export function refusalReason(req) {
  if (!serviceKeyConfigured()) {
    return `no service key configured on the server — set TRADECARD_KEY in the deployment's `
         + `environment variables, and the same value as the TRADECARD_KEY repository secret`;
  }
  const sent = req?.query?.key ?? req?.headers?.['x-tradecard-key'] ?? req?.headers?.['x-api-key'];
  return sent
    ? 'the key presented does not match TRADECARD_KEY on the server'
    : 'no key presented — send it as the x-tradecard-key header';
}

// Refuse in one line, without describing what is behind the door.
export function refuse(res, why = 'not authenticated — log in to the dashboard first') {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(401).json({ error: why });
  return true;
}
