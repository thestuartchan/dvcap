// /api/playbook?region=asia|eu|us
// Structured spine + regime for the dashboard's Global Playbook tab. Same data
// path as the Discord pre-read (lib/assemble.js) but WITHOUT the Anthropic
// prose call — so the tab is cheap to refresh on demand. No webhook, no model.

import { assembleRegion } from '../lib/assemble.js';
import { structure } from '../lib/regime.js';
import { weekHighlights } from '../lib/calendar.js';

export default async function handler(req, res) {
  const region = (req.query.region || 'asia').toLowerCase();
  const assembled = await assembleRegion(region);
  if (!assembled) return res.status(400).json({ error: 'bad region' });

  const { R, quotes, idxRaw, macro, regime } = assembled;

  // Attach display metadata + structure tag to each name, and names to indices.
  const names = quotes.map((q, i) => ({
    ...q,
    name:   R.names[i].name,
    role:   R.names[i].role,
    leader: !!R.names[i].leader,
    structure: structure(q),
  }));
  const indices = idxRaw.map((q, i) => ({ ...q, name: R.indices[i].name }));

  // 60s edge cache so a burst of tab opens doesn't hammer the providers.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  res.status(200).json({
    region,
    label: R.label,
    tz: R.tz,
    names,
    indices,
    macro,
    regime,               // includes regime.korea (Asia only) with won/vol/etf reads
    calendar: weekHighlights(),
    generatedAt: new Date().toISOString(),
  });
}
