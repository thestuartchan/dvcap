// test/gexLevels.test.mjs — put support, trapdoor, pin box, the call wall's kind, balance with a
// direction, the rate that is never 0.00, and the strike table that cannot hide the flip zone.
//
// The four boards are the ones the tile got wrong: 17, 18, 21 and 22 September 2026. Each is
// rebuilt from the figures the panel showed that day — the cells are hand-set so the answer is
// known by construction rather than by running the code and copying what it said.
import {
  levelsOf, putSupport, trapdoors, pinBox, callWallOf, balanceOf, distanceFloor, peaksAt,
  levelsLog, mustShow, regimeLine, regimeDetail, rateLine, rateFarOut, RATE_FAR_DAYS, negativeStack, ladderNodes, STACK_TOUCH_PCT,
  supportText, trapdoorText, pinText, callWallText, shortExpiry, fmtM,
  SUPPORT_MIN_DIST_PCT, SUPPORT_MAX_DIST_PCT, SUPPORT_MIN_SHARE, TRAPDOOR_NEAR_PCT, TRAPDOOR_DEEP_PCT,
  TRAPDOOR_MIN_FRAC, PIN_HALF_PCT, PIN_MIN_SHARE, BALANCE_MIN_RATIO,
} from '../lib/gexLevels.js';
import { heatCells, HEAT_ROWS, HEAT_MIN_PER_COLUMN } from '../lib/gex.js';
import { compareGex, cboeSummary } from '../lib/cboe.js';
import { gexRead } from '../lib/gexRead.js';
import { riskFreeRate, RF_KEY, atr14 } from '../lib/gexStore.js';
import { renderGexSection, renderLadder, bookWords, nextBox, regimeWords } from '../lib/gexBrief.js';
import { assertObservational } from '../lib/read.js';
import { healthSample } from '../lib/occHealth.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// A board from cells: byStrike is the per-strike sum, the grid carries the cells and the expiries
// in date order. Exactly what lib/gex.js hands the levels code, minus the Black-Scholes.
const M = 1e6;
function board(cells) {
  const sum = new Map();
  for (const c of cells) sum.set(c.strike, (sum.get(c.strike) || 0) + c.netGexUsd);
  const byStrike = [...sum.entries()].sort((a, b) => a[0] - b[0]).map(([strike, net]) => ({ strike, netGexUsd: net }));
  const expiries = [...new Set(cells.map(c => c.expiry))].sort().map(expiry => ({ expiry }));
  return { byStrike, grid: { cells, expiries } };
}
const cell = (expiry, strike, m) => ({ expiry, strike, netGexUsd: m * M });
// Eight expiries, as the boards had. The filler expiries peak well away from the strikes under test.
const EXP = ['2026-09-23', '2026-09-25', '2026-09-30', '2026-10-02', '2026-10-16', '2026-10-30', '2026-11-20', '2026-12-18'];
const filler = (spot, skip = []) => EXP.filter(e => !skip.includes(e)).flatMap(e => [
  cell(e, Math.round(spot + 40), 4), cell(e, Math.round(spot - 45), -1),
]);

