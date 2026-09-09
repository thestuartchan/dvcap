// test/unrecorded.test.mjs — everything the console never saw.
//
// The console is deliberately a SWING book: day trades, scalps, options and cash legs are filtered
// out on the way in, counted, and thrown away. That filtering is lossy by design, which left the
// question "what did all the trading that never reached the book actually do" with no answer
// anywhere in the system — `skipped.dayTrades` is an integer and nothing else survives.
//
// This is READ ONLY and writes nothing. The tests below are mostly about the two ways a summary
// like this lies: cutting round trips in the wrong place, and scoring positions that are still open.
import { unrecordedTrades } from '../lib/flexTrades.js';
import { splitIntoTrades, derivePosition } from '../lib/positions.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const DEPS = { splitIntoTrades, derivePosition };
const T = (tradeId, root, side, qty, price, date, commission = 1) =>
  ({ tradeId, root, symbol: root, side, qty, price, date, commission });
const run = (rows, trades, opts = {}) => unrecordedTrades(rows, trades, { ...DEPS, ...opts });

// ── the console's own trades are excluded, by id ─────────────────────────────
{
  const rows = [{ symbol: 'ARM', fills: [{ tradeId: 'T1', side: 'buy', qty: 8, price: 321.855, date: '2026-06-10' }] }];
  const r = run(rows, [
    T('T1', 'ARM', 'buy', 8, 321.855, '2026-06-10'),
    T('T2', 'TQQQ', 'buy', 100, 70, '2026-06-12'),
    T('T3', 'TQQQ', 'sell', 100, 72, '2026-06-12'),
  ]);
  eq('a trade the console holds is excluded', r.excluded.alreadyInConsole, 1);
  eq('and does not appear as unrecorded', r.trips.filter(t => t.root === 'ARM').length, 0);
  ok('while the ones it never saw do', r.trips.some(t => t.root === 'TQQQ'));
  // Matched on TRADE ID, not symbol — a console row in a symbol does not swallow every other
  // trade in that symbol, which is the whole point of tracking scalps separately from a swing.
  const alsoScalped = run(rows, [
    T('T1', 'ARM', 'buy', 8, 321.855, '2026-06-10'),
    T('T9', 'ARM', 'buy', 5, 300, '2026-07-01'), T('T10', 'ARM', 'sell', 5, 310, '2026-07-01'),
  ]);
  eq('a scalp in a symbol the console holds is still unrecorded', alsoScalped.trips.length, 1);
  eq('and its P&L is its own', alsoScalped.trips[0].pnl, 50);
}

// ── round trips are cut where the position goes flat ─────────────────────────
// Buy 200, sell 200, buy 600 three weeks later is TWO trades that share a ticker. Getting this
// boundary wrong is how a win rate becomes fiction — one combined "trade" would net a win against
// a loss and report neither.
{
  const r = run([], [
    T('A', 'TQQQ', 'buy', 100, 70, '2026-06-12'), T('B', 'TQQQ', 'sell', 100, 72, '2026-06-12'),
    T('C', 'TQQQ', 'buy', 50, 75, '2026-07-01'),  T('D', 'TQQQ', 'sell', 50, 71, '2026-07-03'),
  ]);
  eq('two round trips, not one position', r.trips.length, 2);
  eq('the first is the winner', r.trips[0].pnl, 200);
  eq('the second the loser', r.trips[1].pnl, -200);
  eq('so the win rate is 50, not 100 or 0', r.totals.winRate, 50);
  eq('and the net is zero', r.totals.pnl, 0);
  // Same-day is FLAGGED, not filtered. The brief was everything the console missed, not only scalps.
  eq('the same-day trip is marked', r.trips[0].sameDay, true);
  eq('the two-day one is not', r.trips[1].sameDay, false);
  eq('and same-day trips are counted', r.totals.sameDayTrips, 1);
  eq('each trip carries its own fills', [r.trips[0].trades.length, r.trips[1].trades.length], [2, 2]);
  eq('with the dates it spanned', [r.trips[0].days, r.trips[1].days], [1, 2]);
}

// ── a position still open is NOT a result ────────────────────────────────────
// Averaging an open position into a win rate is counting a coin still in the air.
{
  const r = run([], [
    T('A', 'TQQQ', 'buy', 100, 70, '2026-06-12'), T('B', 'TQQQ', 'sell', 100, 72, '2026-06-12'),
    T('C', 'SOXL', 'buy', 10, 30, '2026-08-01'),
  ]);
  eq('the open one is held out of the trips', r.trips.length, 1);
  eq('and reported separately', r.leftovers.length, 1);
  eq('by name', r.leftovers[0].root, 'SOXL');
  eq('the totals count it as open', r.totals.stillOpen, 1);
  eq('and it does not touch the win rate', r.totals.winRate, 100);
  eq('nor the realised total', r.totals.pnl, 200);
}

