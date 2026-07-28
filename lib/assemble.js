// assemble.js — one region-assembly path shared by BOTH deliverables:
//   • /api/preread  (Discord pre-read — adds the model prose on top of this)
//   • /api/playbook (dashboard tab — this structured data, no model)
// Keeps the data spine + regime computation in exactly one place.

import { UNIVERSE } from '../data/universe.js';
import { getQuotes, getMacro, getKoreaStress, getCrossAssets, hygCreditTell } from './quotes.js';
import { computeRegime } from './regime.js';
import { gaugesLeaning } from './gates.js';
import { composeRead } from './read.js';
import { kofiaStale, KOFIA_NAME_BY_KEY } from './kofia.js';
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
  // Round at the SOURCE so every cross-asset row is uniformly 2dp. Raw provider floats
  // (e.g. DXY 0.03449175014864352) must never reach the renderer.
  const r2 = v => (v == null || !Number.isFinite(v)) ? null : +Number(v).toFixed(2);
  cross.regime = { label: 'Cross-asset regime', rows: [
    { sym: 'GC=F', name: 'Gold', price: r2(macro.gold?.value), changePct: r2(macro.gold?.chg1d), delta: r2(macro.gold?.delta), dir: dirOf(macro.gold?.chg1d ?? macro.gold?.delta), basis: '1D' },
    { sym: 'BTC-USD', name: 'BTC', price: r2(macro.btc?.value), changePct: r2(macro.btc?.chg1d), delta: r2(macro.btc?.delta), dir: dirOf(macro.btc?.chg1d ?? macro.btc?.delta), basis: '1D' },
    { sym: 'DX-Y.NYB', name: 'DXY', price: r2(macro.dxy?.value), changePct: r2(macro.dxy?.changePct), delta: r2(macro.dxy?.delta), dir: dirOf(macro.dxy?.delta), basis: '1D' },
    { sym: 'DFII10', name: '10Y real', price: r2(macro.realYield?.value), delta: r2(macro.realYield?.deltaBps), unit: 'bps', dir: dirOf(macro.realYield?.deltaBps), basis: '1D' },
    { sym: '2s10s', name: '2s10s', price: r2(macro.twos10s), delta: r2(macro.twos10sDeltaBps), unit: 'bps', dir: dirOf(macro.twos10sDeltaBps), basis: '1D' },
  ] };

  const hyg = hygCreditTell(cross.volCredit?.rows?.find(r => r.sym === 'HYG'));
  const leaning = gaugesLeaning({
    credit: regime.credit,
    korea:  regime.korea,
    vix:    cross.volCredit?.rows?.find(r => r.sym === '^VIX'),
    nq:     nqLow,
    kofiaLatest: KOFIA_STORE.latest || {},
  });

  // Composed READ (Stage 4) — deterministic, from the structured gate state above.
  const kofiaLatest = KOFIA_STORE.latest || {};
  const staleNotes = Object.keys(kofiaLatest)
    .filter(k => kofiaLatest[k]?.asOf && kofiaStale(kofiaLatest[k].asOf))
    .map(k => `${KOFIA_NAME_BY_KEY[k] || k} stale (${kofiaLatest[k].asOf})`);
  const read = composeRead({
    credit: regime.credit, korea: regime.korea, cross, hyg, leaning,
    regimeSignal: macro.regimeSignal, kofiaLatest, staleNotes,
  });

  return { R, quotes, idxRaw, macro, korea, regime, cross, hyg, leaning, nqLow, read };
}