// ── 22 SEP: SPOT 743.8 — THE PIN CALLED A WALL ───────────────────────────────
{
  const spot = 743.8, atr = 9;
  const b = board([
    cell('2026-10-16', 700, -175), cell('2026-10-16', 730, 60), cell('2026-10-16', 740, 50), cell('2026-10-16', 750, 40),
    cell('2026-09-23', 735, -89), cell('2026-09-23', 743, 20), cell('2026-09-23', 745, 80), cell('2026-09-23', 748, 40),
    cell('2026-09-23', 750, 220), cell('2026-09-23', 760, 10),
    ...filler(spot, ['2026-10-16', '2026-09-23']),
  ]);
  const lv = levelsOf({ ...b, spot, atr, callWall: 745 });

  eq('the floor is one ATR when that is wider than 1%', [lv.floor.pts, lv.floor.basis], [9, 'ATR(14)']);
  // 740 is +50M and 0.5% below spot — the old tile's "put wall". It is inside the pin band.
  eq('740 is rejected as inside the pin band', lv.support.rejected.find(r => r.strike === 740)?.why?.startsWith('inside the pin band'), true);
  eq('the support is 730', lv.support.strike, 730);
  eq('with its size, its owner and its distance', [lv.support.netGexUsd, lv.support.expiry, lv.support.pctBelow], [60 * M, '2026-10-16', 1.9]);
  eq('and the peak count out of eight', [lv.support.peaks, lv.support.of], [1, 8]);
  eq('the tile text', lv.text.support, '730 · +60M Oct-16 · peaks 1 of 8 · 1.9% below');
  eq('the near trapdoor is 735, that day\'s expiry', [lv.trapdoor.near.strike, lv.trapdoor.near.netGexUsd, lv.trapdoor.near.expiry], [735, -89 * M, '2026-09-23']);
  eq('the deep trapdoor is 700, Oct-16', [lv.trapdoor.deep.strike, lv.trapdoor.deep.netGexUsd, lv.trapdoor.deep.expiry], [700, -175 * M, '2026-10-16']);
  eq('the trapdoor tile', lv.text.trapdoor, '735 · −89M (Sep-23) · 1.2% below · deeper: 700 · −175M (Oct-16) · 5.9% below');
  eq('the pin box is 743–748', [lv.pin.pinned, lv.pin.lo, lv.pin.hi], [true, 743, 748]);
  ok('carrying roughly 40% of the nearest expiry', lv.pin.share > 30 && lv.pin.share < 45);
  eq('with the magnets above spot named', lv.pin.magnets, [745, 748]);
  ok('the pin tile', /^743–748 · Sep-23 \d+(\.\d)?% · magnets 745\/748 above spot$/.test(lv.text.pin));
  eq('the call wall at 745 is a ceiling, inside the pin band', [lv.callWall.kind, lv.callWall.inPin], ['ceiling', true]);
  eq('the call wall tile', lv.text.callWall, '745 · ceiling (above spot, inside the pin band)');
  // −$0.14B below against +$0.41B above on this fixture: the smaller side is under 40%.
  eq('the balance is asymmetric, upside damped', lv.balance.state, 'asymmetric_up');
  ok('and says so with the direction', /asymmetric — \$0\.41B above \/ −\$0\.14B below: upside damped, downside thin/.test(lv.balance.sentence));
  eq('the one-line summary reads the objects', lv.summary, 'Cushion at 730; acceleration below 735 and 700; pin 743–748.');
  ok('and the detailed line carries sizes and owners', /Cushion at 730 \(\+60M, Oct-16, 1\.9% below, peaks 1 of 8\); acceleration below 735 \(−89M, Sep-23, 1\.2% below\) and 700 \(−175M, Oct-16, 5\.9% below\); pin 743–748/.test(regimeDetail(lv)));
  ok('the word "wall" never touches the put side', !/wall/i.test(lv.text.support + lv.text.trapdoor + lv.text.pin));
  // What is persisted.
  eq('the log row', levelsLog(lv, { rate: 0.038, rateStatus: 'live' }), {
    put_support_strike: 730, trapdoor_near: 735, trapdoor_deep: 700, pin_lo: 743, pin_hi: 748,
    call_wall_strike: 745, call_wall_kind: 'ceiling', balance_state: 'asymmetric_up', rf_rate: 0.038, rf_status: 'live' });
  // The strikes the table may never drop.
  const m = mustShow(lv, { flipZoneLo: 711, flipZoneHi: 736 });
  eq('the must-show list is the level strikes', m.strikes.sort((a, b) => a - b), [700, 730, 735, 743, 745, 748]);
  eq('with the flip zone alongside', m.flipZone, { lo: 711, hi: 736 });
}

// ── 17 SEP: SPOT 716 — 715 IS A MAGNET, 700 A TRAPDOOR, NO SUPPORT ───────────
{
  const spot = 716, atr = 8;
  const b = board([
    cell('2026-09-17', 715, 140), cell('2026-09-17', 710, 10), cell('2026-09-17', 720, 30),
    cell('2026-10-16', 700, -160), cell('2026-10-16', 725, 20),
    ...filler(spot, ['2026-09-17', '2026-10-16']).filter(c => c.expiry !== '2026-09-23'),
  ]);
  const lv = levelsOf({ ...b, spot, atr, callWall: 715 });
  eq('a positive node below spot is a magnet, not a wall', [lv.callWall.strike, lv.callWall.kind], [715, 'magnet']);
  eq('the tile says so', lv.text.callWall, '715 · magnet (below spot, inside the pin band)');
  eq('no put support inside 5%', [lv.support.strike, lv.support.reason], [null, 'no put support inside 5%']);
  eq('the tile prints the honest blank', lv.text.support, 'no put support inside 5%');
  eq('700 is the trapdoor', [lv.trapdoor.near?.strike, lv.trapdoor.deep, lv.trapdoor.sameStrike], [700, null, true]);
  eq('and it is logged as both near and deep', [levelsLog(lv).trapdoor_near, levelsLog(lv).trapdoor_deep], [700, 700]);
}

// ── 18 SEP: SPOT 721 — 716 NEAR, 700 DEEP, BOTH MATTERED ─────────────────────
{
  const spot = 721, atr = 8;
  const b = board([
    cell('2026-09-18', 716, -118), cell('2026-09-18', 715, -64), cell('2026-09-18', 725, 70),
    cell('2026-10-16', 700, -191), cell('2026-10-16', 730, 40),
    ...filler(spot, ['2026-09-18', '2026-10-16']).filter(c => c.expiry !== '2026-09-23'),
  ]);
  const lv = levelsOf({ ...b, spot, atr, callWall: 725 });
  // 700 is 2.9% below spot — INSIDE the 3% band — and more negative than 716. "Most negative inside
  // 3%" would have returned 700 twice. The near trapdoor is the NEAREST material node.
  eq('the near trapdoor is 716', [lv.trapdoor.near.strike, lv.trapdoor.near.netGexUsd], [716, -118 * M]);
  eq('the deep trapdoor is 700', [lv.trapdoor.deep.strike, lv.trapdoor.deep.netGexUsd], [700, -191 * M]);
  ok('715 at −64M is material but not nearer', Math.abs(-64 * M) >= 191 * M * TRAPDOOR_MIN_FRAC);
  eq('no support', lv.support.strike, null);
  // −$0.37B below, +$0.16B above on this fixture — but the point is the wording, whichever side.
  ok('the balance line is asymmetric with a direction', /^Gamma is asymmetric — .*: (downside amplified, upside thin|upside damped, downside thin)\.$/.test(lv.balance.sentence));
  ok('and never "roughly balanced"', !/roughly balanced/.test(lv.balance.sentence));
}

