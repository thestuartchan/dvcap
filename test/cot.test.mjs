// test/cot.test.mjs — the CFTC check on the CTA replica (lib/cot.js), and the replica on a past date.
import { cotSeries, cotRead, weekCheck, cotTrack, calibrationSummary, fetchCot, COT_MARKETS, TFF, DISAGG, Z_CLEAR, MOVE_CLEAR, TRACK_WEEKS, TRACK_MIN_HIT, TRACK_MIN_CORR, lastCotRelease, cotReleasedSince } from '../lib/cot.js';
import { ctaMarket, positionAt, positionOn, MIN_BARS } from '../lib/cta.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// ── THE MARKETS AND WHO IS COUNTED ───────────────────────────────────────────
{
  eq('the same six markets as the replica', COT_MARKETS.map(m => m.key), ['ES', 'NQ', 'ZN', 'DX', 'CL', 'GC']);
  eq('financials read leveraged funds from the TFF report', COT_MARKETS.filter(m => m.dataset === TFF).map(m => m.trader), Array(4).fill('leveraged funds'));
  eq('crude and gold read managed money from the disaggregated report', COT_MARKETS.filter(m => m.dataset === DISAGG).map(m => [m.key, m.trader]), [['CL', 'managed money'], ['GC', 'managed money']]);
  eq('the contract codes, as the CFTC lists them', COT_MARKETS.map(m => m.code), ['13874A', '209742', '043602', '098662', '067651', '088691']);
}

// ── PARSING ──────────────────────────────────────────────────────────────────
const raw = (code, date, long, short, oi, disagg = false) => ({
  cftc_contract_market_code: code, report_date_as_yyyy_mm_dd: `${date}T00:00:00.000`, open_interest_all: String(oi),
  ...(disagg ? { m_money_positions_long_all: String(long), m_money_positions_short_all: String(short) }
             : { lev_money_positions_long: String(long), lev_money_positions_short: String(short) }),
});
{
  const s = cotSeries([
    raw('13874A', '2026-09-15', 100, 400, 2000), raw('13874A', '2026-09-08', 100, 450, 2000),
    raw('067651', '2026-09-15', 900, 100, 5000, true), raw('999999', '2026-09-15', 1, 1, 1),
  ]);
  eq('net is long minus short, oldest first', s.ES.map(r => [r.date, r.net]), [['2026-09-08', -350], ['2026-09-15', -300]]);
  eq('managed money reads its own fields', s.CL.map(r => r.net), [800]);
  eq('a code outside the six is ignored', Object.keys(s), ['ES', 'NQ', 'ZN', 'DX', 'CL', 'GC']);
  eq('a market with no rows is empty, not missing', s.GC, []);
}

// ── THE LATEST WEEK AGAINST ITS OWN HISTORY ──────────────────────────────────
{
  // A structural short that has become LESS short: below zero, above its own average.
  const series = [-500, -520, -480, -510, -490, -300].map((net, i) => ({ date: `2026-08-${String(10 + i).padStart(2, '0')}`, net, oi: 2000 }));
  const r = cotRead(series);
  eq('the week and its change', [r.date, r.net, r.netChange], ['2026-08-15', -300, 190]);
  ok('still net short', r.net < 0);
  ok('but well above its own average — that is the direction compared', r.z > 1);
  eq('as a share of open interest', r.netPctOI, -15);
  eq('too little history says nothing', cotRead(series.slice(0, 2)), null);
}

// ── THIS WEEK ────────────────────────────────────────────────────────────────
{
  const read = { date: '2026-09-15', prevDate: '2026-09-08', netChange: 48000, z: 0.66 };
  const at = (p1, p0) => (d) => (d === '2026-09-15' ? p1 : p0);
  eq('net rising while the replica rose: agrees', weekCheck(read, at(0.75, 0.6)), { week: 'agrees', replicaThen: 0.75, replicaMove: 0.15 });
  eq('net rising while the replica fell: disagrees', weekCheck(read, at(0.2, 0.5)).week, 'disagrees');
  eq('a replica that barely moved says nothing', weekCheck(read, at(0.75, 0.73)).week, 'unclear');
  eq('an unchanged net says nothing', weekCheck({ ...read, netChange: 0 }, at(0.75, 0.6)).week, 'unclear');
  eq('thresholds', [Z_CLEAR, MOVE_CLEAR], [0.5, 0.05]);
  eq('no read, no verdict', weekCheck(null, at(1, 1)), null);
}

