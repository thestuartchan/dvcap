// test/guards.test.mjs — the pre-trade panel.
// The failure this file is mostly guarding against is a panel that reads clear when it is blind.
// Every guard that cannot be computed must say `unknown`, and `unknown` must never count as a pass.
import {
  preTradeGuards, guardStates, GUARD_CFG,
  sizeGuard, positionNotionalGuard, bookNotionalGuard, futuresNotionalGuard,
  stopAtrGuard, reentryGuard, afterWinGuard, addToLoserGuard,
} from '../lib/guards.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

// ── 1. size vs suggested ─────────────────────────────────────────────────────
{
  eq('at the suggestion', sizeGuard({ takenQty: 100, suggestedQty: 100 }).state, 'green');
  eq('a quarter over is a decision', sizeGuard({ takenQty: 125, suggestedQty: 100 }).state, 'amber');
  eq('half over is a different trade', sizeGuard({ takenQty: 150, suggestedQty: 100 }).state, 'red');
  eq('under the suggestion is never flagged', sizeGuard({ takenQty: 40, suggestedQty: 100 }).state, 'green');
  eq('the delta is reported as a percentage', sizeGuard({ takenQty: 150, suggestedQty: 100 }).value.deltaPct, 50);
  eq('and negative when smaller', sizeGuard({ takenQty: 60, suggestedQty: 100 }).value.deltaPct, -40);
}
{
  // A suggestion the model declined to make is not an override of zero.
  eq('no suggestion is unknown, not green', sizeGuard({ takenQty: 100, suggestedQty: null }).state, 'unknown');
  eq('a zero suggestion cannot divide', sizeGuard({ takenQty: 100, suggestedQty: 0 }).state, 'unknown');
  eq('no quantity typed yet is unknown', sizeGuard({ takenQty: null, suggestedQty: 100 }).state, 'unknown');
  ok('and says which is missing', /no quantity/.test(sizeGuard({ takenQty: null, suggestedQty: 100 }).note));
}

// ── 2-4. notional ────────────────────────────────────────────────────────────
{
  const eq_ = 200000;
  eq('a normal position', positionNotionalGuard({ notionalBase: 10000, equityBase: eq_ }).state, 'green');
  eq('a double weight', positionNotionalGuard({ notionalBase: 22000, equityBase: eq_ }).state, 'amber');
  eq('a concentration', positionNotionalGuard({ notionalBase: 40000, equityBase: eq_ }).state, 'red');
  eq('the percentage is reported', positionNotionalGuard({ notionalBase: 20000, equityBase: eq_ }).value.pct, 10);
  eq('no equity is unknown, not green', positionNotionalGuard({ notionalBase: 20000, equityBase: null }).state, 'unknown');
  eq('a zero equity cannot divide', positionNotionalGuard({ notionalBase: 20000, equityBase: 0 }).state, 'unknown');
}
{
  const eq_ = 200000;
  eq('an unlevered book', bookNotionalGuard({ bookNotionalBase: 80000, equityBase: eq_ }).state, 'green');
  eq('gross above equity', bookNotionalGuard({ bookNotionalBase: 220000, equityBase: eq_ }).state, 'amber');
  eq('and well beyond it', bookNotionalGuard({ bookNotionalBase: 320000, equityBase: eq_ }).state, 'red');
  ok('the note says futures are at contract value',
    /contract value/.test(bookNotionalGuard({ bookNotionalBase: 80000, equityBase: eq_ }).note));
}
{
  const eq_ = 200000;
  eq('no futures at all', futuresNotionalGuard({ futuresNotionalBase: 0, equityBase: eq_, rows: 0 }).state, 'green');
  ok('and says so', /no margined rows/.test(futuresNotionalGuard({ futuresNotionalBase: 0, equityBase: eq_, rows: 0 }).note));
  eq('half the book in notional', futuresNotionalGuard({ futuresNotionalBase: 110000, equityBase: eq_, rows: 2 }).state, 'amber');
  eq('more notional than equity', futuresNotionalGuard({ futuresNotionalBase: 210000, equityBase: eq_, rows: 2 }).state, 'red');
  ok('the row count is named', /2 margined rows/.test(futuresNotionalGuard({ futuresNotionalBase: 110000, equityBase: eq_, rows: 2 }).note));
  ok('singular reads right', /1 margined row\b/.test(futuresNotionalGuard({ futuresNotionalBase: 110000, equityBase: eq_, rows: 1 }).note));
}

