// test/sizer.test.mjs — the size, before the trade.
import { sizeTrade, sizerRun, appendRun, reconcileRuns, catalystCheck, isZeroDteExpiry, capReview, isExempt, sizeFuture, futuresReview, leveragedReview,
         SIZER_LIMITS, RULE_SETS, MAX_RUNS } from '../lib/sizer.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const NOW = new Date('2026-09-10T14:00:00Z');   // 10:00 ET, a Thursday
const NLV = 202000;

// ── THE WORKED EXAMPLE, WHICH IS WHY THIS EXISTS ────────────────────────────
// QQQ Oct16 730C went on at 20 contracts. At entry — QQQ ~718, ATR(20) ~8.50, delta 0.42, mark
// 11.90 — both tests returned five.
{
  const r = sizeTrade({ kind: 'option', symbol: 'QQQ 730C', price: 718, atr: 8.50, atrPct: 1.18,
    delta: 0.42, mark: 11.90, expiry: '2026-10-16', nlv: NLV, bookDeltaNotional: 80800, now: NOW });

  eq('the ATR test returns five', r.tests.find(t => t.name === 'ATR test').size, 5);
  eq('and so does the premium cap', r.tests.find(t => /Premium cap/.test(t.name)).size, 5);
  eq('so the size is five, not twenty', r.size, 5);
  eq('at $5,950 of premium', r.premium, 5950);
  eq('adding $150,780 of delta-notional', r.deltaAdded, 150780);
  eq('taking the book from 0.40×', r.book.before, 0.4);
  eq('to 1.15×', r.book.after, 1.15);
  eq('with 0.35× left to the ceiling', r.book.remaining, 0.35);
  eq('and nothing is past the ceiling at that size', r.pastCeiling, false);
  ok('but it is past the target and says so', r.notes.some(n => /past the 1× target/.test(n)));
  eq('36 days to expiry', r.dte, 36);
}

// ── BOTH TESTS ARE ALWAYS SHOWN, AND WHICH ONE BINDS ────────────────────────
// For volatile single names the concentration cap usually wins; for options they often agree.
// Hiding the losing test behind the final number removes the only part of this that teaches.
{
  const stock = sizeTrade({ kind: 'stock', symbol: 'PLTR', price: 185, atr: 7.4, nlv: NLV, now: NOW });
  eq('the ATR test is generous on a $185 name', stock.tests[0].size, 272);
  eq('and the concentration cap is what binds', stock.size, 109);
  eq('named', stock.binding, 'Concentration cap (10%)');
  eq('both are returned either way', stock.tests.length, 2);
  ok('and each carries its arithmetic', stock.tests.every(t => /÷/.test(t.detail)));
  // A tie marks both, because "they agreed" is a different reading from "one won".
  const tie = sizeTrade({ kind: 'option', symbol: 'QQQ 730C', price: 718, atr: 8.5, delta: 0.42,
    mark: 11.90, expiry: '2026-10-16', nlv: NLV, now: NOW });
  eq('a tie marks both tests', tie.tests.filter(t => t.binds).length, 2);
}

// ── NEVER ROUND UP ──────────────────────────────────────────────────────────
{
  // 5.8 contracts is five. Rounding up spends more than the budget the rule set.
  const r = sizeTrade({ kind: 'stock', price: 100, atr: 3.44, nlv: 200000, now: NOW });
  eq('5.8 renders as 5', r.tests[0].size, 581);   // 2000/3.44 = 581.39
  const s = sizeTrade({ kind: 'stock', price: 100, atr: 344, nlv: 200000, now: NOW });
  eq('and 5.8 contracts likewise', s.tests[0].size, 5);
}

// ── BELOW ONE IS A CORRECT ANSWER, AND IT IS SAID ───────────────────────────
{
  const r = sizeTrade({ kind: 'stock', symbol: 'X', price: 5000, atr: 3000, nlv: NLV, now: NOW });
  eq('the size is zero', r.size, 0);
  eq('flagged as below one', r.belowOne, true);
  ok('with what it means', r.warnings.some(w => /too volatile or the account too small/.test(w)));
}

// ── WARN, NEVER BLOCK ───────────────────────────────────────────────────────
// This refused. Past 1.5× NLV it struck the computed size through, printed ⛔ EXCEEDS CEILING and
// offered the size that would fit instead — so the one question asked of it went unanswered exactly
// when the answer was most worth arguing with.
//
// The ceiling is not wrong; deciding for the operator is. Frameworks build best practice, and the
// room to act on instinct in an exceptional case is what makes an operator good at this. Overrides
// should be rare and must never be foreclosed. Every constraint is now a fact with its numbers
// attached, and the discipline lives in the log instead.
{
  const r = sizeTrade({ kind: 'option', symbol: 'QQQ 730C', price: 718, atr: 8.5, delta: 0.42,
    mark: 11.90, expiry: '2026-10-16', nlv: NLV, bookDeltaNotional: 250000, now: NOW });
  eq('the ceiling is reported', r.pastCeiling, true);
  eq('and nothing is refused', r.ok, true);
  eq('the size stands as the rule computed it', r.size, 5);
  eq('the size that would fit is reported beside it, never substituted', r.fitSize, 1);
  ok('and the reason names the ceiling', r.warnings.some(w => /past the 1.5× ceiling/.test(w)));
  ok('with what would sit inside it', r.warnings.some(w => /1 would sit inside it/.test(w)));
  // NO FIELD IS HIDDEN AND NOTHING IS STRUCK THROUGH: premium, delta and the book projection are
  // all computed at the size the rule returned, exactly as on a trade that fits.
  eq('the premium is still computed', r.premium, 5950);
  ok('and the delta added', r.deltaAdded > 0);
  eq('there is no blocked flag left to branch on', r.blocked, undefined);
  // A book already past the ceiling has no room at all.
  const full = sizeTrade({ kind: 'stock', price: 100, atr: 3, nlv: NLV, bookDeltaNotional: NLV * 2, now: NOW });
  eq('a book already over has no room', full.fitSize, 0);
  eq('the ceiling and target are named constants', [SIZER_LIMITS.portfolioDeltaTarget, SIZER_LIMITS.portfolioDeltaCeiling], [1.0, 1.5]);
}

