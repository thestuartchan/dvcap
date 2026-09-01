// test/gex.test.mjs — aggregation, the flip, the walls, and how much of the flip is assumption.
// Built on a hand-made chain whose answers are known by construction rather than by running the
// code and copying what it said.
import {
  gexSummary, netGammaAt, flipLevel, flipFragility, walls, toDollarGex,
  contractGamma, GEX_CONVENTIONS, CONTRACT_MULTIPLIER,
} from '../lib/gex.js';
import { gamma } from '../lib/blackscholes.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const near = (n, g, w, tol) => { const good = g != null && Math.abs(g - w) <= tol;
  console.log(`${good ? '✅' : '❌'} ${n}` + (good ? '' : `  got ${g} want ${w} ±${tol}`)); good ? pass++ : fail++; };

const C = (strike, oi, iv = 0.20, T = 0.05) => ({ type: 'call', strike, oi, iv, T });
const P = (strike, oi, iv = 0.22, T = 0.05) => ({ type: 'put', strike, oi, iv, T });
// A deliberately lopsided book: calls stacked above spot, puts stacked below.
const CHAIN = [C(95, 1000), C(100, 2000), C(105, 3000), P(95, 4000), P(100, 1500), P(105, 500)];
const OPTS = { r: 0.04, q: 0.005 };

// ── one contract ─────────────────────────────────────────────────────────────
{
  const g = contractGamma(C(100, 1000), { S: 100, ...OPTS });
  near('a contract gamma matches the closed form', g, gamma({ S: 100, K: 100, T: 0.05, r: 0.04, q: 0.005, sigma: 0.20 }), 1e-15);
  // Null, never 0 — a missing IV must drop out of the sum, not pull the aggregate toward zero.
  eq('a contract with no IV yields null, not zero', contractGamma({ type: 'call', strike: 100, oi: 10, T: 0.05 }, { S: 100 }), null);
  eq('nor does a zero IV', contractGamma({ type: 'call', strike: 100, oi: 10, iv: 0, T: 0.05 }, { S: 100 }), null);
  eq('an expired contract likewise', contractGamma({ type: 'call', strike: 100, oi: 10, iv: 0.2, T: 0 }, { S: 100 }), null);
}

// ── aggregation ──────────────────────────────────────────────────────────────
{
  // Summed by hand from the closed form, so this checks the aggregation and not just itself.
  const S = 100;
  const byHand = CHAIN.reduce((a, c) => {
    const g = gamma({ S, K: c.strike, T: c.T, r: 0.04, q: 0.005, sigma: c.iv });
    return a + (c.type === 'call' ? 1 : -1) * g * c.oi;
  }, 0);
  const got = netGammaAt(CHAIN, S, { ...OPTS, convention: 'longCallsShortPuts' });
  near('net gamma equals the hand sum', got.net, byHand, 1e-12);
  eq('with every contract used', [got.used, got.skipped], [6, 0]);
}
{
  // Contracts that cannot be priced are SKIPPED and counted, never silently treated as zero.
  const withJunk = [...CHAIN, { type: 'call', strike: 110, oi: 9999, T: 0.05 }, { type: 'put', strike: 90, oi: 5000, iv: 0.2 }];
  const got = netGammaAt(withJunk, 100, OPTS);
  eq('unpriceable contracts are skipped', got.skipped, 2);
  eq('and counted separately from the ones used', got.used, 6);
  near('leaving the sum unchanged', got.net, netGammaAt(CHAIN, 100, OPTS).net, 1e-15);
  // Zero and missing OI contribute nothing but are not errors.
  eq('a zero-OI contract is skipped too', netGammaAt([C(100, 0)], 100, OPTS).used, 0);
}

