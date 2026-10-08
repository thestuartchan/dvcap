// lib/trendTells.js — the tells of a clean trend day, read every session, against how each has
// done over fifteen years.
//
// THE TEST (8 Oct 2026). On our own 25 captured sessions the six clean trend days (≥0.6 ATR open→
// close, keeping ≥60% of the range) had low VIX, a steep VIX curve, quiet opens and a decisive first
// hour. Run on QQQ from May 2011 to Oct 2026 (3,881 sessions; trend-day base rate 24.1%), only the
// first hour held up. The rest REVERSED: steep contango, VIX under 14, small gaps and high dealer
// gamma all came with FEWER trend days. Our September–October sample was one rally, and it is the
// exception. So the dashboard shows each tell with the fifteen-year rate for the bucket it is in,
// not the in-sample story. Pre-open tells use the prior close; the gap is known at the open; the
// first hour at 10:30 New York.
//
// Dealer gamma for the long test is SqueezeMetrics' SPX estimate (lib/squeeze.js) — the one free
// record that goes back. Our own flip has no history before 1 Sep 2026, so the open's distance from
// the flip is shown with our own captures' record only, and said so.
//
// Market data only. Nothing here reads a position.

// SHOWN: the tells whose fifteen-year rates move the odds enough to matter. VIX level and the prior
// close's place in its range sit within about four points of the base in every bucket, and the
// open against our flip has no long record — on screen they read as signals they are not (8 Oct).
// They are still computed, and still in the per-session record where the flip one is building.
export const SHOWN = Object.freeze(['firstHour', 'curve', 'gex', 'gap']);
export const shownTells = (tells = []) => SHOWN.map(k => tells.find(t => t.key === k)).filter(Boolean);
// The first-hour thresholds in points for a given ATR: ≥0.5 ATR is the trend band, <0.2 the range band.
export const firstHourBands = (atr) => (atr > 0 ? { trend: +(0.5 * atr).toFixed(2), range: +(0.2 * atr).toFixed(2) } : null);

export const BASE_RATE = 24.1;   // QQQ, May 2011 – Oct 2026
export const FIRST_HOUR_BASE = 20.8;   // the last two years, where hourly bars exist
export const BACKTEST = Object.freeze({
  source: 'QQQ, 3,881 sessions May 2011 – Oct 2026 · first hour: 332 sessions, the last two years',
  // [lo, hi) → [trend-day rate %, sessions]
  gex: [[0, 0.2, 29.9, 688], [0.2, 0.4, 28.7, 617], [0.4, 0.6, 24.8, 670], [0.6, 0.8, 21.0, 670], [0.8, 1.01, 18.4, 984]],
  vix: [[0, 14, 19.7, 1100], [14, 16, 23.5, 706], [16, 20, 26.8, 1034], [20, 25, 26.1, 551], [25, 999, 26.7, 490]],
  curve: [[0, 0.8, 15.9, 277], [0.8, 0.85, 21.2, 901], [0.85, 0.9, 23.1, 1114], [0.9, 1.0, 27.0, 1292], [1.0, 99, 31.6, 297]],
  gap: [[0, 0.2, 19.9, 1597], [0.2, 0.5, 26.9, 1432], [0.5, 999, 27.2, 852]],
  prevLoc: [[0, 0.2, 26.9, 689], [0.2, 0.8, 24.1, 1960], [0.8, 1.01, 22.6, 1232]],
  firstHour: [[0, 0.2, 7.9, 164], [0.2, 0.3, 24.1, 54], [0.3, 0.5, 27.8, 72], [0.5, 0.75, 59.4, 32], [0.75, 999, 40.0, 10]],
});

const find = (table, v) => (v == null ? null : table.find(([lo, hi]) => v >= lo && v < hi) || null);
const fmt = (v, dp = 2) => (v == null ? '—' : (+v).toFixed(dp));
const band = ([lo, hi], unit = '') => (hi >= 99 ? `≥${lo}${unit}` : lo === 0 ? `<${hi}${unit}` : `${lo}–${hi}${unit}`);
// A tell's verdict against its base: the lift, and a word for it.
function verdict(rate, base) {
  const lift = rate / base;
  return { lift: +lift.toFixed(2), word: lift >= 1.5 ? 'strong' : lift >= 1.1 ? 'more often' : lift <= 0.67 ? 'rarely' : lift <= 0.9 ? 'less often' : 'about average' };
}

