// lib/signalBoardFeed.js — the Signal Board's inputs, fetched once and cached, and the board built on them.
//
// NOT A SECOND SPINE. The series the market-state engine already fetches (HY OAS, MOVE, VIX, VIX3M,
// VIX9D, RSP, SPY, IWM — lib/marketStateFeed.js stateInputs, KV-cached half an hour) are read from that
// cache, not refetched. Put/call is the cross-check feed's Cboe history (lib/crossCheckFeed.js, its KV
// block), not a second scrape. The cushion is SqueezeMetrics' DIX.csv through lib/squeeze.js, as the
// Gamma tab reads it. Only what nothing else fetches is fetched here: HYG, LQD, QQQ, SOXX, the SPX and
// SPY bars, ^TNX, ^SKEW, ^VXN, Brent, KOSPI, BTC-USD and ETH-USD (the macro spine
// reads BTC-USD too but keeps only a summary; the board needs the series), all keyless Yahoo daily bars; and the Narrative row's
// GDELT coverage and tone (lib/narrativeFeed.js, its own three-hour cache because GDELT rate-limits).
//
// Market data only: no account, book or journal store is read on this path.
import { stateInputs } from './marketStateFeed.js';
import { kvBlockCache } from './crossCheckFeed.js';
import { scrubError } from './crossCheck.js';
import { fetchSqueezeGex } from './squeeze.js';
import { yahooDailyMap, yahooDailyOHLC, yahooBars, yahooPrePost } from './yahoo.js';
import { mapToSeries } from './marketStateFeed.js';
import { kvGetJson, kvSetJsonEx, kvConfigured } from './kv.js';
import { narrativeInputs } from './narrativeFeed.js';
import { buildSignalBoard, tradeDayBlock, scorecard, nextSession, isSession, publicTradeDay } from './signalBoard.js';
import { feedBoard } from './gexFeedBoard.js';
import { gexFeedPayload, nyToday } from './gexFeed.js';
import HOLIDAYS from '../data/holidays.json' with { type: 'json' };
import HISTORY from '../data/signal_board_history.json' with { type: 'json' };

export const BOARD_FEED_KEY = 'dvcap:signalboard:inputs:v1';
export const BOARD_FEED_TTL_S = 30 * 60;

// [key, Yahoo symbol, range, 'close' | 'bars'].
export const YAHOO_BOARD_SERIES = Object.freeze([
  ['hyg', 'HYG', '6mo', 'close'], ['lqd', 'LQD', '6mo', 'close'],
  ['qqqBars', 'QQQ', '1y', 'bars'], ['soxx', 'SOXX', '1y', 'close'], ['spyBars', 'SPY', '3mo', 'bars'],
  ['spx', '^GSPC', '3mo', 'close'], ['tnx', '^TNX', '3mo', 'close'], ['skew', '^SKEW', '2y', 'close'],
  ['vxn', '^VXN', '3mo', 'close'], ['brent', 'BZ=F', '3mo', 'bars'], ['kospi', '^KS11', '3mo', 'close'],
  // Crypto: two years of BTC for the 200-day, the 52-week high and the 200-day break's run; ETH for ETH ÷ BTC.
  ['btc', 'BTC-USD', '2y', 'close'], ['eth', 'ETH-USD', '3mo', 'close'],
]);

const NY = (t) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
};
export const nyDateOf = (now = new Date()) => NY(now.getTime()).date;

