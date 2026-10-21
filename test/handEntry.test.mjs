// test/handEntry.test.mjs — the hand-entry hub's order and editors (lib/handEntry.js). Made-up rows.
import { handEntryPlan, HAND_EDITORS, newerKofia } from '../lib/handEntry.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const R = (key, group, state, days = null) => ({ key, label: key, group, state, days });
const plan = handEntryPlan([
  R('usfr', 'Manual entry', 'due', 20),
  R('ism', 'Manual entry', 'stale', 40),
  R('fedLanguage', 'Source constants', 'due', 60),
  R('kofia7709', 'Korea (KOFIA paste)', 'missing'),
  R('southbound', 'Automatic feed', 'fresh', 1),
  R('override:XYZ Bank', 'Manual entry', 'fresh', 10),
  R('calendar', 'Data files', 'fresh', -70),
]);
eq('overdue first, then due; editable before not within a band', plan.needsYou.map(i => i.key), ['ism', 'korea', 'usfr', 'fedLanguage']);
eq('each editable row names its editor', plan.needsYou.map(i => i.editor), ['ism', 'korea', 'usfr', null]);
eq('a constant says why it cannot be edited here', plan.needsYou.find(i => i.key === 'fedLanguage').whyNot, "updated by Claude's weekly refresh — not editable here");
eq('an automatic feed asks for nothing', plan.rest.find(i => i.key === 'southbound').whyNot, 'automatic — nothing to enter');
eq('a recession override opens the recession editor', plan.rest.find(i => i.key === 'override:XYZ Bank').editor, 'recession');
eq('counts', plan.counts, { overdue: 2, due: 2, editable: 4, total: 7 });
const k = handEntryPlan([
  { key: 'kofiaFlows', label: 'flows', group: 'Korea (KOFIA paste)', state: 'fresh', asOf: '2026-10-20', days: 1 },
  { key: 'kofiaBalances', label: 'balances', group: 'Korea (KOFIA paste)', state: 'fresh', asOf: '2026-10-19', days: 2 },
  { key: 'kofia7709', label: '7709', group: 'Korea (KOFIA paste)', state: 'stale', asOf: '2026-10-16', days: 5 },
]);
eq('the three Korea rows are one row, led by the worst part', [k.needsYou.length, k.rest.length, k.needsYou[0].key, k.needsYou[0].state, k.needsYou[0].asOf], [1, 0, 'korea', 'stale', '2026-10-16']);
eq('…each part keeps its own date and state', k.needsYou[0].parts.map(p => [p.label, p.state, p.asOf]), [['flows', 'fresh', '2026-10-20'], ['balances', 'fresh', '2026-10-19'], ['7709', 'stale', '2026-10-16']]);
eq('…and both source pages are linked once each', k.needsYou[0].sources.map(x => x.label), ['KOFIA FreeSIS', 'CSOP 7709']);
eq('…counted once', k.counts, { overdue: 1, due: 0, editable: 1, total: 1 });
eq('a save newer than the payload wins, field by field', newerKofia({ units7709: { asOf: '2026-10-16', value: 1 }, marginLoans: { asOf: '2026-10-19' } }, { units7709: { asOf: '2026-10-21', value: 2 }, marginLoans: { asOf: '2026-10-18' } }),
  { units7709: { asOf: '2026-10-21', value: 2 }, marginLoans: { asOf: '2026-10-19' } });
eq('no save: the payload as it is', newerKofia({ a: 1 }, null), { a: 1 });
eq('every editable input links its source page where there is one', Object.entries(HAND_EDITORS).filter(([, v]) => v.source).every(([, v]) => /^https:\/\//.test(v.source.url)), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
