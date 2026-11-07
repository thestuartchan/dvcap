// test/cronRouter.test.mjs — the one-tick scheduler (lib/cronRouter.js, api/regime-log.js ?tick).
import { JOBS, zonedToUtc, dueSlots, allDue, tick, runJob, outcomeOf, nextSlot, statusView, claimKey, LAST_KEY, WINDOW_MIN, privateTestText } from '../lib/cronRouter.js';
import handler from '../api/regime-log.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const at = (iso) => Date.parse(iso);
const job = (id) => JOBS.find(j => j.id === id);

// ── CLOCKS ───────────────────────────────────────────────────────────────────
{
  eq('10:02 New York in winter is 15:02 UTC', new Date(zonedToUtc('2026-11-06', '10:02', 'America/New_York')).toISOString(), '2026-11-06T15:02:00.000Z');
  eq('and in summer 14:02 UTC: one entry, no DST twin', new Date(zonedToUtc('2026-10-30', '10:02', 'America/New_York')).toISOString(), '2026-10-30T14:02:00.000Z');
  eq('UTC is UTC', new Date(zonedToUtc('2026-11-06', '21:40', 'UTC')).toISOString(), '2026-11-06T21:40:00.000Z');
}

// ── WHAT IS DUE ──────────────────────────────────────────────────────────────
{
  const cp = job('checkpoint');
  eq('the 10:02 layer is due three minutes after its slot', dueSlots(cp, at('2026-11-06T15:05:00Z')).map(s => s.at), ['10:02']);
  eq('and still due at nine minutes', dueSlots(cp, at('2026-11-06T15:11:00Z')).length, 1);
  eq(`but not after the ${WINDOW_MIN}-minute window`, dueSlots(cp, at('2026-11-06T15:12:00Z')).length, 0);
  eq('nor a minute before it', dueSlots(cp, at('2026-11-06T15:01:00Z')).length, 0);
  eq('not on a Saturday', dueSlots(cp, at('2026-11-07T15:05:00Z')).length, 0);
  eq('the 00:30 layer belongs to the New York day it falls in', dueSlots(cp, at('2026-11-06T05:31:00Z')).map(s => `${s.day} ${s.at}`), ['2026-11-06 00:30']);
  const gx = job('gex-recompute');
  eq('a market job skips a US holiday', dueSlots(gx, at('2026-11-26T12:16:00Z'), { usClosed: ['2026-11-26'] }).length, 0);
  eq('and runs the day after', dueSlots(gx, at('2026-11-27T12:16:00Z'), { usClosed: ['2026-11-26'] }).length, 1);
  eq('the wallet card every half hour', dueSlots(job('walletcard'), at('2026-11-06T06:31:00Z')).map(s => s.at), ['06:30']);
  eq('the Asia pre-read runs on UTC Sunday (Monday in Hong Kong)', dueSlots(job('preread-asia'), at('2026-11-08T22:43:00Z')).length, 1);
  eq('and not on UTC Friday (Saturday in Hong Kong)', dueSlots(job('preread-asia'), at('2026-11-06T22:43:00Z')).length, 0);
  eq('the MLS trial on UTC Saturday, after Friday\'s US session', dueSlots(job('mls-paper'), at('2026-11-07T05:16:00Z')).length, 1);
  const quiet = allDue(JOBS, at('2026-11-07T03:03:00Z'));
  eq('a Saturday night in UTC has nothing due', quiet.length, 0);
  ok('every job has a route or a workflow, and a clock', JOBS.every(j => (j.path || j.workflow) && j.tz && j.at.length));
  ok('every route is relative to this deployment', JOBS.filter(j => j.path).every(j => j.path.startsWith('/api/')));
  eq('ids are unique', new Set(JOBS.map(j => j.id)).size, JOBS.length);
}

