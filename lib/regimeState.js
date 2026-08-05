// regimeState.js — cross-asset regime classifier ("what is the tape doing today").
//
// Distinct from deriveRegimeProbabilities() in the dashboard, which turns analyst recession
// consensus + CPI into forward probabilities. This reads PRICE ACTION, and it exists because
// the probability model structurally cannot represent a session like 2026-07-31: gold, long
// bonds, bitcoin, utilities, staples and small caps all lower while large-cap equities hold
// up. Forced into the nearest of four states, that prints something wrong.
//
// THE DISCRIMINATOR (the whole point of this module):
//   In a deleveraging / dash-for-cash regime, defensives get BID.
//   In a hawkish rates repricing, defensives get SOLD — they are bond proxies.
// Gold and bonds alone cannot separate those two. XLU/XLP can.
//
// Every branch requires its inputs to exist. Missing inputs produce INSUFFICIENT_DATA with
// the gaps named, never a forced fit.

export const REGIME_STATES = {
  HAWKISH_RATES_REPRICING: { label: 'Hawkish rates repricing', color: '#B45309' },
  DEFLATIONARY_RECESSION:  { label: 'Deleveraging / dash-for-cash', color: '#1D4ED8' },
  STAGFLATION:             { label: 'Stagflation', color: '#B45309' },
  REFLATIONARY_GROWTH:     { label: 'Reflationary growth', color: '#166534' },
  INFLATIONARY_BOOM:       { label: 'Inflationary boom', color: '#7C3AED' },
  // F2 — gold bid while market-implied inflation FALLS is not stagflation. It is the real-yield
  // leg: gold rallying because the discount rate is coming down, which is an easing story.
  DISINFLATIONARY_EASING:  { label: 'Disinflationary easing', color: '#0F766E' },
  INSUFFICIENT_DATA:       { label: 'Insufficient data', color: '#7C82A0' },
};

// Tunables.
export const SPY_HOLDING_UP = -0.5;   // large-cap "did not break" threshold (% day)
export const SPY_CLEARLY_DOWN = -0.75;
export const FLAT_EPS = 0.05;         // |%| below this is treated as flat

const dirOf = (v, eps = FLAT_EPS) => v == null ? null : v > eps ? 'up' : v < -eps ? 'down' : 'flat';
const isDown = v => v != null && v < -FLAT_EPS;
const isUp   = v => v != null && v >  FLAT_EPS;

// ── F2 — gold is only readable as a PAIR ─────────────────────────────────────
// Gold alone is ambiguous and has been read both ways in a single week. The same rally means
// opposite things depending on what market-implied inflation did alongside it:
//
//   gold up + breakevens UP    → inflation hedge bid          → stagflation
//   gold up + breakevens DOWN  → real-yield / discount-rate   → disinflationary easing
//
// Anything that reads gold without its breakeven partner is guessing, so this returns an
// explicit "ambiguous" rather than defaulting to the inflation reading when the pair is
// incomplete. Breakevens are a MARKET price (T10YIE) and forward-looking, which is what makes
// them the right partner for a same-session gold move — realized CPI cannot play this role.
export const BE_FLAT_BP = 2;   // |bp| below this is flat; daily BE noise lives under ~2bp

