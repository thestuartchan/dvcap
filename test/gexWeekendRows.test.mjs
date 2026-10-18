// test/gexWeekendRows.test.mjs — the Saturday-dated close rows folded into their Friday
// (lib/gexStore.js foldWeekendRows, migrateWeekendRows). P5, 18 Oct audit. Synthetic figures.
import { foldWeekendRows, migrateWeekendRows, SERIES_KEY, RAW_INDEX_KEY, RAW_KEY } from '../lib/gexStore.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

const open = (date, gex) => ({ date, vintage: 'open', asOf: `${date}T15:15:00Z`, spot: 100, gexUsd: gex, flipLevel: 99, callWall: 104, putWall: 95, close: null, expiryPeaks: [{ expiry: 'a' }] });
const sat = (date, gex) => ({ date, vintage: 'close', asOf: `${date}T00:10:00Z`, spot: 101, gexUsd: gex, flipLevel: 98, callWall: 105, putWall: 96, close: null, expiryPeaks: [{ expiry: 'b' }] });

// ── the fold ──
{
  const rows = [open('2026-10-15', 1), open('2026-10-16', 2), sat('2026-10-17', 3)];
  const { rows: out, moves } = foldWeekendRows(rows);
  eq('a Saturday close becomes its Friday\'s close overlay', moves, [{ from: '2026-10-17', to: '2026-10-16', how: 'overlaid' }]);
  eq('no weekend row is left', out.map(r => r.date), ['2026-10-15', '2026-10-16']);
  const fri = out[1];
  eq('Friday keeps its open figures as canonical', [fri.vintage, fri.gexUsd, fri.asOf], ['open', 2, '2026-10-16T15:15:00Z']);
  eq('and carries the close beside them', [fri.close.gexUsd, fri.close.flipLevel, fri.close.asOf], [3, 98, '2026-10-17T00:10:00Z']);
  eq('the walls follow the close, as on a weekday', fri.expiryPeaks, [{ expiry: 'b' }]);
  eq('the old date is kept for the record', fri.redatedFrom, '2026-10-17');
  eq('folding again changes nothing', foldWeekendRows(out).moves, []);
}
{
  const { rows, moves } = foldWeekendRows([open('2026-10-01', 1), sat('2026-10-03', 3)]);
  eq('with no Friday row, the Saturday row is re-dated to Friday', [moves[0].how, rows.map(r => [r.date, r.vintage, r.gexUsd])], ['redated', [['2026-10-01', 'open', 1], ['2026-10-02', 'close', 3]]]);
}
{
  const done = { ...open('2026-10-09', 1), close: { gexUsd: 9 } };
  const { rows, moves } = foldWeekendRows([done, sat('2026-10-10', 3)]);
  eq('a Friday that already has its close drops the duplicate', [moves[0].how, rows.length, rows[0].close.gexUsd], ['dropped', 1, 9]);
}
eq('a series with no weekend rows is returned as is', foldWeekendRows([open('2026-10-15', 1)]).moves.length, 0);
eq('a Sunday-dated row is Friday\'s too', foldWeekendRows([sat('2026-09-27', 1)]).rows[0].date, '2026-09-25');
eq('nothing in, nothing out', foldWeekendRows(undefined).rows, []);

// ── the stored copy ──
{
  const store = {
    [SERIES_KEY]: { QQQ: [open('2026-10-16', 2), sat('2026-10-17', 3)], SPY: [open('2026-10-16', 5)] },
    [RAW_INDEX_KEY]: ['QQQ:2026-10-16', 'QQQ:2026-10-17', 'SPY:2026-10-16'],
    [RAW_KEY('QQQ', '2026-10-16')]: { date: '2026-10-16', spot: 100, contracts: [{ k: 'open' }] },
    [RAW_KEY('QQQ', '2026-10-17')]: { date: '2026-10-17', spot: 101, contracts: [{ k: 'close' }] },
  };
  let writes = 0;
  const getJson = async (k) => store[k] ?? null;
  const setJson = async (k, v) => { writes++; store[k] = v; };
  const r = await migrateWeekendRows({ getJson, setJson });
  eq('the migration reports a count only', r, { folded: 1 });
  eq('the series is folded in storage', store[SERIES_KEY].QQQ.map(x => x.date), ['2026-10-16']);
  eq('the other symbol is untouched', store[SERIES_KEY].SPY.length, 1);
  eq('the close\'s raw chain now sits under Friday', [store[RAW_KEY('QQQ', '2026-10-16')].contracts[0].k, store[RAW_KEY('QQQ', '2026-10-16')].date], ['close', '2026-10-16']);
  eq('and the Saturday key is cleared', store[RAW_KEY('QQQ', '2026-10-17')], null);
  eq('the raw index no longer lists Saturday', store[RAW_INDEX_KEY], ['QQQ:2026-10-16', 'SPY:2026-10-16']);
  const before = writes;
  eq('a second run is a no-op', [await migrateWeekendRows({ getJson, setJson }), writes - before], [{ folded: 0 }, 0]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
