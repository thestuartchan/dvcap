// lib/atr.js — average true range, and the percentile that makes it mean something.
//
// WHY THE PERCENTILE IS THE NUMBER, NOT THE ATR. Over four days one instrument's ATR moved 3%
// while its percentile moved from the 12th to the 50th. A point value cannot tell you which of
// those two things happened, and only one of them changes how big a position should be: a stop
// placed at "1.5 ATR" is a different stop when the ATR is at the 12th percentile of its own year
// than when it is at the 50th. So the summary stores both, and a caller that wants one number is
// meant to reach for the percentile.
//
// ON FUTURES. Compute this from the SPECIFIC CONTRACT's bars, never a continuous or stitched
// series. A roll gap is a price discontinuity between two different instruments, and true range
// reads it as a real day's movement — one roll can inflate a 14-day ATR for a fortnight, which
// is exactly the fortnight after a roll when position sizing is being re-decided.

import { percentileOf } from './benchmarks.js';

export const ATR_PERIOD = 14;
// A stop closer than this to the entry is inside the instrument's ordinary daily noise, so it is
// not an invalidation level — it is a coin flip that will usually be lost.
export const ATR_TIGHT_STOP = 1.0;

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// One bar: {date?, high, low, close}. True range is the largest of today's range, the gap up from
// the prior close, and the gap down from it — which is why it needs the PREVIOUS close and why the
// first bar has no true range at all rather than a fabricated one from its own range.
export function trueRange(bars = []) {
  const out = [];
  const rows = (Array.isArray(bars) ? bars : [])
    .map(b => ({ date: b?.date ?? null, high: num(b?.high), low: num(b?.low), close: num(b?.close) }))
    .filter(b => b.high != null && b.low != null && b.close != null && b.high >= b.low);
  for (let i = 1; i < rows.length; i++) {
    const b = rows[i], prev = rows[i - 1].close;
    out.push({
      date: b.date,
      tr: Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev)),
      close: b.close,
    });
  }
  return out;
}

// Wilder's smoothing, which is what "ATR" means everywhere it is quoted — a simple mean of the
// last N true ranges is a different indicator that happens to share the name. Seeded with the
// simple mean of the first N, then smoothed. Returns [{date, atr, close}], oldest first, or []
// when there are not enough bars to seed honestly.
export function atrSeries(bars = [], period = ATR_PERIOD) {
  const p = Math.max(1, Math.trunc(num(period) ?? ATR_PERIOD));
  const tr = trueRange(bars);
  if (tr.length < p) return [];
  const out = [];
  let atr = tr.slice(0, p).reduce((a, r) => a + r.tr, 0) / p;
  out.push({ date: tr[p - 1].date, atr, close: tr[p - 1].close });
  for (let i = p; i < tr.length; i++) {
    atr = ((atr * (p - 1)) + tr[i].tr) / p;
    out.push({ date: tr[i].date, atr, close: tr[i].close });
  }
  return out;
}