// ── THE RECORD ───────────────────────────────────────────────────────────────
{
  // 60 Tuesdays; the replica's weekly move alternates, and the net either follows it or opposes it.
  const dates = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2025, 0, 7) + i * 7 * 86400000).toISOString().slice(0, 10));
  const pos = new Map(dates.map((d, i) => [d, (i % 4 < 2 ? 0.1 : -0.1) * (i % 3 + 1)]));
  const posAt = (d) => pos.get(d) ?? null;
  const follow = [{ date: dates[0], net: 0 }];
  const oppose = [{ date: dates[0], net: 0 }];
  for (let i = 1; i < dates.length; i++) {
    const dp = posAt(dates[i]) - posAt(dates[i - 1]);
    follow.push({ date: dates[i], net: follow[i - 1].net + dp * 1000 });
    oppose.push({ date: dates[i], net: oppose[i - 1].net - dp * 1000 });
  }
  const f = cotTrack(follow, posAt), o = cotTrack(oppose, posAt);
  eq('a year of weeks, by default', [TRACK_WEEKS, f.weeks], [52, 52]);
  eq('a category that follows the replica tracks it', [f.hit, f.corr, f.tracks], [1, 1, true]);
  eq('one that runs the other way does not — the leveraged-funds shape', [o.hit, o.corr, o.tracks], [0, -1, false]);
  eq('the bar for tracking', [TRACK_MIN_HIT, TRACK_MIN_CORR], [0.55, 0.15]);
  eq('too few weeks, no record', cotTrack(follow.slice(0, 5), posAt), null);
  const s = calibrationSummary([
    { key: 'CL', date: '2026-09-15', week: 'disagrees', track: { tracks: true } },
    { key: 'GC', date: '2026-09-15', week: 'agrees', track: { tracks: true } },
    { key: 'ES', date: '2026-09-15', week: 'disagrees', track: { tracks: false } },
    null,
  ]);
  eq('the book: which markets are tested, and this week there only', s, { date: '2026-09-15', tested: ['CL', 'GC'], untested: ['ES'], week: { agree: 1, clear: 2 } });
}

// ── THE REPLICA ON A PAST DATE ───────────────────────────────────────────────
{
  const closes = [100];
  for (let i = 1; i < MIN_BARS + 30; i++) closes.push(closes[i - 1] * Math.exp(0.002 + (i % 2 ? 0.01 : -0.01)));
  const bars = closes.map((c, i) => ({ date: new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10), close: c }));
  eq('on the last date it is the live model\'s position', Math.round(positionOn(bars, bars.at(-1).date) * 100), Math.round(ctaMarket(closes).position * 100));
  const mid = bars.at(-11).date;
  eq('on an earlier date it uses only the bars up to it', positionOn(bars, mid), positionAt(closes.slice(0, -10)));
  eq('before enough history, nothing', positionOn(bars, bars[50].date), null);
}

// ── THE FETCH, HERMETIC ──────────────────────────────────────────────────────
{
  const asked = [];
  const fake = async (url) => { asked.push(decodeURIComponent(String(url).replace(/\+/g, " "))); return { ok: true, json: async () => (String(url).includes(TFF) ? [raw('13874A', '2026-09-15', 1, 2, 3)] : [raw('088691', '2026-09-15', 5, 1, 9, true)]) }; };
  const f = await fetchCot({ fetchImpl: fake, today: new Date('2026-09-25T00:00:00Z') });
  eq('two queries, one per report', asked.length, 2);
  ok('each asks only for its own contracts', asked[0].includes("'13874A'") && !asked[0].includes("'088691'") && asked[1].includes("'088691'"));
  ok('and three years back', asked[0].includes("report_date_as_yyyy_mm_dd >= '2023-09"));
  eq('and the series come back per market', [f.ok, f.series.ES.length, f.series.GC[0].net], [true, 1, 4]);
  const bad = await fetchCot({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  eq('a refusal is reported, not guessed', [bad.ok, bad.error], [false, 'CFTC HTTP 503']);
}

// ── THE FRIDAY RELEASE ENDS A CACHE ──
{
  const at = (t) => lastCotRelease(new Date(t))?.toISOString();
  eq('Friday 15:00 ET: the latest release is still last week\'s', at('2026-10-02T19:00:00Z'), '2026-09-25T19:30:00.000Z');
  eq('Friday 15:31 ET: this week\'s, at 15:30 EDT = 19:30 UTC', at('2026-10-02T19:31:00Z'), '2026-10-02T19:30:00.000Z');
  eq('the weekend and Monday still point at Friday', [at('2026-10-03T03:00:00Z'), at('2026-10-05T14:00:00Z')], ['2026-10-02T19:30:00.000Z', '2026-10-02T19:30:00.000Z']);
  eq('in winter 15:30 ET is 20:30 UTC', [at('2026-12-04T20:00:00Z'), at('2026-12-04T20:31:00Z')], ['2026-11-27T20:30:00.000Z', '2026-12-04T20:30:00.000Z']);
  // The 2 Oct case: filled in the morning, read in the evening after the release — out of date.
  eq('a cache filled before the release is out of date after it', cotReleasedSince('2026-10-02T17:00:00Z', new Date('2026-10-02T22:30:00Z')), true);
  eq('one filled after it is not', cotReleasedSince('2026-10-02T20:00:00Z', new Date('2026-10-02T22:30:00Z')), false);
  eq('nor is a morning cache read the same morning', cotReleasedSince('2026-10-02T13:00:00Z', new Date('2026-10-02T17:00:00Z')), false);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
