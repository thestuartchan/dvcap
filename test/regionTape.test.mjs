// test/regionTape.test.mjs — each region's own tape chip (lib/regionTape.js).
import { regionTapeRead, legFromBars, REGION_TAPE, REGION_ORDER } from '../lib/regionTape.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

eq('three regions, in session order', REGION_ORDER, ['asia', 'eu', 'us']);
ok('each has three indices and a currency', REGION_ORDER.every(r => REGION_TAPE[r].indices.length === 3 && REGION_TAPE[r].fx.sym));

// The sessions of 7 Oct (Asia, Europe) and 6 Oct (US), as read.
const asia = regionTapeRead('asia', { indices: [{ name: 'KOSPI', value: -1.98, atr: 2.85 }, { name: 'Hang Seng', value: -0.62, atr: 1.31 }, { name: 'Nikkei', value: -0.92, atr: 1.81 }], fx: { value: 0.3, atr: 0.7 } });
eq('two of three past half their range: risk-off', asia.direction, 'risk-off');
eq('naming the ones that moved', asia.line, 'Asia: risk-off (KOSPI −1.98%, Nikkei −0.92%)');
const us = regionTapeRead('us', { indices: [{ name: 'Nasdaq 100', value: 0.46, atr: 1.21 }, { name: 'S&P 500', value: 0.55, atr: 0.87 }, { name: 'Russell 2000', value: -0.72, atr: 1.31 }], fx: { value: 0.48, atr: 0.35 } });
eq('one up, one down, one quiet: mixed', us.direction, 'mixed');
eq('with the currency tell', us.line, 'US: mixed (S&P 500 +0.55%, Russell 2000 −0.72%) · dollar bid');
const won = regionTapeRead('asia', { indices: [{ name: 'KOSPI', value: -2.5, atr: 2.8 }], fx: { value: 0.9, atr: 0.7 } });
eq('USD/KRW up past its gate: the won is weak', won.fx, { text: 'won weak', weak: true, value: 0.9 });
eq('EUR/USD down: the euro is weak', regionTapeRead('eu', { indices: [], fx: { value: -0.5, atr: 0.4 } }).fx.text, 'euro weak');
eq('nothing past its gate is quiet', regionTapeRead('eu', { indices: [{ name: 'DAX', value: 0.2, atr: 1.2 }] }).direction, 'quiet');
eq('no reading is unavailable, not quiet', regionTapeRead('eu', { indices: [{ name: 'DAX', value: null, atr: null }] }).direction, 'unavailable');
eq('an unknown region is nothing', regionTapeRead('mars', {}), null);

// Bars to a leg: the last session against the one before, and the instrument's own ATR.
const bars = Array.from({ length: 40 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, open: 100, high: 101, low: 99, close: 100 }));
bars.push({ date: '2026-10-07', open: 100, high: 101, low: 97, close: 98 });
const leg = legFromBars(bars);
eq('session move from the last two closes', leg.value, -2);
ok('with an ATR in percent', leg.atr > 1.5 && leg.atr < 3);
eq('too few bars is no reading', legFromBars(bars.slice(0, 5)).value, null);

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
