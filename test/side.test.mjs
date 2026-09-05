// test/side.test.mjs — direction, and every rule that mirrors on it.
//
// The console was long-only and said so in three places, but "long-only" was enforced by nothing:
// a short entered by hand was ACCEPTED and then rendered wrong five ways at once. So these tests
// are written as MIRRORS wherever possible — a short is asserted against the equivalent long, not
// against a hand-computed constant, because a constant only proves the code agrees with whoever
// typed the test and a mirror proves the two directions are the same idea.
import { sideOf, dirSign, isShort, openSideFor, closeSideFor, geometryCheck, DEFAULT_SIDE } from '../lib/side.js';
import { derivePosition, positionPnl, levelHit, levelHits, splitIntoTrades, collapseFills, summarize, realizedCurve } from '../lib/positions.js';
import { rOf, lockedPct, publicView, fitLines, dirOf, PUBLIC_FIELDS } from '../lib/tradecard.js';
import { addToLoser } from '../lib/discipline.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// ── normalising ──────────────────────────────────────────────────────────────
eq('absent is long', sideOf(undefined), 'long');
eq('empty is long', sideOf(''), 'long');
eq('reads a row', sideOf({ side: 'short' }), 'short');
eq('reads a derived position', sideOf({ derived: { side: 'short' } }), 'short');
eq('case and aliases', [sideOf('SHORT'), sideOf('s'), sideOf('sell'), sideOf('L')], ['short', 'short', 'short', 'long']);
// An UNREADABLE side is not silently long — that is the difference between a safe default and an
// inverted position, and the caller has to be able to tell them apart.
eq('unreadable is null, not long', sideOf('sideways'), null);
eq('but it SIGNS as long, never worse than before', dirSign('sideways'), 1);
eq('opens/closes', [openSideFor('short'), closeSideFor('short'), openSideFor('long'), closeSideFor('long')],
   ['sell', 'buy', 'buy', 'sell']);

// ── the engine: a short is the mirror of a long ──────────────────────────────
// Short 100 @ 100, cover 40 @ 90, mark 95   ⟷   long 100 @ 100, sell 40 @ 110, mark 105.
const S = derivePosition([
  { side: 'sell', qty: 100, price: 100, date: '2026-01-01' },
  { side: 'buy',  qty: 40,  price: 90,  date: '2026-02-01' },
], { side: 'short' });
const L = derivePosition([
  { side: 'buy',  qty: 100, price: 100, date: '2026-01-01' },
  { side: 'sell', qty: 40,  price: 110, date: '2026-02-01' },
]);
const sp = positionPnl(S, 95), lp = positionPnl(L, 105);

eq('the opening sell OPENS the short', [S.qty, S.avgCost, S.status], [60, 100, 'open']);
eq('realised mirrors', S.realized, L.realized);
eq('realised % mirrors', S.realizedPct, L.realizedPct);
eq('the scale-out is a GAIN on the short', S.scaleOuts, L.scaleOuts);
eq('unrealised mirrors', [sp.unrealized, sp.unrealizedPct], [lp.unrealized, lp.unrealizedPct]);
ok('a short marked below its entry is UP', sp.unrealizedPct > 0);
eq('side travels with the derived position', [S.side, S.short, L.side, L.short], ['short', true, 'long', false]);
eq('avgEntry is the average SALE price on a short', S.avgEntry, 100);
eq('avgExit is the average cover price', +S.avgExit.toFixed(2), 90);

// A short position is a LIABILITY — negative market value, so a hedged book nets out.
ok('short market value is negative', sp.marketValue < 0);
ok('long market value is positive', lp.marketValue > 0);
eq('a long and its offsetting short net to zero market value',
   +(positionPnl(derivePosition([{ side: 'buy', qty: 10, price: 50 }]), 50).marketValue
   + positionPnl(derivePosition([{ side: 'sell', qty: 10, price: 50 }], { side: 'short' }), 50).marketValue).toFixed(2), 0);

