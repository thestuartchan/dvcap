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
export function prereadStatus(log = {}, { regions, now = new Date(), localDateIn, localMinutesOfDay } = {}) {
  const out = [];
  for (const [region, R] of Object.entries(regions || {})) {
    if (!R?.tz || R.prereadHourLocal == null) continue;
    const today = localDateIn(R.tz, now);
    const nowMin = localMinutesOfDay(R.tz, now);
    const last = log?.[region] || null;
    const deadline = Number.isFinite(R.prereadDeadlineLocal) ? R.prereadDeadlineLocal : R.prereadHourLocal * 60 + 55;
    const delivered = last?.localDate === today;
    // Before the window even opens there is nothing to say — most of the day is this.
    const state = delivered ? 'delivered'
      : nowMin < R.prereadHourLocal * 60 - 20 ? 'pending'
      : nowMin < deadline ? 'due'
      : 'missed';
    out.push({ region, label: R.label || region, state, tz: R.tz, today,
      at: delivered ? last.at : null,
      lastAt: last?.at || null, lastDate: last?.localDate || null,
      // Only meaningful once the deadline has passed; the console renders it as the reason.
      minsPastDeadline: state === 'missed' ? nowMin - deadline : null });
  }
  return out;
}

// Only the part worth interrupting someone with.
export const prereadMissed = (rows = []) => rows.filter(r => r.state === 'missed');
