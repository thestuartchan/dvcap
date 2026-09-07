// lib/chains.js — the chains a wallet is read on, and what can be read there.
//
// EVERY ADDRESS BELOW WAS VERIFIED AGAINST THE CHAIN, not recalled. Each contract was asked its
// own symbol() and decimals() through Multicall3 on 2026-09-07 and the answers are what is written
// here. Three of the names I started with were wrong and the chain corrected them:
//
//   Arbitrum 0xFd08…Fcbb9  I called it USDT; it answers USD₮0 — Tether's rebrand, unicode and all
//   Polygon  0xc213…58e8F  same, answers USDT0
//   Polygon  0x2791…84174  the bridged leg, which answers plain USDC like the native one
//
// A wrong address does not error. It reads another token's balance and reports it under a name you
// trust, which is the whole reason for checking rather than remembering.
//
// PRICING COMES FROM HYPERLIQUID, NOT FROM A TICKER LOOKUP. Measured the same day: Yahoo and HL
// agree to within 0.1% on ETH, BTC and LINK — and differ by 266x on ARB (0.000629 against 0.16753)
// and 12x on POL (0.0082 against 0.096535). Those Yahoo tickers are other instruments entirely,
// which is the same collision that made HYPE-USD a million times off and put a Grayscale trust
// behind a bare BTC. `hl` below is the venue symbol to price against; null means do not price it.

// Multicall3 at its canonical cross-chain address. Verified deployed on all six chains here.
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

// `hl` is the HYPERLIQUID symbol to price against — a perp mark where one exists, otherwise the
// spot pair. `par` marks a token that is a claim on one US dollar and has no venue quote at all;
// those are priced at 1.00 and the row SAYS SO, because an assumed par is not a measured price and
// a depeg is exactly when the difference matters.
const t = (symbol, address, decimals, hl, label, par) =>
  ({ symbol, address, decimals, hl: hl ?? null, label: label ?? null, par: !!par });