// Regression: this is what the OLD engine did to a short, and why it could not be worked around.
const naive = derivePosition(S.fills);   // same fills, side omitted
// Not "the short fails to open" — worse. The opening sell is discarded as an oversell and the
// COVER is read as an opening buy, so the identical fills become a 40-unit LONG at 90 where the
// truth is a 60-unit short at 100. Wrong size, wrong basis, wrong direction, and only a warning
// most of the way down the object to say anything happened at all.
eq('the same fills without a side become a LONG the other way up', [naive.qty, naive.avgCost], [40, 90]);
eq('while the truth is', [S.qty, S.avgCost], [60, 100]);
ok('and it complains rather than staying silent', naive.warnings.length > 0);

// Over-closing is still a data error, named for the direction it happens in.
const over = derivePosition([
  { side: 'sell', qty: 10, price: 100, date: '2026-01-01' },
  { side: 'buy',  qty: 25, price: 90,  date: '2026-02-01' },
], { side: 'short' });
eq('covering more than is short is clamped', over.qty, 0);
ok('and says so in short language', /buy-to-cover/.test(over.warnings[0] || ''));
ok('a long still says sell', /^sell of/.test(derivePosition([
  { side: 'buy', qty: 10, price: 100 }, { side: 'sell', qty: 25, price: 110 }]).warnings[0] || ''));

// An unreadable side degrades to long AND says so.
const weird = derivePosition([{ side: 'buy', qty: 5, price: 10 }], { side: 'sideways' });
eq('unreadable side still derives as long', weird.qty, 5);
ok('and warns', weird.warnings.some(w => /unrecognised side/.test(w)));

// ── levels: every one of them flips ──────────────────────────────────────────
const stop = { kind: 'stop', at: 110 }, tgt = { kind: 'sell', at: 90 };
eq("a short's stop breaches on the way UP",
   [levelHit(stop, 112, 'short'), levelHit(stop, 105, 'short')], [true, false]);
eq("a short's target is reached on the way DOWN",
   [levelHit(tgt, 88, 'short'), levelHit(tgt, 95, 'short')], [true, false]);
eq('a long is unchanged', [levelHit(stop, 112), levelHit(stop, 105)], [false, true]);
// The bug in its original form: hard-coded the long way, a short's stop could NEVER fire.
ok('the old behaviour would have missed it entirely', levelHit(stop, 999) === false);
eq('levelHits reads the side off the position',
   levelHits([{ side: 'short', levels: [stop] }], () => 112).length, 1);
eq('and does not fire the same level on a long', levelHits([{ levels: [stop] }], () => 112).length, 0);

// ── R and the locked-in floor ────────────────────────────────────────────────
eq('R mirrors: short 100/stop 110 at 90 is +1R', rOf(90, 100, 110, 'short'), rOf(110, 100, 90, 'long'));
eq('short at its stop is −1R', rOf(110, 100, 110, 'short'), -1);
eq('a stop the SAFE side of entry is not a risk unit', rOf(90, 100, 90, 'short'), null);
eq('long R unchanged', rOf(20.05, 18.06, 16.5), 1.3);

// The exact defect: a short's ORDINARY stop sits above entry, and used to print as a locked gain.
eq('short, ordinary stop above entry → no floor', lockedPct(110, 100, 'short'), null);
eq('short, stop trailed BELOW entry → floor', lockedPct(92, 100, 'short'), 8);
eq('long, ordinary stop below entry → no floor', lockedPct(90, 100, 'long'), null);
eq('long, stop trailed above entry → floor', lockedPct(108, 100, 'long'), 8);
eq('the two directions lock in symmetrically', lockedPct(92, 100, 'short'), lockedPct(108, 100, 'long'));

