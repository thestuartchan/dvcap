// regimeProb.js — recession-consensus -> regime probability mapping, and the contested guard.
// Extracted from App.jsx so the mapping can be TESTED. The defect it fixes was invisible
// precisely because the logic sat inline in a 4000-line component with no way to drive it.

// ── Section A — WHY did recession probability fall? ──────────────────────────
// The band table below maps a LOWER recession probability to a HIGHER reflationary-growth
// probability, mechanically. Measured: moving the weighted average 33% → 25% shifts
// reflationary +13pp and stagflation −8pp. That is backwards for the move that actually
// happened — forecasters cut recession odds BECAUSE inflation was stickier, i.e. they moved
// probability from recession into STAGFLATION, not into growth. The engine had no way to tell
// the two reasons apart, and that is what produced the 38/37 tie.
//
// The fix is to make the reflationary share EARNED rather than granted. Growth probability is
// only credible if growth is actually accelerating, or inflation is genuinely returning to
// target. Both are live inputs (GDP % SAAR + prior quarter; core inflation + trend), so this
// is derived, not asserted.
export const REFLATIONARY_FLOOR = 20;      // the share that survives even when unearned
export const CORE_NEAR_TARGET = 2.5;       // core inflation at/below this counts as returning to target
export function reflationaryEarned(ctx = {}) {
  const { gdpGrowth, gdpGrowthPrev, coreInflation, coreCooling } = ctx;
  const accelerating = (gdpGrowth != null && gdpGrowthPrev != null) ? gdpGrowth > gdpGrowthPrev : null;
  const nearTarget = coreInflation != null ? coreInflation <= CORE_NEAR_TARGET : null;
  // Unknown inputs must not silently earn the boost — absence of evidence is not acceleration.
  if (accelerating == null && nearTarget == null) {
    return { earned: true, reason: 'growth/inflation context unavailable — band applied unadjusted', known: false };
  }
  if (accelerating) return { earned: true, known: true, reason: `growth accelerating (${gdpGrowth}% vs ${gdpGrowthPrev}% prior) — a growth read is earned` };
  if (nearTarget && coreCooling) return { earned: true, known: true, reason: `core inflation ${coreInflation}% at target and cooling — disinflation earns the growth read` };
  return {
    earned: false, known: true,
    reason: `recession odds fell WITHOUT growth accelerating (${gdpGrowth ?? '—'}% vs ${gdpGrowthPrev ?? '—'}% prior)`
      + `${coreInflation != null ? ` and with core inflation still ${coreInflation}% (>${CORE_NEAR_TARGET}%)` : ''}`
      + ' — that probability belongs in stagflation, not growth',
  };
}

export const deriveRegimeProbabilities = (weightedAvg, cpi, kalshi2027, ctx = {}) => {
  if (weightedAvg === null) return null;

  let base;
  if (weightedAvg < 15)      base = { reflationary: 60, stagflation: 25, deflationary: 10, inflationary: 5 };
  else if (weightedAvg < 30) base = { reflationary: 40, stagflation: 35, deflationary: 20, inflationary: 5 };
  else if (weightedAvg < 45) base = { reflationary: 25, stagflation: 45, deflationary: 25, inflationary: 5 };
  else                       base = { reflationary: 15, stagflation: 40, deflationary: 35, inflationary: 10 };

  // CPI modifier — shift points from deflationary to stagflation when CPI > 3.5%
  if (cpi && cpi > 3.5) {
    const inflationShift = Math.min(10, Math.round((cpi - 3.5) * 4));
    base.deflationary = Math.max(5, base.deflationary - inflationShift);
    base.stagflation = base.stagflation + inflationShift;
  }

  // 2027 delayed-reckoning modifier — threshold raised to <30 (from <25) so it
  // engages while the realized weighted average sits in the mid-20s.
  if (kalshi2027 && kalshi2027 > 35 && weightedAvg < 30) {
    const delayedShift = Math.min(8, Math.round((kalshi2027 - 35) / 3));
    base.reflationary = Math.max(10, base.reflationary - delayedShift);
    base.stagflation = base.stagflation + delayedShift;
  }

  // ── The mapping fix: redirect the UNEARNED growth share into stagflation ──
  // Only fires when the context is KNOWN and says the growth read is not earned. Without
  // this, "recession less likely because inflation is stickier" reads as "growth is stronger".
  const earn = reflationaryEarned(ctx);
  let redirected = 0;
  if (earn.known && !earn.earned) {
    redirected = Math.max(0, base.reflationary - REFLATIONARY_FLOOR);
    base.reflationary -= redirected;
    base.stagflation += redirected;
  }

  // Normalize to exactly 100%
  const total = base.reflationary + base.stagflation + base.deflationary + base.inflationary;
  const scale = 100 / total;
  const out = {
    reflationary: Math.round(base.reflationary * scale),
    stagflation: Math.round(base.stagflation * scale),
    deflationary: Math.round(base.deflationary * scale),
    inflationary: Math.round(base.inflationary * scale),
    weightedAvg: Math.round(weightedAvg),
    kalshi2027,
    mapping: { earned: earn.earned, known: earn.known, redirected, reason: earn.reason },
    derivedFrom: `Weighted recession prob: ${Math.round(weightedAvg)}% | CPI: ${cpi?.toFixed(1) ?? "N/A"}% | Kalshi 2027: ${kalshi2027 ?? "N/A"}%`,
  };

  // ── Section A — contested guard ──
  // A 1pp separation between the top two states is a tie, and a tie cannot support a
  // capital-deployment instruction. Computed here so every consumer sees the same verdict.
  const ranked = [
    ["stag", out.stagflation], ["ref", out.reflationary],
    ["def", out.deflationary], ["inf", out.inflationary],
  ].sort((a, b) => b[1] - a[1]);
  out.topTwoGap = ranked[0][1] - ranked[1][1];
  out.contested = out.topTwoGap < CONTESTED_GAP;
  out.topTwo = [ranked[0][0], ranked[1][0]];
  return out;
};
// Below this separation the top two are a tie, not a winner.
export const CONTESTED_GAP = 8;
