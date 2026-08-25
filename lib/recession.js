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

// ── Revision tracking / source scoring ──────────────────────────────────────
// revisions: [{ asOf, prob, note }] oldest → newest, a source's published history.

// Direction of the most recent revision, in percentage points.
export function lastRevision(revisions = []) {
  if (!Array.isArray(revisions) || revisions.length < 2) return null;
  const a = revisions[revisions.length - 2], b = revisions[revisions.length - 1];
  const delta = +(b.prob - a.prob).toFixed(1);
  return { delta, from: a.prob, to: b.prob, asOf: b.asOf ?? null, dir: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat', note: b.note ?? null };
}

// Count direction reversals — a source that goes up then straight back down round-tripped, which
// means it was reacting to news rather than anticipating it.
export function roundTrips(revisions = []) {
  if (!Array.isArray(revisions) || revisions.length < 3) return 0;
  let trips = 0, prevDir = 0;
  for (let i = 1; i < revisions.length; i++) {
    const d = Math.sign(revisions[i].prob - revisions[i - 1].prob);
    if (d === 0) continue;
    if (prevDir !== 0 && d !== prevDir) trips++;
    prevDir = d;
  }
  return trips;
}

// Descriptive behaviour grade. NOT an accuracy score — see the module header. Reports how much a
// source moves and whether it reverses, so a whipsawing input can be demoted on evidence.
export function sourceScore(revisions = [], nowIso = null) {
  if (!Array.isArray(revisions) || revisions.length < 2) {
    return { grade: 'insufficient history', trips: 0, avgMove: null, netDrift: null, last: null, note: 'fewer than two published prints — nothing to score yet' };
  }
  const moves = [];
  for (let i = 1; i < revisions.length; i++) moves.push(Math.abs(revisions[i].prob - revisions[i - 1].prob));
  const avgMove = +(moves.reduce((s, m) => s + m, 0) / moves.length).toFixed(1);
  const netDrift = +(revisions[revisions.length - 1].prob - revisions[0].prob).toFixed(1);
  const trips = roundTrips(revisions);
  const last = lastRevision(revisions);

  let daysSince = null;
  const lastAsOf = revisions[revisions.length - 1]?.asOf;
  if (nowIso && lastAsOf) {
    const d = Math.round((Date.parse(nowIso) - Date.parse(lastAsOf)) / 86400000);
    if (Number.isFinite(d)) daysSince = d;
  }

  // Grade: reversals dominate — a round-tripping forecaster adds no forward information.
  let grade, note;
  if (trips >= 1 && avgMove >= 7) {
    grade = 'reactive';
    note = `${trips} direction reversal${trips > 1 ? 's' : ''} averaging ${avgMove}pp — moves with the news rather than ahead of it; weight its level accordingly`;
  } else if (avgMove >= 7) {
    grade = 'volatile';
    note = `large revisions (${avgMove}pp average) but no reversal — directional, not whipsawing`;
  } else if (trips >= 1) {
    grade = 'choppy';
    note = `${trips} reversal${trips > 1 ? 's' : ''}, but small moves (${avgMove}pp average)`;
  } else {
    grade = 'steady';
    note = `no reversals, ${avgMove}pp average revision — a stable view`;
  }
  return { grade, trips, avgMove, netDrift, last, daysSince, note };
}
