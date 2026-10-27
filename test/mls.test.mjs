// test/mls.test.mjs — the Momentum-Leaders paper trial (lib/mls.js, lib/mlsFeed.js). Made-up tickers,
// prices and dates.
import { MLS, indicators, scan, step, newLedger, summary } from '../lib/mls.js';
import { runMls, yahooSym } from '../lib/mlsFeed.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const near = (n, g, w, tol = 1e-6) => eq(n, Math.abs(g - w) <= tol ? 'ok' : g, 'ok');

// ── indicators ──
const bar = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c });
{
  const bars = [10, 11, 10.5, 10, 12].map((c, i) => bar(`2026-01-0${i + 1}`, c, c + 0.5, c - 0.5, c));
  const ind = indicators(bars);
  // up: 1, 0.5, 0.25, 1.125 · down: 0, 0.25, 0.375, 0.1875 → RSI 100, 66.67, 40, 85.71
  near('RSI(2) with Wilder smoothing', ind.rsi[2], 100 - 100 / (1 + 0.5 / 0.25), 1e-9);
  near('RSI(2) after a recovery', ind.rsi[4], 100 - 100 / (1 + 1.125 / 0.1875), 1e-9);
  eq('IBS is where the close sits in the range', +indicators([bar('d', 10, 12, 8, 9)]).ibs[0].toFixed(2), 0.25);
}
{
  const bars = Array.from({ length: 210 }, (_, i) => bar(`d${i}`, 100 + i, 101 + i, 99 + i, 100 + i));
  const ind = indicators(bars);
  eq('the 200-day needs 200 bars', [ind.sma[198], ind.sma[199]], [null, (100 + 299) / 2]);
  near('6-1 momentum: 21 sessions back over 126 sessions back', ind.mom[209], (100 + 188) / (100 + 83) - 1, 1e-12);
}

// ── scan ── three made-up names on one day
const mk = (rows) => {
  const series = {};
  for (const [sym, r] of Object.entries(rows)) series[sym] = { bars: [{ date: 'D', ...r.bar }], ind: { sma: [r.sma], mom: [r.mom], rsi: [r.rsi], ibs: [r.ibs] }, index: new Map([['D', 0]]) };
  return series;
};
const base = (o) => ({ bar: { open: 100, high: 101, low: 95, close: 96 }, sma: 90, rsi: 10, ibs: 0.1, ...o });
{
  const names = {};
  for (let i = 0; i < 10; i++) names[`ZZ${i}`] = base({ mom: i / 10 });
  names.ZZ8.rsi = 20;                                   // top momentum but not oversold
  names.ZZ7.sma = 99;                                   // below its 200-day
  const s = scan(mk(names), 'D');
  eq('candidates: top 20% by momentum, above the 200-day, RSI < 15, IBS < 0.25 — strongest first', s.candidates.map(c => c.sym), ['ZZ9']);
  eq('breadth counts names above their 200-day', +s.breadth.toFixed(2), 0.9);
}