// ── 0DTE IS A DIFFERENT REGIME ──────────────────────────────────────────────
// Gamma makes delta unstable within the session, so the ratio the ATR test rests on is obsolete
// before it can be acted on.
{
  const z = sizeTrade({ kind: 'option', symbol: 'SPY 760C', price: 759, atr: 6.2, delta: 0.40,
    mark: 2.50, expiry: '2026-09-10', nlv: NLV, now: NOW });
  eq('it is detected from the expiry', z.ruleSet, RULE_SETS.ZERO_DTE);
  eq('and the flag is set', z.zeroDte, true);
  ok('the ATR test is not among the tests', !z.tests.some(t => t.name === 'ATR test'));
  ok('and the banner says why', z.notes.some(n => /gamma makes delta unstable/.test(n)));
  ok('naming the flat-by time', z.notes.some(n => /15:30 ET/.test(n)));
  eq('premium governs', z.size, 8);   // $2,020 / $250

  // THE CONTRACT CEILING MATTERS MORE THAN IT LOOKS. At the same money a $0.60 contract buys 33
  // lots — four times the delta-notional and a commission load reaching 3-5% of the trade.
  const cheap = sizeTrade({ kind: 'option', symbol: 'SPY 770C', price: 759, atr: 6.2, delta: 0.40,
    mark: 0.60, expiry: '2026-09-10', nlv: NLV, now: NOW });
  eq('a cheap contract is capped at 20', cheap.size, 20);
  eq('by the contract ceiling, not the premium', cheap.binding, 'Contract ceiling');

  // CONCURRENT ACROSS ALL OPEN 0DTE, not per position.
  const some = sizeTrade({ kind: 'option', symbol: 'SPY 760C', price: 759, atr: 6.2, delta: 0.40,
    mark: 2.50, expiry: '2026-09-10', nlv: NLV, openZeroDtePremium: 1500, now: NOW });
  eq('what is already on comes off the budget', some.size, 2);   // ($2,020 − $1,500) / $250
  const spent = sizeTrade({ kind: 'option', symbol: 'SPY 760C', price: 759, atr: 6.2, delta: 0.40,
    mark: 2.50, expiry: '2026-09-10', nlv: NLV, openZeroDtePremium: 2100, now: NOW });
  eq('and a spent budget leaves nothing', spent.size, 0);

  // The delta band is a check, not a size input.
  const wide = sizeTrade({ kind: 'option', symbol: 'SPY 800C', price: 759, atr: 6.2, delta: 0.12,
    mark: 2.50, expiry: '2026-09-10', nlv: NLV, now: NOW });
  ok('a delta outside the band is flagged', wide.warnings.some(w => /outside the 0.35–0.45 band/.test(w)));
  ok('and one inside it is not', !z.warnings.some(w => /band/.test(w)));

  // 0DTE IS TODAY IN NEW YORK, NOT IN UTC. Between 20:00 and 24:00 UTC the two disagree, and that
  // window is inside the US session — so a UTC comparison would call a same-day expiry next-day
  // for the last four hours of every trading day.
  eq('at 22:00 UTC the ET date is still the 10th', isZeroDteExpiry('2026-09-10', new Date('2026-09-10T22:00:00Z')), true);
  eq('and a later expiry is not 0DTE', isZeroDteExpiry('2026-09-11', new Date('2026-09-10T22:00:00Z')), false);
  eq('a stock is never 0DTE', sizeTrade({ kind: 'stock', price: 100, atr: 3, nlv: NLV, now: NOW }).zeroDte, false);
}

// ── A MISSING INPUT IS SAID, NOT GUESSED ────────────────────────────────────
{
  eq('no account value, no size', sizeTrade({ kind: 'stock', price: 100, atr: 3 }).ok, false);
  const noAtr = sizeTrade({ kind: 'stock', price: 100, nlv: NLV, now: NOW });
  eq('no ATR leaves that test unscored', noAtr.tests[0].size, null);
  ok('with the reason', /range that is not known/.test(noAtr.tests[0].detail));
  eq('and the other test still binds', noAtr.size, 202);
  eq('the unscored test is named', noAtr.unscored, ['ATR test']);
  const noDelta = sizeTrade({ kind: 'option', symbol: 'QQQ 730C', price: 718, atr: 8.5, mark: 11.9, expiry: '2026-10-16', nlv: NLV, now: NOW });
  ok('no delta is its own reason', /move per ATR is unknown/.test(noDelta.tests[0].detail));
}

// ── INDICATIVE, NOT BLANK ───────────────────────────────────────────────────
// Pre-open the greeks are the prior close. The size is still computed and marked.
{
  const r = sizeTrade({ kind: 'option', symbol: 'QQQ 730C', price: 718, atr: 8.5, delta: 0.42, mark: 11.9,
    expiry: '2026-10-16', nlv: NLV, indicative: true, asOf: '2026-09-09T20:05:00Z', now: NOW });
  eq('a size is still produced', r.size, 5);
  eq('and marked', r.indicative, true);
  ok('with the stamp', r.notes.some(n => /prior close/.test(n) && /2026-09-09/.test(n)));
}

// ── THE CATALYST JOIN ───────────────────────────────────────────────────────
// A multi-month thesis wrapped in a 40-day option is the documented failure mode.
{
  const cal = [{ date: '2026-09-15', title: 'US CPI (Aug)', tier: 1 },
               { date: '2026-09-17', title: 'US 10-Year auction', tier: 1 },
               { date: '2026-10-01', title: 'Jobless claims (weekly)', tier: 2 }];
  const has = catalystCheck('2026-10-16', cal, NOW);
  eq('a catalyst inside the expiry is found', has.none, false);
  ok('and named', /US CPI/.test(has.note));
  // TIER 1 ONLY: a weekly claims print is not what "does this expiry contain a catalyst" means.
  const weekly = catalystCheck('2026-10-16', [cal[2]], NOW);
  eq('a tier-2 print does not count', weekly.none, true);
  const empty = catalystCheck('2026-09-12', cal, NOW);
  eq('an expiry before the next catalyst is flagged', empty.none, true);
  ok('with the failure mode named', /multi-month thesis wrapped in a dated option/.test(empty.note));
  // NOT CHECKED is distinct from CHECKED AND EMPTY.
  eq('no calendar means not checked', catalystCheck('2026-10-16', null, NOW).checked, false);
  const r = sizeTrade({ kind: 'option', symbol: 'QQQ 730C', price: 718, atr: 8.5, delta: 0.42, mark: 11.9,
    expiry: '2026-09-12', nlv: NLV, catalysts: cal, now: NOW });
  // A FLAG, NOT A STOP. The prior design proposed making this a required input; it is optional in
  // every sense, and an expiry with nothing scheduled is reported as a NOTE rather than a warning
  // because it is a fact about the calendar, not a fault in the trade.
  ok('and it reaches the result', r.notes.some(w => /no scheduled catalyst/.test(w)));
  ok('without becoming a warning', !r.warnings.some(w => /no scheduled catalyst/.test(w)));
  eq('and the size is computed regardless', r.size > 0, true);
  // NOTHING REQUIRES THE CALENDAR. Omitting it changes what is reported, never what is returned.
  const noCal = sizeTrade({ kind: 'option', symbol: 'QQQ 730C', price: 718, atr: 8.5, delta: 0.42, mark: 11.9,
    expiry: '2026-09-12', nlv: NLV, now: NOW });
  eq('no calendar, same size', noCal.size, r.size);
  eq('and it says so rather than assuming', noCal.catalysts.checked, false);
}

