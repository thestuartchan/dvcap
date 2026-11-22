// lib/noiseBand.js + lib/noiseBandFeed.js — the noise-band paper trial (fake bars, no network).
import { dayArray, sigmaFrom, decide, step, newLedger, summary, realisedVol, sessionMinute, RULES, EXPECT, checkTime } from '../lib/noiseBand.js';
import { runNoiseBand, regimeFor } from '../lib/noiseBandFeed.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w); if (a === b) { pass++; console.log('✅', n); } else { fail++; console.log('❌', n, ' got', a, 'want', b); } };
const ok = (n, c) => eq(n, !!c, true);

eq('09:30 ET is minute 0 (winter)', sessionMinute('2026-11-23T14:30:00Z'), 0);
eq('09:30 ET is minute 0 (summer)', sessionMinute('2026-07-06T13:30:00Z'), 0);
eq('the 15:44 bar is the exit bar', sessionMinute('2026-11-23T20:44:00Z'), RULES.exitIdx);
eq('the 10:00 check fills at the 10:00 bar open', checkTime(29), '10:00');

// A synthetic day: flat at 100 to 10:00, then falling 0.01 a minute (a clean short).
const iso = (m) => new Date(Date.parse('2026-11-23T14:30:00Z') + m * 60000).toISOString();
const mkDay = (path) => Array.from({ length: 390 }, (_, m) => { const p = path(m); return { start_time: iso(m), open: p, high: p + 0.01, low: p - 0.01, close: p, volume: 1000, market_time: 'r' }; });
const falling = mkDay(m => (m < 29 ? 100 : 100 - (m - 28) * 0.01));
const a = dayArray(falling);
eq('390 bars', a.length, 390);
eq('a half day is not a session', dayArray(falling.slice(0, 210)), null);
const quiet = Array.from({ length: 20 }, () => new Array(390).fill(0.0005));
const sig = sigmaFrom(quiet);
eq('sigma needs 20 sessions', sigmaFrom(quiet.slice(0, 19)), null);
const r = decide(a, sig, 0.01);
eq('the falling day is a short', r.d, -1);
eq('…at the first check that clears the range by 0.05%', r.m, 39);
ok('…filled at the next open, 2bp worse', Math.abs(r.entry - a[40][0] * (1 - 0.0002)) < 1e-3);
ok('…and exits at the 15:44 close', r.exit === +a[374][3].toFixed(4));
eq('vol 1% → 1× size', r.lev, 1);
eq('size capped at 4×', decide(a, sig, 0.001).lev, 4);
eq('a flat day does not trade', decide(dayArray(mkDay(() => 100)), sig, 0.01).status, 'none');
ok('realised vol needs 15 closes', realisedVol(new Array(14).fill(100)) === null && realisedVol(new Array(15).fill(100)) === 0);

// Ledger: seed 20 days before the start, then a trade day.
const L = newLedger();
for (let i = 0; i < 20; i++) step(L, `2026-10-${String(i + 1).padStart(2, '0')}`, dayArray(mkDay(m => 100 + (m % 7) * 0.02)));
eq('seed days do not trade or move the ledger', [L.days.length, L.lastDate], [0, null]);
step(L, '2026-11-23', a, { zone: 'trade', band: '<20th' });
eq('the start day trades', L.days.at(-1).status, 'trade');
eq('regime recorded', L.days.at(-1).zone, 'trade');
const S = summary(L);
eq('one trade, collecting', [S.trades, S.verdict.state], [1, 'collecting']);
ok('equity moved by size × return', Math.abs(S.equity - 100000 * (1 + L.days.at(-1).lev * L.days.at(-1).ret)) < 0.02);
eq('half day recorded as skipped', step(L, '2026-11-27', null).days.at(-1).status, 'skipped');
// Verdict after 40 trades
const V = newLedger(); V.days = Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, status: 'trade', d: -1, ret: -0.005, equity: 100000 }));
eq('a mean well below the band is flagged', summary(V).verdict.state, 'off');
V.days.forEach(x => { x.ret = 0.001; });
eq('a mean in range is consistent', summary(V).verdict.state, 'consistent');
eq('pre-registered expectation', [EXPECT.mean, EXPECT.minTrades], [0.0009, 40]);

// regime: prior close's GEX
const gex = Array.from({ length: 300 }, (_, i) => [new Date(Date.parse('2025-09-01') + i * 86400000).toISOString().slice(0, 10), 1e9 + i * 1e6]);
gex.push(['2026-11-20', -5e8]);
eq('negative GEX at the prior close → GEX negative band', regimeFor('2026-11-23', gex)?.band, 'GEX negative');

// The run: seeds, scores, stores; refuses without Redis.
process.env.UW_API_KEY = 'x';
const store = {};
const kv = { configured: () => true, get: async (k) => store[k] ?? null, set: async (k, v) => { store[k] = v; return true; }, lock: async () => true, del: async () => true };
const get = async (_p, { query }) => ({ data: query.date === '2026-11-23' ? falling : query.date < '2026-11-23' ? mkDay(m => 100 + (m % 7) * 0.02) : [] });
const res = await runNoiseBand({ now: Date.parse('2026-11-23T22:00:00Z'), get, gex: async () => ({ ok: false, rows: [] }), kv });
eq('first run scores the start session', res.replayed, ['2026-11-23']);
eq('…as a short', res.summary.shorts, 1);
const again = await runNoiseBand({ now: Date.parse('2026-11-23T22:30:00Z'), get, gex: async () => ({ ok: false, rows: [] }), kv });
eq('a second run the same evening replays nothing', again.replayed, []);
eq('no Redis, no run', (await runNoiseBand({ kv: { ...kv, configured: () => false } })).ok, false);

console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exit(1);
