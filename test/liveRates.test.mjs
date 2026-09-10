// test/liveRates.test.mjs — the live long end, and what "live" is allowed to mean.
import { liveYield, withLive, fetchLiveYields, liveAgeMin,
         LIVE_YIELD_SYM, LIVE_MAX_AGE_MIN } from '../lib/liveRates.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const NOW = Date.parse('2026-09-10T13:46:00Z');
const tsAt = (iso) => Math.floor(Date.parse(iso) / 1000);

// ── THE NUMBER THAT WAS MISSING ──────────────────────────────────────────────
// FRED's DGS30 read 5.25% for 2026-09-08 while ^TYX quoted 5.339 live. The board scored a 5.35
// threshold against the first.
{
  const row = { sym: '^TYX', price: 5.3389997, ts: tsAt('2026-09-10T13:44:00Z') };
  const l = liveYield(row, { now: NOW });
  eq('the yield is taken at three decimals', l.value, 5.339);
  eq('with its age in minutes', l.ageMin, 2);
  eq('and the minute it was quoted', l.asOf, '2026-09-10 13:44 UTC');
  eq('and the series it came from', l.src, '^TYX');
}

// ── A SETTLE DRESSED AS A LIVE PRINT IS THE BUG ONE LAYER DOWN ───────────────
// Outside the US session these indices carry the last settle with an old timestamp. Fetching it
// successfully is not the same as it being live, and the difference is the whole point.
{
  eq('a stale quote is not live', liveYield({ sym: '^TYX', price: 5.28, ts: tsAt('2026-09-09T20:00:00Z') }, { now: NOW }), null);
  eq('nor is one with no timestamp', liveYield({ sym: '^TYX', price: 5.28 }, { now: NOW }), null);
  eq('nor a missing price', liveYield({ sym: '^TYX', ts: tsAt('2026-09-10T13:44:00Z') }, { now: NOW }), null);
  eq('nor a zero', liveYield({ sym: '^TYX', price: 0, ts: tsAt('2026-09-10T13:44:00Z') }, { now: NOW }), null);
  // The boundary is stated rather than buried.
  ok('the window is a named constant', LIVE_MAX_AGE_MIN > 0);
  const edge = tsAt('2026-09-10T13:46:00Z') - LIVE_MAX_AGE_MIN * 60 - 60;
  eq('just past the window is not live', liveYield({ sym: '^TYX', price: 5.3, ts: edge }, { now: NOW }), null);
  eq('and age is measured, not assumed', Math.round(liveAgeMin(tsAt('2026-09-10T13:16:00Z'), NOW)), 30);
}

// ── NULL IS THE HONEST ANSWER AND IT HAS A DEFINED CONSEQUENCE ───────────────
// The board then runs on the delayed series plus the stale guard: a worse reading, never a wrong
// one. A fetch that throws must reach the same place as one that returns nothing.
{
  const boom = async () => { throw new Error('yahoo down'); };
  eq('a failed fetch yields no live legs', await fetchLiveYields(boom, { now: NOW }), {});
  const partial = async (syms) => syms.map(sym => sym === '^TYX'
    ? { sym, price: 5.339, ts: tsAt('2026-09-10T13:44:00Z') }
    : { sym, price: 4.9, ts: tsAt('2026-09-09T20:00:00Z') });
  const got = await fetchLiveYields(partial, { now: NOW });
  eq('one live leg among stale ones is kept alone', Object.keys(got), ['us30y']);
  eq('and it is the 30-year', got.us30y.value, 5.339);
}

// ── THERE IS NO LIVE 2-YEAR ──────────────────────────────────────────────────
// Yahoo has no CBOE index for it, and 2YY=F served a stale print 10bp off the cash yield when
// this was measured. The 2Y keeps the delayed series and takes the stale guard instead — the
// fallback the brief asks for, not a gap in it.
eq('only the three that have a live index are wired', Object.keys(LIVE_YIELD_SYM), ['us30y', 'us10y', 'us5y']);
ok('and none of them is a 2-year', !Object.values(LIVE_YIELD_SYM).some(s => /2Y/i.test(s)));

// ── MERGING: THE DELAYED SERIES KEEPS EVERYTHING IT IS GOOD AT ───────────────
// The ATR, the prior print and the 1d delta are properties of the FRED series and stay. Only the
// value and its vintage are replaced, and the replacement is labelled.
{
  const fred = { value: 5.25, date: '2026-09-08', prev: 5.24, prevDate: '2026-09-04',
                 deltaBps: 1, atr: 0.0275, name: 'US 30Y', src: 'DGS30' };
  const live = liveYield({ sym: '^TYX', price: 5.339, ts: tsAt('2026-09-10T13:44:00Z') }, { now: NOW });
  const m = withLive(fred, live);
  eq('the live value wins', m.value, 5.339);
  eq('and is labelled as live', m.live, true);
  eq('the date becomes today, which is what the vintage checks read', m.date, '2026-09-10');
  eq('the ATR survives', m.atr, 0.0275);
  eq('so does the day-over-day delta', m.deltaBps, 1);
  eq('and the delayed print is kept, named', m.delayed, { value: 5.25, date: '2026-09-08', src: 'DGS30' });
  ok('with the minute the live quote was taken', /13:44 UTC/.test(m.liveAsOf));

  // NO LIVE QUOTE MEANS EXPLICITLY NOT LIVE — never merely the absence of a flag, because the
  // stale guard keys off it and an undefined would read as "do not age this".
  const off = withLive(fred, null);
  eq('with no live quote the field is marked not-live', off.live, false);
  eq('and keeps the delayed value', off.value, 5.25);
  eq('and its own date', off.date, '2026-09-08');
  eq('a missing field is passed through untouched', withLive(null, live), null);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