// ── ONE TICK ─────────────────────────────────────────────────────────────────
function fakeKv() {
  const m = new Map();
  return { m, setNx: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)), get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); } };
}
{
  const kv = fakeKv();
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, key: opts.headers['x-tradecard-key'] }); return { status: 200, json: async () => ({ ok: true, secret: 'account data' }) }; };
  const now = at('2026-11-06T15:03:00Z');
  const r1 = await tick({ now, kv, origin: 'https://example.test', env: { TRADECARD_KEY: 'k' }, fetchImpl, dispatch: async () => ({ ok: true }) });
  eq('every due job runs once, with the service key (10:02 checkpoint, 15:00 wallet card)', [r1.ran.map(x => x.id), calls.map(c => [c.url, c.key])],
     [['checkpoint', 'walletcard'], [['https://example.test/api/tradecard?card=checkpoint', 'k'], ['https://example.test/api/tradecard?card=wallet', 'k']]]);
  ok('its slot is claimed', kv.m.has(claimKey('checkpoint', '2026-11-06T15:02:00.000Z')));
  const r2 = await tick({ now: now + 60000, kv, origin: 'https://example.test', env: {}, fetchImpl, dispatch: async () => ({ ok: true }) });
  eq('the next tick does not run them again', [r2.ran.length, r2.skipped, calls.length], [0, 2, 2]);
  const last = kv.m.get(LAST_KEY);
  eq('the outcome is recorded', [last.checkpoint.ok, last.checkpoint.status, last.checkpoint.slot], [true, 200, '2026-11-06T15:02:00.000Z']);
  ok('and nothing from the route\'s body but its verdict', !JSON.stringify(last).includes('account data'));
  const idle = await tick({ now: at('2026-11-07T03:03:00Z'), kv: { setNx: async () => { throw new Error('touched'); } } });
  eq('a tick with nothing due does no I/O', idle.ran, []);
}
{
  eq('a route that says ok:false is a failure, with its reason', outcomeOf(200, { ok: false, why: 'already sent today' }, 5), { ok: false, status: 200, ms: 5, note: 'already sent today' });
  eq('an HTTP error is a failure', outcomeOf(500, null, 1).ok, false);
  const w = await runJob(job('korea-fetch'), { dispatch: async (wf) => ({ ok: wf === 'korea-fetch.yml', status: 204 }) });
  eq('a workflow job dispatches its workflow', [w.ok, w.status], [true, 204]);
  const t = await runJob({ id: 'x', path: '/api/x', timeoutMs: 1000 }, { origin: 'https://example.test', env: {}, fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; } });
  eq('a timeout says so', [t.ok, t.note], [false, 'no answer within 1s']);
}
{
  eq('the next checkpoint slot after 10:03 ET Friday is 10:32', nextSlot(job('checkpoint'), at('2026-11-06T15:03:00Z')), '2026-11-06T15:32:00.000Z');
  eq('and after Friday\'s last, Monday 00:30 ET', nextSlot(job('checkpoint'), at('2026-11-06T15:40:00Z')), '2026-11-09T05:30:00.000Z');
  const v = statusView({}, at('2026-11-06T15:03:00Z'));
  eq('the status page lists every job', v.length, JOBS.length);
  eq('in its own clock', v.find(x => x.id === 'gex-recompute').clock, 'New York');
}

{
  const t = privateTestText(Date.parse('2026-11-07T12:00:00Z'));
  ok('the test message says what the channel is for, and when', /connected.*16:00 Dubai \(07:00 ET\)[\s\S]*Desk rules/.test(t));
}

// ── THE DOOR ─────────────────────────────────────────────────────────────────
function fakeRes() {
  const r = { code: null, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
{
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  let r = fakeRes(); await handler({ method: 'GET', query: { tick: '1' }, headers: { authorization: 'Bearer anything' } }, r);
  eq('no CRON_SECRET: every tick is refused', r.code, 401);
  r = fakeRes(); await handler({ method: 'GET', query: { tick: 'status' }, headers: {} }, r);
  eq('the status page needs the dashboard login', r.code, 401);
  r = fakeRes(); await handler({ method: 'POST', query: { tick: 'test-private' }, headers: {} }, r);
  eq('the private-channel test needs the dashboard login', r.code, 401);
  r = fakeRes(); await handler({ method: 'GET', query: { tick: 'test-private' }, headers: {} }, r);
  eq('and is a POST', r.code, 405);
  if (saved != null) process.env.CRON_SECRET = saved;
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
