// yahoo.js — shared Yahoo Finance v8 chart access (keyless).
// The dvcap universe is authored in Yahoo symbol format (0981.HK, 000660.KS,
// 2330.TW, ^HSI, CL=F), and api/prices.js already proves this endpoint handles
// them. The macro spine reads through here so equities, indices, and oil all
// come from one keyless provider instead of a plan-gated one.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// ── CRUMB + COOKIE ──────────────────────────────────────────────────────────
// The v8 chart endpoint is keyless. The v7 endpoints are NOT, and have not been for some time:
// v7/finance/quote and v7/finance/options both answer 401 "Invalid Crumb" without one. Get a
// cookie from fc.yahoo.com, exchange it for a crumb, send both. Lifted out of api/prices.js so
// the options chain and the dividend fetch share one implementation rather than drifting apart.
function extractCookies(resp) {
  try {
    const arr = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
    const list = arr.length ? arr : (resp.headers.get("set-cookie") ? [resp.headers.get("set-cookie")] : []);
    return list.map(c => c.split(";")[0]).filter(Boolean);
  } catch { return []; }
}
export async function yahooAuth() {
  const cookies = [];
  try {
    const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    cookies.push(...extractCookies(r1));
  } catch { /* a missing cookie usually still yields a usable crumb */ }
  const cookieHeader = cookies.join("; ");
  let crumb = null;
  try {
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
      signal: AbortSignal.timeout(8000),
    });
    cookies.push(...extractCookies(r2));
    const text = (await r2.text()).trim();
    if (text && text.length < 50 && !text.includes("<")) crumb = text;
  } catch { /* caller treats a null crumb as "no v7 access" */ }
  return { crumb, cookie: cookies.join("; ") };
}

