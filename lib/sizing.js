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
//
// A CONTRACT IS NOT A SHARE. The buckets above exist because one share more or less is noise
// against an approximate equity figure. One futures contract is not noise: a single MGC is ten
// ounces of gold and a single MNQ is two index points, so rounding a suggestion of 3 down to 0 —
// which the sub-20 bucket does not, but the sub-100 bucket would at 43 → 40 on a 40-contract
// position — throws away a whole unit of exposure. Anything with a multiplier rounds to whole
// units and nothing else.
export function roundQty(q, multiplier = 1) {
  if (!Number.isFinite(q) || q <= 0) return 0;
  if (Number.isFinite(+multiplier) && +multiplier > 1) return Math.floor(q);
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
// ── THE CONTRACT MULTIPLIER ───────────────────────────────────────────────────
// Every figure below was computed as though one unit were one share. For a share that is true and
// for everything else it is wrong by the multiplier — and wrong in the direction that sizes the
// position TOO LARGE, because the divisor is too small. One MGC contract is ten ounces of gold: a
// stop 40 points away risks $400, not $40, so a $2,000 budget buys five contracts and not fifty.
//
// The multiplier belongs in three places and no others:
//   • RISK MODE, the divisor — risk per unit is the point distance TIMES the multiplier.
//   • ALLOCATION MODE, the divisor — one unit costs price TIMES the multiplier.
//   • NOTIONAL — what the position controls.
// It does NOT belong in the quoted price, the stop, or the point distance, all of which stay in
// the units the instrument is quoted in. Two names are returned rather than one overloaded field,
// because "risk per unit" in money and "distance to the stop" in points are different quantities
// that were previously the same number and are not.
export function sizeSuggestion({
  mode = 'risk', equityInPos, price, stop, multiplier = 1,
  baseRiskPct = DEFAULT_BASE_RISK_PCT, targetPct = DEFAULT_TARGET_PCT,
  regime = {}, heldQty = 0, tranches = 1, sizing = REGIME_SIZING,
} = {}) {
  const eq = num(equityInPos), p = num(price), s = num(stop);
  const m = (Number.isFinite(+multiplier) && +multiplier > 0) ? +multiplier : 1;
  const held = Math.max(0, num(heldQty) || 0);
  const nTranche = Math.max(1, Math.round(num(tranches) || 1));
  const rm = regimeMultiplier({ ...regime, sizing });

  if (!Number.isFinite(eq) || eq <= 0) {
    return { ok: false, mode, mult: rm.mult, reasons: rm.reasons, why: 'set your account equity to get a size' };
  }
  if (!Number.isFinite(p) || p <= 0) {
    return { ok: false, mode, mult: rm.mult, reasons: rm.reasons, why: 'no live price yet — refresh prices' };
  }

  let exact, riskAmount = null, effPct, pointRisk = null, perUnitRisk = null;
  // What ONE unit costs to control — the price for a share, ten times it for an MGC contract.
  const unitCost = +(p * m).toFixed(4);

  if (mode === 'risk') {
    // Risk mode is UNDEFINED without a stop. Say so and point at the alternative rather than
    // silently substituting a guessed invalidation level.
    if (!Number.isFinite(s) || s <= 0) {
      return { ok: false, mode, mult: rm.mult, reasons: rm.reasons,
        why: 'risk sizing needs a stop level — add one, or switch this position to allocation sizing' };
    }
    pointRisk = +Math.abs(p - s).toFixed(6);
    if (pointRisk <= 0) {
      return { ok: false, mode, mult: rm.mult, reasons: rm.reasons, why: 'the stop equals the price — no risk per share to size against' };
    }
    perUnitRisk = +(pointRisk * m).toFixed(4);
    effPct = +(baseRiskPct * rm.mult).toFixed(4);
    riskAmount = eq * (effPct / 100);
    exact = riskAmount / perUnitRisk;
  } else {
    effPct = +(targetPct * rm.mult).toFixed(4);
    exact = (eq * (effPct / 100)) / unitCost;
  }

  const fullExact = Math.floor(exact);
  const fullQty = roundQty(fullExact, m);
  const roomQty = Math.max(0, fullQty - held);
  const trancheQty = Math.floor(roomQty / nTranche);
  const notional = +(fullQty * unitCost).toFixed(2);
  const heldNotional = +(held * unitCost).toFixed(2);
  // What the size actually risks, on the quantity you would actually buy. Not the budget — the
  // budget is what you set out to risk, and rounding to whole units moves the outcome away from it.
  const riskAtSize = perUnitRisk == null ? null : +(fullQty * perUnitRisk).toFixed(2);

  const unitName = m > 1 ? 'contract' : 'share';
  const warnings = [];
  if (held > 0 && roomQty === 0) warnings.push(`already at or above full size (${held} held vs ${fullQty} suggested) — no room to add`);
  // THE MINIMUM TRADEABLE UNIT, when it is bigger than the risk model's answer. On an account this
  // size that is not an edge case: one MGC contract at a 40-point stop risks $400, which is 0.19%
  // of a $209k book — so a 0.6% budget buys three, and a tighter stop or a smaller budget buys
  // none at all. When that happens, contract granularity is setting the position, not the model,
  // and that is worth saying out loud rather than reporting a silent zero.
  if (m > 1 && exact < 1) {
    warnings.push(mode === 'risk'
      ? `one ${unitName} is the minimum and risks ${+((perUnitRisk / eq) * 100).toFixed(2)}% of equity against a ${effPct}% budget — contract size is setting this position, not the risk model`
      : `one ${unitName} is the minimum and is ${+((unitCost / eq) * 100).toFixed(1)}% of equity against a ${effPct}% target — contract size is setting this position, not the allocation model`);
  } else if (fullQty === 0) {
    warnings.push('the suggested size rounds to zero — the risk budget is small relative to this price');
  }
  if (nTranche > 1 && trancheQty === 0 && roomQty > 0) warnings.push(`${roomQty} ${unitName}${roomQty === 1 ? '' : 's'} of room does not divide into ${nTranche} tranches`);

  return {
    ok: true, mode, mult: rm.mult, reasons: rm.reasons,
    multiplier: m, unitName, unitCost,
    effPct,                                   // risk % (risk mode) or target allocation % (allocation)
    fullQty, fullExact, rounded: fullExact !== fullQty,
    // Sizing is linear in equity, so this states plainly how much a wrong equity figure would
    // matter — which is the question a changing account balance actually raises.
    perTenPctEquity: Math.round(fullQty * 0.1),
    heldQty: held, roomQty, tranches: nTranche, trancheQty,
    // BUDGET vs OUTCOME. `riskAmount` is what you set out to risk; `riskAtSize` is what the
    // quantity you would actually buy risks. Rounding to whole units separates them, and printing
    // the budget as though it were the outcome — which this card did — overstates the risk taken on
    // a rounded-down size and hides the gap entirely on a contract that rounds to one.
    riskAmount: riskAmount == null ? null : +riskAmount.toFixed(2),
    riskAtSize,
    riskAtSizePct: (riskAtSize == null || !(eq > 0)) ? null : +((riskAtSize / eq) * 100).toFixed(3),
    // Two quantities that used to be one field: the distance to the stop in the instrument's own
    // quoted units, and what that distance costs on one unit of it.
    pointRisk, perUnitRisk,
    notional, heldNotional,
    notionalPctOfBook: +((notional / eq) * 100).toFixed(1),
    heldPctOfBook: +((heldNotional / eq) * 100).toFixed(1),
    warnings,
  };
}

// What the suggestion actually costs you if the stop is hit — stated in the position's currency so
// it can be read next to the quantity without a mental conversion.
export function riskAtStop({ qty, price, stop, multiplier = 1 }) {
  const q = num(qty), p = num(price), s = num(stop);
  const m = (Number.isFinite(+multiplier) && +multiplier > 0) ? +multiplier : 1;
  if (![q, p, s].every(Number.isFinite) || q <= 0) return null;
  return +(Math.abs(p - s) * q * m).toFixed(2);
}
