// lib/koreaStore.js — merging Korea readings into data/korea_kofia.json, one way for every writer.
//
// Two writers: the hand paste (api/korea-save.js) and the daily fetch (scripts/korea-fetch.mjs).
// Both go through these functions, so a reading lands in the store the same way whichever path
// brought it — same unit gate, same dated series, same "absent keeps its prior value" rule.
// Pure: takes a store, returns a new one and what changed.

import { toWonTrillions, unitSanity, KOFIA_CURRENCY } from './kofia.js';
import { upsertObservation, seriesFromHistory, normalizeSeries } from './series.js';

export const KOFIA_KEYS = ['marginLoans', 'deposits', 'cma', 'kospi', 'kr3yGovt', 'kr3yCorp'];
export const FLOW_KEYS = ['foreignNet', 'instNet', 'retailNet'];
// KOSDAQ flows: kept as their own series and shown as one line. They do not feed the Korea gate,
// which reads the KOSPI table — the market SK hynix and Samsung trade on.
export const KOSDAQ_FLOW_KEYS = ['foreignNetKq', 'instNetKq', 'retailNetKq'];
export const SERIES_KEYS = [...KOFIA_KEYS, 'units7709', ...FLOW_KEYS, ...KOSDAQ_FLOW_KEYS];

// Bring a stored object up to the current shape (dated series per key, deduped).
export function normaliseStore(store0) {
  const store = { ...(store0 || {}) };
  store.latest = { ...(store.latest || {}) };
  store.history = [...(store.history || [])];
  if (!store.series) store.series = seriesFromHistory(store.history, SERIES_KEYS);
  store.series = { ...store.series };
  for (const k of SERIES_KEYS) store.series[k] = normalizeSeries(store.series[k]);
  return store;
}

// The unit gate: each currency row converted to ₩T with its own unit and compared with the prior
// stored reading. A >1000× swing is a mis-detected unit, not a market move.
export function unitProblems(list = [], prevLatest = {}) {
  const problems = [];
  for (const f of list) {
    if (!KOFIA_CURRENCY.includes(f.key)) continue;
    const canon = toWonTrillions(f.balance, f.unit);
    if (canon == null) { problems.push({ key: f.key, unit: f.unit, error: `unrecognized unit "${f.unit}" — cannot convert to ₩T` }); continue; }
    const p = prevLatest?.[f.key];
    const warn = unitSanity(canon, toWonTrillions(p?.value, p?.unit));
    if (warn) problems.push({ key: f.key, unit: f.unit, error: warn });
  }
  return problems;
}

// KOFIA rows (parseKofia's list) into latest + dated series. A row older than what is already
// stored never replaces `latest` — the series still takes it, keyed by its own date.
export function applyKofia(store, list = [], snapshot = {}) {
  const saved = [];
  for (const f of list) {
    if (f.asOf == null || f.balance == null) continue;
    const cur = store.latest[f.key];
    if (!cur?.asOf || f.asOf >= cur.asOf) {
      store.latest[f.key] = { value: f.balance, unit: f.unit, asOf: f.asOf, delta: f.delta ?? null, pct: f.pct ?? null };
    }
    snapshot[f.key] = { value: f.balance, asOf: f.asOf };
    store.series[f.key] = upsertObservation(store.series[f.key], { date: f.asOf, value: f.balance, unit: f.unit, delta: f.delta ?? null, pct: f.pct ?? null });
    saved.push(f.key);
  }
  return saved;
}

// One flow table — { date, unit, foreignNet, instNet, retailNet } — under the given keys.
export function applyFlows(store, flows, keys = FLOW_KEYS, snapshot = {}) {
  const saved = [];
  if (!flows?.date) return saved;
  FLOW_KEYS.forEach((src, i) => {
    const v = flows[src];
    if (v == null || !Number.isFinite(Number(v))) return;
    const k = keys[i];
    const cur = store.latest[k];
    if (!cur?.asOf || flows.date >= cur.asOf) store.latest[k] = { value: Number(v), unit: flows.unit || '십억원', asOf: flows.date };
    snapshot[k] = { value: Number(v), asOf: flows.date };
    store.series[k] = upsertObservation(store.series[k], { date: flows.date, value: Number(v), unit: flows.unit || '십억원' });
    saved.push(k);
  });
  return saved;
}

// The history snapshot is the legacy per-save record. Appended only when something was saved.
export function appendSnapshot(store, snapshot, savedAt) {
  if (Object.keys(snapshot).length) store.history = [...store.history, { savedAt, ...snapshot }].slice(-400);
}

// Did the store actually change? Compares the parts a reading can move.
export function storeChanged(before, after) {
  return JSON.stringify([before?.latest, before?.series]) !== JSON.stringify([after?.latest, after?.series]);
}
