// lib/dexscreener.js — a price for a token no venue lists.
//
// The wallet prices off Hyperliquid, which is right for anything Hyperliquid trades and useless
// for everything else: a token on a chain months old has no perp and no spot pair, so it was
// listed unvalued and left out of the total. That is honest but unhelpful when the thing has a
// real market — MEME on Robinhood Chain sits in a pool with $1.6m of liquidity.
//
// Dexscreener indexes those pools and publishes priceUsd, liquidity and 24-hour volume, keyless.
// Cross-checked 2026-09-07 where an independent quote exists: its WETH reads 2493.42 on Robinhood
// and 2493.87 on Ethereum against Hyperliquid's 2494 mark, and its ARB and POL land within 1.3% of
// the venue's. Three sources agreeing to a few basis points is why this is usable at all.
//
// ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
// A pool ratio is not a venue mid. It is a price only while there is depth behind it, and the
// failure mode is spectacular rather than subtle: an untraded pool is how a burn address came to
// look worth 6.2 trillion dollars. Worse, on Robinhood Chain the quote leg is ADVERSARIAL —
// deliberate fake USDG and WETH clones have been seeded into pools since July 2026 so they look
// tradeable, and a pair quoted against a clone yields a confident wrong number.
//
// So three gates, all of which must pass: enough liquidity, enough real volume, and — where the
// chain has verified quote legs — a quote token pinned BY ADDRESS to one of them.

export const DEX_BASE = 'https://api.dexscreener.com/tokens/v1';

// Verified 2026-09-07 by asking each slug for a known token and checking what came back.
export const DEX_CHAIN = Object.freeze({
  ethereum: 'ethereum', arbitrum: 'arbitrum', base: 'base',
  polygon: 'polygon', hyperevm: 'hyperevm', robinhood: 'robinhood',
});

// A pool with less than this behind it is not a market, and its ratio is not a price.
export const MIN_LIQUIDITY_USD = 25_000;
export const MIN_VOLUME_H24_USD = 10_000;
// The endpoint takes a comma-separated list; 30 is its documented ceiling.
export const MAX_ADDRESSES = 30;

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const lower = (a) => String(a || '').toLowerCase();

// The chain's own native asset, which Dexscreener quotes at the zero address. Always allowed as a
// quote leg: a clone can impersonate a WETH contract, and cannot occupy the zero address — that is
// the one token on any chain whose identity is not a matter of which address you trust.
export const NATIVE_QUOTE = '0x0000000000000000000000000000000000000000';
export const allowQuotes = (...addresses) =>
  new Set([NATIVE_QUOTE, ...addresses.flat().filter(Boolean).map(lower)]);

// Why a pair was refused, in words, because "no price" and "a price I would not stand behind" are
// different answers and the row should be able to say which.
export function gradePair(pair, { quoteAllow = null, minLiquidity = MIN_LIQUIDITY_USD,
                                  minVolume = MIN_VOLUME_H24_USD } = {}) {
  const price = num(pair?.priceUsd);
  if (price == null || price <= 0) return { ok: false, why: 'no usable price' };
  const liq = num(pair?.liquidity?.usd) ?? 0;
  const vol = num(pair?.volume?.h24) ?? 0;
  // The anti-clone gate, and the reason it is by address: a fake USDG is named USDG.
  if (quoteAllow && !quoteAllow.has(lower(pair?.quoteToken?.address)))
    return { ok: false, why: `quoted against an unrecognised ${pair?.quoteToken?.symbol || 'token'}` };
  if (liq < minLiquidity) return { ok: false, why: `only ${Math.round(liq).toLocaleString()} of liquidity` };
  if (vol < minVolume) return { ok: false, why: `only ${Math.round(vol).toLocaleString()} traded in 24h` };
  return { ok: true, why: null, price, liquidity: liq, volume: vol };
}

// The deepest acceptable pair wins. Dexscreener may answer several for one token and they do not
// agree; depth is the tiebreaker because it is the one that decides whether the price is real.
export function bestPair(pairs = [], opts = {}) {
  let best = null, lastWhy = 'no pair found';
  for (const p of pairs) {
    const g = gradePair(p, opts);
    if (!g.ok) { lastWhy = g.why; continue; }
    if (!best || g.liquidity > best.liquidity) best = { ...g, pair: p };
  }
  return best || { ok: false, why: lastWhy };
}

export async function fetchDexPrices({ chainSlug, addresses = [], quoteAllow = null,
                                       timeoutMs = 8000, fetchImpl = fetch, ...opts } = {}) {
  const out = new Map();
  if (!chainSlug || !addresses.length) return { ok: false, error: 'nothing to price', prices: out };
  const wanted = new Set(addresses.map(lower));
  try {
    for (let i = 0; i < addresses.length; i += MAX_ADDRESSES) {
      const batch = addresses.slice(i, i + MAX_ADDRESSES);
      const r = await fetchImpl(`${DEX_BASE}/${chainSlug}/${batch.join(',')}`,
                                { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, prices: out };
      const j = await r.json();
      if (!Array.isArray(j)) return { ok: false, error: 'unexpected response', prices: out };
      // Group by the token we ASKED about — a pair names two tokens and only one of them is ours.
      const byToken = new Map();
      for (const p of j) {
        const base = lower(p?.baseToken?.address);
        if (!wanted.has(base)) continue;
        if (!byToken.has(base)) byToken.set(base, []);
        byToken.get(base).push(p);
      }
      for (const [addr, pairs] of byToken) {
        const b = bestPair(pairs, { quoteAllow, ...opts });
        out.set(addr, b.ok
          ? { price: b.price, liquidity: b.liquidity, volume: b.volume,
              quote: b.pair?.quoteToken?.symbol ?? null, dex: b.pair?.dexId ?? null, source: 'dex' }
          : { price: null, refused: b.why, source: 'dex' });
      }
    }
    return { ok: true, error: null, prices: out };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), prices: out };
  }
}
