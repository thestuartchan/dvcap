// lib/dayTradeRegime.js — Stu's QQQ/SPY day trades by gamma regime (13 Oct 2026). ANALYSIS ONLY.
//
// Should 0DTE/1DTE day trades sit out positive-gamma days, decided from the overnight board? This
// rebuilds every round trip from IBKR's own fills (Flex), labels each day by regime several ways,
// and asks whether skipping the positive / high-cushion days would have kept more than it lost.
//
// PRIVATE BY CONSTRUCTION. Fills, P&L and trades exist only in the server's memory while a signed-in
// console session asks for this, and in the private store the console reads (api/flex-sync.js
// ?regimepnl=1). Nothing here logs, posts or writes anywhere public; the repo holds code and a
// synthetic test fixture only. Pure: no I/O, no clock — the caller passes everything in.
//
// ── DEFINITIONS, AS IMPLEMENTED ─────────────────────────────────────────────────────────────────
//   Round trip  per contract (conid, else root+right+strike+expiry), fills in time order, cut
//               flat-to-flat in the signed position. Entry = the first fill, exit = the fill that
//               takes it flat. P&L = Σ sells − Σ buys at the traded price × multiplier, minus every
//               commission — IBKR's own numbers. A position still open at its expiry, when the data
//               runs past it, is closed at 0 at 16:00 that day (expired). A contract whose first fill
//               in the window is a closing fill began before the window and is left out.
//   In scope    QQQ / SPY options with expiry ≤ 1 trading day after the entry date (0DTE / 1DTE);
//               MES / MNQ / ES / NQ round trips opened and closed on the same day.
//   Day         the New York date of the entry. Ticker = the root (MNQ/NQ count as QQQ, MES/ES as
//               SPY for the gamma labels).
//   Labels      (per ticker per day)
//     open      dvcap: the latest capture taken BEFORE 09:30 New York that day, against the day's
//               opening print. The morning-gamma-regime skill's rule — usable = a flip exists and is
//               not fragile; POSITIVE = open > zone top × 1.01 and usable and no tier data before the
//               open; NEGATIVE = open < zone bottom and usable; UNDECIDED otherwise (in or near the
//               zone, unusable, or data before the open).
//     early     the same rule at 08:00 Dubai (04:00 UTC): the latest capture taken before then, and
//               the open implied by the futures (ES for SPY, NQ for QQQ) at 04:00 UTC against their
//               previous 16:00 New York close, applied to the ETF's previous close.
//     smTercile SqueezeMetrics SPX GEX at the previous close: low < 5.6bn ≤ mid ≤ 7.6bn < high (the
//               skill's terciles); smSign the sign.
//   Data day    CPI, PPI, payrolls, FOMC decision, retail sales (data/calendar.json, US), and monthly
//               opex (the third Friday). Unknown before the calendar's first date.
//   Range       realised (high − low) against the implied 1σ day: previous close × VIX (SPY) or VXN
//               (QQQ) / 100 / √252. First-hour tell: the 09:30–10:30 range over half that 1σ.
//   Fade/break  needs the underlying at the entry minute (5-minute bars, else the hour) and the
//               day's open-label capture. Direction: long call / short put up, long put / short call
//               down. With a pin box: from inside, toward its middle is a fade, toward an edge a break;
//               from above, down is a fade and up a break; from below, the reverse. Without one, the
//               same with the band from the near trapdoor to the call wall. No capture: unclassified.
//   Stats       per trade and per day: total, mean, median, win rate, average win / loss, profit
//               factor, the top 3 days' share of the total, and a 95% bootstrap interval by day.
//   Sit-out     skip a ticker's trades on its POSITIVE days (early label, then open label); skip
//               every trade on HIGH-tercile days. Kept, avoided, trades lost, and the skipped days'
//               mean with its interval — also with the best and worst day of the sample removed.
//   The bar     adopt only if the skipped days' mean is below zero with an interval excluding zero,
//               or the skipped bucket is negative under BOTH dvcap labels — AND that survives
//               removing the best and worst day. Otherwise: no evidence.

