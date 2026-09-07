// lib/alchemy.js — which tokens an address holds, which the chain itself cannot say.
//
// THE THING THAT IS NOT ON CHAIN. An ERC-20 balance lives inside each token's own contract, in a
// mapping keyed by holder. So a node answers "how much USDC does this address hold" instantly and
// has no answer at all for "what does this address hold" — there is no index, because nothing
// writes one. Native ETH is different: that sits in the account state, which is why every chain
// showed ETH and only listed tokens appeared beside it.
//
// Enumerating therefore needs something that has replayed every Transfer event and built the
// reverse index. That is what this is. Without a key the wallet falls back to the verified token
// list in lib/chains.js — complete for majors, blind to everything else — and says which mode it
// is in, because "you hold nothing else" and "I cannot see anything else" are different claims.
//
// Blockscout's public instances were tried first, to avoid needing a key at all: 503 or empty on
// all four majors.

export const ALCHEMY_KEY_ENV = 'ALCHEMY_API_KEY';
export const alchemyKey = () => String(process.env[ALCHEMY_KEY_ENV] || '').trim() || null;
export const alchemyConfigured = () => !!alchemyKey();

// Alchemy passes the key as a PATH SEGMENT, so the URL is a credential. It must never reach a log,
// an error message or a response body — every throw below goes through `redact` first.
export const alchemyUrl = (network, key) => `https://${network}.g.alchemy.com/v2/${key}`;
export function redact(text, key = alchemyKey()) {
  const s = String(text ?? '');
  const noKey = key ? s.split(key).join('«key»') : s;
  // Belt and braces: strip anything shaped like the path even if the key differs from the current one.
  return noKey.replace(/(g\.alchemy\.com\/v2\/)[^\s/"']+/g, '$1«key»');
}

// One page is 100 tokens. Five pages is 500, which is far past any real wallet and is the point:
// a bound that a junk-airdropped address cannot turn into an unbounded request on every page load.
export const MAX_PAGES = 5;
export const PAGE_SIZE = 100;

// Verified 2026-09-07 by probing each host: all six answer "Must be authenticated!" with no key,
// while an invented slug does not resolve at all — so these names exist and are not guesses.
export const NETWORKS = Object.freeze({
  ethereum: 'eth-mainnet',
  arbitrum: 'arb-mainnet',
  base: 'base-mainnet',
  polygon: 'polygon-mainnet',
  hyperevm: 'hyperliquid-mainnet',
  robinhood: 'robinhood-mainnet',
});

// Non-zero balances only. A wallet that once touched a token keeps its zero row forever otherwise,
// and an address with five hundred dead airdrops is exactly the case this has to survive.
const nonZero = (hex) => { try { return BigInt(hex || '0x0') > 0n; } catch { return false; } };

export async function discoverTokens({ network, address, key = alchemyKey(), timeoutMs = 10000,
                                       maxPages = MAX_PAGES, fetchImpl = fetch } = {}) {
  if (!key) return { ok: false, configured: false, error: `${ALCHEMY_KEY_ENV} is not set`, tokens: [], pages: 0, truncated: false };
  if (!network) return { ok: false, configured: true, error: 'no Alchemy network for this chain', tokens: [], pages: 0, truncated: false };
  if (!address) return { ok: false, configured: true, error: 'no address configured', tokens: [], pages: 0, truncated: false };
  const url = alchemyUrl(network, key);
  const out = [];
  let pageKey, pages = 0;
  try {
    do {
      const r = await fetchImpl(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenBalances',
                               params: [address, 'erc20', { maxCount: PAGE_SIZE, ...(pageKey ? { pageKey } : {}) }] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) return { ok: false, configured: true, error: `HTTP ${r.status}`, tokens: out, pages, truncated: false };
      const j = await r.json();
      if (j?.error) return { ok: false, configured: true, error: redact(j.error.message || 'RPC error'), tokens: out, pages, truncated: false };
      for (const b of (j?.result?.tokenBalances || [])) {
        if (b?.error || !b?.contractAddress || !nonZero(b.tokenBalance)) continue;
        out.push({ address: String(b.contractAddress), raw: String(b.tokenBalance) });
      }
      pageKey = j?.result?.pageKey;
      pages += 1;
    } while (pageKey && pages < maxPages);
    // Truncation is REPORTED, never silent — a capped list that looks complete is the one failure
    // this whole file exists to remove.
    return { ok: true, configured: true, error: null, tokens: out, pages, truncated: !!pageKey };
  } catch (e) {
    return { ok: false, configured: true, error: redact(e?.message || e), tokens: out, pages, truncated: false };
  }
}
