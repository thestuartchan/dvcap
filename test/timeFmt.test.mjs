// test/timeFmt.test.mjs — Dubai first, ET in brackets (lib/timeFmt.js).
import { dubaiEt, dubaiEtStamp, zonedInstant, clockIn } from '../lib/timeFmt.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

eq('Dubai first, ET in brackets (EDT, four hours apart)', dubaiEt(new Date('2026-10-16T18:00:00Z')), '22:00 Dubai (14:00 ET)');
eq('after the clocks change, nine hours apart', dubaiEt(new Date('2026-12-01T14:30:00Z')), '18:30 Dubai (09:30 ET)');
eq('a bad date is a dash, not "Invalid Date"', [dubaiEt(null), dubaiEt('soon')], ['—', '—']);

const now = new Date('2026-10-18T09:00:00Z');
eq('today is the clock alone', dubaiEtStamp(new Date('2026-10-18T06:15:00Z'), { now }), '10:15 Dubai (02:15 ET)');
eq('yesterday says so, with its date', dubaiEtStamp(new Date('2026-10-17T06:15:00Z'), { now }), '17 Oct 10:15 Dubai (02:15 ET) — yesterday');
eq('older says how old', dubaiEtStamp(new Date('2026-10-15T06:15:00Z'), { now }), '15 Oct 10:15 Dubai (02:15 ET) — 3d old');
eq('the day is Dubai\'s: 23:30 ET on the 17th is already the 18th in Dubai', dubaiEtStamp(new Date('2026-10-18T03:30:00Z'), { now }), '07:30 Dubai (23:30 ET)');

const intel = zonedInstant('2026-10-29', '14:00', 'America/Los_Angeles');
eq('a Los Angeles wall clock to the instant', intel.toISOString(), '2026-10-29T21:00:00.000Z');
eq('and it lands the next day in Dubai, which is marked', dubaiEt(intel, { refDate: '2026-10-29' }), '01:00 Dubai +1d (17:00 ET)');
eq('a Tokyo time across the US clock change', [clockIn('Asia/Dubai', zonedInstant('2026-11-02', '08:50', 'Asia/Tokyo')), clockIn('America/New_York', zonedInstant('2026-11-02', '08:50', 'Asia/Tokyo'))], ['03:50', '18:50']);
eq('a bad input is null', [zonedInstant('2026-10-29', 'noon', 'Asia/Tokyo'), zonedInstant('2026-10-29', '14:00', 'Not/AZone')], [null, null]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