// Fetch one symbol's daily chart. A single request yields the live quote AND
// enough daily closes to compute 50/200d SMAs — so moving averages are sourced
// from real closes here, not from a provider's (unreliable) precomputed field.
// Returns { price, prevClose, changePct, ma50, ma200, dayLow, dayHigh, ts } or
// null on any failure. ts is epoch seconds (feeds the caller's stale flag).
export async function yahooChart(symbol, { range = "1y", interval = "1d" } = {}) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
      + `?interval=${interval}&range=${range}`;
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;

    // Daily closes for the SMA. Drop nulls (Yahoo pads gaps with null). The most
    // recent element is the current session's (possibly intraday) close — fine
    // for a read tool; the 50/200d level barely moves from including it.
    const closes = (result?.indicators?.quote?.[0]?.close || [])
      .filter(v => typeof v === "number");
    const sma = n => closes.length >= n
      ? closes.slice(-n).reduce((a, b) => a + b, 0) / n
      : null;

    const price = meta.regularMarketPrice ?? closes.at(-1) ?? null;

    // Previous close aligned to the EXCHANGE's OWN trading calendar. Pair each daily
    // bar with its timestamp, shift by the exchange's gmt offset to get the bar's LOCAL
    // date, then take the prior close = the last bar on a day STRICTLY BEFORE "today"
    // (today = the local date of regularMarketTime, i.e. the live tick). Because Yahoo
    // only emits bars for real trading days, this skips holidays automatically (Marine
    // Day, Lunar New Year, etc.) instead of blindly using closes.at(-2). Falls back to
    // closes.at(-2)/chartPreviousClose when timestamps are unavailable.
    const stamps = result?.timestamp || [];
    const rawCloses = result?.indicators?.quote?.[0]?.close || [];
    const off = meta.gmtoffset ?? 0;
    const localDay = t => { const d = new Date((t + off) * 1000);
      return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`; };
    const pairs = stamps
      .map((t, i) => ({ t, c: rawCloses[i] }))
      .filter(p => typeof p.c === "number");
    let prevClose = null;
    if (pairs.length) {
      const todayLocal = localDay(meta.regularMarketTime ?? pairs.at(-1).t);
      for (let i = pairs.length - 1; i >= 0; i--) {
        if (localDay(pairs[i].t) !== todayLocal) { prevClose = pairs[i].c; break; }
      }
    }
    if (prevClose == null) {
      prevClose = closes.length >= 2 ? closes.at(-2)
        : (meta.chartPreviousClose ?? meta.previousClose ?? null);
    }
    const changePct = (price != null && prevClose)
      ? ((price - prevClose) / prevClose) * 100
      : null;

    return {
      price,
      prevClose,
      changePct,
      ma50: sma(50),
      ma200: sma(200),
      dayLow: meta.regularMarketDayLow ?? null,
      dayHigh: meta.regularMarketDayHigh ?? null,
      ts: meta.regularMarketTime ?? null,
    };
  } catch {
    return null;
  }
}

// Latest EXTENDED-HOURS (pre/post-market) print, keyless. Kept separate from
// yahooChart because pre/post bars need an INTRADAY interval, whereas yahooChart uses
// daily bars for the SMA — one request can't serve both. Returns { price, ts, base }
// where `base` is the last REGULAR close (the reference for the pre/post % change), or
// null when there is no extended-hours bar after the regular close (e.g. the overnight
// dead zone) — callers then fall back to the regular/prior-close print.
// Trend snapshot for the regime inputs (gold/BTC): 1d/5d/20d % change, 50/200d SMA, and
// distance off the 52-week high — so the classifier can smooth its read and be MA-sanity
// checked. Fetches a 1-year daily series. Returns null on failure.
export async function yahooTrend(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const result = (await r.json())?.chart?.result?.[0];
    const meta = result?.meta;
    const closes = (result?.indicators?.quote?.[0]?.close || []).filter(v => typeof v === "number");
    if (!closes.length) return null;
    const price = meta?.regularMarketPrice ?? closes.at(-1);
    const chg = n => (closes.length > n && closes.at(-1 - n)) ? +(((price - closes.at(-1 - n)) / closes.at(-1 - n)) * 100).toFixed(2) : null;
    const sma = n => closes.length >= n ? +(closes.slice(-n).reduce((a, b) => a + b, 0) / n).toFixed(2) : null;
    const hi52 = Math.max(...closes);
    return {
      price, ts: meta?.regularMarketTime ?? null, prevClose: closes.at(-2) ?? meta?.chartPreviousClose ?? null,
      chg1d: chg(1), chg5d: chg(5), chg20d: chg(20),
      ma50: sma(50), ma200: sma(200),
      hi52, pctOffHi: hi52 ? +(((price - hi52) / hi52) * 100).toFixed(1) : null,
    };
  } catch {
    return null;
  }
}

// Today's low vs the prior session's low — the "lower low" structural tell. Needs the daily
// bars (yahooChart's meta only carries the CURRENT day's low), so it is its own small fetch.
// Returns null when there aren't two dated sessions to compare — never inferred from one bar.
export async function yahooLowerLow(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`;
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const result = (await r.json())?.chart?.result?.[0];
    const lows = (result?.indicators?.quote?.[0]?.low || []);
    const stamps = result?.timestamp || [];
    const off = result?.meta?.gmtoffset ?? 0;
    const day = t => new Date((t + off) * 1000).toISOString().slice(0, 10);
    const rows = stamps.map((t, i) => ({ date: day(t), low: lows[i] }))
      .filter(x => typeof x.low === "number");
    if (rows.length < 2) return null;
    const today = rows[rows.length - 1], prior = rows[rows.length - 2];
    return { dayLow: today.low, priorLow: prior.low, lowerLow: today.low < prior.low,
             date: today.date, priorDate: prior.date };
  } catch {
    return null;
  }
}

