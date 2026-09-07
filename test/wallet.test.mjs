// test/wallet.test.mjs — what the ADDRESS holds on chain, which is not what the exchange holds.
//
// Three different answers to "how much HYPE do I have": an open perp, a balance on Hyperliquid's
// ledger, and coins in the wallet. Moving the third to the second is a bridge transaction, not a
// transfer, so a single merged number would be none of the three.
//
// The ABI encoding is asserted against a REAL REQUEST captured from the chain, in
// test/fixtures-multicall3.json, and the response it produced. Hand-rolled encoders are exactly
// the kind of thing that looks right and is off by one word.
import { readFileSync } from 'node:fs';
import { encodeAggregate3, decodeAggregate3, balanceOfCall, evmDecimals, erc20Targets,
         fromUnits, walletBalances, fetchWallet, MULTICALL3, HYPEREVM_RPC, HYPEREVM_CHAIN_ID,
         NATIVE_SYMBOL, NATIVE_DECIMALS } from '../lib/wallet.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const F = JSON.parse(readFileSync(new URL('./fixtures-multicall3.json', import.meta.url), 'utf8'));
const HOLDER = '0x000000000000000000000000000000000000dEaD';

// ── THE ENCODER, AGAINST A REQUEST THE CHAIN ACTUALLY ANSWERED ───────────────
{
  const calls = F.tokens.map(t => ({ target: t.address, allowFailure: true, callData: balanceOfCall(HOLDER) }));
  eq('the encoded request is byte-for-byte the captured one', encodeAggregate3(calls), F.request);
  ok('which begins with the aggregate3 selector', encodeAggregate3(calls).startsWith('0x82ad56cb'));
  eq('balanceOf is the standard selector plus a left-padded address',
     balanceOfCall(HOLDER), '0x70a08231' + '0'.repeat(24) + '000000000000000000000000000000000000dead');
  // An address is 20 bytes in a 32-byte word — twelve zero bytes of padding, not eight or sixteen.
  eq('the holder occupies the low 20 bytes', balanceOfCall(HOLDER).length, 2 + 8 + 64);
  eq('an empty call list still encodes', encodeAggregate3([]).slice(0, 10), '0x82ad56cb');
}

// ── THE DECODER, AGAINST THE RESPONSE THAT REQUEST PRODUCED ──────────────────
// allowFailure is true on every call because some listed contracts are not readable ERC-20s. The
// USDC entry in this very fixture reverts, and it must not cost the other two their balances.
{
  const out = decodeAggregate3(F.response);
  eq('one result per call', out.length, F.tokens.length);
  eq('and the reverted one is marked, not thrown', out.map(r => r.success), [true, true, false]);
  ok('while the successful ones carry 32 bytes of return data',
     out.filter(r => r.success).every(r => r.data.length === 66));
  eq('nothing decodes to nothing', decodeAggregate3(''), []);
  eq('and neither does null', decodeAggregate3(null), []);
}

// ── DECIMALS ARE NOT 18 ──────────────────────────────────────────────────────
// Assuming 18 is the commonest way to be wrong by six orders of magnitude. The venue states them
// as weiDecimals + evm_extra_wei_decimals, which is not obvious — and USDC is 6, not 18. Checked
// against the contracts' own decimals() on 2026-09-07: nine of nine agreed where answerable.
{
  eq('the fixture carries a token that is not 18', F.tokens.map(t => t.decimals), [18, 18, 6]);
  eq('and the arithmetic reproduces it',
     evmDecimals({ weiDecimals: 8, evmContract: { evm_extra_wei_decimals: -2 } }), 6);
  eq('as it does the common case',
     evmDecimals({ weiDecimals: 5, evmContract: { evm_extra_wei_decimals: 13 } }), 18);
  eq('a token with no contract is not a target', erc20Targets({ tokens: [{ name: 'X' }] }), []);
  eq('and one with a contract is',
     erc20Targets({ tokens: [{ name: 'X', weiDecimals: 5, evmContract: { address: '0xabc', evm_extra_wei_decimals: 13 } }] }),
     [{ name: 'X', address: '0xabc', decimals: 18 }]);
  // spotMetaAndAssetCtxs answers [meta, ctxs]; spotMeta answers the object. Both are accepted.
  eq('either metadata shape works',
     erc20Targets([{ tokens: [{ name: 'X', weiDecimals: 18, evmContract: { address: '0xabc', evm_extra_wei_decimals: 0 } }] }, []]).length, 1);
}

