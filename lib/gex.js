// lib/gex.js — gamma exposure: aggregate, flip level, walls, and how much of it is assumption.
//
// GEX = [Σ(Γcall · OIcall) − Σ(Γput · OIput)] × 100 × S² × 0.01
//
// The 100 is the contract multiplier. S² × 0.01 turns gamma — which is per $1 of spot — into
// dollars of delta the dealer must trade per 1% move, which is the only form in which the number
// means anything operationally.
//
// ── ON THE TWO CONVENTIONS ───────────────────────────────────────────────────
// The brief asks for both dealer sign conventions, and for a fragility flag when they disagree on
// the flip level. They cannot disagree. "Dealers long calls, short puts" is (+1, −1) and its
// inverse is (−1, +1), which is the first negated TERM BY TERM — so the second profile is the
// first reflected through zero, and a reflection has exactly the same zeros. Verified numerically
// in the tests: at every spot, B === −A to machine precision, and the two flip levels are equal.
//
// So both are computed and stored as asked, and the flag they were meant to raise is replaced with
// one that measures something. The real uncertainty is not WHICH way the signs point, it is that
// the whole model assumes every put is dealer-short — dealers are the other side of customer flow,
// and customers do not only buy puts. `flipFragility` relaxes that: it re-solves the flip with a
// fraction of put open interest held the other way, and reports how far the level moves. A flip
// that barely moves is a level worth trading around; one that slides fifteen points on a plausible
// change of assumption is a number with a story attached, and the panel says so.

import { gamma as bsGamma, yearsTo } from './blackscholes.js';

export const GEX_CONVENTIONS = Object.freeze({
  longCallsShortPuts: { call: 1, put: -1 },   // the classic, and the default everywhere it is quoted
  shortCallsLongPuts: { call: -1, put: 1 },   // its exact reflection — same flip, opposite sign
});
export const CONTRACT_MULTIPLIER = 100;
// How far either side of spot to look for the flip, and how finely. ±10% matches the strike trim:
// beyond it there is no open interest worth solving against.
export const FLIP_SCAN_PCT = 10;
export const FLIP_SCAN_STEPS = 400;
// The put-positioning assumption is relaxed this far when measuring fragility. 25% of put OI on
// the other side is a large but not absurd departure from "dealers are short every put".
export const FRAGILITY_FRACS = Object.freeze([0, 0.05, 0.10, 0.15, 0.20, 0.25]);

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// One contract's gamma at a given spot. Returns null — never 0 — when it cannot be computed, so a
// missing IV drops out of the sum instead of quietly pulling the aggregate toward zero.
export function contractGamma(c, { S, r = 0, q = 0, now } = {}) {
  const T = c?.T != null ? num(c.T) : yearsTo(c?.expiry, now);
  const iv = num(c?.iv);
  if (T == null || iv == null || !(iv > 0)) return null;
  return bsGamma({ S, K: num(c?.strike), T, r, q, sigma: iv });
}

// Net GAMMA (not dollars) across the chain at a hypothetical spot.
// `dealerLongPutFrac` is the fragility knob: 0 means every put is dealer-short, 0.5 means puts net
// to nothing. It scales the put leg by (1 − 2f), which is the net of (1−f) short and f long.
export function netGammaAt(chain = [], S, {
  r = 0, q = 0, now, convention = 'longCallsShortPuts', dealerLongPutFrac = 0,
} = {}) {
  const sign = GEX_CONVENTIONS[convention] || GEX_CONVENTIONS.longCallsShortPuts;
  const f = Math.max(0, Math.min(0.5, num(dealerLongPutFrac) ?? 0));
  let net = 0, used = 0, skipped = 0;
  for (const c of (Array.isArray(chain) ? chain : [])) {
    const oi = num(c?.oi);
    const g = contractGamma(c, { S, r, q, now });
    if (g == null || oi == null || oi <= 0) { skipped++; continue; }
    const isCall = c.type === 'call';
    const s = isCall ? sign.call : sign.put * (1 - 2 * f);
    net += s * g * oi;
    used++;
  }
  return { net, used, skipped };
}

// Gamma → dollars per 1% move.
export const toDollarGex = (netGamma, S) => {
  const s = num(S), g = num(netGamma);
  return (s == null || g == null) ? null : g * CONTRACT_MULTIPLIER * s * s * 0.01;
};

