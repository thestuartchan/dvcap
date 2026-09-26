// lib/flexStatus.js — one line saying whether the daily IBKR sync ran, and what it found.
//
// The sync (flex-sync.yml → /api/flex-sync) writes a note after every applying run, but the console
// only spoke up when something needed you. A quiet, healthy morning and a sync that had stopped
// running looked the same: nothing on screen. This reads the note and says which it is.
//
// WHEN A RUN IS MISSED. The workflow is scheduled for 12:00Z on weekdays and GitHub fires it late —
// 15:30–17:30Z in September 2026 — so a weekday's run is counted as missed only once 18:00Z has
// passed with no note written that UTC day. Weekends have no run and are never a miss.
export const RUN_DEADLINE_UTC_HOUR = 18;

// The most recent weekday deadline at or before `now`.
export function lastDeadline(now = new Date()) {
  const d = new Date(now);
  d.setUTCHours(RUN_DEADLINE_UTC_HOUR, 0, 0, 0);
  if (d > now) d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

const ago = (ms) => {
  const h = Math.floor(ms / 3600e3);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
};

// { tone: 'ok' | 'warn', text, title } — `note` is the stored flex note (api/flex-sync.js noteOf).
export function syncStatus(note, { now = new Date() } = {}) {
  if (!note?.at || !Number.isFinite(Date.parse(note.at))) {
    return { tone: 'warn', text: 'IBKR sync has not reported yet', title: 'No note from the daily reconciliation has been stored.' };
  }
  const at = new Date(note.at);
  const due = lastDeadline(now);
  const dayStart = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()));
  const missed = at < dayStart;
  const needs = note.needsYou?.length || 0;
  const bits = [`IBKR synced ${ago(now - at)}`];
  if (note.asOf) bits.push(`statement ${note.asOf}`);
  if (note.agree != null && note.positions != null) bits.push(`${note.agree} of ${note.positions} positions agree`);
  if (note.discarded) bits.push('batch not applied');
  else if (needs) bits.push(`${needs} need${needs === 1 ? 's' : ''} you`);
  else if (note.applied) bits.push('changes applied');
  else bits.push('nothing new');
  if (missed) bits.unshift(`⚠ no sync since ${String(note.at).slice(0, 10)} — the ${due.toISOString().slice(0, 10)} run is missing`);
  return {
    tone: missed || needs || note.discarded ? 'warn' : 'ok',
    text: missed ? bits.slice(0, 2).join(' · ') : bits.join(' · '),
    title: note.summary ? `Last run ${note.at} — ${note.summary}` : `Last run ${note.at}`,
  };
}
