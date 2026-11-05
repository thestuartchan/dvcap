// test/scenarioBoard.test.mjs — the rebuilt scenario board (lib/scenarioBoard.js).
import { alignCloses, zAt, walkLeg, statusOf, evaluateBoard, mapLegacy, sortBoard, boardSummary,
         SCENARIO_DEFS, SERIES, BOARD_SYMBOLS, GROUPS, WINDOW, VOL_LOOKBACK, ENTER, EXIT } from '../lib/scenarioBoard.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const near = (a, b, t) => Math.abs(a - b) <= t;

// ── THE SET ──────────────────────────────────────────────────────────────────
{
  eq('twenty scenarios on bars — both sides of the tape', SCENARIO_DEFS.map(d => d.id),
     ['A', 'B', 'C', 'GS', 'SF', 'D', 'CU', 'SD', 'AI', 'SL', 'RR', 'EX', 'RF', 'RO', 'DR', 'AR', 'SW', 'MP', 'CR', 'SC']);
  eq('five groups', GROUPS.map(g => g.id), ['rates', 'stress', 'riskon', 'rotation', 'book']);
  ok('every scenario sits in a group that exists', SCENARIO_DEFS.every(d => GROUPS.some(g => g.id === d.group)));
  ok('the board is no longer only bad news: supportive scenarios outside rates',
     SCENARIO_DEFS.filter(d => d.side === 'supportive' && d.group !== 'rates').length >= 4);
  ok('rotations do not move the stance (neither supportive nor adverse)', SCENARIO_DEFS.filter(d => d.group === 'rotation').every(d => d.side === 'rotation'));
  ok('every "not" points at a scenario on the board', SCENARIO_DEFS.every(d => d.not.every(x => SCENARIO_DEFS.some(o => o.id === x.id))));
  ok('every leg names a series that exists, or gates on scenarios that exist',
     SCENARIO_DEFS.every(d => d.legs.every(l => l.dir === 'recent' ? l.after.every(id => SCENARIO_DEFS.some(o => o.id === id)) : SERIES[l.series])));
  ok('selling exhausting is gated on a credit crack or CTA de-risking', SCENARIO_DEFS.find(d => d.id === 'EX').legs.some(l => l.required && l.after.join() === 'D,SD'));
  ok('every scenario states what it means, what to expect and what it is not', SCENARIO_DEFS.every(d => d.meaning && d.expect?.length && d.not?.length));
  ok('credit is high yield AGAINST Treasuries, not HYG alone', SERIES.CREDIT.ratio.join('/') === 'HYG/IEI');
  ok('and no scenario reads HYG on its own', !SCENARIO_DEFS.some(d => d.legs.some(l => l.series === 'HYG')));
  eq('the symbols fetched', [...BOARD_SYMBOLS].sort(), ['CL=F', 'DX-Y.NYB', 'GLD', 'HYG', 'IEI', 'JPY=X', 'QQQ', 'SMH', 'SPY', 'TLT', '^FVX', '^TNX', '^TYX', '^VIX',
     'RSP', 'IWD', 'IWF', 'XLF', 'XLV', 'XLP', 'XLU', 'HG=F', 'EEM', 'IGV', 'MU', 'IWM'].sort());
  eq('horizon and thresholds', [WINDOW, VOL_LOOKBACK, ENTER, EXIT], [20, 60, 0.5, 0.25]);
}

// ── ONE CALENDAR ─────────────────────────────────────────────────────────────
{
  const a = alignCloses({
    SPY: [{ date: '2026-09-01', close: 1 }, { date: '2026-09-02', close: 2 }, { date: '2026-09-03', close: 3 }],
    '^TNX': [{ date: '2026-09-01', close: 4.1 }, { date: '2026-09-03', close: 4.3 }],
    'JPY=X': [{ date: '2026-08-31', close: 150 }, { date: '2026-09-01', close: 151 }, { date: '2026-09-02', close: 152 }, { date: '2026-09-04', close: 153 }],
  });
  eq('the master calendar is SPY\'s', a.dates, ['2026-09-01', '2026-09-02', '2026-09-03']);
  eq('a missing session carries the last close forward', a.closes['^TNX'], [4.1, 4.1, 4.3]);
  eq('and a bar after the last master session is not used', a.closes['JPY=X'], [151, 152, 152]);
}