// The summary a caller actually reads. `atrPct` is ATR as a share of price, which is the only
// form comparable ACROSS instruments — 8 points of ATR means nothing until you know whether the
// thing trades at 40 or at 4,000.
//
// Percentiles are over the last 60 and 250 ATR observations. 250 is a trading year, the window
// that says whether this is a quiet or violent regime for this name; 60 is a quarter, which moves
// fast enough to catch a vol expansion the annual window is still averaging away. Both are
// reported because they disagree exactly when it matters. percentileOf enforces its own minimum
// sample and returns null rather than a confident number off a thin series.
// ── THE WINDOW IS BARS, AND BARS ARE NOT THE SAME LENGTH OF TIME ─────────────────────────────
// A 14-period ATR on an equity spans 14 SESSIONS — about three calendar weeks. On spot crypto,
// which trades every day, the same 14 periods span 14 CALENDAR DAYS, a little over two weeks. Both
// are correctly "ATR(14)"; they are not the same question about volatility, and nothing in the
// output said which had been answered.
//
// Calendar days is the wanted behaviour for crypto — a market that trades through the weekend has
// no session count to fall back on, and pretending it does would mean skipping real price action.
// So the maths is unchanged and the WINDOW IS NOW REPORTED, from the bar dates themselves rather
// than assumed: `spanDays` is what the period actually covered, and `continuous` says whether the
// series has weekends in it. A future reader comparing an equity's ATR to a coin's can see that
// they are measured over different lengths of time instead of inferring it.
export function atrSummary(bars = [], period = ATR_PERIOD) {
  const series = atrSeries(bars, period);
  const empty = { atr: null, atrPct: null, percentile60: null, percentile250: null, median250: null, n: series.length, date: null };
  if (!series.length) return empty;
  const last = series[series.length - 1];
  const atr = last.atr;
  const vals = series.map(s => s.atr);
  const w60 = vals.slice(-60), w250 = vals.slice(-250);
  const sorted = [...w250].sort((a, b) => a - b);
  const median250 = sorted.length
    ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
                         : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
    : null;
  // Calendar days actually spanned by the last `period` bars, read off their dates.
  const tail = series.slice(-period);
  const d0 = tail[0]?.date, d1 = tail[tail.length - 1]?.date;
  const spanDays = (d0 && d1)
    ? Math.round((Date.parse(d1 + 'T00:00:00Z') - Date.parse(d0 + 'T00:00:00Z')) / 864e5) + 1
    : null;
  // A 5-day week puts ~7 calendar days behind every 5 bars; a 7-day one is 1:1. Measured, not
  // assumed from the symbol — a thin or gappy series is not silently called continuous.
  const continuous = spanDays != null && tail.length > 1 && (spanDays / tail.length) < 1.2;

  return {
    atr: +atr.toFixed(6),
    // The window, so a reader never has to guess whether "14" meant sessions or days.
    period, spanDays, continuous,
    windowLabel: spanDays == null ? `${period} bars`
      : continuous ? `${period} days` : `${period} sessions (${spanDays} days)`,
    atrPct: last.close ? +((atr / last.close) * 100).toFixed(3) : null,
    // minN is the window itself: a "60-day percentile" off 20 observations is a different and
    // much weaker claim, and reporting it as the same number is how a thin series gets trusted.
    percentile60: percentileOf(atr, w60, Math.min(60, 30)),
    percentile250: percentileOf(atr, w250, 100),
    median250: median250 == null ? null : +median250.toFixed(6),
    n: series.length,
    date: last.date,
  };
}

// How far the stop sits from entry, measured in ATRs — the form the size question is actually
// asked in. Returns null when either leg is missing; a missing ATR must not read as a tight stop.
export function stopInAtr({ price, stop, atr } = {}) {
  const p = num(price), s = num(stop), a = num(atr);
  if (p == null || s == null || a == null || a <= 0) return null;
  return +(Math.abs(p - s) / a).toFixed(2);
}

// ── WHY THERE IS NO ATR, WHEN THERE IS NO ATR ───────────────────────────────
// Five different things used to produce the single string "no ATR for this symbol": the row was
// never included in the request, the request failed, the provider answered but knows nothing about
// the ticker, it answered with too few bars to seed a 14-period average, or the request is still in
// flight. One message for five causes is indistinguishable from a broken feature, and it is why
// this looked like a glitch rather than like four different things to do about it.
//
// Each has a different remedy — wait, retry, check the ticker, accept that a recent listing has no
// year of history yet — so each gets its own status and its own sentence.
export const ATR_STATUS = Object.freeze({
  OK: 'ok',
  LOADING: 'loading',              // request in flight
  NOT_REQUESTED: 'not-requested',  // this symbol was never asked about
  FETCH_FAILED: 'fetch-failed',    // transport or HTTP error — retryable
  NO_DATA: 'no-data',              // provider answered, knows nothing about the ticker
  SHORT_HISTORY: 'short-history',  // real bars, but fewer than the period needs
  NO_STOP: 'no-stop',              // nothing wrong with the ATR; there is simply no stop to measure
});

