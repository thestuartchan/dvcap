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

import { limiter } from './throttle.js';

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

// ── NOT MORE AT ONCE THAN ALCHEMY WILL ANSWER ────────────────────────────────
// lib/wallet.js reads all six chains with Promise.all, and each chain makes two calls, so a single
// wallet read fired twelve Alchemy requests SIMULTANEOUSLY. Alchemy's free tier limits requests per
// second rather than per month, and twelve at once from a serverless function is a burst that trips
// it — the daily volume is nowhere near the monthly allowance, so this was never a quota problem
// and a smaller quota would not have fixed it.
//
// The gate is module-level on purpose: it applies to every caller, so a future third call site
// cannot widen the burst without noticing this. Four is comfortably under the limit and costs a
// wallet read almost nothing, because these requests were never the slow part.
//
// Every request in this file goes through `gated`. Nothing calls fetch directly, and there is a
// source-scan test asserting that stays true.
const alchemyGate = limiter(4);
const gated = (fetchImpl, url, init) => alchemyGate(() => fetchImpl(url, init));

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
      const r = await gated(fetchImpl, url, {
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

// ── HOW IT GOT THERE, WHICH IS NOT THE SAME AS WHAT IT IS WORTH ──────────────
// Holding a token back from the total because nothing vouches for the CONTRACT punished tokens the
// holder had deliberately swapped for. That is the wrong question asked of the wrong party: what
// separates "I chose this" from "this was dropped on me" is not the contract's reputation, it is
// whether the wallet ever gave anything up to get it.
//
// The chain says so plainly. A swap is one transaction in which the address BOTH sends and
// receives; an airdrop is a transfer in, with nothing going out. So: collect the hashes this
// address sent value in, and a token whose arrival shares one of those hashes was paid for.
//
// Cheap and decisive, and it does not care whether the token is good — a scam someone bought is
// still a position they took, and a legitimate token dropped unbidden is still not a decision.
export const ACQUIRED = 'swapped';
export const UNSOLICITED = 'received';
// A normal wallet's history fits in one page each way; the cap stops an address with tens of
// thousands of dust transfers from becoming an unbounded read on every page load.
export const MAX_TRANSFER_PAGES = 2;

const asHash = (t) => String(t?.hash || '').toLowerCase();
const contractOf = (t) => String(t?.rawContract?.address || '').toLowerCase();

export async function fetchAcquisition({ network, address, key = alchemyKey(), timeoutMs = 10000,
                                         maxPages = MAX_TRANSFER_PAGES, fetchImpl = fetch } = {}) {
  const out = new Map();
  if (!key || !network || !address) return { ok: false, error: 'not configured', acquisition: out };
  const url = alchemyUrl(network, key);
  const page = async (params) => {
    const r = await gated(fetchImpl, url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j?.error) throw new Error(redact(j.error.message || 'RPC error', key));
    return j?.result || {};
  };
  const collect = async (direction) => {
    const rows = [];
    let pageKey, n = 0;
    do {
      const res = await page({
        fromBlock: '0x0', toBlock: 'latest', ...direction,
        // Native sends count: paying ETH for a token is the clearest swap there is.
        category: ['erc20', 'external'], excludeZeroValue: true, maxCount: '0x3e8',
        ...(pageKey ? { pageKey } : {}),
      });
      rows.push(...(res.transfers || []));
      pageKey = res.pageKey; n += 1;
    } while (pageKey && n < maxPages);
    return rows;
  };
  try {
    const [inbound, outbound] = await Promise.all([
      collect({ toAddress: address }), collect({ fromAddress: address }),
    ]);
    // Every transaction in which this address gave something up.
    const paid = new Set(outbound.map(asHash).filter(Boolean));
    for (const t of inbound) {
      const c = contractOf(t);
      if (!c) continue;                                  // a native receipt names no contract
      // Once acquired, always acquired: a token bought and later also airdropped is still one the
      // holder chose. The reverse is not true, so a receipt never downgrades an earlier purchase.
      if (out.get(c) === ACQUIRED) continue;
      out.set(c, paid.has(asHash(t)) ? ACQUIRED : UNSOLICITED);
    }
    return { ok: true, error: null, acquisition: out };
  } catch (e) {
    return { ok: false, error: redact(e?.message || e, key), acquisition: out };
  }
}
