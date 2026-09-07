// test/dexscreener.test.mjs — a price for a token no venue lists.
//
// The wallet prices off Hyperliquid, which is silent about anything Hyperliquid does not trade, so
// a real holding in a $1.6m pool sat unvalued beside genuine dust. Pool data fills that gap and
// brings its own failure mode: a pool RATIO is not a venue mid. It is a price only while there is
// depth behind it, and an untraded pool is how a burn address came to look worth $6.2tn.
//
// On Robinhood Chain the quote leg is worse than thin, it is ADVERSARIAL — deliberate fake USDG
// and WETH clones have been seeded into pools since July 2026 so they look tradeable. Hence the
// address pinning below, which is the assertion that matters most in this file.
import { gradePair, bestPair, fetchDexPrices, allowQuotes, NATIVE_QUOTE,
         MIN_LIQUIDITY_USD, MIN_VOLUME_H24_USD, MAX_ADDRESSES, DEX_CHAIN } from '../lib/dexscreener.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const REAL_USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const FAKE_USDG = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const pair = (o = {}) => ({
  baseToken: { address: '0xabc', symbol: 'MEME' },
  quoteToken: { address: REAL_USDG, symbol: 'USDG' },
  priceUsd: '0.09427', liquidity: { usd: 1_599_736 }, volume: { h24: 400_000 },
  dexId: 'uniswap', ...o,
});

// ── THE CLONE GATE ───────────────────────────────────────────────────────────
// A fake USDG is NAMED USDG. Matching the symbol is the attack succeeding, so the quote leg is
// pinned by address and nothing else is accepted.
{
  const allow = allowQuotes(REAL_USDG);
  ok('the real quote leg passes', gradePair(pair(), { quoteAllow: allow }).ok);
  const clone = gradePair(pair({ quoteToken: { address: FAKE_USDG, symbol: 'USDG' } }), { quoteAllow: allow });
  ok('an identically-named clone does not', !clone.ok);
  ok('and the refusal names what it was quoted against', /USDG/.test(clone.why));
  // The native asset is always allowed: a clone can impersonate a WETH contract and cannot occupy
  // the zero address, which is the one token whose identity is not a matter of which address you trust.
  ok('the native leg is allowed without being listed',
     gradePair(pair({ quoteToken: { address: NATIVE_QUOTE, symbol: 'ETH' } }), { quoteAllow: allow }).ok);
  eq('and allowQuotes always includes it', allowQuotes().has(NATIVE_QUOTE), true);
  ok('addresses are compared case-insensitively', allowQuotes(REAL_USDG.toUpperCase()).has(REAL_USDG.toLowerCase()));
  // With no allow-list the gate is off — for chains where nothing has been verified to pin to.
  ok('no allow-list means no pinning', gradePair(pair({ quoteToken: { address: FAKE_USDG, symbol: 'X' } })).ok);
}

// ── DEPTH AND VOLUME ─────────────────────────────────────────────────────────
// The $6.2tn number came from a real mid on a real pair nobody traded. Both floors, not one:
// liquidity can sit in a pool that never trades, and volume can be wash traded over no depth.
{
  ok('a thin pool is refused', !gradePair(pair({ liquidity: { usd: 500 } })).ok);
  ok('naming the shortfall', /liquidity/.test(gradePair(pair({ liquidity: { usd: 500 } })).why));
  ok('an untraded pool is refused', !gradePair(pair({ volume: { h24: 12 } })).ok);
  ok('naming that too', /24h/.test(gradePair(pair({ volume: { h24: 12 } })).why));
  ok('deep and traded passes', gradePair(pair()).ok);
  eq('the floors are declared, not buried', [MIN_LIQUIDITY_USD, MIN_VOLUME_H24_USD], [25_000, 10_000]);
  // A missing or nonsensical price is refused before any of that.
  for (const bad of [null, '0', 'abc', '-1'])
    ok(`a price of ${JSON.stringify(bad)} is not a price`, !gradePair(pair({ priceUsd: bad })).ok);
  // Absent liquidity/volume read as zero, not as "unknown, allow it".
  ok('missing depth is treated as none', !gradePair(pair({ liquidity: undefined })).ok);
  ok('missing volume likewise', !gradePair(pair({ volume: undefined })).ok);
}