const STATUS_NOTE = {
  [ATR_STATUS.LOADING]: () => 'ATR still loading',
  [ATR_STATUS.NOT_REQUESTED]: () => 'ATR not requested for this row yet',
  [ATR_STATUS.FETCH_FAILED]: (d) => `ATR fetch failed${d?.httpStatus ? ` (HTTP ${d.httpStatus})` : ''} — retryable`,
  [ATR_STATUS.NO_DATA]: (d) => `no price history for ${d?.symbol || 'this symbol'} — check the ticker`,
  [ATR_STATUS.SHORT_HISTORY]: (d) => `only ${d?.bars ?? '?'} bars of history — needs ${d?.needed ?? ATR_PERIOD + 1} for a ${d?.period ?? ATR_PERIOD}-period ATR`,
  [ATR_STATUS.NO_STOP]: () => 'no stop set',
};

// The flag P1 renders. `tight` is only ever true when the distance is KNOWN and below the
// threshold — unknown is its own state, never a silent pass.
export function stopWidth({ price, stop, atr, threshold = ATR_TIGHT_STOP, status = null, detail = null } = {}) {
  const atrs = stopInAtr({ price, stop, atr });
  if (atrs == null) {
    // A missing stop is reported ahead of any ATR problem: it is the thing to fix first, and it is
    // the user's to fix rather than the feed's.
    const st = stop == null ? ATR_STATUS.NO_STOP
      : (status && STATUS_NOTE[status]) ? status
      : (atr == null ? ATR_STATUS.NOT_REQUESTED : ATR_STATUS.NO_DATA);
    return { atrs: null, known: false, tight: false, status: st, note: STATUS_NOTE[st](detail) };
  }
  return {
    atrs, known: true, tight: atrs < threshold, status: ATR_STATUS.OK,
    note: atrs < threshold
      ? `stop is ${atrs} ATR from entry — inside the instrument's ordinary daily range`
      : `stop is ${atrs} ATR from entry`,
  };
}

// ── A NOISE FLOOR FOR A CLOSE-ONLY SERIES ────────────────────────────────────
// The scenario board needs "how big is a normal day for this thing" for series that have no bars:
// a FRED rate, a spread between two rates, a fund's unit count. There is no high and no low, so
// true range degenerates to the absolute close-to-close change — which is exactly what a noise
// floor for a daily series should be, and Wilder-smoothing it gives the same shape ATR has
// everywhere else on the board rather than a second, differently-behaved statistic.
//
// Returned in the SERIES' OWN UNITS: percent for a yield, basis points for a spread quoted in
// them, units for a unit count. The caller compares like with like or it compares nothing.
export function closeOnlyAtr(values = [], period = ATR_PERIOD) {
  const closes = (Array.isArray(values) ? values : [])
    .map(v => (v && typeof v === 'object') ? num(v.value ?? v.close) : num(v))
    .filter(v => v != null);
  if (closes.length < 2) return null;
  // Each close is its own high and low, so trueRange yields |close - prevClose| and the existing
  // Wilder smoothing applies unchanged — no second implementation of the same recurrence.
  const bars = closes.map((c, i) => ({ date: String(i), high: c, low: c, close: c }));
  const s = atrSeries(bars, Math.min(period, Math.max(1, closes.length - 1)));
  return s.length ? +s[s.length - 1].atr.toFixed(4) : null;
}

// The same for a SPREAD between two series. Built from the differences rather than from either
// leg, because the spread's own daily range is what a spread condition has to clear — 5bp is
// nothing on a 30Y yield and a great deal on a 10s30s box.
export function spreadAtr(a = [], b = [], period = ATR_PERIOD, scale = 1) {
  const A = (Array.isArray(a) ? a : []).map(v => (v && typeof v === 'object') ? num(v.value) : num(v));
  const B = (Array.isArray(b) ? b : []).map(v => (v && typeof v === 'object') ? num(v.value) : num(v));
  const n = Math.min(A.length, B.length);
  if (n < 2) return null;
  const diffs = [];
  for (let i = 0; i < n; i++) if (A[i] != null && B[i] != null) diffs.push((A[i] - B[i]) * scale);
  return closeOnlyAtr(diffs, period);
}
