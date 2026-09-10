// test/asiaContext.test.mjs — the handoff and the China line: two things this board computed and
// never printed.
import { handoffLine, chinaLine, HANDOFF_MIN_PP } from '../lib/briefSections.js';
import { usdLeg } from '../lib/quotes.js';
import { assertObservational } from '../lib/read.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// ── THE HANDOFF ────────────────────────────────────────────────────────────
// The live Asia payload at 2026-09-10T22:48Z. lib/handoff.js had computed this on every Asia
// assemble since it was written; it read GAP-DOWN RISK on a 1.82pp gap with the open three hours
// away, and the brief that went out at that minute said nothing about it.
const LIVE = { forward: { available: true, verdict: 'GAP-DOWN RISK', tone: 'amber', gap: 1.82,
  usRef: -2.66, asiaRef: -0.84, nextOpenH: 3,
  drivers: [{ name: 'SOX', detail: '-2.66%' }, { name: '30Y', detail: '+3bp' }, { name: 'Oil', detail: '+8.26%' }] },
  backward: { available: true, verdict: 'CONFIRMING', note: 'Validation: Asia down 0.84% with 2/3 of the overnight drivers.' } };
{
  const l = handoffLine(LIVE);
  ok('the verdict leads', /\*\*GAP-DOWN RISK\*\*/.test(l));
  ok('both sides of the gap are shown', /-0\.8%/.test(l) && /-2\.7%/.test(l));
  ok('and the gap itself', /\*\*1\.82pp\*\*/.test(l));
  ok('with how long until it matters', /3h to the open/.test(l));
  ok('and what drove it', /SOX -2\.66% · 30Y \+3bp · Oil \+8\.26%/.test(l));

  // FORWARD ONLY. The backward half validates a session that is over; the reader at 06:48 local is
  // deciding about the one that has not started.
  ok('the backward validation stays off the brief', !/CONFIRMING|Validation/.test(l));

  // A line that fires every morning is one a reader stops seeing.
  eq('a gap inside the floor renders nothing',
     handoffLine({ forward: { available: true, verdict: 'IN LINE', gap: 0.2, usRef: -0.3, asiaRef: -0.5 } }), null);
  ok('the floor is a named constant', HANDOFF_MIN_PP > 0 && HANDOFF_MIN_PP < 2);
  eq('an unavailable handoff renders nothing', handoffLine({ forward: { available: false } }), null);
  eq('and neither does none at all', handoffLine(null), null);
  eq('nor one with no gap computed', handoffLine({ forward: { available: true, verdict: 'X' } }), null);
  // It works the other way up too — the Asia brief fires into both kinds of morning.
  ok('a gap-up reads as one', /GAP-UP RISK/.test(handoffLine({ forward: { available: true,
     verdict: 'GAP-UP RISK', gap: 1.4, usRef: 1.2, asiaRef: -0.2, nextOpenH: 2, drivers: [] } })));
}

// ── THE CHINA LINE ─────────────────────────────────────────────────────────
// Korea had a currency, a fear gauge and a state. China — HSTECH, HSI, SMIC, BYD, Alibaba,
// Tencent, Biren, about half the names in the Asia brief — had no line at all.
{
  const both = chinaLine({ cnh: 6.7131, cnhPct: 0.31, ah: { premium: 116.6, d5: 3 } });
  ok('the currency is named the way it is quoted', /USD\/CNH \*\*6\.7131\*\*/.test(both));
  // A RISING USD/CNH IS A WEAKER YUAN. Quoted the other way up the sign would invert — the same
  // trap lib/fx.js documents for the won.
  ok('and a rising print reads as a weaker yuan', /yuan weaker/.test(both));
  ok('a falling one as firmer', /yuan firmer/.test(chinaLine({ cnh: 6.68, cnhPct: -0.31 })));
  ok('and a hair either way as flat', /— flat/.test(chinaLine({ cnh: 6.71, cnhPct: 0.01 })));

  ok('the premium is carried with its 5-day move', /SMIC A\/H premium \*\*116\.6pp\*\* \(\+3pp 5d\)/.test(both));
  ok('widening says which leg is the funding one', /the H-share is the funding leg/.test(both));
  ok('and compressing says conviction is draining',
     /mainland conviction draining/.test(chinaLine({ ah: { premium: 110, d5: -4 } })));

  // Either half alone is a line; neither is not.
  ok('the currency alone renders', /USD\/CNH/.test(chinaLine({ cnh: 6.71, cnhPct: 0.2 })));
  ok('the premium alone renders', /A\/H premium/.test(chinaLine({ ah: { premium: 116.6, d5: 3 } })));
  eq('and nothing renders nothing', chinaLine({}), null);
  eq('a premium with no 5-day move states the level only',
     /5d/.test(chinaLine({ ah: { premium: 116.6 } })), false);
}

// ── THE DOLLAR LEG ─────────────────────────────────────────────────────────
// CNH=X is quoted offshore yuan per dollar, the same way up as the yen and the won. Without
// registering that, usdLeg returns null and the largest Asian currency drops silently out of the
// dollar read.
{
  eq('a rising USD/CNH is a stronger dollar', usdLeg({ sym: 'CNH=X', changePct: 0.31 }).dir, 'stronger');
  eq('named against the right currency', usdLeg({ sym: 'CNH=X', changePct: 0.31 }).vs, 'CNH');
  eq('and it is not treated as inverted', usdLeg({ sym: 'CNH=X', changePct: 0.31 }).inverted, false);
  eq('a falling one is a weaker dollar', usdLeg({ sym: 'CNH=X', changePct: -0.31 }).dir, 'weaker');
  // The contrast that makes the registration necessary: EUR/USD is quoted the other way up.
  eq('EUR/USD still inverts', usdLeg({ sym: 'EURUSD=X', changePct: 0.31 }).dir, 'weaker');
  eq('an unregistered pair is still no leg at all', usdLeg({ sym: 'CNY=X', changePct: 0.31 }), null);
}

// ── OBSERVATION, NOT INSTRUCTION ───────────────────────────────────────────
{
  const lines = [handoffLine(LIVE), chinaLine({ cnh: 6.7131, cnhPct: 0.31, ah: { premium: 116.6, d5: 3 } }),
                 chinaLine({ ah: { premium: 110, d5: -4 } })].filter(Boolean);
  eq('there is something to check', lines.length, 3);
  for (const l of lines) ok(`observational: "${l.replace(/\*/g, '').slice(0, 36)}"`, assertObservational(l).ok);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
