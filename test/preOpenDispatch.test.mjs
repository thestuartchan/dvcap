// test/preOpenDispatch.test.mjs — the pre-open GitHub jobs started from the Vercel cron (lib/preOpenDispatch.js).
import { dispatchPlan, preOpenDispatch, PRE_OPEN_WORKFLOWS, DISPATCH_KEY } from '../lib/preOpenDispatch.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const at = (iso) => new Date(iso);
// ── When ──
eq('the US cron at 12:42 UTC (08:42 EDT) dispatches both jobs', dispatchPlan({ now: at('2026-10-21T12:42:00Z') }), { go: true, day: '2026-10-21', workflows: ['signal-board.yml', 'gex-recompute.yml'] });
eq('…and at 12:42 UTC in winter (07:42 EST)', dispatchPlan({ now: at('2026-11-04T12:42:00Z') }).go, true);
eq('a late backup call after 09:20 New York does not', dispatchPlan({ now: at('2026-10-21T13:25:00Z') }).why, 'past 09:20 New York — too close to the open');
eq('a weekend does not', dispatchPlan({ now: at('2026-10-24T12:42:00Z') }).why, 'weekend in New York');
eq('a US closure does not', dispatchPlan({ now: at('2026-12-25T13:42:00Z'), usClosed: ['2026-12-25'] }).why, 'US market closed 2026-12-25');
eq('once a day', dispatchPlan({ now: at('2026-10-21T12:42:00Z'), already: true }).why, 'already dispatched today');

// ── The dispatch ──
const calls = [];
const fakeFetch = async (url, o) => { calls.push([url.split('/actions/workflows/')[1], JSON.parse(o.body).ref]); return { status: 204, ok: true }; };
const env = { GITHUB_TOKEN: 't', GITHUB_REPO: 'o/r' };
const taken = new Set();
const kv = { configured: () => true, setNx: async (k) => (taken.has(k) ? false : (taken.add(k), true)) };
const r1 = await preOpenDispatch({ now: at('2026-10-21T12:42:00Z'), kv, fetchImpl: fakeFetch, env });
eq('both workflows dispatched on main', [r1.ok, calls], [true, [['signal-board.yml/dispatches', 'main'], ['gex-recompute.yml/dispatches', 'main']]]);
const r2 = await preOpenDispatch({ now: at('2026-10-21T12:50:00Z'), kv, fetchImpl: fakeFetch, env });
eq('a second call the same morning dispatches nothing', [r2.dispatched.length, r2.why, calls.length], [0, 'already dispatched today', 2]);
eq('the day key is per New York date', [...taken], [DISPATCH_KEY('2026-10-21')]);
const refused = await preOpenDispatch({ now: at('2026-10-22T12:42:00Z'), kv, fetchImpl: async () => ({ status: 403, ok: false }), env });
eq('a refused dispatch says so', [refused.ok, refused.dispatched.map(d => d.status)], [false, [403, 403]]);
eq('no token: nothing tried', (await preOpenDispatch({ env: {} })).why, 'GITHUB_TOKEN / GITHUB_REPO not configured');
eq('the two jobs', PRE_OPEN_WORKFLOWS, ['signal-board.yml', 'gex-recompute.yml']);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
