// test/gexFeed.test.mjs — the read-only gamma JSON: only gamma fields, the heatmap's strikes, a slug that holds.
import { gexFeedPayload, feedLeaks, slugMatches, rateBucket, expiryFlag, FEED_BANNED, FEED_TICKERS,
         FEED_RECOMPUTE_MIN, FEED_RATE_PER_HOUR } from '../lib/gexFeed.js';
import { heatCells } from '../lib/gex.js';
import { mustShow } from '../lib/gexLevels.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

// A board shaped like the 2026-09-29 QQQ capture (figures from it), trimmed to a few strikes.
const expiries = ['2026-09-29', '2026-09-30', '2026-10-02'];
const strikes = [760, 745, 741, 740, 736, 735, 730, 726, 710, 707, 700];
const cells = [];
let v = 1;
for (const e of expiries) for (const k of strikes) cells.push({ expiry: e, strike: k, netGexUsd: (k >= 737 ? 1 : -1) * (v++ * 1.37e6) });
const board = {
  row: { symbol: 'QQQ', spot: 736.53, asOf: '2026-09-29T01:30:48.788Z', gexUsd: -894270017.1639107, flipLevel: 738.6063,
         flipZoneLo: 707.7847, flipZoneHi: 738.6063, flipSpreadPctOfSpot: 4.18, flipFragile: true, callWall: 760,
         rate: 0.0408, rateSource: 'DTB3 2026-09-25', rateStatus: 'live', atr: 9.76,
         // Fields a board carries that the feed must NOT pass through.
         callOi: 1514747, putOi: 1721432, contracts: 1331, advUsd: 24244912137 },
  levels: {
    callWall: { strike: 760, kind: 'ceiling', peaks: 1, of: 6, netGexUsd: 644873892 },
    support: { strike: 726, netGexUsd: 408245943, expiry: '2026-09-30', peaks: 1, of: 6 },
    trapdoor: { near: { strike: 736, netGexUsd: -1077692644, expiry: '2026-09-29' }, deep: { strike: 730, netGexUsd: -1214781579, expiry: '2026-09-30' } },
    pin: { pinned: true, lo: 732, hi: 741, front: '2026-09-29', share: 52.8, magnets: [740], strikes: [735, 736, 740, 741] },
    balance: { state: 'balanced', below: -4293468683, above: 3399185846 },
  },
  grid: { cells, expiries: [
    { expiry: '2026-09-29', shareOfAbs: 65.5, netGexUsd: -1892376310.98, peakPutStrike: 736, peakCallStrike: 742 },
    { expiry: '2026-09-30', shareOfAbs: 7.5, netGexUsd: 217439878.74, peakPutStrike: 730, peakCallStrike: 726 },
    { expiry: '2026-10-02', shareOfAbs: 6.1, netGexUsd: 12e6, peakPutStrike: 700, peakCallStrike: 760 },
  ] },
  decay: { moves: { flip: { from: 738.6063, to: 731.204, material: true } } },
  crossCheck: { asOf: '2026-09-29T01:30:23Z', checks: [
    { name: 'call wall', ours: 760, theirs: 760, state: 'match', score: true },
    { name: 'put wall ↔ trapdoor', ours: 730, theirs: 725, state: 'mismatch', score: true },
    { name: 'spot', ours: 736.53, theirs: 737.05, state: 'context', score: false },
  ] },
};
const p = gexFeedPayload('QQQ', board, { mode: 'live_recompute', asOf: '2026-09-29T14:02:00Z', sourceSnapshot: '2026-09-29T13:55:10Z' });
const json = JSON.stringify(p);

