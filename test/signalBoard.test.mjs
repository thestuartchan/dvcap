// test/signalBoard.test.mjs — the Signal Board's state logic, clusters, lean and the trade-day call v2
// (lib/signalBoard.js), and the feed's pure helpers (lib/signalBoardFeed.js). Synthetic series only.
import { stateOf, flipDistance, THRESHOLDS, CLUSTERS, clusterOf, leanOf, whatFlips, buildSignalBoard, creditRows, ratesRows, oilRows,
  dealerRows, tapeRows, asiaRows, narrativeRows, maRow, ratioSeries, realisedVol, downRunBefore, nextMonthlyOpex, sessionsBetween, nextSession,
  tradeDayCall, checkpointRead, tradeDayBlock, normCdf, zoneOf, TRADE_DAY_MODEL, BAND_STATS, CHECKPOINTS, priorR, snapshotRow, scoreRows, scorecard, KOSPI_TEST, cryptoRows, btc200Break, offHigh, BTC_TEST,
  narrativeState, narrativeFlip, narrativeMetrics, NARRATIVE_RULE, NARRATIVE_TEST,
  trendDayProb, TREND_MODEL, gammaView, conflictRules, tradeConflict, CONFLICT } from '../lib/signalBoard.js';
import { parseTimeline, joinNarrative, narrativeInputs, NARRATIVE_QUERY, gdeltUrl } from '../lib/narrativeFeed.js';
import { feedLeaks, gexFeedPayload } from '../lib/gexFeed.js';
import { readFileSync } from 'node:fs';
import { CUSHION } from '../lib/trendTells.js';
import { firstRanges, gammaBoards } from '../lib/signalBoardFeed.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

// ── helpers: business-day series ──
const days = (n, end = '2026-10-16') => {
  const out = []; let t = Date.parse(`${end}T12:00:00Z`);
  while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) out.unshift(d.toISOString().slice(0, 10)); t -= 864e5; }
  return out;
};
const ser = (vals, end) => { const ds = days(vals.length, end); return vals.map((v, i) => ({ date: ds[i], value: v })); };
const r2t = (v) => Math.round(v * 100) / 100;
const flat = (n, v) => Array.from({ length: n }, () => v);
const ramp = (n, a, b) => Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));

// ── ONE THRESHOLD RULE, BOTH DIRECTIONS ──
{
  const up = { dir: +1, on: 1, off: -1 }, dn = { dir: -1, on: -10, off: 10 };
  eq('higher-is-on: on at the threshold, off at its mirror, neutral between', [stateOf(1, up), stateOf(-1, up), stateOf(0, up), stateOf(5, up), stateOf(-5, up)], ['on', 'off', 'neutral', 'on', 'off']);
  eq('higher-is-off: the same two numbers read the other way', [stateOf(10, dn), stateOf(-10, dn), stateOf(0, dn), stateOf(30, dn)], ['off', 'on', 'neutral', 'off']);
  eq('missing input → no state, never neutral', [stateOf(null, up), stateOf(undefined, up), stateOf('x', up), stateOf(1, null)], [null, null, null, null]);
  eq('flip from neutral: the nearer threshold, in units of the gap between them', flipDistance(0.6, up), { to: 'on', at: 1, dist: 0.2, when: 'at or above' });
  eq('flip from an extreme: back to neutral past its own threshold', flipDistance(15, dn), { to: 'neutral', at: 10, dist: 0.25, when: 'below' });
  eq('flip from risk-on (higher-is-off): above its threshold', flipDistance(-12, dn), { to: 'neutral', at: -10, dist: 0.1, when: 'above' });
  ok('every threshold names its basis and has on ≠ off', Object.values(THRESHOLDS).every(t => t.basis && t.on !== t.off && (t.dir === 1 || t.dir === -1)));
}

