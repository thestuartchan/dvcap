// test/auditFixes.test.mjs — small defects found in the 17 Oct staleness audit.
import { derivePosition } from '../lib/positions.js';
import { sessionDate } from '../lib/gexStore.js';
import { ordinal } from '../lib/ordinal.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

// A fractional position closed in full is closed — not open with a quantity that prints as 0.
const f = (side, qty, date) => ({ id: side + qty + date, side, qty, price: 10, date });
eq('buy 0.1, buy 0.2, sell 0.3 is closed', derivePosition([f('buy', 0.1, '2026-10-01'), f('buy', 0.2, '2026-10-02'), f('sell', 0.3, '2026-10-03')]).status, 'closed');
eq('buy 1.1, sell 0.7, sell 0.4 is closed', derivePosition([f('buy', 1.1, '2026-10-01'), f('sell', 0.7, '2026-10-02'), f('sell', 0.4, '2026-10-03')]).status, 'closed');
eq('a real remainder is still open', derivePosition([f('buy', 1.1, '2026-10-01'), f('sell', 0.7, '2026-10-02')]).status, 'open');

// A gamma capture is filed under its New York session, not the UTC date it ran on.
eq('the close capture GitHub runs at 00:10Z Saturday is Friday\'s', sessionDate(new Date('2026-10-17T00:10:19Z')), '2026-10-16');
eq('Thursday\'s close at 01:32Z Friday is Thursday\'s', sessionDate(new Date('2026-10-16T01:32:00Z')), '2026-10-15');
eq('the morning open run is that day\'s', sessionDate(new Date('2026-10-16T13:40:00Z')), '2026-10-16');
eq('and after the 1 Nov change, 04:30Z is still the day before', sessionDate(new Date('2026-11-03T04:30:00Z')), '2026-11-02');

// "42th percentile", "2th pct" — gone.
eq('ordinals', [1, 2, 3, 4, 11, 12, 13, 21, 42, 100, 101, 112].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '42nd', '100th', '101st', '112th']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