// P0.1 — last LIVE intraday bar during a regular session, keyless. yahooChart reads the DAILY
// endpoint, whose meta.regularMarketPrice can lag or serve a SETTLED prior close for some
// exchanges — HKEX on the keyless feed most notably — which renders an OPEN market as a stale
// prior-close print (SMIC/Tencent/Hua Hong dark while Korea/Japan/Taiwan are live). When the
// daily quote is stale-while-open, callers refetch here: the 5-minute series carries the real
// intraday tick. Returns { price, ts, dayLow, dayHigh } from the last real bar, or null.
export async function yahooIntradayLast(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`;
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const result = (await r.json())?.chart?.result?.[0];
    const stamps = result?.timestamp || [];
    const q = result?.indicators?.quote?.[0] || {};
    const closes = q.close || [], lows = q.low || [], highs = q.high || [];
    for (let i = stamps.length - 1; i >= 0; i--) {
      if (typeof closes[i] === "number") {
        const lo = lows.filter(v => typeof v === "number");
        const hi = highs.filter(v => typeof v === "number");
        return {
          price: closes[i], ts: stamps[i],
          dayLow: lo.length ? Math.min(...lo) : null,
          dayHigh: hi.length ? Math.max(...hi) : null,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// D4 — dated daily closes over ~3 months → { date: close } map, for cross-name correlation.
// Different exchanges keep different calendars, so callers align on COMMON dates rather than by
// index. Returns {} on any failure (a missing leg drops out of the correlation, never guesses).
export async function yahooDailyMap(symbol, range = '3mo') {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return {};
    const result = (await r.json())?.chart?.result?.[0];
    const stamps = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const map = {};
    for (let i = 0; i < stamps.length; i++) {
      if (typeof closes[i] === "number") map[new Date(stamps[i] * 1000).toISOString().slice(0, 10)] = closes[i];
    }
    return map;
  } catch {
    return {};
  }
}

// P2 — full daily OHLC bars, for ATR. yahooDailyMap above returns closes only, and true range
// needs the high, the low AND the previous close; yahooLowerLow already reads `.low` off this same
// block, so nothing new is being asked of the feed. Returns [{date, open, high, low, close}] oldest
// first, or [] on any failure — an empty series makes ATR null, which the guard panel renders as
// "no ATR for this symbol" rather than as a passing check.
//
// FOR FUTURES, PASS THE SPECIFIC CONTRACT (MGCZ26=F), NOT THE CONTINUOUS SYMBOL (GC=F). A roll gap
// is a discontinuity between two different instruments and true range scores it as a real day's
// move, inflating the ATR for a fortnight — the same fortnight in which the new contract is being
// sized.
export async function yahooDailyOHLC(symbol, range = "1y") {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const result = (await r.json())?.chart?.result?.[0];
    const stamps = result?.timestamp || [];
    const q = result?.indicators?.quote?.[0] || {};
    const off = result?.meta?.gmtoffset ?? 0;
    const day = t => new Date((t + off) * 1000).toISOString().slice(0, 10);
    const out = [];
    for (let i = 0; i < stamps.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
      // Yahoo pads non-trading days with nulls. A bar missing ANY leg is dropped whole rather
      // than half-filled: a high without its low produces a true range that is not a range.
      // Volume is carried but NOT required — ATR never needs it, and a bar with a good range and
      // a missing volume is still a good bar. It rides along so the GEX module can compute a
      // dollar ADV without a second fetch of the same series.
      if ([h, l, c].every(x => typeof x === "number") && h >= l) {
        out.push({ date: day(stamps[i]), open: typeof o === "number" ? o : null, high: h, low: l, close: c,
                   volume: typeof v === "number" ? v : null });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Several symbols, staggered — the same 120ms spacing api/prices.js uses, because the keyless
// endpoint starts refusing a burst and a refused fetch here silently becomes a missing ATR.
// Sequential on purpose: this runs for a handful of open rows, not a universe.
export async function yahooDailyOHLCBatch(symbols = [], range = "1y", gapMs = 120) {
  const out = {};
  const list = [...new Set((symbols || []).filter(Boolean))];
  for (let i = 0; i < list.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, gapMs));
    out[list[i]] = await yahooDailyOHLC(list[i], range);
  }
  return out;
}

export async function yahooPrePost(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
      + `?interval=5m&range=1d&includePrePost=true`;
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const result = (await r.json())?.chart?.result?.[0];
    const meta = result?.meta;
    const base = meta?.regularMarketPrice;
    const regTs = meta?.regularMarketTime;
    if (base == null || regTs == null) return null;

    const ts = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    // Walk back to the last traded bar; it's extended-hours only if it printed AFTER
    // the regular session close.
    for (let i = ts.length - 1; i >= 0; i--) {
      if (typeof closes[i] === "number") {
        return ts[i] > regTs ? { price: closes[i], ts: ts[i], base } : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
