// test/optionsChain.test.mjs — parsing and trimming, against contracts taken from a real QQQ
// chain (test/fixtures-qqq-chain.json, captured 2026-09-01) rather than from imagination.
//
// The case that matters most is the implied-vol sentinel. Yahoo does not return null when it
// cannot solve an IV; it returns 1e-5, which is positive and passes any presence check. Gamma
// goes as 1/sigma, so those contracts price four orders of magnitude too large. Sixteen percent
// of the live chain carried it.
import { readFileSync } from 'node:fs';
import { parseContracts, pickExpiries, STRIKE_BAND_PCT, MIN_IV, MAX_IV } from '../lib/optionsChain.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const FX = JSON.parse(readFileSync(new URL('./fixtures-qqq-chain.json', import.meta.url)));
const OPTS = { spot: FX.spot, expiry: FX.expiry };

// ── the sentinel ─────────────────────────────────────────────────────────────
{
  const calls = parseContracts(FX.calls, 'call', OPTS);
  const lo0 = FX.spot * (1 - STRIKE_BAND_PCT / 100), hi0 = FX.spot * (1 + STRIKE_BAND_PCT / 100);
  const allSentinels = FX.calls.filter(c => (c.impliedVolatility ?? 0) > 0 && c.impliedVolatility < MIN_IV);
  const inBandSentinels = allSentinels.filter(c => c.strike >= lo0 && c.strike <= hi0);
  ok('the fixture actually contains sentinels, or this test proves nothing', allSentinels.length > 0);
  // ORDER MATTERS: the strike trim runs FIRST, so a sentinel outside the band is never counted as
  // an IV rejection — it was already gone. The fixture has one of each, which is why this is
  // asserted against the in-band count and not the total.
  ok('the fixture has a sentinel outside the band too', allSentinels.length > inBandSentinels.length);
  eq('every IN-BAND sentinel is rejected', calls.ivRejected, inBandSentinels.length);
  ok('and the out-of-band one was trimmed by strike before the IV check',
    !calls.some(c => c.strike < lo0 || c.strike > hi0));
  ok('and none survives as a usable vol', calls.every(c => c.iv == null || c.iv >= MIN_IV));
  // Kept as a ROW with a null iv, not dropped: the open interest is real and belongs in the OI
  // totals even though the contract cannot be priced.
  ok('but the contract itself is kept, with its open interest', calls.some(c => c.iv == null && c.oi > 0));
}
{
  const band = [
    { strike: 710, openInterest: 100, impliedVolatility: 1.0000000000000003e-05 },  // the real sentinel
    { strike: 710, openInterest: 100, impliedVolatility: 0.0099 },                  // just below the floor
    { strike: 710, openInterest: 100, impliedVolatility: MIN_IV },                  // exactly the floor
    { strike: 710, openInterest: 100, impliedVolatility: 2.125 },                   // the real chain's max
    { strike: 710, openInterest: 100, impliedVolatility: MAX_IV + 0.1 },            // absurd
    { strike: 710, openInterest: 100, impliedVolatility: null },
  ];
  const got = parseContracts(band, 'call', OPTS).map(c => c.iv);
  eq('only plausible vols survive the band', got, [null, null, MIN_IV, 2.125, null, null]);
  eq('and the rejects are counted', parseContracts(band, 'call', OPTS).ivRejected, 4);
}

