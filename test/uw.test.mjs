// test/uw.test.mjs — the Unusual Whales adapter (lib/uw.js) and /api/flow (lib/routes/flow.js):
// each normaliser on UW-shaped answers, the snapshot failing one part at a time, the public health
// answer carrying no numbers, and the close keeping one row a day and posting once, privately.
// Fake tickers and made-up numbers only: UW data is licensed for personal use and never enters the repo.
import { tideSummary, netPremSummary, flowAlertRows, darkpoolLevels, gexLevelsOf, nopeLast, gammaCrossCheck, flowSnapshot, healthOf, dailyRow, closeCard, plainRead, dirDeltaByMinute, closesByMinute, intradayPoints, intradaySnapshot, nyDayOf, uwUsage, UW_SCAN, dailyBars, yangZhang, termCurve, termSlope, uwCalendarVerdict, richWord, volContext, earningsHistory, volRow, deskTickers, nameFlow, isNotable, namesCard, NAMES_NOTABLE, uwGet, uwConfigured } from '../lib/uw.js';
import { closeOut, namesOut, UW_DAILY_KEY } from '../lib/routes/flow.js';
import { DESK_RULES_KEY } from '../lib/deskRules.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

// ── Normalisers ──
const tide = { data: [
  { timestamp: '2030-01-02T09:35:00-05:00', date: '2030-01-02', net_call_premium: '1000000.0000', net_put_premium: '400000.0000', net_volume: 10 },
  { timestamp: '2030-01-02T09:40:00-05:00', date: '2030-01-02', net_call_premium: '1500000.0000', net_put_premium: '2500000.0000', net_volume: -5 },
], date: '2030-01-02' };
const t = tideSummary(tide);
eq('tide: the last point is the day so far (strings parsed)', [t.netCall, t.netPut, t.net, t.lean], [1500000, 2500000, -1000000, 'puts']);
eq('tide: the series keeps every point', t.series.length, 2);
eq('tide: an empty answer is null, not zero', tideSummary({ data: [] }), null);

const ticks = { data: [{ net_call_premium: '100', net_put_premium: '50', net_call_volume: 3, net_put_volume: 1 }, { net_call_premium: '-20', net_put_premium: '10', net_call_volume: 1, net_put_volume: 2 }] };
const np = netPremSummary(ticks);
eq('net premium: per-minute ticks sum to the day', [np.netCall, np.netPut, np.net, np.ticks], [80, 60, 20, 2]);

const alerts = { result: [
  { ticker: 'FAKE', type: 'put', strike: '100', expiry: '2030-01-17', total_premium: '200000', total_ask_side_prem: '150000', total_bid_side_prem: '0', total_size: 50, alert_rule: 'RepeatedHits', has_sweep: true, has_floor: false, all_opening_trades: true, volume_oi_ratio: '1.5', underlying_price: '101.2', created_at: '2030-01-02T15:00:00Z' },
  { ticker: 'FAKE', type: 'call', strike: '105', expiry: '2030-01-10', total_premium: '100000', total_ask_side_prem: '40000', total_bid_side_prem: '45000', total_size: 20, alert_rule: 'VolumeOverOi' },
] };
const fa = flowAlertRows(alerts);
eq('flow alerts: ask side when ≥60% of premium hit the ask', fa[0].side, 'ask');
eq('flow alerts: neither side ≥60% is mixed', fa[1].side, 'mixed');
eq('flow alerts: numbers parsed, flags kept', [fa[0].strike, fa[0].premium, fa[0].sweep, fa[0].opening, fa[0].volOi], [100, 200000, true, true, 1.5]);
eq('flow alerts: the limit applies', flowAlertRows(alerts, { limit: 1 }).length, 1);

const dp = { date: '2030-01-02', stock_price_vol: [
  { price: '100', dark_pool_volume: 500, regular_volume: 10 }, { price: '101', dark_pool_volume: 2000, regular_volume: 10 },
  { price: '60', dark_pool_volume: 9000000, regular_volume: 0 }, { price: '102', dark_pool_volume: 0, regular_volume: 5 },
] };
const lv = darkpoolLevels(dp, { spot: 101, top: 3 });
eq('dark pool: biggest first, inside the band around spot (a stray print far away is dropped)', lv.map(r => r.price), [101, 100]);
eq('dark pool: share of the volume shown', +lv[0].share.toFixed(2), 0.8);

