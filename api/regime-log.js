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

import { hasSessionCookie, refuse } from '../lib/apiauth.js';
import { readRegimeStore, writeRegimeRow, logConfigured, HAS_CONTENT } from '../lib/regimeLog.js';
// The store, the merge and the commit live in lib/regimeLog.js, shared with the pre-read cron.

export default async function handler(req, res) {
  // GET → read the log back (for the sparkline). No auth needed to read.
  if (req.method === 'GET') {
    if (!logConfigured()) return res.status(200).json({ rows: [], note: 'store not configured' });
    try {
      const { store } = await readRegimeStore();
      // Serve only rows that actually carry a reading. A husk plots as a gap and counts as a
      // day logged, which is how an empty chart came to claim '3 days logged'.
      const all = (store.rows || []).filter(HAS_CONTENT);
      const rows = all.slice(-Number(req.query.limit || 90));
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).json({ rows, count: all.length, stored: (store.rows || []).length });
    } catch (e) {
      return res.status(200).json({ rows: [], error: String(e?.message || e) });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
  if (!(await hasSessionCookie(req))) return refuse(res);
  if (!logConfigured()) return res.status(500).json({ error: 'GITHUB_TOKEN / GITHUB_REPO not configured' });

  const b = req.body || {};
  const date = String(b.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad or missing date (YYYY-MM-DD)' });

  const row = {
    date,
    stagflation_p: b.stagflation_p ?? null, reflationary_p: b.reflationary_p ?? null,
    deflationary_p: b.deflationary_p ?? null, inflationary_p: b.inflationary_p ?? null,
    hawkish_repricing: b.hawkish_repricing ?? null,
    live_regime: b.live_regime ?? null, view_regime: b.view_regime ?? null, pinned: !!b.pinned,
    hyg_chg: b.hyg_chg ?? null, hyg_qqq_divergence: b.hyg_qqq_divergence ?? null,
    // RAW CLASSIFIER INPUTS — the part that makes the log re-runnable.
    inputs: b.inputs ?? null,
    source: 'client',
    loggedAt: new Date().toISOString(),
  };
  const w = await writeRegimeRow(row);
  if (!w.ok) return res.status(502).json(w);
  return res.status(200).json(w);
}
