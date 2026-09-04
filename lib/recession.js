// lib/recession.js — the recession-consensus engine.
//
// This module exists because a single weighted average over "all the recession forecasts" was
// answering a question nobody asked. Three defects, in order of how much they distorted the output:
//
//  1. HORIZON BLENDING (the one that biases direction). "Will NBER declare a recession in calendar
//     2026" and "recession within the next 12 months" are different questions. The calendar
//     contracts sit on a SHRINKING window — on 2026-06-01 they had 7 months to resolve in, by
//     2026-12-01 they have 1 — so their price must fall toward zero as the year ends even if the
//     economy is unchanged. Averaging them with rolling-12m forecasts dragged the consensus down
//     for purely calendar reasons, and that consensus feeds the regime engine and position sizing.
//     Consensus is therefore computed PER HORIZON and never across them.
//
//  2. DOUBLE-COUNTING CORRELATED SOURCES. Kalshi and Polymarket are arbitrage-linked real-money
//     markets pricing substantially the same event. Weighting them separately counted one view
//     twice. Sources are grouped into BLOCKS and a block contributes once — the same
//     effective-vs-nominal-positions doctrine lib/correlation.js applies to the equity sleeve.
//
//  3. DISCARDING DISPERSION AND DIRECTION. A point estimate of 17% hides whether the sources agree
//     (12.5 vs 22 is not consensus) and whether they are being revised up or down. Both are
//     reported alongside the level.
//
// On SCORING (sourceScore): forecast ACCURACY is not scoreable on a live dashboard — recessions are
// rare and NBER declares them 6–18 months late, so a Brier score would take years to say anything.
// What IS scoreable now is whether a source is INFORMATIVE: how much it whipsaws, whether it
// round-trips (revising up then straight back down = following the news, not leading it), and how
// long since it moved. That is the lib/recon.js doctrine — establish on evidence whether an input
// earns its weight, rather than trusting it by habit — applied to forecasters. The grade is
// DESCRIPTIVE (how it behaves), never predictive (whether it is right).

export const HORIZON = Object.freeze({ ROLLING: 'rolling12m', CALENDAR: 'calendar' });

export const HORIZON_LABEL = Object.freeze({
  [HORIZON.ROLLING]: 'Next 12 months',
  [HORIZON.CALENDAR]: 'By year-end',
});

// Classify a source's timeframe string. "12-month" → rolling; "End-2026"/"End-2027" → calendar.
// Anything qualitative ("qualitative") returns null and is excluded from every consensus.
export function horizonOf(timeframe) {
  if (!timeframe) return null;
  const t = String(timeframe).toLowerCase();
  if (/^end-\d{4}/.test(t) || /calendar/.test(t)) return HORIZON.CALENDAR;
  if (/month|rolling|year-ahead/.test(t)) return HORIZON.ROLLING;
  return null;
}

// Correlated-source blocks. Members of one block are NOT independent evidence, so the block
// contributes a single weighted view rather than one contribution per member.
export const SOURCE_BLOCKS = Object.freeze({
  'Kalshi prediction market': 'market-implied',
  'Kalshi prediction market 2027': 'market-implied',
  'Polymarket': 'market-implied',
});
export const BLOCK_LABEL = Object.freeze({ 'market-implied': 'Real-money markets (Kalshi + Polymarket)' });
export const blockOf = (name) => SOURCE_BLOCKS[name] || null;

// Months left for a calendar-year contract to resolve in, and how much of the year is gone. A
// contract with little window left is mechanically cheap — that is the caveat the panel must show.
export function calendarWindow(nowIso, year) {
  if (!nowIso || !year) return null;
  const now = Date.parse(nowIso + (nowIso.length === 10 ? 'T00:00:00Z' : ''));
  const end = Date.parse(`${year}-12-31T23:59:59Z`);
  if (!Number.isFinite(now) || !Number.isFinite(end)) return null;
  const monthsLeft = +(((end - now) / 86400000) / 30.44).toFixed(1);
  return {
    monthsLeft: Math.max(0, monthsLeft),
    fractionLeft: Math.max(0, Math.min(1, monthsLeft / 12)),
    // Under ~6 months the shrinking window is a material drag on the contract price.
    shrinking: monthsLeft < 6,
    expired: monthsLeft <= 0,
  };
}

