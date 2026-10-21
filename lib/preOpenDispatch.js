// lib/preOpenDispatch.js — start the pre-open GitHub jobs on time, from the Vercel pre-read cron.
//
// WHY (20 Oct 2026). GitHub's scheduler runs this repository's crons hours late: the signal board's
// 12:50 UTC snapshot ran at 17:33 UTC, mid-session, and refused (rightly) to record a partial day;
// the pre-open gamma recompute's 07:15 / 09:25 ET entries arrived 15:40–18:30 UTC, outside the
// 20-minute window its own gate allows, so it skipped. Measured over a week, every scheduled job ran
// 3–6 hours late. Vercel's crons run within minutes of their time (see .github/workflows/preread.yml),
// and a workflow_dispatch event starts a GitHub job at once rather than queueing it with the
// schedules. So the US pre-read cron (12:42 UTC: 08:42 EDT / 07:42 EST) asks GitHub to run both jobs
// now. Their own schedules stay as the backup.
//
//   signal-board.yml     the board's daily row, before the open
//   gex-recompute.yml    the settled-OI recompute at pre-open spot (dispatch passes its time gate)
//
// ONCE A DAY, BEFORE THE OPEN. The GitHub pre-read backup calls the same route, hours late; the plan
// refuses after 09:20 New York time, on weekends and on US closures. The day's record holds what each
// workflow answered, so a later call before 09:20 dispatches only what has not yet been accepted.
//
// WHY A RECORD AND NOT JUST A LOCK (21 Oct 2026). The first version took the day's key BEFORE
// dispatching and kept it whatever GitHub answered. That morning the cron ran (its regime-log commit
// is there) and no dispatched run appeared: whatever went wrong — a refused token, a timeout — held
// the key, so nothing could try again, and nothing said what had happened. Now:
//   - a short lock only stops two calls racing; it is released when the call finishes;
//   - the day's record keeps each workflow's answer; only a workflow GitHub accepted counts as done;
//   - a transient failure (network, 5xx, 429) is retried once in the same call;
//   - the last attempt is kept for Data health (dispatchHealth), with what a refusal usually means;
//   - Data health can retry by hand (POST /api/preread?preopen=retry, dashboard session only).
export const PRE_OPEN_WORKFLOWS = Object.freeze(['signal-board.yml', 'gex-recompute.yml']);
export const LATEST_NY_MIN = 9 * 60 + 20;
export const DISPATCH_KEY = (day) => `dvcap:preopen:dispatch:${day}`;
export const LOCK_KEY = (day) => `dvcap:preopen:lock:${day}`;
export const LAST_KEY = 'dvcap:preopen:last';
const DAY_TTL_S = 36 * 3600, LOCK_TTL_S = 90, LAST_TTL_S = 14 * 86400;

const nyParts = (now) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(now).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute, weekday: p.weekday };
};

// Pure: whether to dispatch now, and why not when not.
export function dispatchPlan({ now = new Date(), usClosed = [], already = false } = {}) {
  const ny = nyParts(now);
  if (ny.weekday === 'Sat' || ny.weekday === 'Sun') return { go: false, day: ny.day, why: 'weekend in New York' };
  if (usClosed.includes(ny.day)) return { go: false, day: ny.day, why: `US market closed ${ny.day}` };
  if (ny.min > LATEST_NY_MIN) return { go: false, day: ny.day, why: 'past 09:20 New York — too close to the open' };
  if (already) return { go: false, day: ny.day, why: 'already dispatched today' };
  return { go: true, day: ny.day, workflows: [...PRE_OPEN_WORKFLOWS] };
}

// What a refused dispatch usually means, for the person reading Data health. Status codes only.
export function refusalHint(status) {
  if (status === 401) return 'GitHub refused the token: expired or revoked';
  if (status === 403) return 'the token lacks Actions: write on this repository';
  if (status === 404) return 'workflow not found, or the token cannot see the repository';
  if (status === 422) return 'the workflow has no workflow_dispatch trigger, or the branch is wrong';
  return null;
}
const transient = (x) => !x.ok && (x.status == null || x.status === 429 || x.status >= 500);

async function dispatchOne(wf, { env, fetchImpl, now }) {
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${wf}/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'dvcap-preopen', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: env.GITHUB_BRANCH || 'main' }),
      signal: AbortSignal.timeout(10000),
    });
    const ok = r.status === 204 || !!r.ok;
    return { workflow: wf, ok, status: r.status, at: now.toISOString(), ...(ok ? {} : { hint: refusalHint(r.status) }) };
  } catch (e) {
    return { workflow: wf, ok: false, status: null, at: now.toISOString(), error: String(e?.message || e).slice(0, 120) };
  }
}

