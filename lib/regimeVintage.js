// regimeVintage.js — how much of the consensus behind the regime is still alive.
//
// Why this exists: the four-state regime is derived from a table of hand-kept and market
// recession-probability sources. Each source's weight already decays linearly to zero over 180
// days (App.jsx recencyFactor), so the ENGINE degrades honestly — but nothing downstream knew.
// On 2026-09-14 the consensus vintage read "2.5 months stale, REFRESH DUE" on three footnotes,
// while the sizer applied the regime multiplier at full confidence, the action card let regime
// conviction argue for Stage 2, and the header printed the regime label with no age. The
// hand-kept Korea flows, by contrast, are SUPPRESSED after two business days.
//
// This is the one number that fixes that asymmetry: `alive` is the share of the consensus's
// nominal weight still standing after decay. It grades the regime and yields the haircut the
// sizer applies and the conviction the action card is allowed to claim. Warn, never block: a
// decayed consensus makes the suggestion smaller and says why; it does not refuse.
import { UNCERTAINTY_HAIRCUT } from './sizing.js';

export const CONSENSUS_DECAYED_BELOW = 0.75;   // less than this share alive → the regime is DECAYED
export const CONSENSUS_EXPIRED_BELOW = 0.25;   // less than this → EXPIRED: the regime rests on almost nothing

// Share of nominal weight still alive, over the rows the engine actually consumes.
// rows: [{ weight, recency, prob, archived }] — the shape computeWeightedRecessionProb builds.
export function consensusAlive(rows = []) {
  const used = rows.filter(r => r && !r.archived && r.prob != null && Number.isFinite(r.prob) && r.weight > 0);
  const nominal = used.reduce((s, r) => s + r.weight, 0);
  if (nominal <= 0) return { alive: null, nominal: 0, live: 0, decayed: [] };
  const live = used.reduce((s, r) => s + r.weight * (r.recency ?? 1), 0);
  const decayed = used.filter(r => (r.recency ?? 1) < 0.999).map(r => ({ name: r.name, asOf: r.asOf ?? null, recency: +(r.recency ?? 1).toFixed(3) }));
  return { alive: +(live / nominal).toFixed(3), nominal: +nominal.toFixed(3), live: +live.toFixed(3), decayed, nSources: used.length };
}

// The grade, the haircut and the conviction, from `alive` and the table's own vintage stamp.
// `refreshDue` is consensusVintage().refreshDue — every gating release has landed and the inputs
// have not been rebuilt — which is a reason to call the regime decayed even when the rows' own
// dates have not run down yet.
export function regimeVintage({ alive = null, decayed = [], nSources = 0, refreshDue = false, staleNote = null } = {}) {
  let grade;
  if (alive == null) grade = 'unknown';
  else if (alive < CONSENSUS_EXPIRED_BELOW) grade = 'expired';
  else if (alive < CONSENSUS_DECAYED_BELOW || refreshDue) grade = 'decayed';
  else grade = 'fresh';
  const haircut = grade === 'fresh' ? 1
    : grade === 'decayed' ? Math.max(UNCERTAINTY_HAIRCUT, +Math.min(1, alive).toFixed(2))
    : UNCERTAINTY_HAIRCUT;
  const pct = alive == null ? null : Math.round(alive * 100);
  const parts = [];
  if (pct != null) parts.push(`consensus ${pct}% alive`);
  if (decayed.length) parts.push(`${decayed.length} of ${nSources} sources decayed`);
  if (refreshDue) parts.push(staleNote ? `refresh due, inputs ${staleNote}` : 'refresh due');
  if (alive == null) parts.push('no dated consensus');
  return {
    grade, alive, pct, haircut,
    // Whether the regime's probability may ARGUE for anything on its own (the action card's
    // Stage 2 line, the posture guard). A decayed consensus still names the regime; it does not
    // get to make a case with it.
    conviction: grade === 'fresh',
    note: parts.join(' · '),
    decayed,
  };
}
