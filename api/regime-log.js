// api/regime-log.js — the regime history log (P0.3).
//
// Why this exists: without a history the classifier is UNFALSIFIABLE. There is no way to ask
// "has it actually been right", and no way to re-run a change to the discriminator against
// what really happened. So we store the RAW INPUTS, not just the output — a logic change can
// then be backtested against every day already recorded.
//
// One row per DATE (not per refresh): the last write for a date wins, so a page that refreshes
// twenty times a day produces one row, and a later intraday state supersedes an earlier one.
// Uses the same GitHub commit-back store as the Korea entry — no new infrastructure.

import { upsertObservation } from '../lib/series.js';

const DATA_PATH = 'data/regime_history.json';

function ghHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dvcap-regime-log',
  };
}

async function readStore() {
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

export default async function handler(req, res) {
  // GET → read the log back (for the sparkline). No auth needed to read.
  if (req.method === 'GET') {
    if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) return res.status(200).json({ rows: [], note: 'store not configured' });
    try {
      const { store } = await readStore();
      const rows = (store.rows || []).slice(-Number(req.query.limit || 90));
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).json({ rows, count: (store.rows || []).length });
    } catch (e) {
      return res.status(200).json({ rows: [], error: String(e?.message || e) });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
  if (!/(^|;\s*)mwd_auth=true(;|$)/.test(req.headers.cookie || '')) {
    return res.status(401).json({ error: 'not authenticated' });
  }
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return res.status(500).json({ error: 'GITHUB_TOKEN / GITHUB_REPO not configured' });
  }

  const b = req.body || {};
  const date = String(b.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad or missing date (YYYY-MM-DD)' });

  const row = {
    date,
    // Probabilities (the four-state model)
    stagflation_p: b.stagflation_p ?? null,
    reflationary_p: b.reflationary_p ?? null,
    deflationary_p: b.deflationary_p ?? null,
    inflationary_p: b.inflationary_p ?? null,
    // The tape classifier's state, including the fifth
    hawkish_repricing: b.hawkish_repricing ?? null,
    live_regime: b.live_regime ?? null,
    view_regime: b.view_regime ?? null,
    pinned: !!b.pinned,
    // RAW CLASSIFIER INPUTS — the part that makes the log re-runnable. Without these a logic
    // change can only be tested going forward, which defeats the purpose.
    inputs: b.inputs ?? null,
    loggedAt: new Date().toISOString(),
  };

  const { store, sha } = await readStore();
  // Dedupe by date: last write for a given day wins, ordered ascending.
  store.rows = upsertObservation(
    (store.rows || []).map(r => ({ ...r, value: 1 })),   // upsertObservation needs a value key
    { ...row, value: 1 },
  ).map(({ value, ...r }) => r).slice(-800);

  const content = Buffer.from(JSON.stringify(store, null, 2) + '\n', 'utf8').toString('base64');
  const body = {
    message: `Regime log — ${row.live_regime ?? 'n/a'} @ ${date}`,
    content, branch: process.env.GITHUB_BRANCH || 'main', ...(sha ? { sha } : {}),
  };
  const w = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${DATA_PATH}`, {
    method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body),
  });
  if (!w.ok) return res.status(502).json({ error: 'GitHub commit failed', detail: (await w.text()).slice(0, 300) });
  return res.status(200).json({ ok: true, date, rows: store.rows.length });
}
