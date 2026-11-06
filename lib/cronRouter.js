// lib/cronRouter.js — one on-time scheduler for every dvcap job (Vercel Pro, 6 Nov 2026).
//
// WHY. On Vercel Hobby the project had two cron slots, once a day each, so the rest of the schedule
// lived in GitHub Actions — and GitHub's scheduled runs arrived 3–6 hours late or not at all (six of
// seven pre-read firings lost on 2 Sep; the Signal Board snapshot at 17:33). Claude scheduled tasks
// were then added just to re-trigger GitHub jobs on time. Vercel Pro runs a cron every minute, on the
// minute, so ONE per-minute tick now runs the whole schedule from the table below.
//
// HOW. Vercel calls GET /api/regime-log?tick=1 every minute, signed with CRON_SECRET (unset → every
// tick is refused; nothing runs). Each tick asks which jobs have a slot in the last WINDOW_MIN
// minutes, claims each slot once in Redis (so a slow or repeated tick never runs a job twice), calls
// the job's own route with the service key, and records the outcome. A tick with nothing due does no
// I/O at all.
//
// TIME ZONES. Each job states its slots in its own clock: New York for market jobs (so daylight
// saving needs no second entry — GitHub needed every cron twice), UTC where the source publishes on
// UTC. Jobs that must commit to the repo still run on GitHub, dispatched from here on time.
export const WINDOW_MIN = 10;              // a slot missed by a late tick still runs within this
export const CLAIM_TTL_S = 3 * 86400;
export const LAST_KEY = 'dvcap:cron:last:v1';
export const claimKey = (id, slotIso) => `dvcap:cron:v1:${id}:${slotIso}`;
const NY = 'America/New_York';

const MON_FRI = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const range = (from, to, stepMin) => {
  const out = [];
  const [fh, fm] = from.split(':').map(Number), [th, tm] = to.split(':').map(Number);
  for (let m = fh * 60 + fm; m <= th * 60 + tm; m += stepMin) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  return out;
};

// THE SCHEDULE. `path` jobs are called on this deployment with the service key; `workflow` jobs are
// GitHub workflow_dispatch (they commit data to the repo, which a serverless function cannot).
// `usOpen` skips New York market holidays (data/holidays.json). Times are the ones the GitHub
// workflows used, now kept; ET jobs say ET once instead of twice.
export const JOBS = Object.freeze([
  { id: 'checkpoint', tz: NY, at: ['00:30', '08:40', '10:02', '10:32'], days: MON_FRI, usOpen: true, path: '/api/tradecard?card=checkpoint', timeoutMs: 60000 },
  { id: 'tradecard', tz: 'UTC', at: ['14:35', '17:00', '21:05', '01:35'], days: MON_FRI, path: '/api/tradecard', timeoutMs: 45000 },
  { id: 'walletcard', tz: 'UTC', at: range('06:00', '23:30', 30), days: null, path: '/api/tradecard?card=wallet', timeoutMs: 90000 },
  { id: 'flex-sync', tz: 'UTC', at: ['12:00'], days: MON_FRI, path: '/api/flex-sync?apply=1&trades=1', timeoutMs: 120000 },
  { id: 'gex-recompute', tz: NY, at: ['07:15', '09:25'], days: MON_FRI, usOpen: true, path: '/api/gex?settled=1&symbols=QQQ,SPY&scheduled=1', timeoutMs: 240000 },
  // UTC on purpose: 15:15Z is after the open and 22:00Z after the bell in BOTH halves of the year.
  { id: 'gex-snapshot-open', tz: 'UTC', at: ['15:15'], days: MON_FRI, path: '/api/gex?snapshot=1&dry=0&session=open', timeoutMs: 290000 },
  { id: 'gex-snapshot-close', tz: 'UTC', at: ['22:00'], days: MON_FRI, path: '/api/gex?snapshot=1&dry=0&session=close', timeoutMs: 290000 },
  { id: 'mls-paper', tz: 'UTC', at: ['05:15', '09:15'], days: ['Tue', 'Wed', 'Thu', 'Fri', 'Sat'], path: '/api/atr?mls=1&write=1', timeoutMs: 60000 },
  { id: 'ratio-breaks', tz: 'UTC', at: ['21:40'], days: MON_FRI, path: '/api/atr?ratios=1&write=1', timeoutMs: 60000 },
  // The pre-reads gate themselves (lead time, DST, same-day dedupe), so each region gets both
  // daylight-saving candidates plus a backup and the route decides which one is the run.
  { id: 'preread-asia', tz: 'UTC', at: ['22:42', '22:49'], days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'], path: '/api/preread?region=asia&post=1&cron=1', timeoutMs: 180000 },
  { id: 'preread-eu', tz: 'UTC', at: ['07:47', '08:07', '08:47', '09:07'], days: MON_FRI, path: '/api/preread?region=eu&post=1&cron=1', timeoutMs: 180000 },
  { id: 'preread-us', tz: 'UTC', at: ['12:42', '12:49', '13:42', '13:49'], days: MON_FRI, path: '/api/preread?region=us&post=1&cron=1', timeoutMs: 180000 },
  { id: 'korea-fetch', tz: 'UTC', at: ['07:10', '11:10'], days: MON_FRI, workflow: 'korea-fetch.yml' },
]);

// ── CLOCKS ───────────────────────────────────────────────────────────────────
function partsIn(tz, ms) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, h: +p.hour, m: +p.minute, weekday: p.weekday };
}
// The UTC instant of a wall-clock time on a date in a zone (two passes settle the offset).
export function zonedToUtc(day, hhmm, tz) {
  const [y, mo, d] = day.split('-').map(Number), [h, mi] = hhmm.split(':').map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = partsIn(tz, t);
    const [py, pm, pd] = p.day.split('-').map(Number);
    t += want - Date.UTC(py, pm - 1, pd, p.h, p.m);
  }
  return t;
}
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Slots of one job that fall in (now − WINDOW_MIN, now], each with its local day and weekday.
export function dueSlots(job, now = Date.now(), { usClosed = [], windowMin = WINDOW_MIN } = {}) {
  const today = partsIn(job.tz, now).day;
  const out = [];
  for (const day of [addDays(today, -1), today]) {
    const weekday = partsIn(job.tz, Date.parse(`${day}T12:00:00Z`)).weekday;
    if (job.days && !job.days.includes(weekday)) continue;
    for (const at of job.at) {
      const t = zonedToUtc(day, at, job.tz);
      if (t > now || now - t >= windowMin * 60000) continue;
      if (job.usOpen && usClosed.includes(partsIn(NY, t).day)) continue;
      out.push({ id: job.id, slot: new Date(t).toISOString(), day, at });
    }
  }
  return out;
}
export const allDue = (jobs = JOBS, now = Date.now(), opts = {}) => jobs.flatMap(j => dueSlots(j, now, opts).map(s => ({ job: j, ...s })));

