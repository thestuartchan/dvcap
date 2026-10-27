// lib/mlsFeed.js — the paper trial's daily run (lib/mls.js): fetch a year of daily bars for every
// S&P 500 member and every name still held, replay each settled session since the last run, store.
//
// Raw Yahoo chart bars with their split and dividend events — the same source the backtest used.
// A missed run heals itself: every session after `lastDate` is replayed in order from the bars, so
// a weekend, a holiday or a failed workflow day loses nothing.
//
// FAIL CLOSED ON THIN DATA. A session where fewer than 95% of the members came back is not traded:
// a breadth or momentum rank over half the index is a different strategy, and a buy that only
// happened because the names that would have outranked it failed to load is not the model's.
import { MLS, indicators, scan, step, newLedger, summary } from './mls.js';
import { kvGetJson, kvSetJson, kvSetNxEx, kvDel, kvConfigured } from './kv.js';
import { lastSettledSession } from './ratios.js';
import SP500 from '../data/sp500_constituents.json' with { type: 'json' };

export const MLS_KEY = 'dvcap:mls:paper:v1';
const LOCK_KEY = 'dvcap:mls:lock:v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const COVERAGE_MIN = 0.95;

// The constituents file writes class shares without the dot (BRKB); Yahoo wants BRK-B.
const YAHOO_ALIAS = { BRKB: 'BRK-B', BFB: 'BF-B' };
export const yahooSym = (s) => YAHOO_ALIAS[s] || String(s).replace('.', '-');

export async function fetchBars(sym, range = '1y', fetchImpl = fetch) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym(sym))}?interval=1d&range=${range}&events=div%2Csplits`;
  for (let k = 0; k < 2; k++) {
    try {
      const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (r.status === 404) return null;
      if (!r.ok) continue;
      const res = (await r.json())?.chart?.result?.[0];
      const ts = res?.timestamp || [], q = res?.indicators?.quote?.[0] || {}, off = res?.meta?.gmtoffset ?? 0;
      const day = (t) => new Date((t + off) * 1000).toISOString().slice(0, 10);
      const bars = [];
      for (let i = 0; i < ts.length; i++) {
        const [o, h, l, c] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]];
        if ([o, h, l, c].every(x => typeof x === 'number') && h >= l) bars.push({ date: day(ts[i]), open: o, high: h, low: l, close: c });
      }
      const ev = res?.events || {};
      const splits = Object.values(ev.splits || {}).map(s => ({ date: day(s.date), ratio: s.numerator / s.denominator }));
      const dividends = Object.values(ev.dividends || {}).map(d => ({ date: day(d.date), amount: d.amount }));
      return bars.length ? { bars, splits, dividends } : null;
    } catch { /* one retry */ }
  }
  return null;
}

async function fetchAll(syms, fetchImpl) {
  const out = {};
  // Twelve at a time: about 20 s for the whole index (measured 32 s at eight), inside the route's 60.
  for (let i = 0; i < syms.length; i += 12) {
    if (i) await new Promise(r => setTimeout(r, 150));
    await Promise.all(syms.slice(i, i + 12).map(async s => { out[s] = await fetchBars(s, '1y', fetchImpl); }));
  }
  return out;
}

export async function runMls({ fetchImpl = fetch, now = Date.now(), kv = { get: kvGetJson, set: kvSetJson, lock: kvSetNxEx, del: kvDel, configured: kvConfigured } } = {}) {
  if (!kv.configured()) return { ok: false, reason: 'Redis not configured' };
  if (!(await kv.lock(LOCK_KEY, '1', 300))) return { ok: false, reason: 'a run is already in progress' };
  try {
    const prev = (await kv.get(MLS_KEY)) || newLedger();
    const settled = lastSettledSession(now);
    if (prev.lastDate && prev.lastDate >= settled) return { ok: true, note: `already run through ${prev.lastDate}`, summary: summary(prev) };
    const members = SP500.symbols || [];
    const held = Object.keys(prev.positions || {});
    const syms = [...new Set([...members, ...held, 'SPY'])];
    const raw = await fetchAll(syms, fetchImpl);
    const spy = raw.SPY;
    if (!spy) return { ok: false, reason: 'SPY bars did not load — nothing replayed' };

    const series = {};
    for (const s of members) {
      const d = raw[s];
      if (!d) continue;
      series[s] = { bars: d.bars, ind: indicators(d.bars), index: new Map(d.bars.map((b, i) => [b.date, i])) };
    }
    const coverage = Object.keys(series).length / members.length;
    if (coverage < COVERAGE_MIN) return { ok: false, reason: `only ${Object.keys(series).length} of ${members.length} members loaded — nothing traded` };

    // Every settled session after the last run, oldest first. The first run only reads the close
    // and queues — nothing fills before a session the ledger has seen.
    const sessions = spy.bars.map(b => b.date).filter(d => d <= settled && (!prev.lastDate || d > prev.lastDate));
    const todo = prev.lastDate ? sessions : sessions.slice(-1);
    // NOT YET, NOT "NOTHING TO DO". On 26 Oct the 21:45 UTC run started three hours late and Yahoo's
    // SPY series did not yet carry Monday's bar: it replayed nothing and reported success, so the day's
    // fills waited for a manual run. A session that should be there and is not is a failure the
    // workflow shows — and the later run replays it, since nothing was stored.
    const lastBar = spy.bars[spy.bars.length - 1]?.date;
    if (!todo.length || lastBar < settled) return { ok: false, reason: `Yahoo's SPY bars end ${lastBar}, before the settled session ${settled} — nothing replayed; the next run will` };
    let L = prev, log = [];
    for (const date of todo) {
      const day = { date, open: {}, close: {}, prevHigh: {}, splits: {}, dividends: {}, spy: spy.bars.find(b => b.date === date)?.close ?? null };
      const since = L.lastDate || date;
      for (const s of new Set([...Object.keys(series), ...Object.keys(L.positions), ...(L.pending?.buy || [])])) {
        const d = raw[s];
        if (!d) continue;
        const i = d.bars.findIndex(b => b.date === date);
        if (i < 0) continue;
        day.open[s] = d.bars[i].open; day.close[s] = d.bars[i].close;
        if (i > 0) day.prevHigh[s] = d.bars[i - 1].high;
        // Events dated after the previous session up to and including this one.
        const k = d.splits.filter(x => x.date > since && x.date <= date).reduce((a, x) => a * x.ratio, 1);
        if (k !== 1) day.splits[s] = k;
        const dv = d.dividends.filter(x => x.date > since && x.date <= date).reduce((a, x) => a + x.amount, 0);
        if (dv) day.dividends[s] = dv;
      }
      const { ledger, actions } = step(L, day, scan(series, date));
      L = ledger;
      log.push({ date, ...actions });
    }
    // Keep the stored history bounded: a year of daily rows, the last 500 trades.
    L.history = L.history.slice(-400); L.trades = L.trades.slice(-500);
    if (!(await kv.set(MLS_KEY, L))) return { ok: false, reason: 'Redis write failed — the ledger was left as it was' };
    return { ok: true, replayed: todo.length, coverage: +coverage.toFixed(3), summary: summary(L), log };
  } finally {
    await kv.del(LOCK_KEY).catch(() => {});
  }
}

export async function readMls(kvGet = kvGetJson) {
  const L = await kvGet(MLS_KEY);
  if (!L) return { ok: true, started: false, rules: MLS };
  return { ok: true, rules: MLS, summary: summary(L), positions: L.positions, pending: L.pending, history: L.history.slice(-260), trades: L.trades.slice(-100) };
}