// ── THE JOURNAL, AND THE ONLY THING THAT PROVES ANY OF THIS WORKS ───────────
{
  const r = sizeTrade({ kind: 'option', symbol: 'QQQ 730C', price: 718, atr: 8.5, delta: 0.42,
    mark: 11.9, expiry: '2026-10-16', nlv: NLV, bookDeltaNotional: 80800, now: NOW });
  const run = sizerRun(r, { at: '2026-09-01T13:45:00Z' });
  eq('the run records the size', run.size, 5);
  eq('and which test bound it', run.binding, 'ATR test');
  eq('and the book either side', [run.bookBefore, run.bookAfter], [0.4, 1.15]);
  ok('with the inputs, so it can be re-read against the conditions', run.atr === 8.5 && run.delta === 0.42);
  eq('a failed size records nothing', sizerRun({ ok: false }), null);
  eq('the log is capped', appendRun(Array.from({ length: MAX_RUNS }, (_, i) => ({ at: `${i}` })), run).length, MAX_RUNS);

  // INTENDED vs ACTUAL. The finding this whole module exists for.
  const rec = reconcileRuns([run], [{ symbol: 'QQQ 730C', qty: 20, at: '2026-09-01T14:02:00Z' }]);
  eq('the fill is matched to the run', rec.taken, 1);
  eq('and the override measured', rec.worst.ratio, 4);
  ok('said in a sentence', /actual exceeded suggested on 1 of 1/.test(rec.note));
  eq('intended and actual are both kept', [rec.worst.intended, rec.worst.actual], [5, 20]);

  // A SIZED-AND-DECLINED TRADE IS NOT A VIOLATION. It is the tool working, and it is counted as
  // its own outcome rather than folded into the denominator.
  const declined = reconcileRuns([run], []);
  eq('no fill is not an override', declined.exceeded, 0);
  eq('it is counted separately', declined.notTaken, 1);

  // A fill outside the window is a different decision wearing the same ticker.
  const late = reconcileRuns([run], [{ symbol: 'QQQ 730C', qty: 20, at: '2026-09-05T14:02:00Z' }]);
  eq('a fill days later does not match', late.taken, 0);
  // Following the size is neither over nor under.
  const obeyed = reconcileRuns([run], [{ symbol: 'QQQ 730C', qty: 5, at: '2026-09-01T14:02:00Z' }]);
  eq('taking the suggested size is followed', obeyed.followed, 1);
  eq('with a ratio of one', obeyed.meanRatio, 1);
  // PAST THE CEILING IS MEASURED AGAINST THE RULE'S OWN SIZE, because that is now what was on
  // screen. It used to be measured against the substitute the ceiling offered.
  const overRun = sizerRun(sizeTrade({ kind: 'option', symbol: 'QQQ 730C', price: 718, atr: 8.5,
    delta: 0.42, mark: 11.9, expiry: '2026-10-16', nlv: NLV, bookDeltaNotional: 250000, now: NOW }),
    { at: '2026-09-01T13:45:00Z' });
  eq('the run no longer carries a block flag', overRun.blocked, undefined);
  const vsOver = reconcileRuns([overRun], [{ symbol: 'QQQ 730C', qty: 5, at: '2026-09-01T14:00:00Z' }]);
  eq('it is measured against the suggested size', vsOver.worst.intended, 5);
  eq('so taking exactly it is 1x', vsOver.worst.ratio, 1);

  // ── THE LOG IS A RECORD OF WHAT WAS SHOWN ──────────────────────────────────
  // Runs written before the ceiling stopped blocking carry `blocked: true` and were shown `fitSize`
  // instead of `size`. They are still measured against what was actually on screen at the time:
  // rewriting their meaning retrospectively would make an old row describe a moment that never
  // happened. Nothing writes `blocked` any more, so this only ever applies to history.
  const legacy = { at: '2026-08-01T13:45:00Z', symbol: 'QQQ 730C', size: 5, blocked: true, fitSize: 1 };
  const vsLegacy = reconcileRuns([legacy], [{ symbol: 'QQQ 730C', qty: 5, at: '2026-08-01T14:00:00Z' }]);
  eq('a legacy blocked run keeps its offered size', vsLegacy.worst.intended, 1);
  eq('so the same fill reads as 5x there', vsLegacy.worst.ratio, 5);
  eq('nothing recorded is nothing to report', reconcileRuns([], []).n, 0);
}

// ── SHAPED FOR THE LOG THAT ALREADY RECONCILES ──────────────────────────────
// lib/decisions.js reads `suggestion.roomQty ?? suggestion.fullQty` as the recommendation. A
// second journal of the same thing would drift from it within a week.
{
  const r = sizeTrade({ kind: 'option', symbol: 'QQQ 730C', price: 718, atr: 8.5, delta: 0.42, mark: 11.9,
    expiry: '2026-10-16', nlv: NLV, now: NOW });
  eq('the suggestion carries the field the log reads', r.roomQty, 5);
  eq('and the full size beside it', r.fullQty, 5);
  ok('with a mode and a risk percentage', r.mode === 'option' && r.effPct === SIZER_LIMITS.riskPct);
  // ONE SIZE, AND IT IS THE RULE'S. `roomQty` used to become `fitSize` once the book was past the
  // ceiling, so the reconciliation measured an override against a number the ceiling had
  // substituted rather than against what the rule said.
  const b = sizeTrade({ kind: 'option', symbol: 'QQQ 730C', price: 718, atr: 8.5, delta: 0.42, mark: 11.9,
    expiry: '2026-10-16', nlv: NLV, bookDeltaNotional: 250000, now: NOW });
  eq('past the ceiling it still recommends the rule\'s size', b.roomQty, 5);
  eq('with what would fit reported separately', b.fitSize, 1);
}

// ── CONFIGURABLE, WITH THE SHIPPED DEFAULTS THE SPEC NAMES ──────────────────
{
  eq('the defaults are the specified ones',
     [SIZER_LIMITS.riskPct, SIZER_LIMITS.singleNamePct, SIZER_LIMITS.optionPremiumPct,
      SIZER_LIMITS.zeroDtePremiumPct, SIZER_LIMITS.zeroDteContractCap],
     [1.0, 10, 3, 1, 20]);
  const loose = sizeTrade({ kind: 'stock', price: 185, atr: 7.4, nlv: NLV,
    limits: { singleNamePct: 25 }, now: NOW });
  eq('a raised concentration cap is respected', loose.size, 272);
  eq('and the ATR test now binds', loose.binding, 'ATR test');
  eq('the reading carries the limits it used', loose.limits.singleNamePct, 25);
}


// ── WHAT YOU TYPED, AGAINST WHAT THE RULE SAID ──────────────────────────────
// The single most useful line on the card: it names the gap without arguing about it. And the
// half the log is built around — the suggested size alone cannot say later whether a rule was
// followed.
{
  const base = { kind: 'option', symbol: 'QQQ 730C', price: 718, atr: 8.5, atrPct: 1.18,
                 delta: 0.42, mark: 11.90, expiry: '2026-10-16', nlv: NLV, bookDeltaNotional: 80800, now: NOW };
  const blank = sizeTrade(base);
  // A BLANK FIELD IS A QUESTION NEVER ASKED, not agreement with the suggestion, and must not read
  // as it — 1.00× would be indistinguishable from having typed the suggested size.
  eq('nothing entered is null, not zero and not one', blank.entered, null);
  eq('and there is no multiple to report', blank.enteredMultiple, null);
  eq('the book projection follows the suggestion', blank.book.follows, 'suggested');

  const over = sizeTrade({ ...base, entered: 20 });
  eq('the entered size is kept', over.entered, 20);
  eq('and the gap named', over.enteredMultiple, 4);
  eq('with its own premium', over.enteredPremium, 23800);
  // THE BOOK FOLLOWS WHAT WAS TYPED. "What will I be holding if I do what I just typed" is the
  // question being asked at that moment; projecting the suggestion answers a different one.
  eq('the projection follows the entry', over.book.follows, 'entered');
  // 20 × 0.42 × 100 × 718 = $603,120 of delta-notional on top of $80,800, against a $202,000 NLV.
  eq('to 3.39× at twenty', over.book.after, 3.39);
  // AND THE SUGGESTION STAYS VISIBLE BESIDE IT rather than being replaced.
  eq('the suggested projection is kept too', over.book.atSuggested, 1.15);
  eq('the suggested size is untouched by the override', over.size, blank.size);

  // TYPING THE SUGGESTED SIZE IS 1×, and is not flagged.
  eq('following the rule is 1x', sizeTrade({ ...base, entered: 5 }).enteredMultiple, 1);
  // UNDER-SIZING IS REPORTED TOO — the gap runs both ways and only one direction is a risk.
  eq('half the suggestion is 0.4x', sizeTrade({ ...base, entered: 2 }).enteredMultiple, 0.4);
  // NOTHING IS REFUSED AT ANY SIZE. This is the whole principle in one assertion.
  const absurd = sizeTrade({ ...base, entered: 5000 });
  eq('an absurd entry still computes', absurd.ok, true);
  eq('and still returns the rule\'s size', absurd.size, 5);
  ok('while saying where the book lands', absurd.pastCeiling === true);
  eq('junk in the field is ignored, not fatal', sizeTrade({ ...base, entered: 'abc' }).entered, null);
  eq('and so is a negative', sizeTrade({ ...base, entered: -5 }).entered, null);
}