// ── trimming ─────────────────────────────────────────────────────────────────
{
  const calls = parseContracts(FX.calls, 'call', OPTS);
  const lo = FX.spot * (1 - STRIKE_BAND_PCT / 100), hi = FX.spot * (1 + STRIKE_BAND_PCT / 100);
  ok('every kept strike is inside the band', calls.every(c => c.strike >= lo && c.strike <= hi));
  ok('and the far strike in the fixture was dropped', calls.length < FX.calls.length);
  ok('nothing with zero open interest survives', calls.every(c => c.oi > 0));
  eq('each row is tagged with its side and expiry', [calls[0].type, calls[0].expiry], ['call', FX.expiry]);
}
{
  const puts = parseContracts(FX.puts, 'put', OPTS);
  ok('puts parse the same way', puts.length > 0 && puts.every(c => c.type === 'put'));
  // Every field the module reads is carried through from the real payload shape.
  ok('carrying the six fields the module needs',
    puts.every(c => ['strike', 'oi', 'volume', 'iv', 'last', 'bid', 'ask'].every(k => k in c)));
}
{
  eq('an empty chain parses to nothing', parseContracts([], 'call', OPTS).length, 0);
  eq('a non-array does not throw', parseContracts(null, 'call', OPTS).length, 0);
  // With no spot there is no band, so nothing is trimmed by strike — the alternative is dropping
  // the whole chain because the quote was momentarily missing.
  ok('no spot means no strike trim, not an empty result', parseContracts(FX.calls, 'call', { expiry: FX.expiry }).length >= 1);
}

// ── expiry selection ─────────────────────────────────────────────────────────
{
  const now = new Date('2026-09-01T13:00:00Z');
  const dates = [];
  for (let d = new Date('2026-09-04T21:00:00Z'); d < new Date('2027-07-01'); d.setUTCDate(d.getUTCDate() + 7)) {
    dates.push(Math.floor(d.getTime() / 1000));
  }
  const picked = pickExpiries(dates, { now });
  eq('six distinct expiries', picked.length, 6);
  eq('in ascending order', picked.map(p => p.date), [...picked.map(p => p.date)].sort());
  eq('the roles are all filled', picked.map(p => p.role),
    ['front', 'weekly+1', 'weekly+2', 'front monthly', 'next monthly', 'next quarterly']);
  // A date can BE a monthly while filling a weekly slot. Sep 18 2026 is the third Friday of a
  // quarter-end month; the first version of this let the quarterly role collapse onto it and
  // silently returned four expiries instead of six.
  const sep18 = picked.find(p => p.date === '2026-09-18');
  eq('what a date IS is kept apart from which slot it FILLS', [sep18.role, sep18.tags],
    ['weekly+2', ['weekly', 'monthly', 'quarterly']]);
  eq('so the quarterly slot moves on to a later date', picked.find(p => p.role === 'next quarterly').date, '2026-12-18');
  ok('and every monthly picked really is a third Friday', picked.filter(p => p.role.includes('monthly')).every(p => p.tags.includes('monthly')));
}
{
  const now = new Date('2026-09-01T13:00:00Z');
  const past = [Math.floor(new Date('2026-08-01').getTime() / 1000)];
  eq('expired dates are dropped', pickExpiries(past, { now }).length, 0);
  eq('an empty list picks nothing', pickExpiries([], { now }).length, 0);
  eq('a non-array does not throw', pickExpiries(null, { now }).length, 0);
}

// ── "no chain" and "no open interest" are different failures ─────────────────
// Yahoo serves the contracts pre-market but does not populate openInterest until the session is
// under way. Measured 2026-09-02 at 09:30 UTC, four hours before the US open: the 0DTE expiry
// returned 209 contracts carrying 922,440 of volume and ZERO open interest. Reporting that as
// "no chain" sends anyone debugging it to look at the fetch, which is working perfectly.
{
  const preMarket = FX.calls.map(c => ({ ...c, openInterest: 0 }));
  const parsed = parseContracts(preMarket, 'call', OPTS);
  eq('a chain with no open interest parses to nothing', parsed.length, 0);
  // And it is nothing for a REASON that is not "the fetch failed" — the contracts were served.
  ok('the raw chain was not empty, which is the whole point', preMarket.length > 0);
}
{
  // Zero and missing are both "no position", and neither is an error.
  const mixed = [
    { strike: FX.spot, openInterest: 0, impliedVolatility: 0.2 },
    { strike: FX.spot, openInterest: null, impliedVolatility: 0.2 },
    { strike: FX.spot, openInterest: 500, impliedVolatility: 0.2 },
  ];
  eq('only the contract with real open interest survives', parseContracts(mixed, 'call', OPTS).length, 1);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