// ── the flip ─────────────────────────────────────────────────────────────────
// The spot at which net gamma crosses zero. Solved by scanning, not by algebra: gamma is not
// monotone in S and the sum can cross more than once, so a closed form would be answering a
// different question. The scan reports the crossing NEAREST SPOT, which is the one that governs
// behaviour today, and says how many it found — more than one is itself information.
export function flipLevel(chain = [], { S, r = 0, q = 0, now, convention = 'longCallsShortPuts',
  dealerLongPutFrac = 0, scanPct = FLIP_SCAN_PCT, steps = FLIP_SCAN_STEPS } = {}) {
  const s = num(S);
  if (s == null || !(s > 0) || !Array.isArray(chain) || !chain.length) {
    return { level: null, crossings: 0, all: [], reason: 'no spot or no chain' };
  }
  const lo = s * (1 - scanPct / 100), hi = s * (1 + scanPct / 100);
  const step = (hi - lo) / steps;
  const opts = { r, q, now, convention, dealerLongPutFrac };
  const all = [];
  let prevX = lo, prevY = netGammaAt(chain, lo, opts).net;
  for (let i = 1; i <= steps; i++) {
    const x = lo + i * step;
    const y = netGammaAt(chain, x, opts).net;
    if (prevY === 0) all.push(prevX);
    else if ((prevY < 0) !== (y < 0)) {
      // Linear interpolation between the bracketing points. The profile is smooth at this
      // resolution, so this is accurate to well under a tick.
      all.push(prevX + (x - prevX) * (Math.abs(prevY) / (Math.abs(prevY) + Math.abs(y))));
    }
    prevX = x; prevY = y;
  }
  if (!all.length) {
    // No crossing inside the scan is a real answer: the book is one-signed across the whole
    // plausible range. Saying "no flip in ±10%" is very different from saying the flip is at spot.
    const sign = netGammaAt(chain, s, opts).net >= 0 ? 'positive' : 'negative';
    return { level: null, crossings: 0, all: [], reason: `net gamma stays ${sign} across ±${scanPct}% of spot` };
  }
  const nearest = all.reduce((a, b) => Math.abs(b - s) < Math.abs(a - s) ? b : a);
  return { level: +nearest.toFixed(4), crossings: all.length, all: all.map(v => +v.toFixed(4)), reason: null };
}

// How much of the flip is assumption. Re-solves it with a slice of put OI held the other way and
// reports the spread. This is what the two-conventions flag was reaching for and could not measure.
export function flipFragility(chain = [], opts = {}, fracs = FRAGILITY_FRACS) {
  const points = fracs.map(f => ({ frac: f, level: flipLevel(chain, { ...opts, dealerLongPutFrac: f }).level }))
    .filter(p => p.level != null);
  if (points.length < 2) {
    return { points, zone: null, spread: null, spreadPctOfSpot: null, fragile: false,
      note: 'not enough solutions to compare — the book has no flip across the assumption range' };
  }
  const levels = points.map(p => p.level);
  const lo = +Math.min(...levels).toFixed(4), hi = +Math.max(...levels).toFixed(4);
  const spread = +(hi - lo).toFixed(4);
  const S = num(opts?.S);
  const spreadPctOfSpot = S ? +((spread / S) * 100).toFixed(2) : null;
  // MEASURED, NOT GUESSED. Across every book shape tried — lopsided, thin-winged, wide — the flip
  // moves 3 to 5 points on a 25% change in the put assumption. That is not a quirk of one fixture:
  // the flip is BY DEFINITION the spot where call gamma balances put gamma, so reweighting the put
  // side moves it directly. The honest output is therefore a ZONE, and the boolean below fires
  // often on purpose. A flag that is usually true and correct beats one tuned until it is quiet.
  const fragile = spreadPctOfSpot != null && spreadPctOfSpot > 1.0;
  return {
    points, zone: { lo, hi }, spread, spreadPctOfSpot, fragile,
    note: fragile
      ? `flip zone ${lo}–${hi} (${spread} wide, ${spreadPctOfSpot}% of spot) as the dealer put assumption varies — a zone, not a line`
      : `the flip holds inside ${spread} (${spreadPctOfSpot}% of spot) across the assumption range — tight enough to read as a level`,
  };
}

