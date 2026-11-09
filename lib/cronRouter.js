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
import { dubaiEt } from './timeFmt.js';

const MON_FRI = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const range = (from, to, stepMin) => {
  const out = [];
  const [fh, fm] = from.split(':').map(Number), [th, tm] = to.split(':').map(Number);
  for (let m = fh * 60 + fm; m <= th * 60 + tm; m += stepMin) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  return out;
};

// THE SCHEDULE. `path` jobs are called on this deployment with the service key; `workflow` jobs are
// GitHub workflow_dispatch (none since build step 6: what committed data now writes to Redis).
// `usOpen` skips New York market holidays (data/holidays.json). Times are the ones the GitHub
// workflows used, now kept; ET jobs say ET once instead of twice.
export const JOBS = Object.freeze([
  { id: 'checkpoint', tz: NY, at: ['00:30', '08:40', '10:02', '10:32'], days: MON_FRI, usOpen: true, path: '/api/tradecard?card=checkpoint', timeoutMs: 60000 },
  { id: 'tradecard', tz: 'UTC', at: ['14:35', '17:00', '21:05', '01:35'], days: MON_FRI, path: '/api/tradecard', timeoutMs: 45000 },
  { id: 'walletcard', tz: 'UTC', at: range('06:00', '23:30', 30), days: null, path: '/api/tradecard?card=wallet', timeoutMs: 90000 },
  // retryAfterMin (9 Nov 2026): IBKR answers "still generating" on slow days. The GitHub workflow used
  // to retry the whole request; the scheduler ran it once and alerted. A retry slot runs only while the
  // last run of the same slot failed with retryable:true, and polls the statement the first run asked
  // for (api/flex-sync.js keeps it 15 minutes), so it never restarts IBKR's wait.
  { id: 'flex-sync', tz: 'UTC', at: ['12:00'], retryAfterMin: [3, 7, 12, 20], days: MON_FRI, path: '/api/flex-sync?apply=1&trades=1', timeoutMs: 120000 },
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
  // Korea: KOFIA and KRX after the Seoul close, into the Redis document (build step 6; was a GitHub workflow).
  { id: 'korea-fetch', tz: 'UTC', at: ['07:10', '11:10'], days: MON_FRI, path: '/api/korea-save?fetch=1&scheduled=1', method: 'POST', timeoutMs: 120000 },
  // The Signal Board's daily row, before the open: 07:50 New York in both halves of the year, into
  // the Redis document the scorecard reads (lib/signalBoardSnapshot.js; was a GitHub workflow that
  // committed data/signal_board_history.json until build step 6).
  { id: 'signal-board', tz: NY, at: ['07:50'], days: MON_FRI, usOpen: true, path: '/api/indicators?board=snapshot', timeoutMs: 180000 },
  // 6 Nov 2026. Today's fills beside the book (lib/sameDayFills.js todayNet): IBKR's same-day report
  // every 30 minutes through the US session, summary only, no drafts (api/flex-sync.js ?tcpeek=1).
  { id: 'same-day-book', tz: NY, at: range('09:45', '16:45', 30), days: MON_FRI, usOpen: true, path: '/api/flex-sync?tcpeek=1', timeoutMs: 60000 },
  // The Position Desk's rules on the close (lib/deskRules.js): after TradingView's 15-minute delay on
  // US closes, before the nightly Desk task (16:38) so it reads dvcap's states.
  // 8 Nov 2026. Politicians' and insiders' trades from the filings (lib/disclosures.js): the House
  // Clerk's index every hour (filings land through the day), every new Form 4 across the market every
  // 30 minutes (SEC's latest-filings feed holds the last few hundred), and Friday's insider roundup.
  { id: 'disclosures-congress', tz: 'UTC', at: range('00:07', '23:07', 60), days: null, path: '/api/tradecard?disclosures=congress', timeoutMs: 240000 },
  { id: 'disclosures-insiders', tz: 'UTC', at: range('00:19', '23:49', 30), days: null, path: '/api/tradecard?disclosures=insiders', timeoutMs: 240000 },
  { id: 'disclosures-roundup', tz: NY, at: ['18:30'], days: ['Fri'], path: '/api/tradecard?disclosures=roundup', timeoutMs: 60000 },
  { id: 'desk-rules', tz: NY, at: ['16:20'], days: MON_FRI, usOpen: true, path: '/api/tradecard?deskrules=1', timeoutMs: 120000 },
  // Build step 6: the Redis documents (lib/docStore.js) copied to the data-backup branch nightly,
  // only when changed (lib/docBackup.js). 23:10 UTC = 03:10 Dubai, after every US-day write.
  { id: 'docs-backup', tz: 'UTC', at: ['23:10'], days: null, path: '/api/regime-log?backup=1', timeoutMs: 60000 },
  // Build step 8: the Unusual Whales flow snapshot (lib/uw.js) — three in the session for the panel,
  // one after the close that keeps the day's row for the 60-day scorecard and posts the private card.
  { id: 'uw-flow', tz: NY, at: ['09:50', '12:30', '15:30'], days: MON_FRI, usOpen: true, path: '/api/flow?snapshot=1', timeoutMs: 120000 },
  { id: 'uw-close', tz: NY, at: ['16:12'], days: MON_FRI, usOpen: true, path: '/api/flow?snapshot=1&close=1', timeoutMs: 120000 },
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
    // Retry slots: offsets from each base slot. Whether one actually runs is decided in tick(), from
    // the job's last outcome (shouldRetry).
    for (const at of job.retryAfterMin ? job.at : []) {
      const base = zonedToUtc(day, at, job.tz);
      if (job.usOpen && usClosed.includes(partsIn(NY, base).day)) continue;
      job.retryAfterMin.forEach((min, i) => {
        const t = base + min * 60000;
        if (t > now || now - t >= windowMin * 60000) return;
        out.push({ id: job.id, slot: new Date(t).toISOString(), day, at, base: new Date(base).toISOString(), retry: i + 1 });
      });
    }
  }
  return out;
}
// A retry slot runs only when the last recorded run belongs to the same base slot and failed with
// retryable:true. A success, a hard failure or a run from another slot ends the retries.
export const shouldRetry = (d, last) => !!last && last.ok === false && last.retryable === true && (last.base || last.slot) === d.base;
// How many retry slots are still to come after this run (0 for a job without retries).
export const retriesLeft = (d) => (d.job?.retryAfterMin?.length || 0) - (d.retry || 0);
export const allDue = (jobs = JOBS, now = Date.now(), opts = {}) => jobs.flatMap(j => dueSlots(j, now, opts).map(s => ({ job: j, ...s })));