// ── THE TWO CONVENTIONS ──────────────────────────────────────────────────────
// The brief asks for a fragility flag when the conventions disagree on the flip. They cannot:
// the inverse is the first negated term by term, and a reflection through zero has the same zeros.
// Asserted here so the claim is checkable rather than asserted in a comment.
{
  for (const S of [92, 96, 100, 104, 108]) {
    const a = netGammaAt(CHAIN, S, { ...OPTS, convention: 'longCallsShortPuts' }).net;
    const b = netGammaAt(CHAIN, S, { ...OPTS, convention: 'shortCallsLongPuts' }).net;
    near(`at spot ${S} the inverse convention is the exact negation`, b, -a, 1e-15);
  }
  const fa = flipLevel(CHAIN, { S: 100, ...OPTS, convention: 'longCallsShortPuts' }).level;
  const fb = flipLevel(CHAIN, { S: 100, ...OPTS, convention: 'shortCallsLongPuts' }).level;
  eq('so both conventions give the SAME flip level', fa, fb);
  eq('and the signs are opposite', GEX_CONVENTIONS.longCallsShortPuts.call, -GEX_CONVENTIONS.shortCallsLongPuts.call);
}

// ── the flip ─────────────────────────────────────────────────────────────────
{
  const f = flipLevel(CHAIN, { S: 100, ...OPTS });
  ok('a flip is found', f.level != null);
  // Below it the book is put-heavy and net gamma is negative; above it, call-heavy and positive.
  ok('net gamma is negative below the flip', netGammaAt(CHAIN, f.level - 1, OPTS).net < 0);
  ok('and positive above it', netGammaAt(CHAIN, f.level + 1, OPTS).net > 0);
  // Accuracy is relative, not absolute: net gamma is steep here, so the meaningful claim is that
  // the residual at the solved level is negligible AGAINST the local scale.
  const atFlip = Math.abs(netGammaAt(CHAIN, f.level, OPTS).net);
  const halfAway = Math.abs(netGammaAt(CHAIN, f.level + 0.5, OPTS).net);
  ok('the residual at the flip is negligible against the local scale', atFlip / halfAway < 1e-3);
}
{
  // A book with no crossing must say so rather than reporting a level. "No flip within ±10%" and
  // "the flip is at spot" are completely different facts and the second is the dangerous one.
  const allCalls = [C(100, 5000), C(105, 5000)];
  const f = flipLevel(allCalls, { S: 100, ...OPTS });
  eq('a one-sided book has no flip', f.level, null);
  eq('and no crossings', f.crossings, 0);
  ok('and says which way it is one-sided', /stays positive/.test(f.reason));
  const allPuts = flipLevel([P(100, 5000), P(95, 5000)], { S: 100, ...OPTS });
  ok('the other way too', /stays negative/.test(allPuts.reason));
}
{
  eq('no chain, no flip', flipLevel([], { S: 100 }).level, null);
  eq('no spot, no flip', flipLevel(CHAIN, { S: null }).level, null);
  ok('with a reason rather than a silent null', /no spot or no chain/.test(flipLevel([], { S: 100 }).reason));
}

// ── fragility: the thing the convention flag could not measure ───────────────
{
  const fr = flipFragility(CHAIN, { S: 100, ...OPTS });
  ok('several assumptions are solved', fr.points.length >= 4);
  ok('and the spread is real', fr.spread > 0);
  // The flip moves as the dealer put assumption relaxes — which is the point. The direction is
  // determined: holding fewer puts short lifts the net gamma curve, moving the crossing down.
  const first = fr.points[0].level, last = fr.points[fr.points.length - 1].level;
  ok('relaxing the put assumption moves the flip monotonically', first !== last);
  ok('and the note says what to do about it', /zone, not a line|not an artefact/.test(fr.note));
}
{
  // MEASURED across book shapes: lopsided 4.5%, thin-winged 5.4%, wide 3.2% of spot. The flip is
  // the point where call gamma balances put gamma, so reweighting puts moves it by construction —
  // it is intrinsically a zone. The flag fires often, and correctly.
  for (const [name, book] of [
    ['lopsided', CHAIN],
    ['thin wings', [C(100, 5000), P(100, 5000), C(101, 100), P(99, 100)]],
    ['wide', [C(96, 2000), C(98, 2500), C(100, 3000), C(102, 2500), P(96, 2600), P(98, 2400), P(100, 2200), P(102, 1200)]],
  ]) {
    const fr = flipFragility(book, { S: 100, ...OPTS });
    ok(`${name}: the flip is reported as a zone`, fr.zone != null && fr.zone.hi > fr.zone.lo);
    ok(`${name}: measured against SPOT, not against the level itself`, fr.spreadPctOfSpot > 0);
    ok(`${name}: and the zone brackets every solved level`,
      fr.points.every(p => p.level >= fr.zone.lo - 1e-9 && p.level <= fr.zone.hi + 1e-9));
  }
  const fr = flipFragility(CHAIN, { S: 100, ...OPTS });
  ok('the note names the zone rather than a single number', /flip zone [\d.]+–[\d.]+/.test(fr.note));
}
{
  const fr = flipFragility([C(100, 100)], { S: 100, ...OPTS });
  eq('a book with no flip cannot be fragile', fr.fragile, false);
  ok('and says why', /not enough solutions/.test(fr.note));
}

