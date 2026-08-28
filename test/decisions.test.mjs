// test/decisions.test.mjs — the decision log.
//
// The log exists because the two patterns that cost this account money — adding to losers, and
// sizing up after a win — are invisible in P&L until they are over. So the tests are mostly about
// what is captured WITHOUT typing, and about not recording an inference as though it were a fact.
import { decisionEntry, appendDecision, lastClosedWasWin, overrideStats, MAX_DECISIONS } from '../lib/decisions.js';
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

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
