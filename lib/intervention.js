// lib/intervention.js — two different questions that one boolean had been answering at once.
//
// The old flag was a single `active` that had been true since 2026-08-21, and it conflated:
//
//   "something happened in this session"   — an EVENT, observable, short-lived
//   "this pair is being managed"           — a REGIME, inferred, persistent
//
// An event is a thing you can see in a bar: a move against its own volatility, on volume, that
// moves the index by itself, away from a release that would explain it. A regime is a judgement
// that survives quiet days. Collapsing them means the flag can never be right for long — set it on
// an event and it is stale tomorrow; set it on a regime and it says "today" about a fortnight ago.
//
// AND CONTAMINATION IS SCOPED TO THE LEG. This is the structural point. The old annotation said
// "treat the dollar leg as contaminated", which reads as all of it. A yen flag says nothing
// whatsoever about EUR/USD: the euro is a different market with a different central bank. What a
// yen flag contaminates is the yen leg, and — because DXY is a blend containing it — any reading
// that uses DXY as a proxy for "broad dollar". Anything that wants a broad-dollar read must
// therefore be handed the CLEAN legs and read those, which is what cleanLegs exists for.
//
// NOTHING HERE FETCHES AND NOTHING HERE BLOCKS. Every input may be absent; a criterion that cannot
// be evaluated is `null`, an event cannot fire on unknowns, and the reason is carried out for the
// caller to render rather than swallowed.

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

export const CURRENCIES = Object.freeze(['JPY', 'KRW']);

// SUSPECTED is the honest default and CONFIRMED has a documentary bar, because the difference
// matters: one is a reading of price, the other is a fact someone published. A flag that cannot
// tell them apart will drift to whichever the reader already believed.
export const GRADE = Object.freeze({ SUSPECTED: 'SUSPECTED', CONFIRMED: 'CONFIRMED' });

export const EVENT_CFG = Object.freeze({
  atrMult: 2,            // single-bar move at or beyond 2x that pair's ATR
  volMult: 3,            // volume at or beyond 3x the 20-period average
  legSharePct: 80,       // this leg accounting for more than 80% of the DXY move
  releaseGapMin: 30,     // and no scheduled release inside half an hour either side
  clearAfterSessions: 2, // an unrepeated event is stale after two sessions
});

export const REGIME_CFG = Object.freeze({
  sustainSessions: 2,    // price held beyond the defended level this long, with no event, clears it
  quietSessions: 10,     // no event signature for this long clears it
});

// ── SESSIONS, APPROXIMATELY AND ON PURPOSE ───────────────────────────────────
// Weekdays between two dates, holidays ignored. A proper session count needs an exchange calendar
// per pair and this file does not fetch. The approximation OVER-counts sessions across a holiday
// week, which would clear a flag early — the unsafe direction — so every clear below requires
// STRICTLY MORE than its threshold rather than at-least. That buys a session of slack, which
// covers the ordinary single-holiday case, and a flag that lingers is a smaller error than one
// that lifts while the intervention is still running.
export function sessionsBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  let n = 0;
  for (let t = a + 86400000; t <= b; t += 86400000) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) n++;
  }
  return n;
}

// ── THE EVENT ────────────────────────────────────────────────────────────────
// Four criteria, all required. Each is reported individually whether or not it fired, because
// "three of four" is the interesting case and a bare false hides it.
//
// `legSharePct` is the share of the DXY move this leg's weighted contribution accounts for — the
// arithmetic the old annotation already computed. Above 80% the index is essentially reporting
// this one pair, which is the signature that separates official selling in one currency from a
// broad dollar move that happens to include it.
export function detectEvent({
  currency, changePct, atrPct, volume, avgVolume20, legSharePct, minutesToNextRelease,
} = {}, cfg = EVENT_CFG) {
  const move = num(changePct), atr = num(atrPct);
  const vol = num(volume), avgVol = num(avgVolume20);
  const share = num(legSharePct), gap = num(minutesToNextRelease);

  const criteria = [
    {
      id: 'move', label: `move ≥ ${cfg.atrMult}× ATR`,
      met: (move == null || atr == null || atr <= 0) ? null : Math.abs(move) >= cfg.atrMult * atr,
      display: (move == null || atr == null) ? 'no ATR or no move'
        : `${Math.abs(move).toFixed(2)}% vs ${(cfg.atrMult * atr).toFixed(2)}% needed`,
    },
    {
      id: 'volume', label: `volume ≥ ${cfg.volMult}× 20-period average`,
      met: (vol == null || avgVol == null || avgVol <= 0) ? null : vol >= cfg.volMult * avgVol,
      display: (vol == null || avgVol == null) ? 'no volume'
        : `${(vol / avgVol).toFixed(1)}× average`,
    },
    {
      id: 'share', label: `> ${cfg.legSharePct}% of the DXY move`,
      // Absolute share: a leg driving the index the other way is not driving it.
      met: share == null ? null : Math.abs(share) > cfg.legSharePct,
      display: share == null ? 'no attribution' : `${Math.round(share)}%`,
    },
    {
      id: 'release', label: `no release within ${cfg.releaseGapMin} min`,
      // Unknown is NOT treated as clear. A move next to a payroll print has an explanation that is
      // not intervention, and assuming there was no release because nobody said so is the way a
      // detector manufactures the thing it is looking for.
      met: gap == null ? null : Math.abs(gap) >= cfg.releaseGapMin,
      display: gap == null ? 'release calendar unavailable' : `${Math.abs(Math.round(gap))} min away`,
    },
  ];

  const unknown = criteria.filter(c => c.met === null);
  const failed = criteria.filter(c => c.met === false);
  const fired = unknown.length === 0 && failed.length === 0;

  return {
    currency: currency || null, fired, criteria,
    unknownCount: unknown.length, metCount: criteria.filter(c => c.met === true).length,
    reason: fired
      ? `all four criteria met — ${criteria.map(c => c.display).join(', ')}`
      : unknown.length
        ? `cannot be evaluated: ${unknown.map(c => c.label).join('; ')} — an event is not declared on missing evidence`
        : `${failed.length} of 4 criteria not met: ${failed.map(c => `${c.label} (${c.display})`).join('; ')}`,
  };
}

