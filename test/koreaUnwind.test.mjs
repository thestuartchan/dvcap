// test/koreaUnwind.test.mjs — KM's inputs from the KOFIA / KRX store (lib/koreaUnwind.js).
import { kmInputs } from '../lib/koreaUnwind.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// Made-up levels. Margin loans lag the index and the flow by a day, as KOFIA posts them.
const series = {
  marginLoans: [{ date: '2026-01-05', value: 100 }, { date: '2026-01-06', value: 101 }, { date: '2026-01-07', value: 99, pct: -1.98 }],
  kospi: [{ date: '2026-01-05', value: 2000 }, { date: '2026-01-06', value: 2020 }, { date: '2026-01-07', value: 1980, pct: -1.98 }, { date: '2026-01-08', value: 2000, pct: 1.01 }],
  foreignNet: [{ date: '2026-01-07', value: -450, unit: '십억원' }, { date: '2026-01-08', value: 90, unit: '십억원' }],
};
const k = kmInputs(series);
eq('all three are taken at the latest date they share, not each at its own latest', [k.date, k.margin.date, k.kospi.date, k.foreignNet.date], ['2026-01-07', '2026-01-07', '2026-01-07', '2026-01-07']);
eq('the day change is KOFIA\'s own figure', [k.margin.value, k.kospi.value], [-1.98, -1.98]);
eq('the flow keeps its sign and unit', [k.foreignNet.value, k.foreignNet.unit], [-450, '십억원']);
eq('each leg carries a noise floor from its own history', [k.margin.atr > 0, k.kospi.atr > 0], [true, true]);
eq('without the pct the change is computed from the levels', kmInputs({ ...series, marginLoans: series.marginLoans.map(({ pct, ...r }) => r) }).margin.value, -1.98);
eq('no shared date, no inputs', kmInputs({ marginLoans: series.marginLoans, kospi: [], foreignNet: [] }), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
