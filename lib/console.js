// lib/console.js — pure math for the regime-aware trade console (Tier 3). No network, no React,
// no data feeds: every function is a deterministic transform of user inputs + the live regime the
// rest of the app already derives. That keeps the console inside the project's rule that no number
// shown to the user is invented — prices come from api/prices.js, levels are hand-entered, and
// everything here is arithmetic over those.

// ── Regime-scaled position sizing ────────────────────────────────────────────
// `mult` scales the trader's base risk-per-trade %. Keyed by the macro regime id (REGIMES in the
// app: stag/ref/def/inf). Growth/benign regimes allow full risk; stagflation/deflation cut it.
// These are DEFAULTS the UI lets the user edit — not law — and the suggestion is always shown
// next to the trader's own number, never forced.
export const REGIME_SIZING = {
  ref:  { mult: 1.0, label: 'Reflationary Growth',    note: 'benign trend — full risk' },
  inf:  { mult: 0.8, label: 'Inflationary Boom',      note: 'trend intact, vol higher' },
  stag: { mult: 0.6, label: 'Stagflation',            note: 'chop / whipsaw risk' },
  def:  { mult: 0.4, label: 'Deflationary Recession', note: 'capital preservation' },
};
export const CREDIT_DANGER_CAP   = 0.4;  // credit stress caps the multiplier regardless of regime
export const UNCERTAINTY_HAIRCUT = 0.7;  // regime contested OR pinned≠live → extra × on top
export const DEFAULT_BASE_RISK_PCT = 1.0;

