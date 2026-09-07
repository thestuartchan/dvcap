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
import { CHAINS, MULTICALL3 } from './chains.js';
import { discoverTokens, alchemyConfigured, NETWORKS } from './alchemy.js';

export { MULTICALL3 };
// Kept for the HyperEVM-only callers and tests that predate the other five chains.
export const HYPEREVM_RPC = CHAINS.hyperevm.rpc;
export const HYPEREVM_CHAIN_ID = CHAINS.hyperevm.id;
export const NATIVE_SYMBOL = CHAINS.hyperevm.native.symbol;
export const NATIVE_DECIMALS = 18;

// ── WHAT A TOKEN IS WORTH, ACCORDING TO A VENUE THAT TRADES IT ───────────────
// Not a ticker lookup. Measured 2026-09-07, Yahoo and Hyperliquid agree to within 0.1% on ETH, BTC
// and LINK — and differ by 266x on ARB and 12x on POL, because those Yahoo tickers are other
// instruments. Pricing a wallet off them would reproduce, exactly, the collision that made
// HYPE-USD a million times off.
//
// A listed perp is a real market by construction, so these carry no thin-volume flag; the
// HyperEVM spot path keeps its own, because a spot pair can be listed and dead.
export function venuePrices(markets = {}) {
  const out = new Map();
  for (const [coin, m] of Object.entries(markets)) {
    if (m?.mark == null) continue;
    out.set(coin, { price: m.mark, volume: Infinity, changePercent: m.changePercent ?? null });
  }
  return out;
}

// The price map AS THAT CHAIN'S ROWS ARE KEYED. A row says WETH or WPOL; the venue quotes ETH and
// POL. Translating here keeps the naming honest on screen without inventing a market.
export function chainPrices(chain, venue = new Map()) {
  const out = new Map();
  const add = (tk) => {
    if (!tk?.symbol) return;
    const q = tk.hl && venue.get(tk.hl);
    if (q) { out.set(tk.symbol, q); return; }
    // ── A STABLECOIN WITH NO VENUE QUOTE ─────────────────────────────────────────────────────
    // Stablecoins have no PERP — there is nothing to be long or short of a dollar — so pricing
    // wallet tokens off perp marks alone left every USDC, USDT and DAI balance unpriced, and
    // unpriced means EXCLUDED FROM THE TOTAL. A wallet reported $65 while holding 101.81 USDC.
    // A number silently missing the largest position in it is worse than no number.
    //
    // Where the venue quotes the spot pair it is used (USDC, USDT0). Where it quotes nothing, par
    // is assumed and the row says so — an assumed par is not a measured price, and a depeg is
    // exactly the moment the difference matters.
    if (tk.par) out.set(tk.symbol, { price: 1, volume: Infinity, changePercent: null, assumedPar: true });
  };
  if (chain?.native) add(chain.native);
  for (const tk of chain?.tokens || []) add(tk);
  return out;
}

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

export const SYMBOL_SIG = '0x95d89b41';
export const DECIMALS_SIG = '0x313ce567';

// ── A DISCOVERED CONTRACT IS AN ADDRESS AND NOTHING ELSE ─────────────────────
// The indexer says which contracts an address holds; it does not get to say what they are. Symbol
// and decimals come from the contracts THEMSELVES, over the chain's own RPC, through the same
// multicall already asserted against a captured request — the same standard every hand-written
// entry in lib/chains.js had to meet. A third party naming a token is not evidence.
//
// Old tokens return a bytes32 symbol rather than a string — MKR is the famous one — so both
// encodings are decoded and anything else is left unnamed rather than guessed at.
export function decodeString(hex) {
  const h = strip(hex);
  if (!h) return null;
  if (h.length === 64) {                                   // bytes32: right-padded ASCII
    const s = Buffer.from(h, 'hex').toString('utf8').replace(/\u0000+$/g, '').trim();
    return /^[\x20-\x7e]+$/.test(s) ? s : null;
  }
  try {
    const len = Number(BigInt('0x' + h.slice(64, 128)));
    if (!Number.isInteger(len) || len <= 0 || len > 128) return null;
    const s = Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\u0000/g, '').trim();
    return s || null;
  } catch { return null; }
}