// ── 5. stop distance ─────────────────────────────────────────────────────────
{
  eq('two ATRs is a real invalidation level', stopAtrGuard({ width: { known: true, atrs: 2.0, note: 'n' } }).state, 'green');
  eq('1.2 ATR is worth a look', stopAtrGuard({ width: { known: true, atrs: 1.2, note: 'n' } }).state, 'amber');
  eq('half an ATR is inside the noise', stopAtrGuard({ width: { known: true, atrs: 0.5, note: 'n' } }).state, 'red');
  eq('exactly one ATR is not red', stopAtrGuard({ width: { known: true, atrs: 1.0, note: 'n' } }).state, 'amber');
  // The one that matters: no stop, or no ATR, must not read as a stop that passed.
  eq('an unknown width is unknown', stopAtrGuard({ width: { known: false, note: 'no stop set' } }).state, 'unknown');
  eq('and a missing width object too', stopAtrGuard({}).state, 'unknown');
  ok('carrying the reason through', /no stop set/.test(stopAtrGuard({ width: { known: false, note: 'no stop set' } }).note));
}

// ── 6. re-entry ──────────────────────────────────────────────────────────────
{
  const r = reentryGuard({ lastClose: { at: hoursAgo(3), price: 19.98, realized: -412 } });
  eq('closed three hours ago is red', r.state, 'red');
  ok('with the price it closed at', /19.98/.test(r.note));
  ok('and what it made or lost', /-412/.test(r.note));
  eq('and the elapsed hours', Math.round(r.value.hours), 3);
}
{
  eq('closed a week ago is fine', reentryGuard({ lastClose: { at: hoursAgo(168), price: 10 } }).state, 'green');
  eq('the boundary is 24h', reentryGuard({ lastClose: { at: hoursAgo(23.9), price: 10 } }).state, 'red');
  eq('just past it is not', reentryGuard({ lastClose: { at: hoursAgo(24.5), price: 10 } }).state, 'green');
  // Never closed is genuinely fine — this is the one guard whose absence of data IS a pass.
  eq('never closed is green, not unknown', reentryGuard({}).state, 'green');
  eq('an unparseable date does not throw', reentryGuard({ lastClose: { at: 'not-a-date' } }).state, 'green');
}

// ── 7a. after a win ──────────────────────────────────────────────────────────
{
  const w = afterWinGuard({ prevClosed: { win: true, size: 600, realized: 1240, symbol: 'METU' } });
  eq('the last trade won', w.state, 'amber');
  ok('the symbol is named', /METU/.test(w.note));
  ok('and the size of it', /600 units/.test(w.note));
  ok('with the reason it is flagged at all', /2\.31x/.test(w.note));
  eq('after a loss there is nothing to flag', afterWinGuard({ prevClosed: { win: false, size: 100, realized: -50 } }).state, 'green');
  eq('no closed trade is unknown', afterWinGuard({}).state, 'unknown');
  eq('and a null win is unknown too', afterWinGuard({ prevClosed: { win: null } }).state, 'unknown');
}

