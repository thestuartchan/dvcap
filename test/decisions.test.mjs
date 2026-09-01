// test/decisions.test.mjs — the decision log.
//
// The log exists because the two patterns that cost this account money — adding to losers, and
// sizing up after a win — are invisible in P&L until they are over. So the tests are mostly about
// what is captured WITHOUT typing, and about not recording an inference as though it were a fact.
import { decisionEntry, appendDecision, lastClosedWasWin, overrideStats, MAX_DECISIONS , overrideTrend, guardOutcomes, ACTIONS } from '../lib/decisions.js';
import { derivePosition, positionPnl } from '../lib/positions.js';
import { sizeSuggestion } from '../lib/sizing.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const INTC = { id: 'INTC-open', symbol: 'INTC', multiplier: 1, levels: [],
  fills: [{ id: 'f0', side: 'buy', qty: 30, price: 98.723337, date: '2026-08-05' }] };
const derived = derivePosition(INTC.fills);
const pnl = positionPnl(derived, 91.34);
const sug = sizeSuggestion({ mode: 'allocation', equityInPos: 208597, price: 91.34, targetPct: 5,
  regime: { regimeId: 'stag' }, heldQty: 30 });

// ── the override itself ──
{
  const d = decisionEntry({ row: INTC, derived, pnl, fill: { side: 'buy', qty: 60, price: 91.34 },
    suggestion: sug, regime: { regimeId: 'stag' }, at: '2026-08-28T14:00:00Z' });
  eq('what was taken', d.takenQty, 60);
  eq('against the room the card actually showed', d.recommendedQty, sug.roomQty);
  eq('as a ratio', d.overrideRatio, +(60 / sug.roomQty).toFixed(3));
  eq('the regime it was taken in', [d.regimeId, d.regimeMult], ['stag', sug.mult]);
  // A suggestion the model declined to make is not an override of zero.
  const noRec = decisionEntry({ row: INTC, derived, pnl, fill: { side: 'buy', qty: 60 },
    suggestion: { ...sug, roomQty: 0, fullQty: 0 } });
  eq('no room means no ratio, not infinity', noRec.overrideRatio, null);
}

// ── the field the whole cross-tab turns on ──
// The broker file cannot say whether a stop EXISTED at entry — it records how the exit executed.
// This is the only place that boolean can come from, and it must be recorded, never inferred.
{
  const bare = decisionEntry({ row: INTC, derived, pnl, fill: { side: 'buy', qty: 10 }, suggestion: sug });
  eq('no stop on the row is recorded as false', bare.stopSet, false);
  eq('and no price claimed for one', bare.stopAt, null);
  const stopped = decisionEntry({ row: { ...INTC, levels: [{ id: 'sl', kind: 'stop', at: 88 }] },
    derived, pnl, fill: { side: 'buy', qty: 10 }, suggestion: sug });
  eq('a stop on the row is recorded as true', stopped.stopSet, true);
  eq('with its level', stopped.stopAt, 88);
  // A buy or sell LEVEL is not a stop. This is the distinction the whole finding rests on.
  const target = decisionEntry({ row: { ...INTC, levels: [{ id: 'tp', kind: 'sell', at: 120 }] },
    derived, pnl, fill: { side: 'buy', qty: 10 }, suggestion: sug });
  eq('a target is not a stop', target.stopSet, false);
  // A stop with no price is not a stop either.
  const empty = decisionEntry({ row: { ...INTC, levels: [{ id: 'sl', kind: 'stop', at: null }] },
    derived, pnl, fill: { side: 'buy', qty: 10 }, suggestion: sug });
  eq('an empty stop level does not count', empty.stopSet, false);
}

// ── the pattern, recorded whether or not the warning fired ──
{
  const d = decisionEntry({ row: INTC, derived, pnl, fill: { side: 'buy', qty: 10 }, suggestion: sug });
  eq('this is the second buy', d.addNumber, 2);
  eq('into a position down this much', d.unrealisedPctBefore, -7.48);
  eq('which makes it an add to a loser', d.addToLoser, true);
  const up = decisionEntry({ row: INTC, derived, pnl: positionPnl(derived, 120), fill: { side: 'buy', qty: 10 }, suggestion: sug });
  eq('adding to a winner is not', up.addToLoser, false);
  const sell = decisionEntry({ row: INTC, derived, pnl, fill: { side: 'sell', qty: 10 }, suggestion: sug });
  eq('and a sell is neither', [sell.addToLoser, sell.addNumber], [false, null]);
}

// ── intent: declared, never inferred ──
{
  const d = decisionEntry({ row: INTC, derived, pnl, fill: { side: 'buy', qty: 10 }, suggestion: sug, intent: 'swing' });
  eq('what was declared is kept', d.intent, 'swing');
  eq('nothing declared stays null', decisionEntry({ row: INTC, derived, pnl, fill: { side: 'buy', qty: 10 }, suggestion: sug }).intent, null);
  eq('and junk is not a category', decisionEntry({ row: INTC, derived, pnl, fill: { side: 'buy', qty: 10 }, suggestion: sug, intent: 'maybe' }).intent, null);
}

