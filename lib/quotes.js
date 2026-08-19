// quotes.js — the data spine. One normalized shape, honest stale flags.
// Every downstream feature (Pre-Read, dashboard grid) reads THIS, never a raw
// provider. Sources: Yahoo (equities/indices/oil, keyless — see yahoo.js) and
// FRED (yields/OAS — see fred.js). No plan-gated providers, no per-feed keys.

import { fredLatest, fredLatest2, fredSeries } from './fred.js';
import { benchmark, BENCH_BANDS } from './benchmarks.js';
import { yahooChart, yahooPrePost, yahooTrend, yahooIntradayLast, yahooDailyMap } from './yahoo.js';
import { marketState } from './sessions.js';
import { tvQuote } from './tradingview.js';

// How stale (minutes) before we flag a print as not-live.
const STALE_MIN = 20;

// ---- normalized quote shape ----
// { sym, price, prevClose, changePct, ma50, ma200, dayLow, dayHigh, ts, stale, src }
function shape(sym, o = {}) {
  const ts = o.ts ?? null;
  const stale = ts ? (Date.now() / 1000 - ts) > STALE_MIN * 60 : true;
  const price = o.price ?? null, prevClose = o.prevClose ?? null, changePct = o.changePct ?? null;

  // Prior-close coherence assertion. A price BELOW its prior close cannot carry a positive
  // day-change — if it does, the % was computed against the wrong baseline (wrong session,
  // holiday, or a mis-aligned bar). Flag it here so the renderer suppresses the % rather
  // than publishing a contradiction. Tolerance guards float noise on a flat print.
  let pctSuspect = false;
  if (price != null && prevClose != null && changePct != null) {
    const diff = price - prevClose;
    if (Math.abs(diff) > 1e-9 && Math.abs(changePct) > 0.005 && Math.sign(diff) !== Math.sign(changePct)) {
      pctSuspect = true;
    }
  }

  return {
    sym, price, prevClose, changePct,
    ma50:      o.ma50      ?? null,
    ma200:     o.ma200     ?? null,
    dayLow:    o.dayLow    ?? null,
    dayHigh:   o.dayHigh   ?? null,
    ts, stale, pctSuspect,
    src: o.src ?? 'unknown',
  };
}

// ---- Yahoo batch (primary for equities/indices) ----
// One request per symbol (Yahoo's chart endpoint is single-symbol), lightly
// throttled — mirrors api/prices.js. Each response also carries the closes used
// to compute ma50/ma200, so structure() gets real MAs.
async function yahooBatch(syms) {
  const out = {};
  for (let i = 0; i < syms.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 120));
    const c = await yahooChart(syms[i]);
    out[syms[i]] = c ? shape(syms[i], { ...c, src: 'yahoo' })
                     : shape(syms[i], { src: 'miss' });
  }
  return out;
}

// ---- Oil via Yahoo futures (CL=F / BZ=F) — keyless, fills the FMP gap ----
// The "one real data gap" from the handoff is already covered in-repo by the
// same Yahoo endpoint api/indicators.js uses for WTI. No OIL_KEY, no paid feed.
async function oilQuote(symbol, label) {
  const c = await yahooChart(symbol, { range: '5d' });
  return c
    ? shape(label, { price: c.price, prevClose: c.prevClose, changePct: c.changePct, ts: c.ts, src: 'yahoo-oil' })
    : shape(label, { src: 'oil-miss' });
}

