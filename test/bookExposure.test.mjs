// test/bookExposure.test.mjs — what the book is carrying, in delta.
import { bookExposure, positionExposure, parseOptionSymbol, contractKey, equityDelta,
         trendRead, EXPOSURE_LIMITS, LEVERAGED_ETF, TREND_MIN } from '../lib/bookExposure.js';
import { pickCboeGreeks } from '../lib/cboe.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const near = (n, g, w, tol) => ok(`${n} (${g} ≈ ${w})`, g != null && Math.abs(g - w) <= tol);

const NOW = new Date('2026-09-10T20:00:00Z');

// ── THE LIVE ACCOUNT, 2026-09-10 ────────────────────────────────────────────
// Broker leverage line 0.74×. Premium at risk $41,269 on a $210,335 NLV. Delta-notional ~$737,000
// — 3.5× NLV. The broker's own figure understates directional exposure by roughly five times,
// because it counts long options at PREMIUM rather than at DELTA.
const NLV = 210335;
const ROWS = [
  { symbol: 'QQQ   261016C00730000', qty: 20, multiplier: 100, livePrice: 20.6, assetCategory: 'OPT' },
  { symbol: 'AVGO  261016C00390000', qty: 10, multiplier: 100, livePrice: 14.0, assetCategory: 'OPT' },
  { symbol: 'XLE   270115C00055000', qty: 5,  multiplier: 100, livePrice: 8.2,  assetCategory: 'OPT' },
  { symbol: 'AAPU', qty: 1000, livePrice: 36.5 },
];
const GREEKS = {
  'QQQ|2026-10-16|C|730':  { delta: 0.352, theta: -0.25, vega: 0.55, gamma: 0.006 },
  'AVGO|2026-10-16|C|390': { delta: 0.28,  theta: -0.18, vega: 0.40 },
  'XLE|2027-01-15|C|55':   { delta: 0.90,  theta: -0.01, vega: 0.10 },
};
const SPOTS = { QQQ: 709, AVGO: 357, XLE: 64, AAPU: 36.5 };
const book = bookExposure({ rows: ROWS, greeks: GREEKS, underlyings: SPOTS, nlv: NLV, now: NOW });

{
  // THE FINDING. One option line carrying more than twice the account.
  const qqq = book.lines.find(l => l.symbol.startsWith('QQQ'));
  near('the QQQ line carries about $499,000', qqq.deltaNotional, 499000, 1500);
  eq('which is 2.37× NLV on its own', +(qqq.deltaNotional / NLV).toFixed(2), 2.37);
  near('the book carries about $700,000 in delta', book.deltaNotional, 700000, 5000);
  ok('while premium is a fraction of it', book.premium < book.deltaNotional / 5);
  eq('the state is over the ceiling', book.state, 'OVER CEILING');
  ok('and the ratio is far past it', book.ratio > EXPOSURE_LIMITS.ceiling);

  // EST. BOOK VOL IS WHAT THE COLOUR KEYS OFF, not the delta multiple: the same delta-notional is
  // twice as risky when underlying vol doubles, so a fixed multiple is wrong across regimes.
  near('estimated book volatility is about 60%', Math.round(book.bookVol * 100), 60, 2);
  near('a one-sigma year is about ±$126k', book.oneSd, 126000, 3000);
  eq('the assumptions behind it are stated', [book.limits.underlyingVol, book.limits.correlation], [0.18, 0.75]);

  // Every breach is named, with the number it was judged against.
  ok('the ceiling breach is named', book.breaches.some(b => /over the 2× ceiling/.test(b)));
  ok('the single-position cap too', book.breaches.some(b => /over the 0.5× single-position cap/.test(b)));
  ok('and the theta ceiling', book.breaches.some(b => /over the 0.25% ceiling/.test(b)));
  ok('and the vol target', book.breaches.some(b => /above the 20–25% target/.test(b)));
  eq('the largest line is flagged by name', book.largest.symbol.trim(), 'QQQ   261016C00730000'.trim());
  eq('and it is the only one over the cap', book.overCap.length, 1);
  near('theta is about 0.33% of NLV per day', book.thetaPct, 0.33, 0.02);
}

// ── LEVERAGED ETFs ──────────────────────────────────────────────────────────
// AAPU is 2× AAPL. Counted at 1.0 the book understates by the whole leveraged half.
{
  const aapu = book.lines.find(l => l.symbol === 'AAPU');
  eq('AAPU is counted at 2× delta', aapu.delta, 2);
  eq('so it carries $73,000, not $36,500', aapu.deltaNotional, 73000);
  ok('and the source of the multiple is stated', /leveraged-etf/.test(aapu.deltaSource));
  eq('an ordinary equity is 1×', equityDelta('AAPL').delta, 1);
  eq('an inverse fund keeps its sign', equityDelta('SQQQ').delta, -3);
  // A ROW MAY STATE ITS OWN. The table only fills a gap — the same reasoning as lib/futures.js,
  // where a wrong default is worse than a missing one.
  eq('a stated multiple wins over the table', equityDelta('AAPU', 1.5), { delta: 1.5, source: 'row' });
  ok('the table is not empty and carries both directions',
     Object.keys(LEVERAGED_ETF).length > 5 && Object.values(LEVERAGED_ETF).some(v => v < 0));
}

