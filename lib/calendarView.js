// lib/calendarView.js — the Calendar tab's weeks (Markets › Calendar).
//
// The calendar used to be reachable only inside the Daily Overview's folded reference data, and
// only ten days ahead — the window the pre-reads use. A terminal keeps it one keystroke away and
// further out. This lays the ONE hand-kept calendar (lib/calendar.js eventsBetween — the same
// events the pre-reads and the sizer's catalyst window read) into weeks, adds the rows only the
// live feed knows (Treasury auctions, from /api/playbook), and says where the hand-kept list ends
// so an empty week is never mistaken for a quiet one.
import cal from '../data/calendar.json' with { type: 'json' };
import { eventsBetween } from './calendar.js';

export const CAL_TAB_BACK_DAYS = 2;    // the last two days, greyed as reported
export const CAL_TAB_AHEAD_DAYS = 42;  // six weeks out
export const REGIONS = Object.freeze(['US', 'ASIA', 'EU']);

const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = (iso) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const normKey = (e) => `${e.date}|${String(e.title || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim().toLowerCase()}`;

// The last date anyone has entered into data/calendar.json. Past it, only the recurring rules
// (weekly claims) and feed rows appear — the tab says so instead of showing a calm month.
export const LAST_ENTERED = cal.reduce((m, e) => (e.date > m ? e.date : m), '');

// "Asia/Shanghai" → "Shanghai". The event's own local time is shown as published; converting it
// would invent a precision the hand-kept entry does not have (some carry no time at all).
export const tzCity = (tz) => (tz ? String(tz).split('/').pop().replace(/_/g, ' ') : null);

// Days from `today` to an event date: 0 today, 1 tomorrow, negative in the past.
export const daysUntil = (date, today) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);

export function calendarWeeks({ today, extra = [], region = 'ALL', majorOnly = false, back = CAL_TAB_BACK_DAYS, ahead = CAL_TAB_AHEAD_DAYS } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today || '')) return { weeks: [], from: null, to: null, lastEntered: LAST_ENTERED, beyondEntered: false, count: 0 };
  const from = addDays(today, -back), to = addDays(today, ahead);
  const base = eventsBetween(from, to);
  const seen = new Set(base.map(normKey));
  const fed = (Array.isArray(extra) ? extra : []).filter(e => {
    if (!(e?.date >= from && e.date <= to && e.title) || seen.has(normKey(e))) return false;
    seen.add(normKey(e));
    return true;
  });
  const R = String(region || 'ALL').toUpperCase();
  const keep = (e) => (R === 'ALL' || e.region === R || e.scope === 'global') && (!majorOnly || Number(e.tier) === 1);
  const rows = [...base, ...fed].filter(keep)
    .map(e => ({ ...e, reported: e.date < today, days: daysUntil(e.date, today) }))
    .sort((a, b) => a.date.localeCompare(b.date) || (Number(a.tier) || 9) - (Number(b.tier) || 9) || String(a.title).localeCompare(String(b.title)));
  const weeks = new Map();
  for (const e of rows) {
    const m = mondayOf(e.date);
    if (!weeks.has(m)) weeks.set(m, new Map());
    const days = weeks.get(m);
    days.set(e.date, [...(days.get(e.date) || []), e]);
  }
  return {
    from, to, lastEntered: LAST_ENTERED, beyondEntered: !!LAST_ENTERED && to > LAST_ENTERED, count: rows.length,
    weeks: [...weeks.entries()].map(([monday, days]) => ({
      monday, current: monday === mondayOf(today),
      days: [...days.entries()].map(([date, events]) => ({ date, events })),
    })),
  };
}