// ── ROWS ──
{
  // Credit: HYG falling 2% against a flat LQD over 5 sessions → risk-off.
  const hyg = ser([...flat(20, 80), ...ramp(6, 80, 78.4)]), lqd = ser(flat(26, 110));
  const hy = ser([...flat(20, 3.0), 3.05, 3.1, 3.15, 3.2, 3.25, 3.3]);
  const [hl, oas] = creditRows({ hyg, lqd, hyOas: hy });
  eq('HYG ÷ LQD −2% in 5 sessions is risk-off', [hl.state, hl.value < -1.5, hl.vote], ['off', true, true]);
  eq('HY OAS +25bp over 5 prints is risk-off, from the market-state engine\'s own reading', [oas.state, oas.value], ['off', 25]);
  eq('no HY OAS → no state, no vote, and it says so', [creditRows({ hyg, lqd }).at(1).state, creditRows({ hyg, lqd }).at(1).vote, /no HY OAS/.test(creditRows({ hyg, lqd }).at(1).text)], [null, false, true]);
  // Rates: 10Y down 12bp in five sessions → risk-on (one set of thresholds: −7bp on, +7bp off).
  const [ten] = ratesRows({ tnx: ser([...flat(20, 4.3), 4.28, 4.25, 4.22, 4.2, 4.18, 4.18]) });
  eq('10Y −10bp over 5 sessions is risk-on', [ten.state, ten.value], ['on', -10]);
  // Oil: a close above the prior 20 sessions' high → breakout up, top of the box, risk-off.
  const bars = days(25).map((d, i) => ({ date: d, open: 80, high: 82, low: 78, close: i === 24 ? 85 : 80 }));
  bars[24].high = 85.5;
  const [oil] = oilRows({ brent: bars });
  eq('Brent closes above its 20-day box: breakout up, flagged, risk-off', [oil.breakout, oil.state, oil.flags.length], ['up', 'off', 1]);
  eq('too few Brent bars → no state', oilRows({ brent: bars.slice(-10) })[0].state, null);
}
{
  // Dealers: negative GEX overrides a mid percentile; positive at the top of the year is risk-on.
  const ds = days(300);
  const neg = ds.map((d, i) => [d, i === 299 ? -1e9 : 1e9 + i * 1e6]);
  const rowsNeg = dealerRows({ squeeze: neg }, { today: '2026-10-16' });
  const cush = rowsNeg.find(r => r.id === 'cushion');
  eq('negative GEX is risk-off whatever the percentile, and flagged', [cush.state, cush.gex_negative, cush.flags], ['off', true, ['GEX negative']]);
  const hi = ds.map((d, i) => [d, 1e9 + i * 1e6]);
  eq('GEX at the top of its trailing year is risk-on (≥60th)', dealerRows({ squeeze: hi }, { today: '2026-10-16' }).find(r => r.id === 'cushion').state, 'on');
  // VIX far above realised → risk-on; VIX9D above VIX → front inverted, risk-off.
  const spx = ser(Array.from({ length: 30 }, (_, i) => 6000 * (1 + (i % 2 ? 0.001 : -0.001))));
  const vix = ser(flat(30, 18)), vix9 = ser(flat(30, 19));
  const dr = dealerRows({ spx, vix, vix9d: vix9 }, { today: '2026-10-16' });
  eq('VIX ÷ a near-zero realised is risk-on', dr.find(r => r.id === 'vix_rv').state, 'on');
  eq('VIX9D ÷ VIX 1.06 is risk-off (front inverted)', [dr.find(r => r.id === 'vix9d_vix').state, /front inverted/.test(dr.find(r => r.id === 'vix9d_vix').text)], ['off', true]);
  const op = dr.find(r => r.id === 'opex');
  eq('opex: the next monthly, sessions to it, shown but never a vote', [op.opex, op.value, op.vote], ['2026-10-16', 0, false]);
  eq('put/call missing → no state, said why', [dr.find(r => r.id === 'put_call').state, /not cached/.test(dr.find(r => r.id === 'put_call').text)], [null, true]);
  eq('put/call from the cross-check block: 80th percentile is risk-off', dealerRows({ putCall: { as_of: '2026-10-16', equity_pct_rank_1y: 80, sessions: [{ equity: 0.7 }] } }, { today: '2026-10-16' }).find(r => r.id === 'put_call').state, 'off');
}
{
  // Tape: a series above all four averages; one below three of them.
  const upS = ser(ramp(220, 100, 200)), dnS = ser([...ramp(200, 100, 200), ...ramp(20, 200, 150)]);
  const a = maRow('x', 'X', upS), b = maRow('y', 'Y', dnS);
  eq('above all four averages → risk-on, with a distance to each', [a.state, a.value, a.mas.map(m => m.n)], ['on', 4, [20, 50, 100, 200]]);
  eq('a sharp fall through every average → 0 of 4, risk-off', [b.value, b.state], [0, 'off']);
  eq('fewer than 200 closes → no state', maRow('z', 'Z', ser(ramp(150, 1, 2))).state, null);
  const rsp = ser(ramp(30, 100, 104)), qqq = ser(flat(30, 500));
  const t = tapeRows({ rsp, qqq, spy: ser(flat(30, 600)), iwm: ser(flat(30, 200)) });
  eq('RSP ÷ QQQ +2.8% over 20 sessions is risk-on (broadening, the Market Read\'s convention)', t.find(r => r.id === 'rsp_qqq').state, 'on');
  eq('breadth comes from the market-state engine\'s component', [t.find(r => r.id === 'breadth').state, /Equal-weight vs cap-weight/.test(t.find(r => r.id === 'breadth').text)], ['on', true]);
  { const alt = ser(Array.from({ length: 21 }, (_, i) => (i % 2 ? 101 : 100)));
    const want = Math.log(1.01) * Math.sqrt(20 / 19) * Math.sqrt(252) * 100;
    eq('realised vol: annualised close-to-close, in vol points; too short → null', [Math.abs(realisedVol(alt, 20) - want) < 1e-6, realisedVol(ser([1, 2]), 20)], [true, null]); }
  eq('ratioSeries only on dates both have', ratioSeries([{ date: 'a', value: 2 }, { date: 'b', value: 4 }], [{ date: 'b', value: 2 }]), [{ date: 'b', value: 2 }]);
}
{
  // Asia: up after two down closes → Crown's pattern flagged with its tested record; never a vote.
  const k = ser([100, 99, 98, 100.5]);
  const [row] = asiaRows({ kospi: k });
  eq('KOSPI up 2.6% after 2 down closes: flagged, risk-on, no vote', [row.state, row.vote, row.roc, row.flags.length, new RegExp(`n ${KOSPI_TEST.n}`).test(row.flags[0])], ['on', false, 2, 1, true]);
  eq('down-run counts the closes before the last', [downRunBefore(ser([5, 4, 3, 2, 3])), downRunBefore(ser([1, 2, 3])), downRunBefore(ser([3, 2]))], [3, 0, 0]);
}