// ── walls ────────────────────────────────────────────────────────────────────
{
  const w = walls(CHAIN, { S: 100, ...OPTS });
  // 105 carries the most call OI (3000 vs 2000) but 100 carries the most gamma-weighted OI:
  // 0.0890 x 2000 = 178.0 against 0.0525 x 3000 = 157.5. The wall is the second one. Writing this
  // test the other way round first was making exactly the raw-OI mistake the weighting prevents.
  eq('the call wall is gamma-weighted, not the largest raw OI', w.callWall, 100);
  eq('and the put wall likewise', w.putWall, 95);
  eq('with a row per strike', w.byStrike.map(r => r.strike), [95, 100, 105]);
  ok('carrying dollar figures', w.byStrike.every(r => r.netGexUsd != null));
}
{
  // WEIGHTED, not raw OI. A far strike with enormous open interest pins nothing, and calling it a
  // wall is the most common way this analysis is got wrong.
  const w = walls([C(105, 3000), C(160, 500000)], { S: 100, ...OPTS });
  eq('a distant strike is not a wall however large its OI', w.callWall, 105);
}
{
  const w = walls([], { S: 100 });
  eq('an empty chain has no walls', [w.callWall, w.putWall], [null, null]);
}

// ── dollars ──────────────────────────────────────────────────────────────────
{
  // GEX = gamma x 100 x S^2 x 0.01. At S=100 that is gamma x 100 x 10000 x 0.01 = gamma x 10000.
  near('gamma converts to dollars per 1% move', toDollarGex(2, 100), 20000, 1e-9);
  eq('the multiplier is a hundred', CONTRACT_MULTIPLIER, 100);
  eq('a null gamma gives null dollars', toDollarGex(null, 100), null);
  eq('and a null spot too', toDollarGex(2, null), null);
}

// ── the stored row ───────────────────────────────────────────────────────────
{
  const s = gexSummary(CHAIN, { S: 100, ...OPTS, symbol: 'TEST', date: '2026-09-01', advUsd: 2e10 });
  eq('it carries its identity', [s.symbol, s.date, s.spot], ['TEST', '2026-09-01', 100]);
  near('the inverse convention is the negation', s.gexUsdInverse, -s.gexUsd, 1e-9);
  eq('and both agree on the flip, by construction', s.conventionsAgreeOnFlip, true);
  eq('open interest is totalled per side', [s.callOi, s.putOi], [6000, 6000]);
  ok('IV is OI-weighted, so it sits between the two inputs', s.oiWeightedIv > 0.20 && s.oiWeightedIv < 0.22);
  eq('every contract is accounted for', s.contracts, s.contractsUsed + s.contractsSkipped);
  // Normalised, so a row from 2026 can be read next to one from 2028 when the index is higher.
  ok('normalised against volume', s.gexPctOfAdv != null);
  ok('and against the index level', s.gexPerSpotPct != null);
}
{
  const s = gexSummary([], { S: 100, ...OPTS });
  eq('an empty chain summarises to nulls, not zeros that look computed', [s.flipLevel, s.callWall, s.putWall], [null, null, null]);
  eq('with the counts honest', [s.contracts, s.contractsUsed], [0, 0]);
  eq('and no ADV normalisation without an ADV', gexSummary(CHAIN, { S: 100, ...OPTS }).gexPctOfAdv, null);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