eq('UW GEX levels: read whether wrapped or bare', [gexLevelsOf({ data: { call_wall: '110', put_wall: '95', gamma_flip: 103.5, gamma_magnet: 100 } })?.callWall, gexLevelsOf({ call_wall: 110 })?.callWall], [110, 110]);
eq('UW GEX levels: no level at all is null', gexLevelsOf({ data: { source: 'vol' } }), null);
eq('NOPE: the latest minute with a value', nopeLast({ data: [{ nope: 0.5, timestamp: 'a' }, { nope: null, timestamp: 'b' }] }), { nope: 0.5, fill: null, at: 'a' });

eq('cross-check: under 0.5% apart agrees', gammaCrossCheck({ callWall: 110, flip: 103 }, { callWall: 110.2, flip: 103.1 }, 100), { wallGapPct: -0.2, flipGapPct: -0.1, agree: true });
eq('cross-check: a flip 2% apart is flagged, not resolved', gammaCrossCheck({ callWall: 110, flip: 105 }, { callWall: 110, flip: 103 }, 100).agree, false);

// ── The snapshot ──
const answers = {
  '/api/market/market-tide': tide,
  '/api/stock/FAKE/net-prem-ticks': ticks,
  '/api/stock/FAKE/flow-alerts': alerts,
  '/api/stock/FAKE/gex-levels': { data: { call_wall: 110, gamma_flip: 103 } },
  '/api/darkpool/FAKE/price-levels': dp,
};
const get = async (path) => { if (path in answers) return answers[path]; throw new Error('UW 404'); };
const snap = await flowSnapshot({ tickers: ['FAKE'], get, now: new Date('2030-01-02T21:12:00Z') });
eq('snapshot: each part fails alone (NOPE missing, the rest loaded)', [snap.ok, snap.of, snap.parts['FAKE:nope']], [5, 6, 'UW 404']);
eq('snapshot: the spot for the dark-pool band comes from the alerts', snap.tickers.FAKE.spot, 101.2);
const h = healthOf(snap);
eq('health: part names and states only — no UW number', JSON.stringify(h).match(/1500000|200000|101\.2/), null);
eq('daily row: one compact line for the scorecard', dailyRow(snap), { date: '2030-01-02', tideNet: -1000000, tideLean: 'puts', FAKE_net: 20, FAKE_alerts: 2, FAKE_nope: null });
const card = closeCard(snap);
eq('close card: says it is personal use, private only', card.embeds[0].footer.text.includes('private channel only'), true);
eq('close card: no mentions', card.allowed_mentions, { parse: [] });
eq('close card: the date reads as a day', card.embeds[0].title, '🐋 Flow at the close · Wed 2 Jan');
eq('close card: the plain read first, then Market Tide with the lean in words', [card.embeds[0].fields[0].name, card.embeds[0].fields[1].name, card.embeds[0].fields[1].value.startsWith('**Puts lead**')], ['What it says', 'Market Tide', true]);
eq('close card: one field per ticker', card.embeds[0].fields.map(f => f.name), ['What it says', 'Market Tide', 'FAKE']);
eq('plain read: bearish tide in words', card.embeds[0].fields[0].value.split('\n')[0].includes('leaned **bearish**'), true);
const nz = closeCard({ tide: { date: '2030-01-02', netCall: 1, netPut: 1, lean: 'flat' }, tickers: { FAKE: { nope: { nope: -0.001 }, alerts: [{ type: 'call', strike: 10, expiry: '2030-01-18', premium: 139000, side: 'bid' }] } } });
eq('close card: −0.00 reads 0.00; a premium has no plus sign; the side in words', [nz.embeds[0].fields.at(-1).value.includes('NOPE 0.00'), nz.embeds[0].fields.at(-1).value.includes('Top alert: call 10 Fri 18 Jan · $139k at the bid')], [true, true]);

