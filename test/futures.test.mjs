// test/futures.test.mjs — the contract sizes, and the promise that an unknown one stays unknown.
import { FUTURES_MULTIPLIER, futuresRoot, multiplierFor, backfillMultipliers, EQUITY_AMBIGUOUS, isUnambiguousFuture } from '../lib/futures.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}`); } };
const eq = (name, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}  got ${g} want ${w}`); } };

// ── THE ROW THAT STARTED IT ─────────────────────────────────────────────────
// MGC 2026-08-31 -> 09-01, 2 lots, 4506.40 -> 4385.40. The archive posted -$242.00.
{
  const move = 4385.40 - 4506.40, qty = 2;
  eq('at x1, the figure that was published', +(move * qty).toFixed(2), -242);
  eq('at the real contract size', +(move * qty * FUTURES_MULTIPLIER.MGC).toFixed(2), -2420);
  // The percentage is multiplier-free, which is exactly why nothing looked wrong.
  eq('and the percentage is the same either way', +((move / 4506.40) * 100).toFixed(2), -2.69);
  // The row below it in the same archive, which carried its multiplier and was right.
  eq('the neighbouring row proves the table', +((4526.30 - 4478.8046) * 1 * FUTURES_MULTIPLIER.MGC).toFixed(2), 474.95);
}

// ── ROOTS ───────────────────────────────────────────────────────────────────
{
  eq('a bare root is itself', futuresRoot('MGC'), 'MGC');
  eq('an IBKR contract code is stripped', futuresRoot('MGCZ6'), 'MGC');
  eq('a four-digit year too', futuresRoot('MNQU26'), 'MNQ');
  eq('a Yahoo suffix is stripped', futuresRoot('MGCZ26=F'), 'MGC');
  eq('and a bare Yahoo root', futuresRoot('GC=F'), 'GC');
  eq('lower case is fine', futuresRoot('mgcz6'), 'MGC');
  // THE TRAP: SIL ends in a letter that is a month code plus... nothing. And more dangerously,
  // stripping by shape alone would turn a real root into a different real root.
  eq('SIL is silver, not SI plus noise', futuresRoot('SIL'), 'SIL');
  eq('and keeps its own contract size', multiplierFor('SIL', { margined: true }).multiplier, 1000);
  eq('which is not silver’s', FUTURES_MULTIPLIER.SI, 5000);
  eq('an equity ticker is left alone', futuresRoot('NVDA'), 'NVDA');
  eq('empty in, empty out', futuresRoot(null), '');
}

// ── WHERE THE ANSWER CAME FROM ──────────────────────────────────────────────
{
  eq('the table answers a known root', multiplierFor('MGC', { margined: true }),
    { multiplier: 10, source: 'table', root: 'MGC' });
  eq('a share is 1 because it IS 1, not because nothing was found', multiplierFor('NVDA'),
    { multiplier: 1, source: 'shares', root: 'NVDA' });
  // The whole point: an unknown contract must not come back as 1.
  const unknown = multiplierFor('ZC', { margined: true });
  eq('an unknown contract returns null', unknown.multiplier, null);
  eq('and says so', unknown.source, 'unknown');
  ok('it is emphatically not 1', unknown.multiplier !== 1);
  // Grains and FX are left out deliberately — the units are ambiguous, so no answer beats a guess.
  for (const sym of ['ZC', 'ZS', 'ZW', '6E', '6J']) {
    ok(`${sym} is deliberately absent rather than guessed`, multiplierFor(sym, { margined: true }).source === 'unknown');
  }
}

// ── THE BROKER OUTRANKS THE TABLE, BUT A CLASH IS NAMED ─────────────────────
{
  const stated = multiplierFor('MGC', { stated: 10, margined: true });
  eq('a stated figure is used', stated.multiplier, 10);
  eq('and marked as the broker’s', stated.source, 'statement');
  ok('agreement is silent', !stated.disagrees);
  const clash = multiplierFor('MGC', { stated: 100, margined: true });
  eq('a clash still takes the broker’s number', clash.multiplier, 100);
  eq('and reports both', clash.disagrees, { table: 10, stated: 100 });
  // A zero or nonsense statement figure is not a statement figure.
  eq('zero is not a multiplier', multiplierFor('MGC', { stated: 0, margined: true }).source, 'table');
  eq('nor is a negative one', multiplierFor('MGC', { stated: -5, margined: true }).source, 'table');
  eq('nor a string of letters', multiplierFor('MGC', { stated: 'x', margined: true }).source, 'table');
}

// ── THE TABLE ITSELF ────────────────────────────────────────────────────────
{
  // The two the project already asserted in prose, now asserted in code.
  eq('one MGC is ten ounces of gold', FUTURES_MULTIPLIER.MGC, 10);
  eq('one MNQ is two index points', FUTURES_MULTIPLIER.MNQ, 2);
  // Micros are a known fraction of their full-size parent. A typo in either shows up here.
  for (const [micro, full, ratio] of [['MES','ES',10], ['MNQ','NQ',10], ['MYM','YM',10], ['M2K','RTY',10],
                                      ['MGC','GC',10], ['MCL','CL',10], ['MNG','NG',10], ['MHG','HG',10]]) {
    eq(`${micro} is a tenth of ${full}`, FUTURES_MULTIPLIER[full] / FUTURES_MULTIPLIER[micro], ratio);
  }
  eq('silver’s micro is a fifth, not a tenth', FUTURES_MULTIPLIER.SI / FUTURES_MULTIPLIER.SIL, 5);
  ok('every entry is a positive number', Object.values(FUTURES_MULTIPLIER).every(v => Number.isFinite(v) && v > 0));
  ok('every key is a plain upper-case root', Object.keys(FUTURES_MULTIPLIER).every(k => /^[A-Z0-9]{1,5}$/.test(k)));
  // Round-tripping every key through the root parser must be the identity, or a lookup silently
  // resolves to a different contract.
  ok('no root rewrites to another', Object.keys(FUTURES_MULTIPLIER).every(k => futuresRoot(k) === k));
  eq('the table is frozen', Object.isFrozen(FUTURES_MULTIPLIER), true);
}

// ── THE BACKFILL ────────────────────────────────────────────────────────────
{
  const rows = [
    { id: 'mgc1', symbol: 'MGC', margined: true },                    // the broken one — no field
    { id: 'mgc2', symbol: 'MGC', margined: true, multiplier: 10 },    // already right
    { id: 'mnq',  symbol: 'MNQ', margined: true, multiplier: 1 },     // coerced to 1 at some point
    { id: 'met',  symbol: 'MET', multiplier: 1 },                     // MetLife, NOT micro ether
    { id: 'nvda', symbol: 'NVDA', multiplier: 1 },                    // a plain share
    { id: 'zc',   symbol: 'ZC', margined: true },                     // a contract nobody knows
  ];
  const out = backfillMultipliers(rows);
  const by = Object.fromEntries(out.rows.map(r => [r.id, r]));

  eq('the broken row is given its contract size', by.mgc1.multiplier, 10);
  eq('a row coerced to 1 is corrected', by.mnq.multiplier, 2);
  eq('a row that was already right is untouched', by.mgc2.multiplier, 10);
  eq('two rows were fixed', out.fixed.length, 2);
  eq('and it says which, and from what', out.fixed.map(f => `${f.symbol}:${f.from}->${f.to}`), ['MGC:null->10', 'MNQ:1->2']);

  // THE LINE THAT MUST NOT BE CROSSED. MET is MetLife. Repricing it at x0.1 would be a worse bug
  // than the one being fixed, so a symbol match alone never changes anything.
  eq('MetLife is not repriced as micro ether', by.met.multiplier, 1);
  ok('it is raised for a human instead', out.review.some(r => r.symbol === 'MET' && r.wouldBe === 0.1));
  eq('a plain share is neither fixed nor raised', by.nvda.multiplier, 1);
  ok('and is not in the review list', !out.review.some(r => r.symbol === 'NVDA'));
  // Every colliding root must behave the same way, not just the one that was thought of.
  for (const sym of ['MET', 'PL', 'CL', 'ES', 'NG', 'SI', 'HG', 'GC', 'RB', 'HO']) {
    const r = backfillMultipliers([{ id: 'x', symbol: sym, multiplier: 1 }]);
    eq(`${sym} as a share is left alone`, r.rows[0].multiplier, 1);
    eq(`and ${sym} is raised rather than guessed`, r.review.length, 1);
  }

  // An unknown contract is not invented, and not silently left looking fine either.
  eq('an unknown contract gets no multiplier', by.zc.multiplier, undefined);
  ok('and is not claimed as fixed', !out.fixed.some(f => f.symbol === 'ZC'));

  // Idempotent — running it twice changes nothing the second time.
  const again = backfillMultipliers(out.rows);
  eq('a second pass fixes nothing', again.fixed.length, 0);
  eq('and the rows are unchanged', JSON.stringify(again.rows), JSON.stringify(out.rows));
  eq('an empty book is fine', backfillMultipliers([]).fixed.length, 0);
  eq('so is nonsense', backfillMultipliers(null).rows.length, 0);

  // The archive figure this whole thing exists for.
  const move = (4385.40 - 4506.40) * 2;
  eq('MGC realised, before', +move.toFixed(2), -242);
  eq('MGC realised, after the backfill', +(move * by.mgc1.multiplier).toFixed(2), -2420);
  eq('and the archive total moves with it', +(4978.81 + 242 - 2420).toFixed(2), 2800.81);
}

// ── THE ROW THAT WAS STILL NOT FIXED ────────────────────────────────────────
// The first backfill required `margined` on every root, so the hand-entered MGC row — which never
// carried that flag — went to a review list instead of being corrected, and the archive still
// read -$242.00. But nothing trades as "MGC" except the contract: the caution was owed to roots
// that are ALSO share tickers, and it was applied to all of them indiscriminately.
{
  const rows = [
    { id: 'mgc', symbol: 'MGC' },                    // no margined flag, no multiplier
    { id: 'mnq', symbol: 'MNQ' },
    { id: 'met', symbol: 'MET', multiplier: 1 },     // MetLife
    { id: 'sil', symbol: 'SIL', multiplier: 1 },     // Global X Silver Miners ETF
    { id: 'cl',  symbol: 'CL',  multiplier: 1 },     // Colgate
    { id: 'nvda', symbol: 'NVDA' },
  ];
  const out = backfillMultipliers(rows);
  const by = Object.fromEntries(out.rows.map(r => [r.id, r]));

  eq('MGC is fixed from the symbol alone', by.mgc.multiplier, 10);
  eq('and so is MNQ', by.mnq.multiplier, 2);
  ok('recorded as identified by symbol', out.fixed.every(f => f.by === 'symbol'));
  // A contract is held on margin whether or not the row said so, and the exposure figures read it.
  eq('and the row is marked margined', by.mgc.margined, true);
  ok('which the report states rather than doing quietly', out.fixed.every(f => f.alsoMargined === true));

  // THE LINE THAT MUST NOT MOVE. Every ambiguous root stays untouched and goes to review.
  for (const sym of [...EQUITY_AMBIGUOUS]) {
    const r = backfillMultipliers([{ id: 'x', symbol: sym, multiplier: 1 }]);
    eq(`${sym} is not repriced from its symbol`, r.rows[0].multiplier, 1);
    eq(`and ${sym} is raised for review`, r.review.length, 1);
  }
  eq('MetLife survives this pass too', by.met.multiplier, 1);
  eq('so does the silver ETF', by.sil.multiplier, 1);
  eq('and Colgate', by.cl.multiplier, 1);
  eq('three ambiguous rows went to review', out.review.length, 3);
  eq('a plain share is neither', by.nvda.multiplier, undefined);

  // The predicate itself, stated.
  eq('MGC is unambiguous', isUnambiguousFuture('MGC'), true);
  eq('a dated contract code too', isUnambiguousFuture('MGCZ6'), true);
  eq('SIL is not', isUnambiguousFuture('SIL'), false);
  eq('nor is an equity', isUnambiguousFuture('NVDA'), false);

  // The figure this exists for.
  eq('MGC realised, after', +((4385.40 - 4506.40) * 2 * by.mgc.multiplier).toFixed(2), -2420);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