// ── 21 SEP: SPOT 729 — 700 IS A SUM NO EXPIRY PEAKS AT ───────────────────────
{
  const spot = 729, atr = 8;
  // 700 carries a little negative gamma from every expiry and is nobody's peak; each expiry's own
  // negative peak sits elsewhere.
  const b = board([
    ...EXP.map((e) => cell(e, 700, -22)),
    ...EXP.map((e, i) => cell(e, 690 - i, -30)),
    cell('2026-09-21', 717, -60), cell('2026-09-21', 735, 70), cell('2026-10-16', 745, 50),
  ]);
  const lv = levelsOf({ ...b, spot, atr, callWall: 735 });
  eq('700 is nobody\'s peak', peaksAt(b.grid, 700, -1).agree, 0);
  ok('and it is not the support — it is negative', lv.support.strike !== 700);
  eq('it appears as the deep trapdoor', lv.trapdoor.deep.strike, 700);
  eq('with the day\'s negative at 717 as the near one', lv.trapdoor.near.strike, 717);
}

// ── THE SUPPORT TESTS, ONE AT A TIME ─────────────────────────────────────────
{
  const spot = 700, atr = 5;
  // The far strikes live in another expiry, so the node under test can be its own expiry's peak.
  const base = (extra) => board([cell('2026-09-25', 660, -50), cell('2026-09-25', 720, 90), ...extra]);
  // Passes every test.
  const good = putSupport(base([cell('2026-10-16', 690, 40)]).byStrike, base([cell('2026-10-16', 690, 40)]).grid, { spot, atr });
  eq('a positive node 1.4% below, peaking in an expiry, is support', good.strike, 690);
  // Sign: a negative node never qualifies whatever its size.
  const neg = base([cell('2026-10-16', 690, -400)]);
  eq('a negative node is never support', putSupport(neg.byStrike, neg.grid, { spot, atr }).strike, null);
  // Distance: inside max(1%, ATR) is the pin band.
  const close = base([cell('2026-10-16', 696, 40)]);
  eq('a node inside one ATR is inside the pin band', putSupport(close.byStrike, close.grid, { spot, atr }).rejected[0].why.startsWith('inside the pin band'), true);
  eq('the floor is 1% when the ATR is narrower', distanceFloor(700, 3), { pts: 7, pct: 1, basis: '1%' });
  eq('and says so when no ATR is supplied', distanceFloor(700, null).basis, '1% (no ATR supplied)');
  // Peak: a node no expiry peaks at is a sum.
  const nopeak = board([cell('2026-09-25', 660, -50), cell('2026-09-25', 720, 90), cell('2026-10-16', 690, 40), cell('2026-10-16', 685, 41)]);
  const np = putSupport(nopeak.byStrike, nopeak.grid, { spot, atr });
  eq('the expiry\'s peak wins; the other positive node is a sum', [np.strike, np.rejected.find(r => r.strike === 690)?.why], [685, 'no expiry peaks there (0 of 2)']);
  // Beyond 5%.
  const far = base([cell('2026-10-16', 662, 40)]);
  const fr = putSupport(far.byStrike, far.grid, { spot, atr });
  ok('beyond 5% is out', fr.strike == null && /beyond 5%/.test(fr.rejected[0].why));
  // Share: under 5% of below-spot positive gamma.
  const tiny = board([cell('2026-10-16', 660, -50), cell('2026-10-16', 720, 90), cell('2026-09-25', 690, 1), cell('2026-10-16', 695, 200)]);
  const ty = putSupport(tiny.byStrike, tiny.grid, { spot, atr: 3 });
  ok('a node under 5% of the positive gamma below spot is out', ty.rejected.find(r => r.strike === 690)?.why?.startsWith('under 5%'));
  eq('the thresholds are stated', [SUPPORT_MIN_DIST_PCT, SUPPORT_MAX_DIST_PCT, SUPPORT_MIN_SHARE, TRAPDOOR_NEAR_PCT, TRAPDOOR_DEEP_PCT, PIN_HALF_PCT, PIN_MIN_SHARE, BALANCE_MIN_RATIO],
     [1, 5, 0.05, 3, 10, 0.5, 0.1, 0.4]);
  // Degenerate inputs.
  eq('no spot, no support', putSupport([], null, { spot: null }).strike, null);
  eq('no strikes below spot', putSupport([{ strike: 710, netGexUsd: 1 }], null, { spot: 700 }).reason, 'no strikes below spot');
  eq('no negatives, no trapdoor', trapdoors([{ strike: 690, netGexUsd: 5 }], null, { spot: 700 }), { near: null, deep: null, sameStrike: false });
  eq('no grid, no pin', pinBox([], null, { spot: 700 }).pinned, false);
  eq('a levels call with nothing does not throw', levelsOf({ spot: null }).support.strike, null);
  eq('callWallOf finds the heaviest call side when no wall is passed', callWallOf([{ strike: 705, callGamma: 5, netGexUsd: 1 }, { strike: 710, callGamma: 9, netGexUsd: 2 }], null, { spot: 700 }).strike, 710);
}