// THE TELLS FOR ONE SESSION. Every input optional; a missing one is reported as not yet known.
//   vixPrev, vix3mPrev   the prior close of each
//   gexPct               SqueezeMetrics' GEX percentile against the trailing year, prior close
//   gapAtr               |open − prior close| / ATR (known at the open)
//   prevLoc              where the prior close sat in its range, 0 = low, 1 = high
//   firstHourAtr         (10:30 close − open) / ATR, signed (known at 10:30)
//   openVsFlipAtr        (open − the prior capture's flip) / ATR — our record only
export function tellsFor(x = {}) {
  const out = [];
  const add = (key, label, value, table, unit, base, note) => {
    const b = find(table, key === 'firstHour' ? Math.abs(value ?? NaN) : value);
    if (value == null || !b) { out.push({ key, label, value: null, text: note.pending, rate: null }); return; }
    const v = verdict(b[2], base);
    out.push({ key, label, value, bucket: band(b, unit), rate: b[2], n: b[3], ...v, text: note.read(value, b) });
  };
  add('gex', 'Dealer gamma (SPX, SqueezeMetrics)', x.gexPct, BACKTEST.gex, '', BASE_RATE,
    { pending: 'no reading', read: (v) => `${Math.round(v * 100)}th percentile of the trailing year — ${v < 0.4 ? 'low gamma: more room to run' : v >= 0.8 ? 'high gamma: dealers damp moves' : 'middling'}` });
  const curve = x.vixPrev > 0 && x.vix3mPrev > 0 ? x.vixPrev / x.vix3mPrev : null;
  add('vix', 'VIX', x.vixPrev, BACKTEST.vix, '', BASE_RATE, { pending: 'no reading', read: (v) => `${fmt(v)} at the prior close` });
  add('curve', 'VIX curve (VIX ÷ VIX3M)', curve, BACKTEST.curve, '', BASE_RATE,
    { pending: 'no reading', read: (v) => `${fmt(v, 3)} — ${v >= 1 ? 'inverted (stress)' : `contango: VIX3M ${Math.round((1 / v - 1) * 100)}% above VIX${v < 0.85 ? ', steep' : ''}`}` });
  add('prevLoc', 'Prior close in its range', x.prevLoc, BACKTEST.prevLoc, '', BASE_RATE,
    { pending: 'no reading', read: (v) => `${Math.round(v * 100)}% of the way up` });
  add('gap', 'Gap at the open', x.gapAtr, BACKTEST.gap, ' ATR', BASE_RATE, { pending: 'known at the open', read: (v) => `${fmt(v)} ATR` });
  add('firstHour', 'First hour, net from the open (09:30–10:30)', x.firstHourAtr, BACKTEST.firstHour, ' ATR', FIRST_HOUR_BASE,
    { pending: 'known at 10:30 New York', read: (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v))} ATR${Math.abs(v) >= 0.3 ? ` — trend days have gone the first hour's way 96–100% of the time` : ''}` });
  out.push({ key: 'flip', label: 'Open vs the prior flip', value: x.openVsFlipAtr ?? null, rate: null,
    text: x.openVsFlipAtr == null ? 'known at the open' : `${x.openVsFlipAtr > 0 ? '+' : x.openVsFlipAtr < 0 ? '−' : ''}${fmt(Math.abs(x.openVsFlipAtr))} ATR ${x.openVsFlipAtr >= 0 ? 'above' : 'below'} — no long record: our own flip starts 1 Sep 2026` });
  return out;
}

// THE LINE ABOVE THE TELLS. Before 10:30: the lean from the pre-open tells shown, then the first
// hour's thresholds in points for today's ATR. After: the first hour, which outweighs the rest.
// Never a probability for the day — the tells overlap, and multiplying lifts counts twice.
export function tellsHeadline(tells = [], { atr = null, symbol = '' } = {}) {
  const known = shownTells(tells).filter(t => t.rate != null);
  const fh = known.find(t => t.key === 'firstHour');
  if (fh) return fh.lift >= 1.5 ? `The first hour moved ${fh.bucket}: ${fh.rate}% of such days became trend days (${fh.lift}× the ${FIRST_HOUR_BASE}% base), and trend days have gone the first hour's way 96–100% of the time.`
    : fh.lift <= 0.67 ? `A quiet first hour (${fh.bucket}): only ${fh.rate}% of such days became trend days. Expect a range day.`
    : `The first hour moved ${fh.bucket}: ${fh.rate}% of such days became trend days — near the ${FIRST_HOUR_BASE}% base. No edge from it today.`;
  const pre = known.filter(t => t.key !== 'firstHour');
  const up = pre.filter(t => t.lift >= 1.1).length, down = pre.filter(t => t.lift <= 0.9).length;
  const lean = !pre.length ? 'No pre-open reading yet.' : up > down ? 'Before the open the lean is toward more trend days than usual.' : down > up ? 'Before the open the lean is toward fewer trend days than usual — range more likely.' : 'No lean before the open.';
  const b = firstHourBands(atr);
  return b ? `${lean} The first hour decides: ${symbol ? `${symbol} ` : ''}±${b.trend} or more from the open by 10:30 → 59% trend days; inside ±${b.range} → 8%.` : lean;
}