export async function fetchBoardInputs({ now = new Date(), yahooMap = yahooDailyMap, yahooBarsDaily = yahooDailyOHLC, squeeze = fetchSqueezeGex, state = stateInputs, xcCache = kvBlockCache, narrative = narrativeInputs } = {}) {
  const errors = [];
  const series = {};
  const [st, sq, pc, nar] = await Promise.all([
    state({ now }).catch((e) => { errors.push({ series: 'market-state inputs', error: String(e?.message || e).slice(0, 80) }); return { series: {} }; }),
    squeeze().catch(() => ({ ok: false, rows: [] })),
    Promise.resolve().then(() => xcCache.get('put_call')).catch(() => null),
    // Never fails the board: no answer and no cached copy → the row reads "not available".
    Promise.resolve().then(() => narrative({ now })).catch((e) => ({ series: [], errors: [{ series: 'GDELT', error: String(e?.message || e).slice(0, 80) }] })),
    ...YAHOO_BOARD_SERIES.map(async ([k, sym, range, kind]) => {
      try {
        series[k] = kind === 'bars' ? (await yahooBarsDaily(sym, range)).filter(b => Number.isFinite(b.close)) : mapToSeries(await yahooMap(sym, range));
      } catch { series[k] = []; }
      if (!series[k]?.length) errors.push({ series: sym, error: 'no data' });
    }),
  ]);
  for (const k of ['hyOas', 'move', 'vix', 'vix3m', 'vix9d', 'rsp', 'spy', 'iwm']) series[k] = st?.series?.[k] || [];
  series.qqq = (series.qqqBars || []).map(b => ({ date: b.date, value: b.close }));
  // The squeeze rows stay as [date, gex] pairs — the shape lib/squeeze.js's percentile reads. A year and
  // a half is enough for a trailing-252 percentile and the day before it.
  series.squeeze = (sq?.rows || []).slice(-400);
  if (!sq?.ok) errors.push({ series: 'SqueezeMetrics DIX.csv', error: sq?.why || 'no rows' });
  series.putCall = pc?.data || null;
  if (!series.putCall) errors.push({ series: 'Cboe put/call', error: 'not cached yet (the cross-check feed fills it)' });
  series.narrative = nar?.series || [];
  errors.push(...(nar?.errors || []));
  return { at: now.toISOString(), series, errors, stateSource: st?.source ?? null };
}

// Cached the way the market-state inputs are: half an hour fresh, last good copy served on a failed refresh.
export async function boardInputs({ now = new Date(), fetcher = fetchBoardInputs, kv = { configured: kvConfigured, get: kvGetJson, setEx: kvSetJsonEx } } = {}) {
  let cached = null;
  if (kv.configured()) {
    try { cached = await kv.get(BOARD_FEED_KEY); } catch { cached = null; }
    const age = cached?.at ? (now.getTime() - Date.parse(cached.at)) / 1000 : Infinity;
    if (cached?.series && age >= 0 && age < BOARD_FEED_TTL_S) return { ...cached, source: 'kv' };
  }
  const fresh = await fetcher({ now });
  const usable = Object.values(fresh.series).filter(s => Array.isArray(s) ? s.length : s).length;
  if (usable >= 12) {
    if (kv.configured()) { try { await kv.setEx(BOARD_FEED_KEY, fresh, 3 * 24 * 3600); } catch { /* served uncached */ } }
    return { ...fresh, source: 'live' };
  }
  if (cached?.series) return { ...cached, source: 'stale', refreshErrors: fresh.errors };
  return { ...fresh, source: 'live' };
}

// TODAY'S FIRST 30 / 60 MINUTES, from 30-minute bars (regular session). Pure: bars in ({t, o, h, l, c},
// t in epoch seconds), the New York date, out { open, '10:00': {firstRange, open}, '10:30': {...} }.
export function firstRanges(bars = [], date) {
  const day = (bars || []).map(b => ({ ...b, ny: NY(b.t * 1000) })).filter(b => b.ny.date === date && b.ny.hm >= '09:30' && b.ny.hm < '16:00');
  const b0930 = day.find(b => b.ny.hm === '09:30');
  if (!b0930) return {};
  const out = { open: b0930.o };
  const upto = (hm) => day.filter(b => b.ny.hm < hm);
  for (const [at, end, need] of [['10:00', '10:00', 1], ['10:30', '10:30', 2]]) {
    const w = upto(end);
    if (w.length < need || !day.some(b => b.ny.hm >= end)) continue;   // the window has closed only once a later bar exists
    out[at] = { open: b0930.o, firstRange: Math.max(...w.map(b => b.h)) - Math.min(...w.map(b => b.l)) };
  }
  return out;
}

