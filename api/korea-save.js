// api/korea-save.js — persist the Korea manual-entry (KOFIA paste + 7709 units) to
// data/korea_kofia.json via the GitHub Contents API, so BOTH the dashboard and the
// server-side Pre-Reads read one maintained series (with history). POST only.
// Server re-parses + re-validates the blob (authoritative) before committing.

import { parseKofia } from '../lib/kofia.js';
import { upsertObservation } from '../lib/series.js';
import { normaliseStore, unitProblems as unitGate, applyKofia, applyFlows, appendSnapshot, KOFIA_KEYS } from '../lib/koreaStore.js';
import { hasSessionCookie, refuse } from '../lib/apiauth.js';
import { fetchKoreaInto } from '../lib/koreaFetch.js';

const DATA_PATH = 'data/korea_kofia.json';
// The merge itself — unit gate, dated series, latest — lives in lib/koreaStore.js, shared with the
// daily fetch (scripts/korea-fetch.mjs), so a hand paste and an automatic read land identically.
const KEYS = KOFIA_KEYS;

function ghHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dvcap-korea-kofia',
  };
}

async function readStore() {
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const api = `https://api.github.com/repos/${repo}/contents/${DATA_PATH}?ref=${encodeURIComponent(branch)}`;
  const r = await fetch(api, { headers: ghHeaders() });
  if (!r.ok) return { store: { latest: {}, history: [] }, sha: null };
  const meta = await r.json();
  let store = { latest: {}, history: [] };
  try { store = JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8')); } catch { /* keep default */ }
  // Dated per-key series is the authoritative trend store; normaliseStore backfills it from the
  // legacy savedAt-keyed snapshots and collapses duplicate same-date rows.
  return { store: normaliseStore(store), sha: meta.sha };
}

async function writeStore(store, sha, message) {
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const content = Buffer.from(JSON.stringify(store, null, 2) + '\n', 'utf8').toString('base64');
  const body = { message, content, branch, ...(sha ? { sha } : {}) };
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${DATA_PATH}`, {
    method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body),
  });
  return r.ok ? { ok: true } : { ok: false, status: r.status, detail: (await r.text()).slice(0, 300) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  // Gate the write behind the dashboard's own session (minted by api/login.js, signed by
  // lib/session.js). This used to test for the literal string `mwd_auth=true`, which anyone could
  // send — the gate named the cookie without ever checking it came from us.
  if (!(await hasSessionCookie(req))) return refuse(res);
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return res.status(500).json({ error: 'GITHUB_TOKEN / GITHUB_REPO not configured in Vercel' });
  }

  // ── FETCH NOW ── the panel's button: the scheduled run's fetch, on demand, committed the same
  // way a paste is. lastFetch is stamped whether or not a reading changed, so it always writes.
  if (String(req.query?.fetch || '') === '1') {
    const { store, sha } = await readStore();
    const out = await fetchKoreaInto(store, { by: 'button' });
    const w = await writeStore(store, sha, `Korea fetch (button) — ${out.changed ? 'KOFIA + KRX flows' : 'no new readings'} @ ${new Date().toISOString().slice(0, 10)}`);
    if (!w.ok) return res.status(502).json({ error: 'GitHub commit failed', detail: w, report: out.report });
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

  const { store, sha } = await readStore();
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

  const w = await writeStore(store, sha, `Korea manual entry — ${saved.join(', ')} @ ${savedAt.slice(0, 10)}`);
  if (!w.ok) return res.status(502).json({ error: 'GitHub commit failed', detail: w });

  return res.status(200).json({ ok: true, saved, missing, latest: store.latest, series: store.series });
}