// ── step ── a scanned day with candidates given directly
const S = (cands, breadth = 0.7) => ({ breadth, candidates: cands.map(sym => ({ sym, rsi: 10, ibs: 0.1, mom: 0.5 })) });
const day = (date, px = {}, extra = {}) => ({ date, open: px, close: px, prevHigh: {}, spy: 500, ...extra });
{
  let L = newLedger(50000);
  let r = step(L, day('2026-11-02', { AAA: 100, BBB: 50 }), S(['AAA', 'BBB', 'CCC']));
  eq('first session queues at most two buys, strongest first', r.ledger.pending.buy, ['AAA', 'BBB']);
  eq('nothing fills on the session it was decided', Object.keys(r.ledger.positions), []);
  r = step(r.ledger, day('2026-11-03', { AAA: 100, BBB: 50 }), S([]));
  const a = r.ledger.positions.AAA;
  eq('fills at the next open, 15% of equity in whole shares', [a.shares, a.entry], [Math.floor(50000 * 0.15 / 100), 100]);
  near('10 bp on the fill', a.cost, 75 * 100 * 1.001, 1e-6);
  // Day 2: AAA closes above its prior high → sell queued; BBB does not.
  r = step(r.ledger, day('2026-11-04', { AAA: 104, BBB: 49 }, { prevHigh: { AAA: 102, BBB: 51 } }), S([]));
  eq('a close above the prior high queues the sell', r.ledger.pending.sell, ['AAA']);
  r = step(r.ledger, day('2026-11-05', { AAA: 105, BBB: 49 }), S([]));
  eq('the sell fills at the next open and is logged', [Object.keys(r.ledger.positions), r.ledger.trades.map(t => [t.sym, t.exit])], [['BBB'], [['AAA', 105]]]);
  eq('the same session is never run twice', step(r.ledger, day('2026-11-05', {}), S([])).actions.note, 'already run for this session');
  // BBB never bounces: out on its 20th session held.
  let L2 = r.ledger, d = 6;
  const iso = (n) => `2026-11-${String(n).padStart(2, '0')}`;
  while (!L2.pending.sell.includes('BBB') && d < 40) { L2 = step(L2, day(iso(d++), { BBB: 48 }), S([])).ledger; }
  eq('the 20-session limit queues the sell', L2.positions.BBB.held, MLS.maxHold);
}
{
  const r = step(newLedger(50000), day('2026-11-02', { AAA: 100 }), S(['AAA'], 0.5));
  eq('breadth at half or below: no new buys', [r.ledger.pending.buy, /breadth 50%/.test(r.actions.gate)], [[], true]);
}
{
  let L = newLedger(50000);
  L.peak = 80000;                                     // 37.5% below the peak
  const r = step(L, day('2026-11-02', {}), S(['AAA']));
  eq('more than 25% below the peak: buys paused', [r.ledger.pending.buy, /drawdown/.test(r.actions.gate)], [[], true]);
}
{
  let L = newLedger(50000);
  L.positions = { AAA: { shares: 10, entry: 100, entryDate: '2026-11-01', held: 1, cost: 1001, last: 100 } };
  L.cash = 49000; L.lastDate = '2026-11-01'; L.start = '2026-11-01';
  const r = step(L, day('2026-11-02', { AAA: 50 }, { splits: { AAA: 2 }, dividends: { AAA: 0.25 } }), S([]));
  eq('a 2-for-1 split doubles the shares and halves the entry', [r.ledger.positions.AAA.shares, r.ledger.positions.AAA.entry], [20, 50]);
  near('the dividend is paid on the post-split shares', r.ledger.cash - 49000 * (1 + MLS.cashRate / 252), 20 * 0.25, 1e-6);
}
{
  let L = newLedger(50000);
  for (let i = 0; i < 9; i++) L.positions[`H${i}`] = { shares: 1, entry: 10, entryDate: '2026-10-01', held: 2, cost: 10, last: 10 };
  L.lastDate = '2026-11-01'; L.start = '2026-10-01';
  const r = step(L, day('2026-11-02', {}), S(['AAA', 'BBB', 'H1']));
  eq('one slot free: one buy, and a held name is never bought again', r.ledger.pending.buy, ['AAA']);
}
eq('summary before any run', summary(newLedger()).started, false);
eq('class shares map to Yahoo symbols', [yahooSym('BRKB'), yahooSym('BFB'), yahooSym('BRK.B'), yahooSym('AAPL')], ['BRK-B', 'BF-B', 'BRK-B', 'AAPL']);

// ── runMls ── coverage guard and the first run, with a fake Yahoo and a fake store
{
  const store = {};
  const kv = { configured: () => true, get: async k => store[k] ?? null, set: async (k, v) => { store[k] = v; return true; }, lock: async () => true, del: async () => true };
  const failing = async () => ({ status: 404, ok: false });
  const r = await runMls({ fetchImpl: failing, kv, now: Date.parse('2026-11-04T22:00:00Z') });
  eq('no SPY bars: nothing replayed', [r.ok, /SPY/.test(r.reason)], [false, true]);
  const spyOnly = async (url) => /SPY/.test(url)
    ? { status: 200, ok: true, json: async () => ({ chart: { result: [{ timestamp: [Date.parse('2026-11-04T14:30:00Z') / 1000], meta: { gmtoffset: 0 }, indicators: { quote: [{ open: [1], high: [1], low: [1], close: [1] }] } }] } }) }
    : { status: 404, ok: false };
  const r2 = await runMls({ fetchImpl: spyOnly, kv, now: Date.parse('2026-11-04T22:00:00Z') });
  eq('members missing: nothing traded, nothing stored', [r2.ok, /members loaded/.test(r2.reason), store['dvcap:mls:paper:v1']], [false, true, undefined]);
  // Every name loads, but Yahoo's bars stop the session before the one that has settled (26 Oct).
  const behind = async () => ({ status: 200, ok: true, json: async () => ({ chart: { result: [{ timestamp: [Date.parse('2026-11-03T14:30:00Z') / 1000], meta: { gmtoffset: 0 }, indicators: { quote: [{ open: [1], high: [1], low: [1], close: [1] }] } }] } }) });
  const r3 = await runMls({ fetchImpl: behind, kv, now: Date.parse('2026-11-04T22:00:00Z') });
  eq('bars that stop before the settled session: a failure, nothing stored', [r3.ok, /end 2026-11-03, before the settled session 2026-11-04/.test(r3.reason), store['dvcap:mls:paper:v1']], [false, true, undefined]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