// ---- public API of the spine ----
export async function getQuotes(syms, { prepost = false } = {}) {
  const map = await yahooBatch(syms);
  // Guarantee a row for every requested symbol, even on miss (stale/null, not absent).
  const rows = syms.map(s => map[s] ?? shape(s, { src: 'miss' }));

  // P0.1 — intraday rescue for OPEN-but-stale prints. The daily-bar endpoint can serve a
  // settled prior close for HKEX (and other keyless-delayed exchanges), which shows an open
  // market as a dark, stale prior-close card. For any symbol whose exchange is open yet whose
  // print is older than the stale threshold, refetch the 5-minute series and overlay the last
  // real bar when it is genuinely fresher. Safe no-op when the intraday feed is also stale.
  await Promise.all(rows.map(async (row) => {
    if (!row || row.price == null) return;
    if (marketState(row.sym) !== 'open') return;                    // only rescue live sessions
    const ageMin = row.ts != null ? (Date.now() / 1000 - row.ts) / 60 : Infinity;
    if (ageMin <= STALE_MIN) return;                                // already live enough
    const intra = await yahooIntradayLast(row.sym);
    if (intra && intra.ts && (row.ts == null || intra.ts > row.ts)) {
      row.price = intra.price ?? row.price;
      row.ts = intra.ts;
      row.stale = (Date.now() / 1000 - intra.ts) > STALE_MIN * 60;
      if (intra.dayLow != null)  row.dayLow  = intra.dayLow;
      if (intra.dayHigh != null) row.dayHigh = intra.dayHigh;
      if (row.prevClose) row.changePct = ((row.price - row.prevClose) / row.prevClose) * 100;
      row.src = 'yahoo-intraday';
    }
  }));

  // Optional extended-hours (pre/post-market) overlay — used for the US Pre-Read, which
  // fires pre-open when the regular print is a stale prior close but pre-market is live.
  // Attaches q.ext = { price, changePct vs last regular close, ts, stale }; null-safe.
  if (prepost) {
    await Promise.all(rows.map(async (row) => {
      const pp = await yahooPrePost(row.sym);
      if (pp && pp.base) {
        let nyH = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false })
          .formatToParts(new Date(pp.ts * 1000)).find(p => p.type === 'hour')?.value, 10);
        if (nyH === 24) nyH = 0;
        row.ext = {
          price: pp.price,
          changePct: +(((pp.price - pp.base) / pp.base) * 100).toFixed(2),
          ts: pp.ts,
          stale: (Date.now() / 1000 - pp.ts) > STALE_MIN * 60,
          session: nyH < 12 ? 'pre' : 'post',   // pre-market vs after-hours (by the bar's ET hour)
        };
      }
    }));
  }
  return rows;
}