// ── THE PIN BOX ──────────────────────────────────────────────────────────────
{
  const spot = 700;
  const b = board([cell('2026-09-23', 698, 30), cell('2026-09-23', 702, 50), cell('2026-09-23', 720, 20), cell('2026-10-16', 700, 5)]);
  const p = pinBox(b.byStrike, b.grid, { spot, atr: 4 });
  eq('the box is ±0.5% or ±½ ATR, whichever is wider', p.half, 3.5);
  eq('and spans the front expiry\'s strikes inside it', [p.lo, p.hi, p.pinned], [698, 702, true]);
  eq('the share is of the NEAREST expiry only', p.share, 80);
  eq('magnets are the positive nodes above spot inside the box', p.magnets, [702]);
  const thin = board([cell('2026-09-23', 698, 1), cell('2026-09-23', 720, 200)]);
  const t = pinBox(thin.byStrike, thin.grid, { spot, atr: 4 });
  ok('under a tenth of the nearest expiry is no pin, and says why', !t.pinned && /Sep-23 carries 0% inside/.test(t.reason));
  eq('the tile carries the reason', pinText(t).startsWith('no pin — '), true);
}

// ── BALANCE WITH A DIRECTION ─────────────────────────────────────────────────
{
  // The four printed cases, every one of which the old line called "roughly balanced".
  for (const [below, above] of [[-0.16e9, 6.97e9], [-0.34e9, 6.79e9], [-0.60e9, 6.17e9]]) {
    const b = balanceOf({ above, below });
    eq(`${(below / 1e9).toFixed(2)}/${(above / 1e9).toFixed(2)} is asymmetric_up`, b.state, 'asymmetric_up');
  }
  eq('the 22 Sep sentence', balanceOf({ above: 6.17e9, below: -0.60e9 }).sentence, 'Gamma is asymmetric — $6.17B above / −$0.60B below: upside damped, downside thin.');
  eq('40% exactly is balanced', balanceOf({ above: 1e9, below: 0.4e9 }).state, 'balanced');
  eq('39% is not', balanceOf({ above: 1e9, below: 0.39e9 }).state, 'asymmetric_up');
  eq('a heavy negative below is downside amplified', balanceOf({ above: 0.2e9, below: -3e9 }).state, 'asymmetric_down');
  ok('with the words', /downside amplified, upside thin/.test(balanceOf({ above: 0.2e9, below: -3e9 }).sentence));
  ok('a heavy positive below is a cushion', /downside cushioned, upside thin/.test(balanceOf({ above: 0.2e9, below: 3e9 }).sentence));
  ok('a heavy negative above is upside amplified', /upside amplified, downside thin/.test(balanceOf({ above: -3e9, below: 0.2e9 }).sentence));
  eq('missing sides make no claim', balanceOf({}).state, null);
  eq('both zero is balanced', balanceOf({ above: 0, below: 0 }).state, 'balanced');
  // Through the read.
  const rd = gexRead({ row: { spot: 743.8, flipLevel: 720.5, flipZoneLo: 711, flipZoneHi: 736, callWall: 745, gexUsd: 5.5e9, asOf: '2026-09-22T13:40:00Z' },
    byStrike: [{ strike: 700, netGexUsd: -0.6e9 }, { strike: 760, netGexUsd: 6.17e9 }], now: new Date('2026-09-22T14:00:00Z'), live: true });
  ok('the read prints the asymmetric sentence', rd.lines.some(l => /asymmetric — \$6\.17B above \/ −\$0\.60B below: upside damped, downside thin/.test(l)));
  ok('and never "roughly balanced" for it', !rd.lines.some(l => /roughly balanced/.test(l)));
  eq('and exposes the state', rd.balance, 'asymmetric_up');
  ok('the read carries the levels', rd.levels && 'support' in rd.levels);
}