export function goldBreakevenRead({ gold, breakeven } = {}) {
  const beDeltaBp = breakeven && breakeven.now != null && breakeven.prior != null
    ? Math.round((breakeven.now - breakeven.prior) * 100) : null;
  const goldDir = dirOf(gold);
  if (goldDir == null || beDeltaBp == null) {
    return {
      available: false, goldDir, beDeltaBp,
      reading: 'AMBIGUOUS',
      note: goldDir == null
        ? 'gold direction unavailable — pair unreadable'
        : 'breakeven prior unavailable — gold cannot be read alone, so no inflation/real-yield call is made',
    };
  }
  const beDir = Math.abs(beDeltaBp) < BE_FLAT_BP ? 'flat' : beDeltaBp > 0 ? 'up' : 'down';
  const beTxt = `10Y breakeven ${beDeltaBp >= 0 ? '+' : ''}${beDeltaBp}bp`;
  const goldTxt = `gold ${gold >= 0 ? '+' : ''}${gold}%`;

  let reading, note;
  if (goldDir === 'up' && beDir === 'up') {
    reading = 'INFLATION_HEDGE';
    note = `${goldTxt} with ${beTxt} — gold is being bought as an INFLATION HEDGE. Stagflationary read.`;
  } else if (goldDir === 'up' && beDir === 'down') {
    reading = 'REAL_YIELD_DRIVEN';
    note = `${goldTxt} while ${beTxt} — the bid is REAL-YIELD driven, not an inflation hedge. Disinflationary easing, not stagflation.`;
  } else if (goldDir === 'up') {
    reading = 'AMBIGUOUS';
    note = `${goldTxt} with breakevens flat (${beDeltaBp}bp) — no inflation signal in the pair; the bid is not explained here.`;
  } else if (goldDir === 'down' && beDir === 'down') {
    reading = 'DISINFLATION';
    note = `${goldTxt} with ${beTxt} — both legs point to receding inflation expectations.`;
  } else if (goldDir === 'down' && beDir === 'up') {
    reading = 'AMBIGUOUS';
    note = `${goldTxt} against ${beTxt} — gold falling while implied inflation rises is a real-rate or positioning move, not an inflation signal.`;
  } else {
    reading = 'NEUTRAL';
    note = `${goldTxt}, ${beTxt} — neither leg is moving enough to read.`;
  }
  return { available: true, goldDir, beDir, beDeltaBp, reading, note };
}

