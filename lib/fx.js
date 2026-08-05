// fx.js — FX reads that require judgement about WHY a currency moved, not just how far.
//
// Both rules here exist because a price alone is not evidence of the thing it usually implies.
// A falling DXY normally means the market is selling dollars; during coordinated intervention
// part of that move is an official transaction. A strengthening won normally reads as risk-on;
// it can also be the Bank of Korea. Neither can be settled from the level, so both rules work
// on CORROBORATION — does the rest of the complex agree?

// ── F3 — intervention artefact flag ──────────────────────────────────────────
// Deliberately MANUAL. There is no keyless feed that reports intervention in real time; MOF
// confirmations arrive after the fact. A flag the operator sets is honest about that, where
// an inferred one would manufacture certainty from a wide daily move — which is exactly the
// mistake the annotation exists to prevent.
//
// The yen leg carries 13.6% of DXY, so yen-side intervention moves the index by roughly that
// share of the JPY move. That is arithmetic, not a claim about how much of today's move was
// official — the annotation gives the operator the weight and lets them apply judgement.
export const DXY_JPY_WEIGHT = 0.136;
export const DXY_EUR_WEIGHT = 0.576;

export function interventionAnnotation({ active, since, note, jpyChangePct, dxyChangePct } = {}) {
  if (!active) return { active: false, annotation: null };

  // Attributable share: the portion of the DXY move arithmetically explained by the yen leg.
  let attribution = null;
  if (jpyChangePct != null && dxyChangePct != null && Math.abs(dxyChangePct) > 0.01) {
    const jpyContribution = jpyChangePct * DXY_JPY_WEIGHT;
    const share = Math.round((jpyContribution / dxyChangePct) * 100);
    // Only meaningful when the yen leg pushes the index the SAME way. A negative share means
    // the yen was working against the move, so "part of the decline is the yen" is false.
    attribution = {
      jpyContribution: +jpyContribution.toFixed(3), sharePct: share,
      sameDirection: share > 0,
      note: share > 0
        ? `the yen leg accounts for ~${Math.abs(share)}% of today's DXY move (JPY ${jpyChangePct >= 0 ? '+' : ''}${jpyChangePct}% × ${DXY_JPY_WEIGHT} weight)`
        : `the yen leg moved AGAINST the index today — it is not what is driving DXY`,
    };
  }

  return {
    active: true, since: since ?? null, attribution,
    annotation: `⚑ INTERVENTION ACTIVE${since ? ` (since ${since})` : ''} — part of any DXY move is official selling, not market pricing.`
      + (attribution ? ` Arithmetically, ${attribution.note}.` : '')
      + ' Treat the dollar leg as contaminated while this flag is set.'
      + (note ? ` Operator note: ${note}` : ''),
  };
}

// ── F4 — USD/KRW disambiguation ──────────────────────────────────────────────
// Gate 2 in the two-gate framework is USD/KRW. A strengthening won means opposite things
// depending on whether the rest of Asian FX moved with it:
//
//   won stronger + DXY weak + yen strong  → MACRO (broad dollar move)  → Gate 2 CLEAN
//   won stronger, DXY flat, yen unmoved   → KOREA-SPECIFIC             → Gate 2 SUSPECT
//
// The second case is the one that looks like a risk-on signal and is not. Isolating it is
// the difference between reading a genuine capital-flow improvement and reading the BOK.
export const DXY_FLAT_PCT = 0.15;   // |%| below this is "DXY did not move"
export const JPY_FLAT_PCT = 0.15;

export function wonRead({ krwChangePct, dxyChangePct, jpyChangePct } = {}) {
  if (krwChangePct == null) return { available: false, gate2: 'unknown', note: 'USD/KRW — no print' };

  // USD/KRW falling = won STRENGTHENING (fewer won per dollar).
  const wonStronger = krwChangePct < 0;
  const dxyWeak = dxyChangePct != null && dxyChangePct < -DXY_FLAT_PCT;
  const dxyFlat = dxyChangePct != null && Math.abs(dxyChangePct) <= DXY_FLAT_PCT;
  // USD/JPY falling = yen STRENGTHENING.
  const jpyStronger = jpyChangePct != null && jpyChangePct < -JPY_FLAT_PCT;
  const jpyFlat = jpyChangePct != null && Math.abs(jpyChangePct) <= JPY_FLAT_PCT;

  const legs = `KRW ${krwChangePct >= 0 ? '+' : ''}${krwChangePct}%`
    + (dxyChangePct != null ? `, DXY ${dxyChangePct >= 0 ? '+' : ''}${dxyChangePct}%` : '')
    + (jpyChangePct != null ? `, JPY ${jpyChangePct >= 0 ? '+' : ''}${jpyChangePct}%` : '');

  if (dxyChangePct == null || jpyChangePct == null) {
    return {
      available: false, wonStronger, gate2: 'unknown',
      note: `${legs} — corroborating legs missing, so the won move cannot be attributed. Gate 2 unresolved.`,
    };
  }

  if (wonStronger && dxyWeak && jpyStronger) {
    return {
      available: true, wonStronger, driver: 'MACRO', gate2: 'clean', legs,
      note: `${legs} — won strengthening WITH broad dollar weakness and a firmer yen. This is a macro dollar move, not a Korea-specific one: Gate 2 reads CLEAN.`,
    };
  }
  if (wonStronger && (dxyFlat || !dxyWeak) && (jpyFlat || !jpyStronger)) {
    return {
      available: true, wonStronger, driver: 'KOREA_SPECIFIC', gate2: 'suspect', legs,
      note: `${legs} — won strengthening ALONE against an unmoved dollar and yen. A Korea-specific bid is what official smoothing looks like: Gate 2 reads SUSPECT and should not be taken as a clean risk-on signal.`,
    };
  }
  if (wonStronger) {
    return {
      available: true, wonStronger, driver: 'MIXED', gate2: 'mixed', legs,
      note: `${legs} — won stronger but the corroborating legs only partly agree. Neither a clean macro read nor clearly Korea-specific.`,
    };
  }
  return {
    available: true, wonStronger: false, driver: dxyChangePct > DXY_FLAT_PCT ? 'MACRO' : 'MIXED',
    gate2: 'weakening', legs,
    note: `${legs} — won WEAKENING. Gate 2 deteriorating${dxyChangePct > DXY_FLAT_PCT ? ' alongside broad dollar strength, so this is a macro move' : ' without a broad dollar move behind it'}.`,
  };
}