// ── the card ─────────────────────────────────────────────────────────────────
const shortRow = {
  symbol: 'SPY', trade: 'hedge', side: 'short', price: 95,
  derived: { side: 'short', avgCost: 100, avgEntry: 100, status: 'open', qty: 100, firstDate: '2026-08-01', scaleOuts: [] },
  pnl: { unrealizedPct: 5 }, levels: [{ kind: 'stop', at: 110 }, { kind: 'sell', at: 85 }],
};
const longRow = { ...shortRow, symbol: 'QQQ', side: 'long', price: 105,
  derived: { ...shortRow.derived, side: 'long' }, levels: [{ kind: 'stop', at: 90 }, { kind: 'sell', at: 115 }] };
const sv = publicView(shortRow), lv = publicView(longRow);
eq('the view carries the side', [sv.side, lv.side], ['short', 'long']);
eq('R mirrors on the card', sv.r, lv.r);
eq('the target is worth the same R either way', sv.targets[0].r, lv.targets[0].r);
eq('hitting the stop is −1R either way', [sv.stop.r, lv.stop.r], [-1, -1]);
eq('no phantom locked-in gain on the short', sv.stop.locked, null);

// Direction is PUBLIC (it describes the idea, not the account) — but nothing else leaked with it.
ok('side is a published field', PUBLIC_FIELDS.includes('side'));
for (const forbidden of ['qty', 'notional', 'equity', 'marketValue', 'unrealized'])
  ok(`still never publishes ${forbidden}`, !PUBLIC_FIELDS.includes(forbidden));

// The marker appears only when it VARIES — an all-long card is byte-identical to before.
ok('a mixed book marks both rows', /`S`/.test(fitLines([sv, lv]).body) && /`L`/.test(fitLines([sv, lv]).body));
ok('an all-long book carries no marker', !/`L`/.test(fitLines([lv]).body));
// Colour follows the ECONOMIC direction, not the price direction.
ok('a winning short is green even when the percentage rounds away', dirOf(0, 95, 100, 'short') > 0);
ok('a losing short is red', dirOf(0, 105, 100, 'short') < 0);
ok('a long is unchanged', dirOf(0, 105, 100) > 0);

// ── adding to a loser is adding, not buying ──────────────────────────────────
const losingShort = { side: 'short', qty: 100, avgCost: 100, fills: [{ side: 'sell', qty: 100, price: 100 }] };
ok('selling more of a losing short IS the pattern',
   addToLoser({ derived: losingShort, pct: -6, side: 'sell', fillPrice: 106 }) != null);
eq('covering it is NOT — that reduces the risk',
   addToLoser({ derived: losingShort, pct: -6, side: 'buy', fillPrice: 106 }), null);
// The adverse side MIRRORS. A long adds badly below its average cost; a short adds badly ABOVE
// its average sale price, because that is the side the position has already moved against it. The
// field was called `belowAverage`, which made the long case the definition rather than an instance.
eq('a short selling ABOVE its average is the adverse side',
   addToLoser({ derived: losingShort, pct: -6, side: 'sell', fillPrice: 106 }).worseThanAverage, true);
eq('selling below it is not', addToLoser({ derived: losingShort, pct: -6, side: 'sell', fillPrice: 95 }).worseThanAverage, false);
eq('and it names the direction so a caller can word it', addToLoser({ derived: losingShort, pct: -6, side: 'sell', fillPrice: 106 }).adverseSide, 'above');
ok('a long is unchanged',
   addToLoser({ derived: { qty: 100, avgCost: 100, fills: [{ side: 'buy', qty: 100, price: 100 }] }, pct: -6, side: 'buy', fillPrice: 90 }) != null);

