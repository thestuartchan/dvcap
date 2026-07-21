const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// Yahoo's v7 quote endpoint carries trailingAnnualDividendYield but requires a
// crumb + cookie. The v8 chart endpoint used for price does not — so dividends
// are fetched separately and merged in. Any failure here leaves dividends null
// and never affects the price feed.
function extractCookies(resp) {
  try {
    const arr = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
    const list = arr.length ? arr : (resp.headers.get("set-cookie") ? [resp.headers.get("set-cookie")] : []);
    return list.map(c => c.split(";")[0]).filter(Boolean);
  } catch (_) { return []; }
}
async function getYahooAuth() {
  const cookies = [];
  try {
    const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA } });
    cookies.push(...extractCookies(r1));
  } catch (_) {}
  const cookieHeader = cookies.join("; ");
  let crumb = null;
  try {
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    });
    cookies.push(...extractCookies(r2));
    const text = (await r2.text()).trim();
    if (text && text.length < 50 && !text.includes("<")) crumb = text;
  } catch (_) {}
  return { crumb, cookie: cookies.join("; ") };
}
// Best-effort batched dividend fetch. Adds dividendYield/dividendRate to each
// matched ticker in `results` (null when Yahoo has no dividend data).
async function fetchDividends(tickerList, results) {
  try {
    const { crumb, cookie } = await getYahooAuth();
    if (!crumb) return;
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(tickerList.join(","))}`
      + `&crumb=${encodeURIComponent(crumb)}&fields=trailingAnnualDividendYield,trailingAnnualDividendRate`;
    const r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    });
    if (!r.ok) return;
    const data = await r.json();
    const rows = data?.quoteResponse?.result || [];
    for (const row of rows) {
      const sym = row.symbol;
      if (!sym) continue;
      const dy = (typeof row.trailingAnnualDividendYield === "number" && row.trailingAnnualDividendYield > 0) ? row.trailingAnnualDividendYield : null;
      const dr = (typeof row.trailingAnnualDividendRate === "number" && row.trailingAnnualDividendRate > 0) ? row.trailingAnnualDividendRate : null;
      if (!results[sym]) results[sym] = {};
      results[sym].dividendYield = dy;
      results[sym].dividendRate = dr;
    }
  } catch (e) {
    console.error("Yahoo dividend fetch failed:", e.message);
  }
}

export default async function handler(req, res) {
  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: "Missing tickers" });

  const tickerList = tickers.split(",").map(t => t.trim()).filter(Boolean);
  const results = {};

  for (let i = 0; i < tickerList.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 120));
    const ticker = tickerList[i];
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
      const r = await fetch(url, {
        headers: {
          "User-Agent": UA,
          "Accept": "application/json",
        },
      });
      const data = await r.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta) {
        const price         = meta.regularMarketPrice ?? 0;
        const prevClose     = meta.chartPreviousClose ?? meta.previousClose ?? price;
        const changePercent = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
        results[ticker] = {
          price: parseFloat(price.toFixed(2)),
          changePercent: parseFloat(changePercent.toFixed(2)),
        };
      }
    } catch (e) {
      console.error(`Yahoo fetch failed for ${ticker}:`, e.message);
    }
  }

  // Merge in dividend yield/rate (best-effort; null when unavailable).
  await fetchDividends(tickerList, results);

  // Edge-cache: 2 min fresh, then serve last-good for up to 10 min while revalidating in
  // the background — so a serverless cold start / slow Yahoo upstream never blanks a panel.
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
  return res.status(200).json(results);
}