// Debasement/stagflation regime read from gold+BTC co-movement, gated on DXY / real yield
// / credit. Auditable: returns the driving input directions alongside the label.
function classifyDebasement({ gold, btc, dxy, realYield, oas, breakeven }) {
  const dir = d => d == null ? null : d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  const g5 = dir(gold?.chg5d), b5 = dir(btc?.chg5d);   // headline from the 5d window (not 1d — avoids daily whipsaw)
  const dxyDir = dir(dxy?.delta), ryDir = dir(realYield?.deltaBps);
  const oasWidening = oas?.deltaBps != null && oas.deltaBps > 0;
  const oasCalm = oas?.value != null && oas.value < 3.0 && !oasWidening;
  // P0.2 — the breakeven (inflation-expectations) leg is what a gold bid needs to BE debasement.
  // Flat within ±1bp = the bid is not explained by rising inflation expectations.
  const beDir = breakeven?.deltaBps == null ? null : (Math.abs(breakeven.deltaBps) <= 1 ? 'flat' : breakeven.deltaBps > 0 ? 'up' : 'down');

  const realHigh = realYield?.value != null && realYield.value >= 2.0;   // restrictive 10Y real

  let label;
  if (g5 === 'up' && b5 === 'up')          label = (dxyDir !== 'up' && oasCalm) ? 'Debasement bid (liquidity)' : 'Fiat distrust (warning)';
  else if (g5 === 'down' && b5 === 'down') label = realHigh
    ? 'Deleveraging / dash-for-cash (real yields restrictive)'
    : 'Deleveraging / dash-for-cash';
  else                                     label = 'n/a — no regime signal';

  // P0.2 — debasement discriminator. A gold bid is only debasement when breakevens confirm it.
  //   gold up + breakevens UP   → keep the debasement/distrust label
  //   gold up + breakevens FLAT → AMBIGUOUS (a 3bp real-yield move can't explain a 3.8% gold move)
  //   gold up + breakevens DOWN → a real-yield trade, not debasement
  // This matches the gold-pair check the tape-regime card already runs, so the two agree.
  if ((label === 'Debasement bid (liquidity)' || label === 'Fiat distrust (warning)') && g5 === 'up' && beDir) {
    if (beDir === 'flat')      label = 'AMBIGUOUS — gold up, breakevens flat (bid unexplained)';
    else if (beDir === 'down') label = 'Real-yield trade, not debasement (gold up, breakevens down)';
  }

  // Structural sanity: a "debasement bid" while both assets sit below both MAs isn't credible.
  const maPos = f => { if (f?.value == null || f?.ma50 == null || f?.ma200 == null) return null;
    const a = f.value > f.ma50, b = f.value > f.ma200;
    return a && b ? 'above both' : !a && !b ? 'below both' : (f.value > f.ma200 ? 'below 50d' : 'below 200d'); };
  const gMa = maPos(gold), bMa = maPos(btc);
  if (label === 'Debasement bid (liquidity)' && gMa === 'below both' && bMa === 'below both')
    label = 'Debasement bid — UNCONFIRMED (both below 50/200d)';

  // ── Classifier/input coherence assertion ───────────────────────────────────
  // The label is computed from the 5d window (deliberate — a 1d classifier whipsaws), but the
  // panel shows 1d deltas beneath it. When the two windows disagree the card reads as a
  // contradiction: e.g. a "distrust/debasement" label (both 5d UP) sitting above two red 1d
  // arrows. Rather than silently render that, detect it and say so. Also catches the harder
  // failure — a label whose direction simply does not match its own inputs.
  const g1 = dir(gold?.chg1d), b1 = dir(btc?.chg1d);
  const impliedUp   = /Debasement|Fiat distrust/i.test(label);
  const impliedDown = /Deleveraging/i.test(label);
  let mismatch = null;
  if (impliedUp && g1 === 'down' && b1 === 'down') {
    mismatch = `⚠ classifier/input mismatch — label reads risk-assets-up (5d) while gold ${gold?.chg1d}% and BTC ${btc?.chg1d}% are both DOWN on the day`;
  } else if (impliedDown && g1 === 'up' && b1 === 'up') {
    mismatch = `⚠ classifier/input mismatch — label reads deleveraging (5d) while gold +${gold?.chg1d}% and BTC +${btc?.chg1d}% are both UP on the day`;
  } else if (impliedUp && (g5 === 'down' || b5 === 'down')) {
    mismatch = '⚠ classifier/input mismatch — label implies both risk assets rising, but a 5d input is negative';
  } else if (impliedDown && (g5 === 'up' || b5 === 'up')) {
    mismatch = '⚠ classifier/input mismatch — label implies both risk assets falling, but a 5d input is positive';
  }
  // A 1d/5d divergence that is NOT a contradiction still gets noted, so the reader knows why
  // the arrows beneath the label may point the other way.
  const windowSplit = (g1 && b1 && g5 && b5 && (g1 !== g5 || b1 !== b5))
    ? `1d and 5d windows disagree (gold ${g1}/${g5}, BTC ${b1}/${b5}) — label is the 5d read`
    : null;

  return {
    label, mismatch, windowSplit,
    realYieldHigh: realHigh,
    windows: {
      gold: { d1: dir(gold?.chg1d), d5: g5, d20: dir(gold?.chg20d), ma: gMa, offHi: gold?.pctOffHi },
      btc:  { d1: dir(btc?.chg1d),  d5: b5, d20: dir(btc?.chg20d),  ma: bMa, offHi: btc?.pctOffHi },
    },
    inputs: { dxy: dxyDir, realYield: ryDir, oas: oasCalm ? 'calm' : oasWidening ? 'widening' : 'stable' },
  };
}

