// test/inflation.test.mjs — the core CPI / core PCE gap.
import { coreSpread, IN_LINE_PP, ELEVATED_PCE } from '../lib/inflation.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// The live book, Jul 2026: core CPI 2.47, core PCE 3.34. Read core CPI alone and the job looks
// close to done; the series the Fed targets says otherwise.
const now = coreSpread(3.34414, 2.46652);
eq('the gap is PCE less core CPI', now.pp, 0.88);
ok('which is the wrong way round', now.inverted);
ok('and worth interrupting for, because PCE is elevated', now.divergent);
eq('named as what it is', now.tone, 'warn');

// The usual relationship: PCE sits below core CPI, because shelter is a third of the CPI basket and
// a much smaller share of PCE.
const normal = coreSpread(2.6, 3.1);
eq('a normal gap is negative', normal.pp, -0.5);
ok('and not flagged', !normal.inverted && !normal.divergent);
eq('with a calm tone', normal.tone, 'calm');
ok('and says why it is normal', /shelter/.test(normal.label));

// Inverted but both near target is unusual without being a warning about the target.
const smallInv = coreSpread(2.4, 2.1);
ok('an inversion at low levels is still an inversion', smallInv.inverted);
ok('but not the thing worth interrupting for', !smallInv.divergent);

// A gap inside the noise of either series is not a finding.
const flat = coreSpread(2.5, 2.45);
ok('a tenth of a point is in line', flat.inLine);
ok('not an inversion', !flat.inverted);
eq('and is described that way', flat.tone, 'watch');
// The boundary belongs to "inverted" — a threshold that excluded its own value would make the
// label flip on a rounding difference.
ok('the threshold itself counts as inverted', coreSpread(2.5, 2.5 - IN_LINE_PP).inverted);
ok('and the elevated line likewise', coreSpread(ELEVATED_PCE, 2.0).divergent);
ok('just below it, not', !coreSpread(ELEVATED_PCE - 0.01, 2.0).divergent);

// A missing series is not a zero.
eq('no PCE, no spread', coreSpread(null, 2.5), null);
eq('no CPI either', coreSpread(3.3, null), null);
eq('nor a string that is not a number', coreSpread('n/a', 2.5), null);
eq('but a numeric string is fine', coreSpread('3.3', '2.5').pp, 0.8);


// ── A SPREAD ACROSS TWO RELEASE MONTHS IS NOT A SPREAD ───────────────────────
// This file's own header, and an identical comment in the card that renders it, asserted that both
// figures share a vintage. Nothing checked it — and the two series DO NOT publish together: BLS
// releases CPI around the 11th of the following month, BEA releases PCE at the end of it. For
// roughly two weeks of every month core CPI is one month ahead of core PCE.
//
// It was true on 2026-09-10, both at 2026-07, and false the next morning when August CPI published
// and PCE did not. The gap would have moved, the card would have explained the move as inflation,
// and the cause would have been the release calendar.
{
  const { coreSpread, monthName } = await import('../lib/inflation.js');

  // The state on the day this was found: both series on July, spread valid.
  const ok1 = coreSpread(3.34, 2.47, { pceDate: '2026-07-01', cpiDate: '2026-07-01' });
  eq('matching vintages are vouched for', ok1.sameVintage, true);
  eq('and carry no warning', ok1.vintageNote, null);
  eq('the reading itself is unchanged', ok1.pp, 0.87);

  // The state the following morning.
  const bad = coreSpread(3.34, 2.60, { pceDate: '2026-07-01', cpiDate: '2026-08-01' });
  eq('a one-month gap is caught', bad.sameVintage, false);
  ok('and named in both directions', /core CPI is the August print/.test(bad.vintageNote) && /core PCE is still July/.test(bad.vintageNote));
  ok('with the cause, not just the fact', /release calendar/.test(bad.vintageNote));
  // The arithmetic still happens — the caller decides what to do with it. What must not happen is
  // the number being presented as a movement in inflation.
  ok('the figures survive for a caller that wants them', bad.pce === 3.34 && bad.cpi === 2.60);

  // UNKNOWN IS NOT FINE. A caller that supplies no dates gets null, not true — the absence of
  // evidence that they match is not evidence that they do.
  eq('no dates means it cannot be vouched for', coreSpread(3.34, 2.47).sameVintage, null);
  eq('and one date alone is no better', coreSpread(3.34, 2.47, { cpiDate: '2026-08-01' }).sameVintage, null);
  ok('neither claims a mismatch it cannot see', coreSpread(3.34, 2.47).vintageNote === null);

  // Months are written out: "07" beside "08" in a sentence about two months reads as two numbers
  // rather than as the thing that differs.
  eq('the month is a word', monthName('2026-07-01'), 'July');
  eq('and a past year is kept', monthName('2025-11-01'), 'November 2025');
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
