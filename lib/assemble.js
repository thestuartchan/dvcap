// assemble.js — one region-assembly path shared by BOTH deliverables:
//   • /api/preread  (Discord pre-read — adds the model prose on top of this)
//   • /api/playbook (dashboard tab — this structured data, no model)
// Keeps the data spine + regime computation in exactly one place.

import { UNIVERSE } from '../data/universe.js';
import { getQuotes, getMacro, getKoreaStress, getCrossAssets, hygCreditTell } from './quotes.js';
import { computeRegime } from './regime.js';
import { gaugesLeaning } from './gates.js';
import { yahooLowerLow } from './yahoo.js';
import KOFIA_STORE from '../data/korea_kofia.json' with { type: 'json' };

export async function assembleRegion(region) {
  const R = UNIVERSE[region];
  if (!R) return null;

  const nameSyms = R.names.map(n => n.sym);
  const idxSyms  = R.indices.map(n => n.sym);

  // US Pre-Read fires pre-open, so overlay pre/post-market prints for its names+indices.
  const prepost = region === 'us';
  const [quotes, idxRaw, macro, korea, cross, nqLow] = await Promise.all([
    getQuotes(nameSyms, { prepost }),
    getQuotes(idxSyms, { prepost }),
    getMacro(),
    // Korea-local stress gate is Asia-specific — skip the fetch for EU/US.
    region === 'asia' ? getKoreaStress() : Promise.resolve(null),
    getCrossAssets(),               // Stage 3A — the daily cross-asset set
    yahooLowerLow('^NDX'),          // Stage 3B — NQ lower-low tripwire
  ]);

  const regime = computeRegime({ quotes, names: R.names, macro, korea });

  // Cross-asset regime row reuses the macro spine rather than re-fetching: gold/BTC/DXY carry
  // their own 1d direction, 10Y real + 2s10s come from FRED deltas.
  const dirOf = d => d == null ? null : d > 0 ? 'rising' : d < 0 ? 'falling' : 'flat';
  cross.regime = { label: 'Cross-asset regime', rows: [
    { sym: 'GC=F', name: 'Gold', price: macro.gold?.value, changePct: macro.gold?.chg1d ?? null, delta: macro.gold?.delta ?? null, dir: dirOf(macro.gold?.chg1d ?? macro.gold?.delta), basis: '1D' },
    { sym: 'BTC-USD', name: 'BTC', price: macro.btc?.value, changePct: macro.btc?.chg1d ?? null, delta: macro.btc?.delta ?? null, dir: dirOf(macro.btc?.chg1d ?? macro.btc?.delta), basis: '1D' },
    { sym: 'DX-Y.NYB', name: 'DXY', price: macro.dxy?.value, changePct: macro.dxy?.changePct ?? null, delta: macro.dxy?.delta ?? null, dir: dirOf(macro.dxy?.delta), basis: '1D' },
    { sym: 'DFII10', name: '10Y real', price: macro.realYield?.value, delta: macro.realYield?.deltaBps ?? null, unit: 'bps', dir: dirOf(macro.realYield?.deltaBps), basis: '1D' },
    { sym: '2s10s', name: '2s10s', price: macro.twos10s, delta: macro.twos10sDeltaBps ?? null, unit: 'bps', dir: dirOf(macro.twos10sDeltaBps), basis: '1D' },
  ] };

  const hyg = hygCreditTell(cross.volCredit?.rows?.find(r => r.sym === 'HYG'));
  const leaning = gaugesLeaning({
    credit: regime.credit,
    korea:  regime.korea,
    vix:    cross.volCredit?.rows?.find(r => r.sym === '^VIX'),
    nq:     nqLow,
    kofiaLatest: KOFIA_STORE.latest || {},
  });

  return { R, quotes, idxRaw, macro, korea, regime, cross, hyg, leaning, nqLow };
}
