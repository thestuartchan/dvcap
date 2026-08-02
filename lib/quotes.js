// quotes.js — the data spine. One normalized shape, honest stale flags.
// Every downstream feature (Pre-Read, dashboard grid) reads THIS, never a raw
// provider. Sources: Yahoo (equities/indices/oil, keyless — see yahoo.js) and
// FRED (yields/OAS — see fred.js). No plan-gated providers, no per-feed keys.

import { fredLatest, fredLatest2, fredSeries } from './fred.js';
import { yahooChart, yahooPrePost, yahooTrend } from './yahoo.js';
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
function classifyDebasement({ gold, btc, dxy, realYield, oas }) {
  const dir = d => d == null ? null : d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  const g5 = dir(gold?.chg5d), b5 = dir(btc?.chg5d);   // headline from the 5d window (not 1d — avoids daily whipsaw)
  const dxyDir = dir(dxy?.delta), ryDir = dir(realYield?.deltaBps);
  const oasWidening = oas?.deltaBps != null && oas.deltaBps > 0;
  const oasCalm = oas?.value != null && oas.value < 3.0 && !oasWidening;

  const realHigh = realYield?.value != null && realYield.value >= 2.0;   // restrictive 10Y real

  let label;
  if (g5 === 'up' && b5 === 'up')          label = (dxyDir !== 'up' && oasCalm) ? 'Debasement bid (liquidity)' : 'Fiat distrust (warning)';
  else if (g5 === 'down' && b5 === 'down') label = realHigh
    ? 'Deleveraging / dash-for-cash (real yields restrictive)'
    : 'Deleveraging / dash-for-cash';
  else                                     label = 'n/a — no regime signal';

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
  const [wti, brent, dgs2, dgs10, dgs30, oas, dxyC, goldC, btcC, dfii10, t10yie, moveC, ovxC, oasHist] = await Promise.all([
    oilQuote('CL=F', 'wti'), oilQuote('BZ=F', 'brent'),
    fredLatest2('DGS2'), fredLatest2('DGS10'), fredLatest2('DGS30'), fredLatest2('BAMLH0A0HYM2'),
    yahooChart('DX-Y.NYB', { range: '5d' }),   // ICE DXY (keyless), intraday
    yahooTrend('GC=F'), yahooTrend('BTC-USD'),      // 1y series → 1d/5d/20d + MA + 52w-hi
    fredLatest2('DFII10'), fredLatest2('T10YIE'),        // 10Y real yield + breakeven
    yahooChart('^MOVE', { range: '5d' }), yahooChart('^OVX', { range: '5d' }),  // bond/oil vol
    fredSeries('BAMLH0A0HYM2', 30),   // real prior prints — backs the OAS 2-D gate's direction
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
  const us30y = yf(dgs30, 'US 30Y', 'DGS30');
  const oasF = { ...yf(oas, 'HY OAS', 'BAMLH0A0HYM2'), note: 'FRED daily — last hard print', series: oasHist };
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
  const move = of(moveC, 'MOVE', '^MOVE');
  const ovx = of(ovxC, 'OVX', '^OVX');
  const regimeSignal = classifyDebasement({ gold, btc, dxy, realYield, oas: oasF });

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
    gold, btc, realYield, breakeven, move, ovx, regimeSignal,
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
};

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
export function hygCreditTell(hygRow) {
  if (!hygRow || hygRow.dir == null) {
    return { available: false, note: 'HYG — no prior close, direction unavailable' };
  }
  const stressing = hygRow.dir === 'falling';
  return {
    available: true, dir: hygRow.dir, changePct: hygRow.changePct, stressing,
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
