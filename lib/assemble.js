// assemble.js — one region-assembly path shared by BOTH deliverables:
//   • /api/preread  (Discord pre-read — adds the model prose on top of this)
//   • /api/playbook (dashboard tab — this structured data, no model)
// Keeps the data spine + regime computation in exactly one place.

import { UNIVERSE } from '../data/universe.js';
import { getQuotes, getMacro, getKoreaStress, getCrossAssets, getVolTerm, hygCreditTell, fxDivergence } from './quotes.js';
import { computeRegime } from './regime.js';
import { gaugesLeaning, csop7709Tripwire } from './gates.js';
import { volTermStructure } from './volterm.js';
import { crossMarketHandoff } from './handoff.js';
import { evaluateScenarios } from './scenarios.js';
import { fetchSmicAHPremium } from './smicah.js';
import { southboundLevelTrend } from './southbound.js';
import { smhSoxxTell } from './concentration.js';
import { composeRead } from './read.js';
import { marketState } from './sessions.js';
import { classifyMarketRegime, concentrationLadder } from './regimeState.js';
import { wonRead, interventionAnnotation } from './fx.js';
import { kofiaStale, KOFIA_NAME_BY_KEY } from './kofia.js';
import { yahooLowerLow } from './yahoo.js';
import KOFIA_STORE from '../data/korea_kofia.json' with { type: 'json' };
// F3 — operator flags (intervention, etc). Committed-back store, same pattern as KOFIA.
import MANUAL_STORE from '../data/manual_entry.json' with { type: 'json' };

