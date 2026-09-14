// test/inflationAxis.test.mjs — the inflation axis and the measured quadrant.
import { marketInflation, nowcastInflation, printedInflation, inflationAxis, CORE_HOT, CORE_AT_TARGET, BE_HOT, BE_COLD, OIL_LOOKBACK } from '../lib/inflationAxis.js';
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
  ok('the oil flip is a dollar level from the base', /WTI back below \$72/.test(o.flip));
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

// ── THE AXIS ─────────────────────────────────────────────────────────────────
{
  const V = (verdict, lean) => ({ verdict, label: verdict, lean });
  eq('all hot is confirmed', inflationAxis({ market: V('HOT', 1), nowcast: V('HOT', 1), printed: V('HOT', 1) }).state, 'confirmed');
  const t = inflationAxis({ market: V('COOLING', -1), nowcast: V('BETWEEN', 0), printed: V('HOT', 1) });
  eq('market cool, nowcast between, printed hot — a turn toward cool, in lead order', t.state, 'turning-cool');
  ok('the read names the leading leg against the slowest one, with the in-between leg implied by the turn', /The market reads cool while the printed data still reads hot/.test(t.read));
  eq('the axis lean is the sign of the sum', t.lean, 0);
  eq('printed hot while both faster legs cool is turning-cool with a cool lean', inflationAxis({ market: V('COLD', -1), nowcast: V('COOLING', -1), printed: V('HOT', 1) }).lean, -1);
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
