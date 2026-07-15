// tradingview.js — keyless access to TradingView's public scanner quote (the endpoint
// their embeddable widgets call). Used ONLY for instruments no other keyless feed
// carries — notably the VKOSPI FUTURES (KRX:VKI1!, "V-KOSPI Futures"), which Yahoo and
// CNBC don't list and Investing.com bot-walls from datacenter IPs.
//
// CAVEATS (by design, callers degrade to a "no print" row on any of these):
//   • ~20-min delayed (update_mode "delayed_streaming_1200").
//   • It's TradingView's internal widget endpoint — best-effort. It can rate-limit,
//     change shape, or block server IPs. Never let a failure here break a Pre-Read.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
         + "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Fetch one TradingView symbol (e.g. "KRX:VKI1!") → { last, changePct, changeAbs,
// session } or null on any failure. `last` is the current bar's price (matches the
// widget/chart); `session` is "market" when the contract is actively trading.
export async function tvQuote(symbol) {
  const fields = "close,change,change_abs,current_session,update_mode";
  const url = `https://scanner.tradingview.com/symbol`
    + `?symbol=${encodeURIComponent(symbol)}&fields=${fields}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (j == null || j.close == null) return null;   // symbol resolved but no price → miss
    return {
      last: j.close,
      changePct: typeof j.change === "number" ? j.change : null,
      changeAbs: typeof j.change_abs === "number" ? j.change_abs : null,
      session: j.current_session ?? null,
      updateMode: j.update_mode ?? null,
    };
  } catch {
    return null;
  }
}
