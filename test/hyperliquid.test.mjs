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

// ── the boundary this option was chosen for ──────────────────────────────────
// Public market data only. Nothing here reads an account, and nothing asserts a position exists.
{
  const src = readFileSync(new URL('../lib/hyperliquid.js', import.meta.url), 'utf8');
  for (const forbidden of ['clearinghouseState', 'privateKey', 'apiKey', 'secret', 'signature', 'wallet'])
    ok(`no ${forbidden} anywhere in the module`, !new RegExp(forbidden, 'i').test(src));
  ok('the only request it makes is metaAndAssetCtxs', /metaAndAssetCtxs/.test(src));
  eq('and it asks for exactly one thing', (src.match(/type:\s*'/g) || []).length, 1);
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

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
