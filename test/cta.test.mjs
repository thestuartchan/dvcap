// test/cta.test.mjs — the CTA replica (lib/cta.js), on synthetic series whose answers are known.
import { ctaMarket, sigmaDaily, windowScore, blend, blendedFlip, stanceOf, nearestCut, ctaSummary, flowLevels, priceForPosition,
         LOOKBACKS, MIN_BARS, CTA_MARKETS, CROWDED, NEUTRAL, priceDp, globexTradeDate, closesForModel, isWeekendDate, settlementFor } from '../lib/cta.js';
import { closeBeforeFrom, priceBeforeEt } from '../lib/yahoo.js';
import { marketState } from '../lib/sessions.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A series with a fixed daily drift and an alternating wiggle, so σ is known and non-zero.
function series(n, { start = 100, drift = 0, wiggle = 0.01 } = {}) {
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * Math.exp(drift + (i % 2 ? wiggle : -wiggle)));
  return out;
}
const N = MIN_BARS + 20;

// ── THE PIECES ───────────────────────────────────────────────────────────────
{
  const flat = series(200, { wiggle: 0.01 });
  ok('σ of an alternating ±1% series is 1%', near(sigmaDaily(flat), 0.01, 1e-5));
  eq('too short a series has no σ', sigmaDaily([100, 101]), null);
  eq('a one-sigma move over the window is full conviction', windowScore(100 * Math.exp(0.01 * Math.sqrt(21)), 100, 0.01, 21), 1);
  ok('half a sigma is half', near(windowScore(100 * Math.exp(0.005 * Math.sqrt(21)), 100, 0.01, 21), 0.5, 1e-9));
  eq('and a five-sigma collapse is capped at max short', windowScore(100 * Math.exp(-0.05 * Math.sqrt(21)), 100, 0.01, 21), -1);
  eq('no price, no score', windowScore(null, 100, 0.01, 21), null);
  const refs = [100, 90, 120];
  const f = blendedFlip(refs, 0.01);
  ok('the blended flip is where the average crosses zero', near(blend(f, refs, 0.01), 0, 1e-9));
  ok('and it sits between the references', f > 90 && f < 120);
  eq('stances at the edges', [stanceOf(0.8), stanceOf(0.79), stanceOf(0.2), stanceOf(0.19), stanceOf(-0.19), stanceOf(-0.2), stanceOf(-0.8)],
     ['max long', 'long', 'long', 'neutral', 'neutral', 'short', 'max short']);
  eq('thresholds', [CROWDED, NEUTRAL], [0.8, 0.2]);
  eq('the windows are one, three and twelve months', LOOKBACKS.map(w => w.days), [21, 63, 252]);
  eq('six markets: equities (Nasdaq first), bonds, dollar, crude, gold', CTA_MARKETS.map(m => m.key), ['NQ', 'ES', 'ZN', 'DX', 'CL', 'GC']);
  eq('crude carries the largest roll caveat, the dollar index none', [CTA_MARKETS.find(m => m.key === 'CL').roll, CTA_MARKETS.find(m => m.key === 'DX').roll], ['high', 'none']);
  eq('quote precision reads like the market', [priceDp(6512.25), priceDp(24.5), priceDp(1.08)], [2, 3, 4]);
}

// ── A STEADY UPTREND IS MAX LONG; A DOWNTREND MAX SHORT ──────────────────────
{
  const up = ctaMarket(series(N, { drift: 0.004 }));
  eq('an uptrend: max long', [up.ok, up.stance, up.position], [true, 'max long', 1]);
  ok('every window agrees', up.windows.every(w => w.score === 1));
  const down = ctaMarket(series(N, { drift: -0.004 }));
  eq('a downtrend: max short', [down.stance, down.position], ['max short', -1]);
  const flat = ctaMarket(series(N, { drift: 0 }));
  eq('no trend: neutral', flat.stance, 'neutral');
  eq('too little history is refused, with the count', ctaMarket(series(100)).ok, false);
  ok('and says how many it needs', /needs \d+ daily closes, has 100/.test(ctaMarket(series(100)).reason));
}

