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
  eq('and it is not blocked', r.blocked, false);
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

// ── BLOCK, DO NOT WARN ──────────────────────────────────────────────────────
// The one thing this must not do is compute a clean number for a trade the book cannot carry.
{
  const r = sizeTrade({ kind: 'option', symbol: 'QQQ 730C', price: 718, atr: 8.5, delta: 0.42,
    mark: 11.90, expiry: '2026-10-16', nlv: NLV, bookDeltaNotional: 250000, now: NOW });
  eq('the trade is blocked', r.blocked, true);
  eq('the size that would fit is shown instead', r.fitSize, 1);
  ok('and the reason names the ceiling', r.warnings.some(w => /past the 1.5× ceiling/.test(w)));
  // The computed size is still returned — the reader is entitled to see what was refused.
  eq('the refused size is still visible', r.size, 5);
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
  ok('and the warning reaches the result', r.warnings.some(w => /no scheduled catalyst/.test(w)));
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
  ok('said in a sentence', /actual exceeded intended on 1 of 1/.test(rec.note));
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
  // A BLOCKED run is measured against what it OFFERED, not against what it refused.
  const blockedRun = sizerRun(sizeTrade({ kind: 'option', symbol: 'QQQ 730C', price: 718, atr: 8.5,
    delta: 0.42, mark: 11.9, expiry: '2026-10-16', nlv: NLV, bookDeltaNotional: 250000, now: NOW }),
    { at: '2026-09-01T13:45:00Z' });
  const vsBlocked = reconcileRuns([blockedRun], [{ symbol: 'QQQ 730C', qty: 5, at: '2026-09-01T14:00:00Z' }]);
  eq('a blocked run is measured against the size it offered', vsBlocked.worst.intended, 1);
  eq('so taking five against a fitting one is 5x', vsBlocked.worst.ratio, 5);
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
  // A blocked run offers the fitting size to that log, not the refused one.
  const b = sizeTrade({ kind: 'option', price: 718, atr: 8.5, delta: 0.42, mark: 11.9,
    expiry: '2026-10-16', nlv: NLV, bookDeltaNotional: 250000, now: NOW });
  eq('a blocked run recommends what fits', b.roomQty, 1);
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

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
