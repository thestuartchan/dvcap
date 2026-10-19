// test/handEntry.test.mjs — the hand-entry hub's order and editors (lib/handEntry.js). Made-up rows.
import { handEntryPlan, HAND_EDITORS } from '../lib/handEntry.js';

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
eq('overdue first, then due; editable before not within a band', plan.needsYou.map(i => i.key), ['ism', 'kofia7709', 'usfr', 'fedLanguage']);
eq('each editable row names its editor', plan.needsYou.map(i => i.editor), ['ism', 'korea', 'usfr', null]);
eq('a constant says why it cannot be edited here', plan.needsYou.find(i => i.key === 'fedLanguage').whyNot, "updated by Claude's weekly refresh — not editable here");
eq('an automatic feed asks for nothing', plan.rest.find(i => i.key === 'southbound').whyNot, 'automatic — nothing to enter');
eq('a recession override opens the recession editor', plan.rest.find(i => i.key === 'override:XYZ Bank').editor, 'recession');
eq('counts', plan.counts, { overdue: 2, due: 2, editable: 4, total: 7 });
eq('every editable input links its source page where there is one', Object.entries(HAND_EDITORS).filter(([, v]) => v.source).every(([, v]) => /^https:\/\//.test(v.source.url)), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