// ── FLIP LEVELS ARE THE CLOSES THE NEXT CLOSE IS MEASURED FROM ───────────────
{
  const c = series(N, { drift: 0.003 });
  const n = c.length;
  const settled = ctaMarket(c, { live: false });
  // Settled: the close still to come is the next session's, measured L sessions back from IT.
  eq('settled: each window flips at the close L sessions before the next one',
     settled.windows.map(w => w.flip), LOOKBACKS.map(w => +c[n - w.days].toFixed(2)));
  const live = ctaMarket(c, { live: true });
  eq('live: this session\'s close is measured from L sessions behind it',
     live.windows.map(w => w.flip), LOOKBACKS.map(w => +c[n - 1 - w.days].toFixed(2)));
  ok('in an uptrend every flip is below price', settled.windows.every(w => w.flip < settled.price && w.flipPct < 0 && w.flipSigmas < 0));
  ok('the blended flip is below price too', settled.flip < settled.price);
  const refs = LOOKBACKS.map(w => c[n - w.days]);
  ok('and it is the zero of the blend, to a cent', Math.abs(settled.flip - blendedFlip(refs, sigmaDaily(c))) < 0.01);
  // The level a reader watches: the nearest flip that would CUT a long.
  const cut = nearestCut(settled);
  eq('the nearest cutting flip is the one-month window', cut.label, '1m');
  ok('it is the closest of the three', settled.windows.every(w => Math.abs(w.flipSigmas) >= Math.abs(cut.flipSigmas)));
}

// ── WHAT A MOVE, OR NO MOVE, DOES TO IT ──────────────────────────────────────
{
  // A long trend that has just rolled over: the one-month window turns first.
  const c = [...series(N - 15, { drift: 0.003 })];
  for (let i = 0; i < 15; i++) c.push(c.at(-1) * Math.exp(-0.012 + (i % 2 ? 0.004 : -0.004)));
  const m = ctaMarket(c);
  ok('after a sharp two-week drop the one-month window is short', m.windows[0].score < 0);
  ok('while the twelve-month is still long', m.windows[2].score > 0);
  ok('and the position has come down over five sessions', m.change < 0);
  eq('scenarios run −2σ to +2σ', m.scenarios.map(s => s.sigmas), [-2, -1, 0, 1, 2]);
  ok('and the position rises with price', m.scenarios.every((s, i, a) => i === 0 || s.position >= a[i - 1].position));
  eq('the flat scenario is the hold', m.scenarios[2].position, m.hold);
}

// ── WHAT IT TRADES, AND WHERE IT SELLS OR BUYS (23 Oct) ───────────────────────
{
  const c = [...series(N - 15, { drift: 0.003 })];
  for (let i = 0; i < 15; i++) c.push(c.at(-1) * Math.exp(-0.012 + (i % 2 ? 0.004 : -0.004)));
  const m = ctaMarket(c);
  const prev = ctaMarket(c.slice(0, -1));
  eq('settled: today is the position change on the close, against the day before', m.today, +(m.position - prev.position).toFixed(2));
  eq('settled: the funds carry this close\'s position into the next', m.held, m.position);
  ok('the pivot is where the next close leaves the position unchanged', Math.abs(blend(m.pivot, LOOKBACKS.map(w => c[c.length - w.days]), sigmaDaily(c)) - m.position) < 0.005);
  ok('scenario trades are against the held position', m.scenarios.every(s => Math.abs(s.trade - (s.position - m.held)) < 0.011));
  ok('below the pivot it sells, above it buys', m.scenarios.filter(s => s.price < m.pivot).every(s => s.trade <= 0) && m.scenarios.filter(s => s.price > m.pivot).every(s => s.trade >= 0));
  const live = ctaMarket(c, { live: true });
  eq('live: the funds still carry the last settled close\'s position', live.held, prev.position);
  eq('live: today is what it would trade if the session closed here', live.today, +(live.position - prev.position).toFixed(2));
  eq('a target past saturation has no price', priceForPosition(2, [100, 100, 100], 0.01), null);
  const max = ctaMarket(series(N, { drift: 0.01 }));
  eq('at the maximum there is no pivot to give', [max.position, max.pivot], [1, null]);
}
{
  // Gold, 22 Oct: net short, the three-month window long just under price, the twelve-month short just over it.
  const gold = { ok: true, price: 4092.8, position: -0.3, windows: [
    { label: '1m', score: -0.92, flip: 4318.4, flipPct: 5.51, flipSigmas: 4.2 },
    { label: '3m', score: 0.05, flip: 4070.8, flipPct: -0.54, flipSigmas: -0.42 },
    { label: '12m', score: -0.02, flip: 4109.1, flipPct: 0.4, flipSigmas: 0.31 } ] };
  const L = flowLevels(gold);
  eq('both ways: the sell level below price, and what it does to a short', [L.sell.label, L.sell.flip, L.sell.turns, L.sell.effect], ['3m', 4070.8, 'short', 'adds to the short']);
  eq('…and the buy level above it', [L.buy.label, L.buy.flip, L.buy.turns, L.buy.effect], ['12m', 4109.1, 'long', 'covers the short']);
  const long = flowLevels({ ...gold, position: 0.5 });
  eq('for a long the same levels cut and add', [long.sell.effect, long.buy.effect], ['cuts the long', 'adds to the long']);
  eq('nothing above price: no buy level', flowLevels({ ...gold, windows: gold.windows.filter(w => w.flip < gold.price) }).buy, null);
}