// ── THE LOG CARRIES BOTH NUMBERS, AND THE CATALYST STATE ────────────────────
{
  const cal = [{ date: '2026-10-14', title: 'US CPI (Sep)', tier: 1 }];
  const r = sizeTrade({ kind: 'option', symbol: 'QQQ 730C', price: 718, atr: 8.5, delta: 0.42,
    mark: 11.9, expiry: '2026-10-16', nlv: NLV, bookDeltaNotional: 80800, catalysts: cal,
    entered: 20, now: NOW });
  const run = sizerRun(r, { at: '2026-09-11T13:45:00Z' });
  eq('the run records what was suggested', run.size, 5);
  eq('and what was entered', run.entered, 20);
  eq('and the multiple', run.enteredMultiple, 4);
  eq('and where the book landed', [run.bookBefore, run.bookAfter], [0.4, 3.39]);
  // RECORDED, NOT ACTED ON. The run says the ceiling was passed and the size stands.
  eq('and that the ceiling was passed', run.pastCeiling, true);
  // NOT CHECKED and CHECKED-AND-EMPTY are different facts about a trade and collapse into each
  // other if only one is stored.
  eq('the catalyst state is recorded', [run.catalyst.checked, run.catalyst.none], [true, false]);
  eq('with the event named', run.catalyst.first, 'US CPI (Sep)');
  const none = sizerRun(sizeTrade({ kind: 'option', symbol: 'QQQ 730C', price: 718, atr: 8.5, delta: 0.42, mark: 11.9,
    expiry: '2026-10-16', nlv: NLV, now: NOW }), { at: '2026-09-11T13:45:00Z' });
  eq('an unchecked calendar is recorded as unchecked', none.catalyst.checked, false);
}

// ── A ROLLING MONTHLY STAT, WHICH IS WHERE THE DISCIPLINE LIVES ─────────────
// An all-time mean flattens the thing worth seeing. A number on screen at the moment of entry does
// not stop a decision taken with conviction; reading a month later that actual exceeded suggested
// on 6 of 19 trades is legible in a way the moment never is — and it works BECAUSE it did not
// intervene. An occasional override is the system working; a pattern is what this is for.
{
  const run = (at, symbol, size) => ({ at, symbol, size });
  const runs = [run('2026-08-04T14:00:00Z', 'QQQ', 5), run('2026-08-19T14:00:00Z', 'SPY', 10),
                run('2026-09-02T14:00:00Z', 'QQQ', 5), run('2026-09-11T14:00:00Z', 'AAPU', 100)];
  const fills = [{ symbol: 'QQQ', qty: 20, at: '2026-08-04T15:00:00Z' },
                 { symbol: 'SPY', qty: 10, at: '2026-08-19T15:00:00Z' },
                 { symbol: 'QQQ', qty: 5, at: '2026-09-02T15:00:00Z' },
                 { symbol: 'AAPU', qty: 300, at: '2026-09-11T15:00:00Z' }];
  const rec = reconcileRuns(runs, fills);
  eq('every month present is bucketed', rec.byMonth.map(m => m.month), ['2026-09', '2026-08']);
  eq('newest first, so the current month reads at the top', rec.thisMonth.month, '2026-09');
  eq('with its own count', [rec.thisMonth.taken, rec.thisMonth.exceeded], [2, 1]);
  eq('and its own mean, not the all-time one', rec.thisMonth.meanRatio, 2);
  ok('the all-time mean differs, which is the point', rec.meanRatio !== rec.thisMonth.meanRatio);
  ok('each month says it in a sentence', /exceeded suggested on 1 of 2/.test(rec.thisMonth.note));
  // A month where the rule was followed throughout reports zero, not nothing.
  const clean = reconcileRuns([run('2026-07-01T14:00:00Z', 'X', 10)],
                              [{ symbol: 'X', qty: 10, at: '2026-07-01T15:00:00Z' }]);
  eq('a followed month counts the follow', [clean.thisMonth.exceeded, clean.thisMonth.followed], [0, 1]);
  eq('and nothing matched means no months', reconcileRuns([run('2026-07-01T14:00:00Z', 'X', 10)], []).byMonth, []);
}

// ── THE SINGLE-NAME CAP, ON EXPOSURE — TWO LEGS, EACH ON ITS OWN ─────────────
// The premium cap sees what an option costs, not what it controls. The brief's live cases at NLV
// $206,358 (cap $20,636). Shares and options in the same root are tested SEPARATELY: they are held
// for different reasons and answer a drawdown in opposite ways, and one number hides which leg the
// flag is about. Broad index ETFs (QQQ, SPY) are computed, shown, and never flagged.
{
  const N = 206358;
  const near = (n, g, w, tol) => ok(`${n} (${g} ≈ ${w})`, g != null && Math.abs(g - w) <= tol);
  // XLE Jan15'27 55C ×5 at 64.40, delta 0.90: $28,980, 14.0%, amber — a sector ETF keeps the cap.
  const xle = sizeTrade({ kind: 'option', symbol: 'XLE 2027-01-15 C55', price: 64.40, atr: 1.2, delta: 0.90, mark: 10.4,
    expiry: '2027-01-15', nlv: N, entered: 5, underlyingShares: 0, underlyingOptions: 0, now: NOW });
  near('XLE ×5 carries $28,980 of delta-notional in options', xle.singleName.options.total, 28980, 1);
  eq('…14.0% of NLV, past the cap, not exempt', [xle.singleName.pct, xle.singleName.past, xle.singleName.exempt, xle.singleName.cap], [14.0, true, false, 20635.8]);
  eq('…as 450 shares', xle.singleName.shareEquivalent, 450);
  eq('…the shares leg is empty and clear', [xle.singleName.shares.total, xle.singleName.shares.past], [0, false]);
  ok('…and the warning names the leg and the number', xle.warnings.some(w => /options would carry \$28,980/.test(w) && /14% of NLV/.test(w) && /single-name cap/.test(w)));
  ok('…while the size stands', xle.size != null && xle.ok);
  // INTC Oct02'26 115C ×6 at 110.90, delta 0.42, with 30 shares held: TWO LINES.
  const intc = sizeTrade({ kind: 'option', symbol: 'INTC 2026-10-02 C115', price: 110.90, atr: 3.1, delta: 0.42, mark: 3.7,
    expiry: '2026-10-02', nlv: N, entered: 6, underlyingShares: 30 * 110.90, underlyingOptions: 0, now: NOW });
  near('INTC options: ×6 is ~$27,900', intc.singleName.options.total, 27947, 1);
  eq('…13.5%, amber', [intc.singleName.options.pct, intc.singleName.options.past], [13.5, true]);
  eq('INTC shares: the 30 held, $3,327', [intc.singleName.shares.total, intc.singleName.shares.pct, intc.singleName.shares.past], [3327, 1.6, false]);
  eq('the flag is about the options leg', [intc.singleName.leg, intc.singleName.past, intc.singleName.pct], ['options', true, 13.5]);
  near('the combined figure is display only', intc.singleName.combined, 31274, 1);
  ok('…and the warning does not fold the shares in', intc.warnings.some(w => /options would carry \$27,947/.test(w)) && !intc.warnings.some(w => /31,27/.test(w)));
  // QQQ Oct16'26 730C ×3 at 718.66, delta 0.40: $86,240, 41.8% of NLV — shown, never flagged.
  const qqq = sizeTrade({ kind: 'option', symbol: 'QQQ 2026-10-16 C730', price: 718.66, atr: 8.5, delta: 0.40, mark: 7.56,
    expiry: '2026-10-16', nlv: N, entered: 3, underlyingShares: 0, underlyingOptions: 0, now: NOW });
  near('QQQ ×3 at 0.40 delta is $86,240', qqq.singleName.options.total, 86239, 2);
  eq('…41.8% of NLV, over the number, exempt, NOT flagged', [qqq.singleName.pct, qqq.singleName.over, qqq.singleName.exempt, qqq.singleName.past], [41.8, true, true, false]);
  ok('…no single-name warning', !qqq.warnings.some(w => /single-name cap/.test(w)));
  ok('…but a note says it is exempt and what governs', qqq.notes.some(n => /QQQ is on the index-ETF exempt list/.test(n) && /portfolio delta target governs/.test(n)));
  eq('SPY is exempt by default too; XLE, SMH, 7709 are not', [isExempt('SPY 2026-10-16 C650'), isExempt('XLE'), isExempt('SMH'), isExempt('7709')], [true, false, false, false]);
  eq('the list is editable', [isExempt('IWM', ['QQQ', 'SPY', 'iwm']), isExempt('QQQ', [])], [true, false]);
  const qqqStrict = sizeTrade({ kind: 'option', symbol: 'QQQ 2026-10-16 C730', price: 718.66, atr: 8.5, delta: 0.40, mark: 7.56,
    expiry: '2026-10-16', nlv: N, entered: 3, underlyingShares: 0, underlyingOptions: 0, exempt: [], now: NOW });
  eq('…and with QQQ off the list the same trade flags', qqqStrict.singleName.past, true);
  // Unknown book exposure is reported as unknown, not as zero.
  const unk = sizeTrade({ kind: 'option', symbol: 'XLE 2027-01-15 C55', price: 64.40, atr: 1.2, delta: 0.90, mark: 10.4,
    expiry: '2027-01-15', nlv: N, entered: 5, now: NOW });
  eq('with no book, held is unknown and the added leg is still tested', [unk.singleName.known, unk.singleName.options.held, unk.singleName.shares.total, unk.singleName.past], [false, null, null, true]);
  const unp = sizeTrade({ kind: 'option', symbol: 'XLE 2027-01-15 C55', price: 64.40, atr: 1.2, delta: 0.90, mark: 10.4,
    expiry: '2027-01-15', nlv: N, entered: 1, underlyingUnpriced: 2, now: NOW });
  ok('unpriced lines in the name are named', unp.notes.some(n => /2 lines in this name could not be priced/.test(n)));
  // The delta source travels: exchange by default, modelled when said so, and the note says it.
  eq('exchange by default', xle.singleName.deltaSource, 'exchange');
  const mod = sizeTrade({ kind: 'option', symbol: 'XLE 2027-01-15 C55', price: 64.40, atr: 1.2, delta: 0.90, mark: 10.4,
    expiry: '2027-01-15', nlv: N, deltaSource: 'modelled', now: NOW });
  eq('modelled when the caller says so', mod.singleName.deltaSource, 'modelled');
  ok('…and it is never silent', mod.notes.some(n => /delta is modelled/.test(n)));
  // A stock trade is the shares leg; options already held in the name are the other leg, noted.
  const stk = sizeTrade({ kind: 'stock', symbol: 'INTC', price: 110.90, atr: 3.1, nlv: N, entered: 100, underlyingShares: 3327, underlyingOptions: 27947, now: NOW });
  near('100 INTC shares on top of 30', stk.singleName.shares.total, 14417, 1);
  eq('…the shares leg is clear', [stk.singleName.leg, stk.singleName.past, stk.singleName.deltaSource], ['shares', false, 'shares']);
  ok('…and the options already over the cap are noted, not folded in', stk.notes.some(n => /INTC options already held carry \$27,947/.test(n)));
  // The run carries it and the month counts it, exempt lines apart.
  const run = sizerRun(xle, { at: '2026-09-17T14:00:00Z' });
  eq('the run records the traded leg, both legs, and the exempt flag',
     [run.singleName.underlying_exposure, run.singleName.single_name_pct, run.singleName.leg, run.singleName.delta_source, run.singleName.past_cap, run.singleName.etf_exempt],
     [28980, 14.0, 'options', 'exchange', true, false]);
  eq('an exempt run says so', [sizerRun(qqq).singleName.etf_exempt, sizerRun(qqq).singleName.past_cap, sizerRun(qqq).singleName.over_cap], [true, false, true]);
  const runs = [run, sizerRun(qqq, { at: '2026-09-15T14:00:00Z' }), sizerRun(intc, { at: '2026-09-16T14:00:00Z' }),
                sizerRun(mod, { at: '2026-09-14T14:00:00Z' }), sizerRun(stk, { at: '2026-09-14T15:00:00Z' }),
                sizerRun(xle, { at: '2026-07-01T14:00:00Z' })];
  const rv = capReview(runs, { now: new Date('2026-09-17T16:00:00Z') });
  // The modelled XLE run typed no count, so its suggestion now follows the cap and is clear; the
  // two that typed a count above the cap's are the two the month counts.
  eq('the month counts option entries, exempt ones apart', [rv.n, rv.counted, rv.past, rv.exempt, rv.modelled], [4, 3, 2, 1, 1]);
  eq('and says so, with what governed and how often the typed count went past the cap\'s', rv.note,
     '2 of 3 option entries in 30d exceeded the single-name cap on delta-notional · 2 entered above the cap\'s count · governing test: cap 3 / atr 1 · 1 on exempt index ETFs, not counted · 1 on a modelled delta');
  eq('the distribution is on the object too', [rv.governing, rv.enteredOverCap], [{ cap: 3, atr: 1 }, 2]);
  eq('nothing yet is silent', capReview([], { now: NOW }).note, null);
}