// ── NARRATIVE (GDELT AI build-out coverage and tone) ──
// Calendar-day series ending 2026-10-19: `n` days at share 0.5% (count 50 of 10,000) and tone 1.0, then
// the last 5 days at count `c5` and tone `t5`.
const narr = (c5, t5, n = 45, end = '2026-10-19') => Array.from({ length: n }, (_, i) => {
  const date = new Date(Date.parse(`${end}T12:00:00Z`) - (n - 1 - i) * 864e5).toISOString().slice(0, 10);
  const tail = i >= n - 5;
  return { date, count: tail ? c5 : 50, norm: 10000, tone: tail ? t5 : 1.0 };
});
{
  const C = NARRATIVE_RULE.coverage, T = NARRATIVE_RULE.tone;
  eq('the rule: louder and darker → risk-off; better and not fading → risk-on; else neutral',
    [narrativeState(25, -0.5), narrativeState(0, 0.5), narrativeState(25, 0.5), narrativeState(-30, 0.5), narrativeState(0, -0.5), narrativeState(25, 0), narrativeState(0, 0)],
    ['off', 'on', 'on', 'neutral', 'neutral', 'neutral', 'neutral']);
  eq('thresholds inclusive, the same numbers both ways (±10% coverage, ±0.25 tone)',
    [narrativeState(C, -T), narrativeState(C - 0.1, -T), narrativeState(C, -T + 0.01), narrativeState(-C, T), narrativeState(-C - 0.1, T), narrativeState(-C, T - 0.01)],
    ['off', 'neutral', 'neutral', 'on', 'neutral', 'neutral']);
  eq('missing input → no state', [narrativeState(null, 0.5), narrativeState(5, undefined), narrativeState('x', 1)], [null, null, null]);
  // Share 0.7% for 5 days against 0.5% → 5d mean 0.7 vs 20d mean 0.55 = +27.3%; tone 0.5 vs 1.0 = −0.5.
  const m = narrativeMetrics(narr(70, 0.5));
  eq('metrics: share, 5d vs 20d, 5d vs prior 5, tone and its 5-day change', [m.as_of, m.share_pct, m.cov_5v20, m.cov_5v5, m.cov_20v20, m.tone5, m.tone_chg5], ['2026-10-19', 0.7, 27.3, 40, 10, 0.5, -0.5]);
  eq('tone is article-weighted', narrativeMetrics([...narr(50, 1.0).slice(0, -2), { date: '2026-10-18', count: 300, norm: 10000, tone: -1 }, { date: '2026-10-19', count: 100, norm: 10000, tone: 2 }]).tone5, r2t((50 * 3 * 1 + 300 * -1 + 100 * 2) / 550));
  const [off] = narrativeRows({ narrative: narr(70, 0.5) }, { today: '2026-10-20' });
  const [on] = narrativeRows({ narrative: narr(50, 1.6) }, { today: '2026-10-20' });
  const [neu] = narrativeRows({ narrative: narr(30, 1.6) }, { today: '2026-10-20' });
  eq('rows: risk-off, risk-on, and better-but-fading neutral', [off.state, on.state, neu.state], ['off', 'on', 'neutral']);
  eq('the row carries value (tone change), coverage as its change, thresholds and basis', [off.value, off.roc, off.thresholds.on, off.thresholds.off, off.thresholds.coverage_pct, /quartiles/.test(off.benchmark)], [-0.5, 27.3, 0.25, -0.25, 10, true]);
  eq('no tested edge → shown, not voted, flagged for review', [NARRATIVE_TEST.edge, off.vote, /under review/.test(off.flags[0])], [false, false, true]);
  eq('no GDELT → not available, no state, no vote', [narrativeRows({})[0].state, narrativeRows({})[0].vote, /not available/.test(narrativeRows({})[0].text)], [null, false, true]);
  eq('fewer than 20 days → not available', narrativeRows({ narrative: narr(70, 0.5, 15) })[0].state, null);
  eq('GDELT stopped more than 4 days ago → not available', [narrativeRows({ narrative: narr(70, 0.5) }, { today: '2026-10-30' })[0].state, /days old/.test(narrativeRows({ narrative: narr(70, 0.5) }, { today: '2026-10-30' })[0].text)], [null, true]);
  eq('flip: nearest boundary, either measure, in gap units', narrativeFlip(0.2, -0.5), { to: 'off', at: 10, on: 'coverage', dist: 0.49, when: 'at or above', text: 'AI build-out narrative (neutral) → risk-off if the 5d-vs-20d coverage goes to +10%' });
  eq('flip from risk-on: tone falling under +0.25', [narrativeFlip(0, 0.3).to, narrativeFlip(0, 0.3).on, narrativeFlip(0, 0.3).at, narrativeFlip(0, 0.3).when], ['neutral', 'tone', 0.25, 'below']);
  eq('the row passes the connector\'s banned-word check', [feedLeaks(JSON.stringify(off)), feedLeaks(JSON.stringify(narrativeRows({})))], [[], []]);
  ok('the query names the AI build-out terms, English sources', /hyperscaler/.test(NARRATIVE_QUERY) && /"AI capex"/.test(NARRATIVE_QUERY) && /"data center"/.test(NARRATIVE_QUERY) && /sourcelang:english/.test(NARRATIVE_QUERY));
}
{
  // The GDELT parser: the current UTC day dropped (still filling), collection gaps dropped, dates ISO.
  const now = new Date('2026-10-20T09:00:00Z');
  const vol = { timeline: [{ data: [{ date: '20261017T000000Z', value: 10, norm: 1000 }, { date: '20261018T000000Z', value: 0, norm: 0 }, { date: '20261019T000000Z', value: 12, norm: 1100 }, { date: '20261020T000000Z', value: 3, norm: 90 }] }] };
  const tone = { timeline: [{ data: [{ date: '20261017T000000Z', value: 0.4 }, { date: '20261019T000000Z', value: -0.2 }, { date: '20261020T000000Z', value: 1 }] }] };
  const pv = parseTimeline(vol, 'timelinevolraw', { now }), pt = parseTimeline(tone, 'timelinetone', { now });
  eq('parse: today and a zero day dropped', [pv.map(o => o.date), pt.map(o => o.date)], [['2026-10-17', '2026-10-19'], ['2026-10-17', '2026-10-19']]);
  eq('join on date', joinNarrative(pv, pt), [{ date: '2026-10-17', count: 10, norm: 1000, tone: 0.4 }, { date: '2026-10-19', count: 12, norm: 1100, tone: -0.2 }]);
  eq('parse: rate-limit text or junk → no rows', [parseTimeline(null, 'timelinetone'), parseTimeline({}, 'timelinevolraw')], [[], []]);
  ok('the request: both timeline modes, daily, unsmoothed, the query encoded', /mode=timelinevolraw/.test(gdeltUrl('timelinevolraw', { now })) && /timelinesmooth=0/.test(gdeltUrl('timelinetone', { now })) && /hyperscaler/.test(decodeURIComponent(gdeltUrl('timelinetone', { now }))));
}
{
  // The cache: fetch both (a 5.5s gap between), serve from cache while fresh, keep the last good copy on a
  // failed refresh, and with nothing at all return an empty series, never throw.
  const now = new Date('2026-10-20T09:00:00Z');
  const body = (mode) => JSON.stringify({ timeline: [{ data: [{ date: '20261019T000000Z', value: mode === 'timelinevolraw' ? 5 : 0.3, norm: 100 }] }] });
  const store = {}; const kv = { configured: () => true, get: async (k) => store[k] ?? null, setEx: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); return true; } };
  let calls = 0, slept = 0;
  const good = async (url) => { calls++; return { ok: true, status: 200, text: async () => body(new URL(url).searchParams.get('mode')) }; };
  const limited = async () => { calls++; return { ok: false, status: 429, text: async () => 'Please limit requests' }; };
  const sleep = async (ms) => { slept += ms; };
  const a = await narrativeInputs({ now, fetchImpl: good, sleep, kv });
  eq('first call: two requests, one 5.5s gap, joined series, live', [calls, slept, a.series, a.source], [2, 5500, [{ date: '2026-10-19', count: 5, norm: 100, tone: 0.3 }], 'live']);
  const b = await narrativeInputs({ now: new Date(now.getTime() + 3600e3), fetchImpl: good, sleep, kv });
  eq('within three hours: served from the cache, no request', [calls, b.source, b.series.length], [2, 'kv', 1]);
  const c = await narrativeInputs({ now: new Date(now.getTime() + 5 * 3600e3), fetchImpl: limited, sleep, kv });
  eq('a 429 on refresh: one request only, last good copy served, errors named, stale', [calls, c.series.length, c.source, c.errors.length, /skipped/.test(c.errors[1].error)], [3, 1, 'stale', 2, true]);
  const empty = { configured: () => false, get: async () => null, setEx: async () => true };
  const d = await narrativeInputs({ now: new Date('2030-01-01T00:00:00Z'), fetchImpl: limited, sleep, kv: { ...empty, configured: () => true } });
  eq('nothing cached and GDELT refusing → empty series, source none', [d.series, d.source], [[], 'none']);
  const e = await narrativeInputs({ now, fetchImpl: async () => { throw new Error('connect timeout'); }, sleep, kv: { ...empty, configured: () => true } });
  eq('a network failure never throws', [e.series, e.source, e.errors.length], [[], 'none', 2]);
}

