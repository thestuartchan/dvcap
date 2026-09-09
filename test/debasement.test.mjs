// test/debasement.test.mjs — separating an oil pass-through from a monetary repricing.
//
// Observed on the live panel 2026-09-09: gold +1.27%, 10Y BE 2.37% (+2bps), 5y5y forward 2.34%
// (+1bp). The old discriminator took a single undifferentiated "breakevens" input, read "gold up +
// breakevens up", and confirmed debasement.
//
// It should not have. The 10Y breakeven sitting ABOVE the 5y5y forward is a supply-shock
// signature: near-term expectations pricing an energy move while the long run does not. Brent
// 100.45, oil +2.70% and OVX +8.07% were on the same panel. A monetary repricing appears in the
// FAR forward, and the far forward moved one basis point.
import { classifyDebasement } from '../lib/quotes.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const BASE = { dxy: { delta: -0.1 }, realYield: { value: 1.8, deltaBps: -1 }, oas: { value: 2.68, deltaBps: 0 } };
const G = (d5, d1 = d5) => ({ chg1d: d1, chg5d: d5, chg20d: d5, value: 4450, ma50: 4300, ma200: 4100 });
const B = (d5, d1 = d5) => ({ chg1d: d1, chg5d: d5, chg20d: d5, value: 95000, ma50: 90000, ma200: 80000 });
const run = (o) => classifyDebasement({ ...BASE, ...o });

// ── the discriminator table ──────────────────────────────────────────────────
{
  const both = { gold: G(2.1), btc: B(1.5) };

  // 5y5y UP — the long-run view is repricing, which is where a monetary story shows up.
  const confirming = run({ ...both, breakeven: { value: 2.40, deltaBps: 5 }, fwdBreakeven: { value: 2.42, deltaBps: 6 } });
  ok('a rising 5y5y confirms debasement', /Debasement bid/.test(confirming.label));
  ok('and says why', /DEBASEMENT CONFIRMING/.test(confirming.discriminator));
  ok('naming the forward move', /\+6bps/.test(confirming.discriminator));

  // 5y5y FLAT with the 10Y ABOVE it — the observed 09-09 shape.
  const oil = run({ ...both, breakeven: { value: 2.37, deltaBps: 2 }, fwdBreakeven: { value: 2.34, deltaBps: 1 } });
  eq('a flat forward with the 10Y above it is oil pass-through',
    oil.label, 'OIL PASS-THROUGH — not debasement (10Y BE above 5y5y, forward flat)');
  ok('the discriminator names the supply-shock signature', /supply-shock signature/.test(oil.discriminator));
  ok('and gives the spread', /3bps ABOVE/.test(oil.discriminator));
  eq('the spread is exposed for the panel', oil.breakevens.spreadBps, 3);
  eq('as is the forward direction', oil.breakevens.fwdDir, 'flat');
  // The OLD behaviour, pinned so a revert is loud: a single blended input read this as confirming.
  ok('this is no longer labelled debasement', !/^Debasement bid/.test(oil.label));

  // 5y5y FLAT with the 10Y AT or BELOW — neither story is supported. Do not label it.
  const amb = run({ ...both, breakeven: { value: 2.30, deltaBps: 2 }, fwdBreakeven: { value: 2.34, deltaBps: 1 } });
  ok('a flat forward with the 10Y below it is ambiguous', /AMBIGUOUS — do not label/.test(amb.label));
  ok('and refuses both stories', /neither the monetary nor the supply story/.test(amb.discriminator));

  // 5y5y DOWN — long-run expectations falling while gold rises is a real-yield trade.
  const ry = run({ ...both, breakeven: { value: 2.30, deltaBps: -1 }, fwdBreakeven: { value: 2.28, deltaBps: -5 } });
  ok('a falling forward is a real-yield trade', /Real-yield trade/.test(ry.label));
  ok('and says the forward fell', /FALLING/.test(ry.discriminator));

  // "Flat" is a THRESHOLD, not zero. ±2bps on the forward.
  eq('the flat band is stated', oil.breakevens.fwdFlatBps, 2);
  ok('2bps on the forward is still flat',
    /PASS-THROUGH/.test(run({ ...both, breakeven: { value: 2.37, deltaBps: 3 }, fwdBreakeven: { value: 2.34, deltaBps: 2 } }).label));
  ok('3bps is not',
    /Debasement bid/.test(run({ ...both, breakeven: { value: 2.40, deltaBps: 4 }, fwdBreakeven: { value: 2.37, deltaBps: 3 } }).label));

  // No forward at all: the old rule, running explicitly degraded rather than silently.
  const blind = run({ ...both, breakeven: { value: 2.37, deltaBps: 2 } });
  ok('a missing forward is announced', /5y5y forward unavailable/.test(blind.discriminator));
  ok('and it says what it cannot do', /cannot separate oil pass-through/.test(blind.discriminator));
}

