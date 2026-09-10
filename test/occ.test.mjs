// test/occ.test.mjs — settled open interest, and the two ways of getting it wrong.
//
// A gamma map is open interest × gamma. We compute the gamma; the open interest has to come from
// somewhere, and every source available was wrong in the hour the map is read. Yahoo serves none at
// all before the US open. CBOE serves a settlement behind: measured 2026-09-10 at 01:30 UTC against
// OCC on the same 10,170 QQQ series, 3,477 disagreed, OCC net +621,592 contracts, spread across
// EVERY expiry rather than the one that had just expired — and the following day's expiry stood at
// CBOE 111,953 against OCC 227,301, which is what the prior session had built.
//
// An earlier check found the two in exact agreement and recorded that as a property of the sources.
// It was a property of the HOUR it ran in.
import { readFileSync } from 'node:fs';
import { parseOccSeries, mergeOccIv, occKey, defaultExpiries, MIN_OCC_COVERAGE, DEFAULT_NEAR_COUNT } from '../lib/occ.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const FIX = readFileSync(new URL('./fixtures-occ-qqq.txt', import.meta.url), 'utf8');

// ── the parse ────────────────────────────────────────────────────────────────
{
  const q = parseOccSeries(FIX, 'QQQ');
  ok('the file parses', !!q && q.rows > 0);
  // Header lines, the prose banner and the venue list all sit above the data and must not become
  // contracts. A parse that yields a contract from "Series Search Results for QQQ" is a parse that
  // will yield one from anything.
  ok('no header line becomes a contract', [...q.oi.keys()].every(k => /^\d{4}-\d{2}-\d{2}\|(call|put)\|[\d.]+$/.test(k)));
  ok('open interest is counted', q.totalOi > 0);
  ok('and expiries collected', q.expiries.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(q.expiries[0]));

  // ── THE ROOT IS MATCHED EXACTLY ────────────────────────────────────────────
  // The SPY file also carries `2SPY`: adjusted series from a corporate action, a different
  // deliverable on a different number of shares. Folding those into SPY's open interest would
  // inflate it with positions that are not on the underlying at all — and the fixture's 2SPY rows
  // carry real size, including 906 contracts at a strike of 479.42 that SPY itself does not list.
  const spy = parseOccSeries(FIX, 'SPY');
  ok('the adjusted root is seen and skipped', spy.skippedRoot > 0);
  eq('and none of its strikes reach the book', spy.oi.get(occKey('2026-09-09', 'put', 479.42)), undefined);
  ok('while SPY’s own rows do', spy.oi.has(occKey('2026-09-09', 'put', 500)));
  // A substring match would have swallowed 2SPY; an exact one cannot.
  ok('QQQ does not pick up SPY either', [...parseOccSeries(FIX, 'QQQ').oi.keys()].length !== spy.oi.size);

  // ── THE STRIKE IS INTEGER PLUS THOUSANDTHS ─────────────────────────────────
  // 479 + 420 is 479.42, not 479420 and not 479.
  const adj = parseOccSeries(FIX, '2SPY');
  ok('a fractional strike is reassembled', adj.oi.has(occKey('2026-09-09', 'put', 479.42)));
  eq('with its open interest intact', adj.oi.get(occKey('2026-09-09', 'put', 479.42)), 906);

  // ── ZERO IS NOT A POSITION ─────────────────────────────────────────────────
  // A strike with no open interest carries no gamma exposure by construction. Dropping it keeps the
  // contract counts comparable with every other rung.
  ok('an empty leg is not stored', !adj.oi.has(occKey('2026-09-09', 'call', 550)) || adj.oi.get(occKey('2026-09-09', 'call', 550)) > 0);
  ok('every stored leg is positive', [...q.oi.values()].every(v => v > 0));

  eq('an unknown root yields nothing', parseOccSeries(FIX, 'NOSUCH'), null);
  eq('and so does an empty payload', parseOccSeries('', 'QQQ'), null);
  eq('a missing root is a refusal, not a wildcard', parseOccSeries(FIX, ''), null);
}

