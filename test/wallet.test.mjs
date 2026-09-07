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
import { CHAINS, CHAIN_KEYS, pricedSymbols } from '../lib/chains.js';
import { spotHoldings } from '../lib/hyperliquid.js';
import { encodeAggregate3, decodeAggregate3, balanceOfCall, evmDecimals, erc20Targets,
         fromUnits, walletBalances, fetchWallet, MULTICALL3, HYPEREVM_RPC, HYPEREVM_CHAIN_ID,
         NATIVE_SYMBOL, NATIVE_DECIMALS, venuePrices, chainPrices,
         decodeString, decodeMetadata, SYMBOL_SIG, DECIMALS_SIG } from '../lib/wallet.js';

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
  // The endpoints moved to lib/chains.js when the wallet stopped being HyperEVM-only, so the
  // assertion moves with them rather than being dropped — a removed check is indistinguishable
  // from one that was never made.
  eq('the reader itself hardcodes no endpoint', [...new Set([...src.matchAll(/https?:\/\/[^'"`\s]+/g)].map(m => m[0]))], []);
  {
    const chains = readFileSync(new URL('../lib/chains.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const urls = [...new Set([...chains.matchAll(/https?:\/\/[^'"`\s]+/g)].map(m => m[0]))].sort();
    eq('and the registry names exactly the six verified ones', urls, [
      'https://arb1.arbitrum.io/rpc',
      'https://ethereum-rpc.publicnode.com',
      'https://mainnet.base.org',
      'https://polygon-bor-rpc.publicnode.com',
      'https://rpc.hyperliquid.xyz/evm',
      'https://rpc.mainnet.chain.robinhood.com',
    ]);
    ok('every one of them over TLS', urls.every(u => u.startsWith('https://')));
    eq('HyperEVM is still where it was', HYPEREVM_RPC, 'https://rpc.hyperliquid.xyz/evm');
  }
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

// ── SIX CHAINS, ONE ENCODER ──────────────────────────────────────────────────
// Multicall3 sits at the same canonical address on every one of them, verified deployed, so the
// tested encoder above serves all six and there is no second implementation to drift.
{
  eq('the chains, in order', CHAIN_KEYS, ['hyperevm', 'ethereum', 'arbitrum', 'base', 'polygon', 'robinhood']);
  eq('each names its id', Object.values(CHAINS).map(c => c.id), [999, 1, 42161, 8453, 137, 4663]);
  ok('all six carry an RPC', Object.values(CHAINS).every(c => /^https:\/\//.test(c.rpc)));
  ok('and a native asset with decimals', Object.values(CHAINS).every(c => c.native?.symbol && c.native.decimals > 0));
  // Ids are what a mis-copied RPC would betray, so no two may share one.
  eq('no id is repeated', new Set(Object.values(CHAINS).map(c => c.id)).size, CHAIN_KEYS.length);

  // EVERY ADDRESS IS A 20-BYTE HEX ADDRESS, and unique within its chain. A duplicate would read
  // one token's balance twice under two names and quietly double it in the total.
  for (const [k, c] of Object.entries(CHAINS)) {
    ok(`${k}: every address is well formed`, c.tokens.every(t => /^0x[0-9a-fA-F]{40}$/.test(t.address)));
    eq(`${k}: no address appears twice`, new Set(c.tokens.map(t => t.address.toLowerCase())).size, c.tokens.length);
    eq(`${k}: no symbol appears twice`, new Set(c.tokens.map(t => t.symbol)).size, c.tokens.length);
    ok(`${k}: decimals are stated, never assumed`, c.tokens.every(t => Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 36));
  }
  // Not everything is 18. Assuming so is the commonest way to be wrong by six orders of magnitude,
  // and this registry contains the counterexamples: every stable here is 6, WBTC and cbBTC are 8.
  ok('the registry contains non-18 decimals', Object.values(CHAINS).flatMap(c => c.tokens).some(t => t.decimals !== 18));
  eq('every USDC is six', Object.values(CHAINS).flatMap(c => c.tokens).filter(t => t.symbol.startsWith('USDC')).map(t => t.decimals),
     [6, 6, 6, 6, 6]);
  eq('and the wrapped bitcoins are eight', Object.values(CHAINS).flatMap(c => c.tokens).filter(t => /BTC$/.test(t.symbol)).map(t => t.decimals),
     [8, 8, 8, 8]);

  // ── PRICED BY A VENUE, NOT BY A TICKER ─────────────────────────────────────
  // Measured 2026-09-07: Yahoo and Hyperliquid agree within 0.1% on ETH, BTC and LINK, and differ
  // by 266x on ARB and 12x on POL. Those tickers are other instruments. Nothing here may resolve a
  // price by symbol lookup, so each entry names the VENUE symbol to price against.
  // USDT is quoted on the venue's SPOT book as USDT0, not as a perp — there is no perp on a
  // dollar. DAI is quoted nowhere at all and is marked `par` instead of naming a symbol.
  eq('the venue symbols needed', pricedSymbols(), ['ARB', 'BTC', 'ETH', 'HYPE', 'LINK', 'POL', 'USDC', 'USDT0']);
  const venue = venuePrices({ ETH: { mark: 2482.6 }, BTC: { mark: 79009 }, ARB: { mark: 0.16753 }, POL: { mark: 0.096535 } });
  eq('a mark becomes a price', venue.get('ETH').price, 2482.6);
  ok('a listed perp is never thin — it is a real market by construction', venue.get('ETH').volume === Infinity);
  eq('a market with no mark is not priced', venuePrices({ X: {} }).size, 0);

  // The translation is the point: a row says WETH, the venue quotes ETH.
  const p = chainPrices(CHAINS.arbitrum, venue);
  eq('WETH is priced off ETH', p.get('WETH').price, 2482.6);
  eq('WBTC off BTC', p.get('WBTC').price, 79009);
  eq('ARB off ARB', p.get('ARB').price, 0.16753);
  ok('and a token the venue does not quote is simply absent', !p.has('USDT0'));
  eq('the native asset is priced too', chainPrices(CHAINS.polygon, venue).get('POL').price, 0.096535);

  // ── ROBINHOOD CHAIN SAYS WHAT IT CANNOT SEE ────────────────────────────────
  // Its tokenised assets are not addresses to guess at, and its explorer sits behind Cloudflare so
  // a serverless function cannot enumerate them. Native only — declared, not implied.
  // It carries exactly two, both taken from Robinhood's own contract docs and then confirmed
  // against the chain — WETH at 18 decimals, USDG at 6. PINNED BY ADDRESS on purpose: since July
  // 2026 this chain has carried deliberate fake USDG and WETH clones, deployed elsewhere and
  // seeded into pools to look tradeable. Matching on symbol here would be the attack working.
  eq('robinhood pins the two anchors it can verify', CHAINS.robinhood.tokens.map(t => t.symbol), ['WETH', 'USDG']);
  eq('by address, at the decimals the chain reported', CHAINS.robinhood.tokens.map(t => t.decimals), [18, 6]);
  ok('WETH prices off the venue', CHAINS.robinhood.tokens[0].hl === 'ETH');
  ok('and USDG at par, since nothing quotes it', CHAINS.robinhood.tokens[1].par === true);
  // Everything ELSE on the chain still has no quote, which is what the flag says.
  ok('and says the rest of the list is missing rather than empty', CHAINS.robinhood.tokensUnlisted === true);
  ok('no other chain claims that', Object.entries(CHAINS).filter(([, c]) => c.tokensUnlisted).length === 1);
  // A chain with no tokens still reads its native balance.
  eq('its native asset is still named', CHAINS.robinhood.native.symbol, 'ETH');
}

// ── STABLECOINS HAVE NO PERP, AND UNPRICED MEANT UNCOUNTED ───────────────────
// Found on screen: the wallet reported $65 across all chains while holding 101.81 USDC on
// Arbitrum. Pricing wallet tokens off perp marks alone left every USDC, USDT and DAI balance with
// no quote — and spotHoldings excludes an unpriced row from the total, correctly, because it
// cannot value it. So the headline was missing its own largest position.
{
  const perpsOnly = venuePrices({ ETH: { mark: 2481.31 }, ARB: { mark: 0.16753 } });
  ok('no venue lists a perp on a dollar', !perpsOnly.has('USDC') && !perpsOnly.has('USDT0'));
  const before = chainPrices(CHAINS.arbitrum, perpsOnly);
  ok('which is exactly how USDC went unpriced', !before.has('USDC'));

  // The spot book quotes what the perp book cannot. Merged behind the perps, never over them.
  const merged = new Map(perpsOnly);
  for (const [k, v] of [['USDC', { price: 1, volume: Infinity }], ['USDT0', { price: 0.999755, volume: 980897 }]])
    if (!merged.has(k)) merged.set(k, v);
  const after = chainPrices(CHAINS.arbitrum, merged);
  eq('USDC is priced once spot is merged in', after.get('USDC').price, 1);
  eq('and USDT0 by its spot pair, not at an assumed par', after.get('USDT0').price, 0.999755);
  ok('which is a measured price, so it is not flagged', !after.get('USDT0').assumedPar);
  eq('a perp still wins where one exists', after.get('WETH').price, 2481.31);

  // DAI is quoted by neither. Par is assumed so the balance is COUNTED, and flagged so the
  // assumption is visible — a depeg is exactly when an assumed par stops being harmless.
  const dai = after.get('DAI');
  eq('DAI falls back to par', dai.price, 1);
  ok('and says that it is assumed', dai.assumedPar === true);
  ok('only stablecoins may do that', CHAINS.arbitrum.tokens.filter(t => t.par).every(t => /^(DAI|USD)/.test(t.symbol)));
  ok('and nothing non-par is ever assumed', !after.get('WETH').assumedPar && !after.get('ARB').assumedPar);

  // A token that is neither quoted nor par stays unpriced. Par must not become a catch-all — an
  // unvalued holding is still reported, just not counted, which is the honest half of this.
  eq('an unquoted non-stable is still unpriced', chainPrices({ tokens: [{ symbol: 'ZZZ', hl: 'ZZZ' }] }, merged).size, 0);

  // Every chain's stables now resolve, which is the property that was broken.
  for (const [k, c] of Object.entries(CHAINS)) {
    if (c.tokensFrom) continue;                       // HyperEVM prices off its own spot book
    const p = chainPrices(c, merged);
    const stables = c.tokens.filter(t => /^(DAI|USD)/.test(t.symbol));
    ok(`${k}: every stablecoin resolves to a price`, stables.every(t => p.has(t.symbol)));
  }
}

// ── A DISCOVERED CONTRACT IS AN ADDRESS AND NOTHING ELSE ─────────────────────
// The indexer says WHICH contracts an address holds. It does not get to say what they are: symbol
// and decimals are read from the contracts themselves, over the chain's own RPC, to the same
// standard every hand-written entry in lib/chains.js had to meet.
{
  // Built the way the ABI actually lays a dynamic string out: offset, length, right-padded bytes.
  const dynString = (t) => {
    const b = Buffer.from(t, 'utf8').toString('hex');
    const len = (b.length / 2).toString(16).padStart(64, '0');
    return '0x' + (32).toString(16).padStart(64, '0') + len + b.padEnd(Math.ceil(b.length / 64) * 64, '0');
  };
  const bytes32 = (t) => '0x' + Buffer.from(t, 'utf8').toString('hex').padEnd(64, '0');
  const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

  eq('a dynamic string symbol decodes', decodeString(dynString('USDC')), 'USDC');
  // MKR and other early tokens return bytes32, not a string. Verified live against MKR's own
  // contract on 2026-09-07 alongside three string-symbol tokens.
  eq('a bytes32 symbol decodes too', decodeString(bytes32('MKR')), 'MKR');
  eq('and padding is stripped rather than shown', decodeString(bytes32('DAI')), 'DAI');
  eq('nothing decodes to nothing', [decodeString(''), decodeString(null), decodeString('0x')], [null, null, null]);
  // Binary junk in a bytes32 slot is not a name.
  eq('non-printable bytes are refused', decodeString('0x' + 'ff'.repeat(32)), null);

  const results = (pairs) => pairs.flatMap(([sym, dec]) => ([
    { success: sym != null, data: sym ?? '0x' },
    { success: dec != null, data: dec ?? '0x' },
  ]));
  const addrs = ['0x1', '0x2', '0x3', '0x4'];
  const meta = decodeMetadata(results([
    [dynString('USDC'), word(6)],
    [bytes32('MKR'), word(18)],
    [null, word(18)],                    // symbol() reverted — not a token we can name
    [dynString('WAT'), null],            // decimals() reverted
  ]), addrs);
  eq('only fully-identified contracts get a row', meta.map(m => m.name), ['USDC', 'MKR']);
  eq('with the decimals the contract stated', meta.map(m => m.decimals), [6, 18]);
  // GUESSING 18 IS HOW A DUST TOKEN BECOMES A FORTUNE. A contract that will not say what it is
  // does not get a row at all — a balance under a bare address is not information.
  ok('a contract that will not name itself is dropped, not defaulted', !meta.some(m => m.address === '0x3'));
  ok('and so is one that will not state its decimals', !meta.some(m => m.address === '0x4'));
  eq('absurd decimals are refused too', decodeMetadata(results([[dynString('X'), word(99)]]), ['0x9']), []);

  // The selectors are the standard ERC-20 ones, asserted rather than assumed.
  eq('symbol() and decimals() selectors', [SYMBOL_SIG, DECIMALS_SIG], ['0x95d89b41', '0x313ce567']);
}

// ── A MODULE NOTHING CALLS IS NOT A FEATURE ──────────────────────────────────
// lib/tokensafety.js shipped with 35 passing assertions, a UI that renders its findings, and
// NOTHING WIRING THE TWO TOGETHER — an edit was lost when a later assertion in the same script
// aborted before the write, and the tests all still passed because they test the module, not its
// use. The screenshot is what caught it.
//
// Source-scanned rather than executed, deliberately: the failure was absence, and absence is what
// this checks. It is the same shape as scripts/check-api-auth.mjs, for the same reason.
{
  const src = readFileSync(new URL('../lib/wallet.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('the wallet imports the safety check', /from '\.\/tokensafety\.js'/.test(src));
  ok('and actually calls it', /fetchTokenSafety\s*\(/.test(src));
  ok('and puts the result on a row', /\.safety\s*=/.test(src));
  // Asked only about what is held AND unvouched — a verified token needs no verdict and a zero
  // balance needs no explanation, so neither may cost a request.
  ok('scoped to held, unvouched, non-native rows', /viaPool\s*&&\s*!r\.verified/.test(src));
  // The acquisition read is the same class of wiring and fails the same silent way.
  ok('the wallet asks how each token arrived', /fetchAcquisition\s*\(/.test(src));
  ok('and marks the ones that were paid for', /\.acquired\s*=\s*true/.test(src));
  // The same guard for every other module the wallet leans on, so a lost edit is caught once.
  for (const [mod, fn] of [['dexscreener', 'fetchDexPrices'], ['alchemy', 'discoverTokens'], ['chains', 'CHAINS']])
    ok(`${mod} is imported and used`, new RegExp(`from '\\./${mod}\\.js'`).test(src) && new RegExp(`\\b${fn}\\b`).test(src));
}

// ── A NOMINAL VALUE IS NOT A RANK ────────────────────────────────────────────
// Sorting on value alone put the junk on top, twice. First a fictional $6.2tn airdrop led the list
// above the real holdings. Then five unvouched airdrops — a nominal $753, $422, $109, $102, $81 —
// sorted above the $11 of ETH that was the only thing in that wallet anyone had chosen to own.
{
  const prices = new Map([
    ['REAL', { price: 10, volume: Infinity }],
    ['SMALL', { price: 1, volume: Infinity }],
    ['JUNK', { price: 0.7, volume: 5e5, viaPool: 'WETH', verified: false }],
    ['DEAD', { price: 1e9, volume: 1 }],
  ]);
  const bal = (coin, total) => ({ coin, total, hold: 0, free: total, entryNtl: 0 });
  const h = spotHoldings([bal('REAL', 1.1), bal('JUNK', 1070), bal('SMALL', 5), bal('DEAD', 1), bal('NOPE', 3)], prices);

  eq('owned and valued first, then unvouched, then unvaluable',
     h.rows.map(r => r.coin), ['REAL', 'SMALL', 'JUNK', 'DEAD', 'NOPE']);
  ok('the biggest nominal number is NOT at the top', h.rows[0].coin !== 'DEAD' && h.rows[0].coin !== 'JUNK');
  // And the total counts only what is vouched for.
  eq('the total excludes the unvouched', h.total, 16);
  eq('which is reported rather than silently dropped', [h.unverified.count, h.unverified.value], [1, 749]);
  ok('the unvouched row is still listed', h.rows.some(r => r.coin === 'JUNK'));
  ok('and carries the marker the card reads', h.rows.find(r => r.coin === 'JUNK').viaPool === 'WETH');
  // A verified token priced from a pool is NOT held back — provenance, not price source.
  const v = spotHoldings([bal('WETH', 1)], new Map([['WETH', { price: 2493, volume: Infinity, viaPool: 'USDG', verified: true }]]));
  eq('a verified token priced by pool still counts', v.total, 2493);
  eq('and is not in the held-out bucket', v.unverified.count, 0);
}

// ── A SWAP IS A DECISION; AN AIRDROP IS NOT ──────────────────────────────────
// Holding tokens out of the total because nothing vouched for the CONTRACT punished ones the
// holder had deliberately swapped for — the dashboard second-guessing a decision already made.
// What counts is whether the wallet gave something up, which lib/alchemy.js reads off the chain.
{
  const prices = new Map([
    ['REAL', { price: 10, volume: Infinity }],
    ['BOUGHT', { price: 0.7, volume: 5e5, viaPool: 'USDG', verified: false }],
    ['DROPPED', { price: 0.7, volume: 5e5, viaPool: 'USDG', verified: false }],
  ]);
  const bal = (coin, total, acquired) => ({ coin, total, hold: 0, free: total, entryNtl: 0, ...(acquired ? { acquired: true } : {}) });
  const h = spotHoldings([bal('REAL', 1.1), bal('BOUGHT', 1070, true), bal('DROPPED', 1070)], prices);

  eq('a swapped token counts, however its contract looks', h.total, 760);
  eq('and only the unsolicited one is held out', h.unverified.coins, ['DROPPED']);
  // It also stops being second-class in the ordering: a position taken ranks with the rest.
  eq('the swapped token sorts as an ordinary holding', h.rows.map(r => r.coin), ['BOUGHT', 'REAL', 'DROPPED']);
  ok('and carries the flag the card reads', h.rows.find(r => r.coin === 'BOUGHT').acquired === true);
  ok('while the dropped one does not', h.rows.find(r => r.coin === 'DROPPED').acquired === false);

  // The verdict is about PROVENANCE, not quality. This must not become a goodness test.
  const scam = spotHoldings([bal('SCAM', 100, true)],
    new Map([['SCAM', { price: 1, volume: 5e5, viaPool: 'USDG', verified: false }]]));
  eq('a token someone bought counts even if it is junk', scam.total, 100);
  eq('and nothing is held out', scam.unverified.count, 0);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