// Consensus over ONE horizon, with correlated sources collapsed into blocks.
// rows: [{ name, prob, weight, asOf, recency, year, timeframe, archived }]
// Returns null-safe stats: value (weighted mean), lo/hi/spread (dispersion across contributing
// views), nSources (rows used) and nEffective (independent views after block collapse).
export function consensusFor(rows = [], horizon) {
  const used = rows.filter(r =>
    !r.archived && r.prob != null && Number.isFinite(r.prob) &&
    r.weight > 0 && (r.recency == null || r.recency > 0) &&
    horizonOf(r.timeframe) === horizon);
  if (!used.length) return { value: null, lo: null, hi: null, spread: null, nSources: 0, nEffective: 0, members: [], blocks: [] };

  // Collapse blocks: members of a block are averaged (weight-weighted) into ONE view carrying the
  // block's largest member weight — not the sum, which is what double-counted them before.
  const groups = new Map();
  for (const r of used) {
    const key = blockOf(r.name) || `solo:${r.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const views = [];
  for (const [key, members] of groups) {
    const wsum = members.reduce((s, m) => s + m.weight * (m.recency ?? 1), 0);
    if (wsum <= 0) continue;
    const value = members.reduce((s, m) => s + m.prob * m.weight * (m.recency ?? 1), 0) / wsum;
    const weight = Math.max(...members.map(m => m.weight * (m.recency ?? 1)));
    views.push({
      key, isBlock: key.startsWith('market-implied') || !!blockOf(members[0].name),
      label: blockOf(members[0].name) ? BLOCK_LABEL[blockOf(members[0].name)] : members[0].name,
      value: +value.toFixed(1), weight, members: members.map(m => ({ name: m.name, prob: m.prob, asOf: m.asOf })),
    });
  }
  if (!views.length) return { value: null, lo: null, hi: null, spread: null, nSources: 0, nEffective: 0, members: [], blocks: [] };

  const totW = views.reduce((s, v) => s + v.weight, 0);
  const value = views.reduce((s, v) => s + v.value * v.weight, 0) / totW;
  // Dispersion is measured across the RAW contributing rows, so a wide Kalshi/Polymarket gap still
  // shows up even though the block contributes one view to the mean.
  const probs = used.map(r => r.prob);
  const lo = Math.min(...probs), hi = Math.max(...probs);
  return {
    value: +value.toFixed(1), lo, hi, spread: +(hi - lo).toFixed(1),
    nSources: used.length, nEffective: views.length,
    // Splitting by horizon is correct but leaves each consensus resting on fewer independent
    // views. Fewer than two is a single point of failure and must be visible, not implied.
    thin: views.length < 2,
    views: views.sort((a, b) => b.weight - a.weight),
    members: used.map(r => r.name),
  };
}

// Why the calendar contracts are NOT converted to a 12-month-equivalent and folded back in.
// A constant-hazard conversion — P12 = 1 − (1 − Pcal)^(12/monthsLeft) — turns Kalshi's 22% with
// 4.2 months left into ~51%, which is not credible: it extrapolates a short-window rate across a
// year, and these contracts resolve on an NBER DECLARATION (itself lagged 6–18 months) rather than
// on onset, so the window and the event are not even the same clock. A conversion that wrong is
// worse than no conversion, so the two horizons are reported side by side and never blended.
export const NO_CONVERSION_NOTE =
  'Calendar contracts are shown separately, not converted to a 12-month equivalent: a constant-hazard '
  + 'conversion is unreliable here (these resolve on an NBER declaration, which lags onset), and a wrong '
  + 'conversion would be worse than none.';

// How wide is too wide. A spread this large means the sources are not describing the same world,
// and a point estimate drawn from them implies precision that does not exist.
export const WIDE_SPREAD_PP = 15;
export function dispersionRead(c) {
  if (!c || c.value == null) return null;
  if (c.spread == null) return { wide: false, text: 'single source — no dispersion to read' };
  if (c.spread >= WIDE_SPREAD_PP) {
    return { wide: true, text: `sources disagree by ${c.spread}pp (${c.lo}–${c.hi}%) — treat the level as a range, not a point` };
  }
  return { wide: false, text: `sources cluster within ${c.spread}pp (${c.lo}–${c.hi}%)` };
}

// NOTE: revision tracking / source scoring (lastRevision, roundTrips, sourceScore) lived here
// and was removed once lib/analystViews.js shipped. "Does this source whipsaw?" was a proxy for
// the question the view board answers directly — "is this thesis still holding, and did the
// condition the house itself flagged just fail?" One answer, in one place.

// ─── CONSENSUS VINTAGE — an age that computes itself, and a deferral that can expire ──────────
// The dashboard stamped the consensus block with a HARDCODED string, "2 months stale", sitting
// directly beside the asOf date it could have been derived from. A stamp whose entire job is to
// say how old something is, frozen at the age it happened to be the day it was typed: it would
// have gone on reading "2 months stale" a year later, and the older it got the more confidently
// wrong it became.
//
// The second half is worse. The refresh was deferred pending two releases (the July Employment
// Situation on Aug 7, the BLS benchmark revision on Aug 28). Both landed. The card went on saying
// the refresh was "deferred" — which reads as *nothing is owed* — at exactly the moment the thing
// it was waiting for arrived and the refresh became overdue. A deferral with no expiry is not a
// deferral, it is a standing excuse. Both are now derived from dates.
export function consensusVintage(base, now = new Date()) {
  const gatedOn = base?.gatedOn ?? [];
  const d = new Date(String(base?.asOf) + "T00:00:00Z");
  if (!base?.asOf || Number.isNaN(d.getTime())) {
    // Unknown is never green: a vintage we cannot date is reported as undatable, not as fresh.
    return { ...base, label: "vintage unknown", monthsStale: null, staleNote: "age unknown",
             refreshDue: true, deferredUntil: null,
             dueNote: "the consensus inputs carry no as-of date — treat them as unverified" };
  }
  const months = Math.floor((now - d) / (30.44 * 864e5));
  const pending = gatedOn.filter(g => new Date(g.date + "T00:00:00Z") > now);
  const last = gatedOn[gatedOn.length - 1] ?? null;
  return {
    ...base,
    label: `as of ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCFullYear()}`,
    monthsStale: months,
    staleNote: months < 1 ? "current" : `${months} month${months === 1 ? "" : "s"} stale`,
    // True once every gating release has landed — at which point the refresh is owed, not deferred.
    refreshDue: pending.length === 0,
    deferredUntil: pending.length ? pending.map(g => `${g.date} (${g.label})`).join(" and ") : null,
    dueNote: pending.length
      ? `refresh deferred until ${pending.map(g => g.label).join(" and ")}`
      : last
        ? `refresh is DUE — ${last.label} landed ${last.date} and the inputs have not been rebuilt since`
        : "refresh is DUE — no release is being waited on",
  };
}