// ── RUNNING ──────────────────────────────────────────────────────────────────
// What gets recorded from a job's answer: status and the route's own ok/error. Nothing else — a
// route's body can carry account data, and the record is readable on the status page.
export function outcomeOf(status, body, ms) {
  const ok = status >= 200 && status < 300 && body?.ok !== false && !body?.error;
  const why = body?.error || body?.why || body?.reason || null;
  return { ok, status, ms, ...(why ? { note: String(why).slice(0, 140) } : {}) };
}

export async function runJob(job, { origin, env = process.env, fetchImpl = fetch, dispatch } = {}) {
  const t0 = Date.now();
  try {
    if (job.workflow) {
      const r = await dispatch(job.workflow);
      return { ok: !!r?.ok, status: r?.status ?? null, ms: Date.now() - t0, ...(r?.ok ? {} : { note: String(r?.hint || r?.error || 'dispatch failed').slice(0, 140) }) };
    }
    const r = await fetchImpl(`${origin}${job.path}`, {
      headers: { 'x-tradecard-key': String(env.TRADECARD_KEY || ''), 'user-agent': 'dvcap-cron/1' },
      signal: AbortSignal.timeout(job.timeoutMs || 60000),
    });
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    return outcomeOf(r.status, body, Date.now() - t0);
  } catch (e) {
    return { ok: false, status: null, ms: Date.now() - t0, note: String(e?.name === 'TimeoutError' ? `no answer within ${Math.round((job.timeoutMs || 60000) / 1000)}s` : e?.message || e).slice(0, 140) };
  }
}

// One tick: claim each due slot once, run the claimed jobs together, record the outcomes.
// kv: { setNx(key, value, ttl) → bool, get(key), set(key, value) }.
export async function tick({ now = Date.now(), kv, usClosed = [], origin, env, fetchImpl, dispatch, jobs = JOBS } = {}) {
  const due = allDue(jobs, now, { usClosed });
  if (!due.length) return { ran: [] };
  const claimed = [];
  for (const d of due) {
    const took = await kv.setNx(claimKey(d.id, d.slot), { at: new Date(now).toISOString() }, CLAIM_TTL_S).catch(() => false);
    if (took) claimed.push(d);
  }
  if (!claimed.length) return { ran: [], skipped: due.length };
  const results = await Promise.all(claimed.map(async d => ({ id: d.id, slot: d.slot, ...(await runJob(d.job, { origin, env, fetchImpl, dispatch })) })));
  try {
    const last = (await kv.get(LAST_KEY)) || {};
    for (const r of results) { const { id, ...rest } = r; last[id] = { ...rest, at: new Date(now).toISOString() }; }
    await kv.set(LAST_KEY, last);
  } catch { /* the outcome is still returned */ }
  return { ran: results };
}

// The status page: each job's schedule, next slot and last outcome.
export function nextSlot(job, now = Date.now(), { usClosed = [] } = {}) {
  const today = partsIn(job.tz, now).day;
  for (let k = 0; k <= 8; k++) {
    const day = addDays(today, k);
    const weekday = partsIn(job.tz, Date.parse(`${day}T12:00:00Z`)).weekday;
    if (job.days && !job.days.includes(weekday)) continue;
    const ts = job.at.map(at => zonedToUtc(day, at, job.tz))
      .filter(t => t > now && !(job.usOpen && usClosed.includes(partsIn(NY, t).day))).sort((x, y) => x - y);
    if (ts.length) return new Date(ts[0]).toISOString();
  }
  return null;
}
export function statusView(last = {}, now = Date.now(), { jobs = JOBS, usClosed = [] } = {}) {
  return jobs.map(j => ({
    id: j.id, clock: j.tz === NY ? 'New York' : 'UTC',
    at: j.at.length > 6 ? `${j.at[0]}–${j.at.at(-1)} every 30 min` : j.at.join(', '),
    runs: j.workflow ? `GitHub ${j.workflow}` : j.path.split('?')[0],
    next: nextSlot(j, now, { usClosed }), last: last[j.id] || null,
  }));
}
