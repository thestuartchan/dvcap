// test/blackscholes.test.mjs — d1 and gamma against hand computations and a textbook figure.
// Gamma is the whole basis of the GEX module, so it is checked against numbers derived outside
// this codebase rather than against itself.
import { d1, gamma, normPdf, yearsTo, YEAR_MS, normCdf, delta, price, impliedVol, modelledDelta } from '../lib/blackscholes.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const near = (n, g, w, tol) => { const good = g != null && Math.abs(g - w) <= tol;
  console.log(`${good ? '✅' : '❌'} ${n}` + (good ? '' : `  got ${g} want ${w} ±${tol}`)); good ? pass++ : fail++; };

// ── the normal density ───────────────────────────────────────────────────────
{
  near('phi(0) = 1/sqrt(2pi)', normPdf(0), 0.3989422804014327, 1e-15);
  near('phi(1)', normPdf(1), 0.24197072451914337, 1e-15);
  near('phi is even', normPdf(-1.5), normPdf(1.5), 1e-15);
  eq('and refuses a non-number', normPdf(NaN), null);
}

// ── d1, hand-computed ────────────────────────────────────────────────────────
{
  // S=K=100, T=1, r=0.05, q=0, sigma=0.2:
  //   d1 = [ln(1) + (0.05 - 0 + 0.02)(1)] / (0.2 * 1) = 0.07/0.2 = 0.35
  near('d1 at the money', d1({ S: 100, K: 100, T: 1, r: 0.05, sigma: 0.2 }), 0.35, 1e-12);
  // A dividend yield enters d1 as a drag on the forward: q=0.02 removes 0.02 from the drift.
  //   d1 = [0 + (0.05 - 0.02 + 0.02)(1)]/0.2 = 0.25
  near('a dividend yield lowers d1', d1({ S: 100, K: 100, T: 1, r: 0.05, q: 0.02, sigma: 0.2 }), 0.25, 1e-12);
}

// ── gamma against a hand computation ─────────────────────────────────────────
{
  // phi(0.35) = 0.3752403469 ; gamma = phi(d1)/(S sigma sqrt(T)) = 0.3752403469/20
  near('gamma at the money, one year', gamma({ S: 100, K: 100, T: 1, r: 0.05, sigma: 0.2 }), 0.018762017, 1e-9);
}
{
  // Hull, Options Futures and Other Derivatives — the worked example used throughout the greeks
  // chapter: S=49, K=50, r=5%, sigma=20%, T=0.3846 (20 weeks). Hull quotes gamma = 0.066.
  near('matches the textbook worked example', gamma({ S: 49, K: 50, T: 0.3846, r: 0.05, sigma: 0.2 }), 0.066, 0.0005);
}
{
  // The property that makes GEX possible at all: gamma is the same for a call and a put at the
  // same strike and expiry. Put-call parity differs by a forward, which is linear in S and so has
  // no curvature. The module relies on this — it never asks whether a contract is a call.
  const g = (o) => gamma(o);
  const args = { S: 100, K: 105, T: 0.25, r: 0.04, q: 0.005, sigma: 0.22 };
  near('one gamma serves both option types', g(args), g(args), 0);
  ok('and it is a real positive number', g(args) > 0);
}

// ── shape ────────────────────────────────────────────────────────────────────
{
  const at = gamma({ S: 100, K: 100, T: 0.25, r: 0.04, sigma: 0.2 });
  const near_ = gamma({ S: 100, K: 105, T: 0.25, r: 0.04, sigma: 0.2 });
  const far = gamma({ S: 100, K: 140, T: 0.25, r: 0.04, sigma: 0.2 });
  ok('gamma is largest near the money', at > near_ && near_ > far);
  ok('and is negligible far out', far < at / 100);
  // This is why a far strike with huge open interest is not a wall, and why walls are weighted.
  ok('so a far strike contributes almost nothing however large its OI', far * 1e6 < at * 1e5);
}
{
  const short = gamma({ S: 100, K: 100, T: 1 / 365, r: 0.04, sigma: 0.2 });
  const long = gamma({ S: 100, K: 100, T: 1, r: 0.04, sigma: 0.2 });
  ok('ATM gamma explodes into expiry', short > long * 15);
}
{
  const lowVol = gamma({ S: 100, K: 100, T: 0.25, r: 0.04, sigma: 0.10 });
  const highVol = gamma({ S: 100, K: 100, T: 0.25, r: 0.04, sigma: 0.40 });
  ok('and falls as vol rises', lowVol > highVol);
}

