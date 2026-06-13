export default async function handler(req, res) {
  const FRED_KEY = process.env.FRED_API_KEY;

  if (!FRED_KEY) {
    return res.status(500).json({ error: "FRED_API_KEY not configured" });
  }

  // Fetch latest observation from FRED
  async function fred(seriesId) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=2&api_key=${FRED_KEY}&file_type=json`;
    const r = await fetch(url);
    const d = await r.json();
    // Return latest non-null value
    const obs = (d.observations || []).filter(o => o.value !== "." && o.value !== "");
    return obs.length ? parseFloat(obs[0].value) : 0;
  }

  // Fetch two observations to compute M2 direction (rising/falling)
  async function fredTwo(seriesId) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=3&api_key=${FRED_KEY}&file_type=json`;
    const r = await fetch(url);
    const d = await r.json();
    const obs = (d.observations || []).filter(o => o.value !== "." && o.value !== "");
    return obs.length >= 2
      ? { latest: parseFloat(obs[0].value), prev: parseFloat(obs[1].value) }
      : { latest: 0, prev: 0 };
  }

  try {
    const [tenY, twoY, unemp, hySpread, cpi, gdp, dxyRaw, m2Raw] = await Promise.all([
      fred("DGS10"),        // 10-Year Treasury yield (daily)
      fred("DGS2"),         // 2-Year Treasury yield (daily)
      fred("UNRATE"),       // Unemployment rate (monthly)
      fred("BAMLH0A0HYM2"), // ICE BofA HY OAS (daily)
      fred("CPIAUCSL"),     // CPI All Urban Consumers (monthly)
      fred("GDPC1"),        // Real GDP in billions (quarterly)
      fred("DTWEXBGS"),     // US Dollar Index — trade-weighted broad (daily, FRED)
      fredTwo("M2SL"),      // M2 Money Supply in billions (weekly)
    ]);

    const result = {
      tenY,
      twoY,
      yieldSpread:    parseFloat((tenY - twoY).toFixed(3)),
      unemployment:   unemp,
      creditSpread:   hySpread,
      cpi,
      gdp,
      dxy:            dxyRaw,   // Trade-weighted dollar index (not the DXY futures contract, but equivalent directional signal)
      m2:             m2Raw.latest,
      m2Prev:         m2Raw.prev,
      m2Rising:       m2Raw.latest > m2Raw.prev,
    };

    // Cache 1 hour — FRED data updates daily/weekly/monthly/quarterly
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json(result);
  } catch (e) {
    console.error("Indicator fetch error:", e.message);
    return res.status(500).json({ error: e.message });
  }
}