// ── what the last closed trade did, recorded BESIDE the next decision ──
// By review time the sequence is lost, which is why the 2.31x-after-a-win pattern took a full
// re-segmentation of the broker file to find.
{
  const mk = (id, pnlv, date) => ({ id, symbol: id, derived: { status: 'closed', realized: pnlv, lastDate: date } });
  eq('the most recent exit decides', lastClosedWasWin([mk('A', -100, '2026-08-01'), mk('B', 500, '2026-08-20')]), true);
  eq('by DATE, not array order', lastClosedWasWin([mk('B', 500, '2026-08-20'), mk('A', -100, '2026-08-25')]), false);
  eq('a rolled-out leg is not a closed trade', lastClosedWasWin([mk('B', 500, '2026-08-20'),
    { ...mk('C', 900, '2026-08-26'), derived: { status: 'closed', realized: 900, lastDate: '2026-08-26', rolledInto: 'D' } }]), true);
  eq('a scratch is neither a win nor a loss', lastClosedWasWin([mk('A', 0, '2026-08-20')]), null);
  eq('nothing closed, nothing claimed', lastClosedWasWin([]), null);
}

// ── the log itself ──
{
  const e = (s) => ({ symbol: s, overrideRatio: 1, side: 'buy' });
  eq('appending keeps order', appendDecision([e('A')], e('B')).map(d => d.symbol), ['A', 'B']);
  eq('an entry with no symbol is not an entry', appendDecision([e('A')], { overrideRatio: 1 }).length, 1);
  const big = Array.from({ length: MAX_DECISIONS }, (_, i) => e('S' + i));
  const capped = appendDecision(big, e('NEW'));
  eq('the log is capped', capped.length, MAX_DECISIONS);
  eq('and it is the OLDEST that goes', [capped[0].symbol, capped.at(-1).symbol], ['S1', 'NEW']);
  ok('appending does not mutate the input', (() => { const a = [e('A')]; appendDecision(a, e('B')); return a.length === 1; })());
}

// ── reading it back ──
{
  const d = (ratio, extra = {}) => ({ symbol: 'X', side: 'buy', overrideRatio: ratio, ...extra });
  const log = [
    d(2.0, { prevClosedWasWin: true, addToLoser: true, stopSet: false, intent: 'intraday' }),
    d(2.5, { prevClosedWasWin: true, stopSet: true, intent: 'swing' }),
    d(1.0, { prevClosedWasWin: false, stopSet: true, intent: 'swing' }),
    d(0.5, { prevClosedWasWin: false, stopSet: false, intent: 'swing' }),
  ];
  const s = overrideStats(log);
  eq('counted', s.n, 4);
  eq('exceeded the suggestion twice', s.over, 2);
  eq('and came in under it once', s.under, 1);
  // The prospective version of the 2.31x finding.
  eq('mean ratio after a win', s.meanAfterWin, 2.25);
  eq('and after a loss', s.meanAfterLoss, 0.75);
  eq('adds to losers', s.addsToLosers, 1);
  eq('taken without a stop', s.withoutStop, 2);
  eq('declared intent splits', [s.declaredSwing, s.declaredIntraday], [3, 1]);
  eq('an empty log claims nothing', overrideStats([]), { n: 0 });
  // A sell is not an override of a buy suggestion.
  eq('sells are excluded', overrideStats([{ symbol: 'X', side: 'sell', overrideRatio: 9 }]), { n: 0 });
}


// ── P3: declined, actions, and reading the log back ──────────────────────────
{
  const base = { row: { id: 'r1', symbol: 'ARM', levels: [{ kind: 'stop', at: 300 }] },
    derived: { qty: 100, fills: [{ side: 'buy' }] }, pnl: { unrealizedPct: -8.4 },
    suggestion: { roomQty: 50 }, regime: { regimeId: 'stag' } };
  const took = decisionEntry({ ...base, fill: { side: 'buy', qty: 75, price: 340 } });
  const skip = decisionEntry({ ...base, fill: { side: 'buy', qty: 75, price: 340 }, action: 'declined' });

  eq('a recorded buy is an open', took.action, 'opened');
  eq('a sell is a close', decisionEntry({ ...base, fill: { side: 'sell', qty: 10, price: 1 } }).action, 'closed');
  eq('an unknown action falls back rather than storing junk',
    decisionEntry({ ...base, fill: { side: 'buy', qty: 1, price: 1 }, action: 'nonsense' }).action, 'opened');

  // The whole reason `declined` exists as its own action.
  eq('a declined trade records what was considered', skip.consideredQty, 75);
  eq('and takes nothing', skip.takenQty, null);
  // If a decline carried takenQty it would land in the override stats as though it had executed,
  // making the one act that PROVES a guard worked look identical to ignoring one.
  eq('so it cannot register as an override', skip.overrideRatio, null);
  eq('while the executed one does', took.overrideRatio, 1.5);
  eq('override stats count only what was executed', overrideStats([took, skip]).n, 1);
  eq('and the fill price is kept either way', [took.fillPrice, skip.fillPrice], [340, 340]);
}
{
  const e = decisionEntry({
    row: { id: 'r1', symbol: 'X' }, derived: { qty: 0, fills: [] },
    fill: { side: 'buy', qty: 10, price: 5 },
    guards: { size: 'red', stopAtr: 'unknown' }, guardWorst: 'red', guardBreached: ['size'],
  });
  eq('guard states ride along with the decision', e.guards, { size: 'red', stopAtr: 'unknown' });
  eq('with the worst one named', e.guardWorst, 'red');
  eq('and what was breached', e.guardBreached, ['size']);
  const none = decisionEntry({ row: { id: 'r', symbol: 'X' }, derived: { qty: 0, fills: [] }, fill: { side: 'buy', qty: 1, price: 1 } });
  eq('a decision with no panel stores null, not an empty object', none.guards, null);
}