{
  const pr = plainRead({ tide: { lean: 'calls', net: 300e6 }, tickers: { FAKE: { netPrem: { net: 90e6 }, nope: { nope: 0.12 }, spot: 99, gex: { flip: 100, callWall: 102 }, alerts: [{ type: 'call', premium: 1, side: 'bid' }] } } });
  eq('plain read: tide, then one line per ticker in simple words', pr, [
    'Market-wide: options money leaned **bullish** (heavy call buying / put selling).',
    "FAKE: clear **bullish** flow; options not pushing the price; price below UW's flip (100): moves can run further; ceiling near 102; biggest unusual trade: calls sold."]);
}

// ── 0DTE intraday flow (fake ticker, made-up numbers) ──
{
  const day = '2030-01-02';                               // a Wednesday; 14:30Z = 09:30 New York (EST)
  const g = { data: [
    { timestamp: '2030-01-02T14:20:00Z', dir_delta_flow: '999' },   // pre-open: dropped
    { timestamp: '2030-01-02T14:30:00Z', dir_delta_flow: '1000' },
    { timestamp: '2030-01-02T14:31:00Z', dir_delta_flow: '-400.5' },
    { timestamp: '2030-01-02T14:32:00Z', dir_delta_flow: 'n/a' },   // unreadable: dropped
  ] };
  const flow = dirDeltaByMinute(g, day);
  eq('intraday: session minutes only, numbers parsed', [...flow.values()], [1000, -400.5]);
  const px = closesByMinute({ data: [{ start_time: '2030-01-02T14:31:00Z', close: '101.5' }, { start: '2030-01-02T14:30:00Z', c: 101 }] }, day);
  eq('intraday: closes from REST or short field names', [...px.entries()].sort().map(([, v]) => v), [101, 101.5]);
  const pts = intradayPoints({ all: flow, zero: new Map([['2030-01-02T14:31:00.000Z', -50]]), price: px });
  eq('intraday: running totals from the open', pts.map(p => [p.price, p.cum, p.cum0]), [[101, 1000, 0], [101.5, 600, -50]]);
  const get = async (path) => {
    if (path === '/api/stock/FAKE/greek-flow') return g;
    if (path === `/api/stock/FAKE/greek-flow/${day}`) return { data: [] };
    if (path === '/api/stock/FAKE/ohlc/1m') return { data: [{ start_time: '2030-01-02T14:30:00Z', close: 100 }] };
    throw new Error('UW 404');
  };
  const snap = await intradaySnapshot({ ticker: 'fake', get, now: new Date('2030-01-02T15:00:00Z') });
  eq('intraday: each part reports alone; an empty 0DTE answer is "empty", not an error', [snap.ticker, snap.day, snap.parts, snap.ok, snap.of], ['FAKE', day, { flow: 'ok', '0dte': 'empty', price: 'ok' }, 2, 3]);
  eq('intraday: the New York day, not the UTC one', nyDayOf(new Date('2030-01-03T03:00:00Z')), '2030-01-02');
  eq('usage counts start unknown', [typeof uwUsage.today, typeof uwUsage.limit].every(t => t === 'object' || t === 'number'), true);
}

