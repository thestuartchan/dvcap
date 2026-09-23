// lib/lifecycle.js — one trade card, one state (panel brief, console rework, Step 3).
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// A row opened showing Levels; pressing Bought opened a separate Record panel; after recording,
// the panel disappeared and the fill appeared in a list below; the same thing repeated in the
// archive. The reader could not tell where a trade WAS in its life, and the control that records
// what happened moved around. So the card carries a visible state, and the state is derived from
// the fills — never stored, never confirmed:
//
//   WATCHING  no fills: a setup with levels being watched
//   OPEN      net quantity above zero — the first buy (or short sell) moves it here, by itself
//   CLOSED    quantity back to zero after having traded; realised P&L is frozen
//   ARCHIVED  CLOSED for 24 hours, or archived by hand; read-only, with Restore → CLOSED
//
// lib/positions.js already derives setup / open / closed. This file names them the way the card
// does and adds the one thing the engine cannot see: how long a trade has been closed. `closedAt`
// is stamped on the row by the fill that flattens it (afterFill), and a closed row with no stamp —
// every row closed before this shipped — is treated as long since archived.
export const STATES = Object.freeze(['WATCHING', 'OPEN', 'CLOSED', 'ARCHIVED']);
export const ARCHIVE_AFTER_MS = 24 * 3600 * 1000;
// The filter tabs at the top of the console, in reading order.
export const TABS = Object.freeze([
  { id: 'WATCHING', label: 'Watching' },
  { id: 'OPEN', label: 'Open' },
  { id: 'CLOSED', label: 'Closed' },
  { id: 'ARCHIVED', label: 'Archive' },
]);

// The engine's word for each state, for callers that still speak setup/open/closed.
export const ENGINE_STATUS = Object.freeze({ WATCHING: 'setup', OPEN: 'open', CLOSED: 'closed', ARCHIVED: 'closed' });

export function stateOf(row, { now = Date.now() } = {}) {
  const status = row?.derived?.status;
  if (status === 'setup' || status == null) return 'WATCHING';
  if (status === 'open') return 'OPEN';
  // Closed. A hand decision wins either way: archived by hand, or restored by hand.
  if (row?.archived === true) return 'ARCHIVED';
  if (row?.archived === false) return 'CLOSED';
  const t = Date.parse(String(row?.closedAt || ''));
  if (!Number.isFinite(t)) return 'ARCHIVED';                 // closed before the stamp existed
  return (now - t) >= ARCHIVE_AFTER_MS ? 'ARCHIVED' : 'CLOSED';
}

export const isReadOnly = (state) => state === 'ARCHIVED';

// What a fill changes about the row beyond its fills. `before` and `after` are the engine's
// derivations of the fill list without and with it.
//   open → closed   stamp closedAt (the 24h clock starts) and clear any hand decision
//   closed → open   a re-entry: the row is live again, the stamp and the decision go
//   anything else   nothing
export function afterFill(before, after, { now = new Date().toISOString() } = {}) {
  const was = before?.status, is = after?.status;
  if (was !== 'closed' && is === 'closed') return { closedAt: now, archived: null };
  if (was === 'closed' && is !== 'closed') return { closedAt: null, archived: null };
  return {};
}

export const archivePatch = () => ({ archived: true });
export const restorePatch = ({ now = new Date().toISOString() } = {}) => ({ archived: false, restoredAt: now });

// ── THE THESIS IS REQUIRED ───────────────────────────────────────────────────
// One sentence minimum before a fill can be recorded: the monthly review reads it, and a trade
// with no stated reason cannot be reviewed against anything. "One sentence" is judged as three
// words — "buy the dip" passes, "SOFI" does not — because a stricter rule turns into a prompt
// people type "asdf asdf asdf" into, and a looser one lets a ticker through as its own thesis.
export const THESIS_MIN_WORDS = 3;
export function thesisOk(thesis) {
  const words = String(thesis || '').trim().split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w));
  return words.length >= THESIS_MIN_WORDS;
}

// Rows sorted into the four tabs, each in the order that tab reads best: watching and open in
// the caller's order (they sort those themselves), closed and archived most recent close first.
export function byState(rows = [], { now = Date.now() } = {}) {
  const out = { WATCHING: [], OPEN: [], CLOSED: [], ARCHIVED: [] };
  for (const r of rows) out[stateOf(r, { now })].push(r);
  const byClose = (a, b) => String(b?.derived?.lastDate || '').localeCompare(String(a?.derived?.lastDate || ''));
  out.CLOSED.sort(byClose);
  out.ARCHIVED.sort(byClose);
  return out;
}

// Hours a closed row has left before it archives itself; null when that does not apply.
export function hoursToArchive(row, { now = Date.now() } = {}) {
  if (stateOf(row, { now }) !== 'CLOSED' || row?.archived === false) return null;
  const t = Date.parse(String(row?.closedAt || ''));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, +((ARCHIVE_AFTER_MS - (now - t)) / 3600000).toFixed(1));
}
