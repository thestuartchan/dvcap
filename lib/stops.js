// lib/stops.js — the stop a trade was entered with, and every move after it.
//
// WHY (21 Oct). R is a multiple of the risk taken at entry. The cards measured it against whatever
// stop sat on the row NOW, so trailing a stop rewrote the trade's history: VST was bought at 138.18,
// its stop later trailed up to 151 to protect profits, and from then on it showed no R at all — a
// stop above a long entry is no risk unit — and had it been trailed to 140 its +2R would have read
// as +9R. A trailed stop is the right thing to watch; it is the wrong thing to measure against.
//
// So a row carries two things beside its levels:
//   initialStop  { at, date, on?, recorded | reconstructed }  the risk unit R is measured against
//   stopHistory  [{ date, from, to }]                          every move of the stop once entered
// Kept on the ROW, not the level, so deleting the stop, re-adding it or changing its kind never
// loses where it started. The current stop still drives alerts, the sizer and the exposure strip.
//
// WHEN IT IS CAPTURED. Before the first fill the stop is a plan and moves freely. Once the row holds
// a fill, the first change to the stop records what it was (the stop the trade was entered with,
// dated to the first fill) and logs the move. A stop typed in by hand afterwards — a trade whose
// original stop was never written down — is marked `reconstructed` with the day it was entered, so
// the R that follows says it is a reconstruction and not the original commitment.

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const HISTORY_MAX = 30;

// The stop that is in force now: the first stop level with a price.
export const currentStop = (row) => (row?.levels || []).find(l => l?.kind === 'stop' && num(l?.at) != null) || null;

// Has the trade been entered? Any fill at all — a plan with no fills moves its stop freely.
export const entered = (row) => Array.isArray(row?.fills) && row.fills.length > 0;
const firstFillDate = (row) => (row?.fills || []).map(f => f?.date).filter(Boolean).sort()[0] || null;

// The stop R is measured against: the initial stop when one is recorded, else the current one.
// { at, on, source: 'initial' | 'current', reconstructed } or null when there is none.
export function riskStop(row) {
  const i = row?.initialStop;
  if (i && num(i.at) != null) return { at: num(i.at), on: i.on || null, source: 'initial', reconstructed: !!i.reconstructed };
  const s = currentStop(row);
  return s ? { at: num(s.at), on: s.on || null, source: 'current', reconstructed: !!s.backfilled } : null;
}

// A change to the stop: what was, what is, as a patch for the row ({ initialStop?, stopHistory? }),
// empty when nothing needs recording. `prev` and `next` are prices (null for no stop).
export function stopChange(row, prev, next, { today = new Date().toISOString().slice(0, 10), on = null } = {}) {
  const a = num(prev), b = num(next);
  if (!entered(row) || a === b) return {};
  const patch = {};
  // The first move after entry fixes the stop the trade was entered with — unless one is already set.
  if (a != null && !(row.initialStop && num(row.initialStop.at) != null)) {
    patch.initialStop = { at: a, date: firstFillDate(row) || today, ...(on ? { on } : {}), recorded: true };
  }
  if (a != null || (row.stopHistory || []).length) {
    patch.stopHistory = [...(row.stopHistory || []), { date: today, from: a, to: b }].slice(-HISTORY_MAX);
  }
  return patch;
}

// Typing the initial stop by hand. On a trade already entered it is a reconstruction, dated today;
// a blank clears it, and R falls back to the current stop.
export function setInitialStop(row, at, { today = new Date().toISOString().slice(0, 10), on = null } = {}) {
  const v = num(at);
  if (v == null) return { initialStop: null };
  const auto = row?.initialStop?.recorded && num(row.initialStop.at) === v;
  if (auto) return {};
  return { initialStop: { at: v, date: firstFillDate(row) || today, ...(on ? { on } : {}), reconstructed: today } };
}

// One line for the row: where R is measured from, and how the stop has moved since.
export function stopStory(row) {
  const r = riskStop(row);
  if (!r) return null;
  const moves = (row?.stopHistory || []).map(h => `${h.from ?? '—'} → ${h.to ?? 'removed'} (${h.date})`);
  const from = r.source === 'initial'
    ? `R from the initial stop ${r.at}${r.reconstructed ? `, reconstructed ${typeof row.initialStop.reconstructed === 'string' ? row.initialStop.reconstructed : ''}`.trimEnd() : row.initialStop?.date ? ` (entry ${row.initialStop.date})` : ''}`
    : `R from the current stop ${r.at}`;
  return moves.length ? `${from} · moved ${moves.join(', ')}` : from;
}
