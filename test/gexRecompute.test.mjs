// test/gexRecompute.test.mjs — a reload opens on the last recompute when it is newer than the capture.
import { recomputeRecord, newerRecompute, LAST_RECOMPUTE_KEY, LAST_RECOMPUTE_TTL_SEC } from '../lib/gexStore.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
{
  eq('its own key, per symbol, off the series', LAST_RECOMPUTE_KEY('QQQ'), 'dvcap:gex:recompute:v1:QQQ');
  eq('it expires after a session', LAST_RECOMPUTE_TTL_SEC, 64800);
  const rec = recomputeRecord('QQQ', { ok: true, row: { flipLevel: 730 }, byStrike: [1], grid: null, iv: 'cboe', extra: 'x' }, '2026-09-28T19:00:00Z');
  eq('the record carries what the panel draws and nothing else',
     Object.keys(rec), ['symbol', 'at', 'mode', 'row', 'byStrike', 'grid', 'decay', 'levels', 'crossCheck', 'oi', 'iv', 'atmIv', 'vintage', 'spotSource', 'contracts']);
  const rp = recomputeRecord('SPY', { ok: true, mode: 'repriced', row: { flipLevel: 760 }, repricedFrom: '2026-09-25', capturedAt: '2026-09-26T00:23:49Z', liveIv: 0.02, expiredSinceCapture: 3, reason: 'OI 0%' }, '2026-09-28T14:00:00Z');
  eq('the Yahoo fallback is kept too, with what its "repriced from" note needs',
     [rp.mode, rp.repricedFrom, rp.capturedAt, rp.liveIv, rp.expiredSinceCapture, rp.reason], ['repriced', '2026-09-25', '2026-09-26T00:23:49Z', 0.02, 3, 'OI 0%']);
  eq('a fresh Yahoo chain keeps its mode and carries no note', [recomputeRecord('QQQ', { ok: true, mode: 'fresh', row: {} }).mode, 'repricedFrom' in recomputeRecord('QQQ', { ok: true, mode: 'fresh', row: {} })], ['fresh', false]);
  eq('a refused recompute is not kept', [recomputeRecord('QQQ', { ok: false, reason: 'x' }), recomputeRecord('QQQ', { ok: true })], [null, null]);
  const now = new Date('2026-09-28T19:05:00Z');
  const stored = { date: '2026-09-28', asOf: '2026-09-28T15:40:00Z' };
  eq('newer than the capture: the reload opens on it', newerRecompute(stored, rec, { now })?.at, '2026-09-28T19:00:00Z');
  eq('older than the capture: the capture wins', newerRecompute({ ...stored, asOf: '2026-09-28T19:02:00Z' }, rec, { now }), null);
  eq('a row with only a date counts as 13:00Z', newerRecompute({ date: '2026-09-28' }, rec, { now })?.at, '2026-09-28T19:00:00Z');
  eq('past a session it is dropped even with no newer capture', newerRecompute(stored, rec, { now: new Date('2026-09-29T14:00:00Z') }), null);
  eq('no stored row at all: the recompute stands', newerRecompute(null, rec, { now })?.at, '2026-09-28T19:00:00Z');
  eq('nothing kept, nothing returned', [newerRecompute(stored, null, { now }), newerRecompute(stored, { at: 'x', row: {} }, { now })], [null, null]);
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
