// lib/tokensafety.js — whether a token can actually be sold, which is not what a price says.
//
// A pool's depth says a pool exists. It does not say you can sell into it, and airdropped tokens
// arrive unbidden precisely because looking valuable is the point. Checked on one that had been
// dropped into a real wallet: $1.6m of apparent liquidity, a contract that is NOT open source, and
// 63% of the pool held by a single unlocked address. None of that is illegal or even unusual; all
// of it means the number beside it is not a floor under anything.
//
// GoPlus publishes these flags keylessly for five of the six chains here — including Robinhood
// Chain, checked. HyperEVM is not covered, so tokens there simply carry no verdict rather than a
// clean one, which is a distinction this file is careful to keep.
//
// ADVISORY, NEVER LOAD-BEARING. Nothing here decides a price or a total; lib/hyperliquid.js
// already refuses to count an unvouched pool price. This only says WHY, so "I don't remember
// buying this" can be answered with something better than a shrug.

export const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v1/token_security';

// Verified 2026-09-07 against the supported-chains endpoint. HyperEVM (999) is absent.
export const SAFETY_CHAIN_IDS = Object.freeze({
  ethereum: 1, arbitrum: 42161, base: 8453, polygon: 137, robinhood: 4663,
});
export const MAX_ADDRESSES = 30;
// A sell tax above this is not a fee, it is a partial confiscation.
export const HIGH_SELL_TAX_PCT = 10;

const on = (v) => String(v ?? '') === '1';
const pct = (v) => { const n = Number(v); return Number.isFinite(n) ? n * 100 : null; };

// The flags distilled into plain reasons, worst first. An EMPTY list means nothing was flagged —
// which is not the same as safe, and the caller is expected to say so.
export function readFlags(r) {
  if (!r || typeof r !== 'object') return null;
  const reasons = [];
  if (on(r.is_honeypot)) reasons.push('cannot be sold — honeypot');
  if (on(r.cannot_sell_all)) reasons.push('the full balance cannot be sold');
  if (on(r.transfer_pausable)) reasons.push('transfers can be paused');
  if (on(r.owner_change_balance)) reasons.push('the owner can change balances');
  if (on(r.hidden_owner)) reasons.push('hidden owner');
  if (on(r.can_take_back_ownership)) reasons.push('ownership can be reclaimed');
  if (on(r.selfdestruct)) reasons.push('the contract can self-destruct');
  const sell = pct(r.sell_tax);
  if (sell != null && sell >= HIGH_SELL_TAX_PCT) reasons.push(`${Math.round(sell)}% sell tax`);
  // A contract nobody can read is not evidence of fraud and is a reason not to trust a number.
  if (String(r.is_open_source ?? '') === '0') reasons.push('contract source not published');
  // Unlocked liquidity concentrated in one holder is the rug, mechanically.
  const lp = Array.isArray(r.lp_holders) ? r.lp_holders : [];
  const top = lp.filter(h => !on(h?.is_locked)).map(h => Number(h?.percent)).filter(Number.isFinite);
  const biggest = top.length ? Math.max(...top) : 0;
  if (biggest >= 0.5) reasons.push(`${Math.round(biggest * 100)}% of liquidity unlocked in one wallet`);
  return {
    reasons,
    // "Nothing flagged" is reported as UNKNOWN rather than as clean. This checks for known shapes
    // of bad; it cannot certify good, and a badge saying "safe" would be the worst thing here.
    verdict: reasons.length ? 'flagged' : 'nothing flagged',
    name: r.token_name ?? null, symbol: r.token_symbol ?? null,
  };
}

export async function fetchTokenSafety({ chainKey, addresses = [], timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const out = new Map();
  const id = SAFETY_CHAIN_IDS[chainKey];
  if (!id) return { ok: false, supported: false, error: `no safety data for ${chainKey}`, flags: out };
  if (!addresses.length) return { ok: true, supported: true, error: null, flags: out };
  try {
    for (let i = 0; i < addresses.length; i += MAX_ADDRESSES) {
      const batch = addresses.slice(i, i + MAX_ADDRESSES).map(a => String(a).toLowerCase());
      const r = await fetchImpl(`${GOPLUS_BASE}/${id}?contract_addresses=${batch.join(',')}`,
                                { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return { ok: false, supported: true, error: `HTTP ${r.status}`, flags: out };
      const j = await r.json();
      for (const [addr, rec] of Object.entries(j?.result || {})) {
        const f = readFlags(rec);
        if (f) out.set(String(addr).toLowerCase(), f);
      }
    }
    return { ok: true, supported: true, error: null, flags: out };
  } catch (e) {
    return { ok: false, supported: true, error: String(e?.message || e), flags: out };
  }
}
