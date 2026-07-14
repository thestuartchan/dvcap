// yahoo.js — shared Yahoo Finance v8 chart access (keyless).
// The dvcap universe is authored in Yahoo symbol format (0981.HK, 000660.KS,
// 2330.TW, ^HSI, CL=F), and api/prices.js already proves this endpoint handles
// them. The macro spine reads through here so equities, indices, and oil all
// come from one keyless provider instead of a plan-gated one.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// Fetch one symbol's daily chart. A single request yields the live quote AND
// enough daily closes to compute 50/200d SMAs — so moving averages are sourced
// from real closes here, not from a provider's (unreliable) precomputed field.
// Returns { price, prevClose, changePct, ma50, ma200, dayLow, dayHigh, ts } or
// null on any failure. ts is epoch seconds (feeds the caller's stale flag).
export async function yahooChart(symbol, { range = "1y", interval = "1d" } = {}) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
      + `?interval=${interval}&range=${range}`;
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;

    // Daily closes for the SMA. Drop nulls (Yahoo pads gaps with null). The most
    // recent element is the current session's (possibly intraday) close — fine
    // for a read tool; the 50/200d level barely moves from including it.
    const closes = (result?.indicators?.quote?.[0]?.close || [])
      .filter(v => typeof v === "number");
    const sma = n => closes.length >= n
      ? closes.slice(-n).reduce((a, b) => a + b, 0) / n
      : null;

    const price = meta.regularMarketPrice ?? closes.at(-1) ?? null;
    // Previous DAILY close = the bar before the current session. Each closes[]
    // element is one trading day, so closes.at(-2) is yesterday's close. Do NOT
    // use meta.chartPreviousClose here: for a multi-day range it's the close
    // before the whole window (→ a ~1-year change, not a daily one).
    const prevClose = closes.length >= 2
      ? closes.at(-2)
      : (meta.chartPreviousClose ?? meta.previousClose ?? null);
    const changePct = (price != null && prevClose)
      ? ((price - prevClose) / prevClose) * 100
      : null;

    return {
      price,
      prevClose,
      changePct,
      ma50: sma(50),
      ma200: sma(200),
      dayLow: meta.regularMarketDayLow ?? null,
      dayHigh: meta.regularMarketDayHigh ?? null,
      ts: meta.regularMarketTime ?? null,
    };
  } catch {
    return null;
  }
}

// Latest EXTENDED-HOURS (pre/post-market) print, keyless. Kept separate from
// yahooChart because pre/post bars need an INTRADAY interval, whereas yahooChart uses
// daily bars for the SMA — one request can't serve both. Returns { price, ts, base }
// where `base` is the last REGULAR close (the reference for the pre/post % change), or
// null when there is no extended-hours bar after the regular close (e.g. the overnight
// dead zone) — callers then fall back to the regular/prior-close print.
export async function yahooPrePost(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
      + `?interval=5m&range=1d&includePrePost=true`;
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const result = (await r.json())?.chart?.result?.[0];
    const meta = result?.meta;
    const base = meta?.regularMarketPrice;
    const regTs = meta?.regularMarketTime;
    if (base == null || regTs == null) return null;

    const ts = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    // Walk back to the last traded bar; it's extended-hours only if it printed AFTER
    // the regular session close.
    for (let i = ts.length - 1; i >= 0; i--) {
      if (typeof closes[i] === "number") {
        return ts[i] > regTs ? { price: closes[i], ts: ts[i], base } : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