// ── CLUSTERS AND LEAN ──
{
  const R = (dim, state, vote = true) => ({ dim, state, vote: vote && state != null });
  const rows = [R('credit', 'off'), R('rates', 'off'), R('oil', 'on'), R('dealers', 'on'), R('dealers', 'on'), R('dealers', 'off'), R('tape', 'neutral'), R('tape', 'neutral'), R('asia', 'on', false), R('narrative', null, false)];
  const cl = CLUSTERS.map(c => clusterOf(rows, c));
  eq('cluster = sign of rows on − rows off; non-voting rows ignored; a cluster with no votes reads null', cl.map(c => c.state), ['off', 'on', 'neutral', null]);
  eq('lean counts clusters, not boxes: 3 rows on in one cluster is one vote', leanOf(cl), { state: 'neutral', on: 1, off: 1, of: 3, text: 'No lean: 1 of 3 clusters risk-on, 1 risk-off' });
  eq('two clusters off of three → risk-off lean', leanOf([{ state: 'off' }, { state: 'off' }, { state: 'on' }, { state: null }]).state, 'off');
  const fl = whatFlips([{ id: 'a', vote: true, state: 'neutral', value: 0.9, flip: { to: 'on', at: 1, when: 'at or above', dist: 0.05 }, label: 'A', thresholds: { unit: '%' } },
    { id: 'b', vote: true, state: 'neutral', value: 0, flip: { to: 'on', at: 1, dist: 0.5 }, label: 'B' },
    { id: 'c', vote: false, state: 'on', value: 5, flip: { to: 'neutral', at: 1, dist: 0.01 }, label: 'C' }], 2);
  eq('what flips it: nearest voting rows first, non-voting rows left out', fl.map(f => f.id), ['a', 'b']);
}
{
  const b = buildSignalBoard({}, { today: '2026-10-20', holidays: [] });
  eq('an empty board: every dimension present, no cluster reads, no lean, no flips', [new Set(b.rows.map(r => r.dim)).size, b.clusters.every(c => c.state == null), b.lean.state, b.flips.length], [8, true, 'neutral', 0]);
}

// ── CALENDAR ──
eq('next monthly opex: the third Friday, the Thursday when that Friday is a holiday', [nextMonthlyOpex('2026-10-20'), nextMonthlyOpex('2026-10-16'), nextMonthlyOpex('2027-03-20', ['2027-04-16'])], ['2026-11-20', '2026-10-16', '2027-04-15']);
eq('sessions between, weekends and holidays out', [sessionsBetween('2026-10-16', '2026-10-23'), sessionsBetween('2026-11-25', '2026-11-27', ['2026-11-26'])], [5, 1]);
eq('next session skips the weekend and a holiday', [nextSession('2026-10-16'), nextSession('2026-11-25', ['2026-11-26'])], ['2026-10-19', '2026-11-27']);

