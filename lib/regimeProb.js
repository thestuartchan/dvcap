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
// Consensus/FRED inputs arrive at full float precision and this prose quotes them, so round at
// the boundary. "core inflation still 3.28653%" reads like a bug even when the number is right.
const pct = v => (v == null ? null : Number(v).toFixed(1));

export function reflationaryEarned(ctx = {}) {
  const { gdpGrowth, gdpGrowthPrev, coreInflation, coreCooling } = ctx;
  const accelerating = (gdpGrowth != null && gdpGrowthPrev != null) ? gdpGrowth > gdpGrowthPrev : null;
  const nearTarget = coreInflation != null ? coreInflation <= CORE_NEAR_TARGET : null;
  // Unknown inputs must not silently earn the boost — absence of evidence is not acceleration.
  if (accelerating == null && nearTarget == null) {
    return { earned: true, reason: 'growth/inflation context unavailable — band applied unadjusted', known: false };
  }
  if (accelerating) return { earned: true, known: true, reason: `growth accelerating (${pct(gdpGrowth)}% vs ${pct(gdpGrowthPrev)}% prior) — a growth read is earned` };
  if (nearTarget && coreCooling) return { earned: true, known: true, reason: `core inflation ${pct(coreInflation)}% at target and cooling — disinflation earns the growth read` };
  return {
    earned: false, known: true,
    reason: `recession odds fell WITHOUT growth accelerating (${pct(gdpGrowth) ?? '—'}% vs ${pct(gdpGrowthPrev) ?? '—'}% prior)`
      + `${coreInflation != null ? ` and with core inflation still ${pct(coreInflation)}% (>${CORE_NEAR_TARGET}%)` : ''}`
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

  // ── R8.1 (Amendment 3) — labour deterioration → deflationary recession ──
  // The recession-consensus input is analyst forecasts, which are slow-moving and update
  // monthly-to-quarterly; live labour weakness (an outright negative payroll print, the
  // household control also falling, the 12-month trend at stall speed) is demand-destruction
  // evidence the classifier must move on TODAY rather than wait for consensus to catch up.
  // Points are pulled from reflationary first (a hiring contraction is the opposite of the
  // growth read), then stagflation, into deflationary — each down to a floor so no single
  // modifier can zero a state.
  const lab = ctx.labor || {};
  const empPopDown = lab.empPopDelta != null && lab.empPopDelta < -0.049;
  const laborReasons = [];
  let laborWanted = 0;
  if (lab.payrollsK != null && lab.payrollsK < 0) { laborWanted += 8; laborReasons.push(`payrolls ${Math.round(lab.payrollsK)}k`); }
  if (empPopDown) { laborWanted += 4; laborReasons.push(`emp-pop ${lab.empPopDelta.toFixed(1)}pp`); }
  if (lab.twelveMoAvgK != null && lab.twelveMoAvgK < 75) { laborWanted += 3; laborReasons.push(`12-mo avg ${Math.round(lab.twelveMoAvgK)}k (stall)`); }
  laborWanted = Math.min(15, laborWanted);
  let laborShift = 0;
  if (laborWanted > 0) {
    const fromRef = Math.max(0, Math.min(laborWanted, base.reflationary - 5));
    const fromStag = Math.max(0, Math.min(laborWanted - fromRef, base.stagflation - 10));
    laborShift = fromRef + fromStag;
    base.reflationary -= fromRef;
    base.stagflation -= fromStag;
    base.deflationary += laborShift;
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
    labor: { shift: laborShift, reasons: laborReasons },
    derivedFrom: `Weighted recession prob: ${Math.round(weightedAvg)}% | CPI: ${cpi?.toFixed(1) ?? "N/A"}% | Kalshi 2027: ${kalshi2027 ?? "N/A"}%${laborShift ? ` | labour −${laborShift}pp→deflationary` : ""}`,
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
