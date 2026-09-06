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
import { isAddress, fetchHlAccount, parsePositions, accountSummary, estimateLiquidation, leverageAt, maintenanceMarginFraction, liquidationVsStop } from '../lib/hyperliquid.js';
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

  // Exactly two request types, both reads.
  const types = [...src.matchAll(/type:\s*'([a-zA-Z]+)'/g)].map(m => m[1]).sort();
  eq('two read requests and no others', types, ['clearinghouseState', 'metaAndAssetCtxs']);

  // THE ADDRESS COMES FROM THE ENVIRONMENT, never from a caller. A route that took it as a
  // parameter would be a way to read anyone's account through this deployment.
  ok('the env var is named once and used', src.includes('HL_ADDRESS_ENV') && src.includes("'HYPERLIQUID_ADDRESS'"));
  ok('and the default argument reads process.env', /address\s*=\s*process\.env\[HL_ADDRESS_ENV\]/.test(src));
  // An address must look like one before it is sent anywhere.
  eq('addresses are validated', [isAddress('0x' + 'a'.repeat(40)), isAddress('0xnope'), isAddress(''), isAddress(null)],
     [true, false, false, false]);
  eq('an unset address is reported, not guessed at',
     (await fetchHlAccount({ address: undefined })).configured, false);
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

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
