// lib/smicah.js — SMIC A/H premium for the China-policy scenario leg (lib/assemble.js). The same
// computation also powers the Southbound card via api/indicators.js, which keeps its own inline
// copy (that endpoint is left untouched to avoid deploy risk); the math here mirrors it exactly.
// If one changes, change both. The A-share (688981.SS) has long traded far
// above the H line (0981.HK); the LEVEL is structurally large, so the SIGNAL is the TREND — a
// widening premium = mainland enthusiasm for the China-policy trade rising, a compressing one =
// fading. Computed as premium% = (A · (HKD/CNY) / H − 1) × 100, preferring the direct CNYHKD=X
// cross and falling back to the two USD legs. Null-safe throughout — any missing leg returns null
// rather than a half-computed premium.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
// Each attempt gets its own timeout signal — an AbortSignal is single-use, so a shared one would
// already be aborted on the retry and every retry would fail instantly.
const yopts = () => ({ headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// One symbol's 3-month daily closes → { price, asOf, map:{date:close} }. Falls back to the last
// daily close when the market is shut (regularMarketPrice null) so a closed A-share session does
// not sink the whole premium (all legs must resolve).
//
// RETRIES because Yahoo throttles bursts from datacenter IPs (429/503). All five legs used to be
// requested at once from a serverless function that already fires several other Yahoo calls in the
// same invocation, so the A-share leg — the one with no substitute — intermittently lost the race
// and sank the whole premium into "A-share quote down". api/prices.js staggers its requests for the
// same reason. One retry with a short backoff clears the transient case.
async function fetchYahooDaily(symbol, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    const got = await fetchYahooDailyOnce(symbol);
    if (got) return got;
    if (i < attempts - 1) await sleep(250 * (i + 1));
  }
  return null;
}

async function fetchYahooDailyOnce(symbol) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`, yopts());
    if (!r.ok) return null;
    const res = (await r.json())?.chart?.result?.[0];
    if (!res) return null;
    const ts = res.timestamp || [], closes = res.indicators?.quote?.[0]?.close || [];
    const map = {};
    for (let i = 0; i < ts.length; i++) if (closes[i] != null) map[new Date(ts[i] * 1000).toISOString().slice(0, 10)] = closes[i];
    const dates = Object.keys(map).sort();
    const lastClose = dates.length ? map[dates[dates.length - 1]] : null;
    const live = res.meta?.regularMarketPrice;
    const price = (live != null && live > 0) ? live : lastClose;
    const asOf = (live != null && live > 0 && res.meta?.regularMarketTime)
      ? new Date(res.meta.regularMarketTime * 1000).toISOString().slice(0, 10)
      : (dates[dates.length - 1] || null);
    return { price, asOf, map };
  } catch { return null; }
}

export async function fetchSmicAHPremium() {
  try {
    // Only THREE requests in the common path (the two legs + the direct cross). The USD fallback
    // pair is fetched only when the direct cross is unavailable — cutting the burst from 5 to 3
    // makes Yahoo far less likely to throttle the leg that matters (the A-share has no substitute).
    const [a, h, cross] = await Promise.all([
      fetchYahooDaily("688981.SS"), fetchYahooDaily("0981.HK"),
      fetchYahooDaily("CNYHKD=X"),                          // direct HKD-per-CNY — no convention ambiguity
    ]);
    // Report WHICH leg failed. The panel used to state "the A-share may not be on the price feed"
    // for every failure — a hardcoded guess, since nothing here told it what actually broke. A
    // premium that silently vanishes with a fabricated cause cannot be diagnosed, so failures now
    // name the missing legs and the consumer renders that instead of guessing.
    if (!a || !h) {
      const failed = [!a && "688981.SS (A-share)", !h && "0981.HK (H-share)"].filter(Boolean);
      return { premium: null, failed, reason: `price feed did not return ${failed.join(" + ")}` };
    }
    let cny = null, hkd = null;
    if (!(cross && cross.price > 0)) {
      [cny, hkd] = await Promise.all([fetchYahooDaily("CNY=X"), fetchYahooDaily("HKD=X")]);  // fallback: USDHKD / USDCNY
    }
    const fxAt = (d) => {
      if (cross && cross.map[d] > 0) return cross.map[d];
      if (cny && hkd && cny.map[d] > 0 && hkd.map[d] > 0) return hkd.map[d] / cny.map[d];
      return null;
    };
    const fxNow = (cross && cross.price > 0) ? cross.price
      : (cny && hkd && cny.price > 0 && hkd.price > 0) ? hkd.price / cny.price : null;
    if (fxNow == null) return { premium: null, failed: ["CNYHKD=X", "CNY=X", "HKD=X"], reason: "no CNY→HKD rate available (direct cross and both USD legs failed)" };
    const prem = (aCny, hHkd, fx) => (aCny != null && hHkd > 0 && fx > 0) ? +(((aCny * fx) / hHkd - 1) * 100).toFixed(1) : null;
    const latest = prem(a.price, h.price, fxNow);
    if (latest == null) return { premium: null, failed: [], reason: `legs returned but the premium did not compute (A ${a.price} · H ${h.price} · fx ${fxNow})` };
    const series = [];
    for (const d of Object.keys(a.map)) {
      const fx = fxAt(d);
      if (h.map[d] != null && fx != null) {
        const p = prem(a.map[d], h.map[d], fx);
        if (p != null) series.push({ date: d, premium: p });
      }
    }
    series.sort((x, y) => x.date.localeCompare(y.date));
    return {
      premium: latest, aPrice: a.price, hPrice: h.price, cnyHkd: +fxNow.toFixed(4),
      fxSource: (cross && cross.price > 0) ? "CNYHKD=X" : "USDHKD/USDCNY",
      asOf: a.asOf || h.asOf, series: series.slice(-30),
    };
  } catch (e) { return { premium: null, failed: [], reason: `fetch threw: ${String(e?.message || e).slice(0, 120)}` }; }
}