// ── A FUTURE IS A CONTRACT, NOT A SHARE ──────────────────────────────────────
// 22 Sep 2026: CL=F typed as a Stock sized "229 shares" — 229 barrels. The brief's table, at NLV
// $212,000: risk $2,120, cap $21,200.
{
  const N = 212000, NOW2 = new Date('2026-09-22T14:00:00Z');
  const near = (n, g, w, tol) => ok(`${n} (${g} ≈ ${w})`, g != null && Math.abs(g - w) <= tol);
  const nov = { label: 'Nov-26', code: 'CLX26', y: 2026, m: 11, price: 92.27, lastTrade: '2026-10-20', days: 28, rollBy: '2026-10-15' };
  const dec = { label: 'Dec-26', code: 'CLZ26', y: 2026, m: 12, price: 89.04, lastTrade: '2026-11-20', days: 59, rollBy: '2026-11-17' };
  const r = sizeFuture({ family: 'CL=F', month: dec, front: nov, price: 89.04, atr: 4.57, nlv: N, now: NOW2, underlyingShares: 0, underlyingOptions: 0 });
  eq('CL Dec-26: ATR 0, cap 0 — below one contract', [r.main.tests.map(t => t.size), r.main.size, r.belowOne], [[0, 0], 0, true]);
  ok('…and says so with the numbers', r.main.warnings.some(w => /CL: below one contract/.test(w) && /\$89,040/.test(w) && /\$4,570 per ATR/.test(w)));
  eq('MCL re-run: ATR 4, cap 2 → 2 MCL', [r.micro.tests.map(t => t.size), r.micro.size, r.microUsed, r.chosen.symbol], [[4, 2], 2, true, 'MCL Dec-26']);
  eq('…$17,808 of notional, 8.4% of NLV, under the cap', [r.notional, r.chosen.singleName.pct, r.chosen.singleName.past], [17808, 8.4, false]);
  eq('the concentration cap binds the micro', r.micro.binding, 'Concentration cap (10%)');
  eq('term structure: Nov over Dec, backwardation, −$3.23, −3.5%/mo', [r.term.spread, r.term.pctPerMonth, r.term.shape], [-3.23, -3.5, 'backwardation']);
  ok('…written with the sign and the carry', /−\$3\.23 \(−3\.5%\/mo\) backwardation/.test(r.term.text) && /long earns convergence/.test(r.term.carry));
  eq('gap test at 2 MCL: a 10% day is $1,781', [r.gap.ten.usd, r.gap.ten.pctNlv, r.gap.five.usd], [1780.8, 0.84, 890.4]);
  ok('roll: 20 Nov, physical, roll by 17 Nov', r.roll.lastTrade === '2026-11-20' && r.roll.physical && r.roll.rollBy === '2026-11-17' && !r.roll.amber);
  ok('the micro is explained', r.notes.some(n => /micro MCL \(100 bbl\) is shown instead/.test(n)));
  // The run carries the future's record, keyed by the family that was sized.
  const run = sizerRun(r.chosen, { at: '2026-09-22T14:05:00Z', future: r });
  eq('the run is keyed by the micro family', run.symbol, 'MCL');
  eq('and records the contract, the month, the multiplier and the lines',
     [run.future.family, run.future.parent, run.future.contract_month, run.future.last_trade_date, run.future.multiplier, run.future.contracts_suggested, run.future.micro_used, run.future.term_spread_usd, run.future.gap_10pct_usd, run.future.atr_source, run.future.physical],
     ['MCL', 'CL', 'Dec-26', '2026-11-20', 100, 2, true, -3.23, 1780.8, 'realised', true]);
  // Six days to last trade: amber, still sized.
  const soon = sizeFuture({ family: 'MCL', month: { ...dec, lastTrade: '2026-09-28', days: 6, rollBy: '2026-09-23' }, price: 89.04, atr: 4.57, nlv: N, now: NOW2 });
  ok('six days out: the roll line is amber and the size stands', soon.roll.amber && soon.main.size === 2);
  // MNQ at 30,227 × 2 = $60,454 a contract, 28.5% of NLV: index-exempt, the ATR test governs.
  // ATR 700 × 2 = $1,400 a contract against a $2,120 budget: the ATR test gives one.
  const nq = sizeFuture({ family: 'MNQ', month: { label: 'Dec-26', code: 'MNQZ26', y: 2026, m: 12, price: 30227, lastTrade: '2026-12-18', days: 87, rollBy: null }, price: 30227, atr: 700, nlv: N, now: NOW2, underlyingShares: 0, underlyingOptions: 0 });
  eq('MNQ: the cap is shown and does not govern; the ATR test gives 1', [nq.main.tests.find(t => /Concentration/.test(t.name)).exempt, nq.main.tests.find(t => /Concentration/.test(t.name)).size, nq.main.binding, nq.main.size], [true, 0, 'ATR test', 1]);
  near('…$60,454 of notional for one contract', nq.notional, 60454, 1);
  eq('…28.5% of NLV, exempt, not flagged', [nq.chosen.singleName.pct, nq.chosen.singleName.exempt, nq.chosen.singleName.past], [28.5, true, false]);
  ok('…and cash-settled on the roll line', /cash-settled/.test(nq.roll.text));
  const nqBig = sizeFuture({ family: 'MNQ', price: 30227, atr: 1200, nlv: N, now: NOW2 });
  ok('MNQ with the ATR test below one: no micro exists, and it says so', nqBig.belowOne && nqBig.noMicro && nqBig.notes.some(n => /no micro exists/.test(n)));
  // Refusals: a spread, an unknown family.
  ok('a calendar spread is refused, not sized one leg at a time', /spreads not supported yet/.test(sizeFuture({ family: 'COIL Z6-Z7', price: 80, atr: 2, nlv: N }).why));
  ok('an unknown family asks for a multiplier and never assumes one', /set the contract multiplier for ZZZ/.test(sizeFuture({ family: 'ZZZ', price: 80, atr: 2, nlv: N }).why));
  eq('…and sizes once given one', sizeFuture({ family: 'ZZZ', multiplier: 10, price: 80, atr: 2, nlv: N }).main.size, 26);
  // Aggregation: MCL held counts against CL's cap, and the futures leg is the linear leg.
  const agg = sizeFuture({ family: 'MCL', month: dec, price: 89.04, atr: 4.57, nlv: N, now: NOW2, underlyingShares: 17808, underlyingOptions: 0, entered: 1 });
  eq('one more MCL on top of two held: $26,712, 12.6%, past the cap', [agg.chosen.singleName.shares.total, agg.chosen.singleName.pct, agg.chosen.singleName.past, agg.chosen.singleName.root], [26712, 12.6, true, 'CL']);
  // Stocks and options are untouched.
  eq('a stock still sizes in shares with no multiplier', sizeTrade({ kind: 'stock', symbol: 'INTC', price: 110.9, atr: 3.1, nlv: N, now: NOW2 }).multiplier, null);
  // The monthly line.
  const fills = [{ symbol: 'MCL', qty: 3, at: '2026-09-22T15:00:00Z' }];
  const recon = reconcileRuns([run], fills);
  eq('a 3-lot fill against a 2-lot suggestion is 1 of 1 exceeded', [futuresReview(recon, { now: new Date('2026-09-23T00:00:00Z') }).note], ['1 of 1 futures entry in 30d exceeded the suggested contract count']);
  eq('no futures runs, no line', futuresReview(reconcileRuns([], [])).note, null);
}

