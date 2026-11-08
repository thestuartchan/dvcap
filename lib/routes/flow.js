// lib/routes/flow.js — /api/flow: the Unusual Whales flow snapshot (build step 8, lib/uw.js).
//
// LICENSED FOR PERSONAL USE. Every data answer is gated by authorised() — the dashboard session
// cookie or the scheduler's service key. The one public answer, ?health=1, says which parts loaded
// and when, never a number. The snapshot lives in Redis under its own keys, which are NOT documents
// (lib/docStore.js DOCS) and so never reach the public data-backup branch.
//
//   GET /api/flow            the latest snapshot, refreshed when older than 3 minutes (session)
//   GET /api/flow?fresh=1    force a new snapshot (session)
//   GET /api/flow?daily=1    the kept daily rows for the 60-day scorecard (session)
//   GET /api/flow?snapshot=1[&close=1]   scheduler jobs uw-flow / uw-close (service key); close keeps
//                            the day's row and posts the PRIVATE close card (lib/alerts.js `flow`)
//   GET /api/flow?health=1   public: part names, ok flags, time
import { authorised, refusalReason } from '../apiauth.js';
import { kvGetJson, kvSetJson, kvConfigured } from '../kv.js';
import { uwConfigured, uwGet, flowSnapshot, healthOf, dailyRow, closeCard } from '../uw.js';
import { sendAlert } from '../alerts.js';
import { post } from '../discord.js';

export const UW_SNAP_KEY = 'dvcap:uw:snap:v1';
export const UW_DAILY_KEY = 'dvcap:uw:daily:v1';
export const UW_DAILY_MAX = 130;
export const FRESH_MS = 3 * 60 * 1000;

const defaultKv = { configured: kvConfigured, get: kvGetJson, set: kvSetJson };

// Keep the day's row (one per date) and post the close card once. Returns what happened, in words.
export async function closeOut(snap, { kv = defaultKv, deliver = post, env = process.env, now = new Date() } = {}) {
  const row = dailyRow(snap);
  if (!row) return { daily: 'no tide: nothing kept', alert: 'not sent' };
  let rows = kv.configured() ? await kv.get(UW_DAILY_KEY).catch(() => null) : null;
  rows = Array.isArray(rows) ? rows : [];
  const had = rows.find(r => r.date === row.date);
  const today = { ...row, posted: !!had?.posted };
  const next = [...rows.filter(r => r.date !== row.date), today].sort((a, b) => a.date.localeCompare(b.date)).slice(-UW_DAILY_MAX);
  let alert = 'already sent today';
  if (!had?.posted) {
    const card = closeCard(snap);
    const sent = card ? await sendAlert({ source: 'flow', payload: card, items: [{ ruleId: 'flow:close', title: `Flow at the close ${row.date}` }] },
      { deliver, kv: kv.configured() ? kv : null, env, now }).catch(() => ({ ok: false })) : { ok: false };
    alert = sent.ok ? 'posted' : 'not posted (private webhook unset or Discord refused)';
    if (sent.ok) today.posted = true;
  }
  const saved = kv.configured() ? !!(await kv.set(UW_DAILY_KEY, next).catch(() => false)) : false;
  return { daily: saved ? `kept (${next.length} days)` : 'not kept (Redis unavailable)', alert };
}

export default async function flow(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const kv = defaultKv;
  if (q.health) {
    const snap = kv.configured() ? await kv.get(UW_SNAP_KEY).catch(() => null) : null;
    return res.status(200).json({ ok: true, configured: uwConfigured(), last: healthOf(snap) });
  }
  if (!(await authorised(req))) return res.status(401).json({ ok: false, error: 'unauthorised', why: refusalReason(req) });
  if (!uwConfigured()) return res.status(200).json({ ok: false, why: 'UW_API_KEY is not set on this deployment' });
  if (q.daily) {
    const rows = kv.configured() ? await kv.get(UW_DAILY_KEY).catch(() => null) : null;
    return res.status(200).json({ ok: true, rows: Array.isArray(rows) ? rows : [] });
  }
  let snap = kv.configured() ? await kv.get(UW_SNAP_KEY).catch(() => null) : null;
  const stale = !snap?.at || Date.now() - Date.parse(snap.at) > FRESH_MS;
  if (q.snapshot || q.fresh || stale) {
    snap = await flowSnapshot({ get: (path, o = {}) => uwGet(path, o) });
    if (kv.configured() && snap.ok > 0) await kv.set(UW_SNAP_KEY, snap).catch(() => {});
  }
  if (q.snapshot) {
    // The scheduler's answer carries part states only: job logs never hold UW numbers.
    const close = q.close ? await closeOut(snap) : null;
    return res.status(snap.ok > 0 ? 200 : 502).json({ ok: snap.ok > 0, health: healthOf(snap), close });
  }
  return res.status(200).json({ ok: snap.ok > 0, snap });
}
