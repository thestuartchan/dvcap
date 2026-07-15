// quotes.js — the data spine. One normalized shape, honest stale flags.
// Every downstream feature (Pre-Read, dashboard grid) reads THIS, never a raw
// provider. Sources: Yahoo (equities/indices/oil, keyless — see yahoo.js) and
// FRED (yields/OAS — see fred.js). No plan-gated providers, no per-feed keys.

import { fredLatest } from './fred.js';
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
