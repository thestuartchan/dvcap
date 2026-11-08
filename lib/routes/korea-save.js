// lib/routes/korea-save.js — the Korea readings (KOFIA paste + 7709 units, and the daily KOFIA/KRX
// fetch) kept in one Redis document (lib/docStore.js `kofia`), so the dashboard and the server-side
// Pre-Reads read one maintained series (with history). POST only. The server re-parses and
// re-validates a paste (authoritative) before saving. Since build step 6 nothing here commits.

import { parseKofia } from '../kofia.js';
import { upsertObservation } from '../series.js';
import { normaliseStore, unitProblems as unitGate, applyKofia, applyFlows, appendSnapshot, KOFIA_KEYS } from '../koreaStore.js';
import { hasSessionCookie, authorised, refuse } from '../apiauth.js';
import { readDoc, writeDoc, storeConfigured } from '../docStore.js';
import { fetchKoreaInto } from '../koreaFetch.js';

// The merge itself — unit gate, dated series, latest — lives in lib/koreaStore.js, shared with the
// daily fetch (the scheduler's korea-fetch job), so a hand paste and an automatic read land identically.
const KEYS = KOFIA_KEYS;

// Redis (lib/docStore.js document `kofia`; build step 6). The committed data/korea_kofia.json is the
// seed until the first save. Dated per-key series is the authoritative trend store; normaliseStore
// backfills it from the legacy savedAt-keyed snapshots and collapses duplicate same-date rows.
async function readStore() {
  const { doc } = await readDoc('kofia');
  return { store: normaliseStore(doc && typeof doc === 'object' ? doc : { latest: {}, history: [] }), sha: null };
}

async function writeStore(store) {
  return (await writeDoc('kofia', store)) ? { ok: true } : { ok: false, detail: 'Redis refused the write' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  // Gate the write behind the dashboard's own session (minted by lib/routes/login.js, signed by
  // lib/session.js). This used to test for the literal string `mwd_auth=true`, which anyone could
  // send — the gate named the cookie without ever checking it came from us.
  const fetchNow = String(req.query?.fetch || '') === '1';
  // The fetch also opens to the scheduler's service key (lib/cronRouter.js korea-fetch); a paste
  // stays behind the dashboard login.
  if (!(fetchNow ? await authorised(req) : await hasSessionCookie(req))) return refuse(res);
  if (!storeConfigured()) return res.status(500).json({ error: 'Redis is not configured' });

  // ── FETCH NOW ── the panel's button: the scheduled run's fetch, on demand, committed the same
  // way a paste is. lastFetch is stamped whether or not a reading changed, so it always writes.
  if (fetchNow) {
    const { store } = await readStore();
    const out = await fetchKoreaInto(store, { by: req.query?.scheduled ? 'schedule' : 'button' });
    const w = await writeStore(store);
    if (!w.ok) return res.status(502).json({ error: 'Redis refused the save', detail: w, report: out.report });
    return res.status(200).json({ ok: !out.failed, changed: out.changed, report: out.report, lastFetch: store.lastFetch, latest: store.latest, series: store.series });
  }

  const { blob, units7709, foreignNet, instNet, retailNet } = req.body || {};
  const parsed = blob ? parseKofia(blob) : { list: [], anyMismatch: false };
  // The no-error guarantee: a recompute mismatch blocks the save entirely.
  if (parsed.anyMismatch) {
    return res.status(422).json({
      error: 'paste mismatch — recomputed pct disagrees with the pasted pct; nothing saved',
      mismatched: parsed.list.filter(f => f.mismatch).map(f => ({ key: f.key, pasted: f.pct, recomputed: f.recomputedPct })),
    });
  }

  const { store } = await readStore();
  const prev = store.latest;
  const savedAt = new Date().toISOString();
  const snapshot = { savedAt };
  const saved = [];

  // Unit-detection gate (lib/koreaStore.js): a >1000× swing against the prior reading is a
  // mis-detected unit, not a market move — block the whole save.
  const problems = unitGate(parsed.list, prev);
  if (problems.length) {
    return res.status(422).json({ error: 'unit check failed — nothing saved', unitProblems: problems });
  }

  // Merge parsed KOFIA fields — absent fields keep their prior value+asOf (never wiped).
  saved.push(...applyKofia(store, parsed.list, snapshot));

  // 7709 units (separate manual field): delta vs the prior stored value.
  if (units7709 && units7709.value != null && Number.isFinite(Number(units7709.value))) {
    const v = Number(units7709.value);
    const prevV = prev.units7709?.value ?? null;
    store.latest.units7709 = { value: v, asOf: units7709.asOf || prev.units7709?.asOf || null, delta: prevV != null ? v - prevV : null };
    snapshot.units7709 = { value: v, asOf: store.latest.units7709.asOf };
    store.series.units7709 = upsertObservation(store.series.units7709, {
      date: store.latest.units7709.asOf, value: v, unit: 'units',
    });
    saved.push('units7709');
  }

  // Foreign / institutional / RETAIL net flows (십억원) — all three actors, so absorption can be
  // read. Parsed KRX rows win; the explicit inputs are the manual fallback.
  const parsedFlow = k => parsed.list?.find(f => f.key === k);
  const pick = (k, inp) => { const pf = parsedFlow(k); return pf ? { v: pf.balance, asOf: pf.asOf } : (inp && inp.value != null && Number.isFinite(Number(inp.value)) ? { v: Number(inp.value), asOf: inp.asOf } : null); };
  const byDate = new Map();
  for (const [fk, inp] of [['foreignNet', foreignNet], ['instNet', instNet], ['retailNet', retailNet]]) {
    const got = pick(fk, inp);
    if (!got) continue;
    const asOf = got.asOf || prev[fk]?.asOf || null;
    if (!byDate.has(asOf)) byDate.set(asOf, { date: asOf, unit: '십억원' });
    byDate.get(asOf)[fk] = got.v;
  }
  for (const flows of byDate.values()) for (const k of applyFlows(store, flows, undefined, snapshot)) if (!saved.includes(k)) saved.push(k);

  if (saved.length === 0) return res.status(400).json({ error: 'no recognizable fields in the paste' });

  appendSnapshot(store, Object.fromEntries(Object.entries(snapshot).filter(([k]) => k !== 'savedAt')), savedAt);
  const missing = KEYS.filter(k => !saved.includes(k));

  const w = await writeStore(store);
  if (!w.ok) return res.status(502).json({ error: 'Redis refused the save', detail: w });

  return res.status(200).json({ ok: true, saved, missing, latest: store.latest, series: store.series });
}
