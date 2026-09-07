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
         MIN_CORROBORATING_LEGS, AGREE_TOLERANCE,
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

// ── CORROBORATION, BECAUSE THE ALLOW-LIST WAS THE WRONG INSTRUMENT ───────────
// Pinning the quote leg to a few verified addresses is the right instinct and too blunt: on
// Robinhood Chain the natural quote assets include TOKENISED STOCKS, so NUDES quoted against SNAP,
// ORBIO against NVDA and AU against TSM were all refused — $526k of liquidity and $1.6m of daily
// volume dismissed as "no market found" while the holder's own wallet priced them fine.
//
// What separates a real price from a seeded one is not which token is opposite. It is whether
// INDEPENDENT pools agree.
{
  const leg = (addr, price, liq = 200_000) => ({
    baseToken: { address: '0xabc', symbol: 'NUDES' },
    quoteToken: { address: addr, symbol: addr.slice(0, 6) },
    priceUsd: String(price), liquidity: { usd: liq }, volume: { h24: 500_000 },
  });
  const SNAP = '0x1111111111111111111111111111111111111111';
  const NVDA = '0x2222222222222222222222222222222222222222';
  const TSM  = '0x3333333333333333333333333333333333333333';
  const VERIFIED = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

  // A LONE POOL against something nobody verified is exactly the seeded-clone shape.
  const alone = bestPair([leg(SNAP, 0.0165)], { quoteAllow: allowQuotes(VERIFIED) });
  ok('one pool and no verified leg is refused', !alone.ok);
  ok('and says why in those terms', /only one pool/.test(alone.why));

  // Two distinct legs agreeing is evidence. This is the case that was being thrown away.
  const two = bestPair([leg(SNAP, 0.0172), leg(NVDA, 0.0166)], { quoteAllow: allowQuotes(VERIFIED) });
  ok('two independent legs that agree is enough', two.ok);
  eq('and it says what the basis was', two.basis, '2 independent pools');
  eq('the threshold is declared', MIN_CORROBORATING_LEGS, 2);

  // TWO POOLS ON THE SAME LEG IS ONE OPINION. Independence is about the quote token, not the count.
  const same = bestPair([leg(SNAP, 0.0172), leg(SNAP, 0.0166)], { quoteAllow: allowQuotes(VERIFIED) });
  ok('two pools against the SAME leg is still one leg', !same.ok);

  // A verified leg needs no corroboration — that is the clone-proof path, kept.
  const vouched = bestPair([leg(VERIFIED, 0.0165)], { quoteAllow: allowQuotes(VERIFIED) });
  ok('a verified quote leg stands alone', vouched.ok);
  eq('and says so', vouched.basis, 'verified quote');

  // THE OUTLIER. A real pool on NUDES quoted 0.0000002795 against a true 0.0165 — 60,000x off, on
  // $10 of daily volume. Thrown out by the volume floor AND by disagreement, and it must not drag
  // the reference price with it.
  const withJunk = bestPair([leg(SNAP, 0.0172), leg(NVDA, 0.0166), leg(TSM, 0.0000002795)],
                            { quoteAllow: allowQuotes(VERIFIED) });
  ok('a 60,000x outlier does not win', withJunk.ok && withJunk.price > 0.01);
  eq('nor does it count as a corroborating leg', withJunk.legs, 2);
  eq('the tolerance is declared', AGREE_TOLERANCE, 0.25);

  // Legs that all disagree corroborate nothing, however many there are.
  const chaos = bestPair([leg(SNAP, 1), leg(NVDA, 100), leg(TSM, 10_000)], { quoteAllow: allowQuotes(VERIFIED) });
  ok('mutual disagreement is not corroboration', !chaos.ok);
  ok('and says the pools disagree', /disagree/.test(chaos.why));

  // Depth still decides among survivors, and the floors still come first.
  const deep = bestPair([leg(SNAP, 0.0166, 100_000), leg(NVDA, 0.0167, 900_000)], { quoteAllow: allowQuotes(VERIFIED) });
  eq('the deepest agreeing pool sets the price', deep.price, 0.0167);
  const thin = bestPair([leg(SNAP, 0.0166, 900), leg(NVDA, 0.0167, 800)], { quoteAllow: allowQuotes(VERIFIED) });
  ok('agreement cannot rescue two dead pools', !thin.ok);

  // The refusal names the DEEPEST failing pool, not whichever was looked at last — "only 6 of
  // liquidity" is true of some dead pool and misleading about the token.
  const why = bestPair([leg(SNAP, 0.0166, 6), leg(NVDA, 0.0167, 13_523)], { quoteAllow: allowQuotes(VERIFIED) }).why;
  ok('the reported shortfall is the best candidate’s', /13,523/.test(why));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
