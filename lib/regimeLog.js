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

export const DATA_PATH = 'data/regime_history.json';
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

function ghHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dvcap-regime-log',
  };
}
export function logConfigured() { return !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO); }

export async function readRegimeStore() {
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const api = `https://api.github.com/repos/${repo}/contents/${DATA_PATH}?ref=${encodeURIComponent(branch)}`;
  const r = await fetch(api, { headers: ghHeaders() });
  if (!r.ok) return { store: { rows: [] }, sha: null };
  const meta = await r.json();
  let store = { rows: [] };
  try { store = JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8')); } catch { /* keep default */ }
  store.rows ||= [];
  return { store, sha: meta.sha };
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
  const { store, sha } = await readRegimeStore();
  store.rows = nextRows(store.rows, row);
  const content = Buffer.from(JSON.stringify(store, null, 2) + '\n', 'utf8').toString('base64');
  const body = {
    message: `Regime log — ${row.live_regime ?? 'n/a'} @ ${row.date}${row.source ? ` (${row.source})` : ''}`,
    content, branch: process.env.GITHUB_BRANCH || 'main', ...(sha ? { sha } : {}),
  };
  const w = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${DATA_PATH}`, {
    method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body),
  });
  if (!w.ok) return { ok: false, error: 'GitHub commit failed', detail: (await w.text()).slice(0, 300) };
  return { ok: true, date: row.date, rows: store.rows.length };
}
