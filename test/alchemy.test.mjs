// test/alchemy.test.mjs — discovering which tokens an address holds.
//
// The chain cannot answer this. An ERC-20 balance lives inside each token's own contract, keyed by
// holder, so a node answers "how much USDC does this address hold" and has no index for "what does
// this address hold" — nothing writes one. Native ETH is in the account state, which is why every
// chain showed ETH and only listed tokens beside it.
//
// Stubbed transport throughout: this path cannot be exercised without a key, and untested code
// behind an environment variable is code that runs for the first time in production.
import { discoverTokens, redact, alchemyUrl, NETWORKS, MAX_PAGES, PAGE_SIZE, ALCHEMY_KEY_ENV } from '../lib/alchemy.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const reply = (result) => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
const ADDR = '0x000000000000000000000000000000000000dEaD';

// ── THE KEY IS A PATH SEGMENT, SO THE URL IS A CREDENTIAL ────────────────────
// Alchemy puts the key in the path rather than a header, which means any error string carrying the
// URL carries the secret. Every throw goes through redact first.
{
  const url = alchemyUrl('eth-mainnet', 'SUPERSECRET');
  eq('the key is in the path', url, 'https://eth-mainnet.g.alchemy.com/v2/SUPERSECRET');
  ok('and redaction removes it', !redact(`fetch failed ${url}`, 'SUPERSECRET').includes('SUPERSECRET'));
  // Belt and braces: it must still be removed when the current key is not the one in the string —
  // a rotated key, or an error raised before the env was read.
  ok('even without knowing the key', !redact(`ECONNREFUSED ${url}`, null).includes('SUPERSECRET'));
  eq('leaving the host readable, which is the useful half',
     redact(`fetch failed ${url}`, 'SUPERSECRET'), 'fetch failed https://eth-mainnet.g.alchemy.com/v2/«key»');
  eq('nothing is nothing', redact(null, 'SUPERSECRET'), '');
}

// ── NO KEY IS A STATE, NOT AN ERROR ──────────────────────────────────────────
// The wallet still works without one — it falls back to the verified token list. What it must not
// do is claim to have looked.
{
  const saved = process.env[ALCHEMY_KEY_ENV];
  delete process.env[ALCHEMY_KEY_ENV];
  const r = await discoverTokens({ network: 'eth-mainnet', address: ADDR });
  eq('unconfigured reports itself', [r.ok, r.configured, r.tokens.length], [false, false, 0]);
  ok('and names the variable to set', r.error.includes(ALCHEMY_KEY_ENV));
  if (saved === undefined) delete process.env[ALCHEMY_KEY_ENV]; else process.env[ALCHEMY_KEY_ENV] = saved;
}
{
  const r = await discoverTokens({ network: null, address: ADDR, key: 'k' });
  ok('a chain with no Alchemy network says so rather than failing', !r.ok && /network/.test(r.error));
  const n = await discoverTokens({ network: 'eth-mainnet', address: null, key: 'k' });
  ok('and so does a missing address', !n.ok && /address/.test(n.error));
}

// ── WHAT COMES BACK ──────────────────────────────────────────────────────────
{
  const calls = [];
  const stub = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return reply({ address: ADDR, tokenBalances: [
      { contractAddress: '0xaaa', tokenBalance: hex(5_000_000), error: null },
      // A zero balance is not a holding. A wallet that once touched a token keeps its row forever
      // otherwise, and an airdropped address is exactly the case this has to survive.
      { contractAddress: '0xbbb', tokenBalance: hex(0), error: null },
      // One bad contract must not cost the others.
      { contractAddress: '0xccc', tokenBalance: null, error: 'boom' },
      { contractAddress: '0xddd', tokenBalance: hex(42), error: null },
    ] });
  };
  const r = await discoverTokens({ network: 'eth-mainnet', address: ADDR, key: 'k', fetchImpl: stub });
  eq('only non-zero, non-erroring balances', r.tokens.map(t => t.address), ['0xaaa', '0xddd']);
  eq('carrying the raw hex, undivided', r.tokens[0].raw, hex(5_000_000));
  eq('one page was enough', [r.pages, r.truncated], [1, false]);
  eq('and it asked for erc20 balances', calls[0].method, 'alchemy_getTokenBalances');
  eq('for the address, at the documented page size', [calls[0].params[0], calls[0].params[1], calls[0].params[2].maxCount], [ADDR, 'erc20', PAGE_SIZE]);
}

// ── PAGINATION, AND A BOUND THAT IS REPORTED ─────────────────────────────────
// An address junked with airdrops must not turn into an unbounded request on every page load. The
// cap is real, and a capped list that LOOKED complete is the one failure this file exists to remove.
{
  let n = 0;
  const stub = async () => { n += 1; return reply({ address: ADDR, pageKey: 'more',
    tokenBalances: [{ contractAddress: '0x' + n, tokenBalance: hex(n), error: null }] }); };
  const r = await discoverTokens({ network: 'eth-mainnet', address: ADDR, key: 'k', fetchImpl: stub });
  eq('it stops at the cap', r.pages, MAX_PAGES);
  eq('having collected a row per page', r.tokens.length, MAX_PAGES);
  ok('and SAYS the list is cut short', r.truncated === true);

  // A pageKey that runs out ends the loop early and is not truncated.
  let m = 0;
  const two = async () => { m += 1; return reply({ address: ADDR, ...(m < 2 ? { pageKey: 'more' } : {}),
    tokenBalances: [{ contractAddress: '0x' + m, tokenBalance: hex(m), error: null }] }); };
  const s = await discoverTokens({ network: 'eth-mainnet', address: ADDR, key: 'k', fetchImpl: two });
  eq('two pages, then done', [s.pages, s.truncated, s.tokens.length], [2, false, 2]);
}

// ── FAILURE IS REPORTED, NEVER GUESSED AROUND ────────────────────────────────
{
  const http = await discoverTokens({ network: 'eth-mainnet', address: ADDR, key: 'k',
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
  eq('a rate limit is named', [http.ok, http.error], [false, 'HTTP 429']);

  const rpcErr = await discoverTokens({ network: 'eth-mainnet', address: ADDR, key: 'SUPERSECRET',
    fetchImpl: async () => ({ ok: true, json: async () => ({ error: { message: 'bad key https://eth-mainnet.g.alchemy.com/v2/SUPERSECRET' } }) }) });
  ok('and an RPC error is redacted before it is reported', !rpcErr.error.includes('SUPERSECRET'));

  const threw = await discoverTokens({ network: 'eth-mainnet', address: ADDR, key: 'SUPERSECRET',
    fetchImpl: async () => { throw new Error('connect ETIMEDOUT https://eth-mainnet.g.alchemy.com/v2/SUPERSECRET'); } });
  ok('a thrown error too', !threw.error.includes('SUPERSECRET') && threw.ok === false);
  eq('and nothing is returned as if it were data', threw.tokens, []);
}

// ── THE NETWORK NAMES WERE PROBED, NOT RECALLED ──────────────────────────────
// Verified 2026-09-07: all six hosts answer "Must be authenticated!" without a key, while an
// invented slug does not resolve at all.
{
  eq('one per chain', Object.keys(NETWORKS).sort(), ['arbitrum', 'base', 'ethereum', 'hyperevm', 'polygon', 'robinhood']);
  ok('all lowercase mainnet slugs', Object.values(NETWORKS).every(v => /^[a-z0-9-]+-mainnet$/.test(v)));
  eq('no slug is reused', new Set(Object.values(NETWORKS)).size, Object.keys(NETWORKS).length);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