export const OPTION_ROOTS = ['QQQ', 'SPY'];
export const FUTURE_ROOTS = { MES: 'SPY', ES: 'SPY', MNQ: 'QQQ', NQ: 'QQQ' };
export const POS_CUSHION = 0.01;
export const SM_LOW = 5.6e9, SM_HIGH = 7.6e9;
export const BOOT = 2000;
const DATA_RE = /\b(CPI|consumer price|PPI|producer price|payrolls|employment situation|nonfarm|NFP|FOMC (rate )?decision|FOMC statement|rate decision|retail sales)\b/i;
const MINUTES_RE = /minutes/i;

const num = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export const isTradingDay = (d, holidays = []) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w !== 0 && w !== 6 && !holidays.includes(d); };
export function tradingDaysAfter(a, b, holidays = []) {
  if (b <= a) return 0;
  let n = 0;
  for (let d = addDays(a, 1), g = 0; d <= b && g < 400; d = addDays(d, 1), g++) if (isTradingDay(d, holidays)) n++;
  return n;
}
export const isOpex = (d) => { const t = new Date(`${d}T00:00:00Z`); return t.getUTCDay() === 5 && t.getUTCDate() >= 15 && t.getUTCDate() <= 21; };

// "20261012;101530" (New York) → { date, minutes since midnight, sortable key }
export function nyStamp(s) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})[;T ,]*(\d{2}):?(\d{2}):?(\d{2})?/.exec(String(s || '').trim());
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, min: +m[4] * 60 + +m[5], key: `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6] || '00'}` };
}

// ── ROUND TRIPS ─────────────────────────────────────────────────────────────────────────────────
// `trades`: lib/flexTrades.js parseTrades rows (rawPrice, commission, side, qty, multiplier, time…).
export function roundTrips(trades = [], { lastDate = null } = {}) {
  const key = (t) => t.conid || `${t.root}|${t.right || ''}|${t.strike || ''}|${t.expiry || ''}`;
  const by = new Map();
  for (const t of trades) {
    if (!(t.qty > 0) || num(t.rawPrice) == null) continue;
    by.set(key(t), [...(by.get(key(t)) || []), t]);
  }
  const out = [];
  for (const [, ts] of by) {
    ts.sort((a, b) => String(nyStamp(a.time)?.key || a.date).localeCompare(String(nyStamp(b.time)?.key || b.date)));
    let pos = 0, cur = null;
    for (const t of ts) {
      const signed = (t.side === 'buy' ? 1 : -1) * t.qty;
      if (pos === 0) {
        // A closing fill with nothing open closes a position opened before the window: left out.
        if (String(t.openClose || '').includes('C') && !String(t.openClose || '').includes('O')) continue;
        cur = { fills: [], first: t, max: 0 };
      }
      cur.fills.push(t);
      pos += signed;
      cur.max = Math.max(cur.max, Math.abs(pos));
      if (Math.abs(pos) < 1e-9) { out.push(finish(cur, t, false)); pos = 0; cur = null; }
    }
    if (cur && pos !== 0) {
      const e = cur.first.expiry;
      if (e && lastDate && e <= lastDate) {
        const exp = { ...cur.first, side: pos > 0 ? 'sell' : 'buy', qty: Math.abs(pos), rawPrice: 0, commission: 0, time: `${e.replace(/-/g, '')};160000`, date: e, expired: true };
        cur.fills.push(exp); out.push(finish(cur, exp, true));
      }
    }
  }
  return out.sort((a, b) => a.entryKey.localeCompare(b.entryKey));
}
function finish(cur, last, expired) {
  const f = cur.first, mult = f.multiplier || 1;
  let pnl = 0, comm = 0;
  for (const x of cur.fills) { pnl += (x.side === 'sell' ? 1 : -1) * x.qty * x.rawPrice * mult; comm += Math.abs(x.commission || 0); }
  const open = cur.fills.filter(x => x.side === f.side), close = cur.fills.filter(x => x.side !== f.side);
  const avg = (xs) => { const q = xs.reduce((a, x) => a + x.qty, 0); return q ? xs.reduce((a, x) => a + x.qty * x.rawPrice, 0) / q : null; };
  const e = nyStamp(f.time) || { date: f.date, min: null, key: String(f.date).replace(/-/g, '') }, x = nyStamp(last.time) || { date: last.date, min: null };
  return { root: f.root, assetCategory: f.assetCategory, right: f.right || null, strike: f.strike ?? null, expiry: f.expiry || null,
    side: f.side === 'buy' ? 'long' : 'short', qty: cur.max, multiplier: mult,
    entryDate: e.date, entryMin: e.min, entryKey: e.key, exitDate: x.date, exitMin: x.min,
    entryPrice: avg(open), exitPrice: avg(close), commission: +comm.toFixed(2), pnl: +(pnl - comm).toFixed(2), expired };
}