// Coerce to a finite number or NaN. Critically, null / undefined / '' (blank inputs) become NaN,
// NOT 0 — a missing level must read as missing, never as a real price of zero. The UI stores raw
// strings while the user types (so decimals aren't mangled), so every entry point runs through this.
const num = (v) => {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'string' && v.trim() === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

// 'long' if the stop sits below entry, 'short' if above. null if indeterminate (missing/equal).
export function tradeSide(entry, stop) {
  const e = num(entry), s = num(stop);
  if (!Number.isFinite(e) || !Number.isFinite(s) || e === s) return null;
  return s < e ? 'long' : 'short';
}

// R:R for a setup. Risk R = |entry−stop| per share; reward = the FAVOURABLE move to the target
// (up for a long, down for a short). rr is null when inputs are bad or the target is on the wrong
// side of entry (negative reward is reported honestly, not hidden).
export function rMultiple({ entry, stop, target }) {
  const side = tradeSide(entry, stop);
  const e = num(entry), s = num(stop), t = num(target);
  if (!side || !Number.isFinite(t)) return { side, riskPerShare: null, rewardPerShare: null, rr: null };
  const riskPerShare = Math.abs(e - s);
  if (riskPerShare <= 0) return { side, riskPerShare: null, rewardPerShare: null, rr: null };
  const rewardPerShare = side === 'long' ? (t - e) : (e - t);
  return {
    side,
    riskPerShare: +riskPerShare.toFixed(4),
    rewardPerShare: +rewardPerShare.toFixed(4),
    rr: +(rewardPerShare / riskPerShare).toFixed(2),
  };
}

// Position size from account risk. riskPct is the % of equity lost if the stop is hit. Shares are
// floored to whole units. Returns null on any nonsensical input rather than a misleading zero.
export function positionSize({ equity, riskPct, entry, stop }) {
  const eq = num(equity), rp = num(riskPct), e = num(entry), s = num(stop);
  if (![eq, rp, e, s].every(Number.isFinite) || eq <= 0 || rp <= 0 || e <= 0) return null;
  const stopDistance = Math.abs(e - s);
  if (stopDistance <= 0) return null;
  const riskUsd = eq * (rp / 100);
  const shares = Math.floor(riskUsd / stopDistance);
  const notional = shares * e;
  return {
    riskUsd: +riskUsd.toFixed(2),
    stopDistance: +stopDistance.toFixed(4),
    shares,
    notional: +notional.toFixed(2),
    notionalPct: +((notional / eq) * 100).toFixed(1),
  };
}

// Regime multiplier + a human-readable breakdown of how it was reached. Inputs are generic so the
// UI can map whatever live signals it has (regime id, credit DANGER, contested flag, pinned≠live).
// `sizing` is the possibly user-edited REGIME_SIZING map.
export function regimeMultiplier({ regimeId, creditDanger = false, contested = false, pinnedDiverged = false, sizing = REGIME_SIZING } = {}) {
  const base = sizing[regimeId] ?? { mult: 0.6, label: regimeId || 'unknown', note: 'unmapped regime — conservative default' };
  let mult = base.mult;
  const reasons = [`${base.label}: ×${base.mult.toFixed(2)} (${base.note})`];
  if (creditDanger && mult > CREDIT_DANGER_CAP) {
    mult = CREDIT_DANGER_CAP;
    reasons.push(`credit stress caps risk at ×${CREDIT_DANGER_CAP.toFixed(2)}`);
  }
  if (contested || pinnedDiverged) {
    mult = mult * UNCERTAINTY_HAIRCUT;
    reasons.push(`${contested ? 'regime contested' : 'pinned≠live regime'} → ×${UNCERTAINTY_HAIRCUT} uncertainty haircut`);
  }
  return { mult: +mult.toFixed(3), base: base.mult, reasons };
}

// Suggested size = base risk% scaled by the regime multiplier, then sized off the stop distance.
export function suggestedSize({ equity, baseRiskPct = DEFAULT_BASE_RISK_PCT, regime = {}, entry, stop, sizing = REGIME_SIZING }) {
  const rm = regimeMultiplier({ ...regime, sizing });
  const effRiskPct = +(baseRiskPct * rm.mult).toFixed(4);
  return { effRiskPct, mult: rm.mult, reasons: rm.reasons, size: positionSize({ equity, riskPct: effRiskPct, entry, stop }) };
}

// Distance from the live price to each level, in % and in R (risk units off the first target's R).
export function distanceToLevels({ price, entry, stop, targets = [] }) {
  const p = num(price);
  const R = rMultiple({ entry, stop, target: targets[0] }).riskPerShare;
  const pct = (lvl) => (Number.isFinite(num(lvl)) && p > 0) ? +(((num(lvl) - p) / p) * 100).toFixed(2) : null;
  const inR = (lvl) => (Number.isFinite(num(lvl)) && R > 0) ? +(((num(lvl) - p) / R).toFixed(2)) : null;
  return {
    entry: { pct: pct(entry), r: inR(entry) },
    stop:  { pct: pct(stop),  r: inR(stop) },
    targets: (targets || []).map(t => ({ level: +t, pct: pct(t), r: inR(t) })),
  };
}

// Which levels the live price has REACHED, for poll-cadence alerts. Side-aware. Entry semantics
// are ambiguous (a limit fill crosses down, a breakout crosses up), so entry only fires when price
// is within epsilonPct of it; stop and targets are deterministic directional crossings.
export function triggeredLevels({ price, entry, stop, targets = [], epsilonPct = 0.15 }) {
  const p = num(price), e = num(entry), s = num(stop);
  const side = tradeSide(e, s);
  const out = [];
  if (!Number.isFinite(p) || p <= 0) return out;
  if (Number.isFinite(e) && e > 0 && Math.abs((p - e) / e) * 100 <= epsilonPct) out.push({ level: 'entry', kind: 'entry', price: e });
  if (side && Number.isFinite(s)) {
    if (side === 'long' ? p <= s : p >= s) out.push({ level: 'stop', kind: 'stop', price: s });
  }
  if (side) (targets || []).forEach((t, i) => {
    const tv = num(t);
    if (!Number.isFinite(tv)) return;
    if (side === 'long' ? p >= tv : p <= tv) out.push({ level: `target${i + 1}`, kind: 'target', price: tv });
  });
  return out;
}