// ── TRADE-DAY CALL v2 ──
{
  eq('normal CDF', [+normCdf(0).toFixed(4), +normCdf(1.96).toFixed(4), +normCdf(-1).toFixed(4)], [0.5, 0.975, 0.1587]);
  const q = tradeDayCall('QQQ', { cushionPct: 3.6, prevR: 0.65 });
  const lp = TRADE_DAY_MODEL.QQQ.const + TRADE_DAY_MODEL.QQQ.cush * 3.6 + TRADE_DAY_MODEL.QQQ.prevR * 0.65;
  eq('QQQ median R is exp(the model) and P(R ≥ 1) is Φ(log R̂ ÷ σ)', [q.median_r, q.p_r_ge_1], [+Math.exp(lp).toFixed(2), +normCdf(lp / TRADE_DAY_MODEL.QQQ.sigma).toFixed(2)]);
  eq('the assumptions are stated when the gap and IV change are not known', q.assumed, ['gap 0 (no futures-implied open yet)', 'IV unchanged overnight']);
  eq('the band\'s own distribution rides along (median and share ≥1.0×, not a mean)', q.band, { id: 'p0', median_r: 1.10, share_ge_1: 60, n: 403, lean: 'trade' });
  eq('negative GEX takes the negative band', tradeDayCall('SPY', { cushionPct: 5, gexNegative: true, prevR: 1 }).band.id, 'neg');
  ok('a high cushion and a quiet prior day call lean skip', tradeDayCall('QQQ', { cushionPct: 95, prevR: 0.6 }).zone === 'lean skip');
  ok('a big gap and a wide prior day call trade', tradeDayCall('QQQ', { cushionPct: 10, prevR: 1.6, gapSigma: 1.5 }).zone === 'trade');
  eq('no cushion or no prior day → no call, with why', [tradeDayCall('QQQ', { prevR: 1 }).why, tradeDayCall('QQQ', { cushionPct: 10 }).why], ['no cushion', 'no prior-day range']);
  eq('one zone rule: ≥1.0 trade, 0.9–1.0 selective, below lean skip', [zoneOf(1.0), zoneOf(0.95), zoneOf(0.899), zoneOf(null)], ['trade', 'selective', 'lean skip', null]);
  eq('the cushion bands use that one rule per ticker: QQQ', CUSHION.map(b => b.leanQqq), ['trade', 'trade', 'trade', 'selective', 'lean skip', 'lean skip']);
  eq('… and SPX', CUSHION.map(b => b.leanSpx), ['trade', 'trade', 'selective', 'lean skip', 'lean skip', 'lean skip']);
  eq('the call carries the ticker-matching band lean: 30th pct is Trade for QQQ, Selective for SPY', [tradeDayCall('QQQ', { cushionPct: 30, prevR: 1 }).band.lean, tradeDayCall('SPY', { cushionPct: 30, prevR: 1 }).band.lean], ['trade', 'selective']);
  ok('band stats are medians that fall band by band, on both tickers', ['QQQ', 'SPY'].every(t => ['neg', 'p0', 'p20', 'p40', 'p60', 'p80'].every((k, i, a) => i === 0 || BAND_STATS[t][k][0] <= BAND_STATS[t][a[i - 1]][0])));
}
{
  // Checkpoints: PR #384's thresholds, both tickers, both times.
  eq('the thresholds are PR #384\'s', [CHECKPOINTS.QQQ['10:00'].confirm, CHECKPOINTS.QQQ['10:00'].quiet, CHECKPOINTS.QQQ['10:30'].confirm, CHECKPOINTS.QQQ['10:30'].quiet,
    CHECKPOINTS.SPY['10:00'].confirm, CHECKPOINTS.SPY['10:00'].quiet, CHECKPOINTS.SPY['10:30'].confirm, CHECKPOINTS.SPY['10:30'].quiet], [0.50, 0.33, 0.70, 0.43, 0.40, 0.25, 0.55, 0.32]);
  const imp = 0.01;   // a 1% one-day 1σ
  eq('QQQ 10:00: a 0.6σ first range confirms', checkpointRead('QQQ', '10:00', { firstRange: 3.0, open: 500, implied: imp }).band, 'confirm');
  eq('QQQ 10:30: 0.42σ is quiet, 0.43σ is not', [checkpointRead('QQQ', '10:30', { firstRange: 2.1, open: 500, implied: imp }).band, checkpointRead('QQQ', '10:30', { firstRange: 2.15, open: 500, implied: imp }).band], ['quiet', 'middle']);
  eq('SPY 10:30: ≥0.55σ confirms', checkpointRead('SPY', '10:30', { firstRange: 3.4, open: 600, implied: imp }).band, 'confirm');
  eq('before the window closes: the thresholds, no band', [checkpointRead('SPY', '10:00', {}).ok, checkpointRead('SPY', '10:00', {}).confirm_at], [false, 0.40]);
  eq('the history per band: n, rest-of-day median, full-day share ≥1.0×', checkpointRead('QQQ', '10:00', { firstRange: 3.0, open: 500, implied: imp }).history, { n: 138, rest_median_r: 0.98, rest_ge_median_pct: 70, day_ge_1_pct: 67 });
}
{
  // The call never reads the session it calls: everything dated on or after `target` is dropped.
  const ds = days(300, '2026-10-19');
  const bars = ds.map(d => ({ date: d, open: 100, high: 101, low: 99, close: 100 }));
  bars[bars.length - 1] = { date: '2026-10-19', open: 100, high: 110, low: 90, close: 100 };   // a huge "today"
  const vxn = ds.map(d => ({ date: d, value: 20 }));
  const sq = ds.map((d, i) => [d, 1e9 + i * 1e6]);
  const S = { qqqBars: bars, spyBars: bars, vxn, vix: vxn, squeeze: sq };
  const before = tradeDayBlock(S, { target: '2026-10-19' }), after = tradeDayBlock(S, { target: '2026-10-20' });
  eq('called before the 19th: the 16th is the prior day and its GEX the cushion', [before.as_of, before.calls.QQQ.inputs.prev_r], ['2026-10-16', 1.59]);
  ok('called for the 20th: the 19th\'s wide range is the prior day', after.calls.QQQ.inputs.prev_r > 15 && after.as_of === '2026-10-19');
  eq('priorR = range ÷ open ÷ the implied at the close before it', +priorR(bars.slice(0, -1), vxn).toFixed(2), 1.59);
  const first = { QQQ: { '10:00': { firstRange: 1.0, open: 100 } } };
  eq('a checkpoint is read with the call\'s implied', tradeDayBlock(S, { target: '2026-10-20', first }).checkpoints.QQQ[0].band, 'confirm');
}
{
  // First ranges from 30-minute bars: 10:00 once a later bar exists, 10:30 from the first two bars.
  const t0 = Date.parse('2026-10-19T13:30:00Z') / 1000;
  const bars = [0, 1, 2].map(k => ({ t: t0 + k * 1800, o: 100 + k, h: 101 + k * 2, l: 99 - k, c: 100 }));
  eq('first ranges: 30 minutes, then 60', firstRanges(bars, '2026-10-19'), { open: 100, '10:00': { open: 100, firstRange: 2 }, '10:30': { open: 100, firstRange: 5 } });
  eq('only the first bar: no window has closed yet', firstRanges(bars.slice(0, 1), '2026-10-19'), { open: 100 });
  eq('another day\'s bars: nothing', firstRanges(bars, '2026-10-20'), {});
}

