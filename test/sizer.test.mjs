// test/sizer.test.mjs — the size, before the trade.
import { sizeTrade, sizerRun, appendRun, reconcileRuns, catalystCheck, isZeroDteExpiry,
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
  const noDelta = sizeTrade({ kind: 'option', price: 718, atr: 8.5, mark: 11.9, expiry: '2026-10-16', nlv: NLV, now: NOW });
  ok('no delta is its own reason', /move per ATR is unknown/.test(noDelta.tests[0].detail));
}

// ── INDICATIVE, NOT BLANK ───────────────────────────────────────────────────
// Pre-open the greeks are the prior close. The size is still computed and marked.
{
  const r = sizeTrade({ kind: 'option', price: 718, atr: 8.5, delta: 0.42, mark: 11.9,
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
  const r = sizeTrade({ kind: 'option', price: 718, atr: 8.5, delta: 0.42, mark: 11.9,
    expiry: '2026-09-12', nlv: NLV, catalysts: cal, now: NOW });
  // A FLAG, NOT A STOP. The prior design proposed making this a required input; it is optional in
  // every sense, and an expiry with nothing scheduled is reported as a NOTE rather than a warning
  // because it is a fact about the calendar, not a fault in the trade.
  ok('and it reaches the result', r.notes.some(w => /no scheduled catalyst/.test(w)));
  ok('without becoming a warning', !r.warnings.some(w => /no scheduled catalyst/.test(w)));
  eq('and the size is computed regardless', r.size > 0, true);
  // NOTHING REQUIRES THE CALENDAR. Omitting it changes what is reported, never what is returned.
  const noCal = sizeTrade({ kind: 'option', price: 718, atr: 8.5, delta: 0.42, mark: 11.9,
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
  const r = sizeTrade({ kind: 'option', price: 718, atr: 8.5, delta: 0.42, mark: 11.9,
    expiry: '2026-10-16', nlv: NLV, now: NOW });
  eq('the suggestion carries the field the log reads', r.roomQty, 5);
  eq('and the full size beside it', r.fullQty, 5);
  ok('with a mode and a risk percentage', r.mode === 'option' && r.effPct === SIZER_LIMITS.riskPct);
  // ONE SIZE, AND IT IS THE RULE'S. `roomQty` used to become `fitSize` once the book was past the
  // ceiling, so the reconciliation measured an override against a number the ceiling had
  // substituted rather than against what the rule said.
  const b = sizeTrade({ kind: 'option', price: 718, atr: 8.5, delta: 0.42, mark: 11.9,
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
  const none = sizerRun(sizeTrade({ kind: 'option', price: 718, atr: 8.5, delta: 0.42, mark: 11.9,
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

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
