// status.js — the FOUR status states, and the action-card derivation.
//
// Section I.1: there are four states and no others. Ad-hoc vocabulary ("Softening. Monitor
// closely.", "Danger window", "Benign — no stress") may survive as descriptive subtitles, but
// the STATE itself is always one of these four. One definition, imported everywhere; no card
// hardcodes a hex.
export const STATUS = Object.freeze({
  BENIGN:   { token: 'BENIGN',   color: '#166534', bg: '#F0FDF4', bdr: '#86EFAC', rank: 0, meaning: 'No stress. Metric within normal range' },
  WATCH:    { token: 'WATCH',    color: '#92400E', bg: '#FFFBEB', bdr: '#FCD34D', rank: 1, meaning: 'Softening or approaching a threshold. Not actionable alone' },
  ELEVATED: { token: 'ELEVATED', color: '#C2410C', bg: '#FFF7ED', bdr: '#FDBA74', rank: 2, meaning: 'Meaningful deterioration. Actionable in combination' },
  DANGER:   { token: 'DANGER',   color: '#991B1B', bg: '#FEF2F2', bdr: '#FCA5A5', rank: 3, meaning: 'Threshold breached' },
});
export const STATUS_TOKENS = Object.keys(STATUS);
// I.5 — the allow-list a lint check can assert against.
export const STATUS_HEXES = Object.values(STATUS).flatMap(s => [s.color, s.bg, s.bdr]);
export const moreSevere = (a, b) => (STATUS[a]?.rank ?? -1) >= (STATUS[b]?.rank ?? -1) ? a : b;

// ── Master gauge: HY OAS → status ────────────────────────────────────────────
// Bands follow the P2 amendment (2.90 is NOT a gate). 4.5 is the alert threshold.
export function creditStatus(oas) {
  if (oas == null) return null;
  if (oas < 3.0) return 'BENIGN';
  if (oas < 4.5) return 'WATCH';
  if (oas < 8.0) return 'ELEVATED';
  return 'DANGER';
}

// ── L.3 — stage definitions, stated so "Stage 3" is never unexplained ────────
export const STAGES = Object.freeze({
  1: { label: 'Stage 1 — Surveillance', desc: 'Watching. No insurance purchases yet.' },
  2: { label: 'Stage 2 — Accumulate insurance', desc: 'Insurance is cheap; build the position before spreads move. Not yet defensive.' },
  3: { label: 'Stage 3 — Full insurance active', desc: 'Insurance is already on and being harvested. Requires confirmed credit stress.' },
  4: { label: 'Stage 4 — Deploy', desc: 'Pivot confirmed; rotate and deploy capital.' },
});

// ── L — action derivation ────────────────────────────────────────────────────
// The contradiction this fixes: the card read "Stage 3 — Full Insurance Active" (i.e. already
// hedged) while the master gauge directly beneath read BENIGN (i.e. nothing has happened yet).
// Both cannot be true. A high stagflation probability justifies BUYING insurance; it does not
// justify HAVING ALREADY BOUGHT it. Those are different stages and the card conflated them.
//
// L.2 — credit has veto power. HY OAS is the master gauge in the two-gate framework, so a
// full-defensive call cannot be issued while credit reads BENIGN, regardless of regime.
export function deriveAction({ oas, regimeLabel, regimePct, regimeContested, labourVerdict, labourSevere, ratesNote, vintages = {} }) {
  const credit = creditStatus(oas);
  const inputs = [];

  // Raw stage, before the veto — severity as the individual gauges see it IN ISOLATION.
  // This deliberately reproduces what each gauge would argue for on its own, so the veto has
  // something real to cap and can explain itself. Reporting a capped stage with no note is
  // the same opacity L.1 exists to remove.
  let rawStage = 1;
  if (credit === 'DANGER' || credit === 'ELEVATED') rawStage = 3;
  else if (credit === 'WATCH') rawStage = 2;
  // Labour SEVERITY (both employment surveys falling) is what drove the original Stage 3
  // reading. It still argues for it in isolation — and the veto is what stops it standing.
  if (labourSevere) rawStage = Math.max(rawStage, 3);
  else if (labourVerdict === 'AMBER' || labourVerdict === 'RED') rawStage = Math.max(rawStage, 2);
  // Regime conviction argues for accumulation only, never for being already hedged.
  if (!regimeContested && regimePct != null && regimePct >= 50) rawStage = Math.max(rawStage, 2);

  // ── The veto ──
  const vetoed = credit === 'BENIGN' && rawStage > 2;
  const stage = vetoed ? 2 : rawStage;

  if (credit) inputs.push({ name: 'credit', value: `OAS ${oas}, ${credit.toLowerCase()}`, status: credit, vintage: vintages.credit ?? null });
  if (regimeLabel) inputs.push({ name: 'regime', value: `${regimeLabel}${regimePct != null ? ` ${regimePct}%` : ''}${regimeContested ? ' (contested)' : ''}`, status: null, vintage: vintages.regime ?? null });
  // CONTEXT, not a driver. The curve is listed because it is worth seeing next to the call,
  // but nothing above reads it — it cannot move the stage in either direction. Flagged so the
  // 'Derived from' line does not imply a weight it does not have.
  if (ratesNote) inputs.push({ name: 'rates', value: ratesNote, status: null, weight: 'context', vintage: vintages.rates ?? null });
  if (labourVerdict) inputs.push({ name: 'labour', value: labourVerdict.toLowerCase(), status: labourVerdict === 'AMBER' ? 'WATCH' : labourVerdict === 'RED' ? 'ELEVATED' : 'BENIGN', vintage: vintages.labour ?? null });

  // Card status mirrors the effective stage, so the badge cannot outrun the recommendation.
  const status = stage >= 3 ? 'ELEVATED' : stage === 2 ? 'WATCH' : 'BENIGN';

  return {
    stage, rawStage, vetoed, credit, status,
    label: STAGES[stage].label,
    desc: STAGES[stage].desc,
    inputs,
    vetoNote: vetoed
      ? `Capped at Stage 2 — HY OAS ${oas} reads BENIGN. A full-defensive call requires confirmed credit stress; regime conviction justifies buying insurance, not having already bought it.`
      : null,
  };
}

// ── M.4 — header signal ──────────────────────────────────────────────────────
// Stated as a function of named inputs rather than a separate judgement. A header reading
// DANGER above a master gauge reading BENIGN is section H in miniature, so the same veto
// applies before the comparison.
export function headerSignal({ oas, regimeStatus }) {
  const credit = creditStatus(oas);
  if (!credit && !regimeStatus) return { signal: null, note: 'no inputs' };
  // Credit's veto first: benign credit caps the header too.
  if (credit === 'BENIGN') {
    const capped = moreSevere('WATCH', regimeStatus === 'DANGER' ? 'WATCH' : (regimeStatus || 'BENIGN'));
    return {
      signal: capped, credit, regimeStatus,
      note: `credit BENIGN (OAS ${oas}) caps the header; more severe of (regime, credit) after the cap`,
    };
  }
  const signal = moreSevere(credit || 'BENIGN', regimeStatus || 'BENIGN');
  return { signal, credit, regimeStatus, note: 'more severe of (regime, credit)' };
}
