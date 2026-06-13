export default async function handler(req, res) {
  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: "Missing tickers" });

  const tickerList = tickers.split(",").map(t => t.trim()).filter(Boolean);
  const MASSIVE_KEY = process.env.MASSIVE_API_KEY;

  if (!MASSIVE_KEY) {
    return res.status(500).json({ error: "MASSIVE_API_KEY not configured" });
  }

  const results = {};

  for (let i = 0; i < tickerList.length; i++) {
    // Stagger requests to respect free tier rate limit (5 req/min)
    if (i > 0) await new Promise(r => setTimeout(r, 250));
    const ticker = tickerList[i];
    try {
      const r = await fetch(
        `https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${MASSIVE_KEY}`
      );
      const data = await r.json();
      const snap = data?.ticker;
      if (snap) {
        results[ticker] = {
          price: snap.day?.c ?? snap.prevDay?.c ?? 0,
          changePercent: snap.todaysChangePerc ?? 0,
        };
      }
    } catch (e) {
      console.error(`Massive fetch failed for ${ticker}:`, e.message);
    }
  }

  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate");
  return res.status(200).json(results);
}