// The I/O: plan, take the short lock, dispatch what the day's record does not yet show as accepted,
// record the answers, release the lock. Never throws; returns what happened.
//   kv: { configured(), setNx(k, v, s), get(k), set(k, v, s), del(k) } — lib/kv.js in production.
export async function preOpenDispatch({ now = new Date(), usClosed = [], kv, fetchImpl = fetch, env = process.env, by = 'cron', retryWaitMs = 3000 } = {}) {
  const plan = dispatchPlan({ now, usClosed });
  if (!plan.go) return { ok: true, dispatched: [], day: plan.day, why: plan.why };
  const useKv = !!kv?.configured?.();
  const save = async (rec) => { if (!useKv) return; try { await kv.set(DISPATCH_KEY(plan.day), rec, DAY_TTL_S); await kv.set(LAST_KEY, rec, LAST_TTL_S); } catch { /* the answer is still returned */ } };
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    const why = 'GITHUB_TOKEN / GITHUB_REPO not configured';
    await save({ day: plan.day, at: now.toISOString(), by, ok: false, why, workflows: {} });
    return { ok: false, day: plan.day, why };
  }
  if (useKv) {
    // A store that cannot answer does not stop the dispatch: GitHub's own schedules are the backstop.
    const took = await Promise.resolve().then(() => kv.setNx(LOCK_KEY(plan.day), { at: now.toISOString(), by }, LOCK_TTL_S)).catch(() => true);
    if (!took) return { ok: true, dispatched: [], day: plan.day, why: 'another call is dispatching right now' };
  }
  try {
    let prev = null;
    if (useKv) { try { prev = await kv.get(DISPATCH_KEY(plan.day)); } catch { prev = null; } }
    const done = new Set(Object.entries(prev?.workflows || {}).filter(([, w]) => w?.ok).map(([k]) => k));
    const todo = plan.workflows.filter(wf => !done.has(wf));
    if (!todo.length) return { ok: true, dispatched: [], day: plan.day, why: dispatchPlan({ now, usClosed, already: true }).why };
    const out = [];
    for (const wf of todo) {
      let x = await dispatchOne(wf, { env, fetchImpl, now });
      if (transient(x)) {
        if (retryWaitMs) await new Promise(r => setTimeout(r, retryWaitMs));
        x = { ...(await dispatchOne(wf, { env, fetchImpl, now })), retried: true };
      }
      out.push(x);
    }
    const workflows = { ...(prev?.workflows || {}) };
    for (const x of out) { const { workflow, ...rest } = x; workflows[workflow] = rest; }
    const ok = plan.workflows.every(wf => workflows[wf]?.ok);
    await save({ day: plan.day, at: now.toISOString(), by, ok, tries: (prev?.tries || 0) + 1, workflows });
    return { ok, day: plan.day, dispatched: out };
  } finally {
    if (useKv) { try { await kv.del(LOCK_KEY(plan.day)); } catch { /* the lock expires on its own */ } }
  }
}

// Pure: the Data health line for the last attempt. `last` is the LAST_KEY record (or null).
//   ok        today's jobs were accepted by GitHub
//   failed    today's attempt was refused or errored — says which, and what that usually means
//   missed    a US trading day past 09:20 New York with no attempt recorded: the cron never got here
//   waiting   a trading day before 09:20 with nothing yet
//   idle      weekend or US closure
export function dispatchHealth(last, { now = new Date(), usClosed = [] } = {}) {
  const plan = dispatchPlan({ now, usClosed });
  const ny = nyParts(now);
  const tradingDay = !(ny.weekday === 'Sat' || ny.weekday === 'Sun' || usClosed.includes(ny.day));
  const today = last?.day === ny.day ? last : null;
  if (today?.ok) return { status: 'ok', day: ny.day, line: `dispatched ${Object.keys(today.workflows || {}).join(', ')}${today.tries > 1 ? ` (try ${today.tries})` : ''}`, last: today };
  if (today) {
    const bad = Object.entries(today.workflows || {}).filter(([, w]) => !w?.ok);
    const what = today.why || bad.map(([k, w]) => `${k} ${w.status ?? 'no answer'}${w.hint ? ` — ${w.hint}` : w.error ? ` — ${w.error}` : ''}`).join('; ');
    return { status: 'failed', day: ny.day, line: what || 'not accepted', canRetry: plan.go, last: today };
  }
  if (!tradingDay) return { status: 'idle', day: ny.day, line: plan.why, last };
  if (!plan.go) return { status: 'missed', day: ny.day, line: 'no dispatch recorded today — the 12:42 UTC cron did not reach it', last };
  return { status: 'waiting', day: ny.day, line: 'not yet — the US pre-read cron runs at 12:42 UTC', canRetry: true, last };
}
