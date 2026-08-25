// lib/sizing.js — how much to buy, for spot / swing / long holds.
//
// This replaces the earlier sizing model, which assumed every trade has a stop and that the
// position is being opened from flat. Neither holds here:
//
//   • A LONG HOLD OFTEN HAS NO STOP. Risk-based sizing (risk R% of the book, let the stop distance
//     set the quantity) is undefined without one, and inventing a stop to make the formula work
//     would be a fabricated input. So there are two modes and the module says which one applies:
//     RISK for a swing with a defined invalidation, ALLOCATION (a target % of the book) for an
//     accumulation where the thesis, not a price, is the exit condition.
//   • POSITIONS ARE SCALED INTO. Sizing that ignores what is already held tells you to buy a full
//     position you are already half in. Every suggestion is therefore net of the current holding
//     and reports the ROOM REMAINING, optionally split into tranches.
//
// The regime multiplier is retained from the previous model because it is the part that made this
// dvcap's sizing rather than a generic calculator: size smaller when the macro read is hostile or
// unresolved. It is a SUGGESTION shown beside the user's own number, never an instruction.

export const SIZING_MODES = ['risk', 'allocation'];

export const REGIME_SIZING = {
  ref:  { mult: 1.0, label: 'Reflationary Growth',    note: 'benign trend — full size' },
  inf:  { mult: 0.8, label: 'Inflationary Boom',      note: 'trend intact, vol higher' },
  stag: { mult: 0.6, label: 'Stagflation',            note: 'chop / whipsaw risk' },
  def:  { mult: 0.4, label: 'Deflationary Recession', note: 'capital preservation' },
};
export const CREDIT_DANGER_CAP   = 0.4;   // credit stress caps the multiplier whatever the regime
export const UNCERTAINTY_HAIRCUT = 0.7;   // regime contested, or pinned ≠ live → extra × on top
export const DEFAULT_BASE_RISK_PCT = 1.0;
export const DEFAULT_TARGET_PCT    = 5.0;

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? NaN : +v;

// ── Why sizes are ROUNDED ────────────────────────────────────────────────────
// Account equity moves minute to minute and is entered by hand, so it is an APPROXIMATION by
// construction. Sizing is linear in it — a 5% change in equity moves the suggestion by 5% — so a
// figure like "137 shares" claims a precision the input cannot support and invites the user to
// chase an exact equity number that does not matter. Suggestions are therefore rounded to a
// sensible increment for their magnitude, which also makes them easier to act on.
export function roundQty(q) {
  if (!Number.isFinite(q) || q <= 0) return 0;
  if (q < 20) return Math.floor(q);              // small positions genuinely need each share
  if (q < 100) return Math.floor(q / 5) * 5;
  if (q < 1000) return Math.floor(q / 10) * 10;
  if (q < 10000) return Math.floor(q / 25) * 25;
  return Math.floor(q / 100) * 100;
}

// How stale a hand-entered equity figure is, and whether that has begun to matter. The threshold is
// generous on purpose: because sizing is linear in equity, a week of drift moves a suggestion by
// roughly the same percentage the book moved, which is almost always immaterial to the decision.
export const EQUITY_STALE_DAYS = 14;
export function equityFreshness(asOf, nowIso) {
  if (!asOf) return { days: null, stale: false, note: 'no date recorded — set your equity to stamp one' };
  const a = Date.parse(asOf), n = Date.parse(nowIso || new Date().toISOString().slice(0, 10));
  if (!Number.isFinite(a) || !Number.isFinite(n)) return { days: null, stale: false, note: null };
  const days = Math.max(0, Math.round((n - a) / 86400000));
  return {
    days,
    stale: days > EQUITY_STALE_DAYS,
    note: days > EQUITY_STALE_DAYS
      ? `equity is ${days} days old — sizes scale with it, so refresh if the book has moved much`
      : null,
  };
}

// Regime multiplier plus a readable account of how it was reached.
export function regimeMultiplier({ regimeId, creditDanger = false, contested = false, pinnedDiverged = false, sizing = REGIME_SIZING } = {}) {
  const base = sizing[regimeId] ?? { mult: 0.6, label: regimeId || 'unknown', note: 'unmapped regime — conservative default' };
  let mult = base.mult;
  const reasons = [`${base.label}: ×${base.mult.toFixed(2)} (${base.note})`];
  if (creditDanger && mult > CREDIT_DANGER_CAP) {
    mult = CREDIT_DANGER_CAP;
    reasons.push(`credit stress caps size at ×${CREDIT_DANGER_CAP.toFixed(2)}`);
  }
  if (contested || pinnedDiverged) {
    mult *= UNCERTAINTY_HAIRCUT;
    reasons.push(`${contested ? 'regime contested' : 'pinned ≠ live regime'} → ×${UNCERTAINTY_HAIRCUT} uncertainty haircut`);
  }
  return { mult: +mult.toFixed(3), base: base.mult, reasons };
}

