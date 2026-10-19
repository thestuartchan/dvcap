// Regression tests for lib/analystViews.js — the analyst-view board.
// Run: node test/analystViews.test.mjs
import { buildViews, evaluateViews, regimeCluster, divergenceRead, VERDICT_WEIGHT, fomcDecisionText } from '../lib/analystViews.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✅' : '❌'} ${name}` + (ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};
const find = (ev, k) => ev.find(v => v.key === k);

// Live values as of 2026-08-25.
const NOW = { oil: 91.57, gdpGrowth: 1.5, yieldSpread: 0.38, septHikeOdds: 31, fedHawkish: true, capexRising: true, unemployment: 4.3, empPopFalling: true };
const ev = evaluateViews(buildViews(NOW));

eq('Goldman: under pressure (2/4, own flag fired)', find(ev, 'Goldman Sachs').verdict, 'under pressure');
eq('Goldman: critical condition broken',            find(ev, 'Goldman Sachs').criticalBroken, true);
eq('NY Fed curve: holding',                          find(ev, 'NY Fed Yield Curve Model').verdict, 'holding');
eq('September FOMC: holding',                       find(ev, 'September FOMC').verdict, 'holding');
eq('JPMorgan: void (oil-shock condition false)',     find(ev, 'JPMorgan').verdict, 'void');
eq("Moody's: void",                                  find(ev, "Moody's Analytics (Zandi)").verdict, 'void');
eq('cluster on reflationary',                        regimeCluster(ev).top, 'ref');
eq('Morgan Stanley on the board',                    !!find(ev, 'Morgan Stanley'), true);
eq('BofA on the board',                              !!find(ev, 'Bank of America'), true);
eq('Deutsche on the board',                          !!find(ev, 'Deutsche Bank'), true);
eq('Deutsche void — its dovish-Fed premise failed',  find(ev, 'Deutsche Bank').verdict, 'void');
eq('lead is flagged impaired',                       regimeCluster(ev).impaired, true);
eq('every view carries provenance',                  ev.filter(v => v.kind === 'analyst').every(v => !!v.sourceNote), true);

// A critical failure must never SOFTEN the verdict — with most conditions gone it escalates to void.
const shock = evaluateViews(buildViews({ ...NOW, oil: 112 }));
eq('oil shock: Goldman void',        find(shock, 'Goldman Sachs').verdict, 'void');
eq('oil shock: JPMorgan revives',    find(shock, 'JPMorgan').verdict, 'holding');
eq('oil shock: cluster flips to def', regimeCluster(shock).top, 'def');
// Conviction weighting, not a head count: under the shock the reflationary side still has MORE
// theses, but they are void/cracking while the deflationary ones are intact.
eq('oil shock: def outweighs despite equal head count', regimeCluster(shock).scores.def > regimeCluster(shock).scores.ref, true);
eq('oil shock: ref head count still >= def', regimeCluster(shock).counts.ref >= regimeCluster(shock).counts.def, true);
eq('a holding thesis outweighs an impaired one', VERDICT_WEIGHT.holding > VERDICT_WEIGHT['under pressure'], true);
eq('void contributes nothing', VERDICT_WEIGHT.void, 0);

// Benign path: Goldman's thesis fully intact, the hawkish-Fed thesis dies.
const benign = evaluateViews(buildViews({ ...NOW, gdpGrowth: 2.4, septHikeOdds: 10, fedHawkish: false }));
eq('benign: Goldman holding',  find(benign, 'Goldman Sachs').verdict, 'holding');
eq('benign: FOMC thesis void', find(benign, 'September FOMC').verdict, 'void');

// Missing inputs render n/a — never counted as met, never as a clean miss.
eq('no live data -> unverifiable', find(evaluateViews(buildViews({})), 'NY Fed Yield Curve Model').verdict, 'unverifiable');

// Divergence read
eq('divergence names the disagreement',
  divergenceRead({ cluster: { top: 'ref' }, engineRegime: 'stag' }).includes('disagree'), true);

// ── The FOMC row follows the newest statement (19 Oct 2026) ──
{
  const fomc = (f) => buildViews({ ...NOW, fomcLatest: f }).find(v => v.key === 'September FOMC');
  const none = fomc(null);
  eq('with no statement read, the hand-written September row stands', [none.house, none.published, !!none.needsReview], ['FOMC — September decision', '2026-09-16', false]);
  const hold = fomc({ date: '2026-10-28', action: 'maintain', bps: 0, range: [3.75, 4], dissents: ['A', 'B'], dissentPreferred: 'raise the target range for the federal funds rate by 1/4 percentage point at this meeting' });
  eq('a newer decision replaces the text, dated', [hold.house, hold.published, hold.call], ['FOMC — October decision', '2026-10-28', 'Held at 3.75–4.00%, 2 dissents (preferred to raise by 1/4 percentage point)']);
  eq('a hold flags the regime mapping for review instead of re-mapping it', [hold.impliedRegime, /review/.test(hold.needsReview || '')], ['stag', true]);
  eq('and adds the decisive condition, unmet', hold.conditions.at(-1).label + ' ' + hold.conditions.at(-1).met, 'Latest action still a hike false');
  eq('an older statement never overrides the row', fomc({ date: '2026-07-29', action: 'maintain', bps: 0, range: [3.5, 3.75], dissents: [] }).published, '2026-09-16');
  eq('a cut reads as a cut', fomcDecisionText({ action: 'lower', bps: 50, range: [3.25, 3.5], dissents: [] }), 'Cut 50bp to 3.25–3.50%, no dissent listed');
}

console.log(fail ? `\n❌ ${fail} FAILED` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
