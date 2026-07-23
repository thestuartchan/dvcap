// calendar.js — the global macro calendar.
// You maintain data/calendar.json monthly (hand-edited). This module reads it,
// returns the full month for the dashboard view, and auto-highlights the current week.

import cal from '../data/calendar.json' with { type: 'json' };
import recurringRules from '../data/recurring.json' with { type: 'json' };
import { localDateStr } from './sessions.js';

export function monthView(year, month) {
  // month: 1-12. Returns all events in that month, sorted.
  return cal
    .filter(e => { const d = new Date(e.date); return d.getFullYear() === year && d.getMonth() + 1 === month; })
    .sort((a, b) => a.date.localeCompare(b.date));
}

const CAL_HORIZON_DAYS = 10; // "week ahead" — wide enough to surface next week's FOMC etc.
const CAL_LOOKBACK_DAYS = 2;  // also surface events reported in the past 48h (greyed, tagged "reported")

// Expand recurring rules (data/recurring.json) into concrete dated events within the
// window, so predictable weekly macro (e.g. jobless claims every Thursday) self-populates
// instead of being hand-added each week. weekday: 0=Sun .. 6=Sat.
function expandRecurring(todayStr, horizonStr) {
  const out = [];
  const end = new Date(horizonStr + 'T00:00:00Z');
  for (const rule of recurringRules) {
    if (rule.freq !== 'weekly') continue;
    for (let d = new Date(todayStr + 'T00:00:00Z'); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCDay() === rule.weekday) {
        out.push({ date: d.toISOString().slice(0, 10), title: rule.title, region: rule.region,
          tier: rule.tier ?? 2, scope: rule.scope, recurring: true });
      }
    }
  }
  return out;
}

export function weekHighlights(ref = new Date(), region = null, tz = null) {
  // Events from 48h AGO (region-local) through the next CAL_HORIZON_DAYS. Past-window
  // events are tagged reported:true so the UI can grey them; upcoming events are untouched.
  // Region filter keeps that region's events PLUS scope:"global". Static hand-authored events
  // + expanded recurring rules; a hand-authored event on a date wins over a generic recurring
  // one (dedup ignores parenthetical suffixes like "(fcst 212K)" vs "(weekly)").
  const todayStr = tz ? localDateStr(tz, ref) : ref.toISOString().slice(0, 10);
  const horizon = new Date(todayStr + 'T00:00:00Z');
  horizon.setUTCDate(horizon.getUTCDate() + CAL_HORIZON_DAYS);
  const horizonStr = horizon.toISOString().slice(0, 10);
  const back = new Date(todayStr + 'T00:00:00Z');
  back.setUTCDate(back.getUTCDate() - CAL_LOOKBACK_DAYS);
  const lookbackStr = back.toISOString().slice(0, 10);
  const R = region ? region.toUpperCase() : null;
  const keep = e => !R || e.region === R || e.scope === 'global';
  const normKey = e => e.date + '|' + e.title.replace(/\s*\([^)]*\)\s*/g, ' ').trim().toLowerCase();
  const tag = e => ({ ...e, reported: e.date < todayStr });

  const staticEvents = cal.filter(e => e.date >= lookbackStr && e.date < horizonStr).filter(keep).map(tag);
  const seen = new Set(staticEvents.map(normKey));
  const recurring = expandRecurring(lookbackStr, horizonStr).filter(keep).filter(e => !seen.has(normKey(e))).map(tag);
  return [...staticEvents, ...recurring]
    .sort((a, b) => a.date.localeCompare(b.date) || (a.title < b.title ? -1 : 1));
}