// inputs: { gold, tlt, btc, xlu, xlp, iwm, spy, qqq, us10y:{now,prior}, us2y:{now,prior},
//           realYield:{now,prior}, breakeven:{now,prior} } — all % day change unless noted.
export function classifyMarketRegime(inp = {}) {
  const { gold, tlt, xlu, xlp, spy } = inp;
  const need = { gold, tlt, xlu, xlp, spy };
  const missing = Object.entries(need).filter(([, v]) => v == null).map(([k]) => k);
  if (missing.length) {
    return {
      state: 'INSUFFICIENT_DATA', label: REGIME_STATES.INSUFFICIENT_DATA.label,
      reasons: [], missing,
      note: `cannot classify — missing ${missing.join(', ')}`,
    };
  }

  const reasons = [];
  const goldDown = isDown(gold), tltDown = isDown(tlt);
  const defensivesSold = isDown(xlu) || isDown(xlp);
  const defensivesBid  = isUp(xlu) && isUp(xlp);

  // Corroboration: a near-parallel rise in 2Y AND 10Y is a rates repricing. 2Y falling while
  // 10Y rises is a different animal (growth/term-premium), so it does NOT corroborate.
  const d10 = inp.us10y && inp.us10y.now != null && inp.us10y.prior != null ? inp.us10y.now - inp.us10y.prior : null;
  const d2  = inp.us2y  && inp.us2y.now  != null && inp.us2y.prior  != null ? inp.us2y.now  - inp.us2y.prior  : null;
  const parallelUp = d10 != null && d2 != null && d10 > 0 && d2 > 0;
  const corroboration = (d10 == null || d2 == null)
    ? { available: false, note: 'yield pair unavailable — classification rests on the equity/defensive legs' }
    : {
        available: true, d10: +d10.toFixed(3), d2: +d2.toFixed(3), parallelUp,
        note: parallelUp
          ? `2Y +${(d2 * 100).toFixed(0)}bp and 10Y +${(d10 * 100).toFixed(0)}bp together — near-parallel shift, consistent with rates repricing`
          : `2Y ${d2 >= 0 ? '+' : ''}${(d2 * 100).toFixed(0)}bp vs 10Y ${d10 >= 0 ? '+' : ''}${(d10 * 100).toFixed(0)}bp — not a parallel shift`,
      };
  // Gold down WITH real yields up is the cleanest confirmation of repricing over debasement.
  const dReal = inp.realYield && inp.realYield.now != null && inp.realYield.prior != null
    ? inp.realYield.now - inp.realYield.prior : null;
  const realUp = dReal != null && dReal > 0;

  // ── Section B — ACM 10Y term premium ──
  // A MODEL ESTIMATE, not a market price: direction and trend only, never the level. It
  // sharpens the same discriminator — gold falling WITH term premium rising is a rates story;
  // gold falling while term premium is FLAT means the explanation is elsewhere.
  const dTp = inp.termPremium && inp.termPremium.now != null && inp.termPremium.prior != null
    ? inp.termPremium.now - inp.termPremium.prior : null;
  const tpDir = dTp == null ? null : Math.abs(dTp) < 0.005 ? 'flat' : dTp > 0 ? 'rising' : 'falling';
  const termPremium = tpDir == null
    ? { available: false, note: 'term premium unavailable — confidence unmodified' }
    : {
        available: true, dir: tpDir, deltaBp: Math.round(dTp * 100),
        note: tpDir === 'rising'
          ? `ACM term premium rising (${dTp > 0 ? '+' : ''}${Math.round(dTp * 100)}bp, model estimate) — corroborates a rates repricing`
          : tpDir === 'flat'
            ? 'ACM term premium FLAT (model estimate) — a gold decline here is not obviously a rates story; look elsewhere'
            : `ACM term premium falling (${Math.round(dTp * 100)}bp, model estimate) — does not corroborate a rates repricing`,
      };

  // F2 / Q1 — market-implied inflation, ingested rather than merely displayed.
  const goldPair = goldBreakevenRead({ gold, breakeven: inp.breakeven });

  let state;
  if (goldDown && tltDown && defensivesSold && spy >= SPY_HOLDING_UP) {
    state = 'HAWKISH_RATES_REPRICING';
    reasons.push(`gold ${gold}% and TLT ${tlt}% both lower`);
    reasons.push(`defensives SOLD (XLU ${xlu}%, XLP ${xlp}%) — bond proxies repricing, not a flight to safety`);
    reasons.push(`large caps holding (SPY ${spy >= 0 ? '+' : ''}${spy}%) — no broad risk-off`);
    if (parallelUp) reasons.push(corroboration.note);
    if (realUp) reasons.push(`10Y real yield +${(dReal * 100).toFixed(0)}bp — rates, not debasement, explains gold`);
    if (termPremium.available) reasons.push(termPremium.note);
  } else if (goldDown && tltDown && defensivesBid && spy < SPY_CLEARLY_DOWN) {
    state = 'DEFLATIONARY_RECESSION';
    reasons.push(`gold ${gold}% and TLT ${tlt}% both lower`);
    reasons.push(`defensives BID (XLU +${xlu}%, XLP +${xlp}%) — flight to safety within equities`);
    reasons.push(`large caps breaking (SPY ${spy}%) — broad risk reduction`);
  } else if (isUp(gold) && isDown(tlt) && spy < 0 && goldPair.reading !== 'REAL_YIELD_DRIVEN') {
    state = 'STAGFLATION';
    reasons.push(`gold +${gold}% with TLT ${tlt}% — inflation bid against duration`);
    reasons.push(`equities lower (SPY ${spy}%) — growth not paying for the inflation`);
    // F2 — the stagflation read is only earned when the breakeven leg corroborates it. Said
    // out loud either way, so a call resting on an unreadable pair is visibly weaker.
    reasons.push(goldPair.available ? goldPair.note
      : `${goldPair.note} — stagflation read rests on gold/TLT alone`);
  } else if (isUp(gold) && goldPair.reading === 'REAL_YIELD_DRIVEN') {
    // F2 — the redirect. Gold bid with implied inflation FALLING is an easing story, and
    // calling it stagflation is the specific error this pair rule exists to prevent.
    state = 'DISINFLATIONARY_EASING';
    reasons.push(goldPair.note);
    if (isDown(tlt)) reasons.push(`TLT ${tlt}% — duration still soft, so the easing is not yet in the long end`);
    if (dReal != null && dReal < 0) reasons.push(`10Y real yield ${(dReal * 100).toFixed(0)}bp — the real leg confirms it`);
  } else if (isUp(spy) && isUp(tlt) && !isDown(xlu)) {
    state = 'REFLATIONARY_GROWTH';
    reasons.push(`equities +${spy}% and duration +${tlt}% together — growth without a rates penalty`);
  } else if (isUp(gold) && isUp(spy) && isDown(tlt)) {
    state = 'INFLATIONARY_BOOM';
    reasons.push(`gold +${gold}% and equities +${spy}% while duration ${tlt}% — nominal growth bid`);
  } else {
    state = 'INSUFFICIENT_DATA';
    reasons.push('no branch matched — the legs disagree without forming a recognised pattern');
  }

  // Section B — term premium modifies CONFIDENCE; it never decides the branch. A flat term
  // premium is the useful negative: it says a gold decline here may not be a rates story.
  const confidence = state !== 'HAWKISH_RATES_REPRICING' ? null
    : (termPremium.dir === 'rising' && parallelUp) ? 'high'
    : termPremium.dir === 'flat' ? 'low — term premium flat, may not be a rates story'
    : termPremium.dir === 'falling' ? 'low — term premium falling, does not corroborate'
    : 'moderate';

  return {
    state, label: REGIME_STATES[state].label, color: REGIME_STATES[state].color,
    reasons, corroboration, termPremium, confidence, goldPair, missing: [],
    inputs: {
      gold: dirOf(gold), tlt: dirOf(tlt), xlu: dirOf(xlu), xlp: dirOf(xlp),
      spy: dirOf(spy), qqq: dirOf(inp.qqq), iwm: dirOf(inp.iwm), btc: dirOf(inp.btc),
      // Logged so a change to the pair rule can be re-run against recorded days.
      breakevenBp: goldPair.beDeltaBp ?? null,
    },
    // The discriminator's verdict, stated plainly — this is what separates the two
    // gold-down/bonds-down regimes and is the single most useful line on the card.
    discriminator: defensivesSold ? 'defensives SOLD → bond-proxy repricing'
                 : defensivesBid  ? 'defensives BID → flight to safety'
                 : 'defensives mixed → no clean discriminator',
  };
}

