// test/futures.test.mjs — the contract sizes, and the promise that an unknown one stays unknown.
import { FUTURES_MULTIPLIER, futuresRoot, multiplierFor } from '../lib/futures.js';

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

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