// ── A CUT IS JUDGED AGAINST THE NET POSITION ─────────────────────────────────
{
  // The dollar on 2026-09-25: net long, its three-month window short with a flip just overhead.
  const m = { ok: true, price: 101.07, position: 0.56, windows: [
    { label: '1m', score: 1, flip: 99.2, flipSigmas: -4.1 },
    { label: '3m', score: -0.3, flip: 101.43, flipSigmas: 1.13 },
    { label: '12m', score: 1, flip: 97.5, flipSigmas: -7.9 } ] };
  eq('a net long is cut below price, not by a short window overhead', nearestCut(m).label, '1m');
  const short = { ok: true, price: 101.07, position: -0.6, windows: [
    { label: '1m', score: -1, flip: 103, flipSigmas: 1.5 },
    { label: '3m', score: 0.3, flip: 100.5, flipSigmas: -0.4 },
    { label: '12m', score: -1, flip: 105, flipSigmas: 3 } ] };
  eq('a net short is cut above price, by its nearest short window', nearestCut(short).label, '1m');
  // Neutral: the net-flat level, not a single window — gold on 2026-09-25.
  const gold = nearestCut({ ...m, position: 0.07, price: 4339.6, flip: 4274.23, flipPct: -1.51, flipSigmas: -1.2 });
  eq('a neutral market is cut at its net-flat level', [gold.label, gold.net, gold.flip, gold.side, gold.tips], ['net', true, 4274.23, 'below', 'short']);
  eq('and from below, it tips long above it', nearestCut({ ...m, position: -0.1, price: 4200, flip: 4274.23 }).tips, 'long');
}

// ── THE BOOK LINE ────────────────────────────────────────────────────────────
{
  const up = { key: 'ES', ...ctaMarket(series(N, { drift: 0.004 })) };
  const dn = { key: 'ZN', ...ctaMarket(series(N, { drift: -0.004 })) };
  const s = ctaSummary([up, dn, { key: 'CL', ok: false }]);
  eq('one line, market by market, skipping what failed', s.line, 'ES max long · ZN max short');
  eq('crowded names both', s.crowded, ['ES', 'ZN']);
  ok('and names the nearest flip', ['ES', 'ZN'].includes(s.nearest.key));
  eq('nothing usable, no summary', ctaSummary([{ ok: false }]), null);
}


// ── THE GLOBEX EVENING (7 Oct 2026) ──────────────────────────────────────────
// From 18:00 New York Yahoo keeps updating the finished day's bar with the live price. The model
// must read the live price as the NEXT session's, so its references are the ones the settled run
// already quoted for the next close.
{
  eq('before 18:00 New York the trade date is today', globexTradeDate(new Date('2026-10-07T21:30:00Z')), '2026-10-07');
  eq('from 18:00 it is the next day', globexTradeDate(new Date('2026-10-07T22:48:00Z')), '2026-10-08');
  eq('Sunday evening is Monday', globexTradeDate(new Date('2026-10-11T22:30:00Z')), '2026-10-12');
  eq('in winter too (EST)', globexTradeDate(new Date('2026-12-02T23:30:00Z')), '2026-12-03');

  const c = series(N, { drift: 0.001 });
  const bars = c.map((x, i) => ({ date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10), close: x }));
  const lastDate = bars.at(-1).date, next = new Date(Date.parse(lastDate) + 86400000).toISOString().slice(0, 10);
  const settledRun = ctaMarket(c, { live: false });                  // after the 17:00 close
  const livePx = c.at(-1) * 0.998;                                   // the evening's live price
  const yahoo = [...bars.slice(0, -1), { ...bars.at(-1), close: livePx }];  // the bar Yahoo serves
  const m = closesForModel(yahoo, { live: true, tradeDate: next, settled: c.at(-1) });
  eq('the evening: live price appended as the next session, the day put back to its close', [m.evening, m.date, m.closes.length, m.closes.at(-2), m.closes.at(-1)], [true, next, N + 1, c.at(-1), livePx]);
  const evening = ctaMarket(m.closes, { live: true });
  eq('…so every window flips at the level the settled run quoted for the next close', evening.windows.map(w => w.flip), settledRun.windows.map(w => w.flip));
  const naive = ctaMarket(yahoo.map(b => b.close), { live: true });
  ok('(read as Yahoo serves it, the references were a day stale)', naive.windows[1].flip !== settledRun.windows[1].flip);
  eq('without the 17:00 close the bar is kept as served', closesForModel(yahoo, { live: true, tradeDate: next }).closes.at(-2), livePx);
  eq('in the day session nothing changes', closesForModel(bars, { live: true, tradeDate: lastDate }).evening, false);
  eq('nor when the market is shut', closesForModel(bars, { live: false, tradeDate: next }).evening, false);

  // The hourly series: the last bar of the day that started before 17:00 New York (EDT, −4h).
  const t = (iso) => Date.parse(iso) / 1000;
  const result = { meta: { gmtoffset: -14400 }, timestamp: [t('2026-10-07T19:00:00Z'), t('2026-10-07T20:00:00Z'), t('2026-10-07T22:00:00Z'), t('2026-10-07T23:00:00Z')],
    indicators: { quote: [{ close: [4135.5, 4136.7, 4133.1, 4134.4] }] } };
  eq('the 17:00 close from the hourly bars', closeBeforeFrom(result, '2026-10-07'), 4136.7);
  eq('none for a day the series lacks', closeBeforeFrom(result, '2026-10-06'), null);
}

