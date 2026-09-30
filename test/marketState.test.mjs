// test/marketState.test.mjs — one measured state: regime from the axes, conditions from the gauges.
import { pctRank, upTo, onOrBefore, creditComponent, ratesVolComponent, equityVolComponent, fundingComponent, dollarComponent,
         breadthComponent, realYieldComponent, conditionsAt, conditions, liquidity, legScore, phi, axisScore, regime, axisWords,
         sizing, stage, hedgePhase, transitions, computeMarketState, stateLogRow, bandOf, STRESS_AT, CONDITION_WEIGHTS,
         CONDITION_SIZING, STAGES } from '../lib/marketState.js';
import { FRED_STATE_SERIES, YAHOO_STATE_SERIES, mapToSeries, stateInputs } from '../lib/marketStateFeed.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);
const near = (n, g, w, tol) => ok(`${n} (got ${g}, want ${w} ±${tol})`, g != null && Math.abs(g - w) <= tol);

// ── synthetic calendars ──
const days = (n, end = '2026-09-29') => {
  const out = []; let t = Date.parse(end + 'T00:00:00Z');
  while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) out.unshift(d.toISOString().slice(0, 10)); t -= 864e5; }
  return out;
};
const D = days(500);
const flat = (v, dates = D) => dates.map(date => ({ date, value: v }));
const ramp = (from, to, n, dates = D) => dates.map((date, k) => ({ date, value: k < dates.length - n ? from : from + (to - from) * (k - (dates.length - n) + 1) / n }));
const calm = {
  hyOas: flat(2.8), igOas: flat(0.8), realYield: flat(2.0), move: flat(85), vix: flat(14), vix3m: flat(16.5), vix9d: flat(13),
  dxy: flat(100), rsp: flat(200), spy: flat(700), iwm: flat(250), sofr: flat(3.9), effr: flat(3.9),
  reserves: flat(3000000), fedAssets: flat(6700000), tga: flat(800000), rrp: flat(10),
};

