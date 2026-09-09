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

// ── ONE CONTRACT, NOT ONE TICKER ─────────────────────────────────────────────
// Grouped by ROOT, this was wrong in the most expensive way available: it reported a number.
//
// Taken from the real statement of 2026-09-08. Every QQQ option strike, every expiry, and QQQ the
// ETF share line collapsed into one "position" keyed "QQQ", so a 15-lot put bought at 6.82 was
// closed against a 12-lot sale at 730.55 — the ETF price. One "+$7,250 trade at +7090%", an
// oversell the average-cost engine silently clamped, and 89% of the reported total.
{
  const OBSERVED = [
    { tradeId: '72296876:908901568', root: 'QQQ', symbol: 'QQQ 260810P00719000', assetCategory: 'OPT', multiplier: 100, side: 'buy', qty: 15, price: 6.816903, date: '2026-08-12', commission: 5 },
    { tradeId: '72372238:908901568', root: 'QQQ', symbol: 'QQQ 260810P00719000', assetCategory: 'OPT', multiplier: 100, side: 'sell', qty: 5, price: 9.372801, date: '2026-08-13', commission: 5 },
    { tradeId: '72524399:320227571', root: 'QQQ', symbol: 'QQQ', assetCategory: 'STK', multiplier: 1, side: 'sell', qty: 12, price: 730.551417, date: '2026-08-14', commission: 5 },
  ];
  const r = run([], OBSERVED);
  eq('the option and the ETF are two contracts', r.trips.length + r.leftovers.length, 2);
  const keys = [...r.trips, ...r.leftovers].map(x => x.key).sort();
  eq('keyed by contract id, not by ticker', keys, ['320227571', '908901568']);
  // THE NUMBER THAT MUST NEVER COME BACK.
  ok('no seven-thousand-dollar phantom', ![...r.trips, ...r.leftovers].some(x => x.pnl > 7000));
  ok('and nothing claims a 7090% return', ![...r.trips, ...r.leftovers].some(x => (x.pnlPct ?? 0) > 1000));
  // The put is still open on ten — it was never closed, and pairing it with a share sale is what
  // made it look closed.
  const opt = [...r.trips, ...r.leftovers].find(x => x.key === '908901568');
  eq('the option is open, not closed', opt.status, 'open');
  eq('and carries its own multiplier', opt.multiplier, 100);
  const shares = [...r.trips, ...r.leftovers].find(x => x.key === '320227571');
  eq('the share line is its own row', shares.kind, 'shares');
  eq('at x1', shares.multiplier, 1);
  eq('and read short, since it opened on a sell', shares.side, 'short');
}

// ── THE CONTRACT MULTIPLIER ──────────────────────────────────────────────────
// Not passed at all. An option controls 100 shares and a micro gold future ten ounces, so every
// P&L on the list was reported at x1 and looked exactly as confident as a correct figure. The MGC
// round trip on the real statement read $170.91 against a true $1,709.08.
{
  const mgc = run([], [
    { tradeId: '72650051:744880158', root: 'MGC', symbol: 'MGCV6', assetCategory: 'FUT', multiplier: 10, side: 'buy', qty: 1, price: 4442.796, date: '2026-08-17', commission: 1 },
    { tradeId: '73569665:744880158', root: 'MGC', symbol: 'MGCV6', assetCategory: 'FUT', multiplier: 10, side: 'sell', qty: 1, price: 4613.704, date: '2026-08-26', commission: 1 },
  ]);
  eq('a futures P&L is scaled by its multiplier', mgc.trips[0].pnl, 1709.08);
  eq('and the multiplier is reported', mgc.trips[0].multiplier, 10);
  ok('not the x1 figure it used to give', mgc.trips[0].pnl !== 170.91);

  const opt = run([], [
    { tradeId: 'A:111', root: 'BNO', symbol: 'BNO 261016C00058000', assetCategory: 'OPT', multiplier: 100, side: 'buy', qty: 8, price: 2.799403, date: '2026-09-01', commission: 5 },
    { tradeId: 'B:111', root: 'BNO', symbol: 'BNO 261016C00058000', assetCategory: 'OPT', multiplier: 100, side: 'sell', qty: 8, price: 2.503013, date: '2026-09-04', commission: 5 },
  ]);
  eq('an option likewise', opt.trips[0].pnl, -237.11);
  // Shares are x1 and must not change.
  const sh = run([], [
    { tradeId: 'A:222', root: 'TQQQ', symbol: 'TQQQ', assetCategory: 'STK', multiplier: 1, side: 'buy', qty: 300, price: 74.293003, date: '2026-08-10', commission: 2 },
    { tradeId: 'B:222', root: 'TQQQ', symbol: 'TQQQ', assetCategory: 'STK', multiplier: 1, side: 'sell', qty: 300, price: 73.958278, date: '2026-08-10', commission: 2 },
  ]);
  eq('shares are unchanged at x1', sh.trips[0].pnl, -100.42);
  // A missing multiplier falls back to 1 rather than to NaN, which would poison every total.
  const bare = run([], [
    { tradeId: 'A:333', root: 'X', symbol: 'X', side: 'buy', qty: 10, price: 100, date: '2026-06-01' },
    { tradeId: 'B:333', root: 'X', symbol: 'X', side: 'sell', qty: 10, price: 110, date: '2026-06-02' },
  ]);
  eq('a missing multiplier is 1, not NaN', bare.trips[0].pnl, 100);
}