// ── splitting, collapsing, and the realised curve ────────────────────────────
eq('a short round trip is ONE trade', splitIntoTrades([
  { side: 'sell', qty: 10, price: 100, date: '2026-01-01' },
  { side: 'buy',  qty: 10, price: 90,  date: '2026-02-01' },
], { side: 'short' }).length, 1);
const col = collapseFills(S.fills, { side: 'short' });
ok('collapsing a short preserves its realised P&L exactly', col.exact);
const curve = realizedCurve([{ symbol: 'SPY', side: 'short', derived: S }]);
eq('the curve books the gain on the COVER, not on the opening sell',
   [curve.length, curve[0].date, curve[0].gain], [1, '2026-02-01', 400]);

// ── the mislabelled short, caught where it is created ────────────────────────
const mis = geometryCheck({ side: 'long', entry: 100, stop: 110, targets: [85] });
ok('a long whose levels are a short is flagged', !mis.ok);
ok('and the message names the direction it actually is', /short/.test(mis.reason));
ok('a correct long passes', geometryCheck({ side: 'long', entry: 100, stop: 90, targets: [115] }).ok);
ok('a correct short passes', geometryCheck({ side: 'short', entry: 100, stop: 110, targets: [85] }).ok);
// A TRAILED stop legitimately sits the "wrong" side — that is the locked-in case, not an error.
ok('a long with a trailed stop is NOT flagged', geometryCheck({ side: 'long', entry: 100, stop: 104, targets: [130] }).ok);
ok('a short with a trailed stop is NOT flagged', geometryCheck({ side: 'short', entry: 100, stop: 96, targets: [70] }).ok);
ok('no entry yet, nothing to check', geometryCheck({ side: 'short', stop: 110 }).ok);
ok('an unreadable side is itself the error', !geometryCheck({ side: 'sideways', entry: 100 }).ok);

// ── the broker's sign IS the direction ───────────────────────────────────────
// IBKR reports a short as a negative quantity, and every reconciliation comparison in lib/flex.js
// takes Math.abs() of it — correct while only longs existed, and precisely where a broker-sourced
// short would have entered the console as a long and computed backwards ever after.
{
  const { rowFromPosition } = await import('../lib/flex.js');
  const shortRow = rowFromPosition({ symbol: 'SPY', qty: -300, costBasisPrice: 500, openDate: '2026-08-01' }, { today: '2026-09-05' });
  const longRow  = rowFromPosition({ symbol: 'SPY', qty:  300, costBasisPrice: 500, openDate: '2026-08-01' }, { today: '2026-09-05' });
  eq('a negative IBKR quantity becomes a SHORT row', shortRow.side, 'short');
  eq('and its opening fill is a sell', shortRow.fills[0].side, 'sell');
  eq('at the magnitude, which is what reconciles', shortRow.fills[0].qty, 300);
  eq('a positive quantity is unchanged', [longRow.side, longRow.fills[0].side], ['long', 'buy']);
  // End to end: the row it builds must derive as a real short.
  const d = derivePosition(shortRow.fills, { side: shortRow.side });
  eq('and it derives as 300 short at 500', [d.qty, d.avgCost, d.side], [300, 500, 'short']);
  ok('marked at 450 it is UP', positionPnl(d, 450).unrealizedPct > 0);
}

// ── every existing long row is untouched ─────────────────────────────────────
// The migration is silent: rows written before `side` existed have no such field, and must derive
// byte-identically to how they did. This is the assertion that makes the change safe to deploy.
const legacyFills = [
  { side: 'buy',  qty: 200, price: 18.06, date: '2026-03-02' },
  { side: 'sell', qty: 80,  price: 20.05, date: '2026-05-11' },
  { side: 'buy',  qty: 100, price: 19.10, date: '2026-06-01' },
];
eq('a row with no side derives exactly as an explicit long',
   JSON.stringify(derivePosition(legacyFills)), JSON.stringify(derivePosition(legacyFills, { side: 'long' })));
eq('and its P&L is identical',
   JSON.stringify(positionPnl(derivePosition(legacyFills), 21)),
   JSON.stringify(positionPnl(derivePosition(legacyFills, { side: 'long' }), 21)));

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
