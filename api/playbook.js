// /api/playbook?region=asia|eu|us
// Structured spine + regime for the dashboard's Global Playbook tab. Same data
// path as the Discord pre-read (lib/assemble.js) but WITHOUT the Anthropic
// prose call — so the tab is cheap to refresh on demand. No webhook, no model.

import { assembleRegion } from '../lib/assemble.js';
import { structure } from '../lib/regime.js';
import { weekHighlights } from '../lib/calendar.js';
import { freshness, sessionPhase, localClock } from '../lib/sessions.js';
import KOFIA_STORE from '../data/korea_kofia.json' with { type: 'json' };

export default async function handler(req, res) {
  const region = (req.query.region || 'asia').toLowerCase();
  const assembled = await assembleRegion(region);
  if (!assembled) return res.status(400).json({ error: 'bad region' });

  const { R, quotes, idxRaw, macro, regime } = assembled;

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
    calendar: weekHighlights(),
    kofia: { latest: KOFIA_STORE.latest || {}, history: (KOFIA_STORE.history || []).slice(-90) },
    generatedAt: new Date().toISOString(),
  });
}
