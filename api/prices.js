import { yahooAuth } from "../lib/yahoo.js";
import { roundQuote } from "../lib/price.js";
import { fetchHyperliquid, hlCoin } from "../lib/hyperliquid.js";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// Yahoo's v7 quote endpoint carries trailingAnnualDividendYield but requires a
// crumb + cookie. The v8 chart endpoint used for price does not — so dividends
// are fetched separately and merged in. Any failure here leaves dividends null
// and never affects the price feed.
// Best-effort batched dividend fetch. Adds dividendYield/dividendRate to each
// matched ticker in `results` (null when Yahoo has no dividend data).
async function fetchDividends(tickerList, results) {
  try {
    const { crumb, cookie } = await yahooAuth();
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
      // A ticker Yahoo does not know must be ABSENT from the reply, not present with a price of
      // zero. MNQ has no Yahoo listing, so `?? 0` handed the console a live price of 0.0000 and it
      // dutifully reported the position down 100% — a fabricated number, produced by a default
      // meant only to avoid a crash. Callers already handle a missing key.
      if (meta && Number.isFinite(meta.regularMarketPrice) && meta.regularMarketPrice > 0) {
        const price         = meta.regularMarketPrice;
        const prevClose     = meta.chartPreviousClose ?? meta.previousClose ?? price;
        const changePercent = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
        // The exchange already knows what currency this thing trades in — asking the user to
        // declare it, and defaulting to USD when they do not, is how a Hong Kong listing gets
        // valued as dollars and reports a book ~7.8x too large. Only pass a plausible ISO code
        // through; anything else is left absent so the caller keeps whatever it had.
        const ccy = typeof meta.currency === "string" && /^[A-Za-z]{3}$/.test(meta.currency)
          ? meta.currency.toUpperCase() : null;
        results[ticker] = {
          // ROUNDED BY SCALE, not to a fixed two places. `toFixed(2)` is right for a share and
          // destroys anything quoted below a dollar — MJY at 0.00641 was stored as 0.01, and since
          // this is the SOURCE, no consumer could recover it. See lib/price.js.
          price: roundQuote(price),
          changePercent: parseFloat(changePercent.toFixed(2)),
          ...(ccy ? { currency: ccy } : {}),
        };
      }
    } catch (e) {
      console.error(`Yahoo fetch failed for ${ticker}:`, e.message);
    }
  }

  // Merge in dividend yield/rate (best-effort; null when unavailable).
  await fetchDividends(tickerList, results);

  // ── THE VENUE'S OWN NUMBERS FOR A PERP ──────────────────────────────────────────────────────
  // Attached HERE rather than in a route of its own because the deployment is at its 12-function
  // cap, and because a caller asking for prices is already asking the question this answers.
  //
  // PUBLIC MARKET DATA ONLY — no key, no wallet address, no account. It reports what the venue's
  // mark and funding ARE. It deliberately does NOT replace `price`: a BTC-USD row may be a perp or
  // spot held anywhere, and deciding which from the symbol is the inference this codebase keeps
  // paying for. The spot quote stays the quote; the mark, the basis and the carry sit beside it.
  const coins = [...new Set(tickerList.map(hlCoin).filter(Boolean))];
  if (coins.length) {
    const hl = await fetchHyperliquid();
    for (const t of tickerList) {
      const coin = hlCoin(t);
      if (!coin || !results[t]) continue;
      const m = hl.markets[coin];
      // A venue that does not answer reads as UNKNOWN, never as zero funding — a carry of "none"
      // is a claim, and 11% a year is what it would be hiding.
      results[t].hl = m
        ? { coin, mark: m.mark, oracle: m.oracle, funding: m.funding, fundingApr: m.fundingApr,
            sizeStep: m.sizeStep, maxLeverage: m.maxLeverage, asOf: new Date().toISOString() }
        : { coin, unavailable: true, reason: hl.error || 'not listed on the venue' };
    }
  }

  // Edge-cache: 2 min fresh, then serve last-good for up to 10 min while revalidating in
  // the background — so a serverless cold start / slow Yahoo upstream never blanks a panel.
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
  return res.status(200).json(results);
}
