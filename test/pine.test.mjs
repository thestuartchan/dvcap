// test/pine.test.mjs — the day's gamma levels as a TradingView indicator (lib/pine.js).
//
// Pine cannot be compiled here, so the checks are structural: the version line, one indicator
// declaration, every level present as a typed float input, absent levels as na rather than 0,
// float literals everywhere a float[] is declared, the symbol guard, and nothing private.
import { pineLevels, pineIndicator, pineFor, PINE_VERSION, PINE_COLORS } from '../lib/pine.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// A QQQ-shaped board: spot 741.21, flip zone 739.96–747.44, call wall 760 (ceiling), support 729,
// trapdoor 740 near / 710 deep, pin box 736–746.
const latest = { symbol: 'QQQ', date: '2026-09-24', asOf: '2026-09-24T00:15:59Z', spot: 741.21, flipZoneLo: 739.96, flipZoneHi: 747.44, callWall: 760 };
const levels = {
  callWall: { strike: 760, kind: 'ceiling' },
  support: { strike: 729, netGexUsd: 61e6, expiry: '2026-09-25', peaks: 1, of: 6 },
  trapdoor: { near: { strike: 740, netGexUsd: -1.33e9, expiry: '2026-09-23' }, deep: { strike: 710, netGexUsd: -0.4e9, expiry: '2026-09-23' } },
  pin: { pinned: true, lo: 736, hi: 746, strikes: [740, 741] },
};
const byStrike = [
  { strike: 710, netGexUsd: -0.4e9 }, { strike: 729, netGexUsd: 61e6 }, { strike: 740, netGexUsd: -1.33e9 },
  { strike: 742, netGexUsd: -0.55e9 }, { strike: 745, netGexUsd: 0.3e9 }, { strike: 750, netGexUsd: 0.2e9 }, { strike: 760, netGexUsd: 0.46e9 },
];

{
  const L = pineLevels({ symbol: 'qqq', latest, levels, byStrike, grid: null, today: '2026-09-24' });
  eq('the board, as numbers', [L.symbol, L.spot, L.flipLo, L.flipHi, L.callWall, L.callWallKind, L.support, L.trapNear, L.trapDeep, L.pinLo, L.pinHi],
     ['QQQ', 741.21, 739.96, 747.44, 760, 'ceiling', 729, 740, 710, 736, 746]);
  ok('nodes above are the positive strikes inside the ladder window', L.above.every(n => n.sign > 0 && n.strike > 741.21));
  ok('nodes below carry the trapdoors and the support', L.below.some(n => n.strike === 740) && L.below.some(n => n.strike === 729 && n.kind === 'support'));
  eq('no spot, no levels', pineLevels({ symbol: 'QQQ', latest: { ...latest, spot: null }, levels, byStrike }), null);
  eq('no symbol, no levels', pineLevels({ latest, levels, byStrike }), null);

  const src = pineIndicator(L);
  ok('version six', src.startsWith(`//@version=${PINE_VERSION}\n`));
  eq('one indicator, overlay, dated in the title', (src.match(/^indicator\(/gm) || []).length, 1);
  ok('the title carries the symbol and the date', src.includes('indicator("dvcap gamma levels · QQQ · 2026-09-24"') && src.includes('overlay=true'));
  for (const [name, v] of [['spotIn', '741.21'], ['flipLo', '739.96'], ['flipHi', '747.44'], ['callWall', '760.00'], ['support', '729.00'], ['trapNear', '740.00'], ['trapDeep', '710.00'], ['pinLo', '736.00'], ['pinHi', '746.00']]) {
    ok(`${name} is a float input at ${v}`, new RegExp(`^${name}\\s*= input\\.float\\(${v.replace('.', '\\.')}, `, 'm').test(src));
  }
  ok('the call wall input says which kind', src.includes('"Call wall (ceiling)"'));
  ok('every float[] literal is a float, never an int', /var float\[\] nodeK = array\.from\((\d+\.\d{2}(, )?)+\)/.test(src) && /var float\[\] nodeG = array\.from\((-?\d+\.0(, )?)+\)/.test(src));
  ok('node labels name the kind and the size', /"support 09-25 \$61M"/.test(src) && /"−γ 09-23 −\$1\.33B"/.test(src));
  ok('the symbol guard names the instrument', src.includes('if syminfo.ticker != "QQQ"'));
  ok('the colours are the panel\'s: green positive, purple negative', src.includes(`C_POS  = ${PINE_COLORS.pos}`) && src.includes(`C_NEG  = ${PINE_COLORS.neg}`));
  ok('everything is drawn on the last bar and extended both ways', src.includes('if barstate.islast') && src.includes('extend=extend.both'));
  ok('the loop bound is guarded, never na', src.includes('if showNodes and array.size(nodeK) > 0') && !src.includes(': na)'));
  ok('one statement per line', !/array\.clear\(L\), /.test(src));
  ok('nothing private: no position, quantity or account word', !/position|qty|quantity|NLV|account|balance/i.test(src));
  ok('a fresh call is byte-identical — the script is a pure function of the board', pineIndicator(L) === src);
  ok('under 8 KB', src.length < 8192);
}

// Absent levels are na, not zero — a zero would draw a line at the bottom of the chart.
{
  const L = pineLevels({ symbol: 'SPY', latest: { ...latest, symbol: 'SPY', spot: 500, flipZoneLo: null, flipZoneHi: null, callWall: null },
    levels: { callWall: { strike: null }, support: { strike: null }, trapdoor: { near: null, deep: null }, pin: { pinned: false } }, byStrike: [] });
  const src = pineIndicator(L);
  ok('trapdoors, support, wall and bands are na', /^trapNear = float\(na\)/m.test(src) && /^support {2}= float\(na\)/m.test(src) && /^flipLo {3}= float\(na\)/m.test(src) && /^pinLo {4}= float\(na\)/m.test(src));
  ok('and the empty node arrays are typed and empty', src.includes('var float[] nodeK = array.new_float()') && src.includes('var string[] nodeT = array.new_string()'));
  ok('spot is still an input', /^spotIn {3}= input\.float\(500\.00,/m.test(src));
  eq('pineFor bundles both', Object.keys(pineFor({ symbol: 'SPY', latest: { ...latest, spot: 500 }, levels: {}, byStrike: [] })), ['levels', 'source']);
  eq('and is null without a board', pineFor({ symbol: 'SPY', latest: null }), null);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
