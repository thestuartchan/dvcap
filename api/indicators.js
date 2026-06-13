export default async function handler(req, res) {
  const FRED_KEY    = process.env.FRED_API_KEY;
  const MASSIVE_KEY = process.env.MASSIVE_API_KEY;

  if (!FRED_KEY) {
    return res.status(500).json({ error: "FRED_API_KEY not configured" });
  }

  // Fetch latest observation from FRED
  async function fred(seriesId) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=1&api_key=${FRED_KEY}&file_type=json`;
    const r = await fetch(url);
    const d = await r.json();
    return parseFloat(d.observations?.[0]?.value ?? "0");
  }

  // Fetch DXY from Massive (US Dollar Index)
  async function dxy() {
    if (!MASSIVE_KEY) return null;
    try {
      const r = await fetch(
        `https://api.massive.com/v2/snapshot/locale/global/markets/forex/tickers/C:USDX?apiKey=${MASSIVE_KEY}`
      );
      const d = await r.json();
      return d?.ticker?.day?.c ?? d?.ticker?.prevDay?.c ?? null;
    } catch {
      return null;
    }
  }

  try {
    // Run all fetches in parallel
    const [tenY, twoY, unemp, hySpread, cpi, gdp, dxyVal] = await Promise.all([
      fred("DGS10"),        // 10-Year Treasury yield (daily)
      fred("DGS2"),         // 2-Year Treasury yield (daily)
      fred("UNRATE"),       // Unemployment rate (monthly)
      fred("BAMLH0A0HYM2"), // ICE BofA HY OAS (daily)
      fred("CPIAUCSL"),     // CPI (monthly)
      fred("GDPC1"),        // Real GDP (quarterly)
      dxy(),                // DXY via Massive
    ]);

    const result = {
      tenY,
      twoY,
      yieldSpread:  parseFloat((tenY - twoY).toFixed(3)),
      unemployment: unemp,
      creditSpread: hySpread,
      cpi,
      gdp,
      dxy: dxyVal,
    };

    // Cache for 1 hour — FRED data updates daily/monthly/quarterly
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json(result);
  } catch (e) {
    console.error("Indicator fetch error:", e.message);
    return res.status(500).json({ error: e.message });
  }
}