// ── the gold/BTC divergence is evidence, not its absence ─────────────────────
// Debasement is a monetary claim and should bid both hard assets. Gold up while BTC falls over the
// same week is affirmative evidence AGAINST the label. Returning "n/a — no regime signal" threw
// that away and reserved the same words for having no data at all.
{
  const div = run({ gold: G(2.1, 1.27), btc: B(-1.9, -0.8), breakeven: { value: 2.37, deltaBps: 2 }, fwdBreakeven: { value: 2.34, deltaBps: 1 } });
  eq('the observed split is DIVERGENT, not n/a', div.label, 'DIVERGENT — gold-specific bid, debasement not supported');
  ok('and it is not "no regime signal"', !/no regime signal/.test(div.label));
  // BOTH findings are true at once and the reader wants both: the split rules out a monetary move,
  // the term structure says what actually lifted the metal.
  ok('the term structure is still read', /OIL PASS-THROUGH/.test(div.discriminator));

  const rev = run({ gold: G(-2.1), btc: B(1.9) });
  ok('the mirror case is named for what it is', /DIVERGENT — BTC-specific/.test(rev.label));

  // n/a is RESERVED for genuinely insufficient data.
  eq('missing BTC is n/a', run({ gold: G(2.1) }).label, 'n/a — no regime signal');
  eq('missing both is n/a', run({}).label, 'n/a — no regime signal');
  // A flat leg is neither divergence nor agreement.
  ok('a flat leg is MIXED, not divergent', /MIXED/.test(run({ gold: G(2.1), btc: B(0) }).label));
}

// ── the coherence check must not fire on labels that DENY debasement ─────────
// impliedUp/impliedDown were regexes over the label text, and /Debasement/i matches "Real-yield
// trade, NOT debasement" and "OIL PASS-THROUGH — NOT debasement". Every label written to deny the
// reading was treated as asserting it, so the check fired backwards on exactly its target cases.
{
  const oilDown1d = run({ gold: G(2.1, -0.4), btc: B(1.5, -0.3),
    breakeven: { value: 2.37, deltaBps: 2 }, fwdBreakeven: { value: 2.34, deltaBps: 1 } });
  ok('the label denies debasement', /not debasement/i.test(oilDown1d.label));
  // 5d both up with 1d both down IS a real mismatch and must still be caught — the fix must not
  // silence the check, only stop it misreading which direction the label claims.
  ok('a genuine 1d/5d contradiction is still reported', /classifier\/input mismatch/.test(oilDown1d.mismatch || ''));

  // And the case that was breaking: a divergent label whose 5d inputs disagree by construction
  // must NOT be reported as a mismatch, because nothing is inconsistent about it.
  const div = run({ gold: G(2.1), btc: B(-1.9) });
  eq('a divergent label is not a mismatch', div.mismatch, null);
  const ryLabel = run({ gold: G(2.1), btc: B(1.5), breakeven: { value: 2.3, deltaBps: -1 }, fwdBreakeven: { value: 2.28, deltaBps: -5 } });
  eq('nor is a real-yield label with both legs up', ryLabel.mismatch, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
