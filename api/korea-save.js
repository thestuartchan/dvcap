// api/korea-save.js — persist the Korea manual-entry (KOFIA paste + 7709 units) to
// data/korea_kofia.json via the GitHub Contents API, so BOTH the dashboard and the
// server-side Pre-Reads read one maintained series (with history). POST only.
// Server re-parses + re-validates the blob (authoritative) before committing.

import { parseKofia } from '../lib/kofia.js';

const DATA_PATH = 'data/korea_kofia.json';
const KEYS = ['marginLoans', 'deposits', 'cma', 'kospi', 'kr3yGovt', 'kr3yCorp'];

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
  store.latest ||= {};
  store.history ||= [];
  return { store, sha: meta.sha };
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
  // Gate the write behind the dashboard's own auth cookie (set by api/login.js).
  if (!/(^|;\s*)mwd_auth=true(;|$)/.test(req.headers.cookie || '')) {
    return res.status(401).json({ error: 'not authenticated — log in to the dashboard first' });
  }
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return res.status(500).json({ error: 'GITHUB_TOKEN / GITHUB_REPO not configured in Vercel' });
  }

  const { blob, units7709 } = req.body || {};
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

  // Merge parsed KOFIA fields — absent fields keep their prior value+asOf (never wiped).
  for (const f of parsed.list) {
    store.latest[f.key] = { value: f.balance, unit: f.unit, asOf: f.asOf, delta: f.delta ?? null, pct: f.pct ?? null };
    snapshot[f.key] = { value: f.balance, asOf: f.asOf };
    saved.push(f.key);
  }

  // 7709 units (separate manual field): delta vs the prior stored value.
  if (units7709 && units7709.value != null && Number.isFinite(Number(units7709.value))) {
    const v = Number(units7709.value);
    const prevV = prev.units7709?.value ?? null;
    store.latest.units7709 = { value: v, asOf: units7709.asOf || prev.units7709?.asOf || null, delta: prevV != null ? v - prevV : null };
    snapshot.units7709 = { value: v, asOf: store.latest.units7709.asOf };
    saved.push('units7709');
  }

  if (saved.length === 0) return res.status(400).json({ error: 'no recognizable fields in the paste' });

  store.history = [...store.history, snapshot].slice(-400); // cap the trend series
  const missing = KEYS.filter(k => !saved.includes(k));

  const w = await writeStore(store, sha, `Korea manual entry — ${saved.join(', ')} @ ${savedAt.slice(0, 10)}`);
  if (!w.ok) return res.status(502).json({ error: 'GitHub commit failed', detail: w });

  return res.status(200).json({ ok: true, saved, missing, latest: store.latest });
}
