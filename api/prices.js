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
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
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

  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate");
  return res.status(200).json(results);
}