// ── the merge ────────────────────────────────────────────────────────────────
// OCC's open interest onto CBOE's implied vol. Neither source is sufficient: OCC publishes no
// greeks at all, and CBOE's open interest is the older settlement.
{
  const occ = { oi: new Map([
    [occKey('2026-10-16', 'call', 700), 1000],
    [occKey('2026-10-16', 'put', 700), 2000],
    [occKey('2026-10-16', 'call', 710), 500],
  ]) };
  const cboe = [
    { expiry: '2026-10-16', type: 'call', strike: 700, oi: 900, iv: 0.20 },
    { expiry: '2026-10-16', type: 'put',  strike: 700, oi: 1800, iv: 0.22 },
    { expiry: '2026-10-16', type: 'call', strike: 710, oi: 400, iv: null },   // no vol → no gamma
    { expiry: '2026-10-16', type: 'put',  strike: 720, oi: 300, iv: 0.19 },   // OCC does not list it
  ];
  const m = mergeOccIv(occ, cboe);

  eq('only contracts present in both survive', m.matched, 2);
  // THE OPEN INTEREST IS OCC'S. That is the entire point of the rung.
  eq('and they carry OCC’s open interest, not CBOE’s', m.contracts.map(c => c.oi), [1000, 2000]);
  eq('while the implied vol stays CBOE’s', m.contracts.map(c => c.iv), [0.20, 0.22]);
  eq('a contract OCC does not list is dropped and counted', m.missingFromOcc, 1);
  // NO VOL MEANS NO GAMMA. CBOE's own gamma is deliberately not substituted: it was computed at
  // CBOE's spot, and recomputing at ours is the whole reason this rung exists.
  eq('one with no implied vol likewise', m.noIv, 1);
  ok('and no contract arrives without a vol', m.contracts.every(c => c.iv > 0));

  // ── TWO TOTALS, NOT ONE RATIO ──────────────────────────────────────────────
  // The first version divided OCC's open interest on the MATCHED contracts by CBOE's across ALL of
  // them and called it coverage. It came out at 109% — a coverage figure above one is a sign the
  // ratio is measuring two things at once, and it was: how much of the book survived the join, and
  // how much bigger the newer settlement is.
  eq('coverage is the share of CBOE’s book that joined', m.coverage, +(2700 / 3400).toFixed(4));
  ok('and cannot exceed one', m.coverage <= 1);
  // Like for like, on the contracts that joined: 3,000 against 2,700.
  eq('the settlement difference is measured on the matched set', m.oiDeltaVsCboe, 300);

  eq('nothing settled means no merge', mergeOccIv({ oi: new Map() }, cboe), null);
  eq('and no CBOE contracts means nothing joins', mergeOccIv(occ, []).matched, 0);
  ok('the coverage floor is stated', MIN_OCC_COVERAGE > 0 && MIN_OCC_COVERAGE <= 1);
}

// ── which expiries ───────────────────────────────────────────────────────────
// The full listed book is ~3,240 contracts against the ~1,020 the daily capture stores, and
// gexSummary solves the flip six times over a 400-step spot scan — so its cost is linear in
// contracts and the full book took it from 2.2s to 6.8s, most of a ten-second function budget for
// one symbol of two. It also would not be comparing like with like: a map drawn over a different
// universe cannot be checked against the rung below it in the cascade.
{
  const NOW = new Date('2026-09-10T09:00:00Z');
  const listed = ['2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15',
                  '2026-09-18', '2026-10-16', '2026-12-18', '2027-01-15'];
  const picked = defaultExpiries(listed, NOW);

  ok('an expiry already past is not picked', !picked.includes('2026-09-09'));
  ok('the nearest dailies are', picked.includes('2026-09-10') && picked.includes('2026-09-11'));
  eq('and the count of near ones is stated', DEFAULT_NEAR_COUNT, 3);
  // The front monthly and the two after it, found by horizon rather than by knowing which dates are
  // monthlies — the calendar changes and a hardcoded rule about third Fridays would rot.
  ok('the front monthly is reached by horizon', picked.includes('2026-09-18'));
  ok('and the two beyond it', picked.includes('2026-10-16') && picked.includes('2026-12-18'));
  // SIX, the shape the stored capture uses — three dailies plus three horizons.
  eq('which reproduces the stored capture’s shape', picked.length, 6);
  ok('sorted, so the set is stable across runs', picked.join() === [...picked].sort().join());
  eq('nothing listed picks nothing', defaultExpiries([], NOW), []);
  eq('and everything expired likewise', defaultExpiries(['2026-01-01'], NOW), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
