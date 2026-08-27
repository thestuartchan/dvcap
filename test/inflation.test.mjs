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

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
