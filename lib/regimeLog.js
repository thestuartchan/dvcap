// regimeLog.js — the regime history store, written by two callers.
//
// The route (api/regime-log.js) writes what the dashboard computed, once a day per browser. The
// pre-read cron writes what lib/regimeEngine.js computed on the same payload, every weekday,
// whether or not anyone opened the page. Both go through writeRegimeRow so the row shape, the
// dedupe and the husk purge live once.
//
// MERGE, NOT REPLACE, when both write the same date. The cron runs before the US open and cannot
// know the tape state, the same-day HYG move or the operator's pinned view; the client can. A
// last-write-wins upsert would let the 12:42Z cron row blank those fields the next morning, or
// let a client refresh at 15:00Z blank the cron's provenance. Under mergeRegimeRow a null never
// overwrites a value, and the four probabilities come from whichever wrote LAST — they are the
// same engine on the same inputs, so the later one is at worst the same and at best fresher.
import { upsertByDate } from './series.js';

import { readDoc, writeDoc, storeConfigured } from './docStore.js';

export const DATA_PATH = 'data/regime_history.json';   // the seed (lib/docStore.js)
export const LOG_MAX_ROWS = 800;
// A row is only a real observation if it carries at least one probability.
export const HAS_CONTENT = r => r && (r.stagflation_p != null || r.reflationary_p != null ||
                                      r.deflationary_p != null || r.inflationary_p != null);

export function mergeRegimeRow(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const out = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (k === 'inputs') continue;
    if (v != null) out[k] = v;
  }
  const ei = existing.inputs || {}, ii = incoming.inputs || {};
  const inputs = { ...ei };
  for (const [k, v] of Object.entries(ii)) if (v != null) inputs[k] = v;
  out.inputs = Object.keys(inputs).length ? inputs : null;
  // Provenance is a set, not a scalar: a date both wrote is 'cron+client'.
  const srcs = new Set([...(String(existing.source || '').split('+')), ...(String(incoming.source || '').split('+'))].filter(Boolean));
  out.source = srcs.size ? [...srcs].sort().join('+') : null;
  out.loggedAt = new Date().toISOString();
  return out;
}

// STORE: Redis (lib/docStore.js, document `regime`), not a commit per row. Build step 6 moved it off
// main: the committed data/regime_history.json is now the seed read only until Redis has the log,
// and the nightly backup (lib/docBackup.js) keeps a dated copy on the data-backup branch.
export function logConfigured() { return storeConfigured(); }

export async function readRegimeStore() {
  const { doc } = await readDoc('regime');
  const store = doc && typeof doc === 'object' ? doc : { rows: [] };
  store.rows ||= [];
  return { store, sha: null };
}

// Pure: the next row list, given the current one and an incoming row.
export function nextRows(rows, row) {
  const existing = (rows || []).find(r => r.date === row.date) || null;
  const merged = mergeRegimeRow(existing, { ...row, loggedAt: row.loggedAt || new Date().toISOString() });
  return upsertByDate(rows || [], merged)
    // Purge the contentless husks an old bug wrote: dated rows carrying no probabilities.
    .filter(r => r.date === row.date || HAS_CONTENT(r))
    .slice(-LOG_MAX_ROWS);
}

export async function writeRegimeRow(row) {
  const { store } = await readRegimeStore();
  store.rows = nextRows(store.rows, row);
  if (!(await writeDoc('regime', store))) return { ok: false, error: 'Redis refused the write' };
  return { ok: true, date: row.date, rows: store.rows.length };
}