// ── shorts ───────────────────────────────────────────────────────────────────
// A symbol first SOLD was opened short. Reading it long would invert the P&L on every one.
{
  const r = run([], [
    T('A', 'SPY', 'sell', 10, 600, '2026-06-12'), T('B', 'SPY', 'buy', 10, 590, '2026-06-13'),
  ]);
  eq('a symbol first sold is read short', r.trips[0].side, 'short');
  eq('and covering lower is a profit', r.trips[0].pnl, 100);
  const loser = run([], [
    T('A', 'SPY', 'sell', 10, 590, '2026-06-12'), T('B', 'SPY', 'buy', 10, 600, '2026-06-13'),
  ]);
  eq('covering higher is a loss', loser.trips[0].pnl, -100);
}

// ── the denominator ──────────────────────────────────────────────────────────
// A scratch is neither a win nor a loss. Counting it as a loss flatters nothing and as a win
// flatters everything, so it is excluded from the rate and reported on its own.
{
  const r = run([], [
    T('A', 'X', 'buy', 10, 100, '2026-06-01'), T('B', 'X', 'sell', 10, 110, '2026-06-02'),
    T('C', 'Y', 'buy', 10, 100, '2026-06-03'), T('D', 'Y', 'sell', 10, 100, '2026-06-04'),
    T('E', 'Z', 'buy', 10, 100, '2026-06-05'), T('F', 'Z', 'sell', 10, 90, '2026-06-06'),
  ]);
  eq('three trips', r.totals.closedTrades, 3);
  eq('one win, one loss, one scratch', [r.totals.wins, r.totals.losses, r.totals.scratches], [1, 1, 1]);
  eq('the scratch is out of the denominator', r.totals.winRate, 50);
  eq('averages are per side', [r.totals.avgWin, r.totals.avgLoss], [100, -100]);
  eq('the best is named', r.totals.best.root, 'X');
  eq('and the worst', r.totals.worst.root, 'Z');
}

// ── coverage is reported before anything computed inside it ──────────────────
// "All-time" means whatever the Flex Query was configured to return. A summary that silently
// covers six weeks when the reader believes it covers six months is worse than no summary.
{
  const r = run([], [
    T('A', 'X', 'buy', 10, 100, '2026-07-14'), T('B', 'X', 'sell', 10, 110, '2026-08-20'),
  ], { since: '2026-06-01' });
  eq('the window actually found is stated', [r.coverage.earliest, r.coverage.latest], ['2026-07-14', '2026-08-20']);
  eq('alongside what was asked for', r.coverage.requestedSince, '2026-06-01');
  eq('and how much the statement held', r.coverage.tradesInStatement, 2);

  // The since filter, and its own count — so a missing trade is legible as filtered rather than absent.
  const cut = run([], [
    T('A', 'X', 'buy', 10, 100, '2026-05-01'), T('B', 'X', 'sell', 10, 110, '2026-05-02'),
    T('C', 'Y', 'buy', 10, 100, '2026-07-01'), T('D', 'Y', 'sell', 10, 120, '2026-07-02'),
  ], { since: '2026-06-01' });
  eq('trades before the cutoff are dropped', cut.trips.length, 1);
  eq('the survivor is the later one', cut.trips[0].root, 'Y');
  eq('and the dropped ones are counted', cut.excluded.beforeSince, 2);
  eq('with no cutoff, everything is in', run([], [
    T('A', 'X', 'buy', 10, 100, '2026-05-01'), T('B', 'X', 'sell', 10, 110, '2026-05-02'),
  ]).trips.length, 1);
}

// ── grouping ─────────────────────────────────────────────────────────────────
{
  const r = run([], [
    T('A', 'X', 'buy', 10, 100, '2026-06-01'), T('B', 'X', 'sell', 10, 110, '2026-06-02'),
    T('C', 'X', 'buy', 10, 100, '2026-07-01'), T('D', 'X', 'sell', 10, 90, '2026-07-02'),
    T('E', 'Y', 'buy', 10, 100, '2026-07-05'), T('F', 'Y', 'sell', 10, 130, '2026-07-06'),
  ]);
  eq('by month, on the CLOSING date', Object.keys(r.byMonth), ['2026-06', '2026-07']);
  eq('june nets the winner', r.byMonth['2026-06'], { trades: 1, pnl: 100, wins: 1 });
  eq('july nets both', r.byMonth['2026-07'], { trades: 2, pnl: 200, wins: 1 });
  eq('by symbol too', r.bySymbol.X, { trades: 2, pnl: 0, wins: 1 });
  eq('and the other name', r.bySymbol.Y, { trades: 1, pnl: 300, wins: 1 });
  eq('commission is carried per trip', r.trips[0].commission, 2);
}

// ── degenerate input ─────────────────────────────────────────────────────────
{
  const empty = run([], []);
  eq('no trades is not a crash', empty.totals.closedTrades, 0);
  eq('and reports no window', [empty.coverage.earliest, empty.coverage.latest], [null, null]);
  eq('with a null win rate rather than a zero', empty.totals.winRate, null);
  eq('and no best or worst', [empty.totals.best, empty.totals.worst], [null, null]);
  eq('null arguments are handled', run(null, null).totals.closedTrades, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
