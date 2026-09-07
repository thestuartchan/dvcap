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
// ── THE BATCH ENDPOINT ANSWERS WITH ONE PAIR PER TOKEN ───────────────────────
// Which quietly made corroboration impossible: asked about AU, /tokens/v1 returns its DEEPEST pair
// and nothing else — quoted against TSM, a tokenised stock nobody verified — so bestPair saw a
// single unvouched leg and refused. The token has nine pools, including a $38k USDG one at
// $0.001449 against the TSM pair's $0.001495. Three percent apart, and invisible.
//
// So the batch stays (one call per chain, and it settles most tokens outright) and anything it
// REFUSES is asked again through the per-token endpoint, which answers with the full set. Only the
// ambiguous cost a second call, and the count is capped.
export const PAIRS_BASE = 'https://api.dexscreener.com/token-pairs/v1';
export const MAX_FOLLOWUPS = 12;

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

// ── CORROBORATION, NOT AN ALLOW-LIST ─────────────────────────────────────────
// The first version pinned the quote leg to a handful of verified addresses. That is the right
// instinct and the wrong instrument: on Robinhood Chain the natural quote assets include TOKENISED
// STOCKS, so NUDES quoted against SNAP, ORBIO against NVDA and AU against TSM were all refused —
// $526k of liquidity and $1.6m of daily volume dismissed as "no market found", while the holder's
// own wallet priced them fine.
//
// What actually distinguishes a real price from a seeded one is not which token is on the other
// side. It is whether INDEPENDENT pools agree. NUDES trades in 17 pairs across five distinct quote
// legs — SNAP, USDG, WETH, AI, ETH — and eight of them sit within a few percent of $0.0165. The
// one that does not is 60,000x off, on $10 of daily volume, and is thrown out by the volume floor
// and by disagreement both.
//
// So: a pair passes if its quote leg is one we verified BY ADDRESS (the clone-proof case), or if
// enough independent legs corroborate it. A single seeded pool against a clone satisfies neither.
export const MIN_CORROBORATING_LEGS = 2;
export const AGREE_TOLERANCE = 0.25;      // a quarter, because pools drift and 60,000x is the case

const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };

export function bestPair(pairs = [], opts = {}) {
  const { quoteAllow = null } = opts;
  // Floors first, always — an untraded pool is not evidence of anything, however many of them agree.
  const graded = [], refused = [];
  for (const p of pairs) {
    const g = gradePair(p, { ...opts, quoteAllow: null });
    if (!g.ok) { refused.push({ why: g.why, liq: Number(p?.liquidity?.usd) || 0 }); continue; }
    graded.push({ ...g, pair: p, quoteAddr: lower(p?.quoteToken?.address) });
  }
  if (!graded.length) {
    // The DEEPEST failing pool's reason, not the last one looked at. "only 6 of liquidity" is a
    // true statement about some dead pool and a misleading answer about the token — the one worth
    // reporting is why the best candidate fell short.
    const best = refused.sort((a, b) => b.liq - a.liq)[0];
    return { ok: false, why: best ? best.why : 'no pair found' };
  }

  // Agreement is judged against the median of what survived the floors, so one wild pool cannot
  // drag the reference to itself.
  const mid = median(graded.map(g => g.price));
  const agreeing = graded.filter(g => Math.abs(g.price - mid) / mid <= AGREE_TOLERANCE);
  const legs = new Set(agreeing.map(g => g.quoteAddr));

  const vouched = quoteAllow ? agreeing.filter(g => quoteAllow.has(g.quoteAddr)) : agreeing;
  const corroborated = legs.size >= MIN_CORROBORATING_LEGS;
  const usable = vouched.length ? vouched : (corroborated ? agreeing : []);
  if (!usable.length) {
    // WHICH FAILURE IT WAS. After the agreement filter a token quoted by three mutually
    // contradictory pools looks identical to one quoted by a single pool — both leave one leg
    // standing. The distinction is how many pools were quoting BEFORE agreement was judged, and
    // it is the difference between "nothing corroborates this" and "nothing agrees on this".
    const distinctQuoting = new Set(graded.map(g => g.quoteAddr)).size;
    return { ok: false, why: distinctQuoting <= 1
      ? 'only one pool quotes it, and nothing verified is on the other side'
      : `its ${distinctQuoting} pools disagree — no majority to price from` };
  }
  // Depth decides among the survivors: it is what makes the price real rather than merely agreed.
  const best = usable.reduce((a, b) => (b.liquidity > a.liquidity ? b : a));
  return { ...best, legs: legs.size, pools: graded.length,
           basis: vouched.length ? 'verified quote' : `${legs.size} independent pools` };
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

    // Second pass, for the refused only — the batch showed them one pool, and one pool can neither
    // be corroborated nor vouched for unless it happens to be the right leg.
    const retry = [...out.entries()].filter(([, v]) => v.price == null).map(([a]) => a).slice(0, MAX_FOLLOWUPS);
    for (const addr of retry) {
      try {
        const r = await fetchImpl(`${PAIRS_BASE}/${chainSlug}/${addr}`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) continue;
        const all = await r.json();
        if (!Array.isArray(all) || !all.length) continue;
        const mine = all.filter(p => lower(p?.baseToken?.address) === addr);
        const b = bestPair(mine, { quoteAllow, ...opts });
        if (b.ok) out.set(addr, { price: b.price, liquidity: b.liquidity, volume: b.volume,
                                  quote: b.pair?.quoteToken?.symbol ?? null, dex: b.pair?.dexId ?? null,
                                  source: 'dex', pools: b.pools, basis: b.basis });
        else out.set(addr, { price: null, refused: b.why, source: 'dex' });
      } catch { /* the batch verdict stands */ }
    }
    return { ok: true, error: null, prices: out };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), prices: out };
  }
}
