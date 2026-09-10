// lib/liveRates.js — the live long end, for the predicates that compare a level to a line.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// 2026-09-10, 13:28Z. The scenario board scored C (`30Y > 5.35%`) and D (`30Y > 5.5%`) against
// 5.25% and rendered both `✗ … 0/2`. The live 30Y was 5.344% — nine basis points higher, and six
// tenths of one basis point from C's threshold. The board said "not close" on the day rates were
// the entire story.
//
// The number was not wrong; it was FRED's DGS30 print for 2026-09-08, correctly fetched and
// correctly dated. It is the right series for a history, an ATR and a day-over-day delta, and the
// wrong one for asking whether a yield is through a level RIGHT NOW.
//
// The CBOE yield indices are that number, live, keyless, through the same Yahoo path everything
// else on the board already uses. ^TYX/^TNX/^FVX quote the yield directly in percent — ^TYX 5.339
// against DGS30's 5.25 on the render above.
//
// THERE IS NO LIVE 2-YEAR. Yahoo has no CBOE index for it, and 2YY=F (the CBOT 2-Year Yield
// future) served a stale print 10bp off the cash yield when this was measured. So the 2Y keeps
// only the delayed series and takes the stale guard in lib/scenarios.js instead — which is
// exactly the fallback the brief asks for, not a gap in it.
export const LIVE_YIELD_SYM = Object.freeze({ us30y: '^TYX', us10y: '^TNX', us5y: '^FVX' });

// A quote older than this is not "live" for a threshold predicate, however recently it was
// fetched. Outside the US session these indices carry the last settle with an old timestamp, and
// a settle dressed as a live print is the failure this module exists to fix, one layer down.
export const LIVE_MAX_AGE_MIN = 30;

export function liveAgeMin(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return null;
  return (now / 1000 - ts) / 60;
}

// Shape a raw quote row into the field the rest of the board consumes, or null if it cannot be
// trusted as live. Null is the honest answer and it has a defined consequence: the caller falls
// back to the delayed series, which then carries its own vintage into the stale guard.
export function liveYield(row, { now = Date.now(), maxAgeMin = LIVE_MAX_AGE_MIN } = {}) {
  const value = Number(row?.price);
  if (!Number.isFinite(value) || value <= 0) return null;
  const ageMin = liveAgeMin(row?.ts, now);
  if (ageMin == null || ageMin > maxAgeMin) return null;
  // The SAME-SESSION direction, which is a different question from the day-over-day FRED delta.
  // "Is the 30Y rising right now" is what a same-day cross-asset read needs; DGS30's deltaBps is
  // the move between two settled observations and on a stale morning spans two sessions.
  const prev = Number(row?.prevClose);
  return {
    value: +value.toFixed(3),
    prevClose: Number.isFinite(prev) && prev > 0 ? +prev.toFixed(3) : null,
    changeBps: Number.isFinite(prev) && prev > 0 ? Math.round((value - prev) * 100) : null,
    rising: Number.isFinite(prev) && prev > 0 ? value > prev : null,
    ts: row.ts,
    ageMin: +ageMin.toFixed(1),
    src: row.sym,
    // The ISO minute, because "live" without a time is a claim the reader cannot check.
    asOf: new Date(row.ts * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
  };
}

// Fetches all three at once through the caller's own quote function, so this module holds no
// transport of its own and inherits every rescue and staleness rule getQuotes already applies.
// A failure is logged and returns {} — the board then runs on the delayed series plus the guard,
// which is a worse reading but never a wrong one.
export async function fetchLiveYields(getQuotes, { now = Date.now(), maxAgeMin = LIVE_MAX_AGE_MIN } = {}) {
  const keys = Object.keys(LIVE_YIELD_SYM);
  const syms = keys.map(k => LIVE_YIELD_SYM[k]);
  let rows;
  try {
    rows = await getQuotes(syms);
  } catch (e) {
    console.warn('[liveRates] live yield fetch failed — falling back to the delayed series:', e?.message || e);
    return {};
  }
  const bySym = Object.fromEntries((rows || []).filter(Boolean).map(r => [r.sym, r]));
  const out = {};
  for (const k of keys) {
    const live = liveYield(bySym[LIVE_YIELD_SYM[k]], { now, maxAgeMin });
    if (live) out[k] = live;
  }
  return out;
}

// ── MERGING LIVE OVER DELAYED ────────────────────────────────────────────────
// The delayed series keeps everything it is good at — the ATR, the prior print, the 1d delta in
// basis points, the benchmark. Only the VALUE and its vintage are replaced, and the replacement
// is labelled: `live: true` is what tells lib/scenarios.js the stale guard has nothing to do.
export function withLive(field, live) {
  if (!field) return field;
  if (!live) return { ...field, live: false };
  return {
    ...field,
    value: live.value,
    live: true, liveTs: live.ts, liveAsOf: live.asOf, liveSrc: live.src, liveAgeMin: live.ageMin,
    // Same-session move, kept beside the day-over-day one rather than replacing it: they answer
    // different questions and a reader is entitled to both.
    liveChangeBps: live.changeBps ?? null, liveRising: live.rising ?? null, livePrevClose: live.prevClose ?? null,
    // The delayed print is kept, named, so a reader can see the gap the guard exists for.
    delayed: { value: field.value, date: field.date, src: field.src },
    // A live quote's "date" is today by definition — this is the field the vintage checks read.
    date: new Date(live.ts * 1000).toISOString().slice(0, 10),
  };
}