// ── P5 — concentration ladder ────────────────────────────────────────────────
// Fixed order, widest-beta to narrowest: SMH → QQQ → SPY → IWM → HYG.
// Monotonic ordering with a wide spread means ONE theme is carrying the tape, not breadth.
export const LADDER_ORDER = ['SMH', 'QQQ', 'SPY', 'IWM', 'HYG'];
export const LADDER_SPREAD_ALERT = 2.5;

export function concentrationLadder(pctBySymbol = {}) {
  const rungs = LADDER_ORDER.map(sym => ({ sym, pct: pctBySymbol[sym] ?? null }));
  const have = rungs.filter(r => r.pct != null);
  if (have.length < 2) {
    return { rungs, spread: null, monotonic: null, alert: false, note: 'insufficient rungs to read the ladder' };
  }
  // Monotonic = each rung <= the one above it, in the fixed order (no re-sorting).
  let monotonic = true;
  for (let i = 1; i < have.length; i++) if (have[i].pct > have[i - 1].pct) { monotonic = false; break; }
  const spread = +(have[0].pct - have[have.length - 1].pct).toFixed(2);
  const alert = monotonic && spread > LADDER_SPREAD_ALERT;
  return {
    rungs, spread, monotonic, alert,
    partial: have.length < LADDER_ORDER.length,
    note: alert
      ? `single-theme move: ${have.map(r => r.sym).join(' > ')} in order, ${spread}pp top-to-bottom`
      : monotonic ? `ordered but narrow (${spread}pp) — participation is broader`
      : `not monotonic (${spread}pp span) — no single-theme signature`,
  };
}
