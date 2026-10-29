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
// THE CLOSE IS THE SETTLEMENT (29 Oct). A futures day has two closes: the exchange's settlement,
// fixed in a window before the session ends (`settleEt`, New York time), and the last trade at
// 17:00. Funds mark and trade at the settlement, and Yahoo's history carries settlements — but for
// some hours after the close Yahoo's latest bar holds the 17:00 last trade, and in the Globex
// evening it holds the live price. On 28 Oct the Nasdaq settled 29,979.5 and last traded 29,756.25:
// the evening check read the model selling 16 points on the close; on the settlement it sold 7.
// Over 500 sessions the two disagreed on whether a market traded 15 points or more on 11 to 37
// days a market — most often gold, crude and the 10-year, which settle hours before 17:00. So the
// latest close is the price at the settlement time (lib/yahoo.js yahooSettlePrices — within a
// tick or two of the official figure) until Yahoo carries the settlement itself.
//
// PURE: bars in, numbers out. The route (api/atr.js ?cta=1) fetches; tests run on synthetic series.

// Nasdaq before the S&P, as everywhere on the dashboard (QQQ before SPY).
export const CTA_MARKETS = Object.freeze([
// `settleEt`: the end of the exchange's settlement window, New York time — equity index 15:00
// Chicago, Treasuries 14:00 Chicago, WTI 14:30 New York, gold 13:30 New York.
  { key: 'NQ', symbol: 'NQ=F', label: 'Nasdaq 100', group: 'equities', roll: 'low', settleEt: '16:00' },
  { key: 'ES', symbol: 'ES=F', label: 'S&P 500', group: 'equities', roll: 'low', settleEt: '16:00' },
  { key: 'ZN', symbol: 'ZN=F', label: '10-year note', group: 'bonds', roll: 'low', settleEt: '15:00' },
  // The ICE index itself: Yahoo serves no history for DX=F. No contract, so no roll and no
  // settlement; its hours are the Globex week's near enough that ES=F's session says whether its
  // last bar is live.
  { key: 'DX', symbol: 'DX-Y.NYB', label: 'Dollar index', group: 'dollar', roll: 'none', sessionSymbol: 'ES=F' },
  { key: 'CL', symbol: 'CL=F', label: 'WTI crude', group: 'commodities', roll: 'high', settleEt: '14:30' },
  { key: 'GC', symbol: 'GC=F', label: 'Gold', group: 'commodities', roll: 'moderate', settleEt: '13:30' },
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

// The price at which the blend reaches `target` — the generalisation of the flip (target 0). Null
// when the target is outside what the windows can reach (every window saturated at ±1 beyond it).
export function priceForPosition(target, refs, sigma) {
  if (!(sigma > 0) || refs.some(r => !(r > 0)) || !Number.isFinite(target)) return null;
  let lo = Math.log(Math.min(...refs)) - 1, hi = Math.log(Math.max(...refs)) + 1;
  const at = (x) => blend(Math.exp(x), refs, sigma);
  if (!(at(lo) < target - 1e-9 && at(hi) > target + 1e-9)) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) < target) lo = mid; else hi = mid;
  }
  return Math.exp((lo + hi) / 2);
}

// ── THE GLOBEX EVENING ───────────────────────────────────────────────────────
// CME futures settle the day at 17:00 New York and reopen at 18:00 for the NEXT trade date. Yahoo
// does not open a new daily bar for that evening: it keeps updating the bar just closed, so from
// 18:00 to midnight the last bar is dated the finished day while its "close" is the live price
// (7 Oct 2026, gold: the 7 Oct bar read 4134.4 at 23:30 UTC against a 17:00 close of 4136.7).
// Read as it comes, the model judged the live price against the references of a close that had
// already happened — the Asia pre-read, posted in that window, printed gold's 4,140.8 cut when the
// next close's three-month reference was 4,113.7.