// ── Z: A 20-SESSION CHANGE IN ITS OWN VOLATILITY ─────────────────────────────
const series = (n, drift, wiggle = 0.01, start = 100) => {
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * Math.exp(drift + (i % 2 ? wiggle : -wiggle)));
  return out;
};
{
  const up = series(120, 0.002);
  const z = zAt(up, 119, 'log');
  // 20 sessions of +0.2% drift over a ±1% wiggle: change 0.04, σ ≈ 0.01, so z ≈ 0.04 / (0.01·√20) ≈ 0.89.
  ok('a steady drift reads as a trend of the right size', near(z, 0.04 / (0.01 * Math.sqrt(20)), 0.05));
  ok('a flat series reads near zero', Math.abs(zAt(series(120, 0), 119, 'log')) < 0.1);
  eq('too little history, no reading', zAt(up, 30, 'log'), null);
  const yields = Array.from({ length: 120 }, (_, i) => 4 + i * 0.004 + (i % 2 ? 0.01 : -0.01));
  ok('yields difference rather than log', zAt(yields, 119, 'diff') > 0.5);
}

// ── HYSTERESIS: ON AT 0.5, OFF ONLY BELOW 0.25 ───────────────────────────────
{
  const path = [0.2, 0.6, 0.4, 0.3, 0.26, 0.2, 0.45, 0.55];
  const run = walkLeg({ dir: 'up' }, (i) => path[i], 0, path.length - 1).map(s => s.met);
  eq('switches on past 0.5, holds above 0.25, off below it, and needs 0.5 again', run, [false, true, true, true, true, false, false, true]);
  const down = walkLeg({ dir: 'down' }, (i) => -path[i], 0, path.length - 1).map(s => s.met);
  eq('the same for a falling leg', down, run);
  eq('a permissive leg has no memory', walkLeg({ dir: 'notUp' }, (i) => path[i], 0, 7).map(s => s.met), path.map(v => v < 0.5));
  eq('a missing reading is unknown, and resets the leg', walkLeg({ dir: 'up' }, (i) => [0.6, null, 0.4][i], 0, 2).map(s => s.met), [true, null, false]);
}

// ── STATES ───────────────────────────────────────────────────────────────────
{
  const legs = [{ dir: 'up' }, { dir: 'down' }, { dir: 'notDown' }];
  eq('every leg: active', statusOf([{ met: true }, { met: true }, { met: true }], legs), 'ACTIVE');
  eq('half the directional legs: building', statusOf([{ met: true, v: 1 }, { met: false, v: 0 }, { met: true, v: 0 }], legs), 'BUILDING');
  eq('a permissive leg alone does not make it building', statusOf([{ met: false }, { met: false }, { met: true }], legs), 'QUIET');
  eq('a directional leg moving hard the other way vetoes building',
     statusOf([{ met: true, v: 1.6 }, { met: false, v: 3.0 }, { met: true, v: 0 }], legs), 'QUIET');
  eq('but a leg merely not there yet does not',
     statusOf([{ met: true, v: 1.6 }, { met: false, v: 0.3 }, { met: true, v: 0 }], legs), 'BUILDING');
  eq('a missing leg: no data', statusOf([{ met: true }, { met: null }, { met: true }], legs), 'NO DATA');
}