export const CHAINS = Object.freeze({
  // Listed first: it is the one with a venue behind it, so its token set comes from the venue's own
  // metadata rather than from a list maintained here.
  hyperevm: {
    id: 999, label: 'HyperEVM', rpc: 'https://rpc.hyperliquid.xyz/evm',
    native: t('HYPE', null, 18, 'HYPE'),
    tokensFrom: 'hyperliquid',        // lib/wallet.js reads spotMeta for this one
    tokens: [],
  },
  ethereum: {
    id: 1, label: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com',
    native: t('ETH', null, 18, 'ETH'),
    tokens: [
      t('USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, 'USDC'),
      t('USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6, 'USDT0'),
      t('DAI',  '0x6B175474E89094C44Da98b954EedeAC495271d0F', 18, null, null, true),
      t('WETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18, 'ETH'),
      t('WBTC', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 8,  'BTC'),
      t('LINK', '0x514910771AF9Ca656af840dff83E8264EcF986CA', 18, 'LINK'),
    ],
  },
  arbitrum: {
    id: 42161, label: 'Arbitrum', rpc: 'https://arb1.arbitrum.io/rpc',
    native: t('ETH', null, 18, 'ETH'),
    tokens: [
      t('USDC',  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6, 'USDC'),
      t('USDT0', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6, 'USDT0', 'USD₮0'),
      t('WETH',  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 18, 'ETH'),
      t('WBTC',  '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', 8,  'BTC'),
      t('ARB',   '0x912CE59144191C1204E64559FE8253a0e49E6548', 18, 'ARB'),
      t('DAI',   '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 18, null, null, true),
    ],
  },
  base: {
    id: 8453, label: 'Base', rpc: 'https://mainnet.base.org',
    native: t('ETH', null, 18, 'ETH'),
    tokens: [
      t('USDC',  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6, 'USDC'),
      t('WETH',  '0x4200000000000000000000000000000000000006', 18, 'ETH'),
      t('DAI',   '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', 18, null, null, true),
      t('cbBTC', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 8,  'BTC'),
    ],
  },
  polygon: {
    id: 137, label: 'Polygon', rpc: 'https://polygon-bor-rpc.publicnode.com',
    native: t('POL', null, 18, 'POL'),
    tokens: [
      t('USDC',   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6, 'USDC'),
      // The bridged leg answers "USDC" too, so the label is what tells them apart on screen.
      t('USDC.e', '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 6, 'USDC', 'bridged'),
      t('USDT0',  '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6, 'USDT0'),
      t('DAI',    '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', 18, null, null, true),
      t('WETH',   '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 18, 'ETH'),
      t('WBTC',   '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', 8,  'BTC'),
      t('WPOL',   '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', 18, 'POL'),
    ],
  },
  // ── ROBINHOOD CHAIN: NATIVE ONLY, AND SAYING SO ─────────────────────────────────────────────
  // Chain 4663, its own RPC, Multicall3 present — all verified. What is NOT here is a token list:
  // the chain carries tokenised real-world assets whose addresses are not something to guess at,
  // and its Blockscout explorer sits behind Cloudflare, so a serverless function cannot enumerate
  // them. Native balance is read and the section says the rest is unlisted rather than implying a
  // wallet holds nothing. Add addresses here once they are known — and verify them first.
  robinhood: {
    id: 4663, label: 'Robinhood Chain', rpc: 'https://rpc.mainnet.chain.robinhood.com',
    native: t('ETH', null, 18, 'ETH'),
    // ── PINNED BY ADDRESS, AND ON THIS CHAIN THAT IS NOT PEDANTRY ────────────────────────────
    // Both taken from Robinhood's own contract docs and then confirmed against the chain: WETH at
    // 18 decimals, USDG at 6. They are pinned because since July 2026 this chain has carried
    // deliberate FAKE USDG and WETH clones, deployed at other addresses and seeded into pools so
    // they look tradeable. Matching on the symbol here would not be an approximation, it would be
    // the attack working — so a token is priced only when its ADDRESS is one of these.
    tokens: [
      t('WETH', '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', 18, 'ETH'),
      t('USDG', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, null, 'Global Dollar', true),
    ],
    // Everything else on this chain — the stock tokens and whatever else lands in a wallet — has
    // no venue quoting it, so it is listed and left unvalued rather than guessed at.
    tokensUnlisted: true,
  },
});

export const CHAIN_KEYS = Object.freeze(Object.keys(CHAINS));

// ── CHAIN MARKS, FOR THE DISCORD CARD ────────────────────────────────────────
// Unicode has no chain logos, so these are the closest legible stand-ins and they work with no
// setup at all. Real logos are possible but they are CUSTOM DISCORD EMOJI, which live on one server
// and are referenced by id as <:name:1234567890>. To use them, upload the logos to the server and
// set DISCORD_CHAIN_EMOJI to a JSON object of chain label -> emoji string; anything not named there
// falls back to the marks below, so a partial map is fine.
//
// Chosen to be distinguishable at a glance rather than merely accurate: Robinhood's mark really is
// a feather, Base's really is a blue circle, and Ethereum's diamond has its own glyph.
const CHAIN_MARK = Object.freeze({
  'Ethereum': '⟠',
  'Arbitrum': '🔷',
  'Base': '🔵',
  'Polygon': '🟣',
  'HyperEVM': '🌊',
  'Hyperliquid': '🌊',
  'Robinhood Chain': '🪶',
});
const MARK_FALLBACK = '⬦';

// Parsed once. A malformed override must not take the card down, so every failure path returns an
// empty map and the built-in marks stand.
let overrideCache = null, overrideRaw = null;
function overrides(env) {
  const raw = (env.DISCORD_CHAIN_EMOJI || '').trim();
  if (raw === overrideRaw) return overrideCache || {};
  overrideRaw = raw;
  overrideCache = {};
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        for (const [k, v] of Object.entries(o)) {
          // A stray newline or an over-long value would break the card's layout rather than the
          // card, which is worse — it looks like a bug in the data. Reject instead.
          if (typeof v === 'string' && v.length <= 64 && !/[\r\n]/.test(v)) overrideCache[k] = v.trim();
        }
      }
    } catch { overrideCache = {}; }
  }
  return overrideCache;
}

export function chainMark(label, env = process.env) {
  if (!label) return MARK_FALLBACK;
  const key = String(label);
  return overrides(env)[key] || CHAIN_MARK[key] || MARK_FALLBACK;
}

// Every venue symbol any chain needs a price for — what to ask Hyperliquid, once, for all of them.
export const pricedSymbols = () => [...new Set(
  Object.values(CHAINS).flatMap(c => [c.native?.hl, ...c.tokens.map(x => x.hl)]).filter(Boolean)
)].sort();
