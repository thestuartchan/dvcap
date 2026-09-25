// test/walletidentity.test.mjs — a holding is its CONTRACT, end to end through the wallet read.
//
// 2026-09-25: the real PONS was missing from the card for a third day while the gate reported
// nothing withheld. Three places in the read keyed a token by its SYMBOL — the pool price, the
// swapped-for verdict, and (by omission) discovery's page cap — and each could drop the real token
// the moment a lookalike wearing its name arrived or the spam outgrew the cap. This drives
// lib/wallet.js fetchWallet against a fake Robinhood Chain, hermetically: no network, no key.
import { fetchWallet, BALANCE_OF, SYMBOL_SIG, DECIMALS_SIG } from '../lib/wallet.js';
import { CHAINS } from '../lib/chains.js';
import { publishable, pinsFromMemory } from '../lib/walletcard.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const WALLET = '0x' + 'ab'.repeat(20);
const REAL = '0x39dbed3a2bd333467115de45665cc57f813c4571';   // PONS, the one that was bought
const LOOK = '0x' + '11'.repeat(20);                        // PONS, the one that arrived unbidden
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const E18 = 10n ** 18n;

// ── A MINIMAL ABI, ENOUGH TO ANSWER AGGREGATE3 ───────────────────────────────
const strip = (h) => String(h).replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const pad = (hex) => hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
function decodeCalls(data) {
  const h = strip(data).slice(8);                   // past the selector
  const at = (i) => BigInt('0x' + h.slice(i * 64, (i + 1) * 64));
  const n = Number(at(1));
  const calls = [];
  for (let i = 0; i < n; i++) {
    const s = 2 + Number(at(2 + i)) / 32;           // element offsets are relative to after the length
    const target = '0x' + h.slice(s * 64 + 24, (s + 1) * 64);
    const len = Number(at(s + 3));
    calls.push({ target, callData: '0x' + h.slice((s + 4) * 64, (s + 4) * 64 + len * 2) });
  }
  return calls;
}
function encodeResults(results) {
  const els = results.map(r => {
    const d = strip(r.data || '');
    return word(r.success ? 1 : 0) + word(64) + word(d.length / 2) + pad(d);
  });
  let off = els.length * 32, offs = '';
  for (const e of els) { offs += word(off); off += e.length / 2; }
  return '0x' + word(32) + word(els.length) + offs + els.join('');
}
const abiString = (s) => { const b = Buffer.from(s, 'utf8').toString('hex'); return word(32) + word(b.length / 2) + pad(b); };

// ── THE FAKE CHAIN ───────────────────────────────────────────────────────────
function fakeChain({ tokens, discovered, truncate = false, swapped = [], received = [], transfersFail = false, pairs = {} }) {
  const seen = { dexAsked: [], balanceOfAsked: [] };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const impl = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.includes('.g.alchemy.com/')) {
      if (body.method === 'alchemy_getTokenBalances') {
        return res(200, { result: {
          tokenBalances: discovered.map(a => ({ contractAddress: a, tokenBalance: '0x' + tokens[a].raw.toString(16) })),
          pageKey: truncate ? 'more' : undefined } });
      }
      if (body.method === 'alchemy_getAssetTransfers') {
        if (transfersFail) return res(500, {});
        const p = body.params[0];
        if (p.fromAddress) return res(200, { result: { transfers: swapped.map((a, i) => ({ hash: `0xpaid${i}` })) } });
        return res(200, { result: { transfers: [
          ...swapped.map((a, i) => ({ hash: `0xpaid${i}`, rawContract: { address: a } })),
          ...received.map((a, i) => ({ hash: `0xdrop${i}`, rawContract: { address: a } })),
        ] } });
      }
    }
    if (u === CHAINS.robinhood.rpc) {
      if (body.method === 'eth_getBalance') return res(200, { result: '0x0' });
      const calls = decodeCalls(body.params[0].data);
      return res(200, { result: encodeResults(calls.map(c => {
        const t = tokens[c.target.toLowerCase()];
        if (!t) return { success: false, data: '' };
        if (c.callData === SYMBOL_SIG) return { success: true, data: abiString(t.symbol) };
        if (c.callData === DECIMALS_SIG) return { success: true, data: word(18) };
        if (c.callData.startsWith(BALANCE_OF)) { seen.balanceOfAsked.push(c.target.toLowerCase()); return { success: true, data: word(t.raw) }; }
        return { success: false, data: '' };
      })) });
    }
    if (u.startsWith('https://api.dexscreener.com/tokens/v1/robinhood/')) {
      const asked = u.split('/').pop().split(',').map(a => a.toLowerCase());
      seen.dexAsked.push(...asked);
      return res(200, asked.flatMap(a => (pairs[a] || []).map(p => ({ ...p, baseToken: { address: a, symbol: tokens[a]?.symbol } }))));
    }
    return res(404, {});
  };
  return { impl, seen };
}
const pool = (price, quote, { liq = 5_000_000, vol = 2_000_000 } = {}) =>
  ({ priceUsd: String(price), liquidity: { usd: liq }, volume: { h24: vol }, quoteToken: { address: quote, symbol: quote === USDG ? 'USDG' : 'WETH' }, dexId: 'uniswap' });

async function read(chain, opts = {}) {
  const saved = { fetch: globalThis.fetch, key: process.env.ALCHEMY_API_KEY };
  globalThis.fetch = chain.impl;
  process.env.ALCHEMY_API_KEY = 'test-key';
  try {
    return await fetchWallet({ chain: CHAINS.robinhood, chainKey: 'robinhood', address: WALLET,
      prices: new Map([['ETH', { price: 2600, volume: Infinity }]]), timeoutMs: 2000, ...opts });
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.ALCHEMY_API_KEY; else process.env.ALCHEMY_API_KEY = saved.key;
  }
}
const cardRows = (rows) => publishable(rows.map(r => ({ ...r, chain: 'Robinhood Chain' }))).filter(r => r.price != null);