export async function getMacro() {
  const [wti, brent, dgs2, dgs10, dgs30, oas, dxyC, goldC, btcC, dfii10, t10yie, fwd5y5y, termPrem, moveC, ovxC, oasHist, dgs30Hist, dgs5] = await Promise.all([
    oilQuote('CL=F', 'wti'), oilQuote('BZ=F', 'brent'),
    fredLatest2('DGS2'), fredLatest2('DGS10'), fredLatest2('DGS30'), fredLatest2('BAMLH0A0HYM2'),
    yahooChart('DX-Y.NYB', { range: '5d' }),   // ICE DXY (keyless), intraday
    yahooTrend('GC=F'), yahooTrend('BTC-USD'),      // 1y series → 1d/5d/20d + MA + 52w-hi
    fredLatest2('DFII10'), fredLatest2('T10YIE'),        // 10Y real yield + breakeven
    fredLatest2('T5YIFR'),   // 5y5y forward breakeven — the market's LONG-RUN inflation view
    fredLatest2('THREEFYTP10'),  // ACM 10Y term premium — MODEL ESTIMATE, direction/trend only
    yahooChart('^MOVE', { range: '5d' }), yahooChart('^OVX', { range: '5d' }),  // bond/oil vol
    fredSeries('BAMLH0A0HYM2', 756), // ~3Y — trend windows + the P1.2 percentile (FRED caps OAS at 3Y)
    fredSeries('DGS30', 1260),       // ~5Y — Section E 20d change + the P1.2 30Y percentile
    fredLatest2('DGS5'),             // Section E — 5s30s slope (long-end steepening)   // real prior prints — backs the OAS 2-D gate's direction
  ]);

  // FRED daily field: value + date + prior obs → day-over-day delta in bps (source-native,
  // so the delta is a true 1-session move, not "since we last fetched"). `src` = the FRED
  // series (audit trail on hover). Keeps `.value`/`.date` for existing consumers.
  const yf = (o, name, src) => ({
    value: o.value, date: o.date, prev: o.prev, prevDate: o.prevDate,
    deltaBps: (o.value != null && o.prev != null) ? Math.round((o.value - o.prev) * 100) : null,
    name, src, cadence: 'daily',
  });
  // Yahoo intraday field: keep `.price`/`.stale` (existing consumers) + add delta vs prevClose.
  const of = (q, name, src) => ({
    ...q, value: q?.price ?? null,
    delta: (q?.price != null && q?.prevClose != null) ? +(q.price - q.prevClose).toFixed(2) : null,
    name, src, cadence: 'intraday',
  });

  const us2y = yf(dgs2, 'US 2Y', 'DGS2');
  const us10y = yf(dgs10, 'US 10Y', 'DGS10');
  const us30y = { ...yf(dgs30, 'US 30Y', 'DGS30'), series: dgs30Hist,
    benchmark: benchmark(dgs30.value, dgs30Hist, { byPct: true, window: '5Y' }) };
  const us5y = yf(dgs5, 'US 5Y', 'DGS5');
  // Section E — long-end steepening is the FUNDING-STRESS shape, distinct from a parallel
  // hawkish shift. 5s30s is the cleaner read on that than any auction internal.
  const fives30s = (dgs30.value != null && dgs5.value != null) ? Math.round((dgs30.value - dgs5.value) * 100) : null;
  const fives30sPrev = (dgs30.prev != null && dgs5.prev != null) ? Math.round((dgs30.prev - dgs5.prev) * 100) : null;
  // P3 — reconcile the OAS latest print against its OWN 90-obs series. `fredLatest2` and
  // `fredSeries` are two independent fetches of the SAME FRED series; a transient failure of
  // just one made the three region tabs disagree — US read "UNKNOWN — no prior print" while
  // Asia/EU read "CALM · WIDENING" off identical data, because only the US invocation's
  // latest-fetch had blipped. Backfill value/date/prev from whichever source succeeded so every
  // region resolves the identical gate. It is only genuinely UNKNOWN when BOTH fetches fail —
  // and then all three regions agree on unknown.
  const oasReconciled = (() => {
    const hist = Array.isArray(oasHist) ? oasHist : [];
    if (oas.value != null) {
      // Latest fetch is good; borrow a prior from the series only if it lacks one.
      if (oas.prev == null && hist.length >= 2) {
        const prior = hist[hist.length - 2];
        return { ...oas, prev: prior.value, prevDate: prior.date };
      }
      return oas;
    }
    // Latest fetch blipped — rebuild value + prior from the series' last two real points.
    if (hist.length >= 1) {
      const last = hist[hist.length - 1], prior = hist[hist.length - 2];
      return { value: last.value, date: last.date, prev: prior?.value ?? null, prevDate: prior?.date ?? null };
    }
    return oas;   // both empty → genuinely unknown, and consistently so across regions
  })();
  const oasF = { ...yf(oasReconciled, 'HY OAS', 'BAMLH0A0HYM2'), note: 'FRED daily — last hard print', series: oasHist,
    benchmark: benchmark(oasReconciled.value, oasHist, { bands: BENCH_BANDS.oas, window: '3Y' }) };
  const wtiF = of(wti, 'WTI', 'CL=F');
  const brentF = of(brent, 'Brent', 'BZ=F');
  const dxy = dxyC
    ? { value: dxyC.price, price: dxyC.price, prevClose: dxyC.prevClose, ts: dxyC.ts, changePct: dxyC.changePct,
        delta: (dxyC.price != null && dxyC.prevClose != null) ? +(dxyC.price - dxyC.prevClose).toFixed(2) : null,
        name: 'DXY', src: 'DX-Y.NYB', cadence: 'intraday' }
    : { value: null, name: 'DXY', src: 'DX-Y.NYB', cadence: 'intraday' };

  const twos10s     = (dgs10.value != null && dgs2.value != null) ? Math.round((dgs10.value - dgs2.value) * 100) : null;
  const twos10sPrev = (dgs10.prev  != null && dgs2.prev  != null) ? Math.round((dgs10.prev  - dgs2.prev)  * 100) : null;

  // ── Regime inputs (debasement/stagflation read) ──
  const gold = of(goldC, 'Gold', 'GC=F');
  const btc = of(btcC, 'BTC', 'BTC-USD');
  const realYield = yf(dfii10, '10Y Real', 'DFII10');
  const breakeven = yf(t10yie, '10Y BE', 'T10YIE');
  // 5y5y forward: strips the near-term oil passthrough out of the inflation read, so an
  // oil-driven yield move can be told apart from a genuine repricing of long-run inflation.
  const fwdBreakeven = yf(fwd5y5y, '5y5y fwd BE', 'T5YIFR');
  // Section B — ACM term premium. A model ESTIMATE, not a market price: only its direction
  // feeds the classifier, never the level.
  const termPremium = yf(termPrem, 'ACM 10Y term premium', 'THREEFYTP10');
  const move = of(moveC, 'MOVE', '^MOVE');
  const ovx = of(ovxC, 'OVX', '^OVX');
  const regimeSignal = classifyDebasement({ gold, btc, dxy, realYield, oas: oasF, breakeven });

  // ── Sanity / relationship checks: TAG suspect fields (so the frontend renders them
  // flagged, not as a clean number) + collect a banner. ──
  const sanity = [];
  const band = (field, lo, hi) => { const v = field?.value; if (v != null && (v < lo || v > hi)) { field.suspect = true; sanity.push(`${field.name} out of band: ${v}`); } };
  band(wtiF, 20, 150); band(brentF, 20, 150); band(dxy, 80, 120); band(oasF, 1, 12);
  band(us2y, 0, 10); band(us10y, 0, 10); band(us30y, 0, 10);
  if (twos10s != null && (twos10s < -200 || twos10s > 300)) sanity.push(`2s10s out of band: ${twos10s}`);
  const brentWtiSpread = (brentF.value != null && wtiF.value != null) ? +(brentF.value - wtiF.value).toFixed(2) : null;
  if (brentWtiSpread != null && brentWtiSpread < 0) { brentF.suspect = true; sanity.push(`⚠ Brent < WTI (${brentWtiSpread}) — BZ=F feed suspect, flagged not rendered clean`); }
  else if (brentWtiSpread != null && brentWtiSpread > 12) sanity.push(`Brent−WTI spread ${brentWtiSpread} > $12`);
  if (twos10s != null && us10y.value != null && us2y.value != null) {
    const check = Math.round((us10y.value - us2y.value) * 100);
    if (Math.abs(twos10s - check) > 3) sanity.push(`2s10s assertion failed (${twos10s} vs 10Y−2Y ${check})`);
  }
  // Fisher identity: 10Y nominal ≈ 10Y real + 10Y breakeven — flag if >10bps apart (catches
  // a stale/mis-mapped DFII10 or T10YIE).
  if (us10y.value != null && realYield.value != null && breakeven.value != null) {
    const implied = realYield.value + breakeven.value;
    const gapBps = Math.round((us10y.value - implied) * 100);
    if (Math.abs(gapBps) > 10) sanity.push(`Fisher identity off: 10Y ${us10y.value}% vs real+BE ${implied.toFixed(2)}% (${gapBps}bps) — check DFII10/T10YIE`);
  }

  return {
    wti: wtiF, brent: brentF, us2y, us10y, us30y, oas: oasF, dxy,
    twos10s, twos10sDeltaBps: (twos10s != null && twos10sPrev != null) ? twos10s - twos10sPrev : null,
    brentWtiSpread, sanity,
    gold, btc, realYield, breakeven, fwdBreakeven, termPremium, move, ovx, regimeSignal,
    us5y, fives30s, fives30sDeltaBps: (fives30s != null && fives30sPrev != null) ? fives30s - fives30sPrev : null,
  };
}

