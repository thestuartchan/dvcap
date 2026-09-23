// test/lifecycle.test.mjs — one card, one state (console rework, Step 3).
//
// The brief's acceptance, as the engine sees it: a new SOFI setup takes 500 @ 16.675 and is OPEN
// with no confirm; sell 200 @ 19.25 leaves 300 open with realised shown; sell 300 @ 18.90 closes
// it with realised frozen and, after 24 hours, it is in the Archive; Restore brings it back to
// CLOSED, not OPEN; a fill with no thesis is held, not recorded.
import { stateOf, afterFill, thesisOk, byState, archivePatch, restorePatch, hoursToArchive, isReadOnly, STATES, TABS, ARCHIVE_AFTER_MS, ENGINE_STATUS, THESIS_MIN_WORDS } from '../lib/lifecycle.js';
import { derivePosition } from '../lib/positions.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const T0 = Date.parse('2026-09-24T14:00:00Z');
const row = (fills, extra = {}) => ({ id: 'sofi', symbol: 'SOFI', side: 'long', fills, derived: derivePosition(fills, { side: 'long' }), ...extra });
const BUY = { id: 'b', date: '2026-09-24', side: 'buy', qty: 500, price: 16.675 };
const SELL1 = { id: 's1', date: '2026-09-25', side: 'sell', qty: 200, price: 19.25 };
const SELL2 = { id: 's2', date: '2026-09-26', side: 'sell', qty: 300, price: 18.90 };

// ── THE FOUR STATES ──────────────────────────────────────────────────────────
{
  eq('the four states, in order', STATES, ['WATCHING', 'OPEN', 'CLOSED', 'ARCHIVED']);
  eq('four tabs, same order', TABS.map(t => t.id), STATES);
  eq('archive after 24 hours', ARCHIVE_AFTER_MS, 86400000);
  eq('the engine words', ENGINE_STATUS, { WATCHING: 'setup', OPEN: 'open', CLOSED: 'closed', ARCHIVED: 'closed' });
  eq('a row with no fills is WATCHING', stateOf(row([])), 'WATCHING');
  eq('a row with no derivation at all is WATCHING', stateOf({}), 'WATCHING');
  // The first fill moves it, by itself.
  const opened = row([BUY]);
  eq('the first buy makes it OPEN — no confirm', stateOf(opened), 'OPEN');
  eq('500 at 16.675', [opened.derived.qty, opened.derived.avgCost], [500, 16.675]);
  // Sell 200 @ 19.25: 300 remain, realised shown, still OPEN.
  const partial = row([BUY, SELL1]);
  eq('sell 200 leaves 300 and stays OPEN', [stateOf(partial), partial.derived.qty], ['OPEN', 300]);
  eq('realised (19.25 − 16.675) × 200', partial.derived.realized, 515);
  ok('and the card says it is partially realised', partial.derived.partiallyRealised);
  // Sell 300 @ 18.90: flat, CLOSED, realised frozen.
  const flat = row([BUY, SELL1, SELL2], { closedAt: new Date(T0).toISOString() });
  eq('sell 300 closes it', stateOf(flat, { now: T0 }), 'CLOSED');
  eq('realised frozen at 515 + (18.90 − 16.675) × 300', flat.derived.realized, 1182.5);
  eq('and it is CLOSED for the next 24 hours', stateOf(flat, { now: T0 + ARCHIVE_AFTER_MS - 1 }), 'CLOSED');
  eq('then ARCHIVED by itself', stateOf(flat, { now: T0 + ARCHIVE_AFTER_MS }), 'ARCHIVED');
  eq('hours left, one decimal', hoursToArchive(flat, { now: T0 + 6 * 3600000 }), 18);
  eq('no hours once archived', hoursToArchive(flat, { now: T0 + 2 * ARCHIVE_AFTER_MS }), null);
  eq('a closed row from before the stamp existed is archived', stateOf(row([BUY, SELL1, SELL2])), 'ARCHIVED');
  ok('archived is the read-only state, and the only one', isReadOnly('ARCHIVED') && !isReadOnly('CLOSED') && !isReadOnly('OPEN') && !isReadOnly('WATCHING'));
}

