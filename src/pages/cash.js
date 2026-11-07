// src/pages/cash.js — what cash earns right now, and the prose that quotes it. Used by Plan, Income
// and the Drivers cash card, so one rate move updates every mention.
// ─── LIVE CASH YIELD ──────────────────────────────────────────────────────────
// Single source of truth for "what does cash earn right now". Short-Treasury vehicles
// (USFR / SGOV / BIL) and the CPI chart's reference line all resolve through this, so a
// rate move updates every mention at once instead of leaving hardcoded figures behind —
// the previous hardcoded set had drifted ~1.7pp and disagreed with each other (5.3% in two
// posture notes, 4.4% in the ETF list, while Fed funds was 3.63%).
// USFR holds floating-rate Treasuries that reset off T-bill auctions, so the 6M bill is the
// closest keyless proxy; Fed funds is the fallback. Returns null when neither is available —
// callers must then omit the figure rather than print a stale one.
export function liveCashYield(liveInd) {
  if (liveInd?.tbill6m != null) return { value: liveInd.tbill6m, src: "6M T-bill", asOf: liveInd?.asOf?.tbill6m ?? null };
  if (liveInd?.currentFedFunds != null) return { value: liveInd.currentFedFunds, src: "Fed funds", asOf: liveInd?.asOf?.currentFedFunds ?? null };
  return null;
}

// Substitute {{CASH}} in authored prose with the live rate. With no live rate the sentence
// degrades to a rate-free phrasing instead of emitting a stale number.
export function fillLiveRates(text, cy) {
  if (typeof text !== "string") return text;
  return text.replace(/\{\{CASH\}\}/g, cy ? `~${cy.value.toFixed(2)}% (live, ${cy.src})` : "the prevailing T-bill rate");
}
