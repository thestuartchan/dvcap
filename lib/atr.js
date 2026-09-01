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
  return {
    atr: +atr.toFixed(6),
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

// The flag P1 renders. `tight` is only ever true when the distance is KNOWN and below the
// threshold — unknown is its own state, never a silent pass.
export function stopWidth({ price, stop, atr, threshold = ATR_TIGHT_STOP } = {}) {
  const atrs = stopInAtr({ price, stop, atr });
  if (atrs == null) return { atrs: null, known: false, tight: false,
    note: stop == null ? 'no stop set' : 'no ATR for this symbol' };
  return {
    atrs, known: true, tight: atrs < threshold,
    note: atrs < threshold
      ? `stop is ${atrs} ATR from entry — inside the instrument's ordinary daily range`
      : `stop is ${atrs} ATR from entry`,
  };
}