// The trade date a Globex session belongs to: from 18:00 New York it is the next day's.
export function globexTradeDate(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(now)).map(x => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  if (+p.hour < 18) return date;
  return new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

// The closes the model should read. In the evening window — live, and the last bar dated before
// the session's trade date — the last bar is put back to its close (`settled`: the settlement-time
// price, or the 17:00 close where a market has no settlement; when it could not be read the bar is
// left as Yahoo has it) and the live price is appended as the new session's, so every reference
// moves forward one. When the market is shut, the last bar takes `finished` (settlementFor) if
// one is given. In the day session the bars are read as they are.
//
// A WEEKEND-DATED BAR IS NEVER A SESSION. Sunday's 18:00 reopen is Monday's trade date, but if
// Yahoo gives that evening a bar of its own it is dated Sunday. Kept, it would count as a finished
// day and the live price would be appended after it — the same price twice, every reference one
// session too far back. Its close is dropped, Friday stays the last settled close, and the live
// price is appended once. (Yahoo's five-year history carries no weekend bars; only a live last bar can be one.)
export const isWeekendDate = (date) => {
  const d = typeof date === 'string' ? new Date(`${date}T12:00:00Z`).getUTCDay() : NaN;
  return d === 0 || d === 6;
};
// After the close, until Yahoo swaps in the settlement, its last bar holds the 17:00 last trade.
// While it still does, the settlement-time price stands in; once it no longer matches the last
// trade, the bar is the settlement itself and is left alone. `prices` is yahooSettlePrices'.
export function settlementFor(barClose, { settle = null, last = null } = {}) {
  if (!(barClose > 0) || !(settle > 0) || !(last > 0)) return null;
  return Math.abs(barClose - last) <= barClose * 1e-7 ? settle : null;
}

export function closesForModel(bars = [], { live = false, tradeDate = null, settled = null, finished = null } = {}) {
  const last = bars.at(-1);
  const weekend = isWeekendDate(last?.date);
  const closes = (weekend ? bars.slice(0, -1) : bars).map(b => b.close);
  if (!live && !weekend && last && finished > 0) {
    closes[closes.length - 1] = finished;
    return { closes, evening: false, date: last.date, settled: finished };
  }
  if (!live || !last || !tradeDate || !(last.date < tradeDate)) return { closes, evening: false, date: last?.date ?? null };
  // THE EVENING ON A BAR OF ITS OWN (29 Oct). Yahoo does not always fold the evening into the
  // finished day: on 28 Oct at 02:30 UTC it served the day's settled bar and then a second bar for
  // the evening, dated — by the chart's offset — the same day. Read as two sessions, that day
  // counted twice and every reference sat one session too far back. The second bar is the live
  // price; the first is the finished day, given its settlement when it still holds the last trade.
  if (!weekend && bars.length > 1 && bars.at(-2).date === last.date) {
    const out = closes.slice(0, -1);
    if (finished > 0) out[out.length - 1] = finished;
    out.push(last.close);
    return { closes: out, evening: true, date: tradeDate, settled: finished > 0 ? finished : null };
  }
  const out = closes.slice();
  // A weekday last bar is the finished day carrying the live price; under a weekend bar, Friday's is settled.
  if (!weekend && settled > 0) out[out.length - 1] = settled;
  out.push(last.close);
  return { closes: out, evening: true, date: tradeDate, settled: !weekend && settled > 0 ? settled : null };
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

  // WHAT THE MODEL TRADES, AND WHEN (23 Oct). The score is continuous, so the model trades a little
  // on every close — not only at a window's flip; it stops trading a window only once that window
  // is saturated at ±1. So the day's question is: what did it hold going into the close still to
  // come, and at which close does it neither buy nor sell (the pivot)? Below the pivot it sells,
  // above it buys, and the scenarios say how much per σ.
  //   held   the position the funds carry into the close still to come — the last settled close's
  //          when the session is live, this close's when it has settled
  //   today  the position change on the latest close against the one before: what the model traded
  //          at today's close (live: what it would trade if the session closed here)
  const prevC = c.slice(0, n - 1), prevSigma = sigmaDaily(prevC);
  const prevPos = prevSigma ? blend(prevC.at(-1), LOOKBACKS.map(w => prevC[prevC.length - 1 - w.days]), prevSigma) : null;
  const held = live ? prevPos : position;
  const pivot = held == null || Math.abs(held) >= 0.995 ? null : priceForPosition(held, refsNext, sigma);
  const pd = pivot != null ? dist(pivot) : { pct: null, sigmas: null };

  // The close still to come at ±1σ and ±2σ: the model's position there, as % of max. No dollars.
  const scenarios = SCENARIO_SIGMAS.map(k => {
    const p = price * Math.exp(k * sigma);
    const pos = blend(p, refsNext, sigma);
    return { sigmas: k, price: round(p, dp), position: round(pos, 2), trade: held == null ? null : round(pos - held, 2) };
  });

  const fd = flip != null ? dist(flip) : { pct: null, sigmas: null };
  return {
    ok: true, price: round(price, dp), live: !!live,
    sigmaDailyPct: round(sigma * 100, 2), sigmaAnnPct: round(sigma * Math.sqrt(252) * 100, 1),
    position: round(position, 2), stance: stanceOf(position),
    change: pastPos == null ? null : round(position - pastPos, 2),
    hold: round(hold, 2),
    held: round(held, 2), today: prevPos == null ? null : round(position - prevPos, 2),
    pivot: round(pivot, dp), pivotPct: pd.pct, pivotSigmas: pd.sigmas,
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
//
// NEUTRAL: THE NET-FLAT LEVEL. A neutral model is its windows cancelling — gold on 2026-09-25 was
// −100% on one month against +55% and +67% on three and twelve — so the nearest single-window flip
// says little. The price where the three cancel exactly is the level: below it the model tips net
// short, above it net long. It carries label 'net' so every consumer can say "net flat", not "window".
export function nearestCut(m) {
  if (!m?.ok) return null;
  const dir = m.position >= NEUTRAL ? 1 : m.position <= -NEUTRAL ? -1 : 0;
  if (dir === 0) {
    if (m.flip == null) return null;
    return { label: 'net', net: true, flip: m.flip, flipPct: m.flipPct, flipSigmas: m.flipSigmas,
             side: m.flip < m.price ? 'below' : 'above', tips: m.flip < m.price ? 'short' : 'long' };
  }
  const cands = m.windows.filter(w => w.score != null && w.score !== 0 && w.flip != null)
    .filter(w => (dir > 0 ? (w.score > 0 && w.flip < m.price) : dir < 0 ? (w.score < 0 && w.flip > m.price) : true));
  if (!cands.length) return null;
  return cands.reduce((a, b) => (Math.abs(b.flipSigmas) < Math.abs(a.flipSigmas) ? b : a));
}

// BOTH WAYS (23 Oct). nearestCut names only the level that REDUCES the position, so a short that
// grew on a close through a long window's flip went unreported (gold, 22 Oct: −0.30 → −0.39 on a
// close below the three-month level, while the alert watched only the twelve-month one overhead).
// For the close still to come, a window is long above its flip and short below it, so:
//   sell  the nearest window flip BELOW price — a close under it turns that window short
//   buy   the nearest window flip ABOVE price — a close over it turns that window long
// Whether that cuts or adds depends on the overall position, said in `effect`.
export function flowLevels(m) {
  if (!m?.ok) return null;
  const ws = (m.windows || []).filter(w => w.flip != null && w.flipSigmas != null);
  const pick = (side) => {
    const c = ws.filter(w => (side === 'sell' ? w.flip < m.price : w.flip > m.price));
    if (!c.length) return null;
    const w = c.reduce((a, b) => (Math.abs(b.flipSigmas) < Math.abs(a.flipSigmas) ? b : a));
    const dir = m.position >= NEUTRAL ? 1 : m.position <= -NEUTRAL ? -1 : 0;
    const effect = side === 'sell' ? (dir > 0 ? 'cuts the long' : dir < 0 ? 'adds to the short' : 'tips it short')
                                   : (dir < 0 ? 'covers the short' : dir > 0 ? 'adds to the long' : 'tips it long');
    return { label: w.label, flip: w.flip, flipPct: w.flipPct, flipSigmas: w.flipSigmas, turns: side === 'sell' ? 'short' : 'long', effect };
  };
  return { sell: pick('sell'), buy: pick('buy') };
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
