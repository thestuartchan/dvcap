// test/inflationAxis.test.mjs — the inflation axis and the measured quadrant.
import { marketInflation, nowcastInflation, printedInflation, inflationAxis, CORE_HOT, CORE_AT_TARGET, BE_HOT, BE_COLD, OIL_LOOKBACK, OIL_EXIT_PCT, BE_EXIT_BP, heldScore } from '../lib/inflationAxis.js';
import { measuredQuadrant, axisLean, measuredAxes, axesLogRow } from '../lib/quadrant.js';
import { regimeLogRow, regimeSnapshot } from '../lib/regimeEngine.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);
const NOW = new Date('2026-09-14T14:00:00Z');
function daily(endDate, n, gen) {
  const out = []; const d = new Date(endDate + 'T00:00:00Z'); let i = n - 1;
  while (out.length < n) { const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) { out.unshift({ date: d.toISOString().slice(0, 10), value: gen(i, n) }); i--; } d.setUTCDate(d.getUTCDate() - 1); }
  return out;
}
const fred = (id, history) => ({ id, ok: true, verified: true, mismatch: null, value: history.at(-1).value, date: history.at(-1).date, history });

// ── MARKET: BREAKEVENS ARE LEVELS, OIL IS AN IMPULSE ─────────────────────────
{
  const be5 = fred('T5YIE', daily('2026-09-11', 30, (i, n) => i >= n - 1 ? 2.62 : 2.50));
  const be10 = fred('T10YIE', daily('2026-09-11', 30, () => 2.30));
  const oil = { ok: true, series: daily('2026-09-11', 45, (i, n) => i >= n - 1 ? 72 : 65) };
  const p = marketInflation({ be5, be10, oil }, { now: NOW });
  const b5 = p.legs.find(l => l.key === 'be5'), b10 = p.legs.find(l => l.key === 'be10'), o = p.legs.find(l => l.key === 'oil');
  eq(`a 5Y breakeven at 2.62 is above ${BE_HOT} — hot`, b5.score, 1);
  eq('with the 20-session trend in basis points', b5.trendBp, 12);
  eq(`2.30 sits between ${BE_COLD} and ${BE_HOT}`, b10.score, 0);
  eq(`oil +10.8% over ${OIL_LOOKBACK} sessions is an impulse`, [o.score, o.change], [1, 10.8]);
  ok('the oil flip is the exit level from the base — the impulse lasts until the move is back inside ±5%', /WTI back below \$68/.test(o.flip));
  eq('two hot, one between reads HOT', [p.verdict, p.status, p.lean], ['HOT', 'ELEVATED', 1]);
  ok('the words are inflation words', /hot/.test(p.read) && /between/.test(p.read));
  const cool = marketInflation({ be5: fred('T5YIE', daily('2026-09-11', 30, () => 1.9)), be10: fred('T10YIE', daily('2026-09-11', 30, () => 1.95)), oil: { ok: true, series: daily('2026-09-11', 45, (i, n) => i >= n - 1 ? 58 : 65) } }, { now: NOW });
  eq('all three cool reads COLD, confirmed', [cool.verdict, cool.agreement, cool.lean], ['COLD', 'confirmed', -1]);
  ok('and says at or below target', /at or below target/.test(cool.read));
  const stale = marketInflation({ be5: fred('T5YIE', daily('2026-09-01', 30, () => 2.6)) }, { now: NOW });
  eq('a breakeven nine business days old is a broken feed, excluded', stale.legs.find(l => l.key === 'be5').available, false);
}

// ── NOWCAST: THE CLEVELAND FED, DATED BY ITS FILE ────────────────────────────
{
  const cl = { ok: true, asOf: '2026-09-11', period: '2026-09', cpi: 3.43, coreCpi: 2.39, pce: 3.89, corePce: 3.49,
               prior: { period: '2026-08', coreCpi: 2.32, coreCpiActual: 2.45, corePce: 3.48, corePceActual: null } };
  const p = nowcastInflation(cl, { now: NOW });
  const c = p.legs.find(l => l.key === 'coreCpi'), e = p.legs.find(l => l.key === 'corePce');
  eq(`core CPI 2.39 is at or below ${CORE_AT_TARGET}`, c.score, -1);
  eq(`core PCE 3.49 is above ${CORE_HOT}`, e.score, 1);
  ok('the read names the month and the level', /Core CPI nowcast 2\.39% y\/y for 2026-09, at or below 2\.5/.test(c.read));
  ok('and last month\'s miss against its nowcast', /came in \+0\.1pp vs its nowcast/.test(c.read));
  ok('no miss line when the actual has not printed', !/vs its nowcast/.test(e.read));
  eq('one hot, one cool is BETWEEN', [p.verdict, p.lean], ['BETWEEN', 0]);
  const old = nowcastInflation({ ...cl, asOf: '2026-09-03' }, { now: NOW });
  eq('a nowcast silent for more than five business days is excluded', old.legs[0].available, false);
  eq('an unavailable nowcast excludes both legs with the feed error', nowcastInflation({ ok: false, error: 'HTTP 503' }, { now: NOW }).excluded.map(x => x.reason), ['HTTP 503', 'HTTP 503']);
}