// ── SUNDAY EVENING: A WEEKEND-DATED BAR IS NEVER A SESSION ───────────────────
// Sunday's 18:00 reopen trades for Monday. If Yahoo dates that evening's bar Sunday, keeping it as a
// finished day would append the live price twice and push every reference one session too far back.
{
  // Weekday-dated closes ending Friday 9 Oct 2026, as Yahoo's history is (no weekend bars).
  const c = series(N, { drift: 0.001 });
  const dates = [];
  for (let t = Date.UTC(2026, 9, 9); dates.length < N; t -= 86400000) { const d = new Date(t); if (d.getUTCDay() % 6) dates.unshift(d.toISOString().slice(0, 10)); }
  const bars = c.map((close, i) => ({ date: dates[i], close }));
  const fri = c.at(-1), livePx = fri * 1.003;
  const sunday = new Date('2026-10-11T23:00:00Z');                  // 19:00 New York, Sunday
  const tradeDate = globexTradeDate(sunday);
  eq('Sunday 19:00 New York is Monday\'s session, and the market is open', [tradeDate, marketState('GC=F', sunday)], ['2026-10-12', 'open']);
  eq('weekend dates', [isWeekendDate('2026-10-10'), isWeekendDate('2026-10-11'), isWeekendDate('2026-10-09'), isWeekendDate(null)], [true, true, false, false]);

  // With no Sunday bar: Friday is put back to its close and the live price follows once.
  const noSun = closesForModel([...bars.slice(0, -1), { ...bars.at(-1), close: livePx }], { live: true, tradeDate, settled: fri });
  eq('no Sunday bar: Friday\'s close, then the live price', [noSun.closes.length, noSun.closes.at(-2), noSun.closes.at(-1)], [N + 1, fri, livePx]);
  // With a Sunday-dated bar carrying the live price: dropped as a session, the same closes result.
  const sun = closesForModel([...bars, { date: '2026-10-11', close: livePx }], { live: true, tradeDate });
  eq('a Sunday bar gives the same closes as none', sun.closes, noSun.closes);
  eq('the live price appears once', sun.closes.filter(x => x === livePx).length, 1);
  eq('and it is Monday\'s session', [sun.evening, sun.date, sun.settled], [true, '2026-10-12', null]);
  eq('a stray 17:00 close never replaces Friday under a Sunday bar', closesForModel([...bars, { date: '2026-10-11', close: livePx }], { live: true, tradeDate, settled: fri * 0.9 }).closes, noSun.closes);
  eq('so the flips are Monday\'s — the ones Friday\'s settled run quoted for the next close',
     ctaMarket(sun.closes, { live: true }).windows.map(w => w.flip), ctaMarket(c, { live: false }).windows.map(w => w.flip));
  const kept = ctaMarket([...c, livePx, livePx], { live: true });
  ok('(kept as a session, every reference was a day too far back)', kept.windows[1].flip !== ctaMarket(sun.closes, { live: true }).windows[1].flip);

  // A normal Tuesday evening is unchanged: the day put back to its close, the live price appended.
  const tue = bars.findLastIndex(b => b.date === '2026-10-06');
  const tueBars = bars.slice(0, tue + 1);
  const tueEve = closesForModel([...tueBars.slice(0, -1), { ...tueBars.at(-1), close: livePx }],
                                { live: true, tradeDate: globexTradeDate(new Date('2026-10-06T23:00:00Z')), settled: c[tue] });
  eq('Tuesday evening: Tuesday\'s close, then the live price, as Wednesday\'s session',
     [tueEve.evening, tueEve.date, tueEve.closes.length, tueEve.closes.at(-2), tueEve.closes.at(-1), tueEve.settled], [true, '2026-10-07', tue + 2, c[tue], livePx, c[tue]]);
}


