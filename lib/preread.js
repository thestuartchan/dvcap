// lib/preread.js — pre-read delivery bookkeeping, separate from the endpoint that does the work.

// ── WAS THE BRIEF ACTUALLY DELIVERED TODAY? ──────────────────────────────────
// Three consecutive days of Asia pre-reads went missing and each one was found the same way: a
// person noticing an absence in a Discord channel. Nothing in the system said anything, because
// nothing in the system was asked. A schedule that can fail silently will, and the failure has to
// surface somewhere the reader already looks.
//
// This reads the same per-region record the endpoint writes on a confirmed post, and answers three
// states rather than two — `due` is not the same as `missed`, and calling a brief missed while its
// window is still open would train the reader to ignore the line.
import { closedExchanges } from './sessions.js';

// ── ONLY REGIONS THAT ARE ACTUALLY SCHEDULED ─────────────────────────────────
// The panel monitored every region in the universe and flagged EU as a missed delivery every
// single day. Vercel Hobby allows two cron entries and Asia and US hold both, so EU is scheduled by
// a GitHub Action instead (.github/workflows/preread-eu.yml) — the same answer this repo reaches
// every time it runs out of Vercel crons. Scheduled is scheduled; where the timer lives does not
// change whether a missing brief should be reported. A warning that is always on is not a warning; it teaches the reader to skip
// the panel, which is the one place a genuinely missed brief would show.
//
// Named here rather than read from config at runtime, because a serverless function should not
// depend on a config file being bundled beside it — and named in ONE place, with a test in
// test/preread.test.mjs asserting it matches what is ACTUALLY scheduled, across both vercel.json
// and the GitHub workflows. Add a region's cron anywhere and that test fails until this list is
// updated, which is the point.
export const SCHEDULED_REGIONS = Object.freeze(['asia', 'eu', 'us']);

export function prereadStatus(log = {}, { regions, now = new Date(), localDateIn, localMinutesOfDay,
                                          scheduled = SCHEDULED_REGIONS } = {}) {
  const out = [];
  const watched = scheduled == null ? null : new Set(scheduled);
  for (const [region, R] of Object.entries(regions || {})) {
    if (!R?.tz || R.prereadHourLocal == null) continue;
    // Nothing delivers it on a schedule, so nothing can have missed it. The brief is still
    // assembled on demand — this says only that there is no scheduled delivery to be late.
    if (watched && !watched.has(region)) continue;
    const today = localDateIn(R.tz, now);
    const nowMin = localMinutesOfDay(R.tz, now);
    const last = log?.[region] || null;
    const deadline = Number.isFinite(R.prereadDeadlineLocal) ? R.prereadDeadlineLocal : R.prereadHourLocal * 60 + 55;
    const delivered = last?.localDate === today;
    // ── AND ONLY ON DAYS THERE IS A SESSION TO BE AHEAD OF ───────────────────────────────────
    // The panel has to ask the same question the DELIVERY GUARD asks, or the two disagree and the
    // panel is wrong exactly when the guard is right. On 2026-09-07 — Labor Day — the guard
    // correctly refused the US brief, and this would have reported it as a missed delivery.
    // Same call the handler makes, in the region's own local date.
    const syms = [...(R.names || []).map(n => n.sym), ...(R.indices || []).map(i => i.sym)];
    const noSession = syms.length > 0 && closedExchanges(syms, now).allClosed;
    // Before the window even opens there is nothing to say — most of the day is this.
    const state = delivered ? 'delivered'
      : noSession ? 'no-session'
      : nowMin < R.prereadHourLocal * 60 - 20 ? 'pending'
      : nowMin < deadline ? 'due'
      : 'missed';
    out.push({ region, label: R.label || region, state, tz: R.tz, today, noSession,
      at: delivered ? last.at : null,
      lastAt: last?.at || null, lastDate: last?.localDate || null,
      // Only meaningful once the deadline has passed; the console renders it as the reason.
      minsPastDeadline: state === 'missed' ? nowMin - deadline : null });
  }
  return out;
}

// Only the part worth interrupting someone with.
export const prereadMissed = (rows = []) => rows.filter(r => r.state === 'missed');