// ── Volatility & earnings: UW's earnings-calendar screen (fake tickers, made-up numbers) ──
{
  // UW's verdict matrix, all eight rows: slope gates everything.
  const rows = [];
  for (const slopePass of [true, false]) for (const volumePass of [true, false]) for (const ivRvPass of [true, false]) rows.push(uwCalendarVerdict({ slopePass, volumePass, ivRvPass }));
  eq('UW verdict: all eight rows (slope gates)', rows, ['Recommended', 'Consider', 'Consider', 'Avoid', 'Avoid', 'Avoid', 'Avoid', 'Avoid']);
  eq('UW thresholds as published', [UW_SCAN.avgVolume, UW_SCAN.ivRv, UW_SCAN.slope, UW_SCAN.rvWindow, UW_SCAN.slopeDays, UW_SCAN.periods], [1500000, 1.25, -0.00406, 30, 45, 251]);
  const curve = termCurve({ data: [{ dte: 0, volatility: 0.9 }, { dte: 3, volatility: '0.60' }, { dte: 31, volatility: 0.40 }, { dte: 59, volatility: 0.36 }, { dte: 31, volatility: 0.99 }] });
  eq('term curve: expired dropped, sorted, one point per DTE', curve, [[3, 0.6], [31, 0.4], [59, 0.36]]);
  const sl = termSlope(curve);
  eq('slope: nearest expiry to 45 DTE, per day', [+sl.slope.toFixed(6), sl.nearestDte], [+(((0.4 + (0.36 - 0.4) * 14 / 28) - 0.6) / 42).toFixed(6), 3]);
  eq('slope: never extrapolated past the furthest expiry', termSlope([[3, 0.6], [30, 0.4]]).slope, null);
  eq('slope: undefined when the nearest expiry is past 45 DTE', termSlope([[50, 0.6], [80, 0.4]]).why, 'nearest expiry 50 DTE');
  const bars = dailyBars({ data: [
    { date: '2030-01-03', open: 1, high: 1, low: 1, close: 1, market_time: 'r' },   // today: dropped
    { date: '2030-01-02', open: 10, high: 11, low: 9, close: 10.5, volume: 100, market_time: 'r' },
    { date: '2030-01-02', open: 10, high: 11, low: 9, close: 10.5, volume: 100, market_time: 'po' },   // post-market: dropped
  ] }, '2030-01-03');
  eq('daily bars: completed regular sessions only', bars.length, 1);
  const flat = Array.from({ length: 31 }, () => ({ open: 100, high: 100, low: 100, close: 100 }));
  eq('Yang-Zhang: no movement is no number, not zero', yangZhang(flat), null);
  const wiggle = Array.from({ length: 31 }, (_, i) => ({ open: 100 + (i % 2), high: 102 + (i % 2), low: 98 + (i % 2), close: 100.5 + (i % 2) }));
  const big = Array.from({ length: 31 }, (_, i) => ({ open: 100 + 4 * (i % 2), high: 108 + 4 * (i % 2), low: 92 + 4 * (i % 2), close: 102 + 4 * (i % 2) }));
  eq('Yang-Zhang: bigger ranges, higher vol', yangZhang(big) > yangZhang(wiggle) && yangZhang(wiggle) > 0, true);
  eq('Yang-Zhang: needs 31 bars', yangZhang(wiggle.slice(0, 30)), null);
  eq('rich / fair / cheap', [richWord(1.3), richWord(1.0), richWord(0.8), richWord(null)], ['rich', 'fair', 'cheap', null]);
  const ctx = volContext({ data: { iv_rank: '62', implied_move_perc: 0.051, next_earnings_date: '2030-01-20', term_structure_regime: 'backwardation' } });
  eq('context: picked by name, field names kept', [ctx.ivRank, ctx.impliedMovePct, ctx.earningsDate, ctx.termRegime, ctx.fields.length], [62, 0.051, '2030-01-20', 'backwardation', 4]);
  const eh = earningsHistory({ data: [{ report_date: '2029-10-20', post_earnings_move_1d: '-6.0' }, { report_date: '2029-07-20', post_earnings_move_1d: 0.02 }] });
  eq('earnings history: newest first, percent read either way', [eh.n, +eh.meanAbsMove.toFixed(3), eh.lastMove], [2, 0.04, -0.06]);
  eq('context: UW\'s earnings_report_time is the report time', volContext({ data: { earnings_report_time: 'premarket' } }).earningsTime, 'premarket');
  const up = earningsHistory({ data: [{ report_date: '2030-01-20', report_time: 'postmarket', expected_move_perc: '0.071', post_earnings_move_1d: null }, { report_date: '2029-10-20', post_earnings_move_1d: 0.05 }] }, { today: '2030-01-03' });
  eq('earnings: the upcoming report gives the implied move and its date', [up.next, up.n], [{ date: '2030-01-20', time: 'postmarket', expectedMovePct: 0.071 }, 1]);
  const answers = {
    '/api/stock/FAKE/ohlc/1d': { data: big.map((b, i) => ({ ...b, volume: 2e6, market_time: 'r', date: `2029-11-${String(i + 1).padStart(2, '0')}` })) },
    '/api/stock/FAKE/volatility/term-structure': { data: [{ dte: 3, volatility: 2.0 }, { dte: 60, volatility: 0.3 }] },
    '/api/stock/FAKE/volatility/context': { data: { iv_rank: 80 } },
  };
  const row = await volRow({ ticker: 'FAKE', get: async (p) => { if (p in answers) return answers[p]; throw new Error('UW 404'); }, today: '2030-01-03' });
  eq('vol row: each part alone; a missing earnings history is an error code, not a crash', row.parts, { ohlc: 'ok', term: 'ok', context: 'ok', earnings: 'UW 404' });
  eq('vol row: the screen runs on the parts it has', [row.volumePass, row.slopePass, typeof row.ivRv, ['Recommended', 'Consider', 'Avoid'].includes(row.uwVerdict)], [true, true, 'number', true]);
  const mirror = { positions: [{ rules: [{ symbol: 'NASDAQ:FAKA' }, { symbol: 'HKEX:7515' }, { symbol: 'FAKB/FAKC' }, { symbol: 'DJ:DJI' }, { symbol: 'NYSE:FAKA' }] }] };
  eq('desk tickers: US listings and pair legs, QQQ and SPY first, no indices or HK', deskTickers(mirror), ['QQQ', 'SPY', 'FAKA', 'FAKB', 'FAKC']);
  eq('desk tickers: the Trading Ideas watch list is added, once', deskTickers({ ...mirror, watch: ['FAKD', 'NYSE:FAKA', 'HKEX:700'] }), ['QQQ', 'SPY', 'FAKA', 'FAKB', 'FAKC', 'FAKD']);
}

