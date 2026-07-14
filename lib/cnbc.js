// cnbc.js — keyless access to CNBC's quote cache. Used for feeds Yahoo/FRED don't
// carry — notably VKOSPI (.KSVKOSPI), Korea's KOSPI-200 implied-vol index, which
// Yahoo has no symbol for. Same discipline as yahoo.js/fred.js: isolated fetch,
// normalized return, null on any failure so callers degrade to a stale/miss row.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// CNBC returns numbers as formatted strings ("83.14", "+6.39%", "78.15").
const num = s => {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/[+%,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Fetch one CNBC symbol → { symbol, name, last, prevClose, changePct, high, low,
// yrHigh, yrLow, ts } or null. ts is epoch seconds derived from the print time.
export async function cnbcQuote(symbol) {
  const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol`
    + `?symbols=${encodeURIComponent(symbol)}&requestMethod=itv&noform=1&partnerId=2`
    + `&fund=1&exthrs=1&output=json&events=1`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const q = j?.FormattedQuoteResult?.FormattedQuote?.[0];
    if (!q || q.last == null) return null;

    const last = num(q.last);
    const prevClose = num(q.previous_day_closing);
    const changePct = q.change_pct != null
      ? num(q.change_pct)
      : (last != null && prevClose ? ((last - prevClose) / prevClose) * 100 : null);

    // last_time is ISO w/ tz offset (e.g. 2026-07-13T14:34:50.000+0900) → epoch s.
    let ts = null;
    const t = Date.parse(q.last_time || '');
    if (Number.isFinite(t)) ts = Math.floor(t / 1000);

    return {
      symbol,
      name: q.name ?? symbol,
      last,
      prevClose,
      changePct,
      high: num(q.high),
      low: num(q.low),
      yrHigh: num(q.yrhiprice),
      yrLow: num(q.yrloprice),
      ts,
    };
  } catch {
    return null;
  }
}
