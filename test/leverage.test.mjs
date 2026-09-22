// test/leverage.test.mjs — a leveraged ETF's exposure is its cost times its factor; the swing bucket.
import { LEVERAGE, leverageFor, isLeveraged, looksLeveraged, SWING, swingRoom, roomInWrappers } from '../lib/leverage.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);
{
  eq('the brief\'s seed', [LEVERAGE.TQQQ.factor, LEVERAGE.SQQQ.factor, LEVERAGE.QLD.factor, LEVERAGE.QID.factor, LEVERAGE.UPRO.factor, LEVERAGE.SPXU.factor, LEVERAGE.SSO.factor, LEVERAGE.SOXL.factor, LEVERAGE.SOXS.factor, LEVERAGE['7709.HK'].factor, LEVERAGE.UVXY.factor],
     [3, -3, 2, -2, 3, -3, 2, 3, -3, 2, 1.5]);
  eq('each carries its underlying and a daily reset', [LEVERAGE.TQQQ.underlying, LEVERAGE.SOXL.underlying, LEVERAGE.TQQQ.reset], ['QQQ', 'SOXX', 'daily']);
  eq('an unknown ticker is 1, unknown, no reset', leverageFor('QQQ'), { symbol: 'QQQ', factor: 1, underlying: null, reset: 'none', known: false });
  eq('a known one is itself', [leverageFor('tqqq').factor, leverageFor('tqqq').known, isLeveraged('SQQQ'), isLeveraged('INTC')], [3, true, true, false]);
  eq('the words a leveraged name carries', [looksLeveraged('XYZ 2X Daily Bull'), looksLeveraged('ProShares UltraPro QQQ'), looksLeveraged('Direxion Daily Semiconductor Bear 3X'), looksLeveraged('Intel Corporation'), looksLeveraged(null)], [true, true, true, false, false]);
  ok('7709.HK is filed as the SK Hynix product, with the disagreement recorded', /SK Hynix/.test(LEVERAGE['7709.HK'].note) && LEVERAGE['7709.HK'].underlying === '000660.KS');
}
{
  eq('the rule', [SWING.positionMax, SWING.swingMax, SWING.maxSessions], [1.2, 0.3, 3]);
  const over = swingRoom({ nlv: 220000, positionUsd: 1.38 * 220000, swingUsd: 0 });
  eq('position book at 1.38×: over by $39,600, swing room −$39,600', [over.positionX, over.positionOverUsd, over.roomUsd, over.negative], [1.38, 39600, -39600, true]);
  ok('…and the note says who is using it', /position book is using it/.test(over.note) && /\$39,600 over its 1\.2× limit/.test(over.note));
  const fine = swingRoom({ nlv: 220000, positionUsd: 1.18 * 220000, swingUsd: 0 });
  eq('at 1.18×: the full $66,000 reserve', [fine.positionOverUsd, fine.roomUsd, fine.negative], [0, 66000, false]);
  const used = swingRoom({ nlv: 220000, positionUsd: 1.18 * 220000, swingUsd: 60454 });
  eq('one MNQ overnight uses $60,454 of it, $5,546 left', [used.swingUsd, used.roomUsd], [60454, 5546]);
  ok('…and the note says so', /\$60,454 in use/.test(used.note));
  eq('the room in every wrapper', roomInWrappers(66000, { tqqq: 73, qqq: 740, mnq: 30227 }),
     [{ symbol: 'TQQQ', usd: 22000, units: 301, unit: 'sh' }, { symbol: 'QQQ', units: 89, unit: 'sh' }, { symbol: 'MNQ', units: 1.1, unit: 'contracts' }]);
  eq('no room, no wrappers', roomInWrappers(-39600, { tqqq: 73, qqq: 740, mnq: 30227 }), []);
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
