// test/hardDate.test.mjs — the default hard exit is expiry − 7, worked out from the card's own legs,
// never stored (lib/instruments.js). Fake tickers.
import { optionRow, optionDerived, staleHardDates, defaultHardDate } from '../lib/instruments.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const legs = [{ right: 'C', strike: 175, expiry: '2026-12-18', side: 'long', ratio: 1 }, { right: 'C', strike: 190, expiry: '2026-12-18', side: 'short', ratio: 1 }];
eq('the default is expiry − 7', defaultHardDate(legs), '2026-12-11');
const made = optionRow({ underlying: 'ZZZ', legs, qty: 1, price: 2, date: '2026-10-20' }).row;
eq('a new card does not store the default', [made.hardDate, made.hardDateSet], [undefined, undefined]);
eq('…and reads it from its own legs', optionDerived({ ...made, derived: { status: 'open', qty: 1 } }, { today: '2026-11-02' })?.hardDate, '2026-12-11');
const chosen = optionRow({ underlying: 'ZZZ', legs, qty: 1, price: 2, date: '2026-10-20', hardDate: '2026-11-20' }).row;
eq('a date someone chose is kept, and marked', [chosen.hardDate, chosen.hardDateSet], ['2026-11-20', true]);
// XLV, 2 Nov 2026: a Dec 18 spread carrying a Nov 6 contract's saved default.
const stale = { ...made, id: 'x', hardDate: '2026-10-30', derived: { status: 'open', qty: 1 } };
eq('a saved date earlier than its own expiry − 7, never chosen: listed', staleHardDates([stale]).map(s => [s.stored, s.default]), [['2026-10-30', '2026-12-11']]);
eq('chosen: left alone', staleHardDates([{ ...stale, hardDateSet: true }]), []);
eq('later than the default (a deliberate date): left alone', staleHardDates([{ ...stale, hardDate: '2026-12-15' }]), []);
eq('closed: left alone', staleHardDates([{ ...stale, derived: { status: 'closed', qty: 0 } }]), []);

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
