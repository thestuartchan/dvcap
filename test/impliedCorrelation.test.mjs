// test/impliedCorrelation.test.mjs — COR1M, VIXEQ − VIX and DSPX rows (lib/impliedCorrelation.js).
// Environment-independent: every read goes through an injected fetch, nothing touches the network.
import { parseCboeHistory, parseYahooChart, fetchSeries, gapSeries, gaugeStats, correlationRows, correlationPayload, correlationSummary, BACKTEST,
  CBOE_HISTORY_URL, MIN_SESSIONS } from '../lib/impliedCorrelation.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// ── the two CSV shapes Cboe publishes ──
eq('OHLC history: the CLOSE column, ISO dates, oldest first',
  parseCboeHistory('DATE,OPEN,HIGH,LOW,CLOSE\n10/09/2026,6.88,7.32,6.85,6.93\n10/08/2026,7,7,7,7.10\n'),
  [{ date: '2026-10-08', close: 7.1 }, { date: '2026-10-09', close: 6.93 }]);
eq('single-value history (VIXEQ, DSPX): the value column', parseCboeHistory('DATE,VIXEQ\n06/19/2014,20.78\n'), [{ date: '2014-06-19', close: 20.78 }]);
eq('anything else is nothing, not a guess', [parseCboeHistory('<html>307</html>'), parseCboeHistory('')], [[], []]);
eq('Yahoo chart rows', parseYahooChart({ chart: { result: [{ meta: { gmtoffset: -14400 }, timestamp: [Date.UTC(2026, 9, 9, 13, 30) / 1000], indicators: { quote: [{ close: [14.84] }] } }] } }), [{ date: '2026-10-09', close: 14.84 }]);

// ── a synthetic series: 300 sessions ──
const day = (i) => new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10);
const series = (f, n = 300) => Array.from({ length: n }, (_, i) => ({ date: day(i), close: +f(i).toFixed(2) }));
const flatThenUp = series(i => (i < 295 ? 10 + (i % 3) * 0.1 : 10 + (i - 294)));
const s = gaugeStats(flatThenUp);
eq('changes in points over 5 and 20 sessions', [s.latest, s.ch5, s.ch20], [15, 5, 5]);
eq('the range is the PREVIOUS 60 sessions, so today can break it', [s.range60, s.brk], [{ lo: 10, hi: 14 }, 'above']);
eq('1-year percentile: today above every prior close is 100', s.pct1y, 100);
eq('a 60-point sparkline', s.spark.length, 60);
eq('too little history is no row, not a short one', gaugeStats(flatThenUp.slice(0, MIN_SESSIONS - 1)), null);

eq('the gap is taken on shared dates only', gapSeries([{ date: 'a', close: 30 }, { date: 'b', close: 31 }], [{ date: 'b', close: 15 }]), [{ date: 'b', close: 16 }]);

// ── colours: red = bad, green = good, the benchmark named ──
const ok = (rows) => ({ ok: true, rows, source: 'Cboe', asOf: rows[rows.length - 1].date });
const vixUp = series(i => (i < 295 ? 15 : 15 + (i - 294)));      // VIX +5 over the last 5
const vixFlat = series(() => 15);
const eqFall = series(i => (i < 295 ? 40 : 40 - (i - 294)));     // VIXEQ −5 over the last 5
const eqFlat = series(() => 40);
const eqUp = series(i => (i < 295 ? 40 : 40 + (i - 294)));
const cor = (rows) => correlationRows({ cor1m: ok(rows), vixeq: ok(eqFlat), vix: ok(vixFlat), dspx: ok(eqFlat) });
eq('COR1M rising is red, and the read names the 60-day range', [cor(flatThenUp)[0].tone, /60-day range/.test(cor(flatThenUp)[0].read)], ['bad', true]);
eq('COR1M falling is green', cor(series(i => (i < 295 ? 20 : 20 - (i - 294))))[0].tone, 'good');
const gap = (vixeq, vix) => correlationRows({ cor1m: ok(flatThenUp), vixeq: ok(vixeq), vix: ok(vix), dspx: ok(eqFlat) })[1];
eq('the gap closing WHILE VIX RISES is red', [gap(eqFlat, vixUp).tone, /while VIX rises/.test(gap(eqFlat, vixUp).read)], ['bad', true]);
eq('the gap closing because VIXEQ fell is neutral: broad calm', [gap(eqFall, vixFlat).tone, /broad calm/.test(gap(eqFall, vixFlat).read)], ['neutral', true]);
eq('the gap widening is green', gap(eqUp, vixFlat).tone, 'good');
eq('the gap row says what it was built from', [gap(eqUp, vixFlat).parts, gap(eqUp, vixFlat).unit], [{ vixeq: 45, vix: 15 }, ' pts']);
const dsp = correlationRows({ cor1m: ok(flatThenUp), vixeq: ok(eqUp), vix: ok(vixFlat), dspx: ok(eqFall) })[2];
eq('DSPX is the cross-check: neutral, and says when it disagrees with the gap', [dsp.tone, /disagrees with the gap/.test(dsp.read)], ['neutral', true]);