// ── THE CLOSE IS THE SETTLEMENT ───────────────────────────────────────────────
// After the close Yahoo's last bar can hold the 17:00 last trade; the model's close is the
// settlement. Made-up prices; the shape is 28 Oct's, when the two were 223 points apart.
{
  const t = (iso) => Date.parse(iso) / 1000;
  // Five-minute bars, New York EDT (−4h): 15:50, 15:55, 16:00 and 16:55 on the 28th, one on the 27th.
  const five = { meta: { gmtoffset: -18000 }, timestamp: [t('2026-10-27T20:55:00Z'), t('2026-10-28T19:50:00Z'), t('2026-10-28T19:55:00Z'), t('2026-10-28T20:00:00Z'), t('2026-10-28T20:55:00Z')],
    indicators: { quote: [{ close: [500, 1001, 1002, 1010, 980] }] } };
  eq('the price at the settlement time: the last bar that started before it', priceBeforeEt(five, '2026-10-28', '16:00'), 1002);
  eq('the 17:00 last trade from the same bars', priceBeforeEt(five, '2026-10-28', '17:00'), 980);
  eq('New York time from the zone, not the chart\'s (wrong) offset', priceBeforeEt(five, '2026-10-27', '17:00'), 500);
  eq('none for a day the series lacks', priceBeforeEt(five, '2026-10-26', '16:00'), null);
  // A clock change inside the five days: 3 Nov 2025 is EST (−5h), so 16:00 New York is 21:00Z.
  const est = { timestamp: [t('2025-11-03T20:55:00Z'), t('2025-11-03T21:00:00Z')], indicators: { quote: [{ close: [7, 8] }] } };
  eq('…and across a clock change', priceBeforeEt(est, '2025-11-03', '16:00'), 7);

  eq('the bar still holds the last trade: the settlement-time price stands in', settlementFor(980, { settle: 1002, last: 980 }), 1002);
  eq('the bar no longer matches the last trade: it is the settlement, left alone', settlementFor(1003.5, { settle: 1002, last: 980 }), null);
  eq('nothing read, nothing replaced', [settlementFor(980, {}), settlementFor(980, { settle: null, last: 980 })], [null, null]);

  const bars = [{ date: '2026-10-26', close: 990 }, { date: '2026-10-27', close: 995 }, { date: '2026-10-28', close: 980 }];
  const shut = closesForModel(bars, { live: false, tradeDate: '2026-10-28', finished: 1002 });
  eq('market shut: the finished day reads its settlement', [shut.closes, shut.evening, shut.date, shut.settled], [[990, 995, 1002], false, '2026-10-28', 1002]);
  eq('in the day session the live price is left as it is', closesForModel(bars, { live: true, tradeDate: '2026-10-28', finished: 1002 }).closes.at(-1), 980);
  eq('a weekend-dated bar is never given one', closesForModel([...bars, { date: '2026-10-31', close: 977 }], { live: false, finished: 1002 }).closes, [990, 995, 980]);
  // The evening on a bar of its own, dated the finished day (28 Oct, 02:30 UTC).
  const splitBars = [...bars, { date: '2026-10-28', close: 970 }];
  const ev = closesForModel(splitBars, { live: true, tradeDate: '2026-10-29' });
  eq('evening bar of its own: the day counted once, then the live price', [ev.closes, ev.evening, ev.date], [[990, 995, 980, 970], true, '2026-10-29']);
  eq('…and the finished day takes its settlement when it still holds the last trade', closesForModel(splitBars, { live: true, tradeDate: '2026-10-29', finished: 1002 }).closes, [990, 995, 1002, 970]);
  eq('…never the stray `settled` meant for a folded bar', closesForModel(splitBars, { live: true, tradeDate: '2026-10-29', settled: 1 }).closes, [990, 995, 980, 970]);
  eq('every market with a contract has a settlement time; the dollar index has none',
     CTA_MARKETS.map(m => [m.key, m.settleEt ?? null]), [['NQ', '16:00'], ['ES', '16:00'], ['ZN', '15:00'], ['DX', null], ['CL', '14:30'], ['GC', '13:30']]);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
