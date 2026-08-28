// test/derived.test.mjs — a derived value is only as good as the worst alignment among its inputs.
import { aligned, spreadBps, dayOf } from '../lib/derived.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const o = (name, value, date) => ({ name, value, date });

// The live case: DGS10 and DGS2 both printed on the 26th, so 2s10s is computable and dated.
{
  const r = spreadBps(o('DGS10', 4.66, '2026-08-26'), o('DGS2', 4.19, '2026-08-26'));
  eq('a spread on matched vintages computes', r.value, 47);
  eq('and carries the date BOTH legs share', r.date, '2026-08-26');
  eq('marked as actually checked', [r.ok, r.checked], [true, true]);
}
// The case the board would have got wrong: one leg lags.
{
  const r = spreadBps(o('DGS10', 4.66, '2026-08-27'), o('DGS2', 4.19, '2026-08-26'));
  eq('a spread across vintages does not compute', r.value, null);
  eq('and does not borrow a date from either leg', r.date, null);
  ok('it names which leg is which', /DGS10 2026-08-27/.test(r.reason) && /DGS2 2026-08-26/.test(r.reason));
  // The point of `checked`: a card must be able to say it stopped, not just show a blank.
  eq('and says it did not check, rather than going quiet', r.checked, false);
  eq('with every date available for rendering', r.dates, { DGS10: '2026-08-27', DGS2: '2026-08-26' });
}
// A missing print is a different failure from a misaligned one, and says so.
{
  const r = spreadBps(o('DGS10', null, '2026-08-26'), o('DGS2', 4.19, '2026-08-26'));
  ok('a missing leg is named', /no print for DGS10/.test(r.reason));
  eq('and nothing is derived from it', r.value, null);
}
// An undated observation cannot be aligned against anything, and guessing would defeat the purpose.
{
  const r = spreadBps(o('DGS10', 4.66, null), o('DGS2', 4.19, '2026-08-26'));
  ok('an undated leg is named', /no observation date for DGS10/.test(r.reason));
}
// Three legs, which is the Fisher identity. All three must agree, not just two.
{
  const good = aligned([o('DGS10', 4.66, '2026-08-26'), o('DFII10', 2.34, '2026-08-26'), o('T10YIE', 2.32, '2026-08-26')],
    (n, r, b) => Math.round((n - (r + b)) * 100));
  eq('matched vintages give the identity exactly', good.value, 0);
  // This is the live shape on 2026-08-27: the breakeven is a day ahead of its own inputs.
  const live = aligned([o('DGS10', 4.66, '2026-08-26'), o('DFII10', 2.34, '2026-08-26'), o('T10YIE', 2.33, '2026-08-27')],
    (n, r, b) => Math.round((n - (r + b)) * 100));
  eq('one leg out of three is enough to stop it', live.checked, false);
  ok('and the odd leg is identifiable', /T10YIE 2026-08-27/.test(live.reason));
  // Cross-vintage it would have computed −1bp and sailed through a 10bp tolerance: a false pass,
  // which is exactly what a guard must not produce.
  eq('the number it would have produced', Math.round((4.66 - (2.34 + 2.33)) * 100), -1);
}
// Nothing in, nothing claimed.
eq('an empty set derives nothing', aligned([], () => 1).value, null);
ok('and says so', /nothing to derive/.test(aligned([], () => 1).reason));

// Intraday stamps reduce to a UTC day, which is the coarsest honest test for two live ticks.
eq('an epoch second becomes its day', dayOf(1787788800), '2026-08-27');
eq('and junk is not a day', dayOf(null), null);
{
  const r = aligned([o('Brent', 71.2, dayOf(1787788800)), o('WTI', 67.4, dayOf(1787788800))], (a, b) => +(a - b).toFixed(2));
  eq('two ticks from the same session subtract', r.value, 3.8);
  const stale = aligned([o('Brent', 71.2, dayOf(1787702400)), o('WTI', 67.4, dayOf(1787788800))], (a, b) => +(a - b).toFixed(2));
  eq('a stale leg against a live one does not', stale.value, null);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
