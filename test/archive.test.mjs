// test/archive.test.mjs — the archive at a length that does not grow without bound.
//
// 21 closed trades fit on a screen. 300 do not, and the flat list gets worse the longer it runs:
// it answers "what did I close most recently" and nothing else. Periods carry subtotals, so the
// shape of a whole history is legible as headers without rendering a single row.
import { periodKey, periodLabel, summarise, archivePeriods, hiddenSummary, OPEN_PERIODS } from '../lib/archive.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const row = (lastDate, realized, realizedPct = null, extra = {}) =>
  ({ derived: { lastDate, realized, realizedPct }, ...extra });

// ── THE KEY IS THE SORT ORDER ────────────────────────────────────────────────
// Lexicographic on purpose: sorting the keys sorts the periods, so no date arithmetic is needed
// anywhere else and no timezone can move a trade into the wrong month.
eq('a month key', periodKey('2026-09-04'), '2026-09');
eq('a quarter key', periodKey('2026-09-04', 'quarter'), '2026-Q3');
eq('the quarter boundaries land right',
   ['2026-01-31', '2026-03-31', '2026-04-01', '2026-12-31'].map(d => periodKey(d, 'quarter')),
   ['2026-Q1', '2026-Q1', '2026-Q2', '2026-Q4']);
eq('a year key', periodKey('2026-09-04', 'year'), '2026');
eq('a date with a time still parses', periodKey('2026-09-04T23:00:00Z'), '2026-09');
eq('and nothing is no period, rather than a wrong one',
   [periodKey(null), periodKey(''), periodKey('nonsense'), periodKey(undefined)], [null, null, null, null]);
eq('keys sort chronologically as strings',
   ['2026-01', '2025-12', '2026-10', '2026-02'].sort(), ['2025-12', '2026-01', '2026-02', '2026-10']);

eq('a month reads as a month', periodLabel('2026-09'), 'September 2026');
eq('a quarter as a quarter', periodLabel('2026-Q3', 'quarter'), '2026 Q3');
eq('a year as itself', periodLabel('2026', 'year'), '2026');

// ── `valueOf` IS INHERITED, AND THAT ATE THE FIRST VERSION ───────────────────
// The accessor was called `valueOf` and destructured out of an options object with a default. The
// default never applied: EVERY object inherits valueOf from Object.prototype, so `{}.valueOf` is
// that function rather than undefined, and the archive summed Object.prototype.valueOf over its
// rows. It threw on the first call, which is the argument for making one. `toString`, `constructor`
// and `hasOwnProperty` are the same trap.
{
  const inherited = ['valueOf', 'toString', 'constructor', 'hasOwnProperty', 'isPrototypeOf'];
  ok('the trap is real — these are all truthy on a bare object', inherited.every(k => ({})[k]));
  // So no option this module accepts may be named one of them.
  const opts = ['grain', 'dateOf', 'realisedOf', 'open'];
  eq('and no option name collides with one', opts.filter(o => inherited.includes(o)), []);
  // Proof the default now applies: called with an empty options object, the subtotal is right.
  eq('an empty options object still gets the default accessor',
     archivePeriods([row('2026-09-04', 60)], {})[0].stats.realised, 60);
  eq('and so does no options object at all', archivePeriods([row('2026-09-04', 60)])[0].stats.realised, 60);
}

// ── SUBTOTALS ────────────────────────────────────────────────────────────────
{
  const s = summarise([row('2026-09-01', 475, 1.06), row('2026-09-04', 60, 0.1), row('2026-08-27', -2420, -2.69)]);
  eq('the realised total', s.realised, -1885);
  eq('wins and losses', [s.wins, s.losses], [2, 1]);
  eq('the win rate', s.winRate, 67);
  eq('and the average return, which a total cannot say', s.avgPct, -0.51);
  // A FLAT trade is neither, so wins and losses need not sum to the count. A book that closes at
  // scratch is common and reporting it as a loss would be a lie in the direction that flatters.
  const flat = summarise([row('2026-09-01', 0, 0), row('2026-09-02', 10, 1)]);
  eq('a scratch is neither a win nor a loss', [flat.wins, flat.losses, flat.count], [1, 0, 2]);
  eq('nothing is nothing, not zero-over-zero', summarise([]).winRate, null);
  eq('and an empty total is zero', summarise([]).realised, 0);
}

