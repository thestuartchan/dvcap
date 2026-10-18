// test/bondDays.test.mjs — business days as the US bond market counts them (lib/bondDays.js).
import { bondOnlyClosures, bondClosed, businessDaysSince } from '../lib/bondDays.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

eq('Columbus Day is the second Monday of October; Veterans Day the 11th', bondOnlyClosures(2026), ['2026-10-12', '2026-11-11']);
eq('a Saturday Veterans Day closes nothing', bondOnlyClosures(2023), ['2023-10-09']);
eq('a Sunday Veterans Day is observed Monday', bondOnlyClosures(2029), ['2029-10-08', '2029-11-12']);
eq('the exchange holidays count too', [bondClosed('2026-11-26'), bondClosed('2026-10-12'), bondClosed('2026-10-13')], [true, true, false]);

const at = (s) => new Date(`${s}T15:00:00Z`);
eq('a Friday print read the Tuesday after Columbus Day is one day old, not two',
  [businessDaysSince('2026-10-09', { now: at('2026-10-13') }), businessDaysSince('2026-10-09', { now: at('2026-10-13'), calendar: 'exchange' })], [1, 2]);
eq('a Tuesday print read the Thursday after Veterans Day is one day old', businessDaysSince('2026-11-10', { now: at('2026-11-12') }), 1);
eq('weekends never count', businessDaysSince('2026-10-16', { now: at('2026-10-18') }), 0);
eq('a missing or bad date is no count', [businessDaysSince(null), businessDaysSince('soon')], [null, null]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