export function inScope(rt, { holidays = [] } = {}) {
  const cat = String(rt.assetCategory || '').toUpperCase();
  if ((cat === 'OPT' || cat === 'FOP') && OPTION_ROOTS.includes(rt.root)) return !!rt.expiry && tradingDaysAfter(rt.entryDate, rt.expiry, holidays) <= 1;
  if (cat === 'FUT' && FUTURE_ROOTS[rt.root]) return rt.exitDate === rt.entryDate;
  return false;
}
export const tickerOf = (rt) => FUTURE_ROOTS[rt.root] || rt.root;
// Up or down: a long call or a short put wants the underlying higher. Futures: long up.
export const directionOf = (rt) => rt.right ? ((rt.right === 'C') === (rt.side === 'long') ? 1 : -1) : (rt.side === 'long' ? 1 : -1);

// ── LABELS ──────────────────────────────────────────────────────────────────────────────────────
// captures: the gamma series rows ({date, asOf, flipLevel, flipZoneLo, flipZoneHi, flipFragile,
// pin_lo, pin_hi, callWall, trapdoor_near}) for one ticker. The latest taken before `beforeIso`.
export function captureBefore(captures = [], beforeIso) {
  let best = null;
  for (const c of captures) if (c?.asOf && c.asOf < beforeIso && (!best || c.asOf > best.asOf)) best = c;
  return best;
}
export function classify(price, cap, { dataBeforeOpen = false } = {}) {
  if (!cap || !(price > 0)) return 'unknown';
  const usable = cap.flipLevel != null && !cap.flipFragile;
  const lo = num(cap.flipZoneLo) ?? num(cap.flipLevel), hi = num(cap.flipZoneHi) ?? num(cap.flipLevel);
  if (lo == null || hi == null) return 'unknown';
  if (usable && price > hi * (1 + POS_CUSHION) && !dataBeforeOpen) return 'positive';
  if (usable && price < lo) return 'negative';
  return 'undecided';
}
export function smTercile(g) { return g == null ? 'unknown' : g < SM_LOW ? 'low' : g > SM_HIGH ? 'high' : 'mid'; }
export function dataFlags(date, calendar = []) {
  const ev = calendar.filter(e => e.date === date && (e.region || 'US') === 'US' && DATA_RE.test(e.title || '') && !MINUTES_RE.test(e.title || ''));
  const before = ev.some(e => !e.time || e.time < '09:30');
  return { data: ev.map(e => e.title), dataBeforeOpen: before, opex: isOpex(date) };
}

