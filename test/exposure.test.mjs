// test/exposure.test.mjs — three numbers, never summed.
// The case this file exists for is the one that motivated replacing the heat spec: a book where
// the risk-to-stop figure is small and true, and almost all the exposure sits outside it.
import { riskCoverage, rowExposure, stopOf } from '../lib/exposure.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const row = (o) => ({ currency: 'USD', multiplier: 1, levels: [], ...o });
const stopped = (at) => [{ kind: 'stop', at }];

// ── one row ──────────────────────────────────────────────────────────────────
{
  const x = rowExposure(row({ symbol: 'A', derived: { qty: 100 }, livePrice: 50, levels: stopped(45) }));
  eq('notional is qty x price x multiplier', x.notional, 5000);
  eq('risk is the distance to the stop', x.riskBase, 500);
  eq('and the stop is found', [x.hasStop, x.stopAt], [true, 45]);
}
{
  // The multiplier is the P0 fix and it has to reach here too: a 10x contract at 4200 controls
  // 42,000, not 4,200.
  const x = rowExposure(row({ symbol: 'MGC', multiplier: 10, margined: true, derived: { qty: 1 }, livePrice: 4200 }));
  eq('notional scales by the multiplier', x.notional, 42000);
  eq('and the row is known to be margined', x.margined, true);
  const y = rowExposure(row({ symbol: 'MGC', multiplier: 10, derived: { qty: 1 }, livePrice: 4200, levels: stopped(4150) }));
  eq('so does risk-to-stop', y.riskBase, 500);
}
{
  const x = rowExposure(row({ symbol: 'B', derived: { qty: 100, avgCost: 20 } }));
  eq('with no live price it falls back to average cost', x.notional, 2000);
  const y = rowExposure(row({ symbol: 'B', derived: { qty: 100 } }));
  eq('with neither, notional is null rather than zero', y.notionalBase, null);
  eq('a flat row has no notional', rowExposure(row({ symbol: 'B', derived: { qty: 0 }, livePrice: 10 })).notional, null);
}
{
  // The qty/price overrides — asking about a fill that has not happened yet, which is what the
  // pre-trade panel needs.
  const x = rowExposure(row({ symbol: 'A', derived: { qty: 100 }, livePrice: 50 }), { qty: 150, price: 52 });
  eq('a hypothetical fill can be priced', x.notional, 7800);
}
{
  eq('a stop with no price is not a stop', stopOf(row({ levels: [{ kind: 'stop' }] })), null);
  eq('and neither is a target', stopOf(row({ levels: [{ kind: 'buy', at: 10 }] })), null);
  eq('no levels at all', stopOf(row({})), null);
  eq('an empty call does not throw', stopOf(null), null);
}
{
  // A pinned FX rate stops a finished trade drifting with spot, and must be honoured here too.
  const x = rowExposure(row({ symbol: '0981.HK', currency: 'HKD', derived: { qty: 1000 }, livePrice: 50, fxRate: 7.8 }));
  eq('notional stays in the quote currency', x.notional, 50000);
  eq('and the base figure uses the pinned rate', x.notionalBase, 6410.26);
}
{
  // A well-formed rates map always carries the base itself — ratesFrom() seeds { USD: 1 }.
  const rates = { USD: 1, HKD: 7.8375 };
  const x = rowExposure(row({ symbol: '0981.HK', currency: 'HKD', derived: { qty: 1000 }, livePrice: 50 }), { rates });
  eq('or the live rate when nothing is pinned', x.notionalBase, 6379.59);
  const y = rowExposure(row({ symbol: 'X', currency: 'ZZZ', derived: { qty: 10 }, livePrice: 10 }), { rates });
  eq('an unknown currency gives null, never a face-value figure in the wrong unit', y.notionalBase, null);
  // And a map missing the base leg converts nothing rather than passing the number through — the
  // failure convert() is built to make loud.
  const z = rowExposure(row({ symbol: '0981.HK', currency: 'HKD', derived: { qty: 1000 }, livePrice: 50 }), { rates: { HKD: 7.8375 } });
  eq('a rates map with no base leg refuses', z.notionalBase, null);
}

