// test/apiauth.test.mjs — who may call an API route.
//
// Three routes were open in production on 2026-09-06: the trade console with its fills and account
// equity, the IBKR account, and the endpoint that rebuilds and POSTS the Discord card. The
// middleware matches "/" and nothing else, so each route has to check for itself and the ones that
// did were the ones somebody remembered.
import { authorised, hasSessionCookie, hasServiceKey, serviceKeyConfigured, refusalReason, SERVICE_KEY_ENVS } from '../lib/apiauth.js';
import fs from 'node:fs';
import { mintSession, verifySession, sessionCookie, readCookie, sameDigest, SESSION_ENV, SESSION_MAX_AGE_S } from '../lib/session.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const req = (headers = {}, query = {}) => ({ headers, query });
const clear = () => { for (const n of SERVICE_KEY_ENVS) delete process.env[n]; };

// ── THE COOKIE HAS TO PROVE SOMETHING ────────────────────────────────────────
// It did not. The value was the literal `mwd_auth=true` and the check was a regex for that
// literal, so being logged in meant sending a string printed in api/login.js — in a PUBLIC
// repository. Every route closed on 2026-09-06 was closed against callers who send no cookie,
// which is not the caller anyone was worried about.
//
// THIS IS THE ASSERTION THAT MATTERS. If it ever passes again, the door is open.
const PW = 'correct-horse-battery-staple';
process.env[SESSION_ENV] = PW;

ok('THE OLD COOKIE IS NOT A SESSION', !(await hasSessionCookie(req({ cookie: 'mwd_auth=true' }))));
ok('nor is any other guess', (await Promise.all(
  ['mwd_auth=1', 'mwd_auth=yes', 'mwd_auth=', 'mwd_auth=v1', 'mwd_auth=v1.9999999999',
   'mwd_auth=v1.9999999999.', 'mwd_auth=v1.9999999999.deadbeef'].map(c => hasSessionCookie(req({ cookie: c })))
)).every(r => r === false));

const token = await mintSession(PW);
ok('a minted session authenticates', await hasSessionCookie(req({ cookie: `mwd_auth=${token}` })));
ok('among other cookies', await hasSessionCookie(req({ cookie: `a=1; mwd_auth=${token}; b=2` })));
ok('no cookie at all does not', !(await hasSessionCookie(req())));
// The name is anchored, so a cookie merely CONTAINING the name is not a session.
ok('nor a lookalike name', !(await hasSessionCookie(req({ cookie: `not_mwd_auth=${token}` }))));

// A session minted under a DIFFERENT password is somebody else's, which is what makes the secret
// load-bearing: change the password and every outstanding cookie dies.
ok('a session from another password is refused', !(await verifySession(await mintSession('other'), PW)));
// And one byte of the signature edited is not a rounding error, it is a forgery.
{
  const bad = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
  ok('a tampered signature is refused', !(await verifySession(bad, PW)));
}

// ── THE EXPIRY IS SIGNED AND CHECKED HERE ────────────────────────────────────
// `Max-Age` is the browser's promise to itself. curl makes no such promise, so a token that has
// run out must be refused by the SERVER — and the expiry has to be inside the signature or it can
// simply be edited forward.
{
  const now = Date.parse('2026-09-07T00:00:00Z');
  const t = await mintSession(PW, { now, maxAgeS: 3600 });
  ok('valid inside its window', await verifySession(t, PW, { now: now + 3599_000 }));
  ok('refused after it', !(await verifySession(t, PW, { now: now + 3601_000 })));
  // Editing the expiry forward invalidates the signature rather than extending the session.
  const [v, exp, sig] = t.split('.');
  ok('and cannot be edited forward', !(await verifySession(`${v}.${Number(exp) + 86400}.${sig}`, PW, { now })));
  // One canonical spelling: a padded expiry signs a different string than it presents.
  ok('a padded expiry is not the same session', !(await verifySession(`${v}.0${exp}.${sig}`, PW, { now })));
}

// ── FAIL CLOSED WITH NO SECRET ───────────────────────────────────────────────
// `if (!secret) return true` is the shape this whole file exists to not write twice. With
// DASHBOARD_PASSWORD unset nothing can be minted and nothing verifies — including, especially, a
// token that was valid a moment ago.
{
  const saved = process.env[SESSION_ENV];
  delete process.env[SESSION_ENV];
  eq('no secret mints nothing', await mintSession(process.env[SESSION_ENV]), null);
  ok('and verifies nothing', !(await verifySession(token, process.env[SESSION_ENV])));
  ok('so a real token is refused too', !(await hasSessionCookie(req({ cookie: `mwd_auth=${token}` }))));
  process.env[SESSION_ENV] = saved;
}

