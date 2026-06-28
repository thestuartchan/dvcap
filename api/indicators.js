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

  // ── Compute year-over-year % change from a monthly series ──────────────────
  // CPIAUCSL etc. are index levels, not rates — YoY% = (latest / 12-mo-ago − 1).
  async function fredYoY(seriesId) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=13&api_key=${FRED_KEY}&file_type=json`;
    const r = await fetch(url);
    const d = await r.json();
    const obs = (d.observations || []).filter(o => o.value !== "." && o.value !== "");
    if (obs.length < 13) return 0;
    const latest = parseFloat(obs[0].value);
    const yearAgo = parseFloat(obs[12].value);
    return yearAgo > 0 ? parseFloat((((latest / yearAgo) - 1) * 100).toFixed(2)) : 0;
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

  // ── Fetch WTI crude oil from Yahoo Finance CL=F ────────────────────────────
  // CommodityPriceAPI proved unreliable in production (404 on key validation,
  // varying payload shapes). Yahoo CL=F is free, needs no key, uses the same
  // infrastructure as api/prices.js, and returns the previous close so the oil
  // rising/falling direction indicator works. Single source, no fallback chain.
  async function fetchOil() {
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
      return {
        latest: price > 0 ? parseFloat(price.toFixed(2)) : 0,
        prev:   prev  > 0 ? parseFloat(prev.toFixed(2))  : 0,
      };
    } catch (e) {
      console.error("Yahoo CL=F oil fetch error:", e.message);
      return { latest: 0, prev: 0 };
    }
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
        + "&filter=original_security_term:eq:10-Year&sort=-auction_date&page[size]=12";
      const r = await fetch(url);
      if (!r.ok) { console.error("FiscalData auction status:", r.status); return null; }
      const d = await r.json();
      const rows = d?.data || [];
      const row = rows[0];
      if (!row) return null;
      const bidCover = parseFloat(row.bid_to_cover_ratio);
      // Chronological order (oldest → newest) for the trend chart.
      const history = rows
        .filter(x => x.bid_to_cover_ratio && x.auction_date)
        .map(x => ({ date: x.auction_date, value: parseFloat(x.bid_to_cover_ratio) }))
        .reverse();
      return { bidCover: Number.isFinite(bidCover) ? bidCover : null, date: row.auction_date || null, history };
    } catch (e) {
      console.error("FiscalData auction fetch error:", e.message);
      return null;
    }
  }

  const START_DATE = "2022-01-01"; // Chart history start

  try {
    // ── Fetch all data in parallel ────────────────────────────────────────────
    const [
      tenY, twoY, unemp, hySpread, cpi, cpiYoY, gdp, dxyRaw, m2Raw, oilRaw, auctionRaw,
      fedFundsRaw, tbill6mRaw,
      tenYHistory, twoYHistory, unempHistory, creditHistory,
    ] = await Promise.all([
      fredLatest("DGS10"),
      fredLatest("DGS2"),
      fredLatest("UNRATE"),
      fredLatest("BAMLH0A0HYM2"),
      fredLatest("CPIAUCSL"),
      fredYoY("CPIAUCSL"),
      fredLatest("GDPC1"),
      fredLatest("DTWEXBGS"),
      fredTwo("M2SL"),
      fetchOil(),               // WTI crude oil — Yahoo Finance CL=F
      fetchAuction(),           // 10Y Treasury auction bid-to-cover (FiscalData)
      fredLatest("FEDFUNDS"),   // Current Fed funds effective rate
      fredLatest("DTB6"),       // 6-month T-bill — forward policy-rate proxy
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

    // ── Market-implied Fed policy change ──────────────────────────────────────
    // Proxy: current Fed funds effective rate vs the 6-month T-bill. When the 6m
    // bill yields less than Fed funds, the market is pricing rate cuts → positive
    // bps. Negative bps = market pricing hikes. Null if either fetch is missing.
    const currentFedFunds = fedFundsRaw > 0 ? fedFundsRaw : null;
    const tbill6m = tbill6mRaw > 0 ? tbill6mRaw : null;
    const impliedCutsBps = (currentFedFunds != null && tbill6m != null)
      ? Math.round((currentFedFunds - tbill6m) * 100)
      : null;

    const result = {
      // ── Scalar values ──────────────────────────────────────────────────────
      tenY,
      twoY,
      yieldSpread:  parseFloat((tenY - twoY).toFixed(3)),
      unemployment: unemp,
      creditSpread: hySpread,
      cpi,
      cpiYoY,
      gdp,
      dxy:      dxyRaw,
      m2:       m2Raw.latest,
      m2Prev:   m2Raw.prev,
      m2Rising: m2Raw.latest > m2Raw.prev,
      oil:      oilRaw.latest > 0 ? parseFloat(oilRaw.latest.toFixed(2)) : null,
      oilPrev:  oilRaw.prev > 0   ? parseFloat(oilRaw.prev.toFixed(2))   : null,
      auctionBidCover: auctionRaw?.bidCover ?? null,
      auctionDate:     auctionRaw?.date ?? null,
      auctionHistory:  auctionRaw?.history ?? [],
      currentFedFunds,
      tbill6m,
      impliedCutsBps, // positive = market pricing cuts, negative = pricing hikes
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