// ── TWO TOKENS, ONE NAME ─────────────────────────────────────────────────────
{
  const tokens = { [REAL]: { symbol: 'PONS', raw: 1000n * E18 }, [LOOK]: { symbol: 'PONS', raw: 50n * E18 } };
  const chain = fakeChain({ tokens, discovered: [REAL, LOOK], swapped: [REAL], received: [LOOK],
    pairs: { [REAL]: [pool(0.62, USDG)], [LOOK]: [pool(25, WETH)] } });
  const w = await read(chain);
  ok('the read answers', w.ok);
  const byAddr = Object.fromEntries(w.rows.map(r => [r.address, r]));
  eq('the holding is priced from its OWN pool', byAddr[REAL]?.price, 0.62);
  eq('and the lookalike from its own, not the holding\'s', byAddr[LOOK]?.price, 25);
  eq('both were asked about, by address', [...new Set(chain.seen.dexAsked)].sort(), [LOOK, REAL].sort());
  eq('the holding keeps its own verdict: swapped for', byAddr[REAL]?.acquired, true);
  eq('the lookalike keeps its own: arrived unbidden', byAddr[LOOK]?.acquired, false);
  const card = cardRows(w.rows);
  eq('the card lists exactly one PONS', card.filter(r => r.coin === 'PONS').length, 1);
  eq('and it is the one that was bought, at its price', [card[0]?.address, card[0]?.price], [REAL, 0.62]);
}

// ── ORDER DOES NOT DECIDE ────────────────────────────────────────────────────
// The old symbol → address map took whichever PONS was listed LAST; listing the lookalike first
// flipped which verdict both rows got. By contract, order is irrelevant.
{
  const tokens = { [REAL]: { symbol: 'PONS', raw: 1000n * E18 }, [LOOK]: { symbol: 'PONS', raw: 50n * E18 } };
  const chain = fakeChain({ tokens, discovered: [LOOK, REAL], swapped: [REAL], received: [LOOK],
    pairs: { [REAL]: [pool(0.62, USDG)], [LOOK]: [pool(25, WETH)] } });
  const w = await read(chain);
  const byAddr = Object.fromEntries(w.rows.map(r => [r.address, r]));
  eq('lookalike listed first: verdicts still per contract', [byAddr[REAL]?.acquired, byAddr[LOOK]?.acquired], [true, false]);
  eq('and the card still lists the real one', cardRows(w.rows).map(r => r.address), [REAL]);
}

// ── PAST THE DISCOVERY CAP ───────────────────────────────────────────────────
{
  const spam = Array.from({ length: 6 }, (_, i) => '0x' + (i + 2).toString(16).padStart(2, '0').repeat(20));
  const tokens = { [REAL]: { symbol: 'PONS', raw: 1000n * E18 } };
  for (const [i, a] of spam.entries()) tokens[a] = { symbol: `DROP${i}`, raw: 7n * E18 };
  const chain = fakeChain({ tokens, discovered: spam, truncate: true, swapped: [REAL], received: spam,
    pairs: { [REAL]: [pool(0.62, USDG)] } });
  const w = await read(chain);
  eq('discovery says it stopped short', w.discovery.truncated, true);
  eq('the swapped-for contract was read on top of it', w.discovery.pinned, 1);
  ok('by its own balanceOf', chain.seen.balanceOfAsked.includes(REAL));
  const pons = w.rows.find(r => r.address === REAL);
  eq('and it is a holding, priced, chosen', [pons?.coin, pons?.price, pons?.acquired], ['PONS', 0.62, true]);
  eq('the card carries it', cardRows(w.rows).some(r => r.address === REAL), true);

  // The same wallet with the history unreadable: the memory's pin is what reaches it.
  const blind = fakeChain({ tokens, discovered: spam, truncate: true, transfersFail: true, pairs: { [REAL]: [pool(0.62, USDG)] } });
  const b = await read(blind, { pinned: [REAL] });
  eq('history unreadable: the remembered contract is still read', b.rows.find(r => r.address === REAL)?.price, 0.62);
  eq('with provenance unknown, not guessed', b.rows.find(r => r.address === REAL)?.acquired ?? null, null);
  const none = await read(fakeChain({ tokens, discovered: spam, truncate: true, transfersFail: true, pairs: {} }));
  eq('and without the pin it is exactly the day PONS vanished', none.rows.some(r => r.address === REAL), false);
}

// ── AN UNTRUNCATED DISCOVERY IS TAKEN AT ITS WORD ────────────────────────────
{
  const tokens = { [REAL]: { symbol: 'PONS', raw: 1000n * E18 }, [LOOK]: { symbol: 'OTHER', raw: 5n * E18 } };
  const chain = fakeChain({ tokens, discovered: [LOOK], swapped: [REAL], pairs: {} });
  const w = await read(chain, { pinned: [REAL] });
  eq('nothing is pinned when discovery saw everything', w.discovery.pinned, 0);
  ok('so a chosen contract it did not list is one since sold', !chain.seen.balanceOfAsked.includes(REAL));
}

// ── THE MEMORY, AS PINS ──────────────────────────────────────────────────────
{
  const pins = pinsFromMemory({ [`Robinhood Chain:${REAL}`]: true, [`Base:${LOOK}`]: true, 'Base:notanaddress': true, [`Robinhood Chain:${WETH}`]: false });
  eq('grouped by chain label, only what was confirmed', pins, { 'Robinhood Chain': [REAL], Base: [LOOK] });
  eq('an empty memory pins nothing', pinsFromMemory(null), {});
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
