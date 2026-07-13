// quotes.js — the data spine. One normalized shape, honest stale flags.
// Every downstream feature (Pre-Read, dashboard grid) reads THIS, never a raw
// provider. Sources: Yahoo (equities/indices/oil, keyless — see yahoo.js) and
// FRED (yields/OAS — see fred.js). No plan-gated providers, no per-feed keys.

import { fredLatest } from './fred.js';
import { yahooChart } from './yahoo.js';
import { cnbcQuote } from './cnbc.js';
import k7709units from '../../data/korea_7709.json' with { type: 'json' };

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
export async function getQuotes(syms) {
  const map = await yahooBatch(syms);
  // Guarantee a row for every requested symbol, even on miss (stale/null, not absent).
  return syms.map(s => map[s] ?? shape(s, { src: 'miss' }));
}

export async function getMacro() {
  const [wti, brent, dgs2, dgs10, oas] = await Promise.all([
    oilQuote('CL=F', 'wti'), oilQuote('BZ=F', 'brent'),
    fredLatest('DGS2'), fredLatest('DGS10'), fredLatest('BAMLH0A0HYM2'),
  ]);
  return {
    wti, brent,
    us2y:  { ...dgs2,  name: 'US 2Y'  },
    us10y: { ...dgs10, name: 'US 10Y' },
    oas:   { ...oas,   name: 'HY OAS', note: 'FRED daily — last hard print' },
  };
}

// ---- Korea-local stress bundle (Asia only) ----
// A local credit/fear channel distinct from the global OAS read. Three tells:
//   usdkrw — won direction (Yahoo KRW=X, keyless)         → foreign-flow proxy
//   vkospi — KOSPI-200 implied vol (CNBC .KSVKOSPI)       → fear level / peak-roll
//   etf    — CSOP 7709 (2x Hynix) price + UNITS OUTSTANDING time series → deleveraging
// Units outstanding is the real unwind signal but is NOT machine-scrapable (CSOP &
// HKEX both 403 bot-protection), so it's a maintained series in data/korea_7709.json
// (same hand-kept pattern as the calendar). Price comes live from Yahoo; units do not.
export async function getKoreaStress() {
  const [krw, etfPx, vk] = await Promise.all([
    yahooChart('KRW=X'),
    yahooChart('7709.HK', { range: '5d' }),
    cnbcQuote('.KSVKOSPI'),
  ]);

  const vkStale = vk?.ts ? (Date.now() / 1000 - vk.ts) > STALE_MIN * 60 : true;

  return {
    usdkrw: krw ? shape('KRW=X', { ...krw, src: 'yahoo' }) : shape('KRW=X', { src: 'miss' }),
    vkospi: vk
      ? { ...vk, stale: vkStale, src: 'cnbc' }
      : { symbol: '.KSVKOSPI', name: 'VKOSPI', last: null, changePct: null, stale: true, src: 'miss' },
    etf: {
      price: etfPx ? shape('7709.HK', { ...etfPx, src: 'yahoo' }) : shape('7709.HK', { src: 'miss' }),
      units: k7709units,   // maintained time series: [{ date, units, nav?, aum? }] chrono
    },
  };
}
