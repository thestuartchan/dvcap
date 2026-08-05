// /api/playbook?region=asia|eu|us
// Structured spine + regime for the dashboard's Global Playbook tab. Same data
// path as the Discord pre-read (lib/assemble.js) but WITHOUT the Anthropic
// prose call — so the tab is cheap to refresh on demand. No webhook, no model.

import { assembleRegion } from '../lib/assemble.js';
import { structure } from '../lib/regime.js';
import { weekHighlights } from '../lib/calendar.js';
import { freshness, sessionPhase, localClock } from '../lib/sessions.js';
import KOFIA_STORE from '../data/korea_kofia.json' with { type: 'json' };
import { seriesFromHistory, normalizeSeries } from '../lib/series.js';

const SERIES_KEYS = ['marginLoans', 'deposits', 'cma', 'kospi', 'kr3yGovt', 'kr3yCorp',
                     'units7709', 'foreignNet', 'instNet', 'retailNet'];
// Serve the dated series even for stores written before it existed: backfill from the legacy
// savedAt-keyed snapshots, which also collapses duplicate same-date rows. Computed once at
// module load — the store only changes on redeploy.
const KOFIA_SERIES = (() => {
  const base = KOFIA_STORE.series || seriesFromHistory(KOFIA_STORE.history, SERIES_KEYS);
  const out = {};
  for (const k of SERIES_KEYS) out[k] = normalizeSeries(base[k]);
  return out;
})();

export default async function handler(req, res) {
  const region = (req.query.region || 'asia').toLowerCase();
  const assembled = await assembleRegion(region);
  if (!assembled) return res.status(400).json({ error: 'bad region' });

  const { R, quotes, idxRaw, macro, regime, cross, hyg, leaning, read, marketRegime, ladder, fx, won, intervention } = assembled;

  // Attach display metadata + structure tag to each name, and names to indices.
  // `session` = explicit phase of that symbol's OWN exchange (live/pre/post/lunch/holiday/
  // weekend) so the UI can badge it and never render a prior-close print as clean-live.
  const names = quotes.map((q, i) => ({
    ...q,
    name:   R.names[i].name,
    role:   R.names[i].role,
    leader: !!R.names[i].leader,
    structure: structure(q),
    freshness: freshness(q.sym, q),   // market-state-aware — not the raw feed-age flag
    session:   sessionPhase(q.sym),
  }));
  const indices = idxRaw.map((q, i) => ({ ...q, name: R.indices[i].name, freshness: freshness(q.sym, q), session: sessionPhase(q.sym) }));

  // Region-level session badge: phase of the region's primary index + a live local clock.
  const primaryIdxSym = R.indices[0]?.sym;
  const regionSession = primaryIdxSym ? sessionPhase(primaryIdxSym) : 'closed';
  const regionClock   = localClock(R.tz);

  // 60s edge cache so a burst of tab opens doesn't hammer the providers.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  res.status(200).json({
    region,
    label: R.label,
    tz: R.tz,
    session: regionSession,
    clock: regionClock,
    names,
    indices,
    macro,
    regime,               // includes regime.korea (Asia only) with won/vol reads
    cross,                // Stage 3A — cross-asset groups, each row value + 1D delta + direction
    hyg,                  // Stage 3B — live intraday credit tell (leads the EOD OAS print)
    leaning,              // Stage 3B — how many regime tripwires point the same way
    read,                 // Stage 4 — composed deterministic READ (no model call)
    marketRegime,         // P0.1 — cross-asset regime read (incl. HAWKISH_RATES_REPRICING)
    ladder,               // P5  — concentration ladder + single-theme alert
    fx,                   // P4  — FX leg decomposition + DXY reliability flag
    won,                  // F4  — USD/KRW attribution: macro move vs Korea-specific (Gate 2)
    intervention,         // F3  — manual intervention flag + DXY yen-leg attribution
    calendar: weekHighlights(),
    // `series` is the authoritative dated store (one row per observation date, ordered);
    // `history` stays for backward compatibility with older cached clients.
    kofia: {
      latest: KOFIA_STORE.latest || {},
      series: KOFIA_SERIES,
      history: (KOFIA_STORE.history || []).slice(-90),
    },
    generatedAt: new Date().toISOString(),
  });
}