// ── THE DEEPEST ACCEPTABLE PAIR WINS ─────────────────────────────────────────
// Dexscreener answers several pairs for one token and they do not agree — four MEME/USDG pairs
// were live at once, from $76k to $1.6m of liquidity. Depth is the tiebreaker because it is what
// decides whether the price is real.
{
  const b = bestPair([
    pair({ priceUsd: '0.0928', liquidity: { usd: 76_342 } }),
    pair({ priceUsd: '0.09429', liquidity: { usd: 1_600_063 } }),
    pair({ priceUsd: '0.09491', liquidity: { usd: 158_549 } }),
  ]);
  eq('the deepest pair sets the price', b.price, 0.09429);
  eq('and its depth travels with it', b.liquidity, 1_600_063);
  // A deeper pair that FAILS a gate does not win by being deep.
  const c = bestPair([pair({ priceUsd: '1', liquidity: { usd: 9e9 }, volume: { h24: 3 } }),
                      pair({ priceUsd: '0.09', liquidity: { usd: 50_000 } })]);
  eq('a deeper but untraded pair is skipped', c.price, 0.09);
  // Nothing acceptable is a refusal with a reason, never a silent null.
  const none = bestPair([pair({ liquidity: { usd: 10 } })]);
  ok('no acceptable pair still explains itself', !none.ok && /liquidity/.test(none.why));
  eq('and an empty list says so', bestPair([]).why, 'no pair found');
}

// ── FETCHING ─────────────────────────────────────────────────────────────────
{
  const calls = [];
  const stub = async (url) => { calls.push(url); return { ok: true, json: async () => ([
    pair({ baseToken: { address: '0xAAA', symbol: 'MEME' } }),
    // A pair naming a token we did NOT ask about must not become a price for one we did.
    pair({ baseToken: { address: '0xZZZ', symbol: 'OTHER' } }),
  ]) }; };
  const r = await fetchDexPrices({ chainSlug: 'robinhood', addresses: ['0xaaa'], fetchImpl: stub });
  eq('only the tokens asked about come back', [...r.prices.keys()], ['0xaaa']);
  eq('keyed lower-case, since the caller may not be', r.prices.get('0xaaa').price, 0.09427);
  eq('carrying which pool it came from', r.prices.get('0xaaa').quote, 'USDG');

  // Batched, because one call per token is a call per token.
  const many = Array.from({ length: 47 }, (_, i) => '0x' + String(i).padStart(40, '0'));
  calls.length = 0;
  await fetchDexPrices({ chainSlug: 'robinhood', addresses: many, fetchImpl: stub });
  eq('47 addresses is two requests, not 47', calls.length, 2);
  ok('and neither exceeds the documented ceiling',
     calls.every(u => u.split('/').pop().split(',').length <= MAX_ADDRESSES));

  // Failure is reported, never guessed around.
  const http = await fetchDexPrices({ chainSlug: 'robinhood', addresses: ['0xa'], fetchImpl: async () => ({ ok: false, status: 429 }) });
  eq('a rate limit is named', [http.ok, http.error], [false, 'HTTP 429']);
  const junk = await fetchDexPrices({ chainSlug: 'robinhood', addresses: ['0xa'], fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  ok('an unexpected shape is refused rather than parsed hopefully', !junk.ok);
  const threw = await fetchDexPrices({ chainSlug: 'robinhood', addresses: ['0xa'], fetchImpl: async () => { throw new Error('ETIMEDOUT'); } });
  eq('and a throw returns nothing as data', [threw.ok, threw.prices.size], [false, 0]);
  eq('nothing to price is not an error worth raising', (await fetchDexPrices({ chainSlug: 'robinhood', addresses: [] })).prices.size, 0);
}

// ── THE CHAIN SLUGS WERE PROBED ──────────────────────────────────────────────
// Verified 2026-09-07 by asking each slug for a known token and reading what came back — including
// that its WETH agrees with Hyperliquid's mark to within a few basis points on two chains.
eq('one slug per chain', Object.keys(DEX_CHAIN).sort(), ['arbitrum', 'base', 'ethereum', 'hyperevm', 'polygon', 'robinhood']);

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
