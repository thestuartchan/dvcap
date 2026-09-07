// test/hyperliquid.test.mjs — the venue's own numbers for a perpetual.
//
// A crypto row prices off a Yahoo SPOT quote. If the position is a Hyperliquid perp, two things
// that quote cannot express change the P&L materially: FUNDING (measured 2026-09-06 at 11.0%
// annualised on BTC, paid by the long) and BASIS. A perp long showing +3% after a month is really
// +2.1%, and neither realised nor unrealised P&L can see the difference.
//
// Parsed from a FIXTURE, not the network: funding moves hourly, so a test that asserted today's
// rate would fail tomorrow for the one reason that is not a defect.
import { readFileSync } from 'node:fs';
import { parseSpotBalances, spotPrices, spotHoldings, fetchHlSpot, HL_SPOT_QUOTE, SPOT_DUST_USD, SPOT_THIN_VOLUME_USD,
         isAddress, fetchHlAccount, HL_ADDRESS_ENV, parsePositions, accountSummary, estimateLiquidation, leverageAt, maintenanceMarginFraction, liquidationVsStop } from '../lib/hyperliquid.js';
import { parseMetaAndCtxs, fundingRead, basisRead, hlCoin, hlPerpCoin, isHlPerp, perpQuote, HL_PREFIX, FUNDING_PER_YEAR, FUNDING_LOUD_APR } from '../lib/hyperliquid.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// Shaped exactly as the venue replied on 2026-09-06.
const FIXTURE = [
  { universe: [
      { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
      { name: 'SOL', szDecimals: 2, maxLeverage: 20 },
      { name: 'WIF', szDecimals: 0, maxLeverage: 10 },   // whole units only
    ] },
  [
    { markPx: '79604.0', oraclePx: '79631.4', midPx: '79605.0', funding: '0.0000125', openInterest: '34712.2995' },
    { markPx: '106.05',  oraclePx: '106.10',  midPx: '106.06',  funding: '-0.0000300', openInterest: '900000' },
    { markPx: '0.8123',  oraclePx: '0.8130',  midPx: '0.8124',  funding: '0.0001000', openInterest: '12000' },
  ],
];
const M = parseMetaAndCtxs(FIXTURE);

// ── mapping ──────────────────────────────────────────────────────────────────
eq('a pair maps to its base leg', [hlCoin('BTC-USD'), hlCoin('SOL-USDT'), hlCoin('ETH-EUR')], ['BTC', 'SOL', 'ETH']);
eq('an equity never looks up as a perp', [hlCoin('NVDA'), hlCoin('BRK-B'), hlCoin('IBIT')], [null, null, null]);
eq('nor does a bare base — it is a listed security', hlCoin('BTC'), null);

// ── parsing ──────────────────────────────────────────────────────────────────
eq('three markets parsed', Object.keys(M).length, 3);
eq('mark and oracle are numbers, not strings', [M.BTC.mark, M.BTC.oracle], [79604, 79631.4]);
eq('funding is annualised from the HOURLY rate', M.BTC.fundingApr, +(0.0000125 * FUNDING_PER_YEAR * 100).toFixed(2));
ok('which is about 11% a year', Math.abs(M.BTC.fundingApr - 10.95) < 0.1);
eq('a malformed payload yields nothing rather than throwing', [parseMetaAndCtxs(null), parseMetaAndCtxs([{}, []])], [{}, {}]);

// THE VENUE'S OWN SIZE GRANULARITY, which is per-market and not a property of "crypto". 133 of its
// 233 markets are whole units only, so a single guessed step is wrong for most of them.
eq('size steps come from the venue', [M.BTC.sizeStep, M.SOL.sizeStep, M.WIF.sizeStep], [0.00001, 0.01, 1]);
ok('and are exact, not 0.0000099999', M.BTC.sizeStep === 1e-5);
eq('max leverage travels too', [M.BTC.maxLeverage, M.WIF.maxLeverage], [40, 10]);

// ── who pays ─────────────────────────────────────────────────────────────────
// Positive funding means LONGS PAY SHORTS — the venue's convention, which every sign follows.
{
  const bl = fundingRead(M.BTC, 'long'), bs = fundingRead(M.BTC, 'short');
  ok('a long pays when funding is positive', bl.paying);
  ok('and the short is paid', !bs.paying);
  eq('the magnitude is the same either way', Math.abs(bl.perMonthPct), Math.abs(bs.perMonthPct));
  eq('but the sign to THIS side flips', [bl.aprToSide > 0, bs.aprToSide > 0], [true, false]);
  ok('the note says which', /costs/.test(bl.note) && /pays/.test(bs.note));

  // Negative funding inverts it — the short pays. SOL in the fixture.
  const sl = fundingRead(M.SOL, 'long'), ss = fundingRead(M.SOL, 'short');
  ok('negative funding pays the long', !sl.paying);
  ok('and charges the short', ss.paying);

  // Loud when the carry is a position-level fact rather than a detail.
  ok('11% a year is not loud', !bl.loud);
  ok('but WIF at ~88% is', fundingRead(M.WIF, 'long').loud);
  ok('and the threshold is where it says it is', FUNDING_LOUD_APR === 20);
  eq('a missing record reads as unknown, never as zero funding', fundingRead(null), null);
  eq('and so does a record with no funding', fundingRead({ mark: 1 }), null);
}

// ── basis ────────────────────────────────────────────────────────────────────
{
  const b = basisRead(79629.91, M.BTC);
  eq('spot against the mark', b.pct, +(((79629.91 - 79604) / 79604) * 100).toFixed(3));
  ok('a third of a basis point is not wide', !b.wide);
  ok('half a percent is', basisRead(79604 * 1.006, M.BTC).wide);
  ok('and it is symmetric', basisRead(79604 * 0.994, M.BTC).wide);
  eq('a missing leg yields nothing', [basisRead(null, M.BTC), basisRead(100, null)], [null, null]);
}

// ── THE BOUNDARY, WHICH MOVED BECAUSE IT WAS ASKED TO ────────────────────────
// Option 1 read public market data only, and this asserted the module contained no account call
// at all. Option 2 was then chosen deliberately, so the boundary is different now — and the test
// states the NEW one rather than being deleted, because a removed assertion is indistinguishable
// from an assertion that was never made.
//
// What must still hold: no credential of any kind, the address taken ONLY from the environment,
// and nothing that can place or move anything.
{
  const raw = readFileSync(new URL('../lib/hyperliquid.js', import.meta.url), 'utf8');
  // Prose is stripped first — the previous version of this failed on the word "signature" inside a
  // comment saying there is no signature.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const forbidden of ['privateKey', 'apiKey', 'signature', 'sign(', 'secret'])
    ok(`no ${forbidden} in the code`, !src.includes(forbidden));
  // READ-ONLY, asserted on the property that actually decides it: the venue's writes all go to
  // /exchange, and this module knows exactly one URL — the info endpoint. Matching action words as
  // substrings was the first attempt and it failed on `withdrawable`, a BALANCE FIELD it reads;
  // a checker that cannot tell a noun from a verb gets switched off.
  const urls = [...src.matchAll(/https?:\/\/[^'"`\s]+/g)].map(m => m[0]);
  eq('exactly one endpoint, and it is the read one', [...new Set(urls)], ['https://api.hyperliquid.xyz/info']);
  ok('nothing addresses the write path', !src.includes('/exchange'));
  ok('and no order action is named', !/\b(placeOrder|cancelByCloid|usdSend|withdraw3)\b/.test(src));

  // EVERY request type this module can send, enumerated. It caught the spot read being added,
  // which is exactly the job: widening what a deployment holding an address can ask for is a
  // decision to make on purpose, in a diff, rather than a thing that accretes.
  const types = [...new Set([...src.matchAll(/type:\s*'([a-zA-Z]+)'/g)].map(m => m[1]))].sort();
  // DISTINCT types: spotMetaAndAssetCtxs is now sent from two places — fetchHlSpot when it has no
  // shared context, and fetchSpotContext, which exists so the wallet and the ledger pull the 270KB
  // payload once between them. Two call sites of one read is not a wider surface.
  eq('five read requests and no others', types,
     ['clearinghouseState', 'frontendOpenOrders', 'metaAndAssetCtxs', 'spotClearinghouseState',
      'spotMetaAndAssetCtxs']);
  // Structural rather than a restatement of the list above: every read this venue offers is named
  // for the thing it RETURNS — a ...State, a set of ...Ctxs, or a list of ...Orders. Its write verbs
  // are actions — order, cancel, usdSend, withdraw3 — and none of them ends that way.
  //
  // `Orders` was added for frontendOpenOrders, which reads resting trigger orders so the card can
  // show a stop and a target. It is worth being explicit that this does NOT open a door: the write
  // is `order`, singular and lowercase, so it fails this pattern on the capital and the plural
  // both — and it is sent to /exchange, which the assertion two lines above forbids outright. The
  // endpoint check is the real lock; this one is the tripwire that makes a new read deliberate.
  ok('and every one of them is named for a thing, not an action',
     types.every(t => /(State|Ctxs|Orders)$/.test(t)));
  ok('the write verb would still fail this pattern', !/(State|Ctxs|Orders)$/.test('order'));

  // THE ADDRESS COMES FROM THE ENVIRONMENT, never from a caller. A route that took it as a
  // parameter would be a way to read anyone's account through this deployment.
  ok('the env var is named once and used', src.includes('HL_ADDRESS_ENV') && src.includes("'HYPERLIQUID_ADDRESS'"));
  ok('and the default argument reads process.env', /address\s*=\s*process\.env\[HL_ADDRESS_ENV\]/.test(src));
  // An address must look like one before it is sent anywhere.
  eq('addresses are validated', [isAddress('0x' + 'a'.repeat(40)), isAddress('0xnope'), isAddress(''), isAddress(null)],
     [true, false, false, false]);
  // HERMETIC, BECAUSE THE BUILD RUNS THIS FILE. `fetchHlAccount({ address: undefined })` looked
  // like it was asking about an unset address and was in fact asking the ENVIRONMENT: passing
  // `undefined` explicitly still triggers the default parameter, which reads process.env. Locally
  // that variable is empty, so it passed for days.
  //
  // Vercel injects production environment variables into the BUILD, and the build runs npm test.
  // So the hour HYPERLIQUID_ADDRESS was added, every PRODUCTION deployment began failing here in
  // about seven seconds — while previews, which carry a different variable set, stayed green. Two
  // merges sat in main, undeployed, with the site serving the build before them. Merging is not
  // deploying, and a test that reads ambient configuration reads a different answer per
  // environment — which is the one thing a test must never do.
  {
    const saved = process.env[HL_ADDRESS_ENV];
    delete process.env[HL_ADDRESS_ENV];
    eq('an unset address is reported, not guessed at', (await fetchHlAccount({})).configured, false);
    // The complement, which is the case that broke the build and which nothing asserted: a
    // configured address IS picked up from the environment. Deliberately malformed, so this proves
    // the variable was read without making a network call from a build.
    process.env[HL_ADDRESS_ENV] = 'not-an-address';
    const set = await fetchHlAccount({});
    eq('and a configured one is read from it', [set.configured, set.ok], [true, false]);
    ok('with the reason named rather than guessed', /not a 0x address/.test(set.error));
    if (saved === undefined) delete process.env[HL_ADDRESS_ENV]; else process.env[HL_ADDRESS_ENV] = saved;
  }
}

// ── A PERP IS NAMED BY ITS VENUE, NOT BY ITS TICKER ──────────────────────────
// Pricing a Hyperliquid perp off a Yahoo <TICKER>-USD lookup is not an approximation, it is a
// different asset. Crypto has no central ticker registry, so the same letters name different
// things on different venues and the lookup succeeds either way. Measured 2026-09-06:
//   HYPE  HL 87.264   Yahoo 0.0000054038  — a million times apart
//   PURR  HL 0.11914  Yahoo 126.50161     — a thousand times, the other way
//   JUP   HL 0.26668  Yahoo 0.000328901   — eight hundred times
// HYPE is Hyperliquid's own token and one of its three largest markets.
{
  eq('a prefixed symbol names its coin', [hlPerpCoin('HL:BTC'), hlPerpCoin('hl:hype')], ['BTC', 'HYPE']);
  eq('a spot pair is NOT a perp', [hlPerpCoin('BTC-USD'), hlPerpCoin('HYPE-USD')], [null, null]);
  eq('nor is an equity', [hlPerpCoin('NVDA'), hlPerpCoin('BRK-B'), hlPerpCoin('')], [null, null, null]);
  eq('a malformed prefix yields nothing', [hlPerpCoin('HL:'), hlPerpCoin('HL:BT-C')], [null, null]);
  ok('and the predicate agrees', isHlPerp('HL:SOL') && !isHlPerp('SOL-USD'));
  eq('the prefix is what it says', HL_PREFIX, 'HL:');

  // The quote a perp row prices off is the MARK, with the venue's own day change and size step.
  const rec = M.BTC;
  const withPrev = parseMetaAndCtxs([FIXTURE[0], [{ ...FIXTURE[1][0], prevDayPx: '78000.0' }, FIXTURE[1][1], FIXTURE[1][2]]]).BTC;
  const q = perpQuote(withPrev);
  eq('priced at the mark, not a spot proxy', q.price, 79604);
  eq('day change from the venue prev close', q.changePercent, +(((79604 - 78000) / 78000) * 100).toFixed(2));
  eq('and it carries the venue size step', q.sizeStep, 0.00001);
  eq('labelled with where it came from', q.venue, 'hyperliquid');
  eq('no prev close means no change, not a fabricated zero', perpQuote(rec).changePercent, null);
  // A perp the venue does not list is ABSENT, never present at zero — the defect a `?? 0` default
  // caused for MNQ, which reported a position down 100%.
  eq('an unlisted perp yields no quote at all', [perpQuote(null), perpQuote({ mark: null })], [null, null]);

  // THE SIZE STEP IS PER MARKET. 133 of the venue's 233 markets are whole units, so "crypto is
  // divisible" is wrong for most of them and a fractional suggestion is not a placeable order.
  eq('whole-unit markets report a step of 1', perpQuote(M.WIF).sizeStep, 1);
  ok('which is not divisible', !(perpQuote(M.WIF).sizeStep < 1));
  ok('where BTC is', perpQuote(withPrev).sizeStep < 1);
}

// ── LIQUIDATION IS THE STOP THE VENUE ENFORCES ───────────────────────────────
// At up to 40x the exchange closes the position before any stop of yours does. The formula is
// Hyperliquid's own — liq = price - side * margin_available / position_size / (1 - l * side),
// with maintenance margin defined as HALF the initial margin at max leverage — not derived here.
{
  const BTC = { maxLeverage: 40, tiers: [{ lowerBound: '0.0', maxLeverage: 40 }, { lowerBound: '150000000.0', maxLeverage: 20 }] };

  eq('maintenance margin is half the initial at max leverage',
     [maintenanceMarginFraction(40), maintenanceMarginFraction(3)], [1 / 80, 1 / 6]);

  // THE IDENTITY THAT PROVES THE FORMULA. Unleveraged there is nothing to liquidate: (1/1 - mmf)
  // over (1 - mmf) is exactly 1, so the price must reach zero. Any algebra slip breaks this.
  eq('1x long liquidates at zero', estimateLiquidation({ entry: 80000, leverage: 1, side: 'long', ...BTC }).liq, 0);

  const at = (L, side) => estimateLiquidation({ entry: 80000, leverage: L, side, ...BTC });
  ok('40x sits about 1.27% away', Math.abs(at(40, 'long').distancePct + 1.27) < 0.02);
  ok('10x about 8.9%', Math.abs(at(10, 'long').distancePct + 8.86) < 0.02);
  ok('a long liquidates BELOW entry', at(10, 'long').liq < 80000);
  ok('a short liquidates ABOVE it', at(10, 'short').liq > 80000);
  // Not symmetric, and it should not be: the (1 - l*side) term differs by side.
  ok('the two sides are close but not equal', Math.abs(at(10, 'long').distancePct) !== Math.abs(at(10, 'short').distancePct));
  ok('more leverage is nearer', Math.abs(at(20, 'long').distancePct) < Math.abs(at(10, 'long').distancePct));

  // TIERS: leverage falls as the position grows, so max leverage is a function of size.
  eq('BTC is 40x small and 20x above $150m', [leverageAt(BTC.tiers, 40, 1e6), leverageAt(BTC.tiers, 40, 200e6)], [40, 20]);
  eq('no tiers falls back to the headline', leverageAt(null, 25, 1e9), 25);
  const over = estimateLiquidation({ entry: 80000, leverage: 41, ...BTC });
  eq('past the cap it refuses rather than extrapolating', [over.liq, over.over], [null, true]);
  eq('and says what the cap is', over.tierMaxLeverage, 40);
  eq('missing inputs yield nothing', [estimateLiquidation({}), estimateLiquidation({ entry: 0, leverage: 5, ...BTC })], [null, null]);
  ok('it labels itself an isolated estimate', at(10, 'long').isolated && /cross margin/.test(at(10, 'long').note));

  // WHICH BINDS FIRST. If the exchange liquidates before the stop, the stop is fiction and the R
  // on the row is overstated — the whole reason this is worth showing.
  eq('a long whose liq sits above its stop is liquidated first',
     liquidationVsStop({ liq: 73000, stop: 70000, side: 'long' }).liqFirst, true);
  eq('and below it, the stop binds', liquidationVsStop({ liq: 68000, stop: 70000, side: 'long' }).liqFirst, false);
  eq('inverted for a short', [liquidationVsStop({ liq: 86000, stop: 88000, side: 'short' }).liqFirst,
                              liquidationVsStop({ liq: 90000, stop: 88000, side: 'short' }).liqFirst], [true, false]);
  ok('and it says which, in words', /overstated/.test(liquidationVsStop({ liq: 73000, stop: 70000, side: 'long' }).note));
  eq('no stop, no comparison', liquidationVsStop({ liq: 1 }), null);
}

// ── A REAL POSITION USES THE EXCHANGE'S OWN NUMBER ───────────────────────────
{
  const payload = { marginSummary: { accountValue: '12500.5', totalNtlPos: '80000', totalMarginUsed: '8000' },
    withdrawable: '4500.5',
    assetPositions: [
      { position: { coin: 'BTC', szi: '0.5', entryPx: '79000', liquidationPx: '71000', positionValue: '40000',
                    unrealizedPnl: '500', marginUsed: '4000', leverage: { type: 'isolated', value: 10 } } },
      { position: { coin: 'ETH', szi: '-3.0', entryPx: '2500', liquidationPx: '2800', positionValue: '7500',
                    unrealizedPnl: '-120', marginUsed: '750', leverage: { type: 'cross', value: 10 } } },
      { position: { coin: 'SOL', szi: '0', entryPx: '100' } },   // flat — not a position
    ] };
  const ps = parsePositions(payload);
  eq('flat rows are not positions', ps.length, 2);
  eq('the venue signs size; negative is short', [ps[0].side, ps[1].side], ['long', 'short']);
  eq('and quantity is the magnitude', [ps[0].qty, ps[1].qty], [0.5, 3]);
  eq('the exchange liquidation price is carried verbatim', [ps[0].liquidationPx, ps[1].liquidationPx], [71000, 2800]);
  eq('with its margin mode', [ps[0].leverageType, ps[1].leverageType], ['isolated', 'cross']);
  eq('account summary', accountSummary(payload), { accountValue: 12500.5, totalNotional: 80000, marginUsed: 8000, withdrawable: 4500.5 });
  eq('a malformed payload yields nothing rather than throwing', [parsePositions(null), accountSummary(null)], [[], null]);
  // A position the venue gives no liquidation price for reports NULL — never the estimate in its
  // place, because a computed figure in a field labelled "liquidation" would be read as the venue's.
  eq('no exchange figure means null, not an estimate',
     parsePositions({ assetPositions: [{ position: { coin: 'X', szi: '1', entryPx: '10' } }] })[0].liquidationPx, null);
}

// ── SPOT: WHAT THE WALLET HOLDS, NOT WHAT IT IS POSITIONED IN ────────────────
// A perp is a position — leverage, funding, a liquidation price. Spot is a balance, some of it
// locked in resting orders. Reading them in one list invites the comparison this codebase keeps
// splitting apart, so they are separate reads producing separate sections.
{
  const bal = parseSpotBalances({ balances: [
    { coin: 'USDC', token: 0, total: '1250.5', hold: '0.0', entryNtl: '0.0' },
    { coin: 'HYPE', token: 150, total: '40.0', hold: '12.5', entryNtl: '2800.0' },
    { coin: 'JUNK', token: 999, total: '1000', hold: '0.0', entryNtl: '0.0' },
    { coin: '', total: '5' },                       // no coin — not a balance
    { coin: 'BAD', total: 'not-a-number' },         // no amount — not a balance
  ]});
  eq('malformed balances are dropped, not defaulted', bal.map(b => b.coin), ['USDC', 'HYPE', 'JUNK']);
  // `free` is not in the payload and is the number you want before deciding you HAVE any of
  // something: 40 HYPE with 12.5 resting in orders is 27.5 you can actually move.
  eq('free is total less what is on hold', bal.find(b => b.coin === 'HYPE').free, 27.5);
  eq('and equals total when nothing is resting', bal.find(b => b.coin === 'USDC').free, 1250.5);
}

// ── THE INDEX TRAP, WHICH IS THE WHOLE REASON THIS IS TESTED ─────────────────
// `spotMetaAndAssetCtxs` answers [meta, ctxs] and they are NOT positionally aligned. Measured live
// on 2026-09-07: universe had 326 entries, ctxs had 720, and a universe entry's own `index` is not
// its array position either — universe[105] carried index 107 and was named "@107".
//
// Joining by position priced HYPE at 0.0827 against a true 87.7975. Three orders of magnitude, on
// a number that looks entirely reasonable. This fixture reproduces exactly that shape.
{
  const meta = {
    tokens: [
      { name: 'USDC', index: 0 },
      { name: 'HYPE', index: 150 },
      { name: 'ORPHAN', index: 300 },      // holds no USDC pair at all
    ],
    universe: [
      { tokens: [1, 0],   name: 'PURR/USDC', index: 0 },
      { tokens: [150, 0], name: '@107',      index: 107 },   // array position 1, index 107
    ],
  };
  // ctxs are in a DIFFERENT order and longer than universe — the live shape.
  const ctxs = [
    { coin: 'PURR/USDC', midPx: '0.120575', prevDayPx: '0.12132', dayNtlVlm: '1770384.81' },
    { coin: '@1',        midPx: '0.082745', prevDayPx: '0.08303', dayNtlVlm: '10.81' },   // the decoy
    { coin: '@107',      midPx: '87.7975',  prevDayPx: '85.0',    dayNtlVlm: '81295463' },
  ];
  const px = spotPrices([meta, ctxs]);

  eq('HYPE is priced by NAME, not by array position', px.get('HYPE').price, 87.7975);
  ok('and is nowhere near what the positional join gave', Math.abs(px.get('HYPE').price - 0.082745) > 80);
  eq('through the pair it actually names', px.get('HYPE').pair, '@107');
  eq('the day move comes with it', px.get('HYPE').changePercent, 3.29);
  // The quote asset prices itself. There is no USDC/USDC pair and there should not be one.
  eq('the quote asset is worth one of itself', px.get(HL_SPOT_QUOTE).price, 1);
  eq('and names no pair', px.get(HL_SPOT_QUOTE).pair, null);
  // 191 of the venue's 500 tokens have no USDC pair. Calling those worthless is a claim the data
  // does not support, so they are unpriced rather than zero.
  eq('a token with no USDC pair is unpriced, not zero', px.get('ORPHAN').price, null);
}

// ── A MID PRICE ON A DEAD PAIR IS NOT A PRICE ────────────────────────────────
// Run against a burn address, this reported the wallet as worth SIX POINT TWO TRILLION DOLLARS: an
// airdropped token quoted at 62,227 on a pair that had traded $40.90 in a day. The quote is not
// malformed — it is a real mid on a real pair nobody trades. Volume is what separates them.
{
  const prices = new Map([
    ['USDC', { price: 1, volume: Infinity }],
    ['HYPE', { price: 87.80, volume: 81_295_463 }],
    ['RUB',  { price: 62_227, volume: 40.90 }],          // the trillion-dollar airdrop
    ['CRUMB', { price: 0.0001, volume: 5_000_000 }],     // real market, tiny holding
    ['NOPAIR', { price: null, volume: null }],
  ]);
  const bal = [
    { coin: 'USDC', total: 1250.5, hold: 0, free: 1250.5, entryNtl: 0 },
    { coin: 'HYPE', total: 40, hold: 12.5, free: 27.5, entryNtl: 2800 },
    { coin: 'RUB', total: 99_999_999, hold: 0, free: 99_999_999, entryNtl: 0.01 },
    { coin: 'CRUMB', total: 1000, hold: 0, free: 1000, entryNtl: 0 },
    { coin: 'NOPAIR', total: 5, hold: 0, free: 5, entryNtl: 0 },
  ];
  const h = spotHoldings(bal, prices);

  // THE ASSERTION THAT MATTERS. USDC 1250.50 + HYPE 3512.00 + CRUMB 0.10 = 4762.60.
  eq('the headline total excludes the fictional one', h.total, 4762.60);
  ok('and is not the six-trillion answer', h.total < 1e6);
  eq('the thin holding is reported separately, with its nominal value', h.thin.count, 1);
  ok('which is the absurd number, kept out of the total', h.thin.value > 6e12);
  // LISTED, not dropped. A holding you cannot value is still a holding.
  ok('but it is still listed', h.rows.some(r => r.coin === 'RUB'));
  ok('and marked so the value is not read as one', h.rows.find(r => r.coin === 'RUB').thin === true);

  // Order: what you own, then what cannot be valued. Sorting on value alone put the junk on top.
  eq('real holdings lead', h.rows.map(r => r.coin).slice(0, 2), ['HYPE', 'USDC']);
  eq('thin and unpriced sink', h.rows.map(r => r.coin).slice(-2), ['RUB', 'NOPAIR']);

  // Dust is judged only among values that can be trusted — CRUMB is real and small.
  eq('a small real holding is dust', h.dust.coins, ['CRUMB']);
  ok('and dust still counts toward the total', h.total > 4762);
  eq('an unpriced row is counted as such', h.unpriced, 1);

  // P&L only against a real cost. entryNtl of zero means it was never bought — an airdrop, or the
  // quote asset — and a return against a cost of nothing is not a return, it is the value.
  const hype = h.rows.find(r => r.coin === 'HYPE');
  eq('P&L against what was actually paid', [hype.cost, hype.pnl, hype.pnlPct], [2800, 712, 25.43]);
  eq('and none at all where nothing was paid', h.rows.find(r => r.coin === 'USDC').pnl, null);
  eq('locked says some of it is resting in orders', [hype.locked, hype.free], [true, 27.5]);

  // The thresholds are named constants, not numbers buried in a comparison.
  ok('thresholds are declared', SPOT_DUST_USD === 1 && SPOT_THIN_VOLUME_USD === 10_000);
  // An empty wallet is zero and no error, which is different from an unconfigured one.
  eq('an empty wallet totals nothing', spotHoldings([], prices).total, 0);
}

// ── THE BOUNDARY IS UNCHANGED ────────────────────────────────────────────────
// Reading spot must not widen what this deployment can do: address from the environment only, one
// URL, and nothing signed.
{
  const src = readFileSync(new URL('../lib/hyperliquid.js', import.meta.url), 'utf8');
  eq('still exactly one endpoint', [...src.matchAll(/https:\/\/api\.hyperliquid\.xyz\/[a-z]+/g)].map(m => m[0]),
     ['https://api.hyperliquid.xyz/info']);
  ok('and never the trading one', !/\/exchange/.test(src));
  ok('nothing signs anything', !/privateKey|signTypedData|wallet\.sign|secretKey/i.test(src));
  ok('the spot read takes its address from the environment too',
     /fetchHlSpot\(\{ address = process\.env\[HL_ADDRESS_ENV\]/.test(src));
  // Hermetic: the build runs this file with the deployment's variables set. See
  // scripts/check-env-independent.mjs, and the outage that produced it.
  {
    const saved = process.env[HL_ADDRESS_ENV];
    delete process.env[HL_ADDRESS_ENV];
    eq('an unset address is reported rather than guessed', (await fetchHlSpot({})).configured, false);
    process.env[HL_ADDRESS_ENV] = 'not-an-address';
    const bad = await fetchHlSpot({});
    eq('and a malformed one is refused before any request', [bad.configured, bad.ok], [true, false]);
    ok('naming the variable to fix', /not a 0x address/.test(bad.error));
    if (saved === undefined) delete process.env[HL_ADDRESS_ENV]; else process.env[HL_ADDRESS_ENV] = saved;
  }
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
