// lib/cta.js — where trend-following funds (CTAs) probably sit, and the prices that would flip them.
//
// NOBODY OUTSIDE THE FUNDS SEES CTA ORDERS. What the desk notes quote — "CTAs max long equities,
// short-term trigger at 5,650" — is a model of what mechanical trend funds would hold, rebuilt
// from public prices. This is that model, kept small enough to read in one sitting.
//
// THE REPLICA. A trend fund is long a market that has risen over its lookback and short one that
// has fallen, and it sizes each position to a common volatility. So, per market:
//
//   1. Three windows — one, three and twelve months of trading days (21, 63, 252). The spread of
//      horizons is the industry's; any single fund runs its own blend, which is why a replica is an
//      average and least reliable exactly at a flip.
//   2. Each window scores the move over it IN UNITS OF THE MARKET'S OWN VOLATILITY:
//        z = ln(price / close L sessions ago) / (σ_daily × √L)
//      capped at ±1 — a one-sigma trend over the window is full conviction. σ is the standard
//      deviation of daily log returns over the last 63 sessions.
//   3. The position is the average of the three scores: −100% (max short) to +100% (max long) of
//      what the model would ever hold. Vol-targeting converts that into contracts — lower vol,
//      more contracts for the same score — but no dollar figure is attempted here: that needs an
//      industry size and a leverage, and those are assumptions, not data.
//
// FLIP LEVELS. A window's score changes sign where price crosses the close it is measured from, so
// each window's flip for the NEXT close is a known number: the close L sessions before it. The
// blended flip is the price at which the average crosses zero, solved exactly (it is monotonic in
// price). Both are stated for the close that is still to come, so they are levels a chart can
// carry today.
//
// LEVELS ARE IN FRONT-MONTH TERMS. The series are Yahoo's continuous front contracts, which splice
// one contract onto the next at each roll without adjustment. A reference close from before a roll
// is the old contract's price, off by the calendar spread: small for equity index, Treasury and
// dollar futures, moderate for gold, and large for crude, whose twelve-month window spans twelve
// rolls. Each market carries that caveat as `roll`.
//
// PURE: bars in, numbers out. The route (api/atr.js ?cta=1) fetches; tests run on synthetic series.

export const CTA_MARKETS = Object.freeze([
  { key: 'ES', symbol: 'ES=F', label: 'S&P 500', group: 'equities', roll: 'low' },
  { key: 'NQ', symbol: 'NQ=F', label: 'Nasdaq 100', group: 'equities', roll: 'low' },
  { key: 'ZN', symbol: 'ZN=F', label: '10-year note', group: 'bonds', roll: 'low' },
  // The ICE index itself: Yahoo serves no history for DX=F. No contract, so no roll; its hours
  // are the Globex week's near enough that ES=F's session says whether its last bar is live.
  { key: 'DX', symbol: 'DX-Y.NYB', label: 'Dollar index', group: 'dollar', roll: 'none', sessionSymbol: 'ES=F' },
  { key: 'CL', symbol: 'CL=F', label: 'WTI crude', group: 'commodities', roll: 'high' },
  { key: 'GC', symbol: 'GC=F', label: 'Gold', group: 'commodities', roll: 'moderate' },
]);
export const LOOKBACKS = Object.freeze([
  { days: 21, label: '1m' },
  { days: 63, label: '3m' },
  { days: 252, label: '12m' },
]);
export const VOL_WINDOW = 63;
export const FULL_Z = 1;
export const CROWDED = 0.8;     // at or beyond this, the model is at or near its maximum
export const NEUTRAL = 0.2;     // inside this, the model is close to flat
export const CHANGE_SESSIONS = 5;
export const SCENARIO_SIGMAS = Object.freeze([-2, -1, 0, 1, 2]);
export const MIN_BARS = LOOKBACKS.at(-1).days + VOL_WINDOW + CHANGE_SESSIONS + 2;