// ── THE COOKIE LINE ──────────────────────────────────────────────────────────
// The flags are set in one place so login and any future re-issue cannot disagree. SameSite=Strict
// matters more now that the value is worth stealing.
{
  const line = sessionCookie(token);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_MAX_AGE_S}`])
    ok(`the cookie carries ${flag}`, line.includes(flag));
  eq('and reads back as itself', readCookie(line.split(';')[0]), token);
  ok('the password itself is never in it', !line.includes(PW));
}

// The digest compare is length-first, then constant across the length it walks.
ok('equal digests match', sameDigest('abc123', 'abc123'));
ok('different ones do not', !sameDigest('abc123', 'abc124'));
ok('nor do different lengths', !sameDigest('abc', 'abc1'));
ok('nor empty against empty — a missing digest is not a match', !sameDigest('', ''));

// ── FAIL CLOSED ──────────────────────────────────────────────────────────────
// The shape that caused this: `if (!want) return true` — no secret configured, everyone welcome.
clear();
ok('with no key configured, a service caller is REFUSED', !hasServiceKey(req({ 'x-tradecard-key': 'anything' })));
ok('and an anonymous request is refused', !(await authorised(req())));
ok('serviceKeyConfigured says so', !serviceKeyConfigured());
// The browser path must keep working with nothing configured anywhere — that is what stops this
// fix from being one nobody can deploy.
ok('but a logged-in browser still passes', await authorised(req({ cookie: `mwd_auth=${token}` })));

// ── ONE NAME, TWO PLACES ─────────────────────────────────────────────────────
// The workflow sent `secrets.TRADECARD_KEY` while the server read `TRADECARD_SECRET`: one value,
// two names, two systems. TRADECARD_KEY is the name on both sides now.
clear(); process.env.TRADECARD_KEY = 'correct-horse-battery-staple';
ok('the right key passes', hasServiceKey(req({ 'x-tradecard-key': 'correct-horse-battery-staple' })));
ok('a wrong one does not', !hasServiceKey(req({ 'x-tradecard-key': 'nope' })));
ok('nor a prefix of it', !hasServiceKey(req({ 'x-tradecard-key': 'correct-horse' })));
ok('it may also arrive as a query parameter', hasServiceKey(req({}, { key: 'correct-horse-battery-staple' })));
ok('or as x-api-key', hasServiceKey(req({ 'x-api-key': 'correct-horse-battery-staple' })));
ok('an empty presented key never matches', !hasServiceKey(req({ 'x-tradecard-key': '' })));
// The old name still works, so shipping this does not break a deployment mid-flight.
clear(); process.env.TRADECARD_SECRET = 'legacy-value';
ok('the previous name is still accepted', hasServiceKey(req({ 'x-tradecard-key': 'legacy-value' })));
// An empty string configured is NOT a configured key.
clear(); process.env.TRADECARD_KEY = '   ';
ok('whitespace is not a key', !serviceKeyConfigured() && !hasServiceKey(req({ 'x-tradecard-key': '   ' })));

// ── THE REFUSAL HAS TO SAY WHICH SIDE IS WRONG ───────────────────────────────
// A workflow log reading "unauthorised" tells whoever opens it nothing about what to change.
clear();
ok('unconfigured server names the server', /no service key configured on the server/.test(refusalReason(req())));
ok('and names the variable to set', /TRADECARD_KEY/.test(refusalReason(req())));
process.env.TRADECARD_KEY = 'k';
ok('missing key names the header', /no key presented/.test(refusalReason(req())));
ok('wrong key says it does not match', /does not match/.test(refusalReason(req({ 'x-tradecard-key': 'x' }))));
// Three distinct problems, three distinct messages — a single string for all of them would be the
// same as no message.
const messages = new Set([refusalReason(req()), refusalReason(req({ 'x-tradecard-key': 'x' }))]);
clear();
messages.add(refusalReason(req()));
eq('three causes, three messages', messages.size, 3);
// And none of them says what is behind the door.
for (const m of messages) ok('the refusal leaks nothing about the payload', !/equity|position|fills|console/i.test(m));

clear();
// ── NO LITERAL COOKIE CHECK SURVIVES ANYWHERE ────────────────────────────────
// The constant was in five files: api/login.js minted it, middleware.js matched it, and
// api/manual-entry.js, api/regime-log.js and api/korea-save.js each carried their own copy of the
// regex. That is how a thing gets fixed in one place and stays broken in four. Scanned as SOURCE
// with comments stripped, because this file and lib/session.js both quote the old cookie in prose
// while explaining why it is gone.
{
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = [...fs.readdirSync('api').filter(f => f.endsWith('.js')).map(f => `api/${f}`),
                 'middleware.js', 'lib/apiauth.js', 'lib/session.js'];
  const offenders = files.filter(f => /mwd_auth\s*=\s*true|mwd_auth=true/.test(strip(fs.readFileSync(f, 'utf8'))));
  eq('no file still treats "true" as a session', offenders, []);

  // And no route reads the INCOMING cookie for itself. Scoped to `req.headers.cookie` rather than
  // the word "cookie": api/prices.js holds a Yahoo cookie for an OUTBOUND call, which is a
  // different thing entirely and flagged the first version of this.
  const rolled = files.filter(f => f.startsWith('api/') &&
    /req\s*(\.headers\s*\.\s*cookie|\.headers\s*\[\s*['"`]cookie)/.test(strip(fs.readFileSync(f, 'utf8'))));
  eq('no route reads the request cookie itself', rolled, []);

  // The mint and the verify read the SAME environment variable. Naming it twice is how
  // TRADECARD_KEY and TRADECARD_SECRET became two names for one value in two systems.
  ok('login mints through lib/session.js', /mintSession\s*\(/.test(fs.readFileSync('api/login.js', 'utf8')));
  ok('and the middleware verifies through it', /verifySession\s*\(/.test(fs.readFileSync('middleware.js', 'utf8')));
  ok('the middleware awaits that verification', /await\s+verifySession/.test(fs.readFileSync('middleware.js', 'utf8')));
  ok('and is async, or the await would be a syntax error', /export\s+default\s+async\s+function\s+middleware/.test(fs.readFileSync('middleware.js', 'utf8')));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
