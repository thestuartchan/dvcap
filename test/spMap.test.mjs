// test/spMap.test.mjs — the S&P map: SPX gamma in SPY prices and ES equivalents (lib/spMap.js).
import { spxRatio, esBasis, spyEq, esEq, spMap, spMapBlock, dualLadder, spHeatGrid, RATIO_GAP_WARN_MIN, GREY_ZONE_PCT } from '../lib/spMap.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// ── the conversion (the brief's unit test) ──
const live = { spy: { price: 778.57, ts: 1791600000, session: 'open', date: '2026-10-12' }, spx: { price: 7811.54, ts: 1791600030, session: 'open', date: '2026-10-12' } };
const r = spxRatio(live);
eq('the ratio is SPY ÷ SPX at the same moment, never a fixed 10', [r.ratio, r.gapMin, r.warn], [0.09967, 1, false]);
eq('a known SPX strike converts with the ratio, 2dp', spyEq(7900, r.ratio), 787.39);
const b = esBasis({ es: { price: 7859.75, ts: 1791600010 }, spx: live.spx });
eq('the ES basis is ES front − SPX, both live', [b.basis, b.label], [48.21, 'live']);
eq('es_eq is the SPX level plus the live basis', esEq(7900, b.basis), 7948.21);
eq('reads more than five minutes apart: converted, and flagged with the gap',
  (({ warn, gapMin }) => [warn, gapMin])(spxRatio({ spy: { ...live.spy, ts: 1791600000 }, spx: { ...live.spx, ts: 1791600000 + 60 * (RATIO_GAP_WARN_MIN + 2) } })), [true, 7]);
const closed = spxRatio({ spy: { price: 778.57, ts: 1791576000, session: 'closed', date: '2026-10-09' }, spx: { price: 7811.54, ts: 1791581396, session: 'closed', date: '2026-10-09' } });
eq('outside the session, two closes of the same day are the same moment', [closed.ratio, closed.gapMin, closed.warn, closed.asof], [0.09967, 0, false, '2026-10-09 close']);
const shut = esBasis({ es: { price: 7866, ts: 1791810000 }, spx: { price: 7811.54, session: 'closed', date: '2026-10-09' }, atClose: { price: 7861.25, ts: 1791576000 } });
eq('SPX not printing: the last regular-session basis, labelled', [shut.basis, /last regular-session/.test(shut.label)], [49.71, true]);
eq('no price, no ratio — said, not guessed', spxRatio({ spy: { price: 0 }, spx: { price: 7800 } }).ratio, null);