// The suggestion. `equityInPos` is the account equity already converted into the POSITION's
// currency — the caller owns FX, because it has the rate table and knows when a rate is missing.
export function sizeSuggestion({
  mode = 'risk', equityInPos, price, stop,
  baseRiskPct = DEFAULT_BASE_RISK_PCT, targetPct = DEFAULT_TARGET_PCT,
  regime = {}, heldQty = 0, tranches = 1, sizing = REGIME_SIZING,
} = {}) {
  const eq = num(equityInPos), p = num(price), s = num(stop);
  const held = Math.max(0, num(heldQty) || 0);
  const nTranche = Math.max(1, Math.round(num(tranches) || 1));
  const rm = regimeMultiplier({ ...regime, sizing });

  if (!Number.isFinite(eq) || eq <= 0) {
    return { ok: false, mode, mult: rm.mult, reasons: rm.reasons, why: 'set your account equity to get a size' };
  }
  if (!Number.isFinite(p) || p <= 0) {
    return { ok: false, mode, mult: rm.mult, reasons: rm.reasons, why: 'no live price yet — refresh prices' };
  }

  let fullQty, riskAmount = null, effPct;

  if (mode === 'risk') {
    // Risk mode is UNDEFINED without a stop. Say so and point at the alternative rather than
    // silently substituting a guessed invalidation level.
    if (!Number.isFinite(s) || s <= 0) {
      return { ok: false, mode, mult: rm.mult, reasons: rm.reasons,
        why: 'risk sizing needs a stop level — add one, or switch this position to allocation sizing' };
    }
    const perShare = Math.abs(p - s);
    if (perShare <= 0) {
      return { ok: false, mode, mult: rm.mult, reasons: rm.reasons, why: 'the stop equals the price — no risk per share to size against' };
    }
    effPct = +(baseRiskPct * rm.mult).toFixed(4);
    riskAmount = eq * (effPct / 100);
    fullQty = Math.floor(riskAmount / perShare);
  } else {
    effPct = +(targetPct * rm.mult).toFixed(4);
    fullQty = Math.floor((eq * (effPct / 100)) / p);
  }

  const fullExact = fullQty;
  fullQty = roundQty(fullQty);
  const roomQty = Math.max(0, fullQty - held);
  const trancheQty = Math.floor(roomQty / nTranche);
  const notional = +(fullQty * p).toFixed(2);
  const heldNotional = +(held * p).toFixed(2);

  const warnings = [];
  if (held > 0 && roomQty === 0) warnings.push(`already at or above full size (${held} held vs ${fullQty} suggested) — no room to add`);
  if (fullQty === 0) warnings.push('the suggested size rounds to zero — the risk budget is small relative to this price');
  if (nTranche > 1 && trancheQty === 0 && roomQty > 0) warnings.push(`${roomQty} share${roomQty === 1 ? '' : 's'} of room does not divide into ${nTranche} tranches`);

  return {
    ok: true, mode, mult: rm.mult, reasons: rm.reasons,
    effPct,                                   // risk % (risk mode) or target allocation % (allocation)
    fullQty, fullExact: Math.floor(fullExact), rounded: Math.floor(fullExact) !== fullQty,
    // Sizing is linear in equity, so this states plainly how much a wrong equity figure would
    // matter — which is the question a changing account balance actually raises.
    perTenPctEquity: Math.round(fullQty * 0.1),
    heldQty: held, roomQty, tranches: nTranche, trancheQty,
    riskAmount: riskAmount == null ? null : +riskAmount.toFixed(2),
    perShareRisk: mode === 'risk' ? +Math.abs(p - s).toFixed(4) : null,
    notional, heldNotional,
    notionalPctOfBook: +((notional / eq) * 100).toFixed(1),
    heldPctOfBook: +((heldNotional / eq) * 100).toFixed(1),
    warnings,
  };
}

// What the suggestion actually costs you if the stop is hit — stated in the position's currency so
// it can be read next to the quantity without a mental conversion.
export function riskAtStop({ qty, price, stop }) {
  const q = num(qty), p = num(price), s = num(stop);
  if (![q, p, s].every(Number.isFinite) || q <= 0) return null;
  return +(Math.abs(p - s) * q).toFixed(2);
}
