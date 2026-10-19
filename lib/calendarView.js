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
import { mergeAuto } from './calendarAuto.js';

export const CAL_TAB_BACK_DAYS = 2;    // the last two days, greyed as reported
// At least a quarter out: the rest of this month and the three whole months after it (18 Oct →
// 31 Jan), so a quarter-end print or a January meeting is on the page well before it arrives.
export const CAL_TAB_MONTHS_AHEAD = 3;
export const REGIONS = Object.freeze(['US', 'ASIA', 'EU']);

const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = (iso) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const monthEnd = (iso, plus) => { const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + plus + 1, 0); return d.toISOString().slice(0, 10); };
const monthsIn = (from, to) => { const out = []; for (let m = from.slice(0, 7); m <= to.slice(0, 7);) { out.push(m); const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); m = d.toISOString().slice(0, 7); } return out; };
const normKey = (e) => `${e.date}|${String(e.title || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim().toLowerCase()}`;

// The last date anyone has entered into data/calendar.json. Past it, only the recurring rules
// (weekly claims) and feed rows appear — the tab says so instead of showing a calm month.
export const LAST_ENTERED = cal.reduce((m, e) => (e.date > m ? e.date : m), '');

// "Asia/Shanghai" → "Shanghai". The event's own local time is shown as published; converting it
// would invent a precision the hand-kept entry does not have (some carry no time at all).
export const tzCity = (tz) => (tz ? String(tz).split('/').pop().replace(/_/g, ' ') : null);

// Days from `today` to an event date: 0 today, 1 tomorrow, negative in the past.
export const daysUntil = (date, today) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);

// Months, each holding its weeks (Monday-keyed), each holding its days. A week that straddles two
// months is shown under each month for its own days, so every date sits under the month it is in.
export function calendarMonths({ today, extra = [], region = 'ALL', majorOnly = false, back = CAL_TAB_BACK_DAYS, monthsAhead = CAL_TAB_MONTHS_AHEAD } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today || '')) return { months: [], from: null, to: null, lastEntered: LAST_ENTERED, beyondEntered: false, count: 0 };
  const from = addDays(today, -back), to = monthEnd(today, monthsAhead);
  const base = eventsBetween(from, to);
  const seen = new Set(base.map(normKey));
  const inWin = (Array.isArray(extra) ? extra : []).filter(e => e?.date >= from && e.date <= to && e.title);
  // Automatic rows (lib/calendarAuto.js) give way to a hand-kept row of the same kind on the same day.
  const autoRows = mergeAuto(base, inWin.filter(e => e.auto));
  const fed = [...inWin.filter(e => !e.auto), ...autoRows].filter(e => {
    if (seen.has(normKey(e))) return false;
    seen.add(normKey(e));
    return true;
  });
  const R = String(region || 'ALL').toUpperCase();
  const keep = (e) => (R === 'ALL' || e.region === R || e.scope === 'global') && (!majorOnly || Number(e.tier) === 1);
  const rows = [...base, ...fed].filter(keep)
    .map(e => ({ ...e, reported: e.date < today, days: daysUntil(e.date, today) }))
    .sort((a, b) => a.date.localeCompare(b.date) || (Number(a.tier) || 9) - (Number(b.tier) || 9) || String(a.title).localeCompare(String(b.title)));
  const months = new Map();
  for (const e of rows) {
    const mo = e.date.slice(0, 7), wk = mondayOf(e.date);
    if (!months.has(mo)) months.set(mo, new Map());
    const weeks = months.get(mo);
    if (!weeks.has(wk)) weeks.set(wk, new Map());
    const days = weeks.get(wk);
    days.set(e.date, [...(days.get(e.date) || []), e]);
  }
  const thisWeek = mondayOf(today);
  return {
    from, to, lastEntered: LAST_ENTERED, beyondEntered: !!LAST_ENTERED && to > LAST_ENTERED, count: rows.length,
    // Every month in the window is listed, an empty one too: an empty month reads as "nothing
    // entered yet", which is the thing to know, rather than vanishing.
    months: monthsIn(from, to).map(month => [month, months.get(month) || new Map()]).map(([month, weeks]) => {
      const ws = [...weeks.entries()].map(([monday, days]) => ({
        monday, current: monday === thisWeek,
        days: [...days.entries()].map(([date, events]) => ({ date, events })),
      }));
      const evs = ws.flatMap(w => w.days.flatMap(d => d.events));
      return { month, count: evs.length, major: evs.filter(e => Number(e.tier) === 1).length,
               // Past the last hand-kept entry, a month shows only the weekly rules and feed rows.
               partial: !!LAST_ENTERED && month > LAST_ENTERED.slice(0, 7), weeks: ws };
    }),
  };
}
