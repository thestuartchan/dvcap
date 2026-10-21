// lib/handEntry.js — the hand-entry hub: every hand-kept input, in the order it needs you, and
// whether it can be updated in place.
//
// The ledger (lib/ledger.js) already knows every input a person keeps and how late each is. What it
// did not say is WHERE to fix one: the editors sat on five different tabs (the growth card, the
// Korea panel, the cash card, the Fed path card, the recession panel), so keeping them current
// meant scrolling to each. This turns each ledger row into a row with its editor: the same editor
// component that tab uses, saving through the same path. Pure: the dashboard renders it.
import { ISSUER_PAGE } from './cashyield.js';

// Which editor updates which ledger row, and where the figure is read from.
const KOFIA = { label: 'KOFIA FreeSIS', url: 'https://freesis.kofia.or.kr/stat/main.do' };
export const HAND_EDITORS = Object.freeze({
  ism: { editor: 'ism', source: { label: 'ISM Report On Business', url: 'https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/' } },
  usfr: { editor: 'usfr', source: { label: ISSUER_PAGE.USFR.label, url: ISSUER_PAGE.USFR.url } },
  kofiaFlows: { editor: 'korea', source: KOFIA },
  kofiaBalances: { editor: 'korea', source: KOFIA },
  kofia7709: { editor: 'korea', source: { label: 'CSOP 7709', url: 'https://www.csopasset.com/en/products/hk-skhy-2l' } },
  fedPath: { editor: 'fedPath', source: { label: 'CME ZQ settlements', url: 'https://www.cmegroup.com/markets/interest-rates/stirs/30-day-federal-fund.settlements.html' } },
  southbound: { editor: 'southbound', source: { label: 'HKEX Southbound', url: 'https://www.hkex.com.hk/Mutual-Market/Stock-Connect/Statistics/Historical-Daily' } },
  intervention: { editor: 'intervention', source: null },
});
const editorFor = (key) => HAND_EDITORS[key] || (String(key).startsWith('override:') ? { editor: 'recession', source: null } : null);

// Groups whose rows live in the source or in data files, not in the browser.
const NOT_HERE = {
  'Source constants': "updated by Claude's weekly refresh — not editable here",
  Overlays: 'retires itself when the live series catches up — nothing to enter',
  'Data files': "updated by Claude's weekly refresh and the scheduled workflows — not editable here",
  Judgement: 'changed on a conviction change, by PR — not editable here',
  'Automatic feed': 'automatic — nothing to enter',
};

// overdue (stale, missing) → due → everything else; within a band, editable first, then oldest.
const BAND = { stale: 0, missing: 0, due: 1, fresh: 2, optional: 2, retired: 3, undated: 3 };

// ONE KOREA ROW (21 Oct). Flows, balances and 7709 units are three ledger rows with three dates, but
// one editor — the Korea panel, with the automatic fetch and the 7709 box together — so the hub drew
// the same panel three times. They are one row now: the worst state and the oldest date lead, and
// each part keeps its own line underneath.
const GROUPED = { korea: 'Korea — flows, balances, 7709 units' };
function groupByEditor(items) {
  const out = [], seen = new Map();
  for (const i of items) {
    const label = i.editable && GROUPED[i.editor];
    if (!label) { out.push(i); continue; }
    const parts = { key: i.key, label: i.label, state: i.state, asOf: i.asOf ?? null, days: i.days ?? null, source: i.source };
    const g = seen.get(i.editor);
    if (!g) { const first = { ...i, key: i.editor, label, parts: [parts], sources: i.source ? [i.source] : [] }; seen.set(i.editor, first); out.push(first); continue; }
    g.parts.push(parts);
    if (i.source && !g.sources.some(x => x.url === i.source.url)) g.sources.push(i.source);
    if (i.band < g.band || (i.band === g.band && (i.days ?? -1) > (g.days ?? -1))) Object.assign(g, { band: i.band, state: i.state, asOf: i.asOf, days: i.days, rule: i.rule, cadence: i.cadence });
  }
  return out;
}

// A Korea save answers with the store's `latest`; until the redeploy carries it into the Asia payload,
// the ledger reads whichever of the two is newer, field by field, so the age updates on the save.
export function newerKofia(payload = null, saved = null) {
  if (!saved) return payload;
  if (!payload) return saved;
  const out = { ...payload };
  for (const [k, v] of Object.entries(saved)) if (v?.asOf && (!out[k]?.asOf || v.asOf >= out[k].asOf)) out[k] = v;
  return out;
}

export function handEntryPlan(rows = []) {
  const items = groupByEditor(rows.map(r => {
    const ed = editorFor(r.key);
    const editable = !!ed && !NOT_HERE[r.group];
    return { ...r, band: BAND[r.state] ?? 3, editable, editor: editable ? ed.editor : null, source: ed?.source ?? null,
      whyNot: editable ? null : (NOT_HERE[r.group] || 'not editable in the browser') };
  }));
  items.sort((a, b) => (a.band - b.band) || (Number(b.editable) - Number(a.editable)) || ((b.days ?? -1) - (a.days ?? -1)));
  return {
    needsYou: items.filter(i => i.band <= 1),
    rest: items.filter(i => i.band > 1),
    counts: { overdue: items.filter(i => i.band === 0).length, due: items.filter(i => i.band === 1).length,
      editable: items.filter(i => i.editable).length, total: items.length },
  };
}