// ── CRYPTO ROWS (shown, never voted) ──
{
  // Calendar-day series: crypto trades every day.
  const cal = (vals, end = '2026-10-16') => { const t = Date.parse(`${end}T12:00:00Z`);
    return vals.map((v, i) => ({ date: new Date(t - (vals.length - 1 - i) * 864e5).toISOString().slice(0, 10), value: v })); };
  const t = THRESHOLDS;
  eq('BTC ÷ QQQ: +12% on, −8% off, between neutral', [stateOf(12, t.btcQqq20d), stateOf(-8, t.btcQqq20d), stateOf(2, t.btcQqq20d)], ['on', 'off', 'neutral']);
  eq('ETH ÷ BTC: +5.5% on, −7.5% off', [stateOf(5.5, t.ethBtc20d), stateOf(-8.4, t.ethBtc20d), stateOf(0, t.ethBtc20d)], ['on', 'off', 'neutral']);
  eq('BTC off its high: within 7.5% on, 45% or more off, −35% neutral', [stateOf(-5, t.btcOffHigh), stateOf(-45, t.btcOffHigh), stateOf(-35, t.btcOffHigh)], ['on', 'off', 'neutral']);
  // A year-plus of BTC rising, then a fall: below the 20-day, above the 200-day.
  const up = ramp(400, 50000, 120000), btc = cal([...up, ...ramp(10, 119500, 115000)]);
  const eth = cal([...ramp(400, 2000, 4000), ...ramp(10, 3950, 3000)]);
  const qqq = ser(ramp(260, 500, 600), '2026-10-16');
  const rows = cryptoRows({ btc, eth, qqq });
  eq('four crypto rows, in the crypto dim, none voting', rows.map(r => [r.id, r.dim, r.vote]), [['btc_ma', 'crypto', false], ['btc_qqq', 'crypto', false], ['eth_btc', 'crypto', false], ['btc_dd', 'crypto', false]]);
  const ma = rows[0];
  eq('BTC trend: the QQQ/SOXX rule — a dip under the 20/50-day, above the 100/200-day, is neutral', [ma.value, ma.state, ma.thresholds.on, ma.thresholds.off], [2, 'neutral', 4, 1]);
  const dd = rows.find(r => r.id === 'btc_dd');
  eq('BTC off its 52-week closing high, dated', [Math.round(dd.value * 10) / 10, dd.high, dd.high_date], [-4.2, 120000, '2026-10-06']);
  ok('ETH ÷ BTC is computed and reads a state', rows.find(r => r.id === 'eth_btc').state != null);
  ok('BTC ÷ QQQ on shared dates: a 20-session change', Number.isFinite(rows.find(r => r.id === 'btc_qqq').value));
  // A high older than 365 days rolls out of the window.
  const old = cal([200, ...flat(380, 100)]);
  eq('a high more than a year old is not the 52-week high', offHigh(old).pct, 0);
  eq('under a year of closes: no 52-week reading', offHigh(cal(flat(200, 100))), null);
  // The 200-day break: the first close below after ≥20 above.
  const brk = cal([...ramp(240, 100, 200), 100]);
  ok('a first close below the 200-day after a run above is a break', btc200Break(brk));
  eq('the break carries its flag with the tested numbers', cryptoRows({ btc: brk, eth: [], qqq: [] })[0].flags.length, 1);
  ok('…and the next close below is not a second break', !btc200Break(cal([...ramp(240, 100, 200), 100, 99])));
  ok('a close below after a short run above is not a break', !btc200Break(cal([...flat(220, 100), ...flat(10, 110), 90])));
  ok('fewer than 220 closes: no break', !btc200Break(cal(ramp(100, 100, 200))));
  eq('missing series: rows say so and carry no state', cryptoRows({}).map(r => r.state), [null, null, null, null]);
  // Not voted: the Tape cluster reads the same with or without them.
  const board = buildSignalBoard({ btc, eth, qqq });
  const tape = board.clusters.find(c => c.id === 'tape');
  eq('crypto rows sit in the Tape cluster but cast no vote', [tape.rows, CLUSTERS.find(c => c.id === 'tape').dims.includes('crypto')], [buildSignalBoard({ qqq }).clusters.find(c => c.id === 'tape').rows, true]);
  ok('the tested record is stated', BTC_TEST.n_break === 13 && BTC_TEST.btc_qqq_n_on === 752);
}

