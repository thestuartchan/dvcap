// calendar.js — the global macro calendar.
// You maintain data/calendar.json monthly (hand-edited). This module reads it,
// returns the full month for the dashboard view, and auto-highlights the current week.

import cal from '../../data/calendar.json' with { type: 'json' };

function startOfWeek(d) { // Monday
  const x = new Date(d); const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x;
}

export function monthView(year, month) {
  // month: 1-12. Returns all events in that month, sorted.
  return cal
    .filter(e => { const d = new Date(e.date); return d.getFullYear() === year && d.getMonth() + 1 === month; })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function weekHighlights(ref = new Date(), region = null) {
  // Events from this Monday through Sunday — what the Pre-Read surfaces.
  // When a region is passed, keep only what's relevant to it: events tagged for that
  // region PLUS anything marked scope:"global" (Fed/US-macro that moves every region —
  // the master gate in the framework). Other regions' local events drop off.
  const start = startOfWeek(ref);
  const end = new Date(start); end.setDate(end.getDate() + 7);
  const R = region ? region.toUpperCase() : null;
  return cal
    .filter(e => { const d = new Date(e.date); return d >= start && d < end; })
    .filter(e => !R || e.region === R || e.scope === 'global')
    .sort((a, b) => a.date.localeCompare(b.date));
}