const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const round = (x, dp) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(dp));
// Price precision that reads like the market's own quote: 2dp above 100, 3 below, 4 below 10.
export const priceDp = (p) => (p >= 100 ? 2 : p >= 10 ? 3 : 4);

// σ of daily log returns over the last `n` closes (population form — this is a scale, not an estimate
// anyone is testing a hypothesis with).
export function sigmaDaily(closes, n = VOL_WINDOW) {
  const c = closes.slice(-(n + 1));
  if (c.length < n + 1) return null;
  const r = [];
  for (let i = 1; i < c.length; i++) if (c[i] > 0 && c[i - 1] > 0) r.push(Math.log(c[i] / c[i - 1]));
  if (r.length < n * 0.8) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length;
  return v > 0 ? Math.sqrt(v) : null;
}

// One window's score at `price` against reference close `ref`.
export const windowScore = (price, ref, sigma, days) =>
  (price > 0 && ref > 0 && sigma > 0) ? clamp(Math.log(price / ref) / (sigma * Math.sqrt(days)) / FULL_Z) : null;

// The blended position at `price`, given each window's reference close.
export function blend(price, refs, sigma) {
  const s = LOOKBACKS.map((w, i) => windowScore(price, refs[i], sigma, w.days));
  if (s.some(x => x == null)) return null;
  return s.reduce((a, b) => a + b, 0) / s.length;
}

// The price at which the blend crosses zero. Monotonic non-decreasing in price, so bisection on
// log price is exact to well under a tick.
export function blendedFlip(refs, sigma) {
  if (!(sigma > 0) || refs.some(r => !(r > 0))) return null;
  let lo = Math.log(Math.min(...refs)) - 1, hi = Math.log(Math.max(...refs)) + 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (blend(Math.exp(mid), refs, sigma) < 0) lo = mid; else hi = mid;
  }
  return Math.exp((lo + hi) / 2);
}

export function stanceOf(pos) {
  if (pos == null) return null;
  if (pos >= CROWDED) return 'max long';
  if (pos >= NEUTRAL) return 'long';
  if (pos > -NEUTRAL) return 'neutral';
  if (pos > -CROWDED) return 'short';
  return 'max short';
}

// ── ONE MARKET ───────────────────────────────────────────────────────────────
// `closes` oldest first. `live` says whether the LAST close is a session still trading: then the
// last value is the live price and the close still to come is that session's, measured against
// the references behind it. When it has settled, the close still to come is the next session's,
// and every reference moves forward one.
export function ctaMarket(closes, { live = false } = {}) {
  const c = (Array.isArray(closes) ? closes : []).map(Number).filter(x => Number.isFinite(x) && x > 0);
  if (c.length < MIN_BARS) return { ok: false, reason: `needs ${MIN_BARS} daily closes, has ${c.length}` };
  const n = c.length;
  const price = c[n - 1];
  const sigma = sigmaDaily(c);
  if (!sigma) return { ok: false, reason: 'no usable volatility' };

  // Position NOW: the latest price against the closes L sessions behind it.
  const refsNow = LOOKBACKS.map(w => c[n - 1 - w.days]);
  const position = blend(price, refsNow, sigma);

  // The close still to come — this session's if live, the next one's if settled.
  const refsNext = live ? refsNow : LOOKBACKS.map(w => c[n - w.days]);
  const flip = blendedFlip(refsNext, sigma);
  const dp = priceDp(price);
  const dist = (lvl) => ({ pct: round((lvl / price - 1) * 100, 2), sigmas: round(Math.log(lvl / price) / sigma, 2) });

  const windows = LOOKBACKS.map((w, i) => {
    const score = windowScore(price, refsNow[i], sigma, w.days);
    const d = dist(refsNext[i]);
    return { label: w.label, days: w.days, score: round(score, 2), flip: round(refsNext[i], dp), flipPct: d.pct, flipSigmas: d.sigmas };
  });

  // Five sessions ago, rebuilt from the series as it stood then — its own σ, its own references.
  const past = c.slice(0, n - CHANGE_SESSIONS);
  const pSigma = sigmaDaily(past);
  const pastPos = pSigma ? blend(past.at(-1), LOOKBACKS.map(w => past[past.length - 1 - w.days]), pSigma) : null;

  // If the price simply holds into the close still to come — how much of the position the window
  // roll alone changes. A trend fund adds or cuts with no move at all when an old close drops out.
  const hold = blend(price, refsNext, sigma);

  // The close still to come at ±1σ and ±2σ: the model's position there, as % of max. No dollars.
  const scenarios = SCENARIO_SIGMAS.map(k => {
    const p = price * Math.exp(k * sigma);
    return { sigmas: k, price: round(p, dp), position: round(blend(p, refsNext, sigma), 2) };
  });

  const fd = flip != null ? dist(flip) : { pct: null, sigmas: null };
  return {
    ok: true, price: round(price, dp), live: !!live,
    sigmaDailyPct: round(sigma * 100, 2), sigmaAnnPct: round(sigma * Math.sqrt(252) * 100, 1),
    position: round(position, 2), stance: stanceOf(position),
    change: pastPos == null ? null : round(position - pastPos, 2),
    hold: round(hold, 2),
    windows,
    flip: round(flip, dp), flipPct: fd.pct, flipSigmas: fd.sigmas,
    scenarios,
  };
}

