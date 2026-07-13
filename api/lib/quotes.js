// quotes.js — the data spine. One normalized shape, provider fallback, honest stale flags.
// Every downstream feature (Pre-Read, dashboard grid) reads THIS, never a raw provider.

const FMP_KEY  = process.env.FMP_KEY;
const FRED_KEY = process.env.FRED_KEY;

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
    dayLow:    o.dayLow     ?? null,
    dayHigh:   o.dayHigh    ?? null,
    ts, stale,
    src: o.src ?? 'unknown',
  };
}

// ---- FMP batch (primary for equities/indices) ----
async function fmpBatch(syms) {
  if (!FMP_KEY || !syms.length) return {};
  const url = `https://financialmodelingprep.com/api/v3/quote/${syms.join(',')}?apikey=${FMP_KEY}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return {};
    const rows = await r.json();
    const out = {};
    for (const q of rows) {
      out[q.symbol] = shape(q.symbol, {
        price: q.price, prevClose: q.previousClose, changePct: q.changesPercentage,
        ma50: q.priceAvg50, ma200: q.priceAvg200,
        dayLow: q.dayLow, dayHigh: q.dayHigh, ts: q.timestamp, src: 'fmp',
      });
    }
    return out;
  } catch { return {}; }
}

// ---- Oil via OilPriceAPI-style public JSON (fills the FMP commodity gap) ----
// Swap the URL for your chosen source; keep the normalized return.
async function oilQuote(which) {
  // Placeholder: wire to your preferred oil JSON endpoint. Returns { price, ts }.
  // Kept isolated so the one genuinely-gappy feed can be swapped without touching callers.
  try {
    const r = await fetch(`https://api.oilpriceapi.com/v1/prices/latest?blend=${which}`,
      { headers: { Authorization: `Token ${process.env.OIL_KEY || ''}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return shape(which, { src: 'oil-fail' });
    const j = await r.json();
    return shape(which, { price: j?.data?.price, ts: Math.floor(Date.now() / 1000), src: 'oilpriceapi' });
  } catch { return shape(which, { src: 'oil-fail' }); }
}

// ---- FRED (yields, OAS) — daily series, always flagged with its own date ----
async function fredLatest(series) {
  if (!FRED_KEY) return { value: null, date: null };
  const url = `https://api.stlouisfed.org/fred/series/observations`
    + `?series_id=${series}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=1`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const o = j?.observations?.[0];
    return { value: o?.value === '.' ? null : Number(o?.value), date: o?.date ?? null };
  } catch { return { value: null, date: null }; }
}

// ---- public API of the spine ----
export async function getQuotes(syms) {
  const map = await fmpBatch(syms);
  // Guarantee a row for every requested symbol, even on miss (stale/null, not absent).
  return syms.map(s => map[s] ?? shape(s, { src: 'miss' }));
}

export async function getMacro() {
  const [wti, brent, dgs2, dgs10, oas] = await Promise.all([
    oilQuote('wti'), oilQuote('brent'),
    fredLatest('DGS2'), fredLatest('DGS10'), fredLatest('BAMLH0A0HYM2'),
  ]);
  return {
    wti, brent,
    us2y:  { ...dgs2,  name: 'US 2Y'  },
    us10y: { ...dgs10, name: 'US 10Y' },
    oas:   { ...oas,   name: 'HY OAS', note: 'FRED daily — last hard print' },
  };
}
