// yieldcurve.js — the un-inversion window, computed from dates instead of asserted.
//
// The bug this replaces: the card's signal was a pure LEVEL test (`spread < 0.5` →
// "Danger Window / Just re-normalized … This is the risk zone"), with a TIME claim attached to
// it. Nothing anywhere computed when the curve actually un-inverted, so the card said "just
// re-normalized" for as long as the spread stayed under 0.5 — which by August 2026 meant it
// had been saying "just" for nearly two years, and was pointing at a historical risk window
// that closed around August 2025.
//
// The historical regularity is real: recessions have tended to arrive 4–11 months AFTER the
// curve un-inverts, not while it is inverted. But that is a claim about ELAPSED TIME since a
// specific event, and it can only be evaluated by locating the event. Being inside the window
// and being past it are opposite readings, and a level test cannot tell them apart.
export const WINDOW_START_MONTHS = 4;
export const WINDOW_END_MONTHS = 11;
export const NORMAL_SPREAD = 1.0;      // above this the curve is fully normal

// History rows are {d:"Jan'22", iso:"2022-01-03", v:0.78}. iso was added later, so fall back
// to the display label for payloads cached before that.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function rowDate(row) {
  if (!row) return null;
  if (row.iso && /^\d{4}-\d{2}-\d{2}$/.test(row.iso)) return row.iso;
  const m = /^([A-Za-z]{3})'(\d{2})$/.exec(String(row.d || ''));
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  return `20${m[2]}-${String(mi + 1).padStart(2, '0')}-01`;
}

export function monthsBetween(fromISO, toISO) {
  if (!fromISO || !toISO) return null;
  const [fy, fm, fd] = fromISO.split('-').map(Number);
  const [ty, tm, td] = toISO.split('-').map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;              // not a full month yet
  return months;
}

// The last SUSTAINED un-inversion: the final negative→non-negative crossing with no negative
// print after it. The 2024 re-inversions matter — dating the window from the first brief
// crossing would start the clock months early, and from the last dip months late.
export function lastUnInversion(history = []) {
  const rows = (history || []).filter(r => r && r.v != null);
  if (rows.length < 2) return { found: false, reason: 'history too short to locate a crossing' };

  const lastNegative = rows.reduce((acc, r, i) => (r.v < 0 ? i : acc), -1);
  if (lastNegative === -1) {
    // Never inverted within the window we hold — say so rather than dating it from row 0.
    return { found: false, stillInverted: false, reason: 'no inversion within the loaded history' };
  }
  if (lastNegative === rows.length - 1) {
    return { found: false, stillInverted: true, reason: 'curve is currently inverted' };
  }
  const row = rows[lastNegative + 1];
  return { found: true, stillInverted: false, row, date: rowDate(row), label: row.d, value: row.v };
}

// Where we are relative to the historical 4–11 month window.
export function unInversionPhase(history = [], asOfISO = null) {
  const asOf = asOfISO || new Date().toISOString().slice(0, 10);
  const un = lastUnInversion(history);

  if (un.stillInverted) {
    return { phase: 'INVERTED', monthsSince: null, unInvertedOn: null,
      note: 'Curve is inverted. The historical 4–11 month clock starts when it un-inverts, not now.' };
  }
  if (!un.found || !un.date) {
    return { phase: 'UNKNOWN', monthsSince: null, unInvertedOn: null,
      note: `Un-inversion date not locatable — ${un.reason}. No window claim is made.` };
  }

  const monthsSince = monthsBetween(un.date, asOf);
  // Label and date are the same string when the history carries no display label — don't
  // print "2024-10-01 (2024-10-01)".
  const on = un.label && un.label !== un.date ? `${un.label}, ${un.date}` : un.date;
  if (monthsSince == null) {
    return { phase: 'UNKNOWN', monthsSince: null, unInvertedOn: un.date, note: 'Cannot compute elapsed months.' };
  }
  if (monthsSince < WINDOW_START_MONTHS) {
    return { phase: 'PRE_WINDOW', monthsSince, unInvertedOn: un.date,
      note: `Un-inverted ${monthsSince} month${monthsSince === 1 ? '' : 's'} ago (${on}). The historical ${WINDOW_START_MONTHS}–${WINDOW_END_MONTHS} month window has not opened yet.` };
  }
  if (monthsSince <= WINDOW_END_MONTHS) {
    return { phase: 'IN_WINDOW', monthsSince, unInvertedOn: un.date,
      note: `Un-inverted ${monthsSince} months ago (${on}) — inside the historical ${WINDOW_START_MONTHS}–${WINDOW_END_MONTHS} month window in which recessions have tended to arrive.` };
  }
  return { phase: 'ELAPSED', monthsSince, unInvertedOn: un.date,
    monthsPastWindow: monthsSince - WINDOW_END_MONTHS,
    note: `Un-inverted ${monthsSince} months ago (${on}). The historical ${WINDOW_START_MONTHS}–${WINDOW_END_MONTHS} month window closed roughly ${monthsSince - WINDOW_END_MONTHS} months ago without a recession, so the un-inversion signal has PASSED rather than being pending. A sub-${NORMAL_SPREAD.toFixed(1)}% spread still means the curve is not fully normal, but that is a different claim.` };
}

// The status the curve earns, given BOTH level and elapsed time.
export function yieldCurveStatus(spread, phase) {
  if (spread == null) return { state: 'WATCH', label: 'No print' };
  if (spread < -0.5) return { state: 'DANGER', label: 'Deep inversion' };
  if (spread < 0)    return { state: 'DANGER', label: 'Inverted' };

  // Positive but not normal. Which of these it is depends entirely on elapsed time.
  if (spread < NORMAL_SPREAD) {
    if (phase?.phase === 'IN_WINDOW') return { state: 'ELEVATED', label: 'Re-steepening — in window' };
    if (phase?.phase === 'PRE_WINDOW') return { state: 'WATCH', label: 'Re-steepening — pre-window' };
    if (phase?.phase === 'ELAPSED')   return { state: 'BENIGN', label: 'Re-steepening — window passed' };
    return { state: 'WATCH', label: 'Re-steepening' };
  }
  return { state: 'BENIGN', label: 'Normal' };
}
