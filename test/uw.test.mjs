// test/uw.test.mjs — the Unusual Whales adapter (lib/uw.js) and /api/flow (lib/routes/flow.js):
// each normaliser on UW-shaped answers, the snapshot failing one part at a time, the public health
// answer carrying no numbers, and the close keeping one row a day and posting once, privately.
// Fake tickers and made-up numbers only: UW data is licensed for personal use and never enters the repo.
import { tideSummary, netPremSummary, flowAlertRows, darkpoolLevels, gexLevelsOf, nopeLast, gammaCrossCheck, flowSnapshot, healthOf, dailyRow, closeCard, uwGet, uwConfigured } from '../lib/uw.js';
import { closeOut, UW_DAILY_KEY } from '../lib/routes/flow.js';
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