// ── A CLAMPED OVERSELL IS NOT A RESULT ───────────────────────────────────────
// The average-cost engine clamps a close larger than the open position and warns. That warning
// lived inside the deriver where nobody saw it, while the clamped segment produced the largest
// "profit" on the list.
{
  const r = run([], [
    { tradeId: 'A:1', root: 'X', symbol: 'X', multiplier: 1, side: 'buy', qty: 10, price: 100, date: '2026-06-01' },
    { tradeId: 'B:1', root: 'X', symbol: 'X', multiplier: 1, side: 'sell', qty: 25, price: 110, date: '2026-06-02' },
  ]);
  const row = [...r.trips, ...r.leftovers][0];
  ok('the clamp is reported on the row', Array.isArray(row.warnings) && row.warnings.length > 0);
  ok('and says what it was', /clos|sell|more/i.test(row.warnings.join(' ')));
  // A clean segment carries no warnings field at all, so its presence is the signal.
  const clean = run([], [
    { tradeId: 'A:2', root: 'Y', symbol: 'Y', multiplier: 1, side: 'buy', qty: 10, price: 100, date: '2026-06-01' },
    { tradeId: 'B:2', root: 'Y', symbol: 'Y', multiplier: 1, side: 'sell', qty: 10, price: 110, date: '2026-06-02' },
  ]);
  eq('a clean trip has none', clean.trips[0].warnings, undefined);
}

// Two contracts under one root that never interleave must still be two rows — the old grouping
// happened to get MGC and AVGO right by luck, because their segments did not overlap in time.
// Luck is not a rule.
{
  const r = run([], [
    { tradeId: 'A:100', root: 'AVGO', symbol: 'AVGO 260828C00360000', multiplier: 100, side: 'buy', qty: 10, price: 2.554173, date: '2026-08-26' },
    { tradeId: 'B:200', root: 'AVGO', symbol: 'AVGO 261016C00400000', multiplier: 100, side: 'buy', qty: 10, price: 16.006833, date: '2026-08-26' },
    { tradeId: 'C:100', root: 'AVGO', symbol: 'AVGO 260828C00360000', multiplier: 100, side: 'sell', qty: 10, price: 4.583004, date: '2026-08-27' },
    { tradeId: 'D:200', root: 'AVGO', symbol: 'AVGO 261016C00400000', multiplier: 100, side: 'sell', qty: 10, price: 12.0, date: '2026-08-28' },
  ]);
  eq('interleaved contracts stay separate', r.trips.length, 2);
  eq('each with its own key', r.trips.map(t => t.key).sort(), ['100', '200']);
  // Merged, these would net to a single number and hide that one won and one lost.
  ok('one won', r.trips.some(t => t.pnl > 0));
  ok('and one lost', r.trips.some(t => t.pnl < 0));
  eq('so the win rate is 50', r.totals.winRate, 50);
}

// No conid on the id: the full contract SYMBOL is the fallback, which still separates strikes.
{
  const r = run([], [
    { tradeId: 'A', root: 'SPY', symbol: 'SPY 260918C00700000', multiplier: 100, side: 'buy', qty: 1, price: 5, date: '2026-06-01' },
    { tradeId: 'B', root: 'SPY', symbol: 'SPY 260918C00750000', multiplier: 100, side: 'buy', qty: 1, price: 2, date: '2026-06-01' },
  ]);
  eq('strikes separate without a conid', r.leftovers.length, 2);
  eq('keyed by the contract symbol', r.leftovers.map(x => x.key).sort(),
    ['SPY 260918C00700000', 'SPY 260918C00750000']);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
