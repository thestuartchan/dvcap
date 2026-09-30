// test/gexFeed.test.mjs — the read-only gamma JSON: only gamma fields, the heatmap's strikes, a slug that holds.
import { gexFeedPayload, feedLeaks, slugMatches, rateBucket, expiryFlag, FEED_BANNED, FEED_TICKERS,
         FEED_RECOMPUTE_MIN, FEED_RATE_PER_HOUR, oiStaleReason, oiSettledLabel } from '../lib/gexFeed.js';
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
     'net_ex_today', 'net_today', 'flip', 'call_wall', 'pin_top', 'put_support', 'trapdoor', 'pin_box', 'balance', 'expiries', 'strikes', 'post_expiry_pivot', 'cross_check', 'risk_free']);
  eq('ACCEPTANCE: none of the banned words', feedLeaks(json), []);
  eq('the banned list is the brief\'s', FEED_BANNED, ['position', 'qty', 'nlv', 'journal', 'alert', 'key', 'token']);
  eq('…and the check catches each of them, keys and values, any case', ['{"Position":1}', '{"a":"NLV"}', '{"token":1}', '{"k":"my key"}'].map(s => feedLeaks(s).length > 0), [true, true, true, true]);
  ok('open-interest counts, contract counts and ADV are not passed through', !/1514747|1721432|1331|24244912137/.test(json));
}
{
  eq('times and mode', [p.as_of_utc, p.source_snapshot_utc, p.mode], ['2026-09-29T14:02:00.000Z', '2026-09-29T13:55:10.000Z', 'live_recompute']);
  eq('spot and net GEX per 1% as the tab shows them', [p.spot, p.net_gex_per_1pct], [736.53, -894270017]);
  eq('flip: line, zone, width, and a fragile flip is not usable', p.flip, { line: 738.61, zone_lo: 707.78, zone_hi: 738.61, zone_pct: 4.18, usable: false });
  eq('call wall', p.call_wall, { strike: 760, kind: 'ceiling', gamma: 644873892, expiries_peaking: 1, of: 6 });
  eq('put support', p.put_support, { strike: 726, gamma: 408245943, expiry: '2026-09-30', peaks: 1, of: 6 });
  eq('trapdoors', p.trapdoor, { near: { strike: 736, gamma: -1077692644, gamma_today: null, expiry: '2026-09-29' }, deep: { strike: 730, gamma: -1214781579, gamma_today: null, expiry: '2026-09-30' } });
  eq('pin box', p.pin_box, { lo: 732, hi: 741, expiry: '2026-09-29', share_pct: 52.8, magnets: [740], magnet_gamma: {} });
  eq('balance', p.balance, { below: -4293468683, above: 3399185846, state: 'balanced' });
  // Shares are of GROSS gamma from the cells (Σ|cell| per expiry ÷ the board's), re-based here on the
  // fixture's trimmed cells; net and gross ride beside them.
  eq('expiry rows, with the panel\'s agreement flag', p.expiries.map(e => [e.date, e.share_pct, e.net, e.peak_put, e.peak_call, e.flag]),
     [['2026-09-29', 11.8, -1892376311, 736, 742, 'trapdoor'], ['2026-09-30', 33.3, 217439879, 730, 726, 'support + trapdoor'], ['2026-10-02', 54.9, 12000000, 700, 760, 'call wall']]);
  eq('…each with its gross', p.expiries.every(e => e.gross > 0 && e.gross >= Math.abs(e.net) - 1 || e.gross > 0), true);
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
{
  // THE 30 SEP BRIEF, on a board with its per-strike rows (levels rebuilt from them at the spot).
  const M = 1e6;
  const cells = [
    ['2026-09-29', 770, 900], ['2026-09-29', 760, -400],                         // yesterday's expiry, still on the record
    ['2026-09-30', 765, 181], ['2026-09-30', 761, -525], ['2026-09-30', 760, -171], ['2026-09-30', 766, 877], ['2026-09-30', 768, 681], ['2026-09-30', 770, 300], ['2026-09-30', 763, -40],
    ['2026-10-01', 765, -147], ['2026-10-01', 785, 319],
    ['2026-10-02', 765, -241], ['2026-10-02', 760, -197], ['2026-10-02', 772, 315], ['2026-10-02', 745, -191],
    ['2026-10-09', 785, 763], ['2026-10-09', 760, -617], ['2026-10-09', 745, -900], ['2026-10-09', 761, -102],
  ].map(([expiry, strike, m]) => ({ expiry, strike, netGexUsd: m * M }));
  const sum = new Map(); for (const c of cells) sum.set(c.strike, (sum.get(c.strike) || 0) + c.netGexUsd);
  const expiries = [...new Set(cells.map(c => c.expiry))].sort().map(expiry => ({ expiry, netGexUsd: cells.filter(c => c.expiry === expiry).reduce((a, c) => a + c.netGexUsd, 0) }));
  const brd = { row: { symbol: 'SPY', spot: 766.33, asOf: '2026-09-30T14:00:00Z', gexUsd: 1e9, callWall: 770 },
                byStrike: [...sum.entries()].map(([strike, netGexUsd]) => ({ strike, netGexUsd })), grid: { cells, expiries } };
  const q = gexFeedPayload('SPY', brd, { mode: 'live_recompute', asOf: '2026-09-30T14:00:00Z', today: '2026-09-30' });
  eq('the morning after an expiry: no date earlier than today', q.expiries.map(e => e.date), ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-09']);
  eq('…nor in the strike columns', q.strikes.every(k => !Object.keys(k.by_expiry).some(d => d < '2026-09-30')), true);
  eq('call wall: the largest positive node above spot, 785; the pin top is 770', [q.call_wall.strike, q.call_wall.gamma, q.pin_top], [785, 1082 * M, 770]);
  eq('near trapdoor: 760/761, not 765 (positive today), with today\'s cell', [q.trapdoor.near.label, q.trapdoor.near.strike, q.trapdoor.near.gamma_today], ['760/761', 760, -171 * M]);
  eq('deep trapdoor: 745', q.trapdoor.deep.strike, 745);
  eq('pin box: the positive run 765–770 with magnets 766 and 768', [q.pin_box.lo, q.pin_box.hi, q.pin_box.magnets], [765, 770, [766, 768]]);
  eq('net ex-today', q.net_ex_today, Math.round(cells.filter(c => c.expiry > '2026-09-30').reduce((a, c) => a + c.netGexUsd, 0)));
  eq('no stale reason unless one is set', 'stale_reason' in q, false);
  const st = gexFeedPayload('SPY', brd, { today: '2026-09-30', staleReason: 'oi_not_published' });
  eq('…and it rides when set', st.stale_reason, 'oi_not_published');
  eq('the feed scan stays clean', feedLeaks(JSON.stringify(q)), []);
  // The OI vintage: yesterday's file before today's rolls is stale; after today's close it is not.
  const v = { priorClose: '2026-09-29T20:00:00.000Z', rolledSinceClose: false };
  eq('before OCC rolls, the board is on yesterday\'s OI', oiStaleReason(v, new Date('2026-09-30T11:15:00Z')), 'oi_not_published');
  eq('once rolled, not stale', oiStaleReason({ ...v, rolledSinceClose: true }, new Date('2026-09-30T13:25:00Z')), null);
  eq('after today\'s close, not stale either', oiStaleReason({ priorClose: '2026-09-30T20:00:00.000Z', rolledSinceClose: false }, new Date('2026-09-30T22:00:00Z')), null);
  eq('the header\'s label', oiSettledLabel({ priorClose: '2026-09-29T20:00:00.000Z', rolledSinceClose: true }), 'OI settled 2026-09-29');
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