// ── override frequency over time ─────────────────────────────────────────────
{
  const mk = (at, ratio) => ({ at, id: 'x', symbol: 'X', side: 'buy', action: 'opened', overrideRatio: ratio });
  const log = [mk('2026-07-05T00:00:00Z', 1.4), mk('2026-07-20T00:00:00Z', 0.9),
               mk('2026-08-01T00:00:00Z', 1.6), mk('2026-08-02T00:00:00Z', 1.8)];
  const t = overrideTrend(log);
  eq('one bucket per month', t.map(x => x.period), ['2026-07', '2026-08']);
  eq('counting how many exceeded the suggestion', t.map(x => x.over), [1, 2]);
  eq('as a share', t.map(x => x.overPct), [50, 100]);
  eq('with the mean ratio', t[1].meanRatio, 1.7);
  // A single lifetime number cannot show a habit changing, which is the only thing this can
  // eventually demonstrate about itself.
  ok('so the trend is visible', t[1].overPct > t[0].overPct);
  eq('declines are excluded here too',
    overrideTrend([...log, { at: '2026-08-03T00:00:00Z', side: 'buy', action: 'declined', overrideRatio: 9 }])[1].n, 2);
  eq('an empty log gives an empty trend', overrideTrend([]).length, 0);
}

// ── realised P&L by guard state ──────────────────────────────────────────────
{
  const mk = (id, q, guards) => ({ at: '2026-08-01T00:00:00Z', id, symbol: 'X', side: 'buy', action: 'opened', takenQty: q, guards });
  const log = [
    mk('a', 100, { stopAtr: 'red' }),
    mk('b', 100, { stopAtr: 'green' }),
    mk('c', 50, { stopAtr: 'red' }),
    mk('c', 50, { stopAtr: 'red' }),
  ];
  const rows = [
    { id: 'a', derived: { status: 'closed', realized: -500, bought: 100 } },
    { id: 'b', derived: { status: 'closed', realized: 300, bought: 100 } },
    { id: 'c', derived: { status: 'closed', realized: -800, bought: 100 } },
  ];
  const o = guardOutcomes(log, rows);
  const g = o.guards.find(x => x.id === 'stopAtr');
  // Row c was bought twice and made one result. Crediting -800 to each entry would double it and
  // make the guard look twice as consequential as it is; each half-position carries half.
  eq('a row bought twice splits its result pro rata', g.red.pnl, -1300);
  eq('across three red decisions', g.red.n, 3);
  eq('and the green one stands alone', [g.green.n, g.green.pnl], [1, 300]);
  ok('the spread is reported', g.spread != null);
  // n=1 on one side is an anecdote, and saying so is the point.
  eq('but not called comparable on one green trade', g.comparable, false);
  ok('and the attribution rule is stated in the object', /pro rata/.test(o.note));
  ok('including that columns do not sum to account P&L', /do not sum/.test(o.note));
}
{
  // Open positions have no realised result to attribute, and declines never entered anything.
  const log = [{ at: 'a', id: 'a', symbol: 'X', side: 'buy', action: 'opened', takenQty: 10, guards: { size: 'red' } },
               { at: 'b', id: 'b', symbol: 'X', side: 'buy', action: 'declined', takenQty: null, consideredQty: 10, guards: { size: 'red' } }];
  const rows = [{ id: 'a', derived: { status: 'open', realized: 0, bought: 10 } },
                { id: 'b', derived: { status: 'closed', realized: 500, bought: 10 } }];
  const o = guardOutcomes(log, rows);
  eq('an open position contributes nothing yet', o.decisions, 0);
  eq('and a decline never contributes at all', o.guards.length, 0);
}
{
  // A rolled row's result belongs to the contract it rolled into, not to this entry.
  const log = [{ at: 'a', id: 'a', symbol: 'MGC', side: 'buy', action: 'opened', takenQty: 1, guards: { size: 'green' } }];
  const rows = [{ id: 'a', derived: { status: 'closed', realized: -200, bought: 1, rolledInto: 'b' } }];
  eq('a rolled leg is not counted as a result', guardOutcomes(log, rows).decisions, 0);
}
{
  eq('an empty call does not throw', guardOutcomes().guards.length, 0);
  eq('nor a null log with real rows', guardOutcomes(null, [{ id: 'a', derived: { status: 'closed', realized: 1, bought: 1 } }]).decisions, 0);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