// ── 7b. adding to a loser ────────────────────────────────────────────────────
{
  const a = addToLoserGuard({ add: { addNumber: 3, priorBuys: 2, drawdownPct: -8.4, belowAverage: true,
    evidence: { line: '27 trades lost $18,377.' } } });
  eq('adding to a loser is red', a.state, 'red');
  ok('the add number is named', /add #3/.test(a.note));
  ok('and the drawdown', /8\.4% underwater/.test(a.note));
  ok('and the evidence travels with it', /\$18,377/.test(a.note));
  eq('not adding to a loser is green', addToLoserGuard({}).state, 'green');
}

// ── the panel ────────────────────────────────────────────────────────────────
{
  const clean = preTradeGuards({
    takenQty: 100, suggestedQty: 100,
    notionalBase: 10000, equityBase: 200000,
    bookNotionalBase: 80000, futuresNotionalBase: 0, rows: 0,
    width: { known: true, atrs: 2.2, note: 'n' },
    prevClosed: { win: false, size: 10, realized: -20 },
  });
  eq('a clean trade is green throughout', clean.worst, 'green');
  eq('with nothing breached', clean.breached, []);
  eq('and eight guards evaluated', clean.guards.length, 8);
}
{
  // Three ambers are NOT a red. Refusing to add them up is deliberate — a composite score would
  // invent a number the record cannot support.
  const p = preTradeGuards({
    takenQty: 130, suggestedQty: 100,
    notionalBase: 24000, equityBase: 200000,
    bookNotionalBase: 220000, futuresNotionalBase: 0, rows: 0,
    width: { known: true, atrs: 2.2, note: 'n' },
    prevClosed: { win: false, size: 1, realized: -1 },
  });
  eq('three ambers stay amber', p.worst, 'amber');
  eq('and nothing is reported as breached', p.breached, []);
  eq('but they are counted', p.amber, 3);
}
{
  // A completely empty call — the state on first opening the form, before a quantity is typed.
  const p = preTradeGuards({});
  eq('an empty panel does not throw', p.guards.length, 8);
  eq('and is never green', p.worst, 'unknown');
  ok('unknowns are counted, not hidden', p.unknown >= 4);
  eq('with nothing falsely breached', p.breached, []);
}
{
  const p = preTradeGuards({
    takenQty: 150, suggestedQty: 100,
    notionalBase: 40000, equityBase: 200000,
    bookNotionalBase: 400000, futuresNotionalBase: 300000, rows: 2,
    width: { known: true, atrs: 0.4, note: 'n' },
    lastClose: { at: hoursAgo(2), price: 20 },
    prevClosed: { win: true, size: 600, realized: 1240 },
    add: { addNumber: 4, priorBuys: 3, drawdownPct: -12, evidence: { line: 'x' } },
  });
  eq('the worst case reports red', p.worst, 'red');
  eq('naming every breach', p.breached.sort(),
    ['addToLoser', 'bookNotional', 'futuresNotional', 'notional', 'reentry', 'size', 'stopAtr'].sort());
}
{
  // The compact form the log stores: states by id, nothing else.
  const p = preTradeGuards({ takenQty: 100, suggestedQty: 100 });
  const s = guardStates(p);
  eq('one key per guard', Object.keys(s).length, 8);
  eq('size is green', s.size, 'green');
  eq('and an uncomputable one is unknown', s.stopAtr, 'unknown');
  ok('values are not stored, only states', Object.values(s).every(v => typeof v === 'string'));
  eq('an empty panel gives an empty map, not a throw', Object.keys(guardStates(null)).length, 0);
}
{
  eq('thresholds are stated, not buried', [GUARD_CFG.atrRed, GUARD_CFG.sizeRed, GUARD_CFG.reentryHours], [1.0, 1.5, 24]);
  // Overridable, so they can be tuned against the log rather than argued about in the abstract.
  const strict = { ...GUARD_CFG, sizeAmber: 1.01, sizeRed: 1.02 };
  eq('and can be overridden', sizeGuard({ takenQty: 105, suggestedQty: 100 }, strict).state, 'red');
}

{
  // The guard must not paint five different problems the same colour either. A missing STOP is a
  // risk finding and reads amber; a missing FEED is an absence of information and reads grey.
  const g = (st) => stopAtrGuard({ width: { known: false, status: st, note: st } });
  eq('no stop is a finding, not a blank', g('no-stop').state, 'amber');
  eq('a failed fetch is a blank', g('fetch-failed').state, 'unknown');
  eq('an unknown ticker is a blank', g('no-data').state, 'unknown');
  eq('a short history is a blank', g('short-history').state, 'unknown');
  eq('and so is still-loading', g('loading').state, 'unknown');
  // The reason survives into the value, so the decision log records WHICH blank it was.
  eq('the reason is carried, not just the colour', g('fetch-failed').value.reason, 'fetch-failed');
}

{
  // The guard must not paint five different problems the same colour either. A missing STOP is a
  // risk finding and reads amber; a missing FEED is an absence of information and reads grey.
  const g = (st) => stopAtrGuard({ width: { known: false, status: st, note: st } });
  eq('no stop is a finding, not a blank', g('no-stop').state, 'amber');
  eq('a failed fetch is a blank', g('fetch-failed').state, 'unknown');
  eq('an unknown ticker is a blank', g('no-data').state, 'unknown');
  eq('a short history is a blank', g('short-history').state, 'unknown');
  eq('and so is still-loading', g('loading').state, 'unknown');
  // The reason survives into the value, so the decision log records WHICH blank it was.
  eq('the reason is carried, not just the colour', g('fetch-failed').value.reason, 'fetch-failed');
}

console.log(`\n${fail ? '❌' : '✅'} ${fail ? `${fail} FAILED, ` : 'ALL '}${pass} PASSED`);
process.exit(fail ? 1 : 0);