// ── END TO END: A HAWKISH REPRICING ──────────────────────────────────────────
// 5Y rising fast, 30Y rising slowly (5s30s flattening), dollar rising; everything else flat.
function bars(values, start = '2025-01-01') {
  const d0 = Date.parse(start + 'T00:00:00Z');
  return values.map((close, i) => ({ date: new Date(d0 + i * 86400000).toISOString().slice(0, 10), close }));
}
{
  const N = 400;
  const flat = (v) => bars(series(N, 0, 0.01, v));
  const w = (i) => (i % 2 ? 0.005 : -0.005);
  const lvl = (base, slope, from) => bars(Array.from({ length: N }, (_, i) => base + (i > from ? (i - from) * slope : 0) + w(i)));
  const input = {
    SPY: flat(500), QQQ: flat(400), SMH: flat(250), TLT: flat(90), HYG: flat(80), IEI: flat(115), GLD: flat(200),
    'CL=F': flat(70), 'JPY=X': flat(150), '^VIX': flat(15), '^TNX': lvl(4, 0, N),
    '^FVX': lvl(4, 0.01, N - 40), '^TYX': lvl(4.5, 0.002, N - 40),
    'DX-Y.NYB': bars(series(N, 0, 0.003, 100).map((v, i) => (i > N - 40 ? v * Math.exp((i - (N - 40)) * 0.002) : v))),
    RSP: flat(180), IWD: flat(190), IWF: flat(400), XLF: flat(50), XLV: flat(150), XLP: flat(80), XLU: flat(75), 'HG=F': flat(4.5), EEM: flat(45),
    IGV: flat(110), MU: flat(200), IWM: flat(240),
  };
  const b = evaluateBoard(input);
  const C = b.scenarios.find(s => s.id === 'C');
  eq('one as-of date for the whole board', b.asOf, input.SPY.at(-1).date);
  eq('hawkish repricing is active', C.status, 'ACTIVE');
  ok('every leg met, with its reading', C.legs.every(l => l.met && /σ over 20 sessions/.test(l.display)));
  ok('the posture card\'s fields are all there', ['id', 'name', 'confirmed', 'side', 'consequence', 'met', 'total', 'weight', 'broken', 'proximity', 'watch'].every(k => k in C));
  eq('confirmed means active', [C.confirmed, C.broken, C.met, C.total], [true, false, 3, 3]);
  eq('a 20-session strip, oldest first', [C.strip.length, C.strip.at(-1).status], [20, 'ACTIVE']);
  ok('and it says since when', C.since && C.since <= b.asOf && !C.sinceCapped);
  ok('an active scenario names its weakest leg', /is the weakest leg/.test(C.watch));
  ok('and what ends it, by leg', /5Y yield rising, 5s30s flattening, dollar rising fading back inside ±0.25σ/.test(C.breaksIf));
  const quiet = b.scenarios.filter(s => s.id !== 'C' && s.id !== 'B');
  ok('nothing else trends into a scenario on flat inputs', quiet.every(s => s.status === 'QUIET'));
  ok('a quiet one names its closest trigger', quiet.filter(s => s.nearest).every(s => /from switching on/.test(s.watch)));
  const noSmh = evaluateBoard({ ...input, SMH: [] });
  eq('a missing series is no data, not quiet', noSmh.scenarios.find(s => s.id === 'AI').status, 'NO DATA');
  // Credit: HYG and IEI falling together is a RATES move, not a credit crack.
  const rates = evaluateBoard({ ...input, HYG: bars(series(N, -0.003, 0.01, 80)), IEI: bars(series(N, -0.003, 0.01, 115)) });
  eq('HYG falling with Treasuries is not credit cracking', rates.scenarios.find(s => s.id === 'D').legs[0].met, false);

  // ── THE OTHER SIDE: a rotation out of mega-caps ──
  // Equal-weight, value and financials grind up against a flat S&P and flat growth.
  const grind = (v, d = 0.004) => bars(series(N, 0, 0.01, v).map((x, i) => (i > N - 40 ? x * Math.exp((i - (N - 40)) * d) : x)));
  const rot = evaluateBoard({ ...input, RSP: grind(180), IWD: grind(190), XLF: grind(50) });
  const RO = rot.scenarios.find(s => s.id === 'RO');
  eq('rotation out of mega-caps is active', [RO.status, RO.met], ['ACTIVE', 3]);
  eq('and it does not move the stance', RO.side, 'rotation');
  // Defensives as a basket: the members' log ratios are averaged, so two sectors pulling opposite
  // ways cancel rather than one of them deciding the leg.
  const dr = (x) => evaluateBoard({ ...input, ...x }).scenarios.find(s => s.id === 'DR').legs[0];
  eq('health care leading alone lifts the basket', dr({ XLV: grind(150, 0.003) }).met, true);
  ok('health care up and staples down by as much leave it near flat', Math.abs(dr({ XLV: grind(150, 0.003), XLP: grind(80, -0.003) }).value) < 0.25);
  const noEem = evaluateBoard({ ...input, EEM: [] });
  eq('a missing basket or ratio member is no data', noEem.scenarios.find(s => s.id === 'RF').status, 'NO DATA');
}

// ── A GATE: ACTIVE ONLY AFTER ANOTHER SCENARIO ───────────────────────────────
{
  const N = 400;
  const flat = (v) => bars(series(N, 0, 0.01, v));
  // SPY trends up for 40 sessions, then goes flat for 30: X is active, then switches off.
  const spy = bars(series(N, 0, 0.01, 500).map((x, i) => x * Math.exp(Math.min(Math.max(i - (N - 70), 0), 40) * 0.004)));
  const X = { id: 'X', group: 'rates', legs: [{ series: 'SPY', dir: 'up', label: 'S&P rising' }] };
  const gate = (within) => ({ series: '@X', after: ['X'], dir: 'recent', within, required: true, label: 'after X' });
  const G = (within) => ({ id: 'G' + within, group: 'rates', legs: [gate(within), { series: 'TLT', dir: 'notUp', label: 'TLT not rising' }] });
  const b = evaluateBoard({ SPY: spy, TLT: flat(90) }, { defs: [X, G(10), G(400)], keepDays: true });
  const [x, g10, gAll] = b.scenarios;
  const lastX = x.days.map(d => d.status).lastIndexOf('ACTIVE');
  ok('the gating scenario was active and has since switched off', lastX > 0 && x.status !== 'ACTIVE');
  const after = x.days.length - 1 - lastX;
  eq('ten sessions after it, the gate has closed and the gated scenario is quiet', g10.status, after >= 10 ? 'QUIET' : 'ACTIVE');
  ok('and it says how long ago', /none in the last 10 sessions|last active/.test(g10.legs[0].display));
  eq('a long enough gate keeps it open', gAll.status, 'ACTIVE');
  const never = evaluateBoard({ SPY: flat(500), TLT: flat(90) }, { defs: [X, G(10)] }).scenarios[1];
  eq('never gated: quiet, even with every other leg met', [never.status, never.legs[1].met], ['QUIET', true]);
}

