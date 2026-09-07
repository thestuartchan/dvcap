// test/tokensafety.test.mjs — whether a token can be sold, which is not what a price says.
//
// Prompted by a real wallet: three tokens the holder never bought, dropped in unbidden. One of
// them showed $1.6m of pool liquidity — and its contract is not open source, with 63% of that
// liquidity in a single unlocked wallet. Depth said a pool exists. It did not say anyone could
// sell into it, and the wallet total was counting it as money.
import { readFlags, fetchTokenSafety, SAFETY_CHAIN_IDS, HIGH_SELL_TAX_PCT, MAX_ADDRESSES } from '../lib/tokensafety.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// ── NOTHING FLAGGED IS NOT A CLEAN BILL ──────────────────────────────────────
// This looks for known shapes of bad. It cannot certify good, and a badge reading "safe" would be
// the single most dangerous thing this file could render.
{
  const clean = readFlags({ is_open_source: '1', token_symbol: 'USDC' });
  eq('a clean record flags nothing', clean.reasons, []);
  eq('and says exactly that, not "safe"', clean.verdict, 'nothing flagged');
  eq('an absent record is no verdict at all', [readFlags(null), readFlags('x')], [null, null]);
}

// ── THE SHAPES THAT MATTER ───────────────────────────────────────────────────
{
  const r = (o) => readFlags({ is_open_source: '1', ...o }).reasons;
  ok('a honeypot is named first', /honeypot/.test(r({ is_honeypot: '1' })[0]));
  ok('a partial sell block', r({ cannot_sell_all: '1' }).some(x => /full balance/.test(x)));
  ok('pausable transfers', r({ transfer_pausable: '1' }).some(x => /paused/.test(x)));
  ok('an owner who can rewrite balances', r({ owner_change_balance: '1' }).some(x => /change balances/.test(x)));
  ok('a hidden owner', r({ hidden_owner: '1' }).some(x => /hidden owner/.test(x)));
  ok('reclaimable ownership', r({ can_take_back_ownership: '1' }).some(x => /reclaimed/.test(x)));
  ok('a self-destruct', r({ selfdestruct: '1' }).some(x => /self-destruct/.test(x)));
  // A closed-source contract is not proof of fraud, and is a reason not to trust a number drawn
  // from it — which is the actual finding on the token that prompted this.
  ok('an unpublished contract', readFlags({ is_open_source: '0' }).reasons.some(x => /source not published/.test(x)));
  ok('but a published one is not flagged for it', !r({}).some(x => /source/.test(x)));

  // A sell tax above the threshold is not a fee, it is a partial confiscation.
  eq('the threshold is declared', HIGH_SELL_TAX_PCT, 10);
  ok('a 30% sell tax is flagged', r({ sell_tax: '0.3' }).some(x => /30% sell tax/.test(x)));
  ok('a 1% one is not', !r({ sell_tax: '0.01' }).some(x => /sell tax/.test(x)));
  ok('and an unknown tax is not invented', !r({ sell_tax: '' }).some(x => /sell tax/.test(x)));

  // Unlocked liquidity concentrated in one holder IS the rug, mechanically.
  ok('a majority unlocked LP holder is flagged',
     r({ lp_holders: [{ percent: '0.63', is_locked: 0 }] }).some(x => /63% of liquidity unlocked/.test(x)));
  ok('the same share LOCKED is not', !r({ lp_holders: [{ percent: '0.63', is_locked: 1 }] }).some(x => /unlocked/.test(x)));
  ok('nor is a well-spread pool', !r({ lp_holders: [{ percent: '0.2', is_locked: 0 }, { percent: '0.2', is_locked: 0 }] }).some(x => /unlocked/.test(x)));
  ok('a missing lp list is not a finding', !r({ lp_holders: undefined }).some(x => /liquidity/.test(x)));

  // Several findings travel together; one bad flag does not hide the others.
  const many = readFlags({ is_honeypot: '1', is_open_source: '0', sell_tax: '0.5' });
  eq('every finding is reported', many.reasons.length, 3);
  eq('and the verdict changes', many.verdict, 'flagged');
}

// ── COVERAGE IS NOT UNIVERSAL, AND SAYS SO ───────────────────────────────────
// Verified 2026-09-07 against the supported-chains endpoint: HyperEVM is absent. A chain with no
// data must report NO VERDICT rather than a clean one.
{
  eq('five chains covered', Object.keys(SAFETY_CHAIN_IDS).sort(), ['arbitrum', 'base', 'ethereum', 'polygon', 'robinhood']);
  eq('with the ids the API uses', SAFETY_CHAIN_IDS.robinhood, 4663);
  ok('hyperevm is deliberately absent', !('hyperevm' in SAFETY_CHAIN_IDS));
  const un = await fetchTokenSafety({ chainKey: 'hyperevm', addresses: ['0x1'] });
  eq('an uncovered chain is unsupported, not clean', [un.ok, un.supported, un.flags.size], [false, false, 0]);
  ok('and names the chain it cannot speak for', /hyperevm/.test(un.error));
}

// ── FETCHING ─────────────────────────────────────────────────────────────────
{
  const calls = [];
  const stub = async (url) => { calls.push(url); return { ok: true, json: async () => ({ code: 1, result: {
    '0xaaa': { token_symbol: 'MEME', is_open_source: '0', lp_holders: [{ percent: '0.63', is_locked: 0 }] },
  } }) }; };
  const r = await fetchTokenSafety({ chainKey: 'robinhood', addresses: ['0xAAA'], fetchImpl: stub });
  eq('keyed lower-case, since the caller may not be', [...r.flags.keys()], ['0xaaa']);
  eq('with both findings', r.flags.get('0xaaa').reasons.length, 2);
  ok('and the chain id is in the path', calls[0].includes('/4663?'));

  const many = Array.from({ length: 62 }, (_, i) => '0x' + String(i).padStart(40, '0'));
  calls.length = 0;
  await fetchTokenSafety({ chainKey: 'robinhood', addresses: many, fetchImpl: stub });
  eq('62 addresses is three requests', calls.length, 3);
  ok('none over the ceiling', calls.every(u => u.split('contract_addresses=')[1].split(',').length <= MAX_ADDRESSES));

  // Nothing to ask about costs no request — a verified wallet pays nothing for this.
  calls.length = 0;
  const none = await fetchTokenSafety({ chainKey: 'robinhood', addresses: [], fetchImpl: stub });
  eq('an empty list makes no call', [calls.length, none.ok], [0, true]);

  // Failure leaves rows WITHOUT a verdict rather than with a reassuring one.
  const bad = await fetchTokenSafety({ chainKey: 'robinhood', addresses: ['0xa'], fetchImpl: async () => ({ ok: false, status: 503 }) });
  eq('an outage is reported', [bad.ok, bad.error, bad.flags.size], [false, 'HTTP 503', 0]);
  const threw = await fetchTokenSafety({ chainKey: 'robinhood', addresses: ['0xa'], fetchImpl: async () => { throw new Error('ETIMEDOUT'); } });
  eq('and so is a throw', [threw.ok, threw.flags.size], [false, 0]);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
