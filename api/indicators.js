export default async function handler(req, res) {
  const FRED_KEY = process.env.FRED_API_KEY;

  if (!FRED_KEY) {
    return res.status(500).json({ error: "FRED_API_KEY not configured" });
  }

  // ── Fetch single latest value from FRED ────────────────────────────────────
  async function fredLatest(seriesId) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=2&api_key=${FRED_KEY}&file_type=json`;
    const r = await fetch(url);
    const d = await r.json();
    const obs = (d.observations || []).filter(o => o.value !== "." && o.value !== "");
    return obs.length ? parseFloat(obs[0].value) : 0;
  }

  // ── Fetch two observations for direction (rising/falling) ──────────────────
  async function fredTwo(seriesId) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=3&api_key=${FRED_KEY}&file_type=json`;
    const r = await fetch(url);
    const d = await r.json();
    const obs = (d.observations || []).filter(o => o.value !== "." && o.value !== "");
    return obs.length >= 2
      ? { latest: parseFloat(obs[0].value), prev: parseFloat(obs[1].value) }
      : { latest: 0, prev: 0 };
  }

  // ── Fetch history for chart — returns [{d, v}] array ──────────────────────
  // observationStart: earliest date to fetch from
  // transform: optional function to post-process the value
  async function fredHistory(seriesId, observationStart, transform) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&observation_start=${observationStart}&sort_order=asc&api_key=${FRED_KEY}&file_type=json`;
    const r = await fetch(url);
    const d = await r.json();
    const obs = (d.observations || []).filter(o => o.value !== "." && o.value !== "");

    // Thin the data: for daily series we sample ~monthly to keep payload small
    // For monthly/quarterly series we take everything
    const thinned = [];
    let lastMonth = "";
    for (const o of obs) {
      const month = o.date.slice(0, 7); // "YYYY-MM"
      if (month !== lastMonth) {
        const val = parseFloat(o.value);
        const transformed = transform ? transform(val) : val;
        // Format date as "Mon'YY" e.g. "Jan'22"
        const dt = new Date(o.date + "T00:00:00");
        const label = dt.toLocaleString("en-US", { month: "short" }).slice(0, 3)
          + "'" + String(dt.getFullYear()).slice(2);
        thinned.push({ d: label, v: parseFloat(transformed.toFixed(4)) });
        lastMonth = month;
      }
    }
    return thinned;
  }

  // ── Fetch WTI crude oil price from API Ninjas (near real-time) ───────────
  async function fetchOil() {
    const API_NINJAS_KEY = process.env.API_NINJAS_KEY;
    if (!API_NINJAS_KEY) return { latest: 0, prev: 0 };
    try {
      const r = await fetch("https://api.api-ninjas.com/v1/commodityprice?name=crude_oil", {
        headers: { "X-Api-Key": API_NINJAS_KEY },
      });
      const d = await r.json();
      const price = d?.price ?? 0;
      return { latest: parseFloat(price.toFixed(2)), prev: 0 };
    } catch (e) {
      console.error("API Ninjas oil fetch error:", e.message);
      return { latest: 0, prev: 0 };
    }
  }

  const START_DATE = "2022-01-01"; // Chart history start

  try {
    // ── Fetch all data in parallel ────────────────────────────────────────────
    const [
      tenY, twoY, unemp, hySpread, cpi, gdp, dxyRaw, m2Raw, oilRaw,
      tenYHistory, twoYHistory, unempHistory, creditHistory,
    ] = await Promise.all([
      fredLatest("DGS10"),
      fredLatest("DGS2"),
      fredLatest("UNRATE"),
      fredLatest("BAMLH0A0HYM2"),
      fredLatest("CPIAUCSL"),
      fredLatest("GDPC1"),
      fredLatest("DTWEXBGS"),
      fredTwo("M2SL"),
      fetchOil(),               // WTI crude oil — API Ninjas (near real-time)
      // History series for charts
      fredHistory("DGS10", START_DATE),
      fredHistory("DGS2",  START_DATE),
      fredHistory("UNRATE", START_DATE),
      fredHistory("BAMLH0A0HYM2", START_DATE),
    ]);

    // ── Compute yield spread history by merging 10Y and 2Y arrays ─────────────
    const yieldSpreadHistory = [];
    const twoYMap = {};
    for (const pt of twoYHistory) twoYMap[pt.d] = pt.v;
    for (const pt of tenYHistory) {
      if (twoYMap[pt.d] !== undefined) {
        yieldSpreadHistory.push({
          d: pt.d,
          v: parseFloat((pt.v - twoYMap[pt.d]).toFixed(4)),
        });
      }
    }

    const result = {
      // ── Scalar values ──────────────────────────────────────────────────────
      tenY,
      twoY,
      yieldSpread:  parseFloat((tenY - twoY).toFixed(3)),
      unemployment: unemp,
      creditSpread: hySpread,
      cpi,
      gdp,
      dxy:      dxyRaw,
      m2:       m2Raw.latest,
      m2Prev:   m2Raw.prev,
      m2Rising: m2Raw.latest > m2Raw.prev,
      oil:      oilRaw.latest > 0 ? parseFloat(oilRaw.latest.toFixed(2)) : null,
      oilPrev:  oilRaw.prev > 0   ? parseFloat(oilRaw.prev.toFixed(2))   : null,
      // ── Chart history arrays ───────────────────────────────────────────────
      yieldHistory:  yieldSpreadHistory,
      unempHistory,
      creditHistory,
    };

    // Cache 5 minutes — allows near-fresh data without hammering FRED
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    return res.status(200).json(result);
  } catch (e) {
    console.error("Indicator fetch error:", e.message);
    return res.status(500).json({ error: e.message });
  }
}
