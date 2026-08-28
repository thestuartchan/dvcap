// test/calendartime.test.mjs — event times, and the DST trap under them.
//
// The brief shows every time in GMT so that a reader in Hong Kong and one in London quote the same
// number for the same release. But entries are STORED in their native clock, because a US release
// is anchored to 08:30 ET — 12:30Z in summer, 13:30Z in winter — and storing the UTC value would be
// wrong for half of every year.
import { zonedToUtc } from '../api/preread.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const z = (iso) => new Date(iso).toISOString().slice(11, 16);

// THE REASON tz IS STORED RATHER THAN A UTC TIME. Same wall clock, same city, six months apart.
eq('08:30 ET in August is 12:30Z', z(zonedToUtc('2026-08-28', 8, 30, 'America/New_York')), '12:30');
eq('and in January it is 13:30Z', z(zonedToUtc('2026-01-15', 8, 30, 'America/New_York')), '13:30');
ok('so a stored UTC time would be wrong for half the year',
  zonedToUtc('2026-08-28', 8, 30, 'America/New_York') !== zonedToUtc('2026-01-15', 8, 30, 'America/New_York') - 0);

// The session comparison, which is the part of the line that carries meaning. HK closes 16:00 HKT;
// London closes 16:30. The SAME release lands on opposite sides of that split, which is why it
// could not be asserted from the region alone.
{
  const pce = zonedToUtc('2026-08-28', 8, 30, 'America/New_York');
  const hk = new Date(pce).toLocaleString('en-GB', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', hour12: false });
  const ldn = new Date(pce).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
  eq('20:30 in Hong Kong — after the 16:00 close', hk, '20:30');
  eq('13:30 in London — inside the 16:30 session', ldn, '13:30');
}

// A time with no zone is UTC, which is what an event genuinely defined in GMT should carry.
eq('a bare time is already Z', z(Date.UTC(2026, 7, 28, 14, 0)), '14:00');

// Southern-hemisphere zones run the DST shift the other way — the probe handles direction, it does
// not assume northern summer.
eq('Sydney in January is UTC+11', z(zonedToUtc('2026-01-15', 9, 0, 'Australia/Sydney')), '22:00');
eq('and in July it is UTC+10', z(zonedToUtc('2026-07-15', 9, 0, 'Australia/Sydney')), '23:00');

// Zones with a half-hour offset, which an offset table written by hand tends to get wrong.
eq('Kolkata is UTC+5:30', z(zonedToUtc('2026-08-28', 9, 0, 'Asia/Kolkata')), '03:30');
// And one that keeps no DST at all, which is the whole Asia book.
eq('Hong Kong is UTC+8 year round', z(zonedToUtc('2026-01-15', 9, 30, 'Asia/Hong_Kong')), '01:30');
eq('in August too', z(zonedToUtc('2026-08-28', 9, 30, 'Asia/Hong_Kong')), '01:30');

// Midnight either side, where a naive offset add rolls the date and silently moves the event a day.
eq('an early Tokyo time crosses back a day', new Date(zonedToUtc('2026-08-28', 8, 0, 'Asia/Tokyo')).toISOString().slice(0, 16), '2026-08-27T23:00');
eq('a late New York time stays on the day', new Date(zonedToUtc('2026-08-28', 20, 0, 'America/New_York')).toISOString().slice(0, 16), '2026-08-29T00:00');

// Junk is not a time.
eq('an unknown zone yields nothing', zonedToUtc('2026-08-28', 8, 30, 'Not/AZone'), null);

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
