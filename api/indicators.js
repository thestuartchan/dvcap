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

  // ── Fetch WTI crude oil — CommodityPriceAPI primary, Yahoo CL=F fallback ────
  // CommodityPriceAPI has returned null in production: invalid-key responses are
  // HTTP 404 and the success payload shape can vary, so the previous single-shape
  // parse silently yielded 0 → null. We now parse defensively and ALWAYS fall
  // back to Yahoo Finance CL=F (free, no key, same infra as api/prices.js). Yahoo
  // also returns the previous close, so the oil rising/falling indicator works.
  async function fetchOilYahoo() {
    try {
      const r = await fetch(
        "https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=1d&range=5d",
        { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "application/json" } }
      );
      const d = await r.json();
      const m = d?.chart?.result?.[0]?.meta;
      const price = m?.regularMarketPrice ?? 0;
      const prev  = m?.chartPreviousClose ?? m?.previousClose ?? 0;
      console.log("Yahoo CL=F oil — status:", r.status, "price:", price, "prev:", prev);
      if (price > 0) {
        return { latest: parseFloat(price.toFixed(2)), prev: prev > 0 ? parseFloat(prev.toFixed(2)) : 0, source: "yahoo" };
      }
      return null;
    } catch (e) {
      console.error("Yahoo CL=F oil fetch error:", e.message);
      return null;
    }
  }

  async function fetchOil() {
    const COMMODITY_KEY = process.env.COMMODITY_API_KEY;
    // 1) CommodityPriceAPI (primary, when a key is configured)
    if (COMMODITY_KEY) {
      try {
        const url = "https://api.commoditypriceapi.com/v2/rates/latest?symbols=WTIOIL-FUT";
        console.log("Oil fetch URL:", url, "| key present:", !!COMMODITY_KEY);
        const r = await fetch(url, { headers: { "x-api-key": COMMODITY_KEY } });
        const d = await r.json();
        // Tolerate the several response shapes CommodityPriceAPI v2 has used.
        const raw = d?.rates?.["WTIOIL-FUT"]
                 ?? d?.data?.["WTIOIL-FUT"]?.price
                 ?? d?.data?.["WTIOIL-FUT"]
                 ?? d?.["WTIOIL-FUT"]
                 ?? null;
        const price = typeof raw === "number" ? raw : parseFloat(raw);
        console.log("CommodityPriceAPI — status:", r.status, "success:", d?.success, "parsedOil:", price);
        if (Number.isFinite(price) && price > 0) {
          return { latest: parseFloat(price.toFixed(2)), prev: 0, source: "commoditypriceapi" };
        }
        console.warn("CommodityPriceAPI returned no usable price — falling back to Yahoo CL=F. Body:", JSON.stringify(d).slice(0, 200));
      } catch (e) {
        console.error("CommodityPriceAPI oil fetch error — falling back to Yahoo CL=F:", e.message);
      }
    } else {
      console.warn("COMMODITY_API_KEY not set — using Yahoo CL=F for oil.");
    }
    // 2) Yahoo CL=F fallback (also supplies previous close for direction)
    const y = await fetchOilYahoo();
    if (y) return y;
    // 3) Both sources failed. This function is stateless (no persisted last-known
    //    value across invocations), so we return 0 and let the frontend hold its
    //    static fallback rather than show a misleading number.
    console.error("Oil: both CommodityPriceAPI and Yahoo CL=F failed — returning no data.");
    return { latest: 0, prev: 0, source: "none" };
  }

  // ── Fetch latest 10Y Treasury auction bid-to-cover (FiscalData, public) ─────
  // No API key required. Endpoint confirmed live: returns auction_date,
  // security_term, bid_to_cover_ratio. Returns null gracefully on any failure
  // so the rest of the indicators payload is unaffected.
  async function fetchAuction() {
    try {
      // Filter on original_security_term (not security_term) so 10Y *reopenings*
      // — labelled "9-Year 11-Month" etc. — are included. Filtering exact
      // "10-Year" only matched original issues (Feb/May/Aug/Nov), missing the
      // monthly reopenings and leaving the bid-to-cover weeks stale.
      const url = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query"
        + "?fields=auction_date,security_term,original_security_term,bid_to_cover_ratio"
        + "&filter=original_security_term:eq:10-Year&sort=-auction_date&page[size]=1";
      const r = await fetch(url);
      if (!r.ok) { console.error("FiscalData auction status:", r.status); return null; }
      const d = await r.json();
      const row = d?.data?.[0];
      if (!row) return null;
      const bidCover = parseFloat(row.bid_to_cover_ratio);
      return { bidCover: Number.isFinite(bidCover) ? bidCover : null, date: row.auction_date || null };
    } catch (e) {
      console.error("FiscalData auction fetch error:", e.message);
      return null;
    }
  }

  const START_DATE = "2022-01-01"; // Chart history start

  try {
    // ── Fetch all data in parallel ────────────────────────────────────────────
    const [
      tenY, twoY, unemp, hySpread, cpi, gdp, dxyRaw, m2Raw, oilRaw, auctionRaw,
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
      fetchAuction(),           // 10Y Treasury auction bid-to-cover (FiscalData)
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
      auctionBidCover: auctionRaw?.bidCover ?? null,
      auctionDate:     auctionRaw?.date ?? null,
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