// The per-ticker per-day context, from the market data the caller fetched.
// m: { bars: {QQQ:{date:{o,h,l,c,prevClose,firstHour:{h,l}}}}, fut: {QQQ:{date:{at04:price, prevClose:price}}},
//      vol: {QQQ:{date:prevClose of VXN}}, gex: {date: prev-close GEX}, captures: {QQQ:[…]}, calendar, calendarFrom }
export function dayContext(ticker, date, m) {
  const b = m.bars?.[ticker]?.[date] || null;
  const caps = m.captures?.[ticker] || [];
  const flags = date >= (m.calendarFrom || '9999') ? dataFlags(date, m.calendar || []) : { data: null, dataBeforeOpen: false, opex: isOpex(date) };
  const openIso = nyIso(date, 9 * 60 + 30), earlyIso = `${date}T04:00:00Z`;
  const capOpen = captureBefore(caps, openIso), capEarly = captureBefore(caps, earlyIso);
  const f = m.fut?.[ticker]?.[date];
  const impliedOpen = f && b?.prevClose && f.at04 > 0 && f.prevClose > 0 ? b.prevClose * (f.at04 / f.prevClose) : null;
  const g = m.gex?.[date] ?? null;
  const ivPrev = m.vol?.[ticker]?.[date] ?? null;
  const sigma = b?.prevClose && ivPrev ? b.prevClose * ivPrev / 100 / Math.sqrt(252) : null;
  return {
    ticker, date, open: b?.o ?? null, impliedOpen: impliedOpen == null ? null : +impliedOpen.toFixed(2),
    openLabel: classify(b?.o, capOpen, flags), earlyLabel: classify(impliedOpen, capEarly, flags),
    capOpen, smGex: g, smTercile: smTercile(g), smSign: g == null ? 'unknown' : g >= 0 ? 'positive' : 'negative',
    ...flags,
    sigma, rangeRatio: b && sigma ? (b.h - b.l) / sigma : null,
    firstHourTell: b?.firstHour && sigma ? (b.firstHour.h - b.firstHour.l) > 0.5 * sigma : null,
  };
}
// New York wall clock → UTC ISO (DST from the platform's zone data).
export function nyIso(date, minutes) {
  const [y, mo, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).reduce((a, x) => ({ ...a, [x.type]: x.value }), {});
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess + (guess - shown)).toISOString();
}

// Fade or break, from the underlying at entry and the day's capture.
export function fadeOrBreak(dir, px, cap) {
  if (!cap || !(px > 0) || !dir) return 'unclassified';
  let lo = num(cap.pin_lo), hi = num(cap.pin_hi);
  if (lo == null || hi == null || hi < lo) { lo = num(cap.trapdoor_near); hi = num(cap.callWall); }
  if (lo == null || hi == null || hi < lo) return 'unclassified';
  if (px > hi) return dir < 0 ? 'fade' : 'break';
  if (px < lo) return dir > 0 ? 'fade' : 'break';
  const mid = (lo + hi) / 2;
  return Math.sign(mid - px) === dir || px === mid ? 'fade' : 'break';
}
export const distancesPct = (px, cap) => !cap || !(px > 0) ? null : {
  pinMid: cap.pin_lo != null && cap.pin_hi != null ? +((px / ((+cap.pin_lo + +cap.pin_hi) / 2) - 1) * 100).toFixed(2) : null,
  callWall: cap.callWall ? +((px / cap.callWall - 1) * 100).toFixed(2) : null,
  trapNear: cap.trapdoor_near ? +((px / cap.trapdoor_near - 1) * 100).toFixed(2) : null,
  flip: cap.flipLevel ? +((px / cap.flipLevel - 1) * 100).toFixed(2) : null,
};

