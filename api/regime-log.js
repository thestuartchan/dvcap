// api/regime-log.js — the regime history log (P0.3).
//
// Why this exists: without a history the classifier is UNFALSIFIABLE. There is no way to ask
// "has it actually been right", and no way to re-run a change to the discriminator against
// what really happened. So we store the RAW INPUTS, not just the output — a logic change can
// then be backtested against every day already recorded.
//
// One row per DATE (not per refresh): the last write for a date wins, so a page that refreshes
// twenty times a day produces one row, and a later intraday state supersedes an earlier one.
// Uses the same GitHub commit-back store as the Korea entry — no new infrastructure.

import { hasSessionCookie, hasCronSecret, refuse } from '../lib/apiauth.js';
import { tick, statusView, healthSummary, failureCard, privateTestCard, nyDayOf, jobLabel, FAIL_ALERT_KEY, LAST_KEY as CRON_LAST_KEY } from '../lib/cronRouter.js';
import { post, privateWebhookFromEnv } from '../lib/discord.js';
import { sendAlert } from '../lib/alerts.js';
import { dispatchOne } from '../lib/githubDispatch.js';
import { kvConfigured, kvGetJson, kvSetJson, kvSetNxEx } from '../lib/kv.js';
import HOLIDAYS from '../data/holidays.json' with { type: 'json' };
import { readRegimeStore, writeRegimeRow, logConfigured, HAS_CONTENT } from '../lib/regimeLog.js';
// The store, the merge and the commit live in lib/regimeLog.js, shared with the pre-read cron.

// THE SCHEDULER (lib/cronRouter.js). Vercel calls ?tick=1 every minute, signed with CRON_SECRET;
// ?tick=status (behind the dashboard login) lists every job, its next slot and its last outcome.
// It lives in this route because the deployment is at its function limit, not because it has
// anything to do with the regime log.
const usClosed = () => HOLIDAYS?.US?.closed || [];
async function cronTick(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (String(req.query.tick) === 'status') {
    if (!(await hasSessionCookie(req))) return res.status(401).json({ error: 'sign in to the dashboard first' });
    const last = kvConfigured() ? ((await kvGetJson(CRON_LAST_KEY).catch(() => null)) || {}) : {};
    const jobs = statusView(last, Date.now(), { usClosed: usClosed() });
    return res.status(200).json({ now: new Date().toISOString(), cronSecret: !!String(process.env.CRON_SECRET || '').trim(),
      privateChannel: !!privateWebhookFromEnv(), summary: healthSummary(jobs), jobs });
  }
  // ?tick=test-private (POST, dashboard login): one test message to the private channel, from the
  // deployment's own webhook, so it can be checked without the URL ever leaving Vercel. Once a minute.
  if (String(req.query.tick) === 'test-private') {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, why: 'POST from the dashboard' });
    if (!(await hasSessionCookie(req))) return res.status(401).json({ ok: false, why: 'sign in to the dashboard first' });
    const webhook = privateWebhookFromEnv();
    if (!webhook) return res.status(200).json({ ok: false, why: 'DISCORD_PRIVATE_WEBHOOK is not set in this deployment (redeploy after adding it)' });
    if (kvConfigured() && !(await kvSetNxEx('dvcap:discord:private:test:v1', 1, 60).catch(() => true))) return res.status(200).json({ ok: false, why: 'a test was sent in the last minute' });
    const sent = await post(webhook, privateTestCard()).catch(() => null);
    return res.status(200).json(sent ? { ok: true } : { ok: false, why: 'Discord did not accept the message: check the webhook URL' });
  }
  if (!hasCronSecret(req)) return res.status(401).json({ error: 'cron secret missing or wrong' });
  if (!kvConfigured()) return res.status(200).json({ ok: false, why: 'KV not configured: slots cannot be claimed, so nothing runs' });
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || req.headers.host;
  const out = await tick({
    now: Date.now(), usClosed: usClosed(), origin: `https://${host}`, env: process.env,
    kv: { setNx: kvSetNxEx, get: kvGetJson, set: kvSetJson },
    dispatch: (wf) => dispatchOne(wf, { env: process.env, fetchImpl: fetch, now: new Date() }),
  });
  // One line per tick that ran something: job, slot, verdict. Nothing from the routes' answers.
  if (out.ran?.length) console.log(`[cron] ${out.ran.map(r => `${r.id}@${r.slot.slice(11, 16)}Z ${r.ok ? 'ok' : 'FAIL'} ${r.status ?? '-'} ${r.ms}ms${r.ok || !r.note ? '' : ` (${r.note})`}`).join(' · ')}`);
  // A failed job tells Stu in the private channel, once per job per New York day. The note is the
  // route's own error line (lib/cronRouter.js outcomeOf keeps nothing else from its answer).
  const failed = (out.ran || []).filter(r => !r.ok);
  const webhook = failed.length ? privateWebhookFromEnv() : null;
  if (webhook) {
    for (const r of failed) {
      const first = await kvSetNxEx(FAIL_ALERT_KEY(r.id, nyDayOf(Date.now())), 1, 2 * 86400).catch(() => false);
      // Through the one alert module (lib/alerts.js): private channel, logged against the job.
      if (first) await sendAlert({ source: 'job', payload: failureCard(r), items: [{ ruleId: `job:${r.id}`, title: `${jobLabel(r.id)} failed${r.note ? ` · ${r.note}` : ''}`, state: 'failed' }] },
        { deliver: post, kv: { get: kvGetJson, set: kvSetJson }, webhook }).catch(() => null);
    }
  }
  return res.status(200).json({ ok: true, ...out });
}

export default async function handler(req, res) {
  if (req.query?.tick != null) return cronTick(req, res);
  // GET → read the log back (for the sparkline). No auth needed to read.
  if (req.method === 'GET') {
    if (!logConfigured()) return res.status(200).json({ rows: [], note: 'store not configured' });
    try {
      const { store } = await readRegimeStore();
      // Serve only rows that actually carry a reading. A husk plots as a gap and counts as a
      // day logged, which is how an empty chart came to claim '3 days logged'.
      const all = (store.rows || []).filter(HAS_CONTENT);
      const rows = all.slice(-Number(req.query.limit || 90));
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).json({ rows, count: all.length, stored: (store.rows || []).length });
    } catch (e) {
      return res.status(200).json({ rows: [], error: String(e?.message || e) });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
  if (!(await hasSessionCookie(req))) return refuse(res);
  if (!logConfigured()) return res.status(500).json({ error: 'GITHUB_TOKEN / GITHUB_REPO not configured' });

  const b = req.body || {};
  const date = String(b.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad or missing date (YYYY-MM-DD)' });

  const row = {
    date,
    stagflation_p: b.stagflation_p ?? null, reflationary_p: b.reflationary_p ?? null,
    deflationary_p: b.deflationary_p ?? null, inflationary_p: b.inflationary_p ?? null,
    hawkish_repricing: b.hawkish_repricing ?? null,
    live_regime: b.live_regime ?? null, view_regime: b.view_regime ?? null, pinned: !!b.pinned,
    hyg_chg: b.hyg_chg ?? null, hyg_qqq_divergence: b.hyg_qqq_divergence ?? null,
    // RAW CLASSIFIER INPUTS — the part that makes the log re-runnable.
    inputs: b.inputs ?? null,
    // The measured market state (lib/marketState.js stateLogRow) — market data only.
    state: b.state ?? null,
    axes: b.axes ?? null,
    source: 'client',
    loggedAt: new Date().toISOString(),
  };
  const w = await writeRegimeRow(row);
  if (!w.ok) return res.status(502).json(w);
  return res.status(200).json(w);
}
