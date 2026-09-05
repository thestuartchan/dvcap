// test/price.test.mjs — a price is rounded by its SCALE, not to two decimal places.
//
// Every quote left api/prices.js through `price.toFixed(2)`. For a share that is exactly right —
// cents are the unit one trades in. For anything quoted below a dollar it is destruction, and it
// happened at the SOURCE, so nothing downstream could recover it.
//
// The case that surfaced it: MJY micro yen futures print 0.00641 and were stored as 0.01. The
// console then reported two buy zones at 0.006452 and 0.00629 as 35.48% and 37.1% below the last
// price. They are 0.7% and 1.9% away.
import { roundQuote, fmtPrice, distinctlyShown, QUOTE_SIG } from '../lib/price.js';
import { distancePct, levelHit } from '../lib/positions.js';
import { sizeSuggestion } from '../lib/sizing.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// ── NOTHING AT OR ABOVE A DOLLAR CHANGES ─────────────────────────────────────
// This is the assertion that makes the change safe to ship: every equity, index and ordinary
// future is stored exactly as it was.
for (const v of [149.375, 4649.3, 1.5, 18.06, 500, 1.0])
  eq(`${v} stores as it always did`, roundQuote(v), +v.toFixed(2));

// Just under a dollar is already the new path, and already better: `toFixed(2)` turns 0.995 into
// 0.99 — a tenth of a percent thrown away on a price that had it to give.
eq('0.995 keeps its third digit', roundQuote(0.995), 0.995);
eq('where the old rule dropped it', +(0.995).toFixed(2), 0.99);

// ── BELOW A DOLLAR, SIGNIFICANT FIGURES SURVIVE ──────────────────────────────
eq('the MJY quote survives storage', roundQuote(0.0064105), 0.0064105);
ok('and is nowhere near the 0.01 it used to become', roundQuote(0.0064105) !== 0.01);
eq('a very small price keeps its digits', roundQuote(0.00000123), 0.00000123);
eq('six significant figures is the cap', String(roundQuote(0.00123456789)).length <= 2 + QUOTE_SIG + 2, true);
eq('zero and null are themselves', [roundQuote(0), roundQuote(null), roundQuote('x')], [0, null, null]);

// ── THE CONSEQUENCE, MEASURED ────────────────────────────────────────────────
// Not a display complaint. The stored number drives the distance, the ±0.25% trigger tolerance and
// the per-unit risk that sizes the position — so the row was wrong about how close it was, would
// not have fired when it should, and would have sized off a stop distance inflated ~15x.
{
  const real = roundQuote(0.0064105), broken = +(0.0064105).toFixed(2);
  const lvl = { kind: 'buy', at: 0.006452 };
  ok('the true distance is under a percent', Math.abs(distancePct(lvl, real)) < 1);
  ok('the old one claimed a third of the price away', Math.abs(distancePct(lvl, broken)) > 30);
  // A buy zone 0.7% below the tape is close. At 0.01 it is 35% away and reads as unreachable.
  ok('the level is genuinely near the money', near(distancePct(lvl, real), 0.66, 0.05));

  // Sizing: risk per unit is |price − stop|, and on a 1,250,000-multiplier contract the error is
  // not academic.
  const stop = 0.00600;
  const good = sizeSuggestion({ mode: 'risk', equityInPos: 200000, price: real, stop, multiplier: 1250000 });
  const bad  = sizeSuggestion({ mode: 'risk', equityInPos: 200000, price: broken, stop, multiplier: 1250000 });
  ok('both size successfully', good.ok && bad.ok);
  ok('the broken price inflates per-unit risk by more than 8x', bad.perUnitRisk / good.perUnitRisk > 8);
  ok('and therefore sizes the position far too small', bad.fullQty < good.fullQty);
}

// ── TWO DIFFERENT PRICES MUST NEVER READ AS ONE ──────────────────────────────
// The property, stated directly. The old display rule (toFixed(4) under 1.0) rendered the two MJY
// levels as "0.0065" and "0.0063" — legible, and still wrong by enough to matter.
ok('the two MJY levels stay distinct', distinctlyShown(0.006452, 0.00629));
eq('and each reads as itself', [fmtPrice(0.006452), fmtPrice(0.00629)], ['0.006452', '0.00629']);
ok('the old rule collapsed them toward each other', (0.006452).toFixed(4) === '0.0065' && (0.00629).toFixed(4) === '0.0063');

// ── DISPLAY, AT EVERY SCALE ──────────────────────────────────────────────────
eq('ordinary prices keep two decimals', [fmtPrice(149.375), fmtPrice(4649.3), fmtPrice(1.5)], ['149.38', '4649.30', '1.50']);
eq('sub-dollar keeps at least two', [fmtPrice(0.5), fmtPrice(0.05)], ['0.50', '0.05']);
eq('and never grows a trailing-zero tail', fmtPrice(0.1234), '0.1234');
eq('zero is zero', fmtPrice(0), '0.00');
eq('missing is a dash', [fmtPrice(null), fmtPrice(undefined), fmtPrice(NaN)], ['—', '—', '—']);
eq('negatives format too', fmtPrice(-0.006452), '-0.006452');

// A stored quote and its display must agree — a round trip that changed the number would put the
// two back out of step, which is the whole defect in miniature.
for (const v of [0.0064105, 0.006452, 0.00629, 149.375, 0.5])
  ok(`${v} survives store-then-show`, near(+fmtPrice(roundQuote(v)), v, Math.abs(v) * 0.001));

// The trigger tolerance is a PERCENTAGE of the level, so it scales on its own — but only if the
// price it is compared against is real.
{
  const real = 0.0064105;
  ok('a level at the tape fires', levelHit({ kind: 'buy', at: real * 1.0001 }, real));
  ok('and one 35% away does not', !levelHit({ kind: 'buy', at: real * 0.65 }, real));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