// ── PRINTED: Y/Y LEVELS AND THE 3-MONTH ANNUALISED RATE ──────────────────────
{
  const idx = fred('CPILFESL', Array.from({ length: 16 }, (_, i) => ({ date: `2025-${String(i + 1).padStart(2, '0')}-01`, value: 320 * Math.pow(1.0025, i) })));
  idx.date = '2026-08-01';
  const p = printedInflation({ coreCpiYoY: { value: 3.1, date: '2026-08-01' }, corePceYoY: { value: 3.34, date: '2026-07-01' }, coreCpiIdx: idx }, { now: NOW });
  const m = p.legs.find(l => l.key === 'coreCpi3m');
  eq('0.25% a month annualises to about 3.04%', m.value, 3.04);
  eq('which is hot', m.score, 1);
  eq('three hot prints read HOT, confirmed', [p.verdict, p.agreement], ['HOT', 'confirmed']);
  ok('the y/y legs carry their month', /\(2026-08\)/.test(p.legs[0].read) && /\(2026-07\)/.test(p.legs[1].read));
  eq('a missing print is excluded, not zero', printedInflation({ coreCpiYoY: null }, { now: NOW }).legs[0].available, false);
}

// ── HYSTERESIS: A BAND IS ENTERED AT THE LINE AND LEFT INSIDE A NARROWER ONE ──
{
  const oilOf = vals => ({ ok: true, series: daily('2026-09-11', vals.length, i => vals[i]) });
  const lead = Array(30).fill(65), surge = Array(9).fill(72);   // +10.8% vs 20 sessions earlier
  const oilLeg = vals => marketInflation({ oil: oilOf(vals) }, { now: NOW }).legs.find(l => l.key === 'oil');
  const held = oilLeg([...lead, ...surge, 69.6]);
  eq(`oil back to +7.1% after an impulse is still an impulse — it ends inside ±${OIL_EXIT_PCT}%`, [held.score, held.change, held.held], [1, 7.1, true]);
  ok('and the read says since when and until what', /held since \d{4}-\d{2}-\d{2} \(\+10\.8%\) until the move is back inside ±5%/.test(held.read));
  eq('at +3.8% the impulse is over', oilLeg([...lead, ...surge, 67.5]).score, 0);
  eq('a series that is already +7% when it starts is not invented into an impulse', oilLeg([...Array(20).fill(65), ...Array(5).fill(69.6)]).score, 0);
  eq('a fall works the same way', oilLeg([...lead, ...Array(9).fill(58), 61]).score, -1);
  // The 2026-09-14 → 10-15 window: oil's 20-session change crossing ±10% and back. Without the exit
  // band every crossing is a flip; with it, only entries and exits.
  const walk = [12, 9.6, 11, 9.8, 4, 0, -10.7, -8.2, -7.5, -11, -7.2, -5.2];
  const plainFlips = walk.map(c => c >= 10 ? 1 : c <= -10 ? -1 : 0).filter((v, k, a) => k && v !== a[k - 1]).length;
  const heldFlips = walk.map((_, k) => heldScore(walk.slice(0, k + 1).map(value => ({ value })), { hotIn: 10, hotOut: 5, coldIn: -10, coldOut: -5 }).score)
    .filter((v, k, a) => k && v !== a[k - 1]).length;
  eq('a walk that crosses the line seven times flips twice with the exit band', [plainFlips, heldFlips], [7, 2]);

  const beOf = vals => fred('T5YIE', daily('2026-09-11', 30, (i, n) => vals[i - (n - vals.length)] ?? 2.30));
  const b = v => marketInflation({ be5: beOf(v) }, { now: NOW }).legs.find(l => l.key === 'be5');
  const bh = b([2.52, 2.47]);
  eq(`a breakeven back to 2.47 after 2.52 stays hot until it is ${BE_EXIT_BP}bp inside the line`, [bh.score, bh.held], [1, true]);
  ok('and the read and flip name 2.45, not a rounded 2.5', /until below 2\.45/.test(bh.read) && /below 2\.45/.test(bh.flip));
  eq('at 2.44 it is between again', b([2.52, 2.44]).score, 0);
  eq('a breakeven that never crossed is read on the plain band', [b([2.47]).score, b([2.47]).held], [0, false]);
}