// ── SNAPSHOT AND SCORE ──
{
  const board = { at: 'x', rows: [{ id: 'cushion', value: 10, state: 'off' }, { id: 'qqq_ma', value: 4, state: 'on', as_of: '2026-10-14' }], clusters: [{ id: 'macro', state: 'off' }], lean: { state: 'off' } };
  const td = { target: '2026-10-15', calls: { QQQ: { ok: true, median_r: 1.1, p_r_ge_1: 0.6, zone: 'trade' }, SPY: { ok: false } } };
  const row = snapshotRow(board, td, '2026-10-15');
  eq('a snapshot: states, clusters, lean, the call, its as-of and target', [row.as_of, row.target, row.rows.cushion, row.clusters.macro, row.call.QQQ.zone, row.call.SPY], ['2026-10-14', '2026-10-15', { v: 10, s: 'off' }, 'off', 'trade', null]);
  const closes = { QQQ: { '2026-10-14': 100, '2026-10-15': 99, '2026-10-16': 98, '2026-10-19': 97, '2026-10-20': 101, '2026-10-21': 102 }, SOXX: { '2026-10-14': 50, '2026-10-15': 51 } };
  const [sc] = scoreRows([row], { closes, sessions: { QQQ: { '2026-10-15': 1.3 }, SPY: {} } });
  eq('forward returns from the as-of close, 1/3/5 sessions', [sc.fwd.QQQ_1, sc.fwd.QQQ_3, sc.fwd.QQQ_5, sc.fwd.SOXX_1, sc.fwd.SOXX_3], [-1, -3, 2, 2, null]);
  eq('realised R of the session the call was for', [sc.realised.QQQ, sc.realised.SPY], [{ date: '2026-10-15', r: 1.3 }, null]);
  const card = scorecard([sc]);
  eq('scorecard: a risk-off row followed by a fall is a hit', card.signals.cushion.off.QQQ_1, { n: 1, hit_pct: 100, mean_pct: -1 });
  eq('scorecard: a Trade call that moved 1.3× is a hit, with its Brier', card.calls.QQQ.last20, { n: 1, judged: 1, hit_pct: 100, brier: 0.16 });
}