{
  eq('percentile rank, mid-rank for ties', [pctRank(flat(1).concat(flat(2)), 1), pctRank([{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }], 3), pctRank(flat(5), 5)], [25, 62.5, 50]);
  eq('as of a date: FRED and Yahoo calendars read on the same day', upTo([{ date: '2026-01-02', value: 1 }, { date: '2026-01-05', value: 2 }], '2026-01-03').length, 1);
  eq('the value on or before a date', onOrBefore([{ date: '2026-01-02', value: 1 }, { date: '2026-01-05', value: 2 }], '2026-01-04').value, 1);
  eq('seven components, weights sum to 1', +Object.values(CONDITION_WEIGHTS).reduce((a, b) => a + b, 0).toFixed(6), 1);
  eq('bands calibrated on two years: calm <45, caution <70, stress <82, crisis above', [bandOf(20).id, bandOf(44).id, bandOf(45).id, bandOf(69).id, bandOf(70).id, bandOf(81).id, bandOf(82).id], ['calm', 'calm', 'caution', 'caution', 'stress', 'stress', 'crisis']);
  eq('stress starts at 70', STRESS_AT, 70);
}
{
  const c = conditions(calm);
  ok('a flat, quiet market reads calm', c.band.id === 'calm' && c.score < 45);
  eq('all seven components read', c.present, 7);
  near('contributions add up to the score', Object.values(c.components).reduce((a, x) => a + x.contribution, 0), c.score, 1);
  eq('steady, with a history', [c.trend, c.history.length > 30], ['steady', true]);
}
{
  // 30 Sep 2026 in miniature: credit +36bp in a week, MOVE +36%, real yields at a two-year high,
  // VIX calm in contango.
  const S = { ...calm, hyOas: ramp(2.66, 3.02, 5), move: ramp(78.6, 106.6, 5), realYield: ramp(2.4, 2.9, 40) };
  const cr = creditComponent(S), rv = ratesVolComponent(S), ry = realYieldComponent(S), ev = equityVolComponent(S);
  eq('credit: the facts', [cr.facts.hyOas, cr.facts.hyChg5Bp], [3.02, 36]);
  ok('credit scores high on the speed of the move from a low level', cr.score >= 80);
  ok('rates vol scores high on +36% in a week', rv.score >= 85 && rv.facts.move === 106.6);
  ok('real yields at a two-year high score high', ry.score >= 80 && ry.facts.realPctile === 100);
  eq('equity vol stays low in contango', [ev.facts.structure, ev.score < 40], ['contango', true]);
  const c = conditions(S);
  ok('the composite rises and says so', c.score > conditions(calm).score + 15 && c.trend === 'rising');
}
{
  // April 2025 in miniature: everything at once, VIX inverted.
  const S = { ...calm, hyOas: ramp(3.2, 4.5, 5), move: ramp(90, 140, 5), vix: ramp(18, 50, 5), vix3m: ramp(19, 33, 5), dxy: ramp(104, 100, 20),
              rsp: ramp(200, 186, 20), iwm: ramp(250, 228, 20) };
  const c = conditions(S);
  // The real April 2025 series score 90 (see BANDS); this miniature moves five of the seven gauges.
  ok('a crash reads 80 or worse, stress or crisis', c.score >= 80 && ['stress', 'crisis'].includes(c.band.id));
  eq('with the VIX curve backwardated', c.components.equityVol.facts.structure, 'backwardation');
  eq('fewer than four components is no read', conditionsAt({ hyOas: calm.hyOas, vix: calm.vix, vix3m: calm.vix3m }).score, null);
}
{
  const f = fundingComponent({ ...calm, sofr: flat(3.97), effr: flat(3.9) });
  eq('funding: SOFR over EFFR in bp, 5-day average', f.facts.sofrEffr5Bp, 7);
  ok('a 7bp squeeze scores high', f.score >= 90);
  eq('reserves are published in millions and carried in billions', fundingComponent(calm).facts.reservesBn, 3000);
  eq('the dollar: 20-session change', dollarComponent({ dxy: ramp(100, 102, 20) }).facts.dxyChg20Pct, 2);
  eq('breadth: equal-weight and small caps against SPY', breadthComponent({ spy: flat(700), rsp: ramp(200, 190, 20), iwm: ramp(250, 240, 20) }).facts.rspSpyChg20Pct, -5);
}
{
  const L = liquidity({ fedAssets: [{ date: '2026-09-02', value: 6800000 }, { date: '2026-09-09', value: 6780000 }, { date: '2026-09-16', value: 6760000 }, { date: '2026-09-23', value: 6750000 }, { date: '2026-09-30', value: 6740000 }],
    tga: [{ date: '2026-09-02', value: 700000 }, { date: '2026-09-30', value: 950000 }], rrp: [{ date: '2026-09-01', value: 50 }, { date: '2026-09-30', value: 10 }] });
  eq('net liquidity = Fed assets − TGA − RRP, in $bn', [L.net, L.fed, L.tga, L.rrp], [5780, 6740, 950, 10]);
  eq('four-week change and the impulse it implies', [L.chg4w, L.impulse], [-270, 'draining']);
}
{
  const pulse = (score, usable, lean) => ({ score, usable, lean });
  eq('a leg scores its net lean over its usable inputs', [legScore(pulse(-3, 5, -1)), legScore(pulse(2, 2, 1)), legScore(pulse(0, 3, 0)), legScore(pulse(1, 0, null))], [-0.6, 1, 0, null]);
  near('the normal CDF', phi(1), 0.8413, 0.001); near('…and its symmetry', phi(-1) + phi(1), 1, 1e-9);
  const ax = (g, i) => ({ growth: { pulses: { market: pulse(g[0] * 5, 5, Math.sign(g[0])), weekly: pulse(g[1] * 4, 4, Math.sign(g[1])), monthly: pulse(g[2] * 3, 3, Math.sign(g[2])) } },
                          inflation: { pulses: { market: pulse(i[0] * 3, 3, Math.sign(i[0])), nowcast: pulse(i[1] * 2, 2, Math.sign(i[1])), printed: pulse(i[2] * 3, 3, Math.sign(i[2])) } } });
  const clear = regime(ax([1, 1, 1], [-1, -1, -1]));
  eq('every leg agreeing: reflation, not contested', [clear.id, clear.contested, clear.headline], ['ref', false, 'Reflation']);
  ok('with most of the probability', clear.probs.ref >= 80);
  eq('probabilities are whole percentages summing to 100', Object.values(clear.probs).reduce((a, b) => a + b, 0), 100);
  const today = regime(ax([-0.6, 0.5, 1 / 3], [0, 0, -1 / 3]));
  eq('30 Sep: markets falling, data firm — between regimes, drifting toward stagflation', [today.contested, today.drifting, today.headline], [true, 'stag', 'Between regimes, drifting toward stagflation']);
  eq('…in words', today.words, { growth: 'growth flat and turning down', inflation: 'inflation steady' });
  eq('an axis with no usable leg is no regime', regime({ growth: { pulses: {} }, inflation: { pulses: {} } }).available, false);
  eq('axis words', axisWords({ level: 0.5, drift: 0 }, { level: -0.5, drift: -0.6 }), { growth: 'growth firm', inflation: 'inflation cool and cooling' });
  const s = axisScore({ market: pulse(-3, 5, -1), weekly: pulse(2, 4, 1), monthly: pulse(1, 3, 1) }, { market: 0.45, weekly: 0.35, monthly: 0.20 });
  eq('axis score: weighted level, fast-minus-slow drift', [s.level, s.drift], [-0.03, -0.93]);
}
{
  const st = { regime: { available: true, probs: { ref: 100, inf: 0, stag: 0, def: 0 } }, conditions: { band: { id: 'caution' } } };
  eq('sizing: the expected regime multiplier times the conditions multiplier', sizing(st), { regimeMult: 1, condMult: 0.8, total: 0.8, band: 'caution' });
  eq('a split regime sizes between its cases', sizing({ regime: { available: true, probs: { ref: 50, inf: 0, stag: 50, def: 0 } }, conditions: { band: { id: 'calm' } } }).total, 0.8);
  eq('the conditions multipliers', CONDITION_SIZING, { calm: 1, caution: 0.8, stress: 0.6, crisis: 0.4 });
  eq('no regime read: conditions alone', sizing({ regime: { available: false }, conditions: { band: { id: 'stress' } } }).total, 0.6);
}
{
  const mk = (score, extra = {}) => ({ conditions: { score, band: bandOf(score), trend: 'steady', peak20: score, components: {}, ...extra } });
  eq('one stage derivation: calm → surveillance, caution → insure, stress → defend', [stage(mk(30)).n, stage(mk(55)).n, stage(mk(75)).n, stage(mk(90)).n], [1, 2, 3, 3]);
  eq('deploy only after a stress peak that is easing', stage(mk(55, { peak20: 78, trend: 'easing' })).n, 4);
  eq('four stages', STAGES.map(s => s.id), ['surveil', 'insure', 'defend', 'deploy']);
  eq('hedge phase: pre-crash while hedges are priced for calm', hedgePhase(mk(66)).id, 'preCrash');
  eq('…liquidity in stress with the VIX curve inverted', hedgePhase(mk(78, { components: { equityVol: { facts: { ratio: 1.08 } } } })).id, 'liquidity');
  eq('…recovery when easing from a peak', hedgePhase(mk(58, { peak20: 80 })).id, 'recovery');
}
{
  const st = { conditions: { score: 69, band: bandOf(69), components: { credit: { facts: { hyOas: 3.02 } }, ratesVol: { facts: { move: 106.6 } }, equityVol: { facts: { ratio: 0.89 } }, realYield: { facts: { realYield: 2.9 } } } },
               regime: { growth: { level: -0.03 }, inflation: { level: -0.07, drift: 0.33 } }, policy: { next: { hikeOdds: 48, cutOdds: 0 }, liquidity: { chg4w: -9 } } };
  const t = transitions(st);
  eq('transitions sorted by proximity, the nearest first', t[0].id, 'toStress');
  eq('the stress trigger is an OR: the nearest part sets it', t[0].proximity, 96);
  eq('the stress trigger names its parts with live and trigger values', t[0].parts.map(p => `${p.label} ${p.text}→${p.atText}`), ['Conditions 69→70', 'HY OAS 3.02%→3.50%', 'MOVE 106.6→120.0', 'VIX / VIX3M 0.89→1.00']);
  eq('relief is an AND: the farthest part sets it', t.find(x => x.id === 'relief').proximity, 45);
  eq('a rollover into rising inflation is stagflation', t.find(x => x.id === 'growthRolls').title, 'Growth rolls over → Stagflation');
  ok('every transition carries a plan', t.every(x => x.plan && x.plan.length > 20));
  eq('no stress trigger once in stress', transitions({ ...st, conditions: { ...st.conditions, score: 75, band: bandOf(75) } }).some(x => x.id === 'toStress'), false);
}
{
  const pulse = (score, usable, lean) => ({ score, usable, lean });
  const axes = { growth: { pulses: { market: pulse(-3, 5, -1), weekly: pulse(2, 4, 1), monthly: pulse(1, 3, 1) } }, inflation: { pulses: { market: pulse(0, 3, 0), nowcast: pulse(0, 2, 0), printed: pulse(-1, 3, -1) } } };
  const S = { ...calm, hyOas: ramp(2.66, 3.02, 5), move: ramp(78.6, 106.6, 5), realYield: ramp(2.4, 2.9, 40) };
  const st = computeMarketState({ axes, series: S, stance: 'active_tightening', next: { meeting: '2026-10-28', hikePct: 48, cutPct: 0 } });
  ok('the whole state composes', st.regime.available && st.conditions.score != null && st.sizing.total != null && st.stage && st.transitions.length);
  eq('policy: stance and next-meeting odds (fedpath names them hikePct)', [st.policy.stance, st.policy.next.hikeOdds], ['tightening', 48]);
  ok('a headline in one line', /Between regimes, drifting toward stagflation · conditions/.test(st.headline));
  const row = stateLogRow(st);
  eq('the log row is compact: regime, conditions, policy, sizing, stage', Object.keys(row), ['regime', 'conditions', 'policy', 'sizing', 'stage']);
  eq('…with each component score', Object.keys(row.conditions.comps).length, 7);
  eq('no inputs, no crash', computeMarketState({}).headline, 'Regime: no read · conditions: no read');
}
{
  eq('eleven FRED series, eight Yahoo', [FRED_STATE_SERIES.length, YAHOO_STATE_SERIES.length], [11, 8]);
  eq('a Yahoo map becomes an ascending series', mapToSeries({ '2026-01-03': 2, '2026-01-02': 1, x: NaN }), [{ date: '2026-01-02', value: 1 }, { date: '2026-01-03', value: 2 }]);
  const kv = (store = {}) => ({ configured: () => true, get: async k => store[k], setEx: async (k, v) => { store[k] = v; } });
  const now = new Date('2026-09-30T10:00:00Z');
  const full = { at: now.toISOString(), series: Object.fromEntries([...FRED_STATE_SERIES, ...YAHOO_STATE_SERIES].map(([k]) => [k, [{ date: '2026-09-29', value: 1 }]])), errors: [] };
  const r1 = await stateInputs({ now, fetcher: async () => full, kv: kv() });
  eq('a fresh fetch is served live', r1.source, 'live');
  const store = { 'dvcap:marketstate:inputs:v1': { ...full, at: '2026-09-30T09:50:00Z' } };
  eq('within half an hour the cache answers', (await stateInputs({ now, fetcher: async () => { throw new Error('no'); }, kv: kv(store) })).source, 'kv');
  const old = { 'dvcap:marketstate:inputs:v1': { ...full, at: '2026-09-29T09:00:00Z' } };
  const r3 = await stateInputs({ now, fetcher: async () => ({ at: now.toISOString(), series: {}, errors: [{ series: 'x' }] }), kv: kv(old) });
  eq('a failed refresh serves the last good copy, marked stale', r3.source, 'stale');
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