// ── the map ──
const lad = (rows, near = '2026-10-12', monthly = '2026-10-16') => rows.map(([strike, g, nearMn = 0]) => ({ strike, gamma_mn: g, near_mn: nearMn, monthly_mn: 0, other_mn: g - nearMn, near_expiry: near, monthly_expiry: monthly }));
const spyDash = {
  meta: { spot: 778.57 },
  levels: [{ key: 'flip', strike: 776.36 }, { key: 'wall', strike: 780 }, { key: 'trap_near', strike: 772 }, { key: 'net', strike: null, gamma_bn: 6.1 }],
  ladder: lad([[787, 100], [780, 2200, 1500], [779, 860], [772, -630], [770, -200]]),
};
const spxDash = {
  meta: { spot: 7811.54 },
  levels: [{ key: 'flip', strike: 7744.25 }, { key: 'wall', strike: 7900 }, { key: 'trap_near', strike: 7700 }, { key: 'net', strike: null, gamma_bn: 99.8 }],
  ladder: lad([[7900, 10700], [7850, 7800], [7825, 7100], [7700, -3200], [7600, -3600], [7745, 200]]),
};
const m = spMap({ spyDash, spxDash, ratio: r, basis: b, today: '2026-10-12' });
const row = (label) => m.levels.find(x => x.label === label);
eq('the call wall: SPY 780 beside SPX\'s own wall 7900 → 787.39; ★ because SPX 7825 sits at 780', [row('Call wall').spy, row('Call wall').spx, row('Call wall').spx_spy_eq, row('Call wall').agreement], [780, 7900, 787.39, 'agree']);
eq('a wall that is mostly today\'s expiry says it rolls off', /68% today's expiry — rolls off at the close/.test(row('Call wall').note), true);
eq('an SPX top node with no SPY node near it is ◆ SPX-only', row('SPX 7900 — biggest S&P wall').agreement, 'spx_only');
eq('the biggest SPX negative is listed, converted', [row('SPX 7600 — largest SPX negative').spx_spy_eq, row('SPX 7600 — largest SPX negative').agreement], [757.49, 'spx_only']);
eq('an SPY level with no SPX node of size near it is SPY-only, not red', row('Near trapdoor').agreement, 'spy_only');
eq('both flips; more than 0.2% apart is a grey zone', [row('Flip').spy, row('Flip').spx_spy_eq, m.grey_zone.lo, m.grey_zone.hi, m.grey_zone.gap_pct > GREY_ZONE_PCT], [776.36, 771.87, 771.87, 776.36, true]);
eq('chips: both nets and SPX\'s share', [m.spy.net_bn, m.spx.net_bn, m.spx_share_pct], [6.1, 99.8, 94.24]);
const opp = spMap({ spyDash: { ...spyDash, ladder: lad([[787, -900], [780, 2200]]) }, spxDash, ratio: r, basis: b, today: '2026-10-12' });
eq('an SPX node with a qualifying SPY node of the OTHER sign disagrees', opp.levels.find(x => x.label.startsWith('SPX 7900')).agreement, 'disagree');

// ── the ladder in SPY $1 strikes, and the connector's block ──
eq('SPX gamma bucketed into SPY $1 strikes', m.spx_ladder_spy.map(x => [x.spy_strike, x.gamma_mn]), [[787, 10700], [782, 7800], [780, 7100], [772, 200], [767, 3200 * -1], [757, -3600]]);
const blk = spMapBlock(m);
eq('the block: the brief\'s keys, rows without the internal kind', [Object.keys(blk).filter(k => !k.startsWith('es_basis_label')), Object.keys(blk.levels[0])],
  [['ratio', 'ratio_asof', 'es_basis', 'es_basis_asof', 'levels', 'spx_ladder_spy'], ['label', 'spy', 'spx', 'spx_spy_eq', 'es_eq', 'agreement', 'note']]);
const dl = dualLadder(m, spyDash);
eq('the dual ladder: both books per SPY strike, gold ★ and blue ◆ marked', dl.filter(x => x.mark).map(x => [x.spy_strike, x.mark]), [[787, 'spx_only'], [782, 'spx_only'], [780, 'agree'], [767, 'spx_only'], [757, 'spx_only']]);
eq('a missing board is said, not drawn', spMap({ spyDash, spxDash: null, ratio: r, basis: b }).ok, false);

// ── the heatmap in SPY prices ──
{
  const spyGrid = { expiries: [{ expiry: '2026-10-12' }, { expiry: '2026-10-16' }], cells: [{ expiry: '2026-10-12', strike: 780, netGexUsd: 2000 }, { expiry: '2026-10-16', strike: 772, netGexUsd: -600 }] };
  const spxGrid = { expiries: [], cells: [
    { expiry: '2026-10-12', strike: 7825, netGexUsd: 7000 }, { expiry: '2026-10-12', strike: 7830, netGexUsd: 100 },
    { expiry: '2026-10-15', strike: 7900, netGexUsd: 5000 }, { expiry: '2027-12-17', strike: 7600, netGexUsd: -3000 },
    { expiry: '2026-10-16', strike: 9000, netGexUsd: 999 } ] };
  const h = spHeatGrid({ spyGrid, spxGrid, ratio: 0.09967, spot: 778.57, view: 'spx' });
  const cell = (g, e, k) => g.cells.find(c => c.expiry === e && c.strike === k)?.netGexUsd ?? null;
  eq('SPX strikes land on SPY $1 rows and add: 7825 and 7830 both → 780', cell(h, '2026-10-12', 780), 7100);
  eq('an SPX expiry SPY\'s board does not read goes to one "other" column', [cell(h, 'other', 787), cell(h, 'other', 757), h.expiries.map(e => e.expiry)], [5000, -3000, ['2026-10-12', '2026-10-16', 'other']]);
  eq('outside ±10% of spot is not carried', h.cells.some(c => c.strike > 850), false);
  const c = spHeatGrid({ spyGrid, spxGrid, ratio: 0.09967, spot: 778.57, view: 'combined' });
  eq('combined adds SPY\'s own cells', [cell(c, '2026-10-12', 780), cell(c, '2026-10-16', 772)], [9100, -600]);
  eq('no ratio, no grid — said', spHeatGrid({ spyGrid, spxGrid, ratio: null, spot: 778 }).ok, false);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
