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
export function hasServiceKey(req, envName) {
  const want = String(process.env[envName] || '').trim();
  if (!want) return false;
  const got = String(req?.query?.key ?? req?.headers?.['x-tradecard-key'] ?? req?.headers?.['x-api-key'] ?? '').trim();
  return got.length === want.length && got === want;
}

// The gate. A browser session, or a service key when one is configured.
export function authorised(req, { serviceEnv = null } = {}) {
  return hasSessionCookie(req) || (serviceEnv ? hasServiceKey(req, serviceEnv) : false);
}

// Refuse in one line, without describing what is behind the door.
export function refuse(res, why = 'not authenticated — log in to the dashboard first') {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(401).json({ error: why });
  return true;
}
