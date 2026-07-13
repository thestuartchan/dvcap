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

export function weekHighlights(ref = new Date()) {
  // Events from this Monday through Sunday — what the Monday Pre-Read surfaces.
  const start = startOfWeek(ref);
  const end = new Date(start); end.setDate(end.getDate() + 7);
  return cal
    .filter(e => { const d = new Date(e.date); return d >= start && d < end; })
    .sort((a, b) => a.date.localeCompare(b.date));
}