// ── Step 10: flow on the Desk's names (fake tickers, made-up numbers) ──
{
  const day = '2030-01-02';
  const get = async (p) => {
    if (p === '/api/stock/FAKA/net-prem-ticks') return { data: [{ net_call_premium: '7000000', net_put_premium: '1000000' }] };
    if (p === '/api/stock/FAKA/flow-alerts') return { data: [
      { ticker: 'FAKA', type: 'call', strike: '10', expiry: '2030-01-17', total_premium: '1500000', total_ask_side_prem: '1400000', total_bid_side_prem: '100000', has_sweep: true, all_opening_trades: true, created_at: '2030-01-02T16:00:00Z' },
      { ticker: 'FAKA', type: 'put', strike: '9', expiry: '2030-01-17', total_premium: '9000000', created_at: '2029-12-20T16:00:00Z' },   // an older day: ignored
    ] };
    throw new Error('UW 404');
  };
  const r = await nameFlow({ ticker: 'FAKA', get, day });
  eq('names: net premium, today\'s alerts only, opening sweeps counted', [r.net, r.alerts, r.sweeps, r.top.premium, r.top.side], [6000000, 1, 1, 1500000, 'ask']);
  eq('names: notable by net, by a big trade, or by sweeps; quiet otherwise', [isNotable({ net: 6e6 }), isNotable({ net: 1e6, top: { premium: 1.2e6 } }), isNotable({ sweeps: 3 }), isNotable({ net: 1e6, top: { premium: 2e5 }, sweeps: 1 })], [true, true, true, false]);
  eq('names: thresholds', [NAMES_NOTABLE.net, NAMES_NOTABLE.top, NAMES_NOTABLE.sweeps], [5e6, 1e6, 3]);
  const card = namesCard([r, { ticker: 'FAKB', net: -8e6, alerts: 0, sweeps: 0, top: null }, { ticker: 'FAKC', net: 1e5, alerts: 0, sweeps: 0, top: null }], { day });
  eq('names card: notable names only, biggest net first, plain words', [card.embeds[0].fields.map(f => f.name), card.embeds[0].fields[0].value.startsWith('**bearish**'), card.embeds[0].fields[1].value.includes('Biggest: calls bought $1.5M')], [['FAKB', 'FAKA'], true, true]);
  eq('names card: nothing notable, nothing posted', namesCard([{ ticker: 'FAKC', net: 1e5 }], { day }), null);
  eq('names card: private, no mentions', [card.embeds[0].footer.text.includes('private channel only'), card.allowed_mentions], [true, { parse: [] }]);
}