// ── A LEVERAGED ETF'S EXPOSURE IS ITS COST TIMES ITS FACTOR ──────────────────
// 22 Sep 2026: TQQQ as a Stock sized 291 shares — $21k of cost, $64k of index delta, through
// the 1.5× ceiling with a tick. NLV $220,000: cap $22,000, target 1.0×, ceiling 1.5×.
{
  const N = 220000, NOW3 = new Date('2026-09-22T14:00:00Z');
  const base = { kind: 'stock', price: 73, atr: 2.9, nlv: N, underlying: 'QQQ', underlyingPrice: 729, reset: 'daily', underlyingShares: 0, underlyingOptions: 0, now: NOW3 };
  const t = sizeTrade({ ...base, symbol: 'TQQQ', leverage: 3, bookDeltaNotional: 1.38 * N });
  eq('TQQQ: the cap divides by price × 3 and governs — 100 shares', [t.tests[1].size, t.tests[1].detail, t.binding, t.size], [100, '$22,000 ÷ ($73.00 × 3)', 'Concentration cap (10%)', 100]);
  eq('…cost $7,300, delta-notional $21,900, ≈ 30 QQQ shares of delta', [t.leverage.cost, t.leverage.deltaNotional, t.leverage.underlyingShares], [7300, 21900, 30]);
  eq('…book 1.38× → 1.48×, inside the ceiling', [t.book.before, t.book.after, t.pastCeiling], [1.38, 1.48, false]);
  eq('…a swing trade by default, with the daily-reset note', [t.bucket.used, t.bucket.byDefault, t.leverage.reset], ['swing', 'swing', 'daily']);
  ok('…', t.notes.some(n => /daily reset — path-dependent/.test(n) && /sized as a trade, not a position/.test(n)));
  // The old suggestion, entered: the panel says what it is and still does not block.
  const t291 = sizeTrade({ ...base, symbol: 'TQQQ', leverage: 3, bookDeltaNotional: 1.38 * N, entered: 291 });
  eq('291 TQQQ: $63,729 of delta-notional, 29% of NLV, above the cap', [t291.leverage.deltaNotional, t291.singleName.pct, t291.singleName.past], [63729, 29, true]);
  eq('…and the book goes to 1.67×, past the ceiling — reported, not refused', [t291.book.after, t291.pastCeiling, t291.ok, t291.size], [1.67, true, true, 100]);
  // The inverse: negative delta, the book goes DOWN, and the hedge line says what reaches target.
  const sq = sizeTrade({ ...base, symbol: 'SQQQ', price: 13, atr: 0.6, leverage: -3, bookDeltaNotional: 1.38 * N });
  ok('SQQQ moves the book down', sq.perUnitDelta < 0 && sq.book.after < sq.book.before);
  eq('…to bring the book from 1.38× to 1.0×: $83,600 of SQQQ, 2,143 shares', [sq.leverage.hedgeToTarget.fromX, sq.leverage.hedgeToTarget.toX, sq.leverage.hedgeToTarget.usd, sq.leverage.hedgeToTarget.shares], [1.38, 1, 83600, 2143]);
  ok('…with the drag note', sq.notes.some(n => /volatility drag/.test(n) && /QQQ puts/.test(n)));
  // QQQ itself: leverage 1, exempt, untouched.
  const q = sizeTrade({ ...base, symbol: 'QQQ', price: 729, atr: 9.3, leverage: 1, underlying: null, bookDeltaNotional: 0 });
  eq('QQQ is unchanged: factor 1, position book, no note', [q.leverage.factor, q.bucket.used, q.tests[1].detail, q.notes.some(n => /daily reset/.test(n))], [1, 'position', '$22,000 ÷ $729.00', false]);
  // An unknown ticker that reads leveraged: sized at 1 with the prompt.
  const x = sizeTrade({ ...base, symbol: 'XYZL', price: 20, atr: 1, name: 'XYZ 2X Daily Bull', leverage: null, underlying: null });
  eq('an unknown leveraged-looking name is sized at 1 and asked about', [x.leverage.factor, x.leverage.looksLeveraged], [1, true]);
  ok('…', x.notes.some(n => /looks leveraged/.test(n) && /set the factor/.test(n)));
  // A derived ATR is labelled.
  const d = sizeTrade({ ...base, symbol: 'SOXL', price: 40, atr: 2.4, leverage: 3, underlying: 'SOXX', underlyingPrice: 260, atrSource: 'derived' });
  ok('a derived ATR is labelled on the test', /derived: underlying ATR × \|factor\|/.test(d.tests[0].detail) && d.leverage.atrSource === 'derived');
  // The swing bucket: over, and compliant.
  const over = sizeTrade({ ...base, symbol: 'TQQQ', leverage: 3, bookDeltaNotional: 1.38 * N, positionBookUsd: 1.38 * N, swingUsedUsd: 0 });
  eq('position book at 1.38×: swing room −$39,600, the trade sizes to 0 in swing', [over.bucket.room.roomUsd, over.bucket.fit, over.size, over.binding], [-39600, 0, 0, 'Swing room (0.3× reserved)']);
  ok('…with the message, and no block', over.ok && over.warnings.some(w => /position book is using it/.test(w) && /cannot be sized into swing until the position book is ≤ 1\.2×/.test(w)));
  const fine = sizeTrade({ ...base, symbol: 'TQQQ', leverage: 3, bookDeltaNotional: 1.18 * N, positionBookUsd: 1.18 * N, swingUsedUsd: 0 });
  eq('position book at 1.18×: $66,000 of room, 301 TQQQ would fit, the cap still governs at 100', [fine.bucket.room.roomUsd, fine.bucket.fit, fine.size, fine.binding], [66000, 301, 100, 'Concentration cap (10%)']);
  const mnqUsed = sizeTrade({ ...base, symbol: 'TQQQ', leverage: 3, bookDeltaNotional: 1.18 * N + 60454, positionBookUsd: 1.18 * N, swingUsedUsd: 60454 });
  eq('one MNQ overnight uses $60,454 of the room: $5,546 left, 25 TQQQ', [mnqUsed.bucket.room.roomUsd, mnqUsed.bucket.fit, mnqUsed.size], [5546, 25, 25]);
  const held = sizeTrade({ ...base, symbol: 'TQQQ', leverage: 3, bookDeltaNotional: 1.38 * N, positionBookUsd: 1.38 * N, swingUsedUsd: 0, holdBeyond: true });
  eq('a hold-beyond-3-sessions intent moves it to the position book, where the room test does not apply', [held.bucket.used, held.bucket.fit, held.size], ['position', null, 100]);
  // The run carries the read, and the month counts it.
  const run = sizerRun(t291, { at: '2026-09-22T14:05:00Z' });
  eq('the run records the factor, the signed exposure, the underlying shares, the reset and the bucket', [run.leverage.leverage_factor, run.leverage.delta_notional_signed, run.leverage.underlying_equiv_shares, run.leverage.reset, run.bucket], [3, 63729, 87, 'daily', 'swing']);
  const rv = leveragedReview([run, sizerRun(sq, { at: '2026-09-20T14:00:00Z' }), sizerRun(q, { at: '2026-09-21T14:00:00Z' })],
    [{ symbol: 'TQQQ', firstDate: '2026-09-22', lastDate: '2026-09-24' }, { symbol: 'SQQQ', firstDate: '2026-09-20', lastDate: null }], { now: new Date('2026-09-25T00:00:00Z') });
  eq('the month: 2 leveraged entries, 1 over the cap, average hold measured in sessions (3 and 6)', [rv.n, rv.exceeded, rv.measured, rv.avgHold], [2, 1, 2, 4.5]);
  ok('…and says so', /2 leveraged-ETF entries in 30d; 1 exceeded the cap on delta-notional; average hold 4\.5 sessions/.test(rv.note));
  eq('nothing yet is silent', leveragedReview([], []).note, null);
}

