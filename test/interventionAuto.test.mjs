// test/interventionAuto.test.mjs — the yen flag from price, confirmed or denied by the MoF.
import { scanYen, parseMofCsv, parseMofMonthly, parseMofMonthlyIndex, confirmEvent, autoState, mergeInterventionState,
         tokyoDate, sessionsBetween, AUTO_CFG } from '../lib/interventionAuto.js';
import { contamination } from '../lib/intervention.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// 15-minute bars from 2026-07-30 00:00 UTC: flat, then a fall of `drop`% over `bars` bars at bar 52 (13:00 UTC).
const T0 = Date.parse('2026-07-30T00:00:00Z') / 1000;
const series = (start, dropPct, bars = 4, n = 80) => Array.from({ length: n }, (_, i) => {
  const k = i < 52 ? 0 : Math.min(1, (i - 51) / bars);
  return { t: T0 + i * 900, c: +(start * (1 - (dropPct / 100) * k)).toFixed(4) };
});
{
  const ev = scanYen({ jpy: series(162.96, 2.0), dxy: series(99.0, 0.5), high60: 164 });
  eq('a 2% fall in an hour, four times DXY, near the high: one event', ev.length, 1);
  eq('…dated in Tokyo, with the move and the DXY move', [ev[0].firedOn, ev[0].movePct, ev[0].dxyPct, ev[0].windowMin], ['2026-07-30', -2, -0.5, 60]);
  eq('…every criterion reported met', ev[0].criteria.map(c => [c.id, c.met]), [['size', true], ['yen', true], ['zone', true]]);
  eq('a broad dollar fall (DXY −1.0% with the yen −1.2%) is not the yen', scanYen({ jpy: series(160, 1.2), dxy: series(99, 1.0), high60: 161 }).length, 0);
  eq('far from the 60-day high it is not a defence', scanYen({ jpy: series(150, 2.0), dxy: series(99, 0.4), high60: 160 }).length, 0);
  eq('with no DXY bars there is no event — unknown is not met', scanYen({ jpy: series(162, 2.0), dxy: [], high60: 164 }).length, 0);
  eq('nor with no 60-day high', scanYen({ jpy: series(162, 2.0), dxy: series(99, 0.4), high60: null }).length, 0);
  eq('a 0.8% fall is ordinary', scanYen({ jpy: series(162, 0.8), dxy: series(99, 0.1), high60: 163 }).length, 0);
  eq('a slower 1.6% over three hours counts', scanYen({ jpy: series(162, 1.6, 11), dxy: series(99, 0.3, 11), high60: 163 }).length, 1);
  eq('a yen FALL (USD/JPY up) is not a defence', scanYen({ jpy: series(160, -2.0), dxy: series(99, -0.2), high60: 161 }).length, 0);
  eq('an NY-afternoon move is the next day in Tokyo', tokyoDate(Date.parse('2026-07-31T20:00:00Z') / 1000), '2026-08-01');
  eq('the thresholds are the calibrated ones', [AUTO_CFG.fastPct, AUTO_CFG.slowPct, AUTO_CFG.yenOverDxy, AUTO_CFG.nearHighPct], [1, 1.5, 2, 3]);
}
// The MoF CSV, trimmed from the real file (the Japanese columns replaced — they are not read).
const CSV = [
  'Ministry of Finance,,,,,,,,',
  'x,x,x,Intervention Date,,,,,',
  'x,x,x,Year,Month,Day,amount,x,Currency pairs',
  'x,x,x,2024,Apr,29,"59,185",x,the US dollar (sold) the Japanese yen (bought)',
  ',x,x,,May,1,"38,700",x,the US dollar (sold) the Japanese yen (bought)',
  'x,,,April - June 2024,,,"97,885",,',
  'x,,,July - September 2025,,,0,,',
  'x,x,x,2026,Apr,30,"62,787",x,the US dollar (sold) the Japanese yen (bought)',
  ',x,x,,May,4,"7,802",x,the US dollar (sold) the Japanese yen (bought)',
  ',x,x,,May,6,"46,759",x,the US dollar (sold) the Japanese yen (bought)',
  'x,,,April - June 2026,,,"117,349",,',
].join('\n');
const csv = parseMofCsv(CSV);
{
  eq('the CSV: one row per day, the year carried down, amounts in ¥100m', csv.days.map(d => [d.date, d.amount100mYen]),
     [['2024-04-29', 59185], ['2024-05-01', 38700], ['2026-04-30', 62787], ['2026-05-04', 7802], ['2026-05-06', 46759]]);
  eq('…and it reaches the end of the last quarter it totals', csv.coveredThrough, '2026-06-30');
  const page = '<p>Total amount of foreign exchange intervention operations for the period from July 30, 2026 through August 26, 2026</p><td>&yen;　15,399.3 billion</td>';
  eq('a monthly page', parseMofMonthly(page), { from: '2026-07-30', to: '2026-08-26', totalBillionYen: 15399.3 });
  eq('…and a nil month', parseMofMonthly('<p>for the period from August 27, 2026 through September 28, 2026</p><td>&yen;　0</td>'), { from: '2026-08-27', to: '2026-09-28', totalBillionYen: 0 });
  eq('the monthly index, newest first', parseMofMonthlyIndex('<a href="20260828e.html"><a href="20260930e.html"><a href="20260828e.html">'), ['20260930', '20260828']);
}
const monthly = [{ from: '2026-08-27', to: '2026-09-28', totalBillionYen: 0 }, { from: '2026-07-30', to: '2026-08-26', totalBillionYen: 15399.3 }];
const mof = { csv, monthly };
{
  eq('confirmed by date', confirmEvent({ firedOn: '2026-04-30' }, mof).status, 'confirmed');
  eq('…a day either side, for the Tokyo/NY boundary', confirmEvent({ firedOn: '2026-05-07' }, mof).how, 'daily');
  eq('denied where the daily data covers the date and lists nothing', confirmEvent({ firedOn: '2026-06-10' }, mof).status, 'denied');
  eq('confirmed by a monthly total above zero', [confirmEvent({ firedOn: '2026-07-30' }, mof).status, confirmEvent({ firedOn: '2026-07-30' }, mof).amountTrnYen], ['confirmed', 15.4]);
  eq('denied by a nil month', confirmEvent({ firedOn: '2026-09-10' }, mof).status, 'denied');
  eq('pending until a release covers it', confirmEvent({ firedOn: '2026-09-30' }, mof).status, 'pending');
  eq('no MoF data at all leaves it pending, never confirmed', confirmEvent({ firedOn: '2026-07-30' }, {}).status, 'pending');
}
{
  const ev = (firedOn) => ({ firedOn, movePct: -2, windowMin: 60, from: 162.96 });
  const s1 = autoState([ev('2026-09-30')], mof, '2026-10-01');
  eq('a fresh, unpublished event is a live SUSPECTED event', [s1.active, s1.state.events.JPY, s1.state.regimes.JPY], [true, { firedOn: '2026-09-30', grade: 'SUSPECTED', auto: true }, undefined]);
  eq('…and after two quiet sessions it is history', autoState([ev('2026-09-30')], mof, '2026-10-05').active, false);
  const s2 = autoState([ev('2026-07-30')], mof, '2026-08-07');
  eq('a confirmed event holds the leg as a CONFIRMED regime for ten sessions', [s2.active, s2.state.regimes.JPY?.grade, s2.state.regimes.JPY?.since, s2.state.context.JPY], [true, 'CONFIRMED', '2026-07-30', { sessionsSinceEvent: 6 }]);
  eq('…and lets it go after', autoState([ev('2026-07-30')], mof, '2026-08-14').active, false);
  eq('a denied event sets nothing', autoState([ev('2026-09-10')], mof, '2026-09-11').active, false);
  eq('the headline names the grade and the evidence', s2.headline.startsWith('CONFIRMED yen intervention 2026-07-30: USD/JPY -2% in 60 min from 162.96 — MoF monthly total ¥15.4tn'), true);
  // The hand-off: lib/intervention.js contamination() reads the automatic state as it reads the manual one.
  const c = contamination(mergeInterventionState({ active: false }, s2.state), '2026-08-07');
  eq('the yen leg is contaminated and DXY stops being a broad-dollar proxy', [c.legs, c.dxyUsable, c.flagged.JPY.regime.grade], [['JPY'], false, 'CONFIRMED']);
  eq('nothing automatic, nothing flagged', contamination(mergeInterventionState({}, autoState([], mof, '2026-09-30').state), '2026-09-30').any, false);
  const manual = { regimes: { JPY: { grade: 'SUSPECTED', since: '2026-08-01', note: 'by hand' } }, events: { KRW: { firedOn: '2026-08-06' } } };
  const m = mergeInterventionState(manual, s2.state);
  eq('a stored flag wins for its leg and leaves the others', [m.regimes.JPY.note, m.events.KRW.firedOn], ['by hand', '2026-08-06']);
  eq('sessions skip weekends', sessionsBetween('2026-07-30', '2026-08-07'), 6);
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
