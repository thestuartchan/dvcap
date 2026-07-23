// quotes.js — the data spine. One normalized shape, honest stale flags.
// Every downstream feature (Pre-Read, dashboard grid) reads THIS, never a raw
// provider. Sources: Yahoo (equities/indices/oil, keyless — see yahoo.js) and
// FRED (yields/OAS — see fred.js). No plan-gated providers, no per-feed keys.

import { fredLatest, fredLatest2 } from './fred.js';
import { yahooChart, yahooPrePost } from './yahoo.js';
import { tvQuote } from './tradingview.js';

// How stale (minutes) before we flag a print as not-live.
const STALE_MIN = 20;

// ---- normalized quote shape ----
// { sym, price, prevClose, changePct, ma50, ma200, dayLow, dayHigh, ts, stale, src }
function shape(sym, o = {}) {
  const ts = o.ts ?? null;
  const stale = ts ? (Date.now() / 1000 - ts) > STALE_MIN * 60 : true;
  return {
    sym,
    price:     o.price     ?? null,
    prevClose: o.prevClose ?? null,
    changePct: o.changePct ?? null,
    ma50:      o.ma50      ?? null,
    ma200:     o.ma200     ?? null,
    dayLow:    o.dayLow    ?? null,
    dayHigh:   o.dayHigh   ?? null,
    ts, stale,
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
        row.ext = {
          price: pp.price,
          changePct: ((pp.price - pp.base) / pp.base) * 100,
          ts: pp.ts,
          stale: (Date.now() / 1000 - pp.ts) > STALE_MIN * 60,
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
  const g = dir(gold?.delta), b = dir(btc?.delta), dxyDir = dir(dxy?.delta), ryDir = dir(realYield?.deltaBps);
  const oasWidening = oas?.deltaBps != null && oas.deltaBps > 0;
  const oasCalm = oas?.value != null && oas.value < 3.0 && !oasWidening;
  let label;
  if (g === 'up' && b === 'up')        label = (dxyDir !== 'up' && oasCalm) ? 'Debasement bid (liquidity)' : 'Fiat distrust (warning)';
  else if (g === 'down' && b === 'down') label = 'Deleveraging / dash-for-cash';
  else                                  label = 'n/a — no regime signal';
  return { label, inputs: { gold: g, btc: b, dxy: dxyDir, realYield: ryDir, oas: oasCalm ? 'calm' : oasWidening ? 'widening' : 'stable' } };
}

export async function getMacro() {
  const [wti, brent, dgs2, dgs10, dgs30, oas, dxyC, goldC, btcC, dfii10, t10yie, moveC, ovxC] = await Promise.all([
    oilQuote('CL=F', 'wti'), oilQuote('BZ=F', 'brent'),
    fredLatest2('DGS2'), fredLatest2('DGS10'), fredLatest2('DGS30'), fredLatest2('BAMLH0A0HYM2'),
    yahooChart('DX-Y.NYB', { range: '5d' }),   // ICE DXY (keyless), intraday
    yahooChart('GC=F', { range: '5d' }), yahooChart('BTC-USD', { range: '5d' }),
    fredLatest2('DFII10'), fredLatest2('T10YIE'),        // 10Y real yield + breakeven
    yahooChart('^MOVE', { range: '5d' }), yahooChart('^OVX', { range: '5d' }),  // bond/oil vol
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
  const oasF = { ...yf(oas, 'HY OAS', 'BAMLH0A0HYM2'), note: 'FRED daily — last hard print' };
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
export async function getKoreaStress() {
  const [krw, vk] = await Promise.all([
    yahooChart('KRW=X'),
    tvQuote('KRX:VKI1!'),
  ]);

  return {
    usdkrw: krw ? shape('KRW=X', { ...krw, src: 'yahoo' }) : shape('KRW=X', { src: 'miss' }),
    vkospi: vk
      ? { symbol: 'KRX:VKI1!', name: 'V-KOSPI Futures', last: vk.last, changePct: vk.changePct,
          stale: vk.session ? vk.session !== 'market' : false, src: 'tradingview' }
      : { symbol: 'KRX:VKI1!', name: 'V-KOSPI Futures', last: null, changePct: null, stale: true, src: 'miss' },
  };
}