// ── STATISTICS ──────────────────────────────────────────────────────────────────────────────────
function seeded(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
export function stats(trades = [], { seed = 7 } = {}) {
  const p = trades.map(t => t.pnl);
  if (!p.length) return { n: 0, days: 0 };
  const byDay = new Map();
  for (const t of trades) byDay.set(t.entryDate, (byDay.get(t.entryDate) || 0) + t.pnl);
  const days = [...byDay.values()], total = p.reduce((a, x) => a + x, 0);
  const wins = p.filter(x => x > 0), losses = p.filter(x => x <= 0);
  const sorted = [...p].sort((a, b) => a - b), med = sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const top3 = [...days].sort((a, b) => b - a).slice(0, 3).reduce((a, x) => a + x, 0);
  const ci = (vals) => {
    if (vals.length < 2) return [null, null];
    const r = seeded(seed), ms = [];
    for (let i = 0; i < BOOT; i++) { let s = 0; for (let k = 0; k < vals.length; k++) s += vals[Math.floor(r() * vals.length)]; ms.push(s / vals.length); }
    ms.sort((a, b) => a - b); return [+ms[Math.floor(0.025 * BOOT)].toFixed(2), +ms[Math.floor(0.975 * BOOT) - 1].toFixed(2)];
  };
  // Per-trade interval resampled by DAY (a day's trades move together); per-day interval on day totals.
  const dayLists = [...trades.reduce((m, t) => m.set(t.entryDate, [...(m.get(t.entryDate) || []), t.pnl]), new Map()).values()];
  const r = seeded(seed + 1), tm = [];
  for (let i = 0; i < BOOT && dayLists.length > 1; i++) { let s = 0, n = 0; for (let k = 0; k < dayLists.length; k++) { const d = dayLists[Math.floor(r() * dayLists.length)]; for (const x of d) { s += x; n++; } } tm.push(s / n); }
  tm.sort((a, b) => a - b);
  return {
    n: p.length, days: days.length, total: +total.toFixed(2), mean: +(total / p.length).toFixed(2), median: +med.toFixed(2),
    win: +(wins.length / p.length).toFixed(3), avgWin: wins.length ? +(wins.reduce((a, x) => a + x, 0) / wins.length).toFixed(2) : null,
    avgLoss: losses.length ? +(losses.reduce((a, x) => a + x, 0) / losses.length).toFixed(2) : null,
    pf: losses.length && losses.reduce((a, x) => a + x, 0) < 0 ? +(wins.reduce((a, x) => a + x, 0) / -losses.reduce((a, x) => a + x, 0)).toFixed(2) : null,
    perDay: +(total / days.length).toFixed(2), winDays: +(days.filter(x => x > 0).length / days.length).toFixed(3),
    top3Share: total !== 0 ? +(top3 / total).toFixed(2) : null,
    ciTrade: tm.length ? [+tm[Math.floor(0.025 * tm.length)].toFixed(2), +tm[Math.floor(0.975 * tm.length) - 1].toFixed(2)] : [null, null],
    ciDay: ci(days),
  };
}
export function groupStats(trades, keyFn, opts) {
  const g = new Map();
  for (const t of trades) { const k = keyFn(t); g.set(k, [...(g.get(k) || []), t]); }
  return Object.fromEntries([...g].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([k, ts]) => [k, stats(ts, opts)]));
}