// ── the summary: now, history, what turns it red ──
const corFall = series(i => (i < 295 ? 20 : 20 - (i - 294)));      // falls to the year's low
const calm = correlationSummary(correlationRows({ cor1m: ok(corFall), vixeq: ok(eqUp), vix: ok(vixFlat), dspx: ok(eqUp) }));
eq('low and falling correlation, gap widening, DSPX agreeing: the index calm because its stocks diverge',
  calm.now, 'Correlation low (bottom 10% of the year) and falling; stocks offsetting more (gap widening, DSPX agrees). The index is calm partly because its stocks are moving apart.');
eq('the bottom-10% flag comes from the unrounded share', [gaugeStats(corFall).low10, gaugeStats(flatThenUp).low10], [true, false]);
eq('the history line is the backtest\'s', calm.history.startsWith(`${BACKTEST.span}: `) && calm.history.includes('not by deeper drawdowns'), true);
eq('what turns it red names the live 60-day high', calm.red, 'COR1M closes above 20.00 (its 60-day high), or the gap closes while VIX rises.');
const stress = correlationSummary(correlationRows({ cor1m: ok(flatThenUp), vixeq: ok(eqFlat), vix: ok(vixUp), dspx: ok(eqFall) }));
eq('correlation breaking out while the gap closes with VIX up: the case the gauges watch for', /moving together more while volatility rises/.test(stress.now) && /the gap closing while VIX rises \(DSPX agrees\)/.test(stress.now), true);
eq('nothing readable: no summary', correlationSummary([{ id: 'cor1m', available: false }]), null);

// ── not available is a reason, never an estimate ──
const missing = correlationRows({ cor1m: { ok: false, error: 'Cboe: HTTP 503; Yahoo: 1 session, not a history' }, vixeq: ok(eqFlat), vix: { ok: false, error: 'Cboe: HTTP 404' }, dspx: ok(eqFlat) });
eq('a series that cannot be read says why', [missing[0].available, missing[0].reason], [false, 'Cboe: HTTP 503; Yahoo: 1 session, not a history']);
eq('the gap without VIX is not available, naming VIX', [missing[1].available, missing[1].reason], [false, 'VIX: Cboe: HTTP 404']);
eq('and no number is invented for either', [missing[0].latest, missing[1].latest], [undefined, undefined]);

// ── the reads: Cboe first, Yahoo when Cboe fails, the source carried ──
const csv = 'DATE,CLOSE\n' + flatThenUp.map(r => `${r.date.slice(5, 7)}/${r.date.slice(8)}/${r.date.slice(0, 4)},${r.close}`).join('\n');
const yj = { chart: { result: [{ meta: { gmtoffset: 0 }, timestamp: flatThenUp.map((r, i) => Date.UTC(2025, 0, 1) / 1000 + i * 86400), indicators: { quote: [{ close: flatThenUp.map(r => r.close) }] } }] } };
const fake = (map) => async (url) => {
  const hit = Object.entries(map).find(([k]) => url.includes(k));
  if (!hit) return { ok: false, status: 404 };
  const [, body] = hit;
  return { ok: true, status: 200, text: async () => body, json: async () => body };
};
const viaCboe = await fetchSeries('COR1M', { fetchImpl: fake({ [CBOE_HISTORY_URL('COR1M')]: csv }) });
eq('Cboe answers: Cboe is the source, with its as-of date', [viaCboe.ok, viaCboe.source, viaCboe.asOf], [true, 'Cboe', day(299)]);
const viaYahoo = await fetchSeries('DSPX', { fetchImpl: fake({ 'finance.yahoo.com': yj }) });
eq('Cboe fails: Yahoo answers and says so', [viaYahoo.ok, viaYahoo.source], [true, 'Yahoo']);
const neither = await fetchSeries('COR1M', { fetchImpl: fake({ 'finance.yahoo.com': { chart: { result: [{ timestamp: [1], indicators: { quote: [{ close: [6.9] }] } }] } } }) });
eq('a one-point Yahoo answer is not a history: not available, both reasons given', [neither.ok, neither.error], [false, 'Cboe: HTTP 404; Yahoo: 1 session, not a history']);
const pay = await correlationPayload({ fetchImpl: fake({ 'COR1M_History': csv, 'VIXEQ_History': csv, 'VIX_History': csv, 'DSPX_History': csv }) });
eq('the payload: three rows, every source named, and the summary', [pay.ok, pay.rows.map(r => r.id), Object.values(pay.sources).map(x => x.source), !!pay.summary?.now], [true, ['cor1m', 'gap', 'dspx'], ['Cboe', 'Cboe', 'Cboe', 'Cboe'], true]);

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
