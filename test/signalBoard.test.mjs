// test/signalBoard.test.mjs — the Signal Board's state logic, clusters, lean and the trade-day call v2
// (lib/signalBoard.js), and the feed's pure helpers (lib/signalBoardFeed.js). Synthetic series only.
import { stateOf, flipDistance, THRESHOLDS, CLUSTERS, clusterOf, leanOf, whatFlips, buildSignalBoard, creditRows, ratesRows, oilRows,
  dealerRows, tapeRows, asiaRows, narrativeRows, maRow, ratioSeries, realisedVol, downRunBefore, nextMonthlyOpex, sessionsBetween, nextSession,
  tradeDayCall, checkpointRead, tradeDayBlock, normCdf, zoneOf, TRADE_DAY_MODEL, BAND_STATS, CHECKPOINTS, priorR, snapshotRow, scoreRows, scorecard, KOSPI_TEST } from '../lib/signalBoard.js';
import { CUSHION } from '../lib/trendTells.js';
import { firstRanges } from '../lib/signalBoardFeed.js';

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
  eq('narrative is not wired, says so, and does not vote', [narrativeRows()[0].state, narrativeRows()[0].vote, /not wired/.test(narrativeRows()[0].text)], [null, false, true]);
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
  eq('an empty board: every dimension present, no cluster reads, no lean, no flips', [new Set(b.rows.map(r => r.dim)).size, b.clusters.every(c => c.state == null), b.lean.state, b.flips.length], [7, true, 'neutral', 0]);
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

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
