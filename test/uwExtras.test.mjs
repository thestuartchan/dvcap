// test/uwExtras.test.mjs — after the main UW build (lib/uwExtras.js, lib/routes/flow.js, lib/cronRouter.js):
// short-interest normalisers and bands, dark-pool prints near Desk levels and the once-a-day card,
// the sector ETF board on the snapshot, and the job "recovered" card. Fake tickers, made-up numbers.
import { squeezeWord, shortInterestOf, shortVolumeOf, ftdOf, borrowOf, shortRow, shortsBoard, deskLevels, printsNear, darkpoolAtLevels, darkpoolCard, sectorFlow } from '../lib/uwExtras.js';
import { darkpoolOut, withSectors, UW_DP_POSTED_KEY } from '../lib/routes/flow.js';
import { recoveredCard, OPEN_ALERT_KEY } from '../lib/cronRouter.js';
import { DESK_RULES_KEY } from '../lib/deskRules.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const memKv = () => { const m = new Map(); return { m, configured: () => true, get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); return true; } }; };

// ── shorts: UW's shapes (strings; newest first or last, either way) ──
eq('interest: newest row wins', shortInterestOf({ data: [{ market_date: '2030-01-15', si_float: '0.12', days_to_cover: '2.5', total_float: '1000000', short_interest: '120000' }, { market_date: '2029-12-31', si_float: '0.30' }] }),
  { date: '2030-01-15', siFloat: 0.12, daysToCover: 2.5, float: 1000000, shares: 120000 });
eq('short volume: rows under `si`, 20-day average', shortVolumeOf({ si: [{ market_date: '2030-01-02', short_volume_ratio: '0.4' }, { market_date: '2030-01-03', short_volume_ratio: '0.6' }] }),
  { date: '2030-01-03', ratio: 0.6, avg: 0.5 });
eq('ftds: latest and average', ftdOf({ data: [{ date: '2030-01-02', quantity: 100 }, { date: '2030-01-03', quantity: 300 }] }), { date: '2030-01-03', qty: 300, avg: 200 });
eq('borrow: latest timestamp', borrowOf({ data: [{ timestamp: '2030-01-03T10:00:00Z', fee_rate: '0.25', short_shares_available: '5000' }, { timestamp: '2030-01-02T10:00:00Z', fee_rate: '9' }] }),
  { at: '2030-01-03T10:00:00Z', fee: 0.25, available: 5000 });
eq('bands: 25% of float is crowded', squeezeWord({ siFloat: 0.25 }), 'crowded');
eq('bands: 4 days to cover is elevated', squeezeWord({ siFloat: 0.05, daysToCover: 4 }), 'elevated');
eq('bands: a 12%/yr borrow is crowded', squeezeWord({ fee: 12 }), 'crowded');
eq('bands: quiet name is normal', squeezeWord({ siFloat: 0.03, daysToCover: 1, fee: 0.25 }), 'normal');
eq('bands: no data → no word', squeezeWord({}), null);
const shortGet = async (path) => {
  if (/interest-float/.test(path)) return { data: [{ market_date: '2030-01-15', si_float: '0.22', days_to_cover: '1' }] };
  if (/volume-and-ratio/.test(path)) return { si: [{ market_date: '2030-01-03', short_volume_ratio: '0.5' }] };
  if (/ftds/.test(path)) throw new Error('UW 500');
  return { data: [{ timestamp: '2030-01-03T10:00:00Z', fee_rate: '0.3' }] };
};
const sr = await shortRow({ ticker: 'SAMPLE', get: shortGet });
eq('row: one part failing leaves the rest', [sr.parts.ftds, sr.parts.interest, sr.siFloat, sr.ftd, sr.read], ['UW 500', 'ok', 0.22, null, 'crowded']);
const sb = await shortsBoard({ tickers: ['SAMPLF', 'SAMPLE'], get: async (p) => (/SAMPLE/.test(p) ? shortGet(p) : { data: [] }), now: new Date('2030-01-03T15:00:00Z') });
eq('board: crowded names first', sb.rows.map(r => r.ticker), ['SAMPLE', 'SAMPLF']);
eq('board: New York day', sb.day, '2030-01-03');

// ── dark pool near Desk levels ──
const mirror = { positions: [
  { name: 'SAMPLE A · shares', rules: [{ kind: 'stop', level: 100, symbol: 'NASDAQ:SAMPLE' }, { kind: 'review', symbol: 'NASDAQ:SAMPLE' }] },
  { name: 'Pair', rules: [{ kind: 'stop', level: 1.2, symbol: 'SAMPLE/SAMPLF' }] }] };