// ── AN UNCONVERTED ROW IS COUNTED, NOT ADDED ─────────────────────────────────
// The archive's own rule: a HKD figure summed into a USD total is not a small error, it is a
// different number. The subtotals have to follow it or they will disagree with the total above them.
{
  const rows = [row('2026-09-01', 100), row('2026-09-02', 8989, null, { currency: 'HKD' })];
  const inBase = (r) => (r.currency === 'HKD' ? null : r.derived.realized);   // no rate for HKD
  const s = summarise(rows, inBase);
  eq('the unconvertible row is left out of the total', s.realised, 100);
  eq('but counted so its absence is visible', [s.count, s.counted, s.unconverted], [2, 1, 1]);
  ok('and never added at face value in the wrong unit', s.realised !== 9089);
}

// ── PERIODS ──────────────────────────────────────────────────────────────────
{
  const rows = [row('2026-09-04', 60, 0.1), row('2026-09-01', 475, 1.06), row('2026-08-27', -2420, -2.69),
                row('2026-07-30', -480, -20), row('2026-06-09', -222, -81.11)];
  const ps = archivePeriods(rows);
  eq('newest period first', ps.map(p => p.key), ['2026-09', '2026-08', '2026-07', '2026-06']);
  eq('every row is in exactly one', ps.reduce((n, p) => n + p.rows.length, 0), rows.length);
  eq('subtotals per period', ps.map(p => p.stats.realised), [535, -2420, -480, -222]);
  // The subtotals must reconstruct the total, or the archive contradicts itself.
  eq('and they sum to the whole', +ps.reduce((a, p) => a + p.stats.realised, 0).toFixed(2),
     summarise(rows).realised);

  // WINDOWED BY PERIOD, NOT BY TRADE COUNT. "Show the last 20" lands mid-month, and a header
  // reading "August · 9 trades · +$1,240" above four rows is a subtotal contradicting what is
  // under it. Periods are whole or absent.
  eq('the most recent few are open', ps.map(p => p.open), [true, true, true, false]);
  eq('which is the documented default', ps.filter(p => p.open).length, OPEN_PERIODS);
  ok('but every period is still listed, so the shape of the history is visible',
     ps.length === 4 && ps.every(p => p.label && p.stats));
  // The collapsed remainder is summarised in one line rather than silently dropped.
  const h = hiddenSummary(ps);
  eq('the hidden remainder is described', [h.periods, h.count, h.realised], [1, 1, -222]);
  eq('opening everything hides nothing', hiddenSummary(archivePeriods(rows, { open: Infinity })).periods, 0);
  eq('and closing everything hides all of it', hiddenSummary(archivePeriods(rows, { open: 0 })).periods, 4);
}

// ── A ROW WITH NO CLOSE DATE IS STILL A TRADE ────────────────────────────────
// Dropping it would make the subtotals disagree with the archive total — a discrepancy with no
// visible cause, which is the worst kind. It gets its own trailing group instead.
{
  const ps = archivePeriods([row('2026-09-04', 60), row(null, 10), row('', 5)]);
  eq('undated rows are grouped, not dropped', ps.map(p => p.key), ['2026-09', 'undated']);
  eq('and both of them are in it', ps[1].rows.length, 2);
  eq('the group says what it is', ps[1].label, 'No close date');
  eq('it sorts last, whatever the dates', ps[ps.length - 1].key, 'undated');
  eq('and nothing is lost', ps.reduce((n, p) => n + p.rows.length, 0), 3);
}

// ── GRAIN ────────────────────────────────────────────────────────────────────
// Five years of monthly headers is sixty lines; by quarter it is twenty. The grain is what keeps
// the header list itself from becoming the thing that is too long.
{
  const rows = ['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05', '2025-11-05'].map(d => row(d, 100));
  eq('by month', archivePeriods(rows, { grain: 'month' }).length, 5);
  eq('by quarter', archivePeriods(rows, { grain: 'quarter' }).map(p => p.key), ['2026-Q2', '2026-Q1', '2025-Q4']);
  eq('by year', archivePeriods(rows, { grain: 'year' }).map(p => p.key), ['2026', '2025']);
  // Whatever the grain, the rows are all still there and the subtotals still sum to the total.
  for (const grain of ['month', 'quarter', 'year']) {
    const ps = archivePeriods(rows, { grain });
    eq(`${grain} keeps every row`, ps.reduce((n, p) => n + p.rows.length, 0), rows.length);
    eq(`${grain} subtotals sum to the total`, ps.reduce((a, p) => a + p.stats.realised, 0), summarise(rows).realised);
  }
}

// An empty archive renders nothing rather than a header over nothing.
eq('empty stays empty', archivePeriods([]), []);
eq('and summarises to zero without dividing by it', hiddenSummary([]).realised, 0);

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
