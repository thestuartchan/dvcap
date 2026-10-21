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
// refuses after 09:20 New York time, on weekends and on US closures, and a KV key holds the day's
// dispatch so a second call does nothing.
export const PRE_OPEN_WORKFLOWS = Object.freeze(['signal-board.yml', 'gex-recompute.yml']);
export const LATEST_NY_MIN = 9 * 60 + 20;
export const DISPATCH_KEY = (day) => `dvcap:preopen:dispatch:${day}`;

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

// The I/O: plan, take the day's key, dispatch each workflow. Never throws; returns what happened.
export async function preOpenDispatch({ now = new Date(), usClosed = [], kv, fetchImpl = fetch, env = process.env } = {}) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return { ok: false, why: 'GITHUB_TOKEN / GITHUB_REPO not configured' };
  const first = dispatchPlan({ now, usClosed });
  if (!first.go) return { ok: true, dispatched: [], why: first.why };
  // The day's key is taken before dispatching, so two calls racing cannot both start the jobs.
  let took = true;
  if (kv?.configured?.()) { try { took = await kv.setNx(DISPATCH_KEY(first.day), { at: now.toISOString() }, 36 * 3600); } catch { took = true; } }
  if (!took) return { ok: true, dispatched: [], why: dispatchPlan({ now, usClosed, already: true }).why };
  const out = [];
  for (const wf of first.workflows) {
    try {
      const r = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${wf}/dispatches`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'dvcap-preopen', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: env.GITHUB_BRANCH || 'main' }),
        signal: AbortSignal.timeout(10000),
      });
      out.push({ workflow: wf, ok: r.status === 204 || r.ok, status: r.status });
    } catch (e) {
      out.push({ workflow: wf, ok: false, error: String(e?.message || e).slice(0, 120) });
    }
  }
  return { ok: out.every(x => x.ok), day: first.day, dispatched: out };
}
