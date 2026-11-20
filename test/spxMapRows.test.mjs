// test/spxMapRows.test.mjs — the Daily Read's S&P map rows (lib/spMap.js spxMapRows), in the shape its
// writer used to build from CBOE chains: meta, then the strongest SPX nodes within ±3%, then SPX gamma
// in SPY $1 buckets. Made-up numbers only.
import { spxMapRows } from '../lib/spMap.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

const spxDash = { meta: { spot: 5000, as_of_utc: '2030-01-02T14:00:00Z', mode: 'live_recompute' },
  levels: [{ key: 'flip', strike: 5050, usable: true }, { key: 'net', gamma_bn: -12.34 }],
  ladder: [5200, 5100, 5060, 5050, 5040, 5030, 5020, 5000, 4980, 4950, 4900, 4800].map((k, i) => ({ strike: k, gamma_mn: [999, 300, 250, 200, 150, 100, 50, -400, -50, -600, -700, -900][i] })) };
const spyDash = { meta: { spot: 500 } };
const m = { ok: true, ratio: 0.1, es_basis: 20, spx_ladder_spy: [{ spy_strike: 498, gamma_mn: -100.4 }, { spy_strike: 502, gamma_mn: 55.6 }] };
const out = spxMapRows(m, spxDash, spyDash, { now: new Date('2030-01-02T14:05:00Z') });
const meta = out.rows[0];
eq('meta first, with spots, ratio, ES and its basis', [meta.kind, meta.spx_spot, meta.spy_spot, meta.ratio, meta.es, meta.es_basis], ['meta', 5000, 500, 0.1, 5020, 20]);
eq('net gamma and the flip in both books', [meta.net_bn, meta.flip_spx, meta.flip_spy, meta.flip_usable], [-12.3, 5050, 505, true]);
const nodes = out.rows.filter(r => r.kind === 'node');
eq('five positive then three negative nodes, inside ±3% only', nodes.map(n => n.spx_strike), [5100, 5060, 5050, 5040, 5030, 4900, 4950, 5000]);
eq('a node carries its SPY and ES equivalents', [nodes[0].spy_eq, nodes[0].es_eq, nodes[0].gamma_mn, nodes[0].sign], [510, 5120, 300, 'pos']);
eq('buckets in SPY strikes, highest first, rounded', out.rows.filter(r => r.kind === 'bucket'), [{ kind: 'bucket', spy_strike: 502, gamma_mn: 56 }, { kind: 'bucket', spy_strike: 498, gamma_mn: -100 }]);
eq('no map, no rows', spxMapRows({ ok: false, reason: 'no SPX board' }, null, null).ok, false);
console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
if (fail) process.exit(1);
