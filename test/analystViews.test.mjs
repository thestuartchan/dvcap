// Regression tests for lib/analystViews.js — the analyst-view board.
// Run: node test/analystViews.test.mjs
import { buildViews, evaluateViews, regimeCluster, divergenceRead } from '../lib/analystViews.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✅' : '❌'} ${name}` + (ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};
const find = (ev, k) => ev.find(v => v.key === k);

// Live values as of 2026-08-25.
const NOW = { oil: 91.57, gdpGrowth: 1.5, yieldSpread: 0.38, septHikeOdds: 31, fedHawkish: true, capexRising: true };
const ev = evaluateViews(buildViews(NOW));

eq('Goldman: under pressure (2/4, own flag fired)', find(ev, 'Goldman Sachs').verdict, 'under pressure');
eq('Goldman: critical condition broken',            find(ev, 'Goldman Sachs').criticalBroken, true);
eq('NY Fed curve: holding',                          find(ev, 'NY Fed Yield Curve Model').verdict, 'holding');
eq('FOMC minutes: holding',                          find(ev, 'July FOMC Minutes').verdict, 'holding');
eq('JPMorgan: void (oil-shock condition false)',     find(ev, 'JPMorgan').verdict, 'void');
eq("Moody's: void",                                  find(ev, "Moody's Analytics (Zandi)").verdict, 'void');
eq('cluster on reflationary',                        regimeCluster(ev).top, 'ref');

// A critical failure must never SOFTEN the verdict — with most conditions gone it escalates to void.
const shock = evaluateViews(buildViews({ ...NOW, oil: 112 }));
eq('oil shock: Goldman void',        find(shock, 'Goldman Sachs').verdict, 'void');
eq('oil shock: JPMorgan revives',    find(shock, 'JPMorgan').verdict, 'holding');
eq('oil shock: cluster flips to def', regimeCluster(shock).top, 'def');

// Benign path: Goldman's thesis fully intact, the hawkish-Fed thesis dies.
const benign = evaluateViews(buildViews({ ...NOW, gdpGrowth: 2.4, septHikeOdds: 10, fedHawkish: false }));
eq('benign: Goldman holding',  find(benign, 'Goldman Sachs').verdict, 'holding');
eq('benign: FOMC thesis void', find(benign, 'July FOMC Minutes').verdict, 'void');

// Missing inputs render n/a — never counted as met, never as a clean miss.
eq('no live data -> unverifiable', find(evaluateViews(buildViews({})), 'NY Fed Yield Curve Model').verdict, 'unverifiable');

// Divergence read
eq('divergence names the disagreement',
  divergenceRead({ cluster: { top: 'ref' }, engineRegime: 'stag' }).includes('disagree'), true);

console.log(fail ? `\n❌ ${fail} FAILED` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