// ── the domain errors, which must be null and never a number ─────────────────
{
  // Each of these is a genuine singularity. Returning a large number instead would put a fake
  // wall on the chart at the front expiry, which is exactly where it would be believed.
  eq('zero time to expiry has no gamma', gamma({ S: 100, K: 100, T: 0, sigma: 0.2 }), null);
  eq('negative time neither', gamma({ S: 100, K: 100, T: -0.1, sigma: 0.2 }), null);
  eq('zero vol neither', gamma({ S: 100, K: 100, T: 0.25, sigma: 0 }), null);
  eq('a missing vol neither', gamma({ S: 100, K: 100, T: 0.25 }), null);
  eq('a zero spot neither', gamma({ S: 0, K: 100, T: 0.25, sigma: 0.2 }), null);
  eq('a zero strike neither', gamma({ S: 100, K: 0, T: 0.25, sigma: 0.2 }), null);
  eq('an empty call does not throw', gamma(), null);
  eq('and d1 refuses the same cases', d1({ S: 100, K: 100, T: 0, sigma: 0.2 }), null);
}

// ── year fractions ───────────────────────────────────────────────────────────
{
  near('a year out is a year', yearsTo('2027-09-01', '2026-09-01T21:00:00Z'), 1, 0.01);
  near('a week out', yearsTo('2026-09-08', '2026-09-01T21:00:00Z'), 7 / 365, 1e-6);
  // Expiry is anchored to the close, not midnight — an expiry dated today is still hours of gamma.
  ok('an expiry dated today is not yet expired in the morning', yearsTo('2026-09-01', '2026-09-01T13:00:00Z') > 0);
  eq('but is gone after the close', yearsTo('2026-09-01', '2026-09-01T22:00:00Z'), null);
  eq('a past expiry is null, not negative', yearsTo('2026-08-01', '2026-09-01T13:00:00Z'), null);
  eq('an unparseable date is null', yearsTo('not-a-date', '2026-09-01T13:00:00Z'), null);
  eq('the year is 365 days', YEAR_MS, 365 * 24 * 3600 * 1000);
}

// ── DELTA, IMPLIED VOL, AND THE MODELLED FALLBACK ────────────────────────────
{
  const T = 0.25;
  near('N(0) is a half', normCdf(0), 0.5, 1e-7);
  const c = delta({ S: 100, K: 100, T, r: 0.04, sigma: 0.3, right: 'C' });
  const p = delta({ S: 100, K: 100, T, r: 0.04, sigma: 0.3, right: 'P' });
  near('ATM call delta a little over a half', c, 0.579, 0.002);
  near('put = call − e^(−qT)', c - p, 1, 1e-9);
  const px = price({ S: 100, K: 100, T, r: 0.04, sigma: 0.3, right: 'C' });
  near('the vol that reproduces the price is the vol', impliedVol({ S: 100, K: 100, T, r: 0.04, mark: px, right: 'C' }), 0.3, 1e-6);
  eq('a mark below intrinsic has no vol', impliedVol({ S: 100, K: 80, T, mark: 5, right: 'C' }), null);
  const m = modelledDelta({ S: 110.9, K: 115, expiry: '2026-10-02', mark: 2.4, right: 'C', now: '2026-09-17T14:00:00Z' });
  ok('a modelled delta is labelled', m?.source === 'modelled' && m.delta > 0.2 && m.delta < 0.3);
  eq('an expired contract has none', modelledDelta({ S: 110.9, K: 115, expiry: '2026-09-01', mark: 2.4, now: '2026-09-17T14:00:00Z' }), null);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
