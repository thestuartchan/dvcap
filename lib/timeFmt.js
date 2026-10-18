// lib/timeFmt.js — one way to write a time across the dashboard: Dubai first, ET in brackets.
//
//   22:00 Dubai (14:00 ET)
//
// Dubai is where the dashboard is read; ET is where most of what it reads trades. Before this,
// each tab wrote times its own way: the browser's zone with no label, the browser's zone with a
// short zone name, an exchange's local clock, or a bare HH:MM. Two of those cannot be reconciled
// with the others without knowing where the browser was. Every formatter here names both zones.

export const HOME_TZ = 'Asia/Dubai';
export const ET_TZ = 'America/New_York';

const parts = (tz, d) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(d).map(p => [p.type, p.value]));
const valid = (d) => d instanceof Date && !Number.isNaN(d.getTime());
const asDate = (x) => (x instanceof Date ? x : x == null ? null : new Date(x));

// HH:MM on a zone's wall clock.
export function clockIn(tz, d) {
  const x = asDate(d);
  if (!valid(x)) return null;
  const p = parts(tz, x);
  return `${p.hour}:${p.minute}`;
}
// YYYY-MM-DD on a zone's calendar.
export function dateIn(tz, d) {
  const x = asDate(d);
  if (!valid(x)) return null;
  const p = parts(tz, x);
  return `${p.year}-${p.month}-${p.day}`;
}

// "22:00 Dubai (14:00 ET)". With `refDate` (YYYY-MM-DD, the day the event is filed under), a
// Dubai clock that has already rolled into the next day says so: "01:00 Dubai +1d (17:00 ET)".
export function dubaiEt(d, { refDate = null } = {}) {
  const x = asDate(d);
  if (!valid(x)) return '—';
  const home = dateIn(HOME_TZ, x);
  const shift = refDate && home !== refDate ? Math.round((Date.parse(home) - Date.parse(refDate)) / 86400000) : 0;
  return `${clockIn(HOME_TZ, x)} Dubai${shift ? ` ${shift > 0 ? '+' : ''}${shift}d` : ''} (${clockIn(ET_TZ, x)} ET)`;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;

// A fetch or update stamp. Today (in Dubai) is the clock alone; any other day carries its date
// and how old it is, because a cached "14:32" reads exactly like one from two minutes ago.
export function dubaiEtStamp(d, { now = new Date() } = {}) {
  const x = asDate(d);
  if (!valid(x)) return '—';
  const day = dateIn(HOME_TZ, x), today = dateIn(HOME_TZ, now);
  if (day === today) return dubaiEt(x);
  const days = Math.round((Date.parse(today) - Date.parse(day)) / 86400000);
  return `${shortDate(day)} ${dubaiEt(x)} — ${days === 1 ? 'yesterday' : days > 1 ? `${days}d old` : 'ahead of the clock'}`;
}

// The instant a wall-clock time in a zone names: zonedInstant('2026-10-29', '14:00',
// 'America/Los_Angeles'). Two passes settle the zone's offset on that date, DST included.
export function zonedInstant(date, time, tz) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^\d{1,2}:\d{2}$/.test(String(time))) return null;
  const [h, m] = time.split(':').map(Number);
  const want = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m);
  let t = want;
  try {
    for (let i = 0; i < 2; i++) {
      const p = parts(tz, new Date(t));
      const seen = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
      t += want - seen;
    }
  } catch { return null; }
  return new Date(t);
}