// THE PRE-OPEN GAP. Before the session the open is not known, so the call reads an implied one: the
// front-month future's move since the prior 16:00 ET equity close (the 15:55 five-minute bar's close, the
// daily settle's time) mapped onto the prior ETF close — NQ=F for QQQ, ES=F for SPY. Same feature as
// the backtest: |open ÷ prior close − 1| ÷ implied, computed in tradeDayBlock from this open. Pure: bars
// ({t, c}, t epoch s, ascending), the prior close's New York date and price.
export const GAP_FUTURES = Object.freeze({ QQQ: 'NQ=F', SPY: 'ES=F' });
export function impliedOpenFromFutures(bars = [], { refDate, priorClose, sym = '' } = {}) {
  if (!refDate || !(priorClose > 0)) return { why: 'no prior close' };
  const b = (bars || []).filter(x => Number.isFinite(x?.c) && x.c > 0).map(x => ({ ...x, ny: NY(x.t * 1000) }));
  const ref = b.filter(x => x.ny.date === refDate && x.ny.hm < '16:00').pop();
  if (!ref) return { why: `no ${sym} print at the prior close` };
  const now = b[b.length - 1];
  if (now.t < ref.t) return { why: `no ${sym} print since the prior close` };
  return { open: priorClose * now.c / ref.c, ref: ref.c, last: now.c, at: now.ny.hm,
    source: `futures-implied (${sym} ${now.ny.hm} ET)` };
}
// A live pre-market ETF print, preferred over the futures when it is today's, before 09:30 and no more
// than 15 minutes old. `pp` is yahooPrePost's answer ({price, ts}).
export function preMarketOpen(pp, { today, nowMs, ticker = '' } = {}) {
  if (!(pp?.price > 0) || !pp.ts) return null;
  const ny = NY(pp.ts * 1000);
  if (ny.date !== today || ny.hm < '04:00' || ny.hm >= '09:30' || nowMs / 1000 - pp.ts > 15 * 60) return null;
  return { open: pp.price, source: `pre-market ${ticker} ${ny.hm} ET` };
}
const PRE_TTL_MS = 3 * 60 * 1000;
let preCache = null;   // { k, at, v } — one per warm instance, three minutes, only for the live fetchers
// The `pre` block for tradeDayBlock when the session has not opened: per ticker { open, source } or
// { note } when no implied open could be read (the call then takes gap 0 and says why).
export async function preOpenGaps(series = {}, { target, today, now = new Date(), intraday = yahooBars, prepost = yahooPrePost } = {}) {
  const cacheable = intraday === yahooBars && prepost === yahooPrePost;
  const k = `${target}|${today}`;
  if (cacheable && preCache?.k === k && now.getTime() - preCache.at < PRE_TTL_MS) return preCache.v;
  const out = {};
  await Promise.all([['QQQ', series.qqqBars], ['SPY', series.spyBars]].map(async ([t, bars]) => {
    const prior = (bars || []).filter(b => b.date < target && Number.isFinite(b.close)).at(-1);
    if (!prior) { out[t] = { note: 'gap 0 (no prior close to map an open onto)' }; return; }
    if (target === today) {
      const pm = preMarketOpen(await Promise.resolve().then(() => prepost(t)).catch(() => null), { today, nowMs: now.getTime(), ticker: t });
      if (pm) { out[t] = pm; return; }
    }
    const sym = GAP_FUTURES[t];
    const fb = await Promise.resolve().then(() => intraday(sym, { range: '5d', interval: '5m' })).catch(() => []);
    const f = impliedOpenFromFutures(fb, { refDate: prior.date, priorClose: prior.close, sym });
    out[t] = f.open ? { open: f.open, source: f.source } : { note: `gap 0 (${f.why || `${sym} quote not available`})` };
  }));
  if (cacheable) preCache = { k, at: now.getTime(), v: out };
  return out;
}

const US_CLOSED = HOLIDAYS?.US?.closed || [];