// ---- Korea-local stress bundle (Asia only) ----
// A local credit/fear channel distinct from the global OAS read. Two tells:
//   usdkrw — won direction (Yahoo KRW=X, keyless)              → foreign-flow proxy
//   vkospi — V-KOSPI FUTURES (TradingView KRX:VKI1!, keyless)  → tradeable fear gauge
// VKOSPI reads the FUTURES (VKI1!) — the tradeable contract — not the spot index
// (which sits in heavy backwardation to the future during a vol spike). No keyless feed
// lists the future except TradingView's widget endpoint (best-effort; see tradingview.js).
// (CSOP 7709 units were retired — no reliable keyless source and low marginal signal.)
// ── Cross-asset coverage (Stage 3A) ──────────────────────────────────────────
// The set watched daily, grouped by what each group answers. Every row carries value +
// 1D delta + direction, and direction is only set when a prior close exists (Stage 1A).
export const CROSS_ASSETS = {
  rates:     { label: 'Rate-sensitive / flight', rows: [
    { sym: 'TLT',  name: 'TLT'  }, { sym: 'IEF',  name: 'IEF'  },
    { sym: 'XLU',  name: 'XLU'  }, { sym: 'XLRE', name: 'XLRE' }] },
  cyclical:  { label: 'Cyclical / defensive / oil', rows: [
    { sym: 'XLE',  name: 'XLE'  }, { sym: 'XLP',  name: 'XLP'  }] },
  volCredit: { label: 'Vol / credit proxies', rows: [
    { sym: '^VIX',  name: 'VIX'  }, { sym: '^MOVE', name: 'MOVE' },
    { sym: '^OVX',  name: 'OVX'  }, { sym: 'HYG',   name: 'HYG'  }] },
  // Breadth ladder (P5) + the equity legs the regime classifier needs (P0.1). SMH→HYG is a
  // FIXED order, widest-beta to narrowest: monotonic + wide = one theme, not participation.
  breadth:   { label: 'Breadth ladder (SMH → HYG)', rows: [
    { sym: 'SMH', name: 'SMH' }, { sym: 'QQQ', name: 'QQQ' },
    { sym: 'SPY', name: 'SPY' }, { sym: 'IWM', name: 'IWM' },
    { sym: 'GLD', name: 'GLD' }, { sym: 'TLT', name: 'TLT' }] },
  // P4 — FX legs. DXY is 57.6% EUR and 13.6% JPY, so when those two legs pull in OPPOSITE
  // directions the index understates dollar strength against everything that is not the yen.
  // The legs are first-class rows; DXY is demoted to a summary. USD/KRW is Gate 2 in the
  // two-gate framework and belongs here regardless.
  fx:        { label: 'FX legs (DXY is a blend — read the legs)', rows: [
    { sym: 'EURUSD=X', name: 'EUR/USD' }, { sym: 'JPY=X', name: 'USD/JPY' },
    { sym: 'KRW=X', name: 'USD/KRW' }, { sym: 'DX-Y.NYB', name: 'DXY (summary)' }] },
};