// Is a recorded event still live? Two sessions, then it is history — unless it re-triggered, which
// is a NEW event with a later date and so answers this on its own.
export function eventLive(event, today, cfg = EVENT_CFG) {
  if (!event?.firedOn || !today) return false;
  const n = sessionsBetween(event.firedOn, today);
  return n == null ? false : n <= cfg.clearAfterSessions;
}

// ── THE REGIME ───────────────────────────────────────────────────────────────
// Set by hand, or on a confirmed event. It clears on any ONE of three conditions, and each is
// reported by name — "the flag cleared" without saying which condition fired is not a finding.
export function regimeStatus(regime, {
  today, sessionsBeyondDefended = null, sessionsSinceEvent = null, manualClear = false,
} = {}, cfg = REGIME_CFG) {
  if (!regime?.grade) return { active: false, reason: 'no regime flag set' };
  const grade = regime.grade === GRADE.CONFIRMED ? GRADE.CONFIRMED : GRADE.SUSPECTED;

  const beyond = num(sessionsBeyondDefended);
  const quiet = num(sessionsSinceEvent);
  const clears = [];
  if (manualClear) clears.push('cleared by hand');
  if (beyond != null && beyond > cfg.sustainSessions) {
    clears.push(`price has held beyond the defended level for ${beyond} sessions with no event — the level is no longer being defended`);
  }
  if (quiet != null && quiet > cfg.quietSessions) {
    clears.push(`no event signature for ${quiet} sessions`);
  }

  const heldFor = regime.since && today ? sessionsBetween(regime.since, today) : null;
  return {
    active: clears.length === 0,
    grade, since: regime.since ?? null, currency: regime.currency ?? null,
    defendedLevel: num(regime.defendedLevel), review: regime.review ?? null,
    note: regime.note ?? null,
    heldForSessions: heldFor,
    clears,
    reason: clears.length
      ? `cleared — ${clears.join('; ')}`
      : `${grade}${regime.since ? ` since ${regime.since}` : ''}${heldFor != null ? `, ${heldFor} sessions` : ''}`
        + (grade === GRADE.SUSPECTED ? '. SUSPECTED means read off price, not published — CONFIRMED needs an official statement or Japan MoF monthly data.' : ''),
  };
}

// ── WHAT IS CONTAMINATED, AND WHAT IS NOT ────────────────────────────────────
// The whole reason the flags were split. A JPY flag contaminates the yen leg and, because the
// index contains it, any use of DXY as a stand-in for "broad dollar". It says nothing about the
// euro, which is the leg a broad-dollar read should then be taken from.
export function contamination(state = {}, today = null) {
  const flagged = {};
  for (const cur of CURRENCIES) {
    const r = regimeStatus(state.regimes?.[cur], { today, ...(state.context?.[cur] || {}) });
    const ev = state.events?.[cur];
    const live = eventLive(ev, today);
    if (r.active || live) {
      flagged[cur] = {
        currency: cur,
        regime: r.active ? { grade: r.grade, since: r.since, review: r.review } : null,
        event: live ? { firedOn: ev.firedOn } : null,
        why: [r.active ? r.reason : null, live ? `event ${ev.firedOn}` : null].filter(Boolean).join(' · '),
      };
    }
  }
  const legs = Object.keys(flagged);
  return {
    flagged, legs,
    any: legs.length > 0,
    // DXY is not itself flagged — it is DISQUALIFIED as a broad-dollar proxy, which is a different
    // statement and the one the panels need.
    dxyUsable: legs.length === 0,
    note: legs.length === 0
      ? 'no leg carries an intervention flag — DXY may be read as a broad dollar proxy'
      : `${legs.join(' and ')} flagged — ${legs.length === 1 ? 'that leg is' : 'those legs are'} contaminated and DXY contains ${legs.length === 1 ? 'it' : 'them'}, so DXY is not a broad-dollar proxy today. Read the clean legs instead.`,
  };
}

// The legs a broad-dollar claim may actually be built from. `legs` are the USD-frame readings
// (see usdLeg in lib/quotes.js): { vs, pct }.
export function cleanLegs(legs = [], contam = { flagged: {} }) {
  return (Array.isArray(legs) ? legs : []).filter(l => l?.vs && !contam?.flagged?.[l.vs]);
}
