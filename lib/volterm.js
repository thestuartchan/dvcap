// lib/volterm.js — VIX term-structure regime (C1). Three points on the curve:
//   VIX9D (front, ^VIX9D) · VIX (spot, ^VIX) · VIX3M (back, ^VIX3M)
//
// The SHAPE of the curve governs options posture far more than the spot level:
//   VIX9D < VIX < VIX3M   → CONTANGO       — calm upward slope; dips buyable, premium sellable
//   VIX9D ≈ VIX3M         → FLAT           — regime transition; cut size
//   VIX9D > VIX3M         → BACKWARDATION  — stress; stop selling premium, stop buying dips
//
// The second read is the front-vs-back 1d DIVERGENCE. A front-end bid against a flat back end
// is EVENT pricing — the market pricing a dated catalyst (NFP/CPI/an earnings print), not a
// regime change — and the two demand opposite responses. Reference case (Aug 4 2026): VIX9D
// +8.6% while VIX3M +0.8%, curve still in contango → correctly read as event pricing ahead of
// NFP/CPI/AMD, NOT a reason to de-risk the book.
//
// Every threshold lives in VOL_TERM_CFG so the whole card is retuned in one place.

export const VOL_TERM_CFG = Object.freeze({
  flatBandPct:      2.5,  // |VIX9D − VIX3M| / VIX3M within this % → FLAT (transition)
  eventFrontMinPct: 3.0,  // front (VIX9D) 1d change at/above this …
  eventBackMaxPct:  1.5,  // … while the back (VIX3M) 1d change stays under this → EVENT pricing
});

export function volTermStructure({ vix9d, vix, vix3m } = {}, cfg = VOL_TERM_CFG) {
  const f = vix9d?.price ?? null, s = vix?.price ?? null, b = vix3m?.price ?? null;
  if (f == null || b == null) {
    return { available: false, note: 'VIX term structure incomplete — need ^VIX9D (front) and ^VIX3M (back).' };
  }
  const spreadPts = +(f - b).toFixed(2);                              // front minus back, points
  const spreadPct = b !== 0 ? +(((f - b) / b) * 100).toFixed(1) : null;

  let regime, tone, meaning;
  if (spreadPct != null && Math.abs(spreadPct) <= cfg.flatBandPct) {
    regime = 'FLAT'; tone = 'amber';
    meaning = 'curve flat — regime transition; cut size';
  } else if (f < b) {
    regime = 'CONTANGO'; tone = 'green';
    meaning = 'front below back — calm slope; dips buyable, premium sellable';
  } else {
    regime = 'BACKWARDATION'; tone = 'red';
    meaning = 'front above back — stress; stop selling premium, stop buying dips';
  }

  // Event-pricing overlay: front bid while the back is roughly unchanged.
  const fChg = vix9d?.changePct ?? null, bChg = vix3m?.changePct ?? null;
  const eventPricing = fChg != null && bChg != null
    && fChg >= cfg.eventFrontMinPct && Math.abs(bChg) <= cfg.eventBackMaxPct;

  return {
    available: true, regime, tone, meaning, spreadPts, spreadPct,
    vix9d: f, vix: s, vix3m: b, frontChg: fChg, backChg: bChg, eventPricing,
    note: eventPricing
      ? `Front ${fChg >= 0 ? '+' : ''}${fChg}% vs back ${bChg >= 0 ? '+' : ''}${bChg}% 1d — EVENT pricing (a dated catalyst), not a regime change. A front bid with a flat back does not call for de-risking the book.`
      : null,
  };
}