// EUR and JPY diverging in SIGN is precisely when DXY misleads — flag it explicitly rather
// than leaving the reader to infer it from the index level.
export function fxDivergence(fxRows = []) {
  const eur = fxRows.find(r => r.sym === 'EURUSD=X');
  const jpy = fxRows.find(r => r.sym === 'JPY=X');
  if (eur?.changePct == null || jpy?.changePct == null) {
    return { available: false, note: 'FX legs incomplete — DXY reliability not assessed' };
  }
  // EUR/USD up = dollar WEAKER vs EUR. USD/JPY up = dollar STRONGER vs JPY. So to compare
  // "dollar direction" the EUR leg must be inverted before the signs are compared.
  const usdVsEur = -eur.changePct, usdVsJpy = jpy.changePct;
  const diverging = Math.sign(usdVsEur) !== Math.sign(usdVsJpy)
    && Math.abs(usdVsEur) > 0.05 && Math.abs(usdVsJpy) > 0.05;
  return {
    available: true, diverging, usdVsEur: +usdVsEur.toFixed(2), usdVsJpy: +usdVsJpy.toFixed(2),
    note: diverging
      ? `⚠ DXY unreliable today — the dollar is ${usdVsEur > 0 ? 'stronger' : 'weaker'} vs EUR (${usdVsEur >= 0 ? '+' : ''}${usdVsEur.toFixed(2)}%) but ${usdVsJpy > 0 ? 'stronger' : 'weaker'} vs JPY (${usdVsJpy >= 0 ? '+' : ''}${usdVsJpy.toFixed(2)}%). The legs offset inside the index, so DXY understates the move against everything that is not the yen.`
      : `DXY representative — EUR and JPY legs point the same way (USD ${usdVsEur >= 0 ? '+' : ''}${usdVsEur.toFixed(2)}% vs EUR, ${usdVsJpy >= 0 ? '+' : ''}${usdVsJpy.toFixed(2)}% vs JPY).`,
  };
}

