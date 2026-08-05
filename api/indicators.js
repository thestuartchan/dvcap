import { LABOR_SERIES } from "../lib/labor.js";

export default async function handler(req, res) {
  const FRED_KEY = process.env.FRED_API_KEY;

  if (!FRED_KEY) {
    return res.status(500).json({ error: "FRED_API_KEY not configured" });
  }

  // ── Fetch single latest value from FRED ────────────────────────────────────
  // Returns { value, date } — the observation DATE is the metric's real asOf (source
  // timestamp), which the P0 staleness system needs. Never fetch-time.
  async function fredLatest(seriesId) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=2&api_key=${FRED_KEY}&file_type=json`;
    const r = await fetch(url);
    const d = await r.json();
    const obs = (d.observations || []).filter(o => o.value !== "." && o.value !== "");
    return obs.length ? { value: parseFloat(obs[0].value), date: obs[0].date } : { value: 0, date: null };
  }

  // ── ICE US Dollar Index (DXY) via Yahoo DX-Y.NYB, keyless ───────────────────
  // NOT FRED's DTWEXBGS (Broad Dollar Index, base 2006=100, reads ~120) — that is a
  // different index. The DXY the desk watches is ICE's (~100.8). asOf = quote time.
  async function fetchDxy() {
    try {
      const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?interval=1d&range=5d",
        { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "application/json" } });
      const m = (await r.json())?.chart?.result?.[0]?.meta;
      const price = m?.regularMarketPrice ?? 0;
      return {
        latest: price > 0 ? parseFloat(price.toFixed(3)) : null,
        prev:   (m?.chartPreviousClose ?? m?.previousClose ?? 0) || null,
        asOf:   m?.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
      };
    } catch (e) {
      console.error("Yahoo DX-Y.NYB fetch error:", e.message);
      return { latest: null, prev: null, asOf: null };
    }
  }

  // ── Compute year-over-year % change from a monthly series ──────────────────
  // Uses FRED's units=pc1 (percent change from a year ago) so FRED does the
  // base-period math server-side and returns the YoY% directly. Robust to
  // release timing: the previous approach fetched exactly 13 rows and required
  // all 13 to be non-empty, so a single placeholder "." row (e.g. an unreleased
  // current month) dropped the count to 12 and silently returned 0 — the
  // cpiYoY:0 bug. Filter "." and take the latest real value, like fredLatest.
  async function fredYoY(seriesId) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&units=pc1&sort_order=desc&limit=3&api_key=${FRED_KEY}&file_type=json`;
    const r = await fetch(url);
    const d = await r.json();
    const obs = (d.observations || []).filter(o => o.value !== "." && o.value !== "");
    return obs.length ? parseFloat(parseFloat(obs[0].value).toFixed(2)) : 0;
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

  // Latest TWO observations WITH their dates, nulling out on failure. Deliberately not
  // fredTwo(): that returns {latest:0, prev:0} on failure, which would render a real-looking
  // "0.0%" growth print. A missing series must read as missing, never as zero.
  async function fredPair(seriesId) {
    try {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=6&api_key=${FRED_KEY}&file_type=json`;
      const r = await fetch(url);
      if (!r.ok) return { value: null, date: null, prev: null, prevDate: null };
      const d = await r.json();
      const obs = (d.observations || [])
        .filter(o => o.value !== "." && o.value != null && o.value !== "")
        .map(o => ({ value: parseFloat(o.value), date: o.date }))
        .filter(o => Number.isFinite(o.value));
      return {
        value: obs[0]?.value ?? null, date: obs[0]?.date ?? null,
        prev:  obs[1]?.value ?? null, prevDate: obs[1]?.date ?? null,
      };
    } catch {
      return { value: null, date: null, prev: null, prevDate: null };
    }
  }

  // Cash-ETF yield from the KEYLESS dividend history. Yahoo's v7 quote field
  // (trailingAnnualDividendYield) needs a crumb and currently returns null for these, so the
  // yield is computed from actual distributions instead: TTM = sum of the last 12 months of
  // dividends / price. Also returns the latest monthly distribution annualised, which reacts
  // faster to rate moves but is noisier (one odd payment date swings it). Both are reported so
  // the caller can label which is which — neither is an SEC 30-day yield, and we don't claim to be.
  async function fetchEtfYield(symbol) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y&events=div`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: AbortSignal.timeout(9000) });
      if (!r.ok) return null;
      const res = (await r.json())?.chart?.result?.[0];
      const price = res?.meta?.regularMarketPrice;
      const divs = Object.values(res?.events?.dividends || {})
        .filter(d => typeof d?.amount === "number" && d.amount > 0)
        .sort((a, b) => a.date - b.date);
      if (!price || !divs.length) return null;
      const ttmSum = divs.reduce((a, d) => a + d.amount, 0);
      const last = divs[divs.length - 1];
      return {
        symbol, price,
        ttmYield: +((ttmSum / price) * 100).toFixed(2),
        annualizedLatest: +(((last.amount * 12) / price) * 100).toFixed(2),
        lastDivDate: new Date(last.date * 1000).toISOString().slice(0, 10),
        payments: divs.length,
      };
    } catch {
      return null;
    }
  }

  // Labour series with an IDENTITY ASSERTION. The spec flagged LNS11300060 and LNS13025703 as
  // the IDs most likely to be wrong, so rather than trusting them once we verify on every
  // fetch: FRED's own series metadata title must contain the expected fragment. A repurposed
  // or mistyped ID yields verified:false and a named mismatch, which the UI surfaces — it
  // never silently renders the wrong series as if it were the right one.
  async function fredLabor(id, expectTitle) {
    const base = `api_key=${FRED_KEY}&file_type=json`;
    try {
      const [metaR, obsR] = await Promise.all([
        fetch(`https://api.stlouisfed.org/fred/series?series_id=${id}&${base}`),
        fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&sort_order=desc&limit=16&${base}`),
      ]);
      if (!metaR.ok || !obsR.ok) return { id, ok: false, error: `HTTP ${metaR.status}/${obsR.status}` };
      const title = (await metaR.json())?.seriess?.[0]?.title ?? null;
      const obs = ((await obsR.json())?.observations || [])
        .filter(o => o.value !== '.' && o.value != null && o.value !== '')
        .map(o => ({ date: o.date, value: parseFloat(o.value) }))
        .filter(o => Number.isFinite(o.value));
      const verified = !!(title && expectTitle && title.toLowerCase().includes(expectTitle.toLowerCase()));
      return {
        id, ok: obs.length > 0, title, verified,
        mismatch: verified ? null : `expected title containing "${expectTitle}", FRED returned "${title}"`,
        value: obs[0]?.value ?? null, date: obs[0]?.date ?? null,
        prev: obs[1]?.value ?? null, prevDate: obs[1]?.date ?? null,
        delta: (obs[0] && obs[1]) ? +(obs[0].value - obs[1].value).toFixed(2) : null,
        // Year-ago value for level series that need a y/y read.
        yearAgo: obs[12]?.value ?? null,
        history: obs.slice(0, 16).reverse(),
      };
    } catch (e) {
      return { id, ok: false, error: String(e?.message || e) };
    }
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
        // iso kept alongside the display label so date arithmetic (e.g. months since the
        // curve un-inverted) works on real dates rather than by parsing "Mon'YY" back out.
        thinned.push({ d: label, iso: o.date, v: parseFloat(transformed.toFixed(4)) });
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
        asOf:   m?.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
      };
    } catch (e) {
      console.error("Yahoo CL=F oil fetch error:", e.message);
      return { latest: 0, prev: 0, asOf: null };
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
        + "&filter=original_security_term:eq:10-Year&sort=-auction_date&page%5Bsize%5D=12";
      const r = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
        },
      });
      if (!r.ok) { console.error("FiscalData auction FAILED status:", r.status); return null; }
      const d = await r.json();
      const rows = d?.data || [];
      // Keep only rows that carry a real, positive bid-to-cover ratio. The most
      // recent matching auction is often an announcement/just-auctioned issue
      // whose ratio is still blank (parseFloat -> NaN); skip those and use the
      // latest *settled* auction. rows are sorted newest-first by the API.
      const valid = rows
        .map(x => ({ date: x.auction_date, value: parseFloat(x.bid_to_cover_ratio) }))
        .filter(x => x.date && Number.isFinite(x.value) && x.value > 0);
      const row = valid[0];
      if (!row) {
        console.error("FiscalData auction: no rows with a valid bid-to-cover. rawRows=",
          rows.length, "sample=", JSON.stringify(rows[0] || {}));
        return null;
      }
      // Chronological order (oldest → newest) for the trend chart.
      const history = valid.map(x => ({ date: x.date, value: x.value })).reverse();
      console.log("FiscalData auction OK:", rows.length, "raw,", valid.length,
        "valid · latest settled", row.date, "bid-to-cover", row.value);
      return { bidCover: row.value, date: row.date || null, history };
    } catch (e) {
      console.error("FiscalData auction fetch error:", e.message);
      return null;
    }
  }

  // ── Fetch YoY % change history (units=pc1) — returns [{date, value}] chrono ──
  // FRED computes the year-over-year % server-side. Returns [] on any failure so
  // the rest of the payload is unaffected. Used for the CPI inflation tracker.
  async function fredPc1History(seriesId, limit = 25) {
    try {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=${limit}&units=pc1&api_key=${FRED_KEY}&file_type=json`;
      const r = await fetch(url);
      if (!r.ok) { console.error("FRED pc1 status (" + seriesId + "):", r.status); return []; }
      const d = await r.json();
      return (d.observations || [])
        .filter(o => o.value !== "." && o.value !== "" && o.value !== "NA")
        .map(o => ({ date: o.date, value: parseFloat(o.value) }))
        .reverse(); // chronological order, oldest → newest
    } catch (e) {
      console.error("FRED pc1 history error (" + seriesId + "):", e.message);
      return [];
    }
  }

  const START_DATE = "2022-01-01"; // Chart history start

  try {
    // ── Fetch all data in parallel ────────────────────────────────────────────
    const [
      tenY, twoY, unemp, hySpread, cpi, cpiYoY, gdp, dxyRaw, m2Raw, oilRaw, auctionRaw,
      fedFundsRaw, tbill6mRaw, gdpGrowthRaw, usfrYield, sgovYield, termPremiumRaw, laborRaw,
      spreadPublished, spreadHistoryRaw,
      tenYHistory, twoYHistory, unempHistory, creditHistory,
      cpiHeadlineHistory, cpiCoreHistory, pceCoreHistory,
    ] = await Promise.all([
      fredLatest("DGS10"),
      fredLatest("DGS2"),
      fredLatest("UNRATE"),
      fredLatest("BAMLH0A0HYM2"),
      fredLatest("CPIAUCSL"),
      fredYoY("CPIAUCSL"),
      fredLatest("GDPC1"),
      fetchDxy(),               // ICE DXY via Yahoo (was FRED DTWEXBGS = wrong index)
      fredTwo("M2SL"),
      fetchOil(),               // WTI crude oil — Yahoo Finance CL=F
      fetchAuction(),           // 10Y Treasury auction bid-to-cover (FiscalData)
      fredLatest("FEDFUNDS"),   // Current Fed funds effective rate
      fredLatest("DTB6"),       // 6-month T-bill — forward policy-rate proxy
      // Real GDP GROWTH (% change from preceding quarter, SAAR) — the growth INPUT. GDPC1
      // above is a level ($T) and cannot answer "is growth decelerating"; this can, and it
      // carries the prior quarter so the direction is computed from a real prior print.
      fredPair("A191RL1Q225SBEA"),
      fetchEtfYield("USFR"),   // cash-ETF yields, computed from real distributions
      fetchEtfYield("SGOV"),
      // Section B — ACM 10Y term premium. MODEL ESTIMATE, not a market price: direction and
      // trend only, never the absolute level. ID verified against FRED metadata on every fetch.
      fredLabor("THREEFYTP10", "term premium"),
      // P1 — every labour series, each identity-checked against FRED's own metadata title.
      Promise.all(Object.entries(LABOR_SERIES).map(async ([key, m]) => [key, await fredLabor(m.id, m.expectTitle)]))
        .then(Object.fromEntries),
      // History series for charts
      // T10Y2Y is FRED's OWN published 10Y−2Y spread, and it lands a full business day
      // ahead of DGS10/DGS2 — on 2026-08-05 it carried 08-04 while both constituents stopped
      // at 08-03. Deriving the spread from the legs therefore inherited their lag for no
      // reason. Fetched as a first-class series so the card can show the newest print.
      fredLatest("T10Y2Y"),
      fredHistory("T10Y2Y", START_DATE),
      fredHistory("DGS10", START_DATE),
      fredHistory("DGS2",  START_DATE),
      fredHistory("UNRATE", START_DATE),
      fredHistory("BAMLH0A0HYM2", START_DATE),
      // CPI inflation tracker — YoY % histories (24 months)
      fredPc1History("CPIAUCSL"),  // Headline CPI
      fredPc1History("CPILFESL"),  // Core CPI (ex food & energy)
      fredPc1History("PCEPILFE"),  // Core PCE (Fed's preferred)
    ]);

    // ── Yield spread history: prefer FRED's published series ──────────────────
    // The merge below is kept as a fallback only. Merging DGS10 and DGS2 requires both legs
    // to carry the same date, so any per-leg publication lag silently truncates the spread —
    // which is exactly what made the card sit a business day behind.
    const derivedSpreadHistory = [];
    const twoYMap = {};
    for (const pt of twoYHistory) twoYMap[pt.d] = pt.v;
    for (const pt of tenYHistory) {
      if (twoYMap[pt.d] !== undefined) {
        derivedSpreadHistory.push({
          d: pt.d, iso: pt.iso ?? null,
          v: parseFloat((pt.v - twoYMap[pt.d]).toFixed(4)),
        });
      }
    }
    const yieldSpreadHistory = (spreadHistoryRaw && spreadHistoryRaw.length >= derivedSpreadHistory.length)
      ? spreadHistoryRaw : derivedSpreadHistory;

    // Which spread is newest, and do the two sources agree where they overlap?
    const derivedSpread = (tenY.value != null && twoY.value != null)
      ? parseFloat((tenY.value - twoY.value).toFixed(3)) : null;
    const derivedDate = (tenY.date && twoY.date && tenY.date === twoY.date) ? tenY.date : null;
    const publishedNewer = !!(spreadPublished?.date && (!derivedDate || spreadPublished.date > derivedDate));
    const yieldSpread = publishedNewer ? spreadPublished.value : (derivedSpread ?? spreadPublished?.value ?? null);
    const yieldSpreadDate = publishedNewer ? spreadPublished.date : (derivedDate ?? spreadPublished?.date ?? null);
    const yieldSpreadSource = publishedNewer ? "T10Y2Y (published)" : "DGS10 − DGS2 (derived)";
    // Coherence: on a SHARED date the two must agree. A gap means one leg is mis-mapped or
    // stale, and silently preferring the newer number would hide that.
    let yieldSpreadCoherence = null;
    if (spreadPublished?.value != null && derivedSpread != null && derivedDate && spreadPublished.date === derivedDate) {
      const gapBp = Math.round(Math.abs(spreadPublished.value - derivedSpread) * 100);
      yieldSpreadCoherence = { sharedDate: derivedDate, gapBp, agree: gapBp <= 2, note: null };
      yieldSpreadCoherence.note = `published T10Y2Y ${spreadPublished.value}% vs derived ${derivedSpread}% on ${derivedDate} (${gapBp}bp apart)`;
    }

    // ── Market-implied Fed policy change ──────────────────────────────────────
    // Proxy: current Fed funds effective rate vs the 6-month T-bill. When the 6m
    // bill yields less than Fed funds, the market is pricing rate cuts → positive
    // bps. Negative bps = market pricing hikes. Null if either fetch is missing.
    const currentFedFunds = fedFundsRaw.value > 0 ? fedFundsRaw.value : null;
    const tbill6m = tbill6mRaw.value > 0 ? tbill6mRaw.value : null;
    const impliedCutsBps = (currentFedFunds != null && tbill6m != null)
      ? Math.round((currentFedFunds - tbill6m) * 100)
      : null;

    // ── Sanity clamp: flag any scalar outside a plausible band (don't silently render) ──
    const BANDS = { dxy: [70, 130], tenY: [0, 10], twoY: [0, 10], unemployment: [2, 12], creditSpread: [1, 25] };
    const sanity = {};
    const chk = (k, v) => { if (v != null && BANDS[k] && (v < BANDS[k][0] || v > BANDS[k][1])) sanity[k] = "out-of-band"; };
    // Registered here rather than where it is computed: sanity is declared below that block,
    // so assigning into it earlier is a temporal-dead-zone ReferenceError on the one path
    // that matters — the sources disagreeing.
    if (yieldSpreadCoherence && !yieldSpreadCoherence.agree) sanity.yieldSpread = yieldSpreadCoherence.note;
    chk("dxy", dxyRaw.latest); chk("tenY", tenY.value); chk("twoY", twoY.value);
    chk("unemployment", unemp.value); chk("creditSpread", hySpread.value);

    // ── CPI inflation tracker — latest reading of each YoY series ──────────────
    const cpiHeadlineCurrent = cpiHeadlineHistory.length ? cpiHeadlineHistory[cpiHeadlineHistory.length - 1].value : null;
    const cpiCoreCurrent     = cpiCoreHistory.length     ? cpiCoreHistory[cpiCoreHistory.length - 1].value         : null;
    const pceCoreCurrent     = pceCoreHistory.length     ? pceCoreHistory[pceCoreHistory.length - 1].value         : null;

    const result = {
      // ── Scalar values ──────────────────────────────────────────────────────
      tenY:         tenY.value,
      twoY:         twoY.value,
      yieldSpread,
      yieldSpreadSource,
      yieldSpreadCoherence,
      unemployment: unemp.value,
      creditSpread: hySpread.value,
      cpi:          cpi.value,
      cpiYoY,
      gdp:          gdp.value,
      // Real GDP growth (% SAAR) + the prior quarter, so the card can state DIRECTION from a
      // real prior print rather than asserting deceleration from a single number.
      gdpGrowth:      gdpGrowthRaw.value,
      gdpGrowthPrev:  gdpGrowthRaw.prev,
      gdpGrowthDate:  gdpGrowthRaw.date,
      gdpGrowthPrevDate: gdpGrowthRaw.prevDate,
      // Cash-ETF yields (null when the dividend history is unavailable — never faked).
      etfYields: { USFR: usfrYield, SGOV: sgovYield },
      // P1 — labour block. Each series carries its own verified flag + mismatch reason.
      labor: laborRaw,
      termPremium: termPremiumRaw,   // Section B — model estimate; use direction/trend only
      dxy:      dxyRaw.latest,
      dxyPrev:  dxyRaw.prev,
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
      // ── CPI inflation tracker (additive; existing `cpi` field unchanged) ─────
      cpiHeadlineCurrent,
      cpiCoreCurrent,
      pceCoreCurrent,
      // ── Chart history arrays ───────────────────────────────────────────────
      yieldHistory:  yieldSpreadHistory,
      unempHistory,
      creditHistory,
      cpiHeadlineHistory,
      cpiCoreHistory,
      pceCoreHistory,
      // ── Per-metric source dates (asOf) — feeds the P0 staleness system ───────
      // FRED scalars: observation date (YYYY-MM-DD). Yahoo (dxy/oil): ISO quote time.
      // The frontend computes stale = now − asOf > per-metric cadence, and always
      // shows this date as subtext — mirroring the HY OAS "last hard print" model.
      asOf: {
        // The spread carries its OWN date. It can legitimately be a day ahead of the legs,
        // and stamping it with tenY.date would have understated it by a business day.
        tenY: tenY.date, twoY: twoY.date, yieldSpread: yieldSpreadDate,
        unemployment: unemp.date, creditSpread: hySpread.date,
        cpi: cpi.date, gdp: gdp.date, gdpGrowth: gdpGrowthRaw.date,
        currentFedFunds: fedFundsRaw.date, tbill6m: tbill6mRaw.date,
        dxy: dxyRaw.asOf, oil: oilRaw.asOf,
        cpiYoY:             cpiHeadlineHistory.at(-1)?.date ?? null,
        cpiHeadlineCurrent: cpiHeadlineHistory.at(-1)?.date ?? null,
        cpiCoreCurrent:     cpiCoreHistory.at(-1)?.date ?? null,
        pceCoreCurrent:     pceCoreHistory.at(-1)?.date ?? null,
        auctionBidCover:    auctionRaw?.date ?? null,
      },
      sanity,  // { metric: "out-of-band" } for any value outside its plausible band
    };

    // 60s edge cache with a 5-minute stale window: a new FRED print shows up within a
    // minute, while stale-while-revalidate keeps the response instant and means FRED still
    // sees at most ~1 origin fetch a minute regardless of traffic.
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json(result);
  } catch (e) {
    console.error("Indicator fetch error:", e.message);
    return res.status(500).json({ error: e.message });
  }
}