// ── THE NEW LEG KINDS ────────────────────────────────────────────────────────
{
  const v = Array.from({ length: 120 }, (_, i) => 100 * Math.exp((i > 113 ? (i - 113) * 0.01 : 0) + (i % 2 ? 0.005 : -0.005)));
  ok('a 5-session window sees a week\'s move the 20-session one barely registers', zAt(v, 119, 'log', 5) >= 1.9 * zAt(v, 119, 'log'));
  eq('CTA adding: on at +0.25, holds to +0.10', walkLeg({ dir: 'add' }, (i) => [0.2, 0.3, 0.15, 0.05][i], 0, 3).map(s => s.met), [false, true, true, false]);
  eq('CTA already cut: on at ≤ 0.20, holds to 0.30', walkLeg({ dir: 'low' }, (i) => [0.5, 0.15, 0.28, 0.35][i], 0, 3).map(s => s.met), [false, true, true, false]);
  ok('the new kinds are directional, so they count toward building',
     statusOf([{ met: true, v: 0.3 }, { met: false, v: 0 }], [{ dir: 'add' }, { dir: 'down' }]) === 'BUILDING');
}

// ── KOREA AND CHINA, MAPPED ──────────────────────────────────────────────────
{
  const base = { id: 'KM', name: 'KOREA MECHANICAL UNWIND', weight: 8, side: 'adverse', conditions: [{ label: 'x', met: true, display: '1' }, { label: 'y', met: false, display: '2' }] };
  eq('every leg met → active', mapLegacy({ ...base, conditions: [{ label: 'x', met: true }, { label: 'y', met: true }] }).status, 'ACTIVE');
  eq('partial with a leg met → building', mapLegacy({ ...base, status: 'PARTIAL', met: 1, total: 2 }).status, 'BUILDING');
  const br = mapLegacy({ ...base, broken: true, status: 'BROKEN', brokenBy: ['A/H widening 20d (+18pp)'] });
  eq('broken → quiet, saying why it ended', [br.status, br.note], ['QUIET', 'ended: A/H widening 20d (+18pp)']);
  eq('nothing reported at all → no data', mapLegacy({ ...base, conditions: [{ label: 'x', met: null, neutral: true, reason: 'not reported', display: 'n/a' }] }).status, 'NO DATA');
  // KM on 2026-09-25: units flat (a reading, too small to confirm), VKOSPI not reported in this region.
  const km = mapLegacy({ ...base, conditions: [
    { label: '7709 units falling', met: null, neutral: true, reason: 'below half an ATR — too small to confirm or deny', display: '+0% 1d' },
    { label: 'VKOSPI extreme', met: null, neutral: true, reason: 'not reported', display: 'n/a' },
    { label: 'VKOSPI not yet rolled', met: null, neutral: true, reason: 'not reported', display: 'n/a' } ] });
  eq('a flat reading is a reading: quiet, not no data', [km.status, km.legs.map(l => l.met)], ['QUIET', [false, null, null]]);
  eq('and it names what was not reported', km.note, 'not reported here: VKOSPI extreme, VKOSPI not yet rolled');
  eq('the name reads as words, not shouting', mapLegacy(base).name, 'Korea Mechanical Unwind');
  eq('it sits with the book', mapLegacy(base).group, 'book');
}

// ── ORDER AND SUMMARY ────────────────────────────────────────────────────────
{
  const s = sortBoard([
    { name: 'q', status: 'QUIET', weight: 9, proximity: 0 }, { name: 'a', status: 'ACTIVE', weight: 6, proximity: 1 },
    { name: 'b', status: 'BUILDING', weight: 7, proximity: 0.5 }, { name: 'n', status: 'NO DATA', weight: 9, proximity: 0 },
  ]);
  eq('active, building, quiet, no data — then weight', s.map(x => x.name), ['a', 'b', 'q', 'n']);
  eq('the summary line', boardSummary(s), { active: ['a'], building: ['b'], quiet: 1, noData: ['n'] });
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
