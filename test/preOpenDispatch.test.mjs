// test/preOpenDispatch.test.mjs — the pre-open GitHub jobs started from the Vercel cron (lib/preOpenDispatch.js).
import { dispatchPlan, preOpenDispatch, dispatchHealth, PRE_OPEN_WORKFLOWS, DISPATCH_KEY, LOCK_KEY, LAST_KEY } from '../lib/preOpenDispatch.js';

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
// A KV stand-in with the five calls the route passes (lib/kv.js in production).
const memKv = () => { const m = new Map(); return { m, configured: () => true,
  setNx: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)), get: async (k) => m.get(k) ?? null,
  set: async (k, v) => (m.set(k, v), true), del: async (k) => m.delete(k) }; };
const env = { GITHUB_TOKEN: 't', GITHUB_REPO: 'o/r' };
const fetchFrom = (answer) => { const calls = []; const f = async (url, o) => { const wf = url.split('/actions/workflows/')[1].split('/')[0]; calls.push(`${wf}@${JSON.parse(o.body).ref}`); return answer(wf, calls.length); }; f.calls = calls; return f; };
const ok204 = () => ({ status: 204, ok: true });
const opts = { retryWaitMs: 0, env };

const kv = memKv(), f1 = fetchFrom(ok204);
const r1 = await preOpenDispatch({ now: at('2026-10-21T12:42:00Z'), kv, fetchImpl: f1, ...opts });
eq('both workflows dispatched on main', [r1.ok, f1.calls], [true, ['signal-board.yml@main', 'gex-recompute.yml@main']]);
const r2 = await preOpenDispatch({ now: at('2026-10-21T12:50:00Z'), kv, fetchImpl: f1, ...opts });
eq('a second call the same morning dispatches nothing', [r2.dispatched.length, r2.why, f1.calls.length], [0, 'already dispatched today', 2]);
eq('the lock is released and the day recorded', [kv.m.has(LOCK_KEY('2026-10-21')), kv.m.get(DISPATCH_KEY('2026-10-21'))?.ok], [false, true]);

// The 21 Oct failure: a refusal no longer holds the day.
const kv2 = memKv();
const refused = await preOpenDispatch({ now: at('2026-10-22T12:42:00Z'), kv: kv2, fetchImpl: fetchFrom(() => ({ status: 403, ok: false })), ...opts });
eq('a refused dispatch says so, and why', [refused.ok, refused.dispatched.map(d => [d.status, d.hint])], [false, [[403, 'the token lacks Actions: write on this repository'], [403, 'the token lacks Actions: write on this repository']]]);
const f3 = fetchFrom(ok204);
const again = await preOpenDispatch({ now: at('2026-10-22T12:55:00Z'), kv: kv2, fetchImpl: f3, ...opts, by: 'retry' });
eq('…and a later call before 09:20 tries again', [again.ok, f3.calls.length, kv2.m.get(LAST_KEY)?.tries, kv2.m.get(LAST_KEY)?.by], [true, 2, 2, 'retry']);

// Only what GitHub has not accepted is sent again.
const kv3 = memKv();
await preOpenDispatch({ now: at('2026-10-23T12:42:00Z'), kv: kv3, fetchImpl: fetchFrom(wf => wf === 'gex-recompute.yml' ? { status: 404, ok: false } : ok204()), ...opts });
const f4 = fetchFrom(ok204);
await preOpenDispatch({ now: at('2026-10-23T12:50:00Z'), kv: kv3, fetchImpl: f4, ...opts });
eq('a half-failed morning re-sends only the failed job', f4.calls, ['gex-recompute.yml@main']);

// A transient failure is retried once in the same call; a refusal is not.
const f5 = fetchFrom((wf, n) => (n === 1 ? { status: 502, ok: false } : ok204()));
const r5 = await preOpenDispatch({ now: at('2026-10-26T12:42:00Z'), kv: memKv(), fetchImpl: f5, ...opts });
eq('a 502 is retried once and succeeds', [r5.ok, f5.calls.length, r5.dispatched[0].retried], [true, 3, true]);
const f6 = fetchFrom(() => ({ status: 401, ok: false }));
await preOpenDispatch({ now: at('2026-10-27T12:42:00Z'), kv: memKv(), fetchImpl: f6, ...opts });
eq('a 401 is not retried', f6.calls.length, 2);
const f7 = fetchFrom(() => { throw new Error('socket hang up'); });
const r7 = await preOpenDispatch({ now: at('2026-10-28T12:42:00Z'), kv: memKv(), fetchImpl: f7, ...opts });
eq('a network error is retried, then recorded', [f7.calls.length, r7.dispatched[0].error], [4, 'socket hang up']);

// Two calls racing: the second sees the lock.
const kv8 = memKv(); kv8.m.set(LOCK_KEY('2026-10-29'), { at: 'x' });
eq('a call racing another stands aside', (await preOpenDispatch({ now: at('2026-10-29T12:42:00Z'), kv: kv8, fetchImpl: fetchFrom(ok204), ...opts })).why, 'another call is dispatching right now');

const kv9 = memKv();
const noTok = await preOpenDispatch({ now: at('2026-10-21T12:42:00Z'), kv: kv9, env: {} });
eq('no token: nothing tried, and Data health is told', [noTok.why, kv9.m.get(LAST_KEY)?.why], ['GITHUB_TOKEN / GITHUB_REPO not configured', 'GITHUB_TOKEN / GITHUB_REPO not configured']);
eq('a weekend writes nothing more', [(await preOpenDispatch({ now: at('2026-10-24T12:42:00Z'), kv: kv9, env })).why, kv9.m.size], ['weekend in New York', 2]);

// ── Data health ──
const okRec = kv.m.get(LAST_KEY);
eq('health: dispatched', dispatchHealth(okRec, { now: at('2026-10-21T14:00:00Z') }).line, 'dispatched signal-board.yml, gex-recompute.yml');
const bad = { day: '2026-10-21', ok: false, at: '2026-10-21T12:42:05Z', by: 'cron', workflows: { 'signal-board.yml': { ok: false, status: 403, hint: 'the token lacks Actions: write on this repository' }, 'gex-recompute.yml': { ok: true, status: 204 } } };
eq('health: failed, which job and why, retry offered before 09:20', (({ status, line, canRetry }) => ({ status, line, canRetry }))(dispatchHealth(bad, { now: at('2026-10-21T12:50:00Z') })),
  { status: 'failed', line: 'signal-board.yml 403 — the token lacks Actions: write on this repository', canRetry: true });
eq('…and no retry after 09:20', dispatchHealth(bad, { now: at('2026-10-21T14:00:00Z') }).canRetry, false);
eq('health: missed when the cron never got there', dispatchHealth(okRec, { now: at('2026-10-22T14:00:00Z') }).status, 'missed');
eq('health: waiting before the cron', dispatchHealth(null, { now: at('2026-10-22T11:00:00Z') }).status, 'waiting');
eq('health: idle on a closure', dispatchHealth(null, { now: at('2026-12-25T14:00:00Z'), usClosed: ['2026-12-25'] }).status, 'idle');
eq('the two jobs', PRE_OPEN_WORKFLOWS, ['signal-board.yml', 'gex-recompute.yml']);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
