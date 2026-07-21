// calendar.js — the global macro calendar.
// You maintain data/calendar.json monthly (hand-edited). This module reads it,
// returns the full month for the dashboard view, and auto-highlights the current week.

import cal from '../data/calendar.json' with { type: 'json' };
import { localDateStr } from './sessions.js';

export function monthView(year, month) {
  // month: 1-12. Returns all events in that month, sorted.
  return cal
    .filter(e => { const d = new Date(e.date); return d.getFullYear() === year && d.getMonth() + 1 === month; })
    .sort((a, b) => a.date.localeCompare(b.date));
}

const CAL_HORIZON_DAYS = 10; // "week ahead" — wide enough to surface next week's FOMC etc.

export function weekHighlights(ref = new Date(), region = null, tz = null) {
  // Upcoming events: from TODAY (in the region's local timezone, so nothing already past
  // for that region shows) through the next CAL_HORIZON_DAYS. When a region is passed, keep
  // only what's relevant — events tagged for that region PLUS anything scope:"global"
  // (Fed/US-macro that moves every region). Other regions' local events drop off.
  const todayStr = tz ? localDateStr(tz, ref) : ref.toISOString().slice(0, 10);
  const horizon = new Date(todayStr + 'T00:00:00Z');
  horizon.setUTCDate(horizon.getUTCDate() + CAL_HORIZON_DAYS);
  const horizonStr = horizon.toISOString().slice(0, 10);
  const R = region ? region.toUpperCase() : null;
  return cal
    .filter(e => e.date >= todayStr && e.date < horizonStr)   // today .. +7d; past dropped
    .filter(e => !R || e.region === R || e.scope === 'global')
    .sort((a, b) => a.date.localeCompare(b.date));
}
