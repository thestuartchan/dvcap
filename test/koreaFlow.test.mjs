// test/koreaFlow.test.mjs — the cross-panel qualifier, and the flows it reads.
//
// Observed on the live panel 2026-09-09. Two panels reached compatible conclusions independently
// and neither knew about the other:
//
//   Cross-asset Gate 2: SUSPECT — "the won strengthened but no unflagged leg moved even half as
//   far. A Korea-specific bid is what official smoothing looks like."
//
//   Korea flow READ: "Cautious tone... Dry powder is building — buffer and optionality intact for
//   MORE UPSIDE" — generated from the flow table alone, with no input from the FX gate.
//
// The flows underneath that second read: Foreign −₩435bn, Retail −₩2,288bn, Institutional
// +₩942bn. Institutions the sole net buyer, absorbing selling five times heavier from retail than
// from foreigners. Gate 2 SUSPECT plus institutions-as-sole-absorber is the same finding twice —
// the bid is official rather than organic — and the panel offered forward-looking language instead.
import { koreaFlowImplication, instSoleBuyer } from '../lib/kofia.js';
import { evaluateScenarios } from '../lib/scenarios.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// The board exactly as observed.
const OBSERVED = {
  foreignNet: { value: -435 }, instNet: { value: 942 }, retailNet: { value: -2288 },
  deposits: { pct: 1.2 },
};

// ── is the institution the only buyer ────────────────────────────────────────
{
  eq('the observed print has institutions as sole buyer', instSoleBuyer(OBSERVED), true);
  eq('foreign buying too is not "only"', instSoleBuyer({ ...OBSERVED, foreignNet: { value: 100 } }), false);
  eq('retail buying too is not "only"', instSoleBuyer({ ...OBSERVED, retailNet: { value: 100 } }), false);
  eq('institutions selling is not it either', instSoleBuyer({ ...OBSERVED, instNet: { value: -50 } }), false);
  // Zero is not buying. A flat leg must not count as the distribution that makes "only" true, and
  // must not count as a positive leg that makes it false — it is simply not a buyer.
  eq('a flat foreign leg still leaves institutions alone', instSoleBuyer({ ...OBSERVED, foreignNet: { value: 0 } }), true);
  eq('a flat institutional leg is not buying', instSoleBuyer({ ...OBSERVED, instNet: { value: 0 } }), false);
  // ALL THREE legs must be readable. Two-of-three cannot establish "only", and inferring it from a
  // missing leg is how a qualifier starts firing on absent data.
  eq('a missing retail leg yields null, not true', instSoleBuyer({ foreignNet: { value: -435 }, instNet: { value: 942 } }), null);
  eq('a missing foreign leg likewise', instSoleBuyer({ instNet: { value: 942 }, retailNet: { value: -2288 } }), null);
  eq('nothing at all is null', instSoleBuyer(null), null);
}

// ── the downgrade ────────────────────────────────────────────────────────────
{
  const before = koreaFlowImplication(OBSERVED);
  const after = koreaFlowImplication(OBSERVED, { gate2: 'suspect' });

  // What the panel actually said, and why it was wrong to say it.
  ok('the ungated read is the constructive one', /Dry powder is building/.test(before));
  ok('and it looks forward', /more upside/.test(before));

  ok('the gated read is downgraded', /SUPPORTED — NOT ORGANIC/.test(after));
  ok('and the forward-looking language is gone', !/more upside/.test(after));
  ok('as is the optionality claim', !/optionality intact/.test(after));
  ok('and it declines to give a direction', /No directional read/.test(after));

  // AUDITABLE. Both triggering conditions have to appear in the text, not just their conclusion —
  // a qualifier a reader cannot check is one they have to take on trust.
  ok('the Gate 2 condition is stated', /Gate 2 is SUSPECT/.test(after));
  ok('the sole-buyer condition is stated', /sole net buyer/.test(after));
  ok('with the institutional figure', /₩942bn/.test(after));
  ok('the foreign figure', /₩435bn/.test(after));
  ok('and the retail figure — the heaviest seller of the three', /₩2,288bn/.test(after));

  // BOTH conditions, or nothing. Either alone is not the finding.
  eq('gate 2 clean does not downgrade', koreaFlowImplication(OBSERVED, { gate2: 'clean' }), before);
  eq('nor does an unresolved gate', koreaFlowImplication(OBSERVED, { gate2: 'unknown' }), before);
  eq('nor an absent one', koreaFlowImplication(OBSERVED), before);
  const foreignBuying = { ...OBSERVED, foreignNet: { value: 500 } };
  ok('gate 2 suspect alone does not downgrade when foreigners are buying too',
    !/NOT ORGANIC/.test(koreaFlowImplication(foreignBuying, { gate2: 'suspect' })));
  // And with a leg missing the qualifier must stay silent rather than guess.
  ok('a missing retail leg leaves the read ungated',
    !/NOT ORGANIC/.test(koreaFlowImplication({ foreignNet: { value: -435 }, instNet: { value: 942 } }, { gate2: 'suspect' })));

  // Staleness must survive the new branch — it was previously appended only on the old path.
  const stale = koreaFlowImplication({ ...OBSERVED, instNet: { value: 942, asOf: '2026-08-01' } }, { gate2: 'suspect' });
  ok('a stale driver is still flagged on the downgraded read', /Stale inputs/.test(stale));
}

// ── carried into the scenario board ──────────────────────────────────────────
// An EXHAUSTING reached on a non-organic bid is lower conviction than one reached on organic flow.
// A qualifier, deliberately not a break: it lowers what the reading is worth, it does not disprove
// the mechanics.
{
  const live = { korea: { volBand: 'EXTREME', volRolling: false, date: '2026-09-09' },
                 units7709: { value: -7.2, atr: 2.0, date: '2026-09-09' } };
  const plain = evaluateScenarios(live).find(s => s.id === 'KM');
  const flagged = evaluateScenarios({ ...live, koreaBidNonOrganic: true }).find(s => s.id === 'KM');

  eq('without the flag KM carries no qualifier', plain.qualifier, null);
  ok('with it, KM says the bid is not organic', /not organic/.test(flagged.qualifier));
  ok('and names both triggering conditions', /Gate 2 reads SUSPECT/.test(flagged.qualifier) && /sole net buyer/.test(flagged.qualifier));

  // It must NOT masquerade as evidence. The count, the status and the break are untouched.
  eq('the status is unchanged', flagged.status, plain.status);
  eq('the count is unchanged', [flagged.met, flagged.total], [plain.met, plain.total]);
  eq('and it does not break the scenario', flagged.broken, false);

  // One scenario, not all of them. It is a claim about the Korean bid.
  const others = evaluateScenarios({ koreaBidNonOrganic: true }).filter(s => s.id !== 'KM');
  ok('no other scenario picks it up', others.every(s => s.qualifier == null));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