// ── P(TREND DAY) ──
{
  // 20 Oct 2026: no out-of-sample skill on either ticker, so the call shows the cushion band's base rate.
  eq('the tested verdict: no skill, walk-forward n 2,714 from 2016', [TREND_MODEL.QQQ.skill, TREND_MODEL.SPY.skill, TREND_MODEL.QQQ.oos.n, TREND_MODEL.QQQ.oos.span.slice(0, 4)], [false, false, 2714, '2016']);
  const top = trendDayProb('QQQ', { cushionPct: 90, prevR: 0.8, band: 'p80' });
  eq('no skill → the band\'s base rate, labelled', [top.p, top.source, top.band_pct, top.band_n, top.base_pct], [0.42, 'band base rate', 41.5, 987, 49.1]);
  ok('…and the text says the model has no out-of-sample skill', /no out-of-sample skill over the base rate/.test(top.text));
  eq('negative GEX reads its own band', trendDayProb('SPY', { cushionPct: 5, gexNegative: true, prevR: 1, band: 'neg' }).band_pct, 57.1);
  eq('no band → no reading', trendDayProb('QQQ', { cushionPct: 50, prevR: 1 }), null);
  const q = tradeDayCall('QQQ', { cushionPct: 90, prevR: 0.8 });
  eq('the call carries p_trend and its source', [q.p_trend, q.trend.source], [0.42, 'band base rate']);
  ok('the call\'s text names P(trend day) and the base-rate fallback', /P\(trend day\) 41\.5%: the cushion band's base rate/.test(q.text));
  ok('every band has a rate and a count, both tickers', ['QQQ', 'SPY'].every(t => ['neg', 'p0', 'p20', 'p40', 'p60', 'p80'].every(b => TREND_MODEL[t].bands[b][1] > 300)));
  const imp = 0.2 / Math.sqrt(252);   // the one-day 1σ as a fraction; 5.0 on 500 is 0.79σ, a confirm
  const h = checkpointRead('QQQ', '10:30', { firstRange: 5.0, open: 500, implied: imp }).history;
  eq('10:30 checkpoint: the band\'s trend-day share with its n and base', [h.trend_day_pct, h.trend_n, h.trend_base_pct], [47, 122, 45]);
  ok('10:00 carries no trend share (60 sessions of free 30-minute bars)', !('trend_day_pct' in checkpointRead('QQQ', '10:00', { firstRange: 3.0, open: 500, implied: imp }).history));
}

// ── THE CONFLICT FLAG ──
{
  const base = { spot: 600, as_of_utc: '2026-10-19T20:00:00.000Z', mode: 'settled', net_gex_per_1pct: 2e9,
    flip: { line: 590, usable: true }, call_wall: { strike: 603, gamma: 8e8 }, pin_box: { lo: 595, hi: 605 },
    trapdoor: { near: { strike: 585, gamma: -5e8 } }, expiries: [{ move_1sd: 6 }] };
  const view = (o = {}) => gammaView({ ...base, ...o }, { target: '2026-10-20' });
  const call = (zone, sd = 8) => ({ ok: true, ticker: 'QQQ', zone, median_r: zone === 'trade' ? 1.1 : 0.8, implied_1sd: sd });
  eq('Trade in a positive-gamma pin box, near the wall: both pin rules', conflictRules('trade', view(), 8).map(r => r.id), ['pin_box', 'call_wall']);
  eq('Trade outside the box and beyond 0.5σ of the wall: none', conflictRules('trade', view({ spot: 612 }), 8).map(r => r.id), []);
  eq('Trade, call wall 0.5σ away exactly: fires (inclusive)', conflictRules('trade', view({ pin_box: null, call_wall: { strike: 604, gamma: 1e9 } }), 8).map(r => r.id), ['call_wall']);
  eq('Trade, net gamma negative: no pin conflict', conflictRules('trade', view({ net_gex_per_1pct: -1e9 }), 8), []);
  eq('Trade, a wall with negative gamma is no wall', conflictRules('trade', view({ pin_box: null, call_wall: { strike: 601, gamma: -1e8 } }), 8), []);
  const neg = { net_gex_per_1pct: -2e9, flip: { line: 605, usable: true }, pin_box: null, trapdoor: { near: { strike: 597, gamma: -9e8 } } };
  eq('Lean skip below the flip with negative gamma, trapdoor within 0.5σ: both', conflictRules('lean skip', view(neg), 8).map(r => r.id), ['below_flip', 'trapdoor']);
  eq('Lean skip: a fragile flip (a zone, not a line) does not fire', conflictRules('lean skip', view({ ...neg, flip: { line: 605, usable: false }, trapdoor: null }), 8), []);
  eq('Lean skip: a trapdoor 1σ away is not imminent', conflictRules('lean skip', view({ ...neg, flip: { line: 590, usable: true }, trapdoor: { near: { strike: 592, gamma: -1e9 } } }), 8), []);
  eq('Lean skip in a pin box: the views agree', conflictRules('lean skip', view(), 8), []);
  eq('Selective never raises one', conflictRules('selective', view(neg), 8), []);
  eq('no call σ → the board\'s ±1σ is used', conflictRules('trade', view({ pin_box: null, call_wall: { strike: 602.9, gamma: 1e9 } }), null).map(r => r.id), ['call_wall']);
  const stale = gammaView({ ...base, as_of_utc: '2026-10-12T20:00:00.000Z' }, { target: '2026-10-20' });
  eq('a board 8 days old is stale and raises nothing', [stale.stale, conflictRules('trade', stale, 8)], [true, []]);
  const c = tradeConflict(call('trade'), view());
  eq('the conflict object: zone, what gamma reads, rules, never an override', [c.call_zone, c.gamma_reads, c.rules, c.overrides, c.sigma_usd], ['trade', 'pinned', ['pin_box', 'call_wall'], false, 8]);
  ok('…its text shows both views and says the call stands', /the call says Trade .* the gamma board reads pinned .* the call is not changed/.test(c.text));
  eq('agreement → null', tradeConflict(call('trade'), view({ net_gex_per_1pct: -1e9 })), null);
  eq('no board → null', [gammaView(null), tradeConflict(call('trade'), null)], [null, null]);
  ok('the rule constants are the documented ones', CONFLICT.sigma === 0.5 && CONFLICT.maxAgeDays === 4);
  // The real SPY board (fixture, 8 Oct close): spot below a usable flip, net gamma −$1.8bn.
  const fx = JSON.parse(readFileSync('test/fixtures-gamma-board-spy.json', 'utf8'));
  const p = gexFeedPayload('SPY', fx, { mode: 'settled', asOf: fx.row.asOf, today: '2026-10-08' });
  const g = gammaView(p, { target: '2026-10-09' });
  eq('the served SPY board reads below its flip with negative gamma', [g.spot, g.flip, g.net_gamma_bn, g.flip_usable], [774.64, 775.59, -1.83, true]);
  eq('…so a Lean skip call on it carries below_flip', tradeConflict({ ...call('lean skip'), ticker: 'SPY' }, g).rules, ['below_flip']);
  // Through the block: the call is unchanged, the conflict sits beside it.
  const ds = days(300, '2026-10-19');
  const bars = ds.map(d => ({ date: d, open: 600, high: 601, low: 599.5, close: 600 }));
  const S = { qqqBars: bars, spyBars: bars, vxn: ds.map(d => ({ date: d, value: 20 })), vix: ds.map(d => ({ date: d, value: 20 })), squeeze: ds.map((d, i) => [d, 1e9 + i * 1e6]) };
  const plain = tradeDayBlock(S, { target: '2026-10-20' });
  const withG = tradeDayBlock(S, { target: '2026-10-20', gamma: { QQQ: { ...base, ...neg } } });
  eq('the block: same zone and median with or without the board', [withG.calls.QQQ.zone, withG.calls.QQQ.median_r], [plain.calls.QQQ.zone, plain.calls.QQQ.median_r]);
  eq('…lean skip below the flip carries the conflict; SPY without a board has none', [withG.calls.QQQ.zone, withG.calls.QQQ.conflict?.rules, withG.calls.SPY.gamma, withG.calls.SPY.conflict], ['lean skip', ['below_flip', 'trapdoor'], null, null]);
  const snap = snapshotRow({ rows: [] }, withG, '2026-10-20');
  eq('the snapshot keeps the conflict rules and P(trend)', [snap.call.QQQ.conflict, snap.call.QQQ.p_trend], [['below_flip', 'trapdoor'], withG.calls.QQQ.p_trend]);
  // The connector's banned-word filter (substring match: "position", "key", …) on everything new.
  const texts = [withG, c, tradeDayCall('SPY', { cushionPct: 10, gexNegative: true, prevR: 1 }), checkpointRead('SPY', '10:30', { firstRange: 4, open: 600, implied: imp30() }),
    conflictRules('trade', view(), 8), conflictRules('lean skip', view(neg), 8), TREND_MODEL];
  eq('trend and conflict output pass the connector\'s banned-word check', texts.map(t => feedLeaks(JSON.stringify(t))), texts.map(() => []));
}
function imp30() { return 0.2 / Math.sqrt(252); }
{
  // gammaBoards: the feed's board selection, reshaped by the feed's payload builder; the recompute flag passed through.
  const fx = JSON.parse(readFileSync('test/fixtures-gamma-board-spy.json', 'utf8'));
  const seen = [];
  const board = async (t, now, { recompute }) => { seen.push([t, recompute]); return t === 'SPY' ? { board: fx, mode: 'settled', asOf: fx.row.asOf, source: fx.row.asOf } : { board: null }; };
  const g = await gammaBoards({ board, now: Date.parse('2026-10-09T12:00:00Z') });
  eq('SPY reshaped by gexFeedPayload, QQQ without a board is null, never a recompute by default', [g.SPY.spot, g.SPY.flip.line, g.QQQ, seen.sort()], [774.64, 775.59, null, [['QQQ', false], ['SPY', false]]]);
  const g2 = await gammaBoards({ recompute: true, board: async () => { throw new Error('down'); } });
  eq('a failing board is null, not a failed board', [g2.QQQ, g2.SPY], [null, null]);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
