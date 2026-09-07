// lib/wallet.js — what the ADDRESS holds on chain, which is not what the exchange holds for it.
//
// THREE DIFFERENT THINGS, DELIBERATELY THREE SECTIONS:
//
//   Hyperliquid perps   a POSITION. Leverage, funding, a liquidation price.
//   Hyperliquid spot    a BALANCE ON THE EXCHANGE's ledger. Some of it locked in resting orders.
//   The wallet          a BALANCE ON CHAIN. Nothing on the exchange knows about it, and moving it
//                       to the exchange is a bridge transaction, not a transfer between accounts.
//
// Merging any two of them would answer a question nobody asks. "How much HYPE do I have" has three
// true answers with different consequences, and a single number would be none of them.
//
// Read-only, from the same address in the environment, over a public RPC. No key, no signing.

import { spotHoldings, HL_ADDRESS_ENV } from './hyperliquid.js';

export const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';
export const HYPEREVM_CHAIN_ID = 999;
// Multicall3 at its canonical cross-chain address; verified deployed on HyperEVM 2026-09-07.
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const NATIVE_SYMBOL = 'HYPE';
export const NATIVE_DECIMALS = 18;

const strip = (h) => String(h ?? '').replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => word('0x' + strip(a));

export const BALANCE_OF = '0x70a08231';
export const balanceOfCall = (holder) => BALANCE_OF + addrWord(holder);

// ── WHY MULTICALL AND NOT A BATCH ────────────────────────────────────────────
// The obvious approach is JSON-RPC batching, and it works — until it does not: this RPC answers
// `{"code":-32010,"message":"The batch request was too large","data":"Exceeded max limit of 20"}`.
// 169 tokens carry an EVM contract, so batching is nine round trips on every page load. aggregate3
// is one, and it took 775ms for all 169 measured end to end.
//
// allowFailure is TRUE on every call because some listed contracts are not readable ERC-20s — the
// USDC entry reverts — and one bad address must not lose the other 168 balances.
export function encodeAggregate3(calls = []) {
  const structs = calls.map(c => {
    const data = strip(c.callData);
    const padded = data.padEnd(Math.ceil(data.length / 64) * 64, '0');
    // address, bool, then the offset to the bytes — 96, being three words past the struct start.
    return addrWord(c.target) + word(c.allowFailure === false ? 0 : 1) + word(96)
         + word(data.length / 2) + padded;
  });
  let offset = structs.length * 32, offsets = '';
  for (const s of structs) { offsets += word(offset); offset += s.length / 2; }
  // selector, offset to the array, its length, the element offsets, the elements
  return '0x82ad56cb' + word(32) + word(structs.length) + offsets + structs.join('');
}

export function decodeAggregate3(ret) {
  const h = strip(ret);
  if (!h) return [];
  const at = (i) => h.slice(i * 64, (i + 1) * 64);
  const num = (i) => Number(BigInt('0x' + at(i)));
  const base = num(0) / 32;
  const n = num(base);
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = base + 1 + num(base + 1 + i) / 32;
    const d = s + num(s + 1) / 32;
    const len = num(d);
    out.push({ success: BigInt('0x' + at(s)) === 1n, data: '0x' + h.slice((d + 1) * 64, (d + 1) * 64 + len * 2) });
  }
  return out;
}

// ── DECIMALS ARE NOT 18 ──────────────────────────────────────────────────────
// Assuming 18 is the commonest way to be wrong by six orders of magnitude. Hyperliquid states the
// EVM contract's decimals as `weiDecimals + evm_extra_wei_decimals`, which is not obvious and is
// not always 18: USDC is 6. Checked against the contracts' own decimals() on 2026-09-07 — nine of
// nine agreed wherever the call was answerable.
export const evmDecimals = (token) =>
  (token?.weiDecimals ?? 0) + (token?.evmContract?.evm_extra_wei_decimals ?? 0);

export function erc20Targets(spotMeta) {
  const tokens = (Array.isArray(spotMeta) ? spotMeta[0] : spotMeta)?.tokens || [];
  return tokens
    .filter(t => t?.evmContract?.address && t?.name)
    .map(t => ({ name: String(t.name), address: String(t.evmContract.address), decimals: evmDecimals(t) }));
}

// A balance is an integer of the smallest unit, and an 18-decimal one routinely exceeds what a
// double can hold. `Number(bigint) / 10 ** decimals` loses digits BEFORE the division even starts,
// so the split is done on the decimal string and converted once at the end. The result is still a
// double — about fifteen significant figures — which is far beyond anything displayed, but it is
// the difference between a rounded balance and a wrong one.
export function fromUnits(raw, decimals) {
  if (raw == null) return null;
  let v;
  try { v = BigInt(raw); } catch { return null; }
  if (decimals <= 0) return Number(v);
  const neg = v < 0n; if (neg) v = -v;
  const s = v.toString().padStart(decimals + 1, '0');
  const trimmed = `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, '') || '0';
  return Number(neg ? '-' + trimmed : trimmed);
}

// The balances, in the shape lib/hyperliquid.js already knows how to value — so the wallet gets the
// same thin-market guard and the same dust bucket as the exchange ledger, from one implementation.
export function walletBalances(nativeWei, results = [], targets = []) {
  const out = [];
  const native = fromUnits(nativeWei, NATIVE_DECIMALS);
  if (native) out.push({ coin: NATIVE_SYMBOL, total: native, hold: 0, free: native, entryNtl: 0, native: true });
  results.forEach((r, i) => {
    const t = targets[i];
    if (!t || !r?.success || !r.data || r.data === '0x') return;
    const amt = fromUnits(r.data, t.decimals);
    if (!amt) return;                                  // a zero balance is not a holding
    out.push({ coin: t.name, total: amt, hold: 0, free: amt, entryNtl: 0, native: false });
  });
  return out;
}

const rpc = (body, timeoutMs) => fetch(HYPEREVM_RPC, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
});

export async function fetchWallet({ address = process.env[HL_ADDRESS_ENV], spotMeta, prices, timeoutMs = 10000 } = {}) {
  const nope = (error) => ({ ok: false, error, rows: [], dust: null, thin: null, total: null, unpriced: 0, chainId: HYPEREVM_CHAIN_ID });
  if (!address) return nope('no address configured');
  const targets = erc20Targets(spotMeta);
  try {
    const [nat, mc] = await Promise.all([
      rpc({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }, timeoutMs),
      targets.length
        ? rpc({ jsonrpc: '2.0', id: 2, method: 'eth_call', params: [
            { to: MULTICALL3, data: encodeAggregate3(targets.map(t => ({ target: t.address, allowFailure: true, callData: balanceOfCall(address) }))) },
            'latest'] }, timeoutMs)
        : null,
    ]);
    const nj = await nat.json();
    const mj = mc ? await mc.json() : null;
    if (nj?.error && mj?.error) return nope(String(nj.error?.message || 'RPC error'));
    const results = mj?.result ? decodeAggregate3(mj.result) : [];
    const balances = walletBalances(nj?.result, results, targets);
    return { ok: true, error: null, chainId: HYPEREVM_CHAIN_ID, ...spotHoldings(balances, prices || new Map()) };
  } catch (e) {
    return nope(String(e?.message || e));
  }
}
