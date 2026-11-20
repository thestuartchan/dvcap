// lib/ismCalendar.js — the calendar's ISM month, validated before it can stand in for the release.
import { validateCalendarRow, mergeCalendarRow, calendarAsFeed, ISM_MAX_MOVE } from '../lib/ismCalendar.js';
import { mergeIsm } from '../lib/ismFeed.js';
let pass = 0, fail = 0;
const eq = (name, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name, ' got', g, 'want', w); } };
const ok = (name, c) => eq(name, !!c, true);
const NOW = new Date('2026-12-01T16:00:00Z');
const good = { period: '2026-11', manufacturing: 53.2, newOrders: 54.0, asOf: '2026-12-01', source: 'tradingview-calendar' };

const v = validateCalendarRow(good, { now: NOW });
eq('a calendar month is accepted and marked as from the calendar', [v.ok, v.row.source, v.row.via, v.row.manufacturing], [true, 'calendar', 'tradingview-calendar', 53.2]);
eq('services may be missing on manufacturing day', v.row.services, null);
ok('the headline is required', !validateCalendarRow({ ...good, manufacturing: null }, { now: NOW }).ok);
ok('a reading outside 20–80 is refused', /diffusion-index/.test(validateCalendarRow({ ...good, manufacturing: 5.3 }, { now: NOW }).error));
ok('a release date in the future is refused', /future/.test(validateCalendarRow({ ...good, asOf: '2026-12-02' }, { now: NOW }).error));
ok('a release in the survey month itself is refused', /not after the survey month/.test(validateCalendarRow({ ...good, asOf: '2026-11-28' }, { now: NOW }).error));
ok('an unnamed calendar is refused', /source must be/.test(validateCalendarRow({ ...good, source: 'web' }, { now: NOW }).error));
const series = [{ period: '2026-10', manufacturing: 55.5 }];
ok(`a move of more than ${ISM_MAX_MOVE} points from last month is refused`, /more than 10 points/.test(validateCalendarRow({ ...good, manufacturing: 41 }, { series, now: NOW }).error));
eq('a normal move is fine', validateCalendarRow(good, { series, now: NOW }).ok, true);

const merged = mergeCalendarRow([{ period: '2026-11', manufacturing: 50, source: 'calendar' }, ...series], v.row);
eq('one row per month: a rewrite replaces it', merged.map(r => [r.period, r.manufacturing]), [['2026-10', 55.5], ['2026-11', 53.2]]);
const feed = calendarAsFeed({ series: merged, at: 'x' });
eq('served in the feed shape', [feed.ok, feed.latest.period, feed.source], [true, '2026-11', 'calendar']);
eq('nothing stored is not a feed', calendarAsFeed(null).ok, false);
const typed = mergeIsm(feed, { series: [{ period: '2026-11', manufacturing: 53.4, asOf: '2026-12-01' }] }).latest;
eq('a month typed on the Growth axis card still outranks the calendar', [typed.manufacturing, typed.source], [53.4, 'hand+calendar']);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