// ── A LINE THE FEED DID NOT CARRY IS NAMED, NEVER DROPPED ───────────────────
// A book total that quietly omits its largest position is the failure this tile exists to fix.
{
  const blind = bookExposure({ rows: ROWS, greeks: { 'AVGO|2026-10-16|C|390': GREEKS['AVGO|2026-10-16|C|390'] },
                               underlyings: SPOTS, nlv: NLV, now: NOW });
  eq('two option lines have no published greek', blind.unpriced.length, 2);
  ok('and they are named', blind.unpriced.some(u => u.symbol.startsWith('QQQ')));
  ok('with the reason', /no published delta/.test(blind.unpriced[0].why));
  // Their premium still counts — what is withheld is the delta, not the position.
  eq('their premium is still in the total', blind.premium, book.premium);
  ok('but their delta is not', blind.deltaNotional < book.deltaNotional);
  // No underlying price is a different reason, and says so.
  const noSpot = bookExposure({ rows: [ROWS[0]], greeks: GREEKS, underlyings: {}, nlv: NLV, now: NOW });
  ok('a missing underlying is its own reason', /no underlying price/.test(noSpot.unpriced[0].why));
}

// ── OPTION SYMBOLS ──────────────────────────────────────────────────────────
// A misread strike is a silent order-of-magnitude error in every number below it.
{
  eq('the OCC 21-character form', parseOptionSymbol('QQQ   261016C00730000'),
     { root: 'QQQ', expiry: '2026-10-16', type: 'call', strike: 730, form: 'occ' });
  eq('unpadded', parseOptionSymbol('QQQ261016C00730000').strike, 730);
  eq('a fractional strike survives', parseOptionSymbol('SPY   261016P00612500').strike, 612.5);
  eq('a put is a put', parseOptionSymbol('SPY   261016P00612500').type, 'put');
  eq('the compact form', parseOptionSymbol('AVGO 261016C390').strike, 390);
  eq('an ISO date form', parseOptionSymbol('XLE 2027-01-15 C55').expiry, '2027-01-15');
  eq('a human form', parseOptionSymbol("QQQ OCT 16'26 730 C").strike, 730);
  eq('a bare equity ticker is not an option', parseOptionSymbol('AAPL'), null);
  eq('and neither is nothing', parseOptionSymbol(''), null);
  eq('the key is stable across forms',
     contractKey(parseOptionSymbol('QQQ   261016C00730000')), contractKey(parseOptionSymbol('QQQ 261016C730')));
}

// ── DAYS TO EXPIRY AND DISTANCE TO STRIKE, KEPT FROM THE ORIGINAL SPEC ──────
{
  const l = positionExposure(ROWS[0], { greek: GREEKS['QQQ|2026-10-16|C|730'], underlying: 709, now: NOW });
  eq('days to expiry', l.dte, 36);
  near('distance to strike, in per cent', l.distanceToStrikePct, 2.96, 0.05);
  eq('premium is quantity × mark × contract size', l.premium, 41200);
  near('theta is per day, in money', l.theta, -500, 1);
  eq('and vega is per vol point', l.vega, 1100);
}

// ── THE TREND IS THE MOST IMPORTANT ROW ─────────────────────────────────────
// One reading says where the book is. The series says it arrived there gradually without anyone
// deciding to — which is what exposure creep looks like and what a point-in-time number cannot show.
{
  const days = (vals) => vals.map((ratio, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, ratio }));
  const rising = trendRead(days([2.1, 2.3, 2.6, 2.9, 3.2, 3.5]));
  eq('a rising series is named as rising', rising.dir, 'rising');
  eq('with the arrow', rising.arrow, '▲');
  ok('and the two ends', /2\.1× → 3\.5×/.test(rising.note));
  eq('falling is falling', trendRead(days([3.5, 3.0, 2.6, 2.2, 1.8])).dir, 'falling');
  eq('and a flat book is flat', trendRead(days([2.0, 2.02, 1.98, 2.01, 2.0])).dir, 'flat');
  // A DIRECTION IS NOT CLAIMED OFF TOO FEW READINGS.
  const thin = trendRead(days([2.1, 3.5]));
  eq('two readings claim nothing', thin.available, false);
  ok('and say how many are needed', /2 of 5 daily readings/.test(thin.note));
  eq('the minimum is a named constant', TREND_MIN, 5);
  // Today's live ratio wins over the last stored close — the stored row is this morning's.
  eq('today overrides the last stored reading', trendRead(days([2.1, 2.2, 2.3, 2.4, 2.5]), 3.5).to, 3.5);
}

