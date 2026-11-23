// The Global Macro weekend edition (lib/globalMacro.js) and the Asia re-time (data/universe.js).
import { weekendMove, weekendLines, assembleGlobal, WEEKEND_LEGS } from '../lib/globalMacro.js';
import { UNIVERSE } from '../data/universe.js';
import { prereadWindow } from '../api/preread.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w); if (a === b) { pass++; console.log('✅', n); } else { fail++; console.log('❌', n, ' got', a, 'want', b); } };
const ok = (n, c) => eq(n, !!c, true);
const t = (iso) => Date.parse(iso) / 1000;
// Friday 20 Nov 2026 (EST): 15:55 and 16:00 ET bars, then Sunday 18:05 and 18:20 ET bars.
const ts = [t('2026-11-20T20:55:00Z'), t('2026-11-20T21:00:00Z'), t('2026-11-22T23:05:00Z'), t('2026-11-22T23:20:00Z')];
const m = weekendMove(ts, [6900, 6905, 6950, 6960], '2026-11-20');
eq('reference is the last bar before Friday 16:00 ET', m.ref, 6900);
eq('latest is the last bar', m.now, 6960);
ok('change measured from Friday', Math.abs(m.chg - (6960 / 6900 - 1)) < 1e-12);
eq('no Friday bar, no move', weekendMove([t('2026-11-22T23:05:00Z')], [1], '2026-11-20'), null);
eq('nulls skipped', weekendMove(ts, [6900, null, 6950, null], '2026-11-20').now, 6950);
const lines = weekendLines([{ sym: 'ES=F', label: 'S&P 500 futures', ok: true, now: 6960.25, chg: 0.0087 }, { sym: 'EURUSD=X', label: 'EUR/USD', ok: true, now: 1.08234, chg: -0.0021 }, { sym: 'ZN=F', label: 'x', ok: false }]);
eq('lines read label · price · bold change', lines, ['S&P 500 futures 6,960 · **+0.9%**', 'EUR/USD 1.0823 · **−0.2%**']);
eq('nothing loaded, no section', weekendLines([{ ok: false }]), null);
ok('the legs cover futures, crypto and FX', ['ES=F', 'NQ=F', 'BTC-USD', 'JPY=X'].every(s => WEEKEND_LEGS.some(([x]) => x === s)));
const wk = assembleGlobal({ weekend: lines });
ok('weekend edition is labelled', wk.includes('WEEKEND EDITION') && wk.includes("SINCE FRIDAY'S CLOSE"));
ok('a weekday Overview carries no weekend section', !assembleGlobal({}).includes('WEEKEND'));
// Asia: 07:30 HKT, window opens 07:10, closes at the 08:15 deadline
eq('Asia targets 07:30 HKT', UNIVERSE.asia.prereadHourLocal, 7.5);
eq('23:12 UTC (07:12 HKT) is inside the window', prereadWindow(7 * 60 + 12, 7.5, { deadlineMin: UNIVERSE.asia.prereadDeadlineLocal }).accept, true);
eq('22:42 UTC (06:42 HKT) is now too early', prereadWindow(6 * 60 + 42, 7.5, { deadlineMin: UNIVERSE.asia.prereadDeadlineLocal }).accept, false);
console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exit(1);
