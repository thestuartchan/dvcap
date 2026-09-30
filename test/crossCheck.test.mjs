// test/crossCheck.test.mjs — the cross-check JSON: data and simple statistics, one failing source never fails the rest.
import { buildCrossCheck, crossCheckLeaks, scrubError, statusOf, pctRank, chg5, dir5, computeCredit, computeRealYields, computeBreadth,
         computeAuctions, computeCotMarket, parseDixCsv, computeDix, parseCboeDaily, computePutCall, computeAaii, crossCheckHealth, BLOCKS, CADENCE } from '../lib/crossCheck.js';
import { acmDate, acmSeries, tdRow, XC_COT } from '../lib/crossCheckFeed.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const days = (vals, end = '2026-09-28') => { const out = []; let t = Date.parse(`${end}T00:00:00Z`);
  for (let i = vals.length - 1; i >= 0; ) { const d = new Date(t); t -= 864e5; if (d.getUTCDay() % 6 === 0) continue; out.unshift({ date: d.toISOString().slice(0, 10), value: vals[i--] }); } return out; };

{ // ACCEPTANCE: HY OAS 3.02 on 28 Sep, five prints earlier 2.68.
  const c = computeCredit(days([2.70, 2.66, 2.66, 2.65, 2.71, 2.68, 2.76, 2.78, 2.83, 2.80, 3.02]));
  eq('ACCEPTANCE: chg_5d_bp ≈ 34, widening', [c.as_of, c.chg_5d_bp, c.dir_5d], ['2026-09-28', 34, 'widening']);
  eq('…with the last ten prints', c.series.length, 10);
  eq('the ±3bp band is flat', [dir5(3), dir5(-3), dir5(4), dir5(-4)], ['flat', 'flat', 'widening', 'tightening']);
  eq('five prints need six observations', chg5(days([1, 2, 3, 4, 5])), null);
  const r = computeRealYields({ real: days([2.8, 2.82, 2.85, 2.88, 2.9, 2.93]), breakeven: days([2.4, 2.41, 2.42, 2.41, 2.43, 2.45]) });
  eq('real yields and breakevens, each with its own change', [r.tips_10y.chg_5d_bp, r.breakeven_10y.chg_5d_bp], [13, 5]);
}
{
  const b = computeBreadth({ rsp: { '2026-09-21': 200, '2026-09-22': 201, '2026-09-23': 199, '2026-09-24': 198, '2026-09-25': 199, '2026-09-28': 197 },
                             spy: { '2026-09-21': 760, '2026-09-22': 765, '2026-09-23': 766, '2026-09-24': 760, '2026-09-25': 762, '2026-09-28': 768 } });
  eq('breadth: RSP/SPY over five sessions, and SPY\'s own move', [b.ratio_rsp_spy.length, b.ratio_chg_5d_pct, b.spy_chg_5d_pct], [6, -2.53, 1.05]);
}
{
  const row = (d, tenor, btc, ind, dir, dlr, type = 'Note') => ({ cusip: `X${d}${tenor}`, type, tenor, term: tenor, auctionDate: d, reopening: false, highYield: 4.1, bidToCover: btc, indirectPct: ind, directPct: dir, dealerPct: dlr });
  const hist = ['2026-03-25', '2026-04-24', '2026-05-27', '2026-06-25', '2026-07-28', '2026-08-26'].map((d, i) => row(d, '5-Year', 2.4 + i * 0.02, 65 + i, 20, 15 - i));
  const a = computeAuctions([...hist, row('2026-09-29', '5-Year', 2.31, 60.2, 21.1, 18.7)], '2026-09-30');
  eq('an auction in the window, against the previous six of its tenor', [a.items.length, a.items[0].prev_n, a.items[0].prev_avg], [1, 6, { bid_to_cover: 2.45, indirect_pct: 67.5, direct_pct: 20, dealer_pct: 12.5 }]);
  eq('…with no tail, and saying why', /tail omitted/.test(a.scope), true);
  const none = computeAuctions(hist, '2026-09-30');
  eq('ACCEPTANCE: no auction in three days → empty list with the note', [none.items, none.note], [[], 'no coupon auctions in the last 3 days']);
  eq('the direct share is computed from TreasuryDirect\'s accepted amounts', tdRow({ securityType: 'Note', originalSecurityTerm: '5-Year', auctionDate: '2026-09-29T00:00:00', bidToCoverRatio: '2.31', competitiveAccepted: '1000', indirectBidderAccepted: '602', directBidderAccepted: '211', primaryDealerAccepted: '187' }),
     { cusip: null, type: 'Note', tenor: '5-Year', term: null, auctionDate: '2026-09-29', reopening: false, highYield: null, bidToCover: 2.31, indirectPct: 60.2, directPct: 21.1, dealerPct: 18.7 });
}
{
  const weeks = Array.from({ length: 52 }, (_, i) => ({ date: `w${String(i).padStart(2, '0')}`, net: 100000 + i * 1000 }));
  const g = computeCotMarket(weeks, { trader: 'managed money' });
  eq('ACCEPTANCE: gold net at its 52-week high → top decile, extreme', [g.pct_rank_52w >= 90, g.extreme, g.net_chg_wk], [true, true, 1000]);
  eq('a middling week is not extreme', computeCotMarket([...weeks, { date: 'w52', net: 125000 }], { trader: 'x' }).extreme, false);
  eq('the four markets and their codes, as verified against the API', XC_COT.map(m => [m.key, m.code, m.trader]),
     [['wti', '067651', 'managed money'], ['gold', '088691', 'managed money'], ['jpy', '097741', 'leveraged funds'], ['ust10y', '043602', 'leveraged funds']]);
}
{
  const csv = 'date,price,dix,gex\n' + Array.from({ length: 300 }, (_, i) => `2025-${String(1 + Math.floor(i / 28) % 12).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')},6000,${(0.40 + (i % 50) / 1000).toFixed(4)},${i % 3 ? 1e9 : -1e9}`).join('\n');
  const d = computeDix(parseDixCsv(csv));
  eq('DIX: ten rows, the sign of the latest GEX, and a one-year rank', [d.series.length, d.gex_sign, typeof d.dix_pct_rank_1y], [10, 'positive', 'number']);
  const pc = parseCboeDaily({ ratios: [{ name: 'TOTAL PUT/CALL RATIO', value: '0.76' }, { name: 'INDEX PUT/CALL RATIO', value: '1.01' }, { name: 'EQUITY PUT/CALL RATIO', value: '0.38' }] }, '2026-09-29');
  eq('Cboe daily ratios by name', pc, { date: '2026-09-29', total: 0.76, equity: 0.38, index: 1.01 });
  const p = computePutCall([{ date: '2026-09-25', total: 0.75, equity: 0.52, index: 0.95 }, pc]);
  eq('put/call: last sessions and a rank that says its sample', [p.as_of, p.sessions.length, p.equity_pct_rank_1y, p.rank_sample_sessions], ['2026-09-29', 2, 25, 2]);
  const a = computeAaii([{ date: '2026-09-17', bullish: 0.35, neutral: 0.30, bearish: 0.35 }, { date: '2026-09-24', bullish: 0.42, neutral: 0.28, bearish: 0.30 }]);
  eq('AAII in percent, with the spread', [a.bullish, a.bearish, a.bull_bear_spread], [42, 30, 12]);
}
{
  eq('ACM dates as the NY Fed writes them', [acmDate('28-Sep-2026'), acmDate('2-Jan-1961'), acmDate(46293)], ['2026-09-28', '1961-01-02', '2026-09-28']);
  const cells = new Map([['0,0', 'DATE'], ['0,20', 'ACMTP10'], ['1,0', '25-Sep-2026'], ['1,20', 0.7747], ['2,0', '28-Sep-2026'], ['2,20', 0.7927]]);
  eq('the ACM daily sheet, column ACMTP10', acmSeries({ sheets: [{ name: 'ACM Monthly', cells: new Map(), maxRow: 0 }, { name: 'ACM Daily', cells, maxRow: 2 }] }),
     [{ date: '2026-09-25', value: 0.7747 }, { date: '2026-09-28', value: 0.7927 }]);
}
{
  eq('a daily-lag-1 series is fresh on Monday reading Friday', statusOf('credit', '2026-09-25', '2026-09-28'), 'fresh');
  eq('…and stale three business days late', statusOf('credit', '2026-09-23', '2026-09-28'), 'stale');
  eq('a weekly COT report is fresh into the next week', statusOf('positioning', '2026-09-22', '2026-09-30'), 'fresh');
  eq('…and stale once the next release is well overdue', statusOf('positioning', '2026-09-08', '2026-09-30'), 'stale');
  eq('mid-rank percentile', [pctRank([1, 2, 3, 4], 4), pctRank([1, 1, 1], 1)], [88, 50]);
}
{ // ACCEPTANCE: one source blocked, everything else present, one response.
  const now = new Date('2026-09-30T13:00:00Z');
  const store = new Map();
  const cache = { get: async (b) => store.get(b) ?? null, set: async (b, v) => { store.set(b, v); } };
  let calls = 0;
  const ok = (as_of) => async () => { calls++; return { as_of, value: 1 }; };
  const sources = Object.fromEntries(BLOCKS.map(b => [b, ok('2026-09-29')]));
  sources.sentiment_aaii = async () => { throw new Error('403 from source'); };
  sources.put_call = async () => { throw new Error('GET https://cdn.example/x?api_key=SECRET123 failed'); };
  const p = await buildCrossCheck({ sources, cache, now });
  eq('ACCEPTANCE: AAII blocked → unavailable with its error', [p.blocks.sentiment_aaii.status, p.blocks.sentiment_aaii.error], ['unavailable', '403 from source']);
  eq('…and every other block present', BLOCKS.filter(b => b !== 'sentiment_aaii' && b !== 'put_call').every(b => p.blocks[b].status === 'fresh' && p.blocks[b].as_of && p.blocks[b].fetched_at_utc), true);
  eq('blocks in the brief\'s order', Object.keys(p.blocks), BLOCKS);
  eq('an error never carries a URL, a query or a credential', [p.blocks.put_call.error.includes('SECRET'), p.blocks.put_call.error.includes('http')], [false, false]);
  eq('ACCEPTANCE: the payload scan is clean', crossCheckLeaks(JSON.stringify(p)), []);
  const before = calls;
  const again = await buildCrossCheck({ sources, cache, now: new Date('2026-09-30T13:20:00Z') });
  eq('ACCEPTANCE (speed): a second call inside the cache window fetches nothing', [calls - before, again.blocks.credit.status], [0, 'fresh']);
  sources.credit = async () => { throw new Error('timeout'); };
  const later = await buildCrossCheck({ sources, cache, now: new Date('2026-10-01T01:00:00Z') });
  eq('a failed refresh serves the last good copy, with the refresh error', [later.blocks.credit.as_of, later.blocks.credit.refresh_error], ['2026-09-29', 'timeout']);
  eq('health is statuses only — no data', Object.keys(crossCheckHealth(p).credit), ['status', 'as_of', 'fetched_at_utc', 'error']);
  eq('every block has a cadence and a cache time', BLOCKS.every(b => CADENCE[b].cadence && CADENCE[b].ttlS > 0), true);
}
{
  eq('the leak scan catches the banned words as words', ['{"a":"position"}', '{"api_key":"x"}', '{"Token":1}', '{"qty":1}', '{"alerts":[]}'].map(s => crossCheckLeaks(s).length > 0), [true, true, true, true, true]);
  eq('…and not the block named "positioning", nor "monkey"', crossCheckLeaks('{"positioning":{},"x":"monkey"}'), []);
  eq('scrubbed errors', scrubError(new Error('FRED_API_KEY not set')), 'FRED_API_[redacted] not set');
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