// One cross-asset row: value, 1D delta, direction (null without a prior close).
function crossRow(sym, name, c) {
  if (!c || c.price == null) return { sym, name, price: null, dir: null, note: 'no print' };
  const delta = c.prevClose != null ? +(c.price - c.prevClose).toFixed(2) : null;
  const dir = c.changePct == null ? null
            : c.changePct > 0.05 ? 'rising' : c.changePct < -0.05 ? 'falling' : 'flat';
  return {
    sym, name, price: c.price, prevClose: c.prevClose ?? null,
    changePct: c.changePct != null ? +c.changePct.toFixed(2) : null,
    delta, dir, basis: '1D', ts: c.ts ?? null,
    note: dir == null ? 'no prior close — direction unavailable' : null,
  };
}

// C1 — VIX term structure (front/spot/back). Fetched together so the three points are one
// internally-consistent snapshot; ^VIX is re-quoted here rather than reused from getCrossAssets
// so the curve can't mix prints from two moments. Keyless Yahoo indices, null-safe.
export async function getVolTerm() {
  const [v9, v, v3] = await Promise.all([
    yahooChart('^VIX9D', { range: '5d' }),
    yahooChart('^VIX',   { range: '5d' }),
    yahooChart('^VIX3M', { range: '5d' }),
  ]);
  const row = (sym, name, c) => (c && c.price != null)
    ? { sym, name, price: +(+c.price).toFixed(2), changePct: c.changePct != null ? +(+c.changePct).toFixed(2) : null, ts: c.ts ?? null }
    : { sym, name, price: null, changePct: null, ts: null };
  return { vix9d: row('^VIX9D', 'VIX9D', v9), vix: row('^VIX', 'VIX', v), vix3m: row('^VIX3M', 'VIX3M', v3) };
}

// P1.2 — 1-year percentile + band for the vol gauges (VIX / MOVE / OVX). Keyed by cross-asset sym
// so assemble can attach each to its row. Null-safe (a missing history just omits the benchmark).
export async function getVolBenchmarks() {
  const defs = [['^VIX', BENCH_BANDS.vix], ['^MOVE', BENCH_BANDS.move], ['^OVX', BENCH_BANDS.ovx]];
  const maps = await Promise.all(defs.map(([sym]) => yahooDailyMap(sym, '1y')));
  const out = {};
  defs.forEach(([sym, bands], i) => {
    const vals = Object.values(maps[i] || {}).filter(Number.isFinite);
    const latest = vals.length ? vals[vals.length - 1] : null;
    out[sym] = latest != null ? benchmark(latest, vals, { bands, window: '1Y' }) : null;
  });
  return out;
}

export async function getCrossAssets() {
  const flat = Object.entries(CROSS_ASSETS).flatMap(([g, { rows }]) => rows.map(r => ({ ...r, group: g })));
  const quotes = await Promise.all(flat.map(r => yahooChart(r.sym, { range: '5d' })));
  const out = {};
  for (const [g, { label }] of Object.entries(CROSS_ASSETS)) out[g] = { label, rows: [] };
  flat.forEach((r, i) => out[r.group].rows.push(crossRow(r.sym, r.name, quotes[i])));
  return out;
}

