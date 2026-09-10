// lib/vintage.js — one rule for "is this input late", applied to every gate rather than one.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// The HY OAS gate carries a caveat when its print is late: "HY OAS has not printed since
// 2026-09-08 (2 business days) — the credit gate is reading a stale observation." It is the right
// sentence and it was the ONLY one. Every other daily FRED series on this board — the 2-year, the
// 10-year breakeven, the 5y5y forward, the 10-year real yield, the ACM term premium — reaches a
// decision function with no vintage attached at all, and each of them can be exactly as late for
// exactly the same reason.
//
// The consequence is not hypothetical. The debasement read composes gold and BTC, which are live
// ticks, with the real yield and the breakeven, which are end-of-day FRED prints; on a morning
// when FRED has not published, that classifier is comparing this hour against the day before
// yesterday and calling the difference a regime.
//
// So the rule lives here once, and every gate takes it:
//
//   LATE IS RELATIVE TO THE SERIES' OWN SCHEDULE, NOT TO TODAY. FRED publishes the prior business
//   day during the US morning, so a two-business-day-old print is ordinary before the publish hour
//   and late after it. That hour-awareness is already in lib/read.js's expectedLagBizDays and is
//   imported rather than restated — a second copy is a second thing to keep in step.
//
//   A LIVE INPUT HAS NOTHING TO AGE. Fields carrying `live: true` (see lib/liveRates.js) are
//   today's number by construction and are skipped, not excused.
import { observationAge } from './gates.js';
import { expectedLagBizDays } from './read.js';

// The gates that reach a decision function on this board, with the name a reader would recognise
// and the sentence-fragment that says what it is FOR. The fragment is the difference between
// "T10YIE is 2 days old" and "the inflation-expectations leg of the debasement read is 2 days old".
// ── NOT EVERY SERIES IS A DAILY SERIES ───────────────────────────────────────
// Caught on the live board an hour after this shipped: the ACM term premium read "late" at four
// business days and pushed the confidence grade to `low`, on a completely ordinary morning. It is
// a New York Fed model estimate and it does not publish daily; judging it by FRED's daily
// schedule flags it most days, and a warning that is always on is not a warning — which is the
// exact failure this file's neighbour in lib/read.js documents about the prior-US-close caveat.
//
// A gate listed here is judged against its OWN tolerance in business days; everything else takes
// the hour-aware daily rule.
export const GATE_LAG_BIZ_DAYS = Object.freeze({
  termPremium: 6,   // ACM 10Y term premium — a model estimate on its own release cadence
});

export const GATE_ROLE = Object.freeze({
  oas: 'the credit gate',
  us2y: 'the front end of the curve',
  us5y: 'the 5-year leg of the 5s30s slope',
  us10y: 'the 10-year leg of the curve',
  us30y: 'the long end',
  realYield: 'the real-yield leg of the debasement read',
  breakeven: 'the inflation-expectations leg of the debasement read',
  fwdBreakeven: 'the 5y5y forward leg of the debasement read',
  termPremium: 'the term-premium leg of the regime classifier',
});

// One field's vintage, or null when there is nothing to judge.
export function fieldVintage(field, key, now = new Date()) {
  if (!field) return null;
  // Live beats dated: lib/liveRates.js has already replaced the value with today's.
  if (field.live === true) {
    return { key, live: true, late: false, obsDate: field.date ?? null, bizDays: 0,
             role: GATE_ROLE[key] || key, label: field.liveAsOf ? `live ${field.liveAsOf}` : 'live' };
  }
  const date = field.date || field.obsDate || null;
  if (!date || field.value == null) return null;
  const age = observationAge(date, now);
  if (!age?.available) return null;
  const tolerance = GATE_LAG_BIZ_DAYS[key] ?? expectedLagBizDays(now);
  const late = age.bizDays > tolerance;
  return {
    key, live: false, late, tolerance, obsDate: date, bizDays: age.bizDays, calendarDays: age.calendarDays,
    role: GATE_ROLE[key] || key,
    label: `obs ${date}`,
    note: late
      ? `${field.name || key} has not printed since ${date} (${age.bizDays} business days) — ${GATE_ROLE[key] || key} is reading a stale observation`
      : null,
  };
}

// Every gate on the board, in one pass. `macro` is the object lib/quotes.js returns.
export function gateVintages(macro = {}, now = new Date()) {
  const out = [];
  for (const key of Object.keys(GATE_ROLE)) {
    const v = fieldVintage(macro[key], key, now);
    if (v) out.push(v);
  }
  return out;
}

// ── THE CAVEATS, DEDUPLICATED AND CAPPED ─────────────────────────────────────
// Confidence is graded by COUNTING caveats, so a day on which FRED publishes nothing would have
// pushed six separate lines into the list and driven every brief to "low" for one cause. Late
// gates are ONE finding with a list attached — which is also how a reader holds it.
export const CAVEAT_CAP = 3;   // names listed before the line switches to a count

export function staleGateCaveat(vintages = []) {
  const late = vintages.filter(v => v.late);
  if (!late.length) return null;
  // Oldest first: the worst one is the one that decides how much to discount the rest.
  const sorted = [...late].sort((a, b) => b.bizDays - a.bizDays);
  const worst = sorted[0];
  if (sorted.length === 1) return worst.note;
  const names = sorted.slice(0, CAVEAT_CAP).map(v => `${v.key} (${v.bizDays}d)`);
  const rest = sorted.length - names.length;
  return `${sorted.length} gates are reading stale observations — ${names.join(', ')}`
    + `${rest > 0 ? ` and ${rest} more` : ''}; the oldest is ${worst.obsDate}`;
}

// ── COMPOSING A LIVE TICK WITH AN END-OF-DAY PRINT ───────────────────────────
// The debasement read's own failure mode, and the one lib/derived.js exists for one layer down: a
// classifier whose inputs come from different days produces a statement about the release calendar
// rather than about the market. Here the mismatch is structural rather than accidental — gold and
// BTC tick all day and FRED does not — so it is DISCLOSED rather than blocked: refusing to render
// the read would lose more than it protects, and rendering it silently is what was happening.
export function mixedVintageNote(liveKeys = [], vintages = [], now = new Date()) {
  const dated = vintages.filter(v => !v.live && v.obsDate);
  if (!liveKeys.length || !dated.length) return null;
  const oldest = [...dated].sort((a, b) => b.bizDays - a.bizDays)[0];
  if (!(oldest.bizDays >= 1)) return null;
  const today = now.toISOString().slice(0, 10);
  return `${liveKeys.join(' and ')} are live ticks; ${oldest.key} is ${oldest.obsDate}`
    + `${oldest.obsDate === today ? '' : ` (${oldest.bizDays} business day${oldest.bizDays === 1 ? '' : 's'} back)`}`
    + ' — the comparison spans two sessions, which is what an end-of-day series and a live tape always do';
}
