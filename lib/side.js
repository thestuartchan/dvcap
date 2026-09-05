// lib/side.js — the single source of the long/short convention.
//
// Direction used to be an assumption rather than a field. The console modelled long spot and swing
// holds only, and said so honestly in three places — but "long-only" was enforced by nothing, so a
// short entered by hand was accepted and then rendered wrong in five directions at once: a stop
// that could never trigger, a target that fired on day one, a red dot on a winning trade, and a
// "locked in +14%" label printed over the actual risk. Every one of those came from the same
// missing fact.
//
// So the convention lives in ONE place and everything that needs to know which way a position
// points asks here. The two facts callers need are the normalised side and its sign; nothing
// should be re-deriving direction from the geometry of a stop.

export const SIDES = Object.freeze(['long', 'short']);
export const DEFAULT_SIDE = 'long';

// Accepts a row, a derived position, or a bare string. ABSENT means long — every row written
// before this existed has no side field and is a long, so the migration is silent and correct.
//
// PRESENT BUT UNRECOGNISED is different, and returns null rather than quietly falling back: the
// difference between "no side recorded" and "side recorded as something we cannot read" is the
// difference between a safe default and an inverted position. Callers treat null as long so the
// behaviour never gets WORSE than it was, and say so out loud rather than acting on a guess.
export function sideOf(x) {
  const raw = (x && typeof x === 'object') ? (x.side ?? x?.derived?.side) : x;
  if (raw == null || raw === '') return DEFAULT_SIDE;
  const s = String(raw).trim().toLowerCase();
  if (s === 'long' || s === 'l' || s === 'buy') return 'long';
  if (s === 'short' || s === 's' || s === 'sell') return 'short';
  return null;
}

export const isShort = (x) => sideOf(x) === 'short';

// +1 long, -1 short. Multiply any long-shaped P&L or R calculation by this and it holds for both.
// An unreadable side signs as long, which is what the code did before it could tell the difference.
export function dirSign(x) {
  return sideOf(x) === 'short' ? -1 : 1;
}

// Which fill OPENS a position of this side, and which CLOSES it. A long opens on a buy; a short
// opens on a sell. Every average-cost and realised-P&L rule follows from this one mapping rather
// than from the words "buy" and "sell", which is why the fill engine no longer mentions them.
export function openSideFor(x) { return sideOf(x) === 'short' ? 'sell' : 'buy'; }
export function closeSideFor(x) { return sideOf(x) === 'short' ? 'buy' : 'sell'; }

export const SIDE_LABEL = Object.freeze({ long: 'LONG', short: 'SHORT' });

// ─── DOES THE GEOMETRY AGREE WITH THE DECLARED SIDE? ──────────────────────────────────────────
// Direction is now recorded, but it is typed by a human and the levels are typed by the same human
// a moment later. A row declaring LONG with its stop ABOVE entry and its target BELOW is not an
// exotic position — it is a short someone forgot to mark, and every number on it will be inverted
// while looking entirely normal. That is the failure this whole change exists to remove, so it is
// worth catching where it is created rather than trusting the label.
//
// This REPORTS, it does not correct. Overriding the declared side from the geometry would be the
// original sin in reverse — inferring direction from where a stop happens to sit. A stop can also
// legitimately sit the "wrong" side once a trade is in profit and the stop has been trailed past
// entry, which is precisely the locked-in case; so a mismatch is only asserted when the stop AND a
// target BOTH point the other way, which trailing cannot produce.
export function geometryCheck({ side, entry, stop, targets = [] } = {}) {
  const n = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
  const sd = sideOf(side), sign = dirSign(side);
  const e = n(entry), s = n(stop);
  const ts = (Array.isArray(targets) ? targets : []).map(n).filter(v => v != null);
  if (sd == null) return { ok: false, reason: `side ${JSON.stringify(side)} is not "long" or "short"` };
  if (e == null || e <= 0) return { ok: true, reason: null };            // nothing to check against
  // A stop is on the risk side when (entry − stop) × sign > 0.
  const stopWrong = s != null && (e - s) * sign < 0;
  // A target is on the reward side when (target − entry) × sign > 0.
  const targetsWrong = ts.length > 0 && ts.every(t => (t - e) * sign < 0);
  if (stopWrong && targetsWrong) {
    return { ok: false, stopWrong, targetsWrong,
      reason: `declared ${sd.toUpperCase()}, but the stop (${s}) and every target (${ts.join(', ')}) `
            + `sit on the opposite side of the entry (${e}) — this is the geometry of a `
            + `${sd === 'long' ? 'short' : 'long'}. Fix the side or the levels; the numbers on this `
            + `row are inverted until one of them changes.` };
  }
  return { ok: true, stopWrong, targetsWrong, reason: null };
}
