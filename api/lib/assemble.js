// assemble.js — one region-assembly path shared by BOTH deliverables:
//   • /api/preread  (Discord pre-read — adds the model prose on top of this)
//   • /api/playbook (dashboard tab — this structured data, no model)
// Keeps the data spine + regime computation in exactly one place.

import { UNIVERSE } from '../../data/universe.js';
import { getQuotes, getMacro, getKoreaStress } from './quotes.js';
import { computeRegime } from './regime.js';

export async function assembleRegion(region) {
  const R = UNIVERSE[region];
  if (!R) return null;

  const nameSyms = R.names.map(n => n.sym);
  const idxSyms  = R.indices.map(n => n.sym);

  const [quotes, idxRaw, macro, korea] = await Promise.all([
    getQuotes(nameSyms),
    getQuotes(idxSyms),
    getMacro(),
    // Korea-local stress gate is Asia-specific — skip the fetch for EU/US.
    region === 'asia' ? getKoreaStress() : Promise.resolve(null),
  ]);

  const regime = computeRegime({ quotes, names: R.names, macro, korea });
  return { R, quotes, idxRaw, macro, korea, regime };
}