{
  eq('the brief\'s fields, in its order', Object.keys(p), ['ticker', 'as_of_utc', 'source_snapshot_utc', 'mode', 'spot', 'net_gex_per_1pct',
     'flip', 'call_wall', 'put_support', 'trapdoor', 'pin_box', 'balance', 'expiries', 'strikes', 'post_expiry_pivot', 'cross_check', 'risk_free']);
  eq('ACCEPTANCE: none of the banned words', feedLeaks(json), []);
  eq('the banned list is the brief\'s', FEED_BANNED, ['position', 'qty', 'nlv', 'journal', 'alert', 'key', 'token']);
  eq('…and the check catches each of them, keys and values, any case', ['{"Position":1}', '{"a":"NLV"}', '{"token":1}', '{"k":"my key"}'].map(s => feedLeaks(s).length > 0), [true, true, true, true]);
  ok('open-interest counts, contract counts and ADV are not passed through', !/1514747|1721432|1331|24244912137/.test(json));
}
{
  eq('times and mode', [p.as_of_utc, p.source_snapshot_utc, p.mode], ['2026-09-29T14:02:00.000Z', '2026-09-29T13:55:10.000Z', 'live_recompute']);
  eq('spot and net GEX per 1% as the tab shows them', [p.spot, p.net_gex_per_1pct], [736.53, -894270017]);
  eq('flip: line, zone, width, and a fragile flip is not usable', p.flip, { line: 738.61, zone_lo: 707.78, zone_hi: 738.61, zone_pct: 4.18, usable: false });
  eq('call wall', p.call_wall, { strike: 760, kind: 'ceiling', expiries_peaking: 1, of: 6 });
  eq('put support', p.put_support, { strike: 726, gamma: 408245943, expiry: '2026-09-30', peaks: 1, of: 6 });
  eq('trapdoors', p.trapdoor, { near: { strike: 736, gamma: -1077692644, expiry: '2026-09-29' }, deep: { strike: 730, gamma: -1214781579, expiry: '2026-09-30' } });
  eq('pin box', p.pin_box, { lo: 732, hi: 741, expiry: '2026-09-29', share_pct: 52.8, magnets: [740] });
  eq('balance', p.balance, { below: -4293468683, above: 3399185846, state: 'balanced' });
  eq('expiry rows, with the panel\'s agreement flag', p.expiries.map(e => [e.date, e.share_pct, e.net, e.peak_put, e.peak_call, e.flag]),
     [['2026-09-29', 65.5, -1892376311, 736, 742, 'trapdoor'], ['2026-09-30', 7.5, 217439879, 730, 726, 'support + trapdoor'], ['2026-10-02', 6.1, 12000000, 700, 760, 'call wall']]);
  eq('post-expiry pivot', p.post_expiry_pivot, { from: 738.61, to: 731.2 });
  eq('cross-check: agreements and disagreements, the spot clock left out, CBOE time', [p.cross_check.agrees.map(c => c.check), p.cross_check.disagrees, p.cross_check.cboe_snapshot_utc],
     [['call wall'], [{ check: 'put wall ↔ trapdoor', ours: 730, theirs: 725 }], '2026-09-29T01:30:23.000Z']);
  eq('risk-free: a print four days older than the board is stale, not live', p.risk_free, { rate: 0.0408, source: 'DTB3 2026-09-25', as_of: '2026-09-25', status: 'stale' });
  const today = gexFeedPayload('QQQ', { ...board, row: { ...board.row, rateSource: 'DTB3 2026-09-29' } }, { asOf: '2026-09-29T14:02:00Z' });
  eq('…one dated the board\'s own day is live', today.risk_free.status, 'live');
  const failed = gexFeedPayload('QQQ', { ...board, row: { ...board.row, rateStatus: 'unavailable' } }, { asOf: '2026-09-29T14:02:00Z' });
  eq('…and unavailable stays unavailable', failed.risk_free.status, 'unavailable');
}
{
  // The strikes are the heatmap's, built the way the panel builds them.
  const m = mustShow(board.levels, { flipZoneLo: board.row.flipZoneLo, flipZoneHi: board.row.flipZoneHi });
  const heat = heatCells(board.grid, { must: m.strikes, flipZone: m.flipZone });
  eq('ACCEPTANCE: the same strike set the heatmap shows', p.strikes.map(s => s.strike), heat.strikes);
  eq('each strike carries its gamma per expiry, whole dollars', p.strikes.find(s => s.strike === 736).by_expiry,
     Object.fromEntries(expiries.map(e => [e, Math.round(heat.at.get(`${e}|736`))])));
}
{
  const bare = gexFeedPayload('SPY', { row: { spot: 765.61, flipLevel: 771.31, flipZoneLo: 762.78, flipZoneHi: 771.31, flipFragile: false } }, {});
  eq('a board with less on it: nulls, never a crash', [bare.pin_box, bare.balance, bare.post_expiry_pivot, bare.cross_check, bare.strikes, bare.flip.usable, bare.mode],
     [null, null, null, null, [], true, 'settled']);
  eq('no support is a null strike, as the tab says "none"', bare.put_support.strike, null);
}
{
  const slug = 'x'.repeat(43);
  eq('the right slug opens it', slugMatches(slug, slug), true);
  eq('a wrong one, a short one, a missing one do not', [slugMatches('y'.repeat(43), slug), slugMatches('x'.repeat(42), slug), slugMatches(null, slug), slugMatches(slug, null)], [false, false, false, false]);
  eq('a stored slug under 32 characters never matches', slugMatches('a'.repeat(20), 'a'.repeat(20)), false);
  eq('an hourly bucket per hashed IP', rateBucket('ab12', new Date('2026-09-29T14:37:00Z')), 'dvcap:gex:feed:rl:v1:ab12:2026-09-29T14');
  eq('QQQ and SPY; five minutes; thirty an hour', [FEED_TICKERS, FEED_RECOMPUTE_MIN, FEED_RATE_PER_HOUR], [['QQQ', 'SPY'], 5, 30]);
  eq('the flag needs a matching peak', expiryFlag({ peakCallStrike: 1, peakPutStrike: 2 }, { callWall: 760, levels: board.levels }), null);
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