// ── RESTORE → CLOSED, ARCHIVE BY HAND ────────────────────────────────────────
{
  const old = row([BUY, SELL1, SELL2], { closedAt: '2026-08-01T00:00:00Z' });
  eq('an old close is archived', stateOf(old, { now: T0 }), 'ARCHIVED');
  const restored = { ...old, ...restorePatch({ now: '2026-09-24T14:00:00Z' }) };
  eq('Restore reopens it as CLOSED, not OPEN', stateOf(restored, { now: T0 }), 'CLOSED');
  eq('and it stays CLOSED past the 24 hours — a hand decision does not expire', stateOf(restored, { now: T0 + 3 * ARCHIVE_AFTER_MS }), 'CLOSED');
  eq('the restore is dated', restored.restoredAt, '2026-09-24T14:00:00Z');
  const fresh = row([BUY, SELL1, SELL2], { closedAt: new Date(T0).toISOString() });
  eq('archived by hand goes now', stateOf({ ...fresh, ...archivePatch() }, { now: T0 }), 'ARCHIVED');
  eq('no archive countdown once restored', hoursToArchive(restored, { now: T0 }), null);
}

// ── WHAT A FILL CHANGES ──────────────────────────────────────────────────────
{
  const d = (fills) => derivePosition(fills, { side: 'long' });
  eq('setup → open changes nothing else', afterFill(d([]), d([BUY])), {});
  eq('open → open (a partial) changes nothing else', afterFill(d([BUY]), d([BUY, SELL1])), {});
  eq('open → closed stamps the clock and clears any hand decision', afterFill(d([BUY, SELL1]), d([BUY, SELL1, SELL2]), { now: '2026-09-26T15:00:00Z' }), { closedAt: '2026-09-26T15:00:00Z', archived: null });
  eq('closed → open (a re-entry) clears the stamp', afterFill(d([BUY, SELL1, SELL2]), d([BUY, SELL1, SELL2, { ...BUY, id: 'b2', date: '2026-09-27' }])), { closedAt: null, archived: null });
  // Deleting the closing fill reopens the row the same way.
  eq('deleting the closing fill reopens it', afterFill(d([BUY, SELL1, SELL2]), d([BUY, SELL1])), { closedAt: null, archived: null });
}

// ── THE THESIS IS REQUIRED ───────────────────────────────────────────────────
{
  eq('three words', THESIS_MIN_WORDS, 3);
  ok('one sentence passes', thesisOk('Accumulate on a pullback to the 200-day.'));
  ok('three words pass', thesisOk('buy the dip'));
  ok('a ticker does not', !thesisOk('SOFI'));
  ok('two words do not', !thesisOk('fintech rerate'));
  ok('nothing does not', !thesisOk('') && !thesisOk(null) && !thesisOk('   '));
  ok('punctuation is not a word', !thesisOk('- - -'));
}

// ── THE TABS ─────────────────────────────────────────────────────────────────
{
  const rows = [
    { id: 'w', derived: derivePosition([], { side: 'long' }) },
    { id: 'o', derived: derivePosition([BUY], { side: 'long' }) },
    { id: 'c1', closedAt: new Date(T0 - 3600000).toISOString(), derived: { ...derivePosition([BUY, SELL1, SELL2], { side: 'long' }), lastDate: '2026-09-26' } },
    { id: 'c2', closedAt: new Date(T0 - 7200000).toISOString(), derived: { ...derivePosition([BUY, SELL1, SELL2], { side: 'long' }), lastDate: '2026-09-27' } },
    { id: 'a', closedAt: '2026-06-01T00:00:00Z', derived: { ...derivePosition([BUY, SELL1, SELL2], { side: 'long' }), lastDate: '2026-06-01' } },
    { id: 'legacy', derived: { ...derivePosition([BUY, SELL1, SELL2], { side: 'long' }), lastDate: '2026-07-01' } },
  ];
  const t = byState(rows, { now: T0 });
  eq('watching', t.WATCHING.map(r => r.id), ['w']);
  eq('open', t.OPEN.map(r => r.id), ['o']);
  eq('closed, most recent close first', t.CLOSED.map(r => r.id), ['c2', 'c1']);
  eq('archive, most recent close first', t.ARCHIVED.map(r => r.id), ['legacy', 'a']);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