// HYG is the LIVE intraday credit tell: OAS is an end-of-day/T+1 print, so HYG moves first.
// Falling HYG = credit risk being sold now; the daily OAS print tends to follow.
// Divergence beyond this (HYG %chg minus QQQ %chg) is the actionable signal.
export const HYG_QQQ_DIVERGENCE = 1.5;

export function hygCreditTell(hygRow, qqqRow) {
  if (!hygRow || hygRow.dir == null) {
    return { available: false, note: 'HYG — no prior close, direction unavailable' };
  }
  const stressing = hygRow.dir === 'falling';

  // HYG vs QQQ is the real tell. Credit refusing to confirm an equity rally is the case that
  // matters: on 2026-07-31 HYG was −0.06% while QQQ was +1.72%, and QQQ gave back most of the
  // move within 20 minutes. A single HYG print alone would not have surfaced that.
  let divergence = null;
  if (qqqRow?.changePct != null && hygRow.changePct != null) {
    const spread = +(hygRow.changePct - qqqRow.changePct).toFixed(2);
    const alert = Math.abs(spread) >= HYG_QQQ_DIVERGENCE;
    divergence = {
      spread, alert, qqqChangePct: qqqRow.changePct, threshold: HYG_QQQ_DIVERGENCE,
      direction: spread < 0 ? 'credit lagging equities' : 'credit leading equities',
      note: alert
        ? (spread < 0
            ? `HYG ${hygRow.changePct}% vs QQQ ${qqqRow.changePct >= 0 ? '+' : ''}${qqqRow.changePct}% — ${Math.abs(spread)}pp gap: credit is NOT confirming the equity move`
            : `HYG ${hygRow.changePct >= 0 ? '+' : ''}${hygRow.changePct}% vs QQQ ${qqqRow.changePct}% — ${Math.abs(spread)}pp gap: credit firmer than equities`)
        : `HYG vs QQQ ${spread >= 0 ? '+' : ''}${spread}pp — within the ±${HYG_QQQ_DIVERGENCE}pp band, no divergence signal`,
    };
  }

  return {
    available: true, dir: hygRow.dir, changePct: hygRow.changePct, stressing,
    ts: hygRow.ts ?? null, divergence,
    note: stressing
      ? `HYG ${hygRow.changePct}% 1D — credit being sold intraday; leads the EOD OAS print`
      : hygRow.dir === 'rising'
        ? `HYG +${hygRow.changePct}% 1D — credit bid intraday; no live stress signal`
        : `HYG flat 1D — no live credit signal`,
  };
}

export async function getKoreaStress() {
  const [krw, vk, ks, k200] = await Promise.all([
    yahooChart('KRW=X'),
    tvQuote('KRX:VKI1!'),
    yahooChart('^KS11', { range: '5d' }),   // index move → KRX circuit-breaker level
    yahooChart('^KS200', { range: '5d' }),  // KOSPI 200 CASH — sidecar's reference index
  ]);

  return {
    usdkrw: krw ? shape('KRW=X', { ...krw, src: 'yahoo' }) : shape('KRW=X', { src: 'miss' }),
    kospiChangePct: ks?.changePct ?? null,
    // Sidecar triggers off KOSPI-200 FUTURES ±5%. Neither Yahoo nor TradingView's keyless
    // endpoints carry that contract (probed: KRX:K2001!, K200F1!, KS200.KS, … all miss), so
    // we pass the CASH K200 move as an explicitly-labelled proxy and never as a confirmed
    // sidecar. futuresChangePct stays null until a real futures feed exists.
    kospi200: k200 ? { price: k200.price, prevClose: k200.prevClose, changePct: k200.changePct } : null,
    kospi200ChangePct: k200?.changePct ?? null,
    futuresChangePct: null,

    vkospi: vk
      ? { symbol: 'KRX:VKI1!', name: 'V-KOSPI Futures', last: vk.last, changePct: vk.changePct,
          stale: vk.session ? vk.session !== 'market' : false, src: 'tradingview' }
      : { symbol: 'KRX:VKI1!', name: 'V-KOSPI Futures', last: null, changePct: null, stale: true, src: 'miss' },
  };
}