export function decodeMetadata(results = [], addresses = []) {
  const out = [];
  addresses.forEach((address, i) => {
    const sym = results[i * 2], dec = results[i * 2 + 1];
    const name = sym?.success ? decodeString(sym.data) : null;
    const decimals = (dec?.success && dec.data && dec.data !== '0x') ? Number(BigInt(dec.data)) : null;
    // A contract that will not say what it is does not get a row. Showing a balance under an
    // address is not information, and guessing 18 decimals is how a dust token becomes a fortune.
    if (!name || decimals == null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return;
    out.push({ name, address, decimals });
  });
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
export function walletBalances(nativeWei, results = [], targets = [], nativeToken = CHAINS.hyperevm.native) {
  const out = [];
  const native = fromUnits(nativeWei, nativeToken?.decimals ?? 18);
  if (native) out.push({ coin: nativeToken?.symbol ?? 'ETH', total: native, hold: 0, free: native, entryNtl: 0, native: true });
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

export async function fetchWallet({ chain = CHAINS.hyperevm, chainKey = 'hyperevm', address = process.env[HL_ADDRESS_ENV],
                                   spotMeta, prices, timeoutMs = 10000, useDiscovery = true } = {}) {
  const shell = { chain: chain?.label ?? null, chainId: chain?.id ?? null, tokensUnlisted: !!chain?.tokensUnlisted };
  const nope = (error) => ({ ok: false, error, rows: [], dust: null, thin: null, total: null, unpriced: 0, ...shell });
  if (!address) return nope('no address configured');
  if (!chain?.rpc) return nope('no RPC configured for this chain');
  // HyperEVM's token set comes from the venue's own metadata; every other chain carries a list
  // whose addresses were verified against the chain — see lib/chains.js.
  const rpc = (body) => fetch(chain.rpc, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const call = (data) => rpc({ jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: MULTICALL3, data }, 'latest'] });
  try {
    // ── DISCOVERED, OR MERELY LISTED ─────────────────────────────────────────────────────────
    // With a key the indexer says which contracts this address actually holds and hands back the
    // raw balances with them, so no balanceOf pass is needed — only a metadata pass, read from the
    // contracts themselves. Without one, the verified list in lib/chains.js is all there is, and
    // `discovery` records which of the two happened: "you hold nothing else" and "I cannot see
    // anything else" are different claims and must not render the same.
    const network = NETWORKS[chainKey] || null;
    const found = (useDiscovery && network)
      ? await discoverTokens({ network, address, timeoutMs })
      : { ok: false, configured: alchemyConfigured(), error: null, tokens: [], truncated: false };

    let targets, raw = null;
    if (found.ok && found.tokens.length) {
      const addrs = found.tokens.map(t => t.address);
      const meta = await call(encodeAggregate3(addrs.flatMap(a => ([
        { target: a, allowFailure: true, callData: SYMBOL_SIG },
        { target: a, allowFailure: true, callData: DECIMALS_SIG },
      ]))));
      const mj = await meta.json();
      const named = decodeMetadata(mj?.result ? decodeAggregate3(mj.result) : [], addrs);
      const rawBy = new Map(found.tokens.map(t => [t.address.toLowerCase(), t.raw]));
      targets = named;
      raw = named.map(t => rawBy.get(t.address.toLowerCase()));
    } else {
      targets = chain.tokensFrom === 'hyperliquid'
        ? erc20Targets(spotMeta)
        : (chain.tokens || []).map(tk => ({ name: tk.symbol, address: tk.address, decimals: tk.decimals }));
    }

    const [nat, mc] = await Promise.all([
      rpc({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
      (raw == null && targets.length)
        ? call(encodeAggregate3(targets.map(t => ({ target: t.address, allowFailure: true, callData: balanceOfCall(address) }))))
        : null,
    ]);
    const nj = await nat.json();
    const mj = mc ? await mc.json() : null;
    if (nj?.error && (!mj || mj?.error)) return nope(String(nj.error?.message || 'RPC error'));
    const results = raw != null
      ? raw.map(v => ({ success: v != null, data: v ?? '0x' }))
      : (mj?.result ? decodeAggregate3(mj.result) : []);
    const balances = walletBalances(nj?.result, results, targets, chain.native);
    // `used` is whether discovery ANSWERED, not whether it found anything. A wallet holding no
    // ERC-20s on a chain is a successful answer — reporting it as "not discovered" undercounted
    // the header, which read "4 of 6 chains" while all six had in fact been asked.
    const discovery = { used: !!found.ok, configured: found.configured, truncated: !!found.truncated,
                        error: found.ok ? null : (found.error || null), seen: targets.length };
    return { ok: true, error: null, ...shell, discovery, ...spotHoldings(balances, prices || new Map()) };
  } catch (e) {
    return nope(String(e?.message || e));
  }
}

// ── EVERY CHAIN AT ONCE, AND NONE OF THEM BLOCKING THE OTHERS ────────────────
// Six chains, six independent RPCs, one multicall each. In parallel that is one round trip; in
// series it is six, on a route that already makes several. A chain that is down returns its own
// error and the other five still report — a wallet view that goes blank because one public RPC is
// rate-limited is worse than one that says which chain it could not reach.
export async function fetchWallets({ address = process.env[HL_ADDRESS_ENV], spotMeta, spotPrices,
                                     markets = {}, timeoutMs = 10000 } = {}) {
  // PERP MARKS FIRST, SPOT BEHIND THEM. A perp is the deeper book for anything that has one; the
  // spot map is what supplies the quotes perps cannot — there is no perp on a dollar, so USDC and
  // USDT0 are quoted only there. Without this merge every stablecoin on every chain went unpriced
  // and dropped out of the total.
  const venue = venuePrices(markets);
  for (const [sym, q] of (spotPrices || new Map())) if (!venue.has(sym)) venue.set(sym, q);
  const keys = Object.keys(CHAINS);
  const results = await Promise.all(keys.map(k => {
    const chain = CHAINS[k];
    // HyperEVM prices off the spot book, which carries real volume and so keeps the thin guard.
    const prices = chain.tokensFrom === 'hyperliquid' ? spotPrices : chainPrices(chain, venue);
    return fetchWallet({ chain, chainKey: k, address, spotMeta, prices, timeoutMs }).then(r => ({ key: k, ...r }));
  }));
  const live = results.filter(r => r.ok);
  return {
    ok: live.length > 0,
    chains: results,
    // Whether the wallet could ask "what do you hold" at all, or only "how much of these".
    discoveryConfigured: alchemyConfigured(),
    // The total spans only what actually answered, and `unreachable` names the rest — a number
    // silently missing a chain is worse than a smaller number with a reason beside it.
    total: +live.reduce((a, r) => a + (r.total || 0), 0).toFixed(2),
    unreachable: results.filter(r => !r.ok).map(r => ({ chain: r.chain, error: r.error })),
  };
}