// ── THE RATE: LIVE, STALE, UNAVAILABLE — NEVER 0.00 ──────────────────────────
{
  const store = {};
  const kv = { get: async (k) => store[k] ?? null, set: async (k, v) => { store[k] = v; } };
  const live = await riskFreeRate({ fred: async () => ({ value: 3.80, date: '2026-09-22' }), kv, now: new Date('2026-09-22T12:00:00Z') });
  eq('a live print is live', [live.rate, live.status, live.source], [0.038, 'live', 'DTB3 2026-09-22']);
  eq('and is kept as the last good print', store[RF_KEY]?.value, 3.80);
  const stale = await riskFreeRate({ fred: async () => { throw new Error('HTTP 429'); }, kv });
  eq('a failed fetch serves the last good print, marked stale', [stale.rate, stale.status, stale.date], [0.038, 'stale', '2026-09-22']);
  const zero = await riskFreeRate({ fred: async () => ({ value: 0, date: '2026-09-23' }), kv });
  eq('a zero print is a failure, not a value', [zero.rate, zero.status], [0.038, 'stale']);
  const empty = await riskFreeRate({ fred: async () => ({ value: null, date: null }), kv: { get: async () => null, set: async () => {} } });
  eq('nothing at all is unavailable, with a null rate', [empty.rate, empty.status], [null, 'unavailable']);
  // The line the panel prints.
  eq('live prints the value', rateLine({ rate: 0.038, rateSource: 'DTB3 2026-09-22', rateStatus: 'live' }), ' Risk-free rate 3.80% (DTB3 2026-09-22).');
  ok('stale prints the value dated and says stale', /3\.80% \(DTB3 2026-09-16, stale — FRED did not answer, last good print\)/.test(rateLine({ rate: 0.038, rateSource: 'DTB3 2026-09-16 (stale)', rateStatus: 'stale' })));
  ok('unavailable never prints 0.00', !/0\.00/.test(rateLine({ rate: null, rateStatus: 'unavailable' })) && /unavailable/.test(rateLine({ rate: null, rateStatus: 'unavailable' })));
  ok('a legacy row with rate 0 and no status is treated as unavailable', /unavailable/.test(rateLine({ rate: 0, rateSource: 'DTB3 2026-09-16' })));
  ok('a legacy row with a real rate and no status is live', /4\.02% \(DTB3 2026-09-21\)/.test(rateLine({ rate: 0.0402, rateSource: 'DTB3 2026-09-21' })));
  eq('the far-dated columns are the ones 35+ days out', [rateFarOut('2026-11-20', Date.parse('2026-09-23')), rateFarOut('2026-10-16', Date.parse('2026-09-23')), RATE_FAR_DAYS], [true, false, 35]);
  // The settled rung priced at r = 0 with nothing saying so: the store's own paths now go through
  // riskFreeRate, and the literal `rate ?? 0` default is gone from the settled rung.
  const storeSrc = readFileSync('lib/gexStore.js', 'utf8');
  ok('the settled rung fetches a rate', /const rf = rate != null \? \{ rate, status: 'live', source: null \} : await riskFreeRate/.test(storeSrc));
  ok('the capture path goes through the same helper', /const rf = await riskFreeRate\(\{ now \}\)/.test(storeSrc));
  ok('and the old silent DTB3 try-block is gone', !/const dtb3 = await fredLatest\('DTB3'\)/.test(storeSrc));
  // ATR from bars, without a store.
  const bars = Array.from({ length: 40 }, (_, i) => ({ date: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}`, open: 700, high: 706, low: 696, close: 701 + (i % 3), volume: 1 }));
  const a = await atr14('QQQ', { bars, kv: { get: async () => null, setEx: async () => {} } });
  ok('atr14 returns a positive ATR from bars', a?.atr > 0);
}

// ── THE STRIKE TABLE CANNOT HIDE THE FLIP ZONE ───────────────────────────────
{
  // Three expiries. The front carries big cells at 700–760; the back month's whole book sits at
  // 715–719, which is light against the front and is exactly where the flip zone is.
  const cells = [];
  for (let k = 600; k <= 800; k += 5) cells.push({ expiry: '2026-09-23', strike: k, netGexUsd: 50e6 + (k % 7) * 1e6 });
  for (let k = 715; k <= 719; k += 1) cells.push({ expiry: '2026-12-18', strike: k, netGexUsd: -4e6 });
  for (let k = 650; k <= 750; k += 25) cells.push({ expiry: '2026-10-16', strike: k, netGexUsd: 8e6 });
  const grid = { cells, expiries: [{ expiry: '2026-09-23' }, { expiry: '2026-10-16' }, { expiry: '2026-12-18' }] };
  const h = heatCells(grid);
  ok('each column\'s own heaviest strikes make the cut', [715, 716, 717].every(k => h.strikes.includes(k)));
  eq('the per-column count is stated', h.perColumn, Math.max(HEAT_MIN_PER_COLUMN, Math.ceil(HEAT_ROWS / 3)));
  // 21 Sep: the flip zone edges, and one strike either side, are always present.
  const z = heatCells(grid, { flipZone: { lo: 711, hi: 736 } });
  ok('the flip-zone edges and their neighbours are kept', [705, 710, 715, 730, 735, 740].every(k => z.strikes.includes(k)));
  ok('and the ones the ranking would have dropped are named', z.added.length > 0 && z.added.every(k => z.strikes.includes(k)));
  // The trapdoor / support strikes are forced in, mapped to the nearest listed strike.
  const t = heatCells(grid, { must: [603, 797.6] });
  ok('must-show strikes are kept', t.strikes.includes(605) && t.strikes.includes(800));
  ok('the table grew rather than dropping something to fit', t.strikes.length >= HEAT_ROWS);
  ok('and comes back high to low', t.strikes.every((k, i, a) => i === 0 || a[i - 1] > k));
  eq('with nothing to force, nothing is added', heatCells(grid).added, []);
}

// ── THE CROSS-CHECK COMPARES LIKE WITH LIKE ──────────────────────────────────
{
  const spot = 743.8;
  const lvNone = { support: { strike: null, rejected: [{ strike: 740, why: 'inside the pin band (1.21% / ATR(14))' }] },
                   trapdoor: { near: { strike: 735 }, deep: { strike: 700 } }, pin: { pinned: true, lo: 743, hi: 748 } };
  const ours = { spot, callWall: 745, putWall: 740, callOi: 1e6, putOi: 1.2e6, oiWeightedIv: 0.21 };
  const base = { spot: 743.5, callWall: 745, callOi: 1e6, putOi: 1.2e6, oiWeightedIv: 0.21 };
  // Their put wall is a negative node → our trapdoor.
  const td = compareGex(ours, { ...base, putWall: 735, putWallNet: -80e6 }, { spot, levels: lvNone });
  const c1 = td.checks.find(c => c.name === 'put wall ↔ trapdoor');
  eq('a negative CBOE put wall is compared to the trapdoor', [c1.state, c1.ours, c1.theirs], ['match', 735, 735]);
  ok('and the line says which comparison was made', /compared to our trapdoor/.test(c1.detail));
  // Their put wall is positive and we show no support → context, not ✗.
  const pin = compareGex(ours, { ...base, putWall: 745, putWallNet: 60e6 }, { spot, levels: lvNone });
  const c2 = pin.checks.find(c => c.name === 'put wall ↔ put support');
  eq('no qualifying support on our side is context, unscored', [c2.state, c2.score], ['context', false]);
  ok('and names where their strike sits on our map', /CBOE put wall 745 — we show no qualifying support; their 745 is inside our pin box 743–748/.test(c2.detail));
  ok('so the verdict is not a disagreement about the put side', !/put wall/.test(pin.verdict));
  const rej = compareGex(ours, { ...base, putWall: 740, putWallNet: 50e6 }, { spot, levels: lvNone });
  ok('a rejected candidate names the failed test', /their 740 fails our support test — inside the pin band/.test(rej.checks.find(c => c.name === 'put wall ↔ put support').detail));
  const tdk = compareGex(ours, { ...base, putWall: 700, putWallNet: 5e6 }, { spot, levels: lvNone });
  ok('their positive strike on our trapdoor says so', /their 700 is our trapdoor/.test(tdk.checks.find(c => c.name === 'put wall ↔ put support').detail));
  // Both positive, both solved → an ordinary wall comparison under the new name.
  const both = compareGex(ours, { ...base, putWall: 730, putWallNet: 60e6 }, { spot, levels: { ...lvNone, support: { strike: 730 } } });
  eq('positive against our support is scored', both.checks.find(c => c.name === 'put wall ↔ put support').state, 'match');
  // Without levels the legacy comparison still runs, for the stored series.
  eq('no levels: the legacy put-wall check', compareGex(ours, { ...base, putWall: 740 }, { spot }).checks.find(c => c.name === 'put wall').state, 'match');
  eq('CBOE did not solve one', compareGex(ours, { ...base, putWall: null }, { spot, levels: lvNone }).checks.find(c => c.name === 'put wall ↔ put support').state, 'unknown');
  // cboeSummary carries the sign at their wall.
  const s = cboeSummary([
    { type: 'put', strike: 735, oi: 5000, gamma: 0.02, iv: 0.2 }, { type: 'call', strike: 735, oi: 500, gamma: 0.02, iv: 0.2 },
    { type: 'call', strike: 750, oi: 4000, gamma: 0.02, iv: 0.2 },
  ], 743.8);
  ok('their put wall carries its net sign', s.putWall === 735 && s.putWallNet < 0 && s.callWallNet > 0);
}

// ── THE LADDER: THE 23 SEP BOARD, AS A DAY TRADER READS IT ───────────────────
// spot 746.06, negative from 745 down to 740 in today's expiry, 750 the ceiling, Friday's box
// 745–755 with 740 under it, Oct-02's −340M at 730, Oct-16's cushion at 726.
{
  const spot = 746.06, atr = 8;
  const b = board([
    cell('2026-09-23', 745, -110), cell('2026-09-23', 743, -175), cell('2026-09-23', 742, -98), cell('2026-09-23', 740, -50),
    cell('2026-09-23', 748, 205), cell('2026-09-23', 750, 244), cell('2026-09-23', 752, 118),
    cell('2026-09-25', 755, 241), cell('2026-09-25', 750, 250), cell('2026-09-25', 748, 111), cell('2026-09-25', 740, -109),
    cell('2026-10-02', 730, -340), cell('2026-10-02', 748, 145),
    cell('2026-10-16', 726, 60), cell('2026-10-16', 700, -165),
    cell('2026-11-20', 760, 492),
  ]);
  b.grid.expiries = [{ expiry: '2026-09-23', shareOfAbs: 11.3 }, { expiry: '2026-09-25', shareOfAbs: 22.5 }, { expiry: '2026-10-02', shareOfAbs: 2.6 }, { expiry: '2026-10-16', shareOfAbs: 33.2 }, { expiry: '2026-11-20', shareOfAbs: 30.4 }];
  const lv = levelsOf({ ...b, spot, atr, callWall: 750 });

  // The stack: 745, 743, 742, 740 are contiguous negatives right under spot; 730 is next and
  // negative too, so the run continues to it; 726 is the first positive node.
  const st = negativeStack(b.byStrike, { spot });
  eq('the run of negatives under spot', [st.hi, st.lo, st.touching], [745, 730, true]);
  eq('the next positive node ends the air', [st.nextPositive.strike, st.airPct], [726, 2.5]);
  eq('touching means inside the pin half-width', STACK_TOUCH_PCT, 0.6);
  eq('a positive first strike is no stack', negativeStack([{ strike: 745, netGexUsd: 5 }, { strike: 740, netGexUsd: -5 }], { spot: 746 }).strikes, []);

  const nodes = ladderNodes(b.byStrike, b.grid, { spot, levels: lv, callWall: 750, pivotAfter: 733.96, today: '2026-09-23' });
  // 752 (+118M) is the fifth-heaviest inside 2.5% and the ladder keeps four.
  eq('above: the heaviest positive nodes inside 2.5%, ascending', nodes.above.map(n => n.strike), [748, 750, 755, 760]);
  eq('the call wall is marked with its peak count', [nodes.above[1].wall, nodes.above[1].peaks.agree], [true, 2]);
  eq('the owner is named', nodes.above[2].expiry, '2026-09-25');
  // 742 (−98M) is the fifth negative inside 3%; the four heaviest, the trapdoors, the pivot and the
  // cushion make the line.
  eq('below: negatives, the deep trapdoor, the pivot and the cushion, descending',
     nodes.below.map(n => `${n.strike}:${n.kind}`), ['745:negative', '743:negative', '740:negative', '733.96:pivot', '730:negative', '726:support']);

  const row = { name: 'QQQ', spot, callWall: 750, putWall: lv.support.strike, flipLevel: 740.80, flipZoneLo: 712.76, flipZoneHi: 740.80,
                levels: lv, byStrike: b.byStrike, grid: b.grid, iv: 0.217, pin: { pinned: false, share: 11.3, near: false },
                decay: { expiringToday: true, front: '2026-09-23', after: { flip: 733.96 } } };
  const L = renderLadder(row, { today: '2026-09-23' });
  ok('the heading carries the regime and the zone', /^__\*\*QQQ\*\* 746\.06__ · positive gamma, moves damp · low confidence, flip zone 28 wide/.test(L.head));
  const line = (label) => L.lines.find(l => l.startsWith(label));
  eq('eight lines at most', L.lines.length <= 8, true);
  ok('above', /^above {2}748 \(today\) · 750 \(2 of 5, ceiling\) · 755 \(Sep-25\) · 760 \(Nov-20\) {4}cap 748–760$/.test(line('above')));
  eq('spot', line('spot'), 'spot   746.06');
  ok('below, nearest first, sizes and owners', /^below {2}745 \(−110M today\) · 743 \(−175M today\) · 740 \(−159M Sep-25\) · 733\.96 \(pivot after today\) · 730 \(−340M Oct-02\) · 726 \(\+60M Oct-16, cushion, peaks 1 of 5\)$/.test(line('below')));
  ok('the stack line is the new sentence', /^stack {2}negative 730–745 directly under spot: through 745 hedging accelerates, 2\.5% of air to 726 \(\+60M Oct-16\)$/.test(line('stack')));
  ok('pin and priced-for on one line', /^pin {4}none today \(11\.3% expires, away from spot\) · priced for ±10\.2 \(±1\.37%\)$/.test(line('pin')));
  ok('the book line names what the balance does', /^book {3}−\$[\d.]+B below \/ \+\$[\d.]+B above: (balanced either side|rallies absorbed into 750, dips extend|dips accelerate, rallies thin)$/.test(line('book')));
  ok('after: the pivot once today is gone, and Friday\'s box', /^after {2}today's expiry: pivot 740\.80 → 733\.96 · Sep-25 box 748–755, 740 \(−109M\) under it$/.test(line('after')));
  ok('never "wall" on the put side', !/put wall/i.test(L.lines.join(' ')));

  // The section: heading outside the fence, ladder inside it, the caveat once, the footer once.
  const out = renderGexSection([row, { ...row, name: 'SPY' }], { rung: 'occ', asOf: '2026-09-23T12:00:00Z', today: '2026-09-23' });
  const lines = out.split('\n');
  ok('the heading is outside the fence, so the bold renders', lines.indexOf(L.head) < lines.indexOf('```'));
  eq('one fence per instrument', lines.filter(l => l === '```').length, 4);
  eq('the caveat is said once', out.split('one day in three').length - 1, 1);
  ok('QQQ before SPY', out.indexOf('**QQQ**') < out.indexOf('**SPY**'));
  ok('the rung footer survives', /today's settled open interest \(OCC\)/.test(out));
  ok('no horizontal map remains', !/`P` put|`C` call|·····/.test(out));
  // Every line is observational.
  for (const l of L.lines) { let bad = null; try { assertObservational(l); } catch (e) { bad = e; } ok(`observational: ${l.slice(0, 32)}…`, !bad); }

  // Words for the book line.
  ok('upside-heavy positive', /rallies absorbed into 750, dips extend/.test(bookWords({ balance: { state: 'asymmetric_up', above: 5.18e9, below: -1.69e9 } }, 750)));
  ok('downside-heavy negative', /dips accelerate, rallies thin/.test(bookWords({ balance: { state: 'asymmetric_down', above: 0.2e9, below: -3e9 } }, 750)));
  ok('downside-heavy positive names the cushion', /dips cushioned at 726, rallies thin/.test(bookWords({ balance: { state: 'asymmetric_down', above: 0.2e9, below: 3e9 }, support: { strike: 726 } }, 750)));
  eq('no balance, no line', bookWords(null), null);
  // The next box prefers the coming week over the month's heaviest expiry.
  const nb = nextBox(b.grid, { spot, today: '2026-09-23' });
  eq('Friday wins over Oct-16 inside the week', [nb.expiry, nb.lo, nb.hi, nb.heaviestNegative.strike], ['2026-09-25', 748, 755, 740]);
  eq('no grid, no box', nextBox(null, { spot }), null);
  // The regime words.
  ok('inside the zone is no regime', /at the flip, no regime/.test(regimeWords({ spot: 720, flipLevel: 718, flipZoneLo: 712, flipZoneHi: 722 })));
  ok('a tight zone quotes the flip', /flip 718\.00 \(zone 2\.0 wide\)/.test(regimeWords({ spot: 730, flipLevel: 718, flipZoneLo: 717, flipZoneHi: 719 })));
  ok('below is negative gamma', /negative gamma, moves extend/.test(regimeWords({ spot: 700, flipLevel: 718, flipZoneLo: 717, flipZoneHi: 719 })));

  // A legacy row without per-strike rows still renders a ladder from the two walls it has.
  const legacy = renderLadder({ name: 'QQQ', spot: 718.36, putWall: 700, callWall: 720, flipLevel: 718.83, pin: { pinned: false } }, { today: '2026-09-09' });
  ok('legacy above', /^above {2}720\.00 \(call wall\)$/.test(legacy.lines[0]));
  ok('legacy below never calls the put side a wall', /^below {2}700\.00 \(heaviest put strike\)$/.test(legacy.lines[2]));
  // A closed session renders the heading only, then the handoff lines.
  const closed = renderGexSection([row], { rung: 'stored', tense: 'closed', today: '2026-09-23' });
  ok('closed: heading and where it finished', /closed above its pivot/.test(closed) && !/```/.test(closed));

  // The health sample carries the levels.
  const hs = healthSample({ ok: true, levels: lv, row: { rate: 0.038, rateStatus: 'live' }, vintage: {}, oi: {}, crossCheck: null }, { symbol: 'QQQ' });
  eq('the health sample logs the levels', [hs.put_support_strike, hs.trapdoor_near, hs.trapdoor_deep, hs.call_wall_kind, hs.rf_status], [726, 745, 730, 'ceiling', 'live']);
}

// ── THE PANEL WEARS THE VOCABULARY ───────────────────────────────────────────
{
  const src = readFileSync('src/GexPanel.jsx', 'utf8');
  ok('three put-side tiles', /label="Put support"/.test(src) && /label="Trapdoor"/.test(src) && /label="Pin box"/.test(src));
  ok('the call wall tile carries its kind', /lv\.callWall\.kind/.test(src));
  ok('the rate line comes from the tested helper', /\{rateLine\(latest\)\}/.test(src) && !/No risk-free rate on this row/.test(src));
  ok('far-dated columns grey when the rate is unavailable', /rateOut && rateFarOut\(e\)/.test(src));
  ok('the heatmap is fed the must-show strikes and the flip zone', /heatCells\(grid, \{ must: m\.strikes, flipZone: m\.flipZone \}\)/.test(src));
  ok('the expiry badge names the object', /"trapdoor"/.test(src) && /"support"/.test(src) && !/"put wall"/.test(src));
  eq('helpers', [shortExpiry('2026-10-16'), fmtM(-89e6), fmtM(1.2e9), supportText(null), trapdoorText(null), callWallText(null)],
     ['Oct-16', '−89M', '+1.20B', 'no put support', 'no negative node below spot inside 10%', '—']);
  eq('the summary handles an empty levels object', regimeLine({}), 'Cushion: none inside 5%; no acceleration node below spot; no pin.');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