// ── THE WHOLE ANALYSIS ──────────────────────────────────────────────────────────────────────────
// trades: parseTrades rows; m: market context (see dayContext); under: {QQQ:{date:{min:price}}} the
// underlying at the minute (5m or 60m bars, keyed by minute of day, any minute inside the bar).
export function analyse(trades, m, { holidays = [], lastDate = null, under = {} } = {}) {
  const all = roundTrips(trades, { lastDate });
  const rts = all.filter(rt => inScope(rt, { holidays }));
  const ctxCache = new Map();
  const ctx = (tk, d) => { const k = `${tk}|${d}`; if (!ctxCache.has(k)) ctxCache.set(k, dayContext(tk, d, m)); return ctxCache.get(k); };
  const rows = rts.map(rt => {
    const tk = tickerOf(rt), c = ctx(tk, rt.entryDate), dir = directionOf(rt);
    const px = underlyingAt(under[tk]?.[rt.entryDate], rt.entryMin);
    return { ...rt, ticker: tk, dir, early: c.earlyLabel, open: c.openLabel, smTercile: c.smTercile, smSign: c.smSign,
      dataDay: c.data == null ? 'unknown' : (c.data.length || c.opex) ? 'data/opex' : 'none', rangeRatio: c.rangeRatio, firstHourTell: c.firstHourTell,
      underPx: px, setup: fadeOrBreak(dir, px, c.capOpen), dist: distancesPct(px, c.capOpen),
      bucket: bucketOf(rt.entryMin) };
  });
  // Range terciles over the days traded (per ticker-day), for "quiet vs big".
  const rr = rows.map(r => r.rangeRatio).filter(Number.isFinite).sort((a, b) => a - b);
  const q1 = rr[Math.floor(rr.length / 3)], q2 = rr[Math.floor(2 * rr.length / 3)];
  for (const r of rows) r.rangeBucket = !Number.isFinite(r.rangeRatio) ? 'unknown' : r.rangeRatio < q1 ? 'quiet' : r.rangeRatio < q2 ? 'normal' : 'big';

  const dates = rows.map(r => r.entryDate).sort();
  const out = {
    window: { first: dates[0] || null, last: dates[dates.length - 1] || null, roundTripsAll: all.length, inScope: rows.length },
    overall: stats(rows),
    byOpen: groupStats(rows, r => r.open), byEarly: groupStats(rows, r => r.early),
    bySmTercile: groupStats(rows, r => r.smTercile), bySmSign: groupStats(rows, r => r.smSign),
    byDataDay: groupStats(rows, r => r.dataDay),
    callsPuts: { open: groupStats(rows, r => `${r.open} · ${r.right ? (r.right === 'C' ? 'calls' : 'puts') : 'futures'} ${r.side}`),
                 smTercile: groupStats(rows, r => `${r.smTercile} · ${r.right ? (r.right === 'C' ? 'calls' : 'puts') : 'futures'} ${r.side}`) },
    setup: { all: groupStats(rows, r => r.setup), byOpen: groupStats(rows, r => `${r.open} · ${r.setup}`), byEarly: groupStats(rows, r => `${r.early} · ${r.setup}`) },
    timeOfDay: { all: groupStats(rows, r => r.bucket), byOpen: groupStats(rows, r => `${r.open} · ${r.bucket}`) },
    range: { all: groupStats(rows, r => r.rangeBucket), withinRangeByOpen: groupStats(rows, r => `${r.rangeBucket} · ${r.open}`),
             withinRangeBySm: groupStats(rows, r => `${r.rangeBucket} · ${r.smTercile}`), firstHourTell: groupStats(rows, r => String(r.firstHourTell)) },
    sitOut: {
      earlyPositive: sitOut(rows, r => r.early === 'positive'),
      openPositive: sitOut(rows, r => r.open === 'positive'),
      smHigh: sitOut(rows, r => r.smTercile === 'high'),
    },
  };
  out.verdict = verdict(out, rows);
  return { result: out, trades: rows };
}
export const bucketOf = (min) => { if (min == null) return 'unknown'; const b = Math.floor(min / 30) * 30; return `${String(Math.floor(b / 60)).padStart(2, '0')}:${String(b % 60).padStart(2, '0')}`; };
function underlyingAt(series, min) {
  if (!series || min == null) return null;
  let best = null, bk = -1;
  for (const [k, v] of Object.entries(series)) { const kk = +k; if (kk <= min && kk > bk) { bk = kk; best = v; } }
  return best;
}
export function sitOut(rows, skip) {
  const skipped = rows.filter(skip), kept = rows.filter(r => !skip(r));
  const byDay = (rs) => { const m = new Map(); for (const r of rs) m.set(r.entryDate, (m.get(r.entryDate) || 0) + r.pnl); return m; };
  const sd = byDay(skipped), all = byDay(rows);
  const sorted = [...all.entries()].sort((a, b) => a[1] - b[1]);
  const extremes = new Set([sorted[0]?.[0], sorted[sorted.length - 1]?.[0]].filter(Boolean));
  const trimmed = skipped.filter(r => !extremes.has(r.entryDate));
  return { kept: stats(kept), skipped: stats(skipped), avoided: +(-[...sd.values()].reduce((a, x) => a + x, 0)).toFixed(2),
    tradesLost: skipped.length, daysSkipped: sd.size, skippedTrimmed: stats(trimmed), removed: [...extremes] };
}
function verdict(out, rows) {
  const neg = (s) => s && s.n > 0 && s.perDay < 0;
  const ciNeg = (s) => s && s.ciDay && s.ciDay[1] != null && s.ciDay[1] < 0;
  const judge = (so, both) => {
    const main = (ciNeg(so.skipped)) || both;
    const survives = so.skippedTrimmed.n > 0 && (ciNeg(so.skippedTrimmed) || (both && neg(so.skippedTrimmed)));
    return { adopt: !!(main && survives), skippedMeanPerDay: so.skipped.perDay ?? null, ciDay: so.skipped.ciDay ?? null,
      negativeUnderBothLabels: !!both, survivesTrim: !!survives };
  };
  const bothPos = neg(out.sitOut.earlyPositive.skipped) && neg(out.sitOut.openPositive.skipped);
  const pos = judge(out.sitOut.earlyPositive, bothPos), posOpen = judge(out.sitOut.openPositive, bothPos), high = judge(out.sitOut.smHigh, false);
  return { sitOutPositiveEarly: pos, sitOutPositiveOpen: posOpen, sitOutHighTercile: high,
    summary: pos.adopt || posOpen.adopt || high.adopt ? 'evidence for a sit-out rule' : 'no evidence', rows: rows.length };
}