// ── RUNNING ──────────────────────────────────────────────────────────────────
// What gets recorded from a job's answer: status and the route's own ok/error. Nothing else — a
// route's body can carry account data, and the record is readable on the status page.
export function outcomeOf(status, body, ms) {
  const ok = status >= 200 && status < 300 && body?.ok !== false && !body?.error;
  const why = body?.error || body?.why || body?.reason || null;
  return { ok, status, ms, ...(why ? { note: String(why).slice(0, 140) } : {}), ...(!ok && body?.retryable ? { retryable: true } : {}) };
}

export async function runJob(job, { origin, env = process.env, fetchImpl = fetch, dispatch } = {}) {
  const t0 = Date.now();
  try {
    if (job.workflow) {
      const r = await dispatch(job.workflow);
      return { ok: !!r?.ok, status: r?.status ?? null, ms: Date.now() - t0, ...(r?.ok ? {} : { note: String(r?.hint || r?.error || 'dispatch failed').slice(0, 140) }) };
    }
    const r = await fetchImpl(`${origin}${job.path}`, {
      method: job.method || 'GET',   // a route that only takes POST (the Korea fetch) says so on its job
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
  let due = allDue(jobs, now, { usClosed });
  if (!due.length) return { ran: [] };
  if (due.some(d => d.retry)) {
    const last = (await kv.get(LAST_KEY).catch(() => null)) || {};
    due = due.filter(d => !d.retry || shouldRetry(d, last[d.id]));
    if (!due.length) return { ran: [] };
  }
  const claimed = [];
  for (const d of due) {
    const took = await kv.setNx(claimKey(d.id, d.slot), { at: new Date(now).toISOString() }, CLAIM_TTL_S).catch(() => false);
    if (took) claimed.push(d);
  }
  if (!claimed.length) return { ran: [], skipped: due.length };
  const results = await Promise.all(claimed.map(async d => {
    const r = { id: d.id, slot: d.slot, ...(d.retry ? { base: d.base, retry: d.retry } : {}), ...(await runJob(d.job, { origin, env, fetchImpl, dispatch })) };
    if (!r.ok && r.retryable) r.retriesLeft = retriesLeft(d);
    return r;
  }));
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
// The latest slot whose catch-up window has closed: by now it should have run.
export function prevSlot(job, now = Date.now(), { usClosed = [], windowMin = WINDOW_MIN } = {}) {
  const cut = now - windowMin * 60000;
  const today = partsIn(job.tz, now).day;
  for (let k = 0; k <= 8; k++) {
    const day = addDays(today, -k);
    const weekday = partsIn(job.tz, Date.parse(`${day}T12:00:00Z`)).weekday;
    if (job.days && !job.days.includes(weekday)) continue;
    const ts = job.at.map(at => zonedToUtc(day, at, job.tz))
      .filter(t => t <= cut && !(job.usOpen && usClosed.includes(partsIn(NY, t).day))).sort((x, y) => y - x);
    if (ts.length) return new Date(ts[0]).toISOString();
  }
  return null;
}
// What each job is called on the dashboard and in the private channel.
export const JOB_LABELS = Object.freeze({
  'checkpoint': 'Daytrade card layers', 'docs-backup': 'Nightly backup of the documents', 'tradecard': 'Trade card', 'walletcard': 'Wallet card', 'flex-sync': 'IBKR statement sync',
  'gex-recompute': 'Gamma recompute (settled OI)', 'gex-snapshot-open': 'Gamma snapshot, open', 'gex-snapshot-close': 'Gamma snapshot, close',
  'mls-paper': 'MLS paper trial', 'ratio-breaks': 'Ratio breaks', 'preread-asia': 'Pre-read Asia', 'preread-eu': 'Pre-read Europe',
  'preread-us': 'Pre-read US', 'korea-fetch': 'Korea data (GitHub)', 'signal-board': 'Signal Board snapshot (GitHub)',
  'same-day-book': 'Same-day fills (IBKR)', 'desk-rules': 'Desk rules at the close',
  'uw-flow': 'Unusual Whales flow snapshot', 'uw-close': 'Unusual Whales flow at the close',
});
export const jobLabel = (id) => JOB_LABELS[id] || id;
// One word per job for the dashboard's Job health panel:
//   ok      the last slot that should have run, ran, and the route said ok
//   failed  it ran and failed (HTTP error, ok:false, timeout)
//   missed  a slot's window closed with no run recorded (the scheduler itself was down)
//   waiting no slot has come due yet, or nothing is recorded since the scheduler started
export function healthOf(job, last, now = Date.now(), opts = {}) {
  const due = prevSlot(job, now, opts);
  if (!due) return 'waiting';
  if (!last?.slot) return 'waiting';
  if (last.slot < due) return 'missed';
  return last.ok ? 'ok' : 'failed';
}
export function statusView(last = {}, now = Date.now(), { jobs = JOBS, usClosed = [] } = {}) {
  return jobs.map(j => ({
    id: j.id, label: jobLabel(j.id), clock: j.tz === NY ? 'New York' : 'UTC',
    at: j.at.length > 6 ? `${j.at[0]}–${j.at.at(-1)} every 30 min` : j.at.join(', '),
    runs: j.workflow ? `GitHub ${j.workflow}` : j.path.split('?')[0],
    next: nextSlot(j, now, { usClosed }), due: prevSlot(j, now, { usClosed }),
    health: healthOf(j, last[j.id], now, { usClosed }), last: last[j.id] || null,
  }));
}
// The panel's headline: how many jobs are in each state.
export function healthSummary(view = []) {
  const n = (h) => view.filter(v => v.health === h).length;
  return { ok: n('ok'), failed: n('failed'), missed: n('missed'), waiting: n('waiting'), total: view.length };
}

// A failed run worth telling Stu about, once per job per New York day (the private channel).
export const FAIL_ALERT_KEY = (id, nyDay) => `dvcap:cron:alerted:v1:${id}:${nyDay}`;
export function failureCard(r, now = Date.now()) {
  // A route that answered 200 with ok:false failed by its own account: its reason is the news, not
  // the status code. No answer at all: the timeout note already says so.
  const why = r.note ? String(r.note).slice(0, 300) : r.status == null ? 'no answer' : `HTTP ${r.status}`;
  return {
    embeds: [{
      title: `⚠️ ${jobLabel(r.id)} failed`,
      description: why,
      color: 0xe74c3c,
      fields: [
        { name: 'Run', value: dubaiEt(new Date(r.slot)), inline: true },
        { name: 'Answer', value: r.status == null ? 'none' : `HTTP ${r.status}`, inline: true },
      ],
      footer: { text: 'dvcap · Data health → Scheduled jobs · posts once per job per day' },
      timestamp: new Date(now).toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };
}
export const nyDayOf = (ms) => partsIn(NY, ms).day;
// The private channel's test card (Job health → Send test message).
export function privateTestCard(now = Date.now()) {
  return {
    embeds: [{
      title: '✅ dvcap private channel connected',
      description: `Test sent from the dashboard, ${dubaiEt(new Date(now))}. Only you can see this channel.`,
      color: 0x2ecc71,
      fields: [
        { name: 'Desk rules at the close', value: 'Your rules newly hit or due, 01:20 Dubai', inline: false },
        { name: 'Scheduled jobs', value: 'A job that fails, once per job per day', inline: false },
        { name: 'Later', value: 'Unusual Whales flow, once subscribed', inline: false },
      ],
      footer: { text: 'dvcap · private channel' },
      timestamp: new Date(now).toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };
}