// The window flip nearest to price that would CUT the position — judged against the OVERALL
// position, not the window's own sign. For a net long, that is a long window's flip below price; a
// short window's flip above price would ADD to the long, not cut it (2026-09-25, the dollar: net
// long, with its three-month window short and flipping just overhead). Net flat: the nearest flip
// either way, since any of them moves it.
export function nearestCut(m) {
  if (!m?.ok) return null;
  const dir = m.position >= NEUTRAL ? 1 : m.position <= -NEUTRAL ? -1 : 0;
  const cands = m.windows.filter(w => w.score != null && w.score !== 0 && w.flip != null)
    .filter(w => (dir > 0 ? (w.score > 0 && w.flip < m.price) : dir < 0 ? (w.score < 0 && w.flip > m.price) : true));
  if (!cands.length) return null;
  return cands.reduce((a, b) => (Math.abs(b.flipSigmas) < Math.abs(a.flipSigmas) ? b : a));
}

// One line across the book: where the model sits per market, grouped the way the desk notes speak.
export function ctaSummary(markets = []) {
  const ok = markets.filter(m => m?.ok);
  if (!ok.length) return null;
  const parts = ok.map(m => `${m.key} ${m.stance}`);
  const cut = ok.map(m => ({ m, w: nearestCut(m) })).filter(x => x.w)
    .sort((a, b) => Math.abs(a.w.flipSigmas) - Math.abs(b.w.flipSigmas))[0];
  return {
    line: parts.join(' · '),
    crowded: ok.filter(m => Math.abs(m.position) >= CROWDED).map(m => m.key),
    nearest: cut ? { key: cut.m.key, label: cut.w.label, flip: cut.w.flip, pct: cut.w.flipPct, sigmas: cut.w.flipSigmas } : null,
  };
}

// ── THE REPLICA ON A PAST DATE ───────────────────────────────────────────────
// What the model held at a given close, rebuilt from the series as it stood then — its own σ, its
// own references. The CFTC check (lib/cot.js) compares Tuesday with Tuesday.
export function positionAt(closes) {
  const c = (Array.isArray(closes) ? closes : []).filter(x => x > 0);
  const n = c.length;
  if (n < LOOKBACKS.at(-1).days + VOL_WINDOW + 2) return null;
  const sigma = sigmaDaily(c);
  return sigma ? blend(c[n - 1], LOOKBACKS.map(w => c[n - 1 - w.days]), sigma) : null;
}
export const positionOn = (bars, date) =>
  positionAt((Array.isArray(bars) ? bars : []).filter(b => b?.date && b.date <= date).map(b => +b.close));