// ── THE CAP GOVERNS THE COUNT (24 Sep brief) ────────────────────────────────
// NLV ~$211,000: single-name cap $21,100, premium cap $6,330, risk budget $2,110. The suggestion
// is the floor of the minimum of three tests, all printed; for an exempt index ETF the cap is
// shown and does not govern. Numbers from the live SOFI chain of 24 Sep, not estimates.
{
  const N = 211000;
  const base = { kind: 'option', nlv: N, now: NOW, underlyingShares: 0, underlyingOptions: 0 };
  const t = (r, re) => r.tests.find(x => re.test(x.name));
  // SOFI Nov20 18C · delta 0.42 · mark 0.97 · ATR $0.50
  const sofi = sizeTrade({ ...base, symbol: 'SOFI 2026-11-20 C18', price: 16.72, atr: 0.50, delta: 0.42, mark: 0.97, expiry: '2026-11-20' });
  eq('ATR test 100', t(sofi, /^ATR/).size, 100);
  eq('premium cap 65', t(sofi, /^Premium/).size, 65);
  eq('delta-notional cap 30, with its arithmetic', [t(sofi, /^Delta-notional/).size, t(sofi, /^Delta-notional/).detail], [30, '$21,100 ÷ $702 per contract']);
  eq('the cap governs: 30 contracts, not 65', [sofi.size, sofi.binding], [30, 'Delta-notional cap (10%)']);
  eq('all three are printed', sofi.tests.length, 3);
  eq('premium $2,910', sofi.premium, 2910);
  ok('delta-notional ≈ $21,060, 10.0% of NLV', Math.abs(sofi.deltaAdded - 21067) < 10 && Math.abs(sofi.singleName.pct - 10) < 0.1);
  eq('≈ 1,260 SOFI shares', sofi.singleName.addedShareEquivalent, 1260);
  eq('the counts and the governing test are on the result', sofi.optionCounts, { atr: 100, premium: 65, cap: 30, governing: 'cap', capExempt: false });
  // SOFI Nov20 20C · delta 0.25 · mark 0.50 → cap 50, premium 126, ATR 168 → 50, and the delta floor note.
  const c20 = sizeTrade({ ...base, symbol: 'SOFI 2026-11-20 C20', price: 16.72, atr: 0.50, delta: 0.25, mark: 0.50, expiry: '2026-11-20' });
  eq('20C: cap 50 / premium 126 / ATR 168 → 50', [t(c20, /^Delta-notional/).size, t(c20, /^Premium/).size, t(c20, /^ATR/).size, c20.size], [50, 126, 168, 50]);
  ok('…and the panel notes the delta is below the 0.35 entry floor, as information', c20.notes.some(n => /delta 0\.25 is below the 0\.35 entry floor — info/.test(n)) && !c20.warnings.some(w => /entry floor/.test(w)));
  // SOFI Nov20 18/22 call spread · net delta 0.20 · net debit 0.70 → cap 63, premium 90, ATR 211 → 63.
  const sp = sizeTrade({ ...base, symbol: 'SOFI 2026-11-20 C18/C22', price: 16.72, atr: 0.50, delta: 0.20, mark: 0.70, expiry: '2026-11-20' });
  eq('spread: cap 63 / premium 90 / ATR 211 → 63, delta the net of the legs', [t(sp, /^Delta-notional/).size, t(sp, /^Premium/).size, t(sp, /^ATR/).size, sp.size], [63, 90, 211, 63]);
  // QQQ Oct16 730C ×3 at 718.66, delta 0.40: $86,240, 41.8%, exempt — the cap is shown and does not govern.
  const qqq = sizeTrade({ ...base, symbol: 'QQQ 2026-10-16 C730', price: 718.66, atr: 8.5, delta: 0.40, mark: 7.56, expiry: '2026-10-16', entered: 3 });
  eq('QQQ: the cap test is shown, exempt, and does not bind', [t(qqq, /^Delta-notional/).size, t(qqq, /^Delta-notional/).exempt, t(qqq, /^Delta-notional/).binds], [0, true, false]);
  ok('…the suggestion comes from the other two', ['atr', 'premium'].includes(qqq.optionCounts.governing) && qqq.size > 0);
  // 41.8% was at the brief's earlier NLV of $206,358; at $211,000 the same $86,240 is 40.9%.
  ok('…$86,240, 40.9% of this NLV, no flag', Math.abs(qqq.singleName.options.total - 86239) < 3 && qqq.singleName.pct === 40.9 && !qqq.singleName.past && qqq.singleName.exempt);
  // XLE Jan27 55C ×5, delta 0.90 → $28,980 (13.7%) ⚠, and the cap now says 3.
  const xle = sizeTrade({ ...base, symbol: 'XLE 2027-01-15 C55', price: 64.40, atr: 1.2, delta: 0.90, mark: 10.4, expiry: '2027-01-15', entered: 5 });
  eq('XLE: the cap allows 3; 5 were entered', [t(xle, /^Delta-notional/).size, xle.size, xle.entered], [3, 3, 5]);
  ok('…$28,980 at 13.7%, amber — a sector ETF keeps the cap', Math.abs(xle.singleName.options.total - 28980) < 1 && xle.singleName.pct === 13.7 && xle.singleName.past);
  // The log carries the three counts, what governed, the delta source and the exemption.
  const run = sizerRun(xle, { at: '2026-09-24T14:00:00Z' });
  eq('the run\'s fields', [run.atr_contracts, run.premium_contracts, run.cap_contracts, run.governing_test, run.delta_source, run.etf_exempt], [19, 6, 3, 'cap', 'exchange', false]);
  eq('an exempt run says so', [sizerRun(qqq).etf_exempt, sizerRun(qqq).governing_test !== 'cap'], [true, true]);
  // A 0DTE contract keeps its own rule set: no delta-notional test, no counts.
  const z = sizeTrade({ ...base, symbol: 'SPY 0DTE', price: 759, atr: 6.2, delta: 0.40, mark: 2.5, expiry: NOW.toISOString().slice(0, 10) });
  eq('0DTE has no cap test and no counts', [z.tests.some(x => /^Delta-notional/.test(x.name)), z.optionCounts], [false, null]);
  // No price: the cap test is unscored and says why; the other two still size.
  const np = sizeTrade({ ...base, symbol: 'SOFI 2026-11-20 C18', atr: 0.50, delta: 0.42, mark: 0.97, expiry: '2026-11-20' });
  eq('no price: the cap is unscored, named', [t(np, /^Delta-notional/).size, t(np, /^Delta-notional/).detail, np.size], [null, 'no price', 65]);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