// ── THRESHOLDS ARE CONFIGURABLE, AND THE READING SAYS WHICH IT USED ─────────
// Judgement calls calibrated to a ~$210k personal account, not universal constants.
{
  eq('the shipped defaults are the specified ones',
     [EXPOSURE_LIMITS.targetLo, EXPOSURE_LIMITS.targetHi, EXPOSURE_LIMITS.ceiling,
      EXPOSURE_LIMITS.singleCap, EXPOSURE_LIMITS.thetaPctPerDay],
     [1.1, 1.4, 2.0, 0.5, 0.25]);
  const loose = bookExposure({ rows: ROWS, greeks: GREEKS, underlyings: SPOTS, nlv: NLV,
                               limits: { ceiling: 5.0, singleCap: 3.0, thetaPctPerDay: 1.0 }, now: NOW });
  ok('a raised ceiling is respected', loose.state !== 'OVER CEILING');
  eq('and no cap breach is reported', loose.overCap.length, 0);
  eq('the reading carries the limits it was judged against', loose.limits.ceiling, 5.0);

  // The bands, walked.
  const at = (dn) => bookExposure({ rows: [{ symbol: 'SPY', qty: dn / 100, livePrice: 100 }],
                                    greeks: {}, underlyings: { SPY: 100 }, nlv: 100000, now: NOW }).state;
  eq('at 0.8× the book is conservative', at(80000), 'CONSERVATIVE');
  eq('at 1.2× it is on target', at(120000), 'TARGET');
  eq('at 1.7× it is elevated', at(170000), 'ELEVATED');
  eq('and past 2.0× it is over the ceiling', at(250000), 'OVER CEILING');
}

// ── NOTHING TO MEASURE IS NOT A ZERO ────────────────────────────────────────
{
  eq('an empty book renders nothing', bookExposure({ rows: [], nlv: NLV }).available, false);
  const noNlv = bookExposure({ rows: ROWS, greeks: GREEKS, underlyings: SPOTS, nlv: null, now: NOW });
  eq('without an account value there is no ratio', noNlv.ratio, null);
  eq('and no state to claim', noNlv.state, 'UNKNOWN');
  ok('but the delta-notional is still a real number', noNlv.deltaNotional > 0);
  // Closed rows are not carried.
  eq('a closed row is not in the book',
     bookExposure({ rows: [{ symbol: 'AAPL', qty: 0, livePrice: 200 }], nlv: NLV }).available, false);
}

// ── THE GREEKS ARE THE EXCHANGE'S, NOT OURS ─────────────────────────────────
// A modelled delta carries an assumed rate and an assumed dividend and turns a summing exercise
// into a modelling one. CBOE publishes delta, gamma, theta and vega per contract on the same feed
// this board already reads for the gamma walls.
{
  const payload = { timestamp: '2026-09-10 20:05:00', data: { current_price: 709, options: [
    { option: 'QQQ261016C00730000', delta: 0.3375, gamma: 0.009, theta: -0.2028, vega: 0.8163, iv: 0.1812, open_interest: 19409, bid: 8.67, ask: 8.74, theo: 8.713 },
    // Zero open interest, and deep out of the band — parseCboe drops both, and both can be held.
    { option: 'QQQ261016C00900000', delta: 0.0011, gamma: 0.0, theta: -0.0002, vega: 0.01, iv: 0.32, open_interest: 0, bid: 0.01, ask: 0.03, theo: 0.02 },
    { option: 'QQQ261016P00600000', delta: -0.03, gamma: 0.001, theta: -0.04, vega: 0.2, iv: 0.28, open_interest: 500 },
  ] } };
  const all = pickCboeGreeks(payload);
  eq('every contract comes back when none is named', Object.keys(all.greeks).length, 3);
  // A POSITION DOES NOT STOP EXISTING BECAUSE NOBODY ELSE IS IN IT. parseCboe drops zero open
  // interest and anything outside the strike band; both are right for measuring the market's
  // gamma and wrong for looking up a contract someone holds.
  ok('a zero-open-interest contract is kept', !!all.greeks['QQQ|2026-10-16|C|900']);
  ok('and so is one far outside the band', all.greeks['QQQ|2026-10-16|C|900'].delta === 0.0011);
  const one = pickCboeGreeks(payload, ['QQQ|2026-10-16|C|730']);
  eq('naming a contract returns only it', Object.keys(one.greeks), ['QQQ|2026-10-16|C|730']);
  eq('with all four greeks', [one.greeks['QQQ|2026-10-16|C|730'].delta, one.greeks['QQQ|2026-10-16|C|730'].gamma,
      one.greeks['QQQ|2026-10-16|C|730'].theta, one.greeks['QQQ|2026-10-16|C|730'].vega],
     [0.3375, 0.009, -0.2028, 0.8163]);
  eq('the underlying comes with them', one.spot, 709);
  eq('and the stamp, because a risk number without one cannot be checked', one.asOf, '2026-09-10T20:05:00Z');
  eq('a put keeps its negative delta', all.greeks['QQQ|2026-10-16|P|600'].delta, -0.03);
  eq('an empty payload yields nothing rather than a zero', pickCboeGreeks({ data: { options: [] } }), null);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