// THE GAMMA STRUCTURE FOR THE CONFLICT FLAG: the same board the gamma feed and the connector's get_gamma_*
// tools serve (lib/gexFeedBoard.js feedBoard → lib/gexFeed.js gexFeedPayload), in-process. `recompute`
// false (the public /api/indicators?board=1 route) serves a kept recompute or the stored board and never
// fetches a chain; the connector passes true, as its gamma tools do. A ticker with no board is null.
export async function gammaBoards({ recompute = false, board = feedBoard, now = Date.now() } = {}) {
  const out = {};
  await Promise.all(['QQQ', 'SPY'].map(async (t) => {
    try {
      const f = await board(t, now, { recompute });
      out[t] = f?.board ? gexFeedPayload(t, f.board, { mode: f.mode, asOf: f.asOf, sourceSnapshot: f.source, today: nyToday(new Date(now)), staleReason: f.staleReason }) : null;
    } catch { out[t] = null; }
  }));
  return out;
}

// The whole answer, as /api/indicators?board=1 and the MCP tool serve it.
export async function signalBoardPayload({ now = new Date(), inputs = boardInputs, intraday = yahooBars, prepost = yahooPrePost, history = HISTORY, gamma = gammaBoards, recompute = false, full = false } = {}) {
  const [inp, gb] = await Promise.all([inputs({ now }), Promise.resolve().then(() => gamma({ recompute, now: now.getTime() })).catch(() => ({}))]);
  const gammaErrors = ['QQQ', 'SPY'].filter(t => !gb?.[t]).map(t => ({ series: `${t} gamma board`, error: 'no board (the conflict flag is not read)' }));
  const today = nyDateOf(now);
  const board = buildSignalBoard(inp.series, { today, holidays: US_CLOSED, at: inp.at });
  // Intraday checkpoints only once today's session has bars; one small call per ticker.
  // WHICH SESSION IS BEING CALLED. Before 09:30 New York on a session day: today. During it: today,
  // with the open (the real gap) and the first 30 / 60 minutes once they exist. After 16:00, or on a
  // day with no session: the next session.
  const first = {}, pre = {};
  const hm = NY(now.getTime()).hm;
  const live = isSession(today, US_CLOSED) && hm >= '09:30' && hm < '16:00';
  const target = isSession(today, US_CLOSED) && hm < '16:00' ? today : nextSession(today, US_CLOSED);
  if (live) {
    await Promise.all([['QQQ', 'QQQ'], ['SPY', 'SPY']].map(async ([t, sym]) => {
      const fr = firstRanges(await intraday(sym, { range: '1d', interval: '30m' }).catch(() => []), today);
      if (fr.open) pre[t] = { open: fr.open, source: 'actual open' };
      first[t] = fr;
    }));
  }
  // Not in session (or in it before the first bar prints): the futures-implied (or pre-market) open,
  // or gap 0 with the reason.
  if (!pre.QQQ || !pre.SPY) {
    const g = await preOpenGaps(inp.series, { target, today, now, intraday, prepost }).catch(() => ({}));
    for (const t of ['QQQ', 'SPY']) if (!pre[t] && g[t]) pre[t] = g[t];
  }
  const tradeDay = tradeDayBlock(inp.series, { pre, first, target, gamma: gb || {} });
  tradeDay.phase = live ? 'in session' : target === today ? 'before the open' : 'after the close';
  return {
    ok: board.rows.some(r => r.state != null), at: inp.at, source: inp.source, today,
    // Scrubbed: no URL, query string or banned word ever leaves in an error (lib/crossCheck.js scrubError).
    errors: [...(inp.errors || []), ...gammaErrors].map(e => ({ series: scrubError(e.series), error: scrubError(e.error) })),
    // `full` (the token-gated connector only): each call's gamma object and the level-bearing conflict.
    // Public (the default): no gamma levels anywhere (publicTradeDay).
    board, trade_day: full ? tradeDay : publicTradeDay(tradeDay),
    scorecard: scorecard(history?.rows || []),
    note: 'Market data only. Every row carries its thresholds; states are fixed rules, never a model.',
  };
}
