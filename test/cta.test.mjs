// test/cta.test.mjs — the CTA replica (lib/cta.js), on synthetic series whose answers are known.
import { ctaMarket, sigmaDaily, windowScore, blend, blendedFlip, stanceOf, nearestCut, ctaSummary,
         LOOKBACKS, MIN_BARS, CTA_MARKETS, CROWDED, NEUTRAL, priceDp, ctaSeries, positionOn } from '../lib/cta.js';
import { globexEvening, marketState } from '../lib/sessions.js';
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
  eq('six markets: equities, bonds, dollar, crude, gold', CTA_MARKETS.map(m => m.key), ['ES', 'NQ', 'ZN', 'DX', 'CL', 'GC']);
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

// ── THE CME EVENING: A LIVE PRICE ON A SETTLED SESSION'S BAR ─────────────────
// Yahoo dates futures bars by the New York calendar day, so from the 18:00 reopen to midnight the
// live Globex price sits on the bar of the session that settled at 17:00 — gold on 7 Oct 2026 read
// 4134.4 on the 7th's bar, which COMEX had settled at 4140.7. Rebuilt here with dated bars.
{
  const c = series(N, { drift: 0.002 });              // settled closes, the last one the 7th's
  const n = c.length;
  const day0 = Date.parse('2026-10-07T00:00:00Z');
  const bars = c.map((close, i) => ({ date: new Date(day0 - (n - 1 - i) * 86400000).toISOString().slice(0, 10), close }));
  const settle = c.at(-1);
  const livePx = settle * Math.exp(-0.0015);          // the evening's Globex print, below the settle
  const yahoo = [...bars.slice(0, -1), { ...bars.at(-1), close: livePx }];   // what the feed serves at 23:30 UTC

  // The clock: 19:30 New York on the 7th is the evening of the 7th; 16:30 and 00:30 are not.
  eq('23:30 UTC on 7 Oct is the evening of the 7th, and the market is open',
     [globexEvening(new Date('2026-10-07T23:30:00Z')), marketState('GC=F', new Date('2026-10-07T23:30:00Z'))], ['2026-10-07', 'open']);
  eq('the day session is not the evening', globexEvening(new Date('2026-10-07T20:30:00Z')), null);
  eq('nor is after midnight New York, when Yahoo has opened the 8th\'s bar', globexEvening(new Date('2026-10-08T04:30:00Z')), null);
  eq('nor Sunday\'s reopen, which closed no session', globexEvening(new Date('2026-10-11T23:00:00Z')), null);

  // What the route reported between 17:00 and 18:00, live: false — the references for the 8th.
  const halt = ctaMarket(c, { live: false });
  const want = LOOKBACKS.map(w => +c[n - w.days].toFixed(2));
  eq('the halt hour already had it right: the 8th is measured L sessions back from the 8th', halt.windows.map(w => w.flip), want);

  // THE BUG: the live price taken as the 7th's close, so the flips are the 7th's references.
  const bug = ctaMarket(yahoo.map(b => b.close), { live: true });
  eq('as served, the evening measured a session that had already settled', bug.windows.map(w => w.flip), LOOKBACKS.map(w => +c[n - 1 - w.days].toFixed(2)));

  // THE FIX, with the settle recovered: the 7th's bar back to its settle, the live price the 8th's.
  const s = ctaSeries(yahoo, { live: true, evening: '2026-10-07', settle });
  eq('the series gains a session: the settle, then the live price', [s.closes.length, s.closes.at(-2), s.closes.at(-1)], [n + 1, settle, livePx]);
  eq('and says so', s.evening, { date: '2026-10-07', settle });
  const fixed = ctaMarket(s.closes, { live: true });
  eq('the evening\'s flips are the 8th\'s — the same levels the halt hour gave', fixed.windows.map(w => w.flip), want);
  ok('which are not the ones it printed', fixed.windows.every((w, i) => w.flip !== bug.windows[i].flip));
  eq('the price is still the live one', fixed.price, +livePx.toFixed(2));
  ok('the blended flip is the zero of the 8th\'s references', Math.abs(fixed.flip - blendedFlip(LOOKBACKS.map(w => c[n - w.days]), sigmaDaily([...c, livePx]))) < 0.01);
  eq('the dated bars carry the settle again, for the CFTC Tuesday check', s.bars.at(-1), bars.at(-1));
  ok('so the position on the 7th is the settled one', positionOn(s.bars, '2026-10-07') === positionOn(bars, '2026-10-07'));

  // No settle to be had: the levels are still right; only σ carries the live price a day early.
  const blind = ctaSeries(yahoo, { live: true, evening: '2026-10-07' });
  eq('without a settle the overwritten bar keeps the live price', [blind.closes.at(-2), blind.closes.at(-1), blind.evening.settle], [livePx, livePx, null]);
  eq('and every window flip is still the 8th\'s', ctaMarket(blind.closes, { live: true }).windows.map(w => w.flip), want);
  eq('its dated bars are left as served', blind.bars, yahoo);

  // Anything else passes straight through.
  const unchanged = (o) => { const r = ctaSeries(yahoo, o); return r.evening === null && r.closes.length === n && r.bars === yahoo; };
  ok('settled (the halt hour, the weekend): unchanged', unchanged({ live: false, evening: '2026-10-07', settle }));
  ok('the day session: unchanged', unchanged({ live: true, evening: null, settle }));
  ok('a last bar not dated the evening: unchanged', unchanged({ live: true, evening: '2026-10-06', settle }));
  eq('no bars, no crash', ctaSeries(null, { live: true, evening: '2026-10-07' }).closes, []);
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

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
