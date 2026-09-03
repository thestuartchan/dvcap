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
// depending on whether the rest of the complex moved with it: broad dollar weakness, or Korea
// alone — and Korea alone is what official smoothing looks like.
//
// WHY THIS WAS WRONG, AND IT WAS WRONG ON THE SCREEN. The old rule read CLEAN when the won
// strengthened and DXY was weak and the yen was firm. On 2026-09-03 it did exactly that — and the
// panel immediately above it said the yen leg accounted for ~102% of the DXY move under an active
// intervention flag. So Gate 2 cited DXY as evidence of a broad dollar move while the same screen
// declared DXY to be reporting one managed pair, and it cited the yen as a corroborating leg while
// the yen was the flagged one. It used the contaminated evidence twice and called the result clean.
//
// The new rule takes corroboration only from a leg carrying no intervention flag, and requires it
// to have MOVED — at least half the won's own magnitude, in the same dollar direction. Half is the
// point where a leg is participating rather than merely not contradicting: on that day EUR/USD
// +0.09% is USD −0.09% against USD/KRW −1.08%, which needs 0.54% to corroborate and delivers a
// sixth of it. The won moved and essentially nothing clean moved with it, which is SUSPECT.
//
// DXY IS NOT A LEG. It is a blend containing the flagged one, so it is never the evidence when
// anything is flagged. With nothing flagged it may stand in, because then it is what it claims.
export const DXY_FLAT_PCT = 0.15;   // |%| below this is "DXY did not move"
export const JPY_FLAT_PCT = 0.15;
// How much of the won's move a clean leg must match before it counts as corroboration.
export const CORROBORATION_RATIO = 0.5;

// Everything in the DOLLAR'S frame, so the legs are comparable. EUR/USD is quoted as dollars per
// euro and rises when the dollar weakens, so it inverts; USD/JPY and USD/KRW already read this way.
const usdFrameLegs = ({ eurChangePct, jpyChangePct }) => [
  eurChangePct == null ? null : { vs: 'EUR', pct: +(-eurChangePct).toFixed(2), quoted: eurChangePct, inverted: true },
  jpyChangePct == null ? null : { vs: 'JPY', pct: +(+jpyChangePct).toFixed(2), quoted: jpyChangePct, inverted: false },
].filter(Boolean);

export function wonRead({ krwChangePct, dxyChangePct, jpyChangePct, eurChangePct, contamination = null } = {}) {
  if (krwChangePct == null) return { available: false, gate2: 'unknown', note: 'USD/KRW — no print' };

  // USD/KRW falling = won STRENGTHENING (fewer won per dollar).
  const wonStronger = krwChangePct < 0;
  const all = usdFrameLegs({ eurChangePct, jpyChangePct });
  const flaggedMap = contamination?.flagged || {};
  const clean = all.filter(l => !flaggedMap[l.vs]);
  const flagged = all.filter(l => flaggedMap[l.vs]);
  const anyFlag = flagged.length > 0 || !!contamination?.any;

  const need = +(Math.abs(krwChangePct) * CORROBORATION_RATIO).toFixed(2);
  const corroborating = clean.filter(l => Math.sign(l.pct) === Math.sign(krwChangePct) && Math.abs(l.pct) >= need);

  const legs = `KRW ${krwChangePct >= 0 ? '+' : ''}${krwChangePct}%`
    + all.map(l => `, USD ${l.pct >= 0 ? '+' : ''}${l.pct}% vs ${l.vs}${flaggedMap[l.vs] ? ' ⚑' : ''}`).join('')
    + (dxyChangePct != null ? `, DXY ${dxyChangePct >= 0 ? '+' : ''}${dxyChangePct}%${anyFlag ? ' (not evidence today)' : ''}` : '');
  const flagNote = anyFlag
    ? ` ${flagged.map(l => l.vs).join(' and ') || 'A leg'} carries an intervention flag, so neither it nor DXY is evidence here.`
    : '';

  if (!all.length && dxyChangePct == null) {
    return { available: false, wonStronger, gate2: 'unknown', legs,
      note: `${legs} — no corroborating leg at all, so the won move cannot be attributed. Gate 2 unresolved.` };
  }

  if (wonStronger) {
    if (corroborating.length) {
      const c = corroborating.map(l => `USD ${l.pct}% vs ${l.vs}`).join(', ');
      return {
        available: true, wonStronger, driver: 'MACRO', gate2: 'clean', legs,
        corroboratedBy: corroborating.map(l => l.vs), needed: need, flaggedLegs: flagged.map(l => l.vs),
        note: `${legs} — the won strengthened and ${c} moved with it, at least half its magnitude (${need}% needed). A clean leg confirms a broad dollar move: Gate 2 reads CLEAN.${flagNote}`,
      };
    }
    // Nothing clean moved enough. Whether that is Korea acting alone or simply an unusable board
    // depends on whether there WAS a clean leg to look at.
    if (!clean.length) {
      return {
        available: false, wonStronger, driver: 'UNCORROBORATED', gate2: 'unknown', legs,
        needed: need, flaggedLegs: flagged.map(l => l.vs),
        note: `${legs} — every corroborating leg is flagged, so there is nothing clean to test the won against. Gate 2 unresolved rather than clean.${flagNote}`,
      };
    }
    return {
      available: true, wonStronger, driver: 'KOREA_SPECIFIC', gate2: 'suspect', legs,
      needed: need, cleanLegs: clean.map(l => l.vs), flaggedLegs: flagged.map(l => l.vs),
      note: `${legs} — the won strengthened but no unflagged leg moved even half as far (${need}% needed). A Korea-specific bid is what official smoothing looks like: Gate 2 reads SUSPECT and is not a clean risk-on signal.${flagNote}`,
    };
  }

  return {
    available: true, wonStronger: false,
    driver: (!anyFlag && dxyChangePct != null && dxyChangePct > DXY_FLAT_PCT) ? 'MACRO' : 'MIXED',
    gate2: 'weakening', legs, flaggedLegs: flagged.map(l => l.vs),
    note: `${legs} — won WEAKENING. Gate 2 deteriorating${(!anyFlag && dxyChangePct != null && dxyChangePct > DXY_FLAT_PCT) ? ' alongside broad dollar strength, so this is a macro move' : ' without a clean broad-dollar move behind it'}.${flagNote}`,
  };
}
