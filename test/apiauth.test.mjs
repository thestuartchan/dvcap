// test/apiauth.test.mjs — who may call an API route.
//
// Three routes were open in production on 2026-09-06: the trade console with its fills and account
// equity, the IBKR account, and the endpoint that rebuilds and POSTS the Discord card. The
// middleware matches "/" and nothing else, so each route has to check for itself and the ones that
// did were the ones somebody remembered.
import { authorised, hasSessionCookie, hasServiceKey, serviceKeyConfigured, refusalReason, SERVICE_KEY_ENVS } from '../lib/apiauth.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const req = (headers = {}, query = {}) => ({ headers, query });
const clear = () => { for (const n of SERVICE_KEY_ENVS) delete process.env[n]; };

// ── the session cookie ───────────────────────────────────────────────────────
ok('the dashboard cookie authenticates', hasSessionCookie(req({ cookie: 'mwd_auth=true' })));
ok('among others', hasSessionCookie(req({ cookie: 'a=1; mwd_auth=true; b=2' })));
ok('a false value does not', !hasSessionCookie(req({ cookie: 'mwd_auth=false' })));
// The check is anchored, so a cookie merely CONTAINING the string is not a session.
ok('nor a lookalike name', !hasSessionCookie(req({ cookie: 'not_mwd_auth=true' })));
ok('no cookie at all does not', !hasSessionCookie(req()));

// ── FAIL CLOSED ──────────────────────────────────────────────────────────────
// The shape that caused this: `if (!want) return true` — no secret configured, everyone welcome.
clear();
ok('with no key configured, a service caller is REFUSED', !hasServiceKey(req({ 'x-tradecard-key': 'anything' })));
ok('and an anonymous request is refused', !authorised(req()));
ok('serviceKeyConfigured says so', !serviceKeyConfigured());
// The browser path must keep working with nothing configured anywhere — that is what stops this
// fix from being one nobody can deploy.
ok('but a logged-in browser still passes', authorised(req({ cookie: 'mwd_auth=true' })));

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
console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
