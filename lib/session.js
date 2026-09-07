// lib/session.js — the dashboard session cookie, signed.
//
// WHAT WAS WRONG. The cookie was the literal string `mwd_auth=true`, and the check was a regex
// looking for that literal. It carried no secret, so it proved nothing: anyone could send
//
//     Cookie: mwd_auth=true
//
// and be a logged-in session. The value is not even a guess — it is written in api/login.js, in
// middleware.js and in lib/apiauth.js, in a PUBLIC repository. Every route hardened on 2026-09-06
// was hardened against callers who send no cookie, which is not the caller anyone was worried
// about. The four quantities lib/tradecard.js refuses to publish — equity, size, absolute P&L,
// share of book — were one header away, and with HYPERLIQUID_ADDRESS configured the live perp
// book, its leverage and its liquidation prices join them.
//
// WHAT REPLACES IT. A token the server can verify and nobody else can produce:
//
//     mwd_auth = v1.<expiry-epoch-seconds>.<HMAC-SHA256(DASHBOARD_PASSWORD, "v1.<expiry>")>
//
// The password is never in the cookie — an HMAC is one-way, so a stolen cookie is a session and
// not the password. The expiry is signed rather than merely declared, so it cannot be edited
// forward, and it is CHECKED here rather than left to `Max-Age`, which is the browser's promise
// to itself and no constraint on a caller with curl.
//
// WEB CRYPTO, NOT node:crypto, so ONE implementation serves both runtimes. middleware.js runs on
// the edge, where node:crypto does not exist; the API routes run on Node, where `crypto.subtle`
// has been global since 18. Two implementations of one signature is a drift waiting to happen,
// and the drift would be silent in exactly the direction that matters.
//
// The cost is that verification is ASYNC, which makes `authorised()` async — and a forgotten
// `await` returns a Promise, which is truthy, which is the fail-open shape all over again.
// scripts/check-api-auth.mjs fails the build on a call site that omits it.

const ENC = new TextEncoder();

export const COOKIE_NAME = 'mwd_auth';
export const SESSION_ENV = 'DASHBOARD_PASSWORD';   // already set; no new configuration to do
export const SESSION_VERSION = 'v1';
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 7; // a week, as before

// One cookie out of a header. Deliberately not a full cookie parser: the name is fixed and the
// value is base16 plus two dots, so anything a parser would rescue is something we reject anyway.
export function readCookie(header, name = COOKIE_NAME) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(String(header || ''));
  return m ? m[1] : null;
}

const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function sign(message, secret) {
  const key = await crypto.subtle.importKey('raw', ENC.encode(String(secret)),
                                            { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, ENC.encode(message)));
}

// Constant time in the LENGTH THEY SHARE. Both operands here are fixed-width hex, so leaking that
// two strings differ in length leaks nothing; what must not leak is WHERE they first differ, which
// is what an early-returning `===` on a long string would time out for an attacker.
export function sameDigest(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  if (!x.length || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// Mint. Returns null when no secret is configured — a session that cannot be verified must never
// be issued, or the next deploy hands out cookies that nothing will ever accept.
export async function mintSession(secret, { now = Date.now(), maxAgeS = SESSION_MAX_AGE_S } = {}) {
  if (!secret) return null;
  const exp = Math.floor(now / 1000) + maxAgeS;
  const body = `${SESSION_VERSION}.${exp}`;
  return `${body}.${await sign(body, secret)}`;
}

// Verify. FAILS CLOSED on every path — no secret, no token, wrong shape, wrong version, expired,
// bad signature. `if (!secret) return true` is the mistake this file exists to not make twice.
export async function verifySession(token, secret, { now = Date.now() } = {}) {
  if (!secret || !token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3) return false;
  const [version, expRaw, sig] = parts;
  if (version !== SESSION_VERSION) return false;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp <= 0 || exp * 1000 <= now) return false;
  // ONE CANONICAL SPELLING. Re-signing from the parsed number would accept "v1.017…" and "v1.17…"
  // as the same session, because both parse to the same integer and therefore sign identically.
  // Harmless on its own — the expiry is unchanged either way — but a token with several valid
  // forms is a token that logging, rate-limiting and revocation all count differently.
  if (String(exp) !== expRaw) return false;
  return sameDigest(sig, await sign(`${SESSION_VERSION}.${exp}`, secret));
}

// The Set-Cookie line, so login and any future re-issue cannot disagree about the flags.
// HttpOnly keeps it away from page script, Secure from plaintext, SameSite=Strict from being sent
// along by another origin — the last of which matters more now that the value is worth stealing.
export function sessionCookie(token, { maxAgeS = SESSION_MAX_AGE_S } = {}) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeS}`;
}