// ── walls ────────────────────────────────────────────────────────────────────
// The strikes carrying the most gamma-weighted open interest. Weighted, not raw OI: a far strike
// with enormous OI and no gamma pins nothing, and a raw-OI "wall" is the most common way this
// analysis is got wrong.
export function walls(chain = [], { S, r = 0, q = 0, now } = {}) {
  const byStrike = new Map();
  for (const c of (Array.isArray(chain) ? chain : [])) {
    const k = num(c?.strike), oi = num(c?.oi);
    const g = contractGamma(c, { S, r, q, now });
    if (k == null || oi == null || g == null || oi <= 0) continue;
    if (!byStrike.has(k)) byStrike.set(k, { strike: k, callGamma: 0, putGamma: 0, callOi: 0, putOi: 0 });
    const row = byStrike.get(k);
    if (c.type === 'call') { row.callGamma += g * oi; row.callOi += oi; }
    else { row.putGamma += g * oi; row.putOi += oi; }
  }
  const rows = [...byStrike.values()]
    .map(r0 => ({ ...r0, netGamma: r0.callGamma - r0.putGamma,
      callGexUsd: toDollarGex(r0.callGamma, S), putGexUsd: toDollarGex(r0.putGamma, S),
      netGexUsd: toDollarGex(r0.callGamma - r0.putGamma, S) }))
    .sort((a, b) => a.strike - b.strike);
  const top = (key) => rows.reduce((best, r0) => (best == null || r0[key] > best[key]) ? r0 : best, null);
  const cw = top('callGamma'), pw = top('putGamma');
  return {
    byStrike: rows,
    callWall: cw && cw.callGamma > 0 ? cw.strike : null,
    putWall: pw && pw.putGamma > 0 ? pw.strike : null,
  };
}

// ── the row that gets stored ─────────────────────────────────────────────────
export function gexSummary(chain = [], { S, r = 0, q = 0, now, date = null, symbol = null, advUsd = null } = {}) {
  const s = num(S);
  const base = { r, q, now };
  const gA = netGammaAt(chain, s, { ...base, convention: 'longCallsShortPuts' });
  const gB = netGammaAt(chain, s, { ...base, convention: 'shortCallsLongPuts' });
  const w = walls(chain, { S: s, r, q, now });
  const flipA = flipLevel(chain, { S: s, ...base, convention: 'longCallsShortPuts' });
  const flipB = flipLevel(chain, { S: s, ...base, convention: 'shortCallsLongPuts' });
  const frag = flipFragility(chain, { S: s, ...base, convention: 'longCallsShortPuts' });

  const calls = chain.filter(c => c?.type === 'call');
  const puts = chain.filter(c => c?.type === 'put');
  const sumOi = (xs) => xs.reduce((a, c) => a + (num(c?.oi) ?? 0), 0);
  const oiWeightedIv = (xs) => {
    let wsum = 0, isum = 0;
    for (const c of xs) { const oi = num(c?.oi), iv = num(c?.iv); if (oi > 0 && iv > 0) { wsum += oi; isum += oi * iv; } }
    return wsum > 0 ? +(isum / wsum).toFixed(4) : null;
  };

  const gexUsd = toDollarGex(gA.net, s);
  return {
    date, symbol, spot: s,
    // WHEN, not just which day. A daily row quoted to two decimals at 14:00 off an 09:00 capture
    // is not wrong, it is stale — and stale reads precise, which is worse. The panel needs hours.
    asOf: now || new Date().toISOString(),
    // Both conventions, as asked. They are exact reflections; the tests assert it rather than
    // leaving a reader to wonder whether the second column is telling them anything new.
    gexUsd, gexUsdInverse: toDollarGex(gB.net, s),
    netGamma: gA.net,
    flipLevel: flipA.level, flipCrossings: flipA.crossings, flipReason: flipA.reason,
    flipLevelInverse: flipB.level,
    // True by construction; stored so a future change that breaks it is visible in the data.
    conventionsAgreeOnFlip: flipA.level != null && flipB.level != null
      ? Math.abs(flipA.level - flipB.level) < 1e-6 : null,
    flipSpread: frag.spread, flipSpreadPctOfSpot: frag.spreadPctOfSpot,
    flipZoneLo: frag.zone?.lo ?? null, flipZoneHi: frag.zone?.hi ?? null,
    flipFragile: frag.fragile, flipNote: frag.note,
    callWall: w.callWall, putWall: w.putWall,
    callOi: sumOi(calls), putOi: sumOi(puts),
    oiWeightedIv: oiWeightedIv(chain),
    contracts: chain.length, contractsUsed: gA.used, contractsSkipped: gA.skipped,
    // NORMALISED so the series stays comparable as the index level drifts. A raw dollar GEX from
    // 2026 cannot be read next to one from 2028 — the same positioning is a bigger number simply
    // because QQQ is higher.
    gexPctOfAdv: (gexUsd != null && num(advUsd) > 0) ? +((gexUsd / advUsd) * 100).toFixed(3) : null,
    gexPerSpotPct: gexUsd != null && s ? +(gexUsd / s).toFixed(2) : null,
    advUsd: num(advUsd),
  };
}