// ── THE AXIS ─────────────────────────────────────────────────────────────────
{
  const V = (verdict, lean) => ({ verdict, label: verdict, lean });
  eq('all hot is confirmed', inflationAxis({ market: V('HOT', 1), nowcast: V('HOT', 1), printed: V('HOT', 1) }).state, 'confirmed');
  const t = inflationAxis({ market: V('COOLING', -1), nowcast: V('BETWEEN', 0), printed: V('HOT', 1) });
  eq('market cool, nowcast between, printed hot — a turn toward cool, in lead order', t.state, 'turning-cool');
  ok('the read names the leading leg against the slowest one, with the in-between leg implied by the turn', /the market reads cool while the printed data still reads hot/.test(t.read));
  ok('and opens with the lean the quadrant takes — neutral when the legs cancel', /^On balance neutral: /.test(t.read) && t.balance === 'between');
  eq('the axis lean is the sign of the sum', t.lean, 0);
  eq('printed hot while both faster legs cool is turning-cool with a cool lean', inflationAxis({ market: V('COLD', -1), nowcast: V('COOLING', -1), printed: V('HOT', 1) }).lean, -1);
  const cooling = inflationAxis({ market: V('BETWEEN', 0), nowcast: V('BETWEEN', 0), printed: V('HOT', 1) });
  eq('printed hot with both faster legs between is turning cool but still leans hot — 2026-10-14', [cooling.state, cooling.lean, cooling.balance], ['turning-cool', 1, 'hot']);
  ok('and the read opens with that lean, so the label and the quadrant never disagree unexplained', /^On balance hot: /.test(cooling.read));
  eq('fast-slow-fast is a split', inflationAxis({ market: V('HOT', 1), nowcast: V('COLD', -1), printed: V('HOT', 1) }).state, 'split');
  eq('nothing usable is insufficient', inflationAxis({}).state, 'insufficient');
}

// ── THE QUADRANT ─────────────────────────────────────────────────────────────
{
  eq('growth up, inflation down is reflationary', measuredQuadrant({ growthLean: 1, inflationLean: -1 }).id, 'ref');
  eq('growth up, inflation up is the inflationary boom', measuredQuadrant({ growthLean: 1, inflationLean: 1 }).id, 'inf');
  eq('growth down, inflation up is stagflation', measuredQuadrant({ growthLean: -1, inflationLean: 1 }).id, 'stag');
  eq('growth down, inflation down is the deflationary recession', measuredQuadrant({ growthLean: -1, inflationLean: -1 }).id, 'def');
  ok('a flat axis is between quadrants, named', measuredQuadrant({ growthLean: 0, inflationLean: 1 }).id === null && /growth axis is flat/.test(measuredQuadrant({ growthLean: 0, inflationLean: 1 }).read));
  ok('a missing axis is no quadrant, named', /inflation axis has no read/.test(measuredQuadrant({ growthLean: 1, inflationLean: null }).read));
  eq('the axis lean sums the legs', [axisLean([{ lean: 1 }, { lean: -1 }, { lean: -1 }]), axisLean([{ lean: null }]), axisLean([])], [-1, null, null]);
}

// ── THE ROW ──────────────────────────────────────────────────────────────────
{
  const ax = measuredAxes({}, { now: NOW });
  const row = axesLogRow(ax);
  eq('an empty payload logs no quadrant and null verdicts, never invented ones', [row.quadrant, row.growth.market, row.inflation.nowcast.verdict], [null, { verdict: 'INSUFFICIENT', lean: null, usable: 0, of: 5 }, 'INSUFFICIENT']);
  const snap = regimeSnapshot({}, { now: NOW });
  eq('the regime row carries the axes when given them', regimeLogRow(snap, { extra: { axes: row } }).axes.quadrant, null);
  eq('and null when not', regimeLogRow(snap).axes, null);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
