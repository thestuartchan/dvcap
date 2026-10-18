// test/calendarView.test.mjs — Markets › Calendar (lib/calendarView.js).
import { calendarWeeks, daysUntil, tzCity, LAST_ENTERED } from '../lib/calendarView.js';
import { eventsBetween } from '../lib/calendar.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

const today = '2026-10-18';   // a Sunday
const all = calendarWeeks({ today });
eq('two days back to six weeks out', [all.from, all.to], ['2026-10-16', '2026-11-29']);
eq('the same events the pre-reads read, nothing invented', all.count, eventsBetween('2026-10-16', '2026-11-29').length);
ok('weeks start on Monday, in order', all.weeks.every((w, i, a) => new Date(`${w.monday}T00:00:00Z`).getUTCDay() === 1 && (!i || a[i - 1].monday < w.monday)));
eq('the week holding today is marked', all.weeks.filter(w => w.current).map(w => w.monday), ['2026-10-12']);
const rows = all.weeks.flatMap(w => w.days.flatMap(d => d.events));
ok('past events are reported, future ones are not', rows.every(e => e.reported === (e.date < today)));
ok('every event carries its countdown', rows.every(e => e.days === daysUntil(e.date, today)));
ok('within a day, tier 1 comes first', all.weeks.every(w => w.days.every(d => d.events.every((e, i, a) => !i || (Number(a[i - 1].tier) || 9) <= (Number(e.tier) || 9)))));

// Filters.
const us = calendarWeeks({ today, region: 'US' }).weeks.flatMap(w => w.days.flatMap(d => d.events));
ok('a region keeps its own events and the global ones', us.length && us.every(e => e.region === 'US' || e.scope === 'global'));
const major = calendarWeeks({ today, majorOnly: true }).weeks.flatMap(w => w.days.flatMap(d => d.events));
ok('major only keeps tier 1', major.length && major.every(e => Number(e.tier) === 1));

// Feed rows (auctions) join, once.
const extra = [{ date: '2026-10-21', title: 'US 20Y bond auction', region: 'US', tier: 2 }, { date: '2026-10-21', title: 'US 20Y bond auction', region: 'US', tier: 2 },
  { date: '2027-03-01', title: 'Out of window', region: 'US', tier: 2 }];
const withFeed = calendarWeeks({ today, extra });
eq('a feed row inside the window is added once; one outside is not', withFeed.count - all.count, 1);

// Where the hand-kept list ends.
eq('the last entered date is read from the file', LAST_ENTERED, '2026-12-30');
eq('a window past it says so', [calendarWeeks({ today: '2026-12-01' }).beyondEntered, all.beyondEntered], [true, false]);
eq('time zone to city', [tzCity('Asia/Shanghai'), tzCity('America/New_York'), tzCity(null)], ['Shanghai', 'New York', null]);
eq('a bad date gives an empty calendar, not a crash', calendarWeeks({ today: 'soon' }).weeks, []);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