// ── the three numbers ────────────────────────────────────────────────────────
{
  // The shape of the actual book: one stopped row, several unstopped, futures at contract value.
  const rows = [
    row({ symbol: 'ARM',  derived: { qty: 100 }, livePrice: 340,  levels: stopped(300) }),
    row({ symbol: 'NTRA', derived: { qty: 50 },  livePrice: 210 }),
    row({ symbol: 'MGC',  multiplier: 10, margined: true, derived: { qty: 1 }, livePrice: 4250 }),
  ];
  const c = riskCoverage(rows, { equityBase: 200000 });
  eq('defined risk is only what the stops cover', c.defined.amount, 4000);
  eq('across the rows that have one', c.defined.rows, 1);
  eq('undefined exposure is the market value of the rest', c.undefined.amount, 53000);
  eq('and it is the bigger number by an order of magnitude', c.undefined.rows, 2);
  ok('by a lot', c.undefined.amount > c.defined.amount * 10);
  eq('gross notional counts everything at contract value', c.gross.amount, 87000);
  eq('futures are reported separately as well', [c.futures.amount, c.futures.rows], [42500, 1]);
  eq('each as a share of equity', [c.defined.pctOfEquity, c.undefined.pctOfEquity, c.gross.pctOfEquity], [2, 26.5, 43.5]);
}
{
  // The whole argument, stated as a test: the three do NOT add up, and must not be made to.
  const rows = [
    row({ symbol: 'A', derived: { qty: 100 }, livePrice: 100, levels: stopped(95) }),
    row({ symbol: 'B', derived: { qty: 100 }, livePrice: 100 }),
  ];
  const c = riskCoverage(rows, { equityBase: 100000 });
  eq('a stopped row contributes its RISK to defined', c.defined.amount, 500);
  eq('an unstopped one contributes its whole VALUE to undefined', c.undefined.amount, 10000);
  eq('and gross counts both at full value', c.gross.amount, 20000);
  ok('so defined + undefined is not gross, on purpose', c.defined.amount + c.undefined.amount !== c.gross.amount);
  ok('and the object says so in words', /not summed/.test(c.note));
}
{
  const c = riskCoverage([], { equityBase: 100000 });
  eq('an empty book is zero, not null', [c.defined.amount, c.undefined.amount, c.gross.amount], [0, 0, 0]);
  eq('with no rows anywhere', [c.defined.rows, c.undefined.rows, c.gross.rows], [0, 0, 0]);
}
{
  // Closed rows are not exposure.
  const rows = [row({ symbol: 'A', derived: { qty: 0 }, livePrice: 100 }), row({ symbol: 'B', derived: { qty: 10 }, livePrice: 100 })];
  eq('a flat row is out of every figure', riskCoverage(rows, { equityBase: 100000 }).gross.rows, 1);
}
{
  // A row the feed could not price must be counted, not silently dropped from every total.
  const rows = [row({ symbol: 'A', derived: { qty: 10 }, livePrice: 100 }), row({ symbol: 'MNQ', derived: { qty: 1 } })];
  const c = riskCoverage(rows, { equityBase: 100000 });
  eq('the unpriced row is counted', c.unpriced, 1);
  eq('and the priced one still totals correctly', c.gross.amount, 1000);
}
{
  const c = riskCoverage([row({ symbol: 'A', derived: { qty: 10 }, livePrice: 100 })], { equityBase: null });
  eq('with no equity the amounts still compute', c.gross.amount, 1000);
  eq('but the percentages refuse rather than divide by nothing', c.gross.pctOfEquity, null);
  eq('a zero equity likewise', riskCoverage([row({ symbol: 'A', derived: { qty: 10 }, livePrice: 100 })], { equityBase: 0 }).gross.pctOfEquity, null);
}
{
  eq('a non-array does not throw', riskCoverage(null, { equityBase: 1000 }).gross.rows, 0);
}

console.log(`\n${fail ? '❌' : '✅'} ${fail ? `${fail} FAILED, ` : 'ALL '}${pass} PASSED`);
process.exit(fail ? 1 : 0);