// ── The close: one row a day, posted once, privately ──
const memKv = () => { const m = new Map(); return { m, configured: () => true, get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); return true; } }; };
const kv = memKv(); const sent = [];
const deliver = async (hook, payload) => { sent.push({ hook, payload }); return 'msg-1'; };
const env = { DISCORD_PRIVATE_WEBHOOK: 'https://discord.com/api/webhooks/1/tok', DISCORD_TRADES_WEBHOOK: 'https://discord.com/api/webhooks/2/tok' };
const r1 = await closeOut(snap, { kv, deliver, env });
eq('close: the row is kept and the card posted', [r1.daily, r1.alert], ['kept (1 days)', 'posted']);
eq('close: it went to the PRIVATE webhook, not the trades one', sent[0].hook, env.DISCORD_PRIVATE_WEBHOOK);
const r2 = await closeOut(snap, { kv, deliver, env });
eq('close: a second run the same day keeps one row and does not post again', [kv.m.get(UW_DAILY_KEY).length, r2.alert, sent.length], [1, 'already sent today', 1]);
const kv2 = memKv();
const r3 = await closeOut(snap, { kv: kv2, deliver, env: {} });
eq('close: with no private webhook nothing is posted anywhere, and it says so', [r3.alert, kv2.m.get(UW_DAILY_KEY)[0].posted], ['not posted (private webhook unset or Discord refused)', false]);

// ── Step 10 at the close: the names card, private, once a day ──
{
  const kvN = memKv(); const sentN = [];
  kvN.m.set(DESK_RULES_KEY, { positions: [{ rules: [{ symbol: 'NASDAQ:FAKA' }, { symbol: 'HKEX:7515' }] }] });
  const deliverN = async (hook, payload) => { sentN.push({ hook, payload }); return 'msg-n'; };
  const getN = async (p) => {
    if (p === '/api/stock/FAKA/net-prem-ticks') return { data: [{ net_call_premium: '9000000', net_put_premium: '0' }] };
    if (p === '/api/stock/FAKA/flow-alerts') return { data: [] };
    throw new Error('UW 404');
  };
  const now = new Date('2030-01-02T21:12:00Z');
  const n1 = await namesOut({ kv: kvN, deliver: deliverN, env, now, get: getN });
  const n2 = await namesOut({ kv: kvN, deliver: deliverN, env, now, get: getN });
  eq('names: posted once, to the PRIVATE webhook, only the Desk\'s US names (QQQ/SPY are on the close card)', [n1.alert, n1.names, n2.alert, sentN.length, sentN[0]?.hook], ['posted', 1, 'already sent today', 1, env.DISCORD_PRIVATE_WEBHOOK]);
}

// ── The GET ──
eq('no key, no call', await uwGet('/api/market/market-tide', { env: {} }).then(() => 'called', e => e.message), 'UW_API_KEY unset');
eq('only a UW API path is accepted', await uwGet('https://evil.example/x', { env: { UW_API_KEY: 'k' } }).then(() => 'called', e => e.message), 'bad UW path');
let seen = null;
const fakeFetch = async (url, opts) => { seen = { url, auth: opts.headers.Authorization }; return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
await uwGet('/api/stock/FAKE/flow-alerts', { env: { UW_API_KEY: 'k' }, query: { limit: 5 }, fetchImpl: fakeFetch });
eq('the key goes in the Authorization header, never the URL', [seen.url, seen.auth], ['https://api.unusualwhales.com/api/stock/FAKE/flow-alerts?limit=5', 'Bearer k']);
const failFetch = async () => ({ ok: false, status: 403, json: async () => ({ message: 'secret detail' }) });
eq('a refusal throws the status only, not the body', await uwGet('/api/market/market-tide', { env: { UW_API_KEY: 'k' }, fetchImpl: failFetch }).then(() => 'ok', e => e.message), 'UW 403');
eq('configured only with a non-blank key', [uwConfigured({ UW_API_KEY: ' ' }), uwConfigured({ UW_API_KEY: 'k' })], [false, true]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