eq('levels: only rules with a US ticker and a level', deskLevels(mirror), [{ ticker: 'SAMPLE', level: 100, kind: 'stop', name: 'SAMPLE A · shares' }]);
const prints = [
  { price: '100.30', premium: '2100000', canceled: false },   // within 0.5%
  { price: '99.80', premium: '1500000', canceled: false },    // within
  { price: '101.00', premium: '9000000', canceled: false },   // 1% away
  { price: '100.10', premium: '500000', canceled: false },    // too small
  { price: '100.00', premium: '3000000', canceled: true },    // canceled
];
eq('near: in band, $1M+, not canceled', printsNear(prints, 100), { count: 2, total: 3.6e6, biggest: { price: 100.3, premium: 2.1e6 } });
eq('near: nothing near → null', printsNear(prints, 50), null);
const calls = [];
const dpGet = async (path, o) => { calls.push({ path, query: o?.query }); return { data: prints }; };
const res = await darkpoolAtLevels({ mirror, get: dpGet, day: '2030-01-02' });
eq('levels: one ticker fetched for the day, $1M floor', [calls.length, calls[0].query.date, calls[0].query.min_premium], [1, '2030-01-02', 1e6]);
eq('levels: the hit', [res.hits.length, res.hits[0].count], [1, 2]);
const card = darkpoolCard(res);
eq('card: one line per level', card.embeds[0].fields[0].value, 'Stop 100.00: **$3.6M** across 2 blocks within 0.5% · biggest $2.1M at 100.30');
eq('card: private footer, no mentions', [/private channel only/.test(card.embeds[0].footer.text), card.allowed_mentions], [true, { parse: [] }]);
eq('card: nothing → null', darkpoolCard({ hits: [] }), null);

const kv = memKv(); kv.m.set(DESK_RULES_KEY, mirror);
const sent = []; const deliver = async (h, p) => { sent.push(p); return 'msg-1'; };
const env = { DISCORD_PRIVATE_WEBHOOK: 'https://discord.com/api/webhooks/1/tok' };
const now = new Date('2030-01-02T21:15:00Z');
eq('out: posts once', await darkpoolOut({ kv, deliver, env, now, get: dpGet }), 'posted');
eq('out: never twice a day', [await darkpoolOut({ kv, deliver, env, now, get: dpGet }), sent.length, !!kv.m.get(UW_DP_POSTED_KEY('2030-01-02'))], ['already sent today', 1, true]);
eq('out: no levels', await darkpoolOut({ kv: memKv(), deliver, env, now, get: dpGet }), 'no Desk levels');

// ── sector flow ──
const etfs = { data: [
  { ticker: 'SPY', bullish_premium: '9', bearish_premium: '1' },
  { ticker: 'XLK', full_name: 'Technology Select Sector SPDR Fund', bullish_premium: '5000000', bearish_premium: '2000000', last: '101', prev_close: '100' },
  { ticker: 'XLE', full_name: 'Energy', bullish_premium: '1000000', bearish_premium: '4000000' }] };
const sf = sectorFlow(etfs);
eq('sectors: SPY left out, biggest bullish first', sf.map(r => [r.ticker, r.net]), [['XLK', 3e6], ['XLE', -3e6]]);
eq('sectors: day change', +sf[0].chg.toFixed(3), 0.01);
const snap = await withSectors({ parts: { tide: 'ok' }, ok: 1, of: 1 }, async () => etfs);
eq('snapshot: sectors part counted', [snap.parts.sectors, snap.ok, snap.of], ['ok', 2, 2]);
const snap2 = await withSectors({ parts: { tide: 'ok' }, ok: 1, of: 1 }, async () => { throw new Error('UW 503'); });
eq('snapshot: a failing sector board fails alone', [snap2.parts.sectors, snap2.ok, snap2.sectors], ['UW 503', 1, null]);

// ── job recovered ──
const rc = recoveredCard({ id: 'gex-snapshot-open', slot: '2030-01-02T15:15:00Z' }, { slot: '2030-01-02T14:15:00Z' }, Date.parse('2030-01-02T15:16:00Z'));
eq('recovered: title names the job', rc.embeds[0].title, '✅ Gamma snapshot, open recovered');
eq('recovered: says when it failed', /after the failure at/.test(rc.embeds[0].description), true);
eq('recovered: no mentions', rc.allowed_mentions, { parse: [] });
eq('recovered: open-alert key per job', OPEN_ALERT_KEY('sample-job'), 'dvcap:cron:open:v1:sample-job');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