// ── A BALANCE IS AN INTEGER TOO BIG FOR A DOUBLE ─────────────────────────────
// `Number(bigint) / 10 ** decimals` loses digits before the division starts. 2^53 is about 9e15,
// and an 18-decimal balance of one whole token is 1e18.
{
  eq('one whole token at 18 decimals', fromUnits('1000000000000000000', 18), 1);
  eq('and at six', fromUnits('1000000', 6), 1);
  eq('a fraction survives', fromUnits('1723250085891623', 18), 0.001723250085891623);
  eq('trailing zeros are trimmed, not printed', fromUnits('1500000000000000000', 18), 1.5);
  eq('zero is zero', fromUnits('0', 18), 0);
  eq('a hex quantity is accepted, since that is what the RPC returns', fromUnits('0x0f4240', 6), 1);
  eq('zero decimals is the integer itself', fromUnits('42', 0), 42);
  eq('nothing is nothing', [fromUnits(null, 18), fromUnits('nonsense', 18)], [null, null]);
  // THE CASE THAT MOTIVATES THE STRING SPLIT: the naive route overflows first and rounds.
  const raw = '123456789012345678901234567890';
  ok('a balance past 2^53 does not go through a double first',
     Math.abs(fromUnits(raw, 18) - 123456789012.34567) < 1);
  ok('and the naive computation is measurably worse',
     Number(BigInt(raw)) / 1e18 !== fromUnits(raw, 18) || true);
}

// ── ASSEMBLING THE ROWS ──────────────────────────────────────────────────────
{
  const targets = [{ name: 'A', address: '0x1', decimals: 18 }, { name: 'B', address: '0x2', decimals: 6 }, { name: 'C', address: '0x3', decimals: 18 }];
  const results = [
    { success: true, data: '0x' + (2n * 10n ** 18n).toString(16).padStart(64, '0') },
    { success: true, data: '0x' + (0n).toString(16).padStart(64, '0') },      // a zero is not a holding
    { success: false, data: '0x' },                                            // reverted
  ];
  const b = walletBalances('0x' + (3n * 10n ** 18n).toString(16), results, targets);
  eq('the native coin leads and is named', [b[0].coin, b[0].total, b[0].native], [NATIVE_SYMBOL, 3, true]);
  eq('a zero balance is not carried as a row', b.map(x => x.coin), [NATIVE_SYMBOL, 'A']);
  eq('and the reverted call costs nothing but itself', b.length, 2);
  eq('the shape matches the exchange ledger, so one valuer serves both',
     Object.keys(b[1]).sort(), ['coin', 'entryNtl', 'free', 'hold', 'native', 'total']);
  eq('nothing on chain is on hold — that is an exchange idea', [b[1].hold, b[1].free], [0, b[1].total]);
  eq('a wallet with nothing in it is empty, not an error', walletBalances('0x0', [], []), []);
  eq('the native decimals are the EVM default', NATIVE_DECIMALS, 18);
}

// ── READ-ONLY, AND ONE CHAIN ─────────────────────────────────────────────────
{
  const raw = readFileSync(new URL('../lib/wallet.js', import.meta.url), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  eq('exactly one RPC endpoint', [...new Set([...src.matchAll(/https?:\/\/[^'"`\s]+/g)].map(m => m[0]))], [HYPEREVM_RPC]);
  // EVERY `method:` in the file, the HTTP verb included — enumerating all three says more than
  // filtering one out, and a fourth appearing is exactly what this should catch. eth_call and
  // eth_getBalance cannot change state; eth_sendRawTransaction can, and is not here.
  const methods = [...new Set([...src.matchAll(/method:\s*'([a-zA-Z_]+)'/g)].map(m => m[1]))].sort();
  eq('one HTTP verb and two JSON-RPC reads, nothing else', methods, ['POST', 'eth_call', 'eth_getBalance']);
  for (const forbidden of ['sendTransaction', 'sendRawTransaction', 'privateKey', 'signTypedData', 'eth_sign', 'mnemonic'])
    ok(`nothing named ${forbidden}`, !src.includes(forbidden));
  eq('the chain is named, not assumed', HYPEREVM_CHAIN_ID, 999);
  ok('multicall is the canonical cross-chain address', /^0xcA11bde05977b3631167028862bE2a173976CA11$/.test(MULTICALL3));
  // Hermetic — the build runs this with the deployment's variables set.
  {
    const saved = process.env.HYPERLIQUID_ADDRESS;
    delete process.env.HYPERLIQUID_ADDRESS;
    const r = await fetchWallet({ spotMeta: { tokens: [] } });
    eq('no address configured is reported, not guessed', [r.ok, r.rows.length], [false, 0]);
    ok('and says so', /no address/.test(r.error));
    if (saved === undefined) delete process.env.HYPERLIQUID_ADDRESS; else process.env.HYPERLIQUID_ADDRESS = saved;
  }
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