export async function assembleRegion(region) {
  const R = UNIVERSE[region];
  if (!R) return null;

  const nameSyms = R.names.map(n => n.sym);
  const idxSyms  = R.indices.map(n => n.sym);

  // US Pre-Read fires pre-open, so overlay pre/post-market prints for its names+indices.
  const prepost = region === 'us';
  const [quotes, idxRaw, macro, korea, cross, nqLow, volTermRaw, soxRes, smicAH, soxxRes] = await Promise.all([
    getQuotes(nameSyms, { prepost }),
    getQuotes(idxSyms, { prepost }),
    getMacro(),
    // Korea-local stress gate is Asia-specific — skip the fetch for EU/US.
    region === 'asia' ? getKoreaStress() : Promise.resolve(null),
    getCrossAssets(),               // Stage 3A — the daily cross-asset set
    yahooLowerLow('^NDX'),          // Stage 3B — NQ lower-low tripwire
    getVolTerm(),                   // C1 — VIX term structure (front/spot/back)
    region === 'asia' ? getQuotes(['^SOX']) : Promise.resolve(null),  // C3 — SOX overnight driver
    fetchSmicAHPremium(),           // China-policy scenario leg — SMIC A/H premium + trend
    getQuotes(['SOXX']),            // D3 — SMH − SOXX concentration spread (SMH from cross-assets)
  ]);
  // C1 — classify the VIX curve shape (contango/flat/backwardation + event-pricing overlay).
  const volTerm = volTermStructure(volTermRaw);
  // A4 — is the US regular session open right now? Outside RTH the US-derived READ clauses
  // (HYG credit tell, VIX/NQ tripwires) are composed off prior-close prints, so the READ is
  // marked accordingly rather than presented as a live intraday read.
  const usRthOpen = marketState('SPY') === 'open';

  // C3 — cross-market handoff (Asia only). Asia's live aggregate move vs the overnight drivers.
  let handoff = null;
  if (region === 'asia') {
    const idxPcts = idxRaw.map(q => q?.changePct).filter(v => Number.isFinite(v));
    const asiaChangePct = idxPcts.length ? idxPcts.reduce((a, b) => a + b, 0) / idxPcts.length : null;
    const tltRow = (cross.rates?.rows || []).find(r => r.sym === 'TLT')
                || (cross.breadth?.rows || []).find(r => r.sym === 'TLT');
    handoff = crossMarketHandoff({
      asiaChangePct,
      sox:   soxRes?.[0] || null,
      tlt:   tltRow || null,
      wti:   macro.wti || null,
      brent: macro.brent || null,
    });
  }

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
    { sym: 'T10YIE', name: '10Y BE', price: r2(macro.breakeven?.value), delta: r2(macro.breakeven?.deltaBps), unit: 'bps', dir: dirOf(macro.breakeven?.deltaBps), basis: '1D' },
    { sym: 'T5YIFR', name: '5y5y fwd BE', price: r2(macro.fwdBreakeven?.value), delta: r2(macro.fwdBreakeven?.deltaBps), unit: 'bps', dir: dirOf(macro.fwdBreakeven?.deltaBps), basis: '1D' },
    { sym: 'DFII10', name: '10Y real', price: r2(macro.realYield?.value), delta: r2(macro.realYield?.deltaBps), unit: 'bps', dir: dirOf(macro.realYield?.deltaBps), basis: '1D' },
    { sym: '2s10s', name: '2s10s', price: r2(macro.twos10s), delta: r2(macro.twos10sDeltaBps), unit: 'bps', dir: dirOf(macro.twos10sDeltaBps), basis: '1D' },
  ] };

  // ── Cross-asset regime read (P0.1) + breadth ladder (P5) ──
  // pctOf reaches across every cross-asset group so a symbol can move between groups without
  // silently becoming null here.
  const allCross = Object.values(cross).flatMap(g => g?.rows || []);
  const pctOf = sym => allCross.find(r => r.sym === sym)?.changePct ?? null;
  const marketRegime = classifyMarketRegime({
    // GLD is the tradable gold leg the spec names; fall back to the futures print if absent.
    gold: pctOf('GLD') ?? (macro.gold?.chg1d ?? null),
    tlt: pctOf('TLT'), xlu: pctOf('XLU'), xlp: pctOf('XLP'),
    spy: pctOf('SPY'), qqq: pctOf('QQQ'), iwm: pctOf('IWM'),
    btc: macro.btc?.chg1d ?? null,
    // Yield legs come from FRED's last two real prints (value + prior), not a same-day guess.
    us10y: macro.us10y ? { now: macro.us10y.value, prior: macro.us10y.prev ?? null } : null,
    us2y:  macro.us2y  ? { now: macro.us2y.value,  prior: macro.us2y.prev  ?? null } : null,
    realYield: macro.realYield ? { now: macro.realYield.value, prior: macro.realYield.prev ?? null } : null,
    // Section B — ACM term premium (model estimate; direction only).
    termPremium: macro.termPremium ? { now: macro.termPremium.value, prior: macro.termPremium.prev ?? null } : null,
    // F2 / Q1 — market-implied inflation. This series was fetched, Fisher-checked and
    // rendered, but never reached a decision function; gold was being read alone as a result.
    breakeven: macro.breakeven ? { now: macro.breakeven.value, prior: macro.breakeven.prev ?? null } : null,
  });
  const fx = fxDivergence(cross.fx?.rows || []);   // P4 — is DXY representative today?
  // F4 — attribute the won move before Gate 2 is read. A strengthening won means opposite
  // things depending on whether the dollar and yen corroborate it.
  const won = wonRead({
    krwChangePct: pctOf('KRW=X'), dxyChangePct: pctOf('DX-Y.NYB'), jpyChangePct: pctOf('JPY=X'),
  });
  // F3 — manual flag, set via the operator entry store. Off unless explicitly turned on.
  const intervention = interventionAnnotation({
    ...(MANUAL_STORE?.intervention || {}),
    jpyChangePct: pctOf('JPY=X'), dxyChangePct: pctOf('DX-Y.NYB'),
  });
  const ladder = concentrationLadder({
    SMH: pctOf('SMH'), QQQ: pctOf('QQQ'), SPY: pctOf('SPY'), IWM: pctOf('IWM'), HYG: pctOf('HYG'),
  });

  const hyg = hygCreditTell(
    cross.volCredit?.rows?.find(r => r.sym === 'HYG'),
    allCross.find(r => r.sym === 'QQQ'),      // P2 — credit vs equities is the actionable read
  );
  const leaning = gaugesLeaning({
    credit: regime.credit,
    korea:  regime.korea,
    vix:    cross.volCredit?.rows?.find(r => r.sym === '^VIX'),
    nq:     nqLow,
    kofiaLatest: KOFIA_STORE.latest || {},
  });
  // P2 — CSOP 7709 deleveraging tripwire, surfaced STANDALONE (not folded into the gauges
  // cluster, whose denominator should stay the broad macro/US set).
  const csop7709 = csop7709Tripwire({
    units7709: (KOFIA_STORE.latest || {}).units7709,
    series:    KOFIA_STORE.series?.units7709 || [],
  });

  // Part C — scenario board. Synthesizes the category-bucketed data into "which scenario am I
  // in". Server-computed from in-assembly values; every threshold lives in SCENARIO_CFG. The
  // SMIC A/H leg is not fetched here yet — its conditions render n/a until wired.
  const crossRow = sym => allCross.find(r => r.sym === sym) || null;
  const scenarios = evaluateScenarios({
    us30y: macro.us30y, oas: macro.oas,
    tenThirtyDeltaBps: (macro.us30y?.deltaBps != null && macro.us10y?.deltaBps != null)
      ? macro.us30y.deltaBps - macro.us10y.deltaBps : null,
    tlt: crossRow('TLT'),
    basket: [crossRow('TLT'), crossRow('XLU'), crossRow('XLP'), crossRow('IWM'), crossRow('GLD')]
      .filter(Boolean).map(r => ({ name: r.name, dir: r.dir })),
    korea: regime.korea ? { volBand: regime.korea.vol?.band ?? null, volRolling: regime.korea.vol?.rolling ?? null } : {},
    units7709: { dayPct: csop7709?.available ? csop7709.dayPct : null },
    // China policy — the A/H premium TREND (5d/20d point change). Compressing = mainland
    // enthusiasm fading, the unwind signature. Null legs when the feed is down.
    ah: smicAH?.series?.length ? (() => { const t = southboundLevelTrend(smicAH.series, 'premium'); return { d5: t.d5, d20: t.d20, level: t.level }; })() : null,
  });

  // D3 — SMH − SOXX concentration spread (SMH from the breadth ladder, SOXX its own fetch).
  const smhSoxx = smhSoxxTell({ smh: crossRow('SMH'), soxx: soxxRes?.[0] || null });

  // Composed READ (Stage 4) — deterministic, from the structured gate state above.
  const kofiaLatest = KOFIA_STORE.latest || {};
  const staleNotes = Object.keys(kofiaLatest)
    .filter(k => kofiaLatest[k]?.asOf && kofiaStale(kofiaLatest[k].asOf))
    .map(k => `${KOFIA_NAME_BY_KEY[k] || k} stale (${kofiaLatest[k].asOf})`);
  const read = composeRead({
    credit: regime.credit, korea: regime.korea, cross, hyg, leaning,
    regimeSignal: macro.regimeSignal, kofiaLatest, staleNotes, usRthOpen,
  });

  return { R, quotes, idxRaw, macro, korea, regime, cross, hyg, leaning, csop7709, volTerm, handoff, scenarios, smhSoxx, nqLow, read, marketRegime, ladder, fx, won, intervention };
}
