// regime.js — deterministic regime tagging. NO model here. Pure arithmetic on the spine's output.
// The model only writes prose later, and only from THIS output.

import { ROLE_META } from '../data/universe.js';
import { freshness } from './sessions.js';
import { twoDimGate, OAS_LEVELS, OAS_WORDS, OAS_ESCALATE, VKOSPI_LEVELS, VKOSPI_WORDS, KRW_FLIP, levelOf } from './gates.js';

const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// structure tag vs MAs
export function structure(q) {
  if (q.price == null || q.ma50 == null || q.ma200 == null) return null;
  if (q.price > q.ma50 && q.price > q.ma200) return 'above both';
  if (q.price < q.ma50 && q.price < q.ma200) return 'below both';
  if (q.price < q.ma200) return 'below 200d';
  if (q.price < q.ma50)  return 'below 50d';
  return 'mixed';
}

// Memory vs Foundry split — the live axis. Foundry now spans leading-edge + mature-node
// sub-roles (analog is its OWN thing, excluded here). Returns a labeled read + the spread.
export function memoryVsFoundry(quotes, names) {
  const pctWhere = pred => quotes
    .map((q, i) => ({ q, meta: names[i] }))
    .filter(x => x.meta && pred(x.meta.role) && x.q.changePct != null)
    .map(x => x.q.changePct);

  const mem = avg(pctWhere(r => r === 'memory'));
  const fnd = avg(pctWhere(r => r === 'foundry-leading' || r === 'foundry-mature'));
  if (mem == null || fnd == null) return { label: 'n/a', mem, fnd, spread: null };

  const spread = fnd - mem;               // + = foundry outperforming
  let label;
  if (Math.abs(spread) < 1.5)      label = 'moving together';
  else if (spread > 0)             label = 'memory-specific weakness (foundry holding)';
  else                             label = 'foundry-specific weakness (memory holding)';
  return { label, mem: +mem.toFixed(2), fnd: +fnd.toFixed(2), spread: +spread.toFixed(2) };
}

// AI-levered vs non-AI split — the second axis. AI-capex RECIPIENTS (memory, litho, equip,
// GPU, leading-edge foundry) vs mature-node / analog / auto. Cuts ACROSS the memory/foundry
// line — today's real split was AI-bid vs mature/analog-sold, which the old axis couldn't
// express. Returns the labeled read + both baskets (name + %chg) so the card is auditable.
export function aiLeveredVsNon(quotes, names) {
  const rows = quotes
    .map((q, i) => ({ q, meta: names[i] }))
    .filter(x => x.meta && x.q.changePct != null && ROLE_META[x.meta.role]?.ai != null);
  const basket = pred => rows
    .filter(x => ROLE_META[x.meta.role]?.ai === pred)
    .map(x => ({ name: x.meta.name, role: x.meta.role, chg: +x.q.changePct.toFixed(2) }))
    .sort((a, b) => b.chg - a.chg);

  const aiBasket = basket(true), nonBasket = basket(false);
  const ai  = avg(aiBasket.map(x => x.chg));
  const non = avg(nonBasket.map(x => x.chg));
  if (ai == null || non == null) return { label: 'n/a', ai, non, spread: null, aiBasket, nonBasket };

  const spread = ai - non;                // + = AI-levered outperforming
  let label;
  if (Math.abs(spread) < 1.5)      label = 'moving together';
  else if (spread > 0)             label = 'AI-levered bid, non-AI lagging';
  else                             label = 'AI-levered sold, non-AI holding';
  return { label, ai: +ai.toFixed(2), non: +non.toFixed(2), spread: +spread.toFixed(2), aiBasket, nonBasket };
}

// Credit anchor — TWO-DIMENSIONAL (level × direction). A level-only gate read "Calm" while
// OAS ran 2.68 → 2.77 → 2.79: the level was calm but the trend was the signal. Direction and
// the consecutive-session count come from real FRED prints (oas.series), never from one
// reading. Calm + Widening for 3+ consecutive sessions elevates to WATCH regardless of level.
export function creditState(oasValue, oasSeries = null) {
  if (oasValue == null) return { state: 'unknown', level: null, note: 'no OAS print', compound: 'UNKNOWN' };

  const g = twoDimGate({
    value: oasValue, series: oasSeries, levels: OAS_LEVELS, words: OAS_WORDS,
    escalate: OAS_ESCALATE, digits: 2,
  });

  const NOTE = {
    CALM:   'correction regime, not a break',
    WATCH:  'approaching the stress line',
    STRESS: 'Path-2 territory — defend the book',
  };
  const state = String(g.effective || '').toLowerCase();
  return {
    state,                       // effective (post-escalation) level, lower-cased for the UI
    level: g.level,              // raw level band
    dir: g.dir, word: g.word,    // direction from stored priors (null when no prior)
    compound: g.compound,        // "CALM · WIDENING (+0.02 1d, +0.11 5d)"
    runs: g.runs, escalated: g.escalated,
    d1: g.d1, d5: g.d5,
    note: g.note || NOTE[g.effective] || NOTE[g.level] || '',
  };
}

// Oil vs pivot + the inflation-transmission flag.
export function oilRead(wti, pivot = 73.08) {
  if (wti?.price == null) return { label: 'no print', above: null };
  const above = wti.price > pivot;
  return {
    price: wti.price,
    above,
    label: above ? 'holding above pivot — inflation impulse building'
                 : "won't hold the pivot — no inflation breakout yet",
  };
}

// Direction arrow helper for formatting.
export const arrow = pct => pct == null ? '·' : pct > 0.15 ? '▲' : pct < -0.15 ? '▼' : '·';

// ── Korea-local stress gate ──────────────────────────────────────────────────
// A SEPARATE regime input from the global OAS gate. OAS answers "is this a world
// credit event?"; the Korea cluster answers "is the leveraged-memory forced-
// deleveraging spiral exhausting?" Never fold these into each other.

// USD/KRW — the won. RISING USDKRW = won weakening = foreign outflows (bad).
// FALLING/flat = outflows easing (stabilization). Day-over-day is the fast tell.
// 2-D: LEVEL against the 1,491 flip (tunable) × DIRECTION vs prior close. Interpretation is
// the point — a rising won on an equity selloff reads as flight, whereas a flat/falling won
// on the same selloff reads as a mechanical/domestic unwind. Direction requires a prior
// close; without one there is no direction word (never inferred from the level alone).
export function usdkrwRead(q, flip = KRW_FLIP) {
  if (!q || q.price == null) return { level: null, dir: null, flag: 'no print', regime: null };
  const lvl = q.price;
  const aboveFlip = lvl > flip;
  if (q.changePct == null || q.prevClose == null) {
    return { level: lvl, changePct: null, dir: null, flip, aboveFlip,
             regime: aboveFlip ? 'flight-zone' : 'mechanical-zone',
             flag: `${aboveFlip ? 'above' : 'below'} ${flip} — no prior close, direction unavailable`,
             delta: null, vs50d: null };
  }
  const d = q.changePct;
  const delta = +(lvl - q.prevClose).toFixed(2);
  const dir = d > 0.15 ? 'rising' : d < -0.15 ? 'falling' : 'flat';
  // Level decides the regime; direction qualifies it.
  const regime = aboveFlip ? 'flight-zone' : 'mechanical-zone';
  const flag = aboveFlip
    ? (dir === 'rising' ? `above ${flip} and weakening — flight` : `above ${flip} but not weakening — flight risk, unconfirmed`)
    : (dir === 'rising' ? `below ${flip}, weakening — watch the ${flip} flip` : `firm below ${flip} — consistent with mechanical/domestic unwind`);
  return {
    level: lvl, changePct: +d.toFixed(2), delta, dir, flip, aboveFlip, regime, flag,
    compound: `${lvl} ${dir ? `· ${dir.toUpperCase()}` : ''} (${delta >= 0 ? '+' : '−'}${Math.abs(delta)} 1d) · ${aboveFlip ? '>' : '<'}${flip}`,
    weakeningWon: dir === 'rising',
    vs50d: (q.ma50 != null) ? (lvl > q.ma50 ? 'above 50d' : 'below 50d') : null,
  };
}

// VKOSPI — KOSPI-200 implied vol, read off the tradeable FUTURES (VKI1!). Bands: calm
// ~15-20, elevated 30-40, panic 80+ (futures run a touch below spot in backwardation,
// so it tops out lower). A PEAK-AND-ROLL from extreme highs (elevated AND now falling)
// = fear exhausting. yrHigh is absent from the futures feed → nearYrHigh just stays false.
// 2-D on a scale calibrated to THIS instrument. VKOSPI futures sat ~15–25 through 2017–2025,
// so generic vol-index bands (calm<20 / panic>80) mislabel it — 30 is genuinely elevated here,
// not "normal". Bands: <25 normal · 25–35 elevated · 35–50 high · 50+ extreme (tunable).
// A trend word may NEVER contradict the measured direction: "exhausting" requires the level to
// be actually falling, so it cannot print on an up day or a circuit-breaker day.
export function vkospiRead(v) {
  if (!v || v.last == null) return { level: null, band: 'n/a', dir: null, rolling: null, flag: 'no print' };
  const x = v.last;
  const band = levelOf(x, VKOSPI_LEVELS);          // NORMAL | ELEVATED | HIGH | EXTREME
  const dir = v.changePct == null ? null : v.changePct > 0.5 ? 'rising' : v.changePct < -0.5 ? 'falling' : 'flat';
  const word = dir ? VKOSPI_WORDS[dir] : null;
  const elevated = x >= 35;                        // HIGH or EXTREME
  // "Rolling over" = elevated AND measurably falling. Both conditions required.
  const rolling = elevated && dir === 'falling';
  const nearYrHigh = v.yrHigh != null && x >= v.yrHigh * 0.9;

  let flag;
  if (dir == null)              flag = `${band.toLowerCase()} — no prior print, direction unavailable`;
  else if (rolling)             flag = 'elevated and rolling over — fear draining';
  else if (elevated && dir === 'rising') flag = nearYrHigh ? 'stress building (near 1y high)' : 'stress building';
  else if (dir === 'rising')    flag = `${band.toLowerCase()} but rising`;
  else if (dir === 'falling')   flag = `${band.toLowerCase()} and easing`;
  else                          flag = `${band.toLowerCase()}, flat`;

  const dPts = v.changePct != null && v.prevClose != null ? +(x - v.prevClose).toFixed(2) : null;
  return {
    level: +x.toFixed(2), band, dir, word,
    changePct: v.changePct != null ? +v.changePct.toFixed(2) : null,
    delta: dPts,
    compound: `${band}${word ? ` · ${word}` : ''}${v.changePct != null ? ` (${v.changePct >= 0 ? '+' : ''}${v.changePct.toFixed(2)}% 1d)` : ''}`,
    rolling, nearYrHigh, flag,
  };
}

// KRX trading-halt severity from the index move. Two DIFFERENT mechanisms, distinguished:
//   • Sidecar — programme-trading halt, triggered off the FUTURES moving ±5% for 1 min.
//   • Circuit breaker — index-wide halt: CB1 −8%, CB2 −15%, CB3 −20% (20 min; CB3 ends trading).
// We can derive CB level from the index print; sidecar needs the futures move, so it is only
// asserted when a futures change is supplied — never inferred from the cash index.
// `k200ChangePct` (KOSPI-200 CASH) is accepted only as an explicitly-labelled PROXY: it
// populates `sidecarProxy`, never `sidecar`. A confirmed sidecar still requires the real
// futures move, so the cash index can never masquerade as one.
//
// VERIFIED 2026-07-28 — why `sidecar` is still unreachable even WITH broker access:
// the K200 front-month future (202609, IBKR contract 813874122 @ KSE) was pulled twice
// ~40s apart during the KRX session. The feed MOVES (ts +44s, 958.20 → 956.95, volume
// +100 lots), so it is not frozen — but the lag vs wall clock was identical on both pulls
// (20.3 min each time). A CONSTANT offset is a delayed entitlement, not a live feed, and a
// 20-minute-old print cannot confirm a real-time ±5% trigger. It therefore stays a proxy.
// Separately, IBKR has no stateless API-key auth, so a Vercel serverless function cannot
// hold the session at all (see MACRO_BUILD_HANDOFF.md — needs a gateway or OAuth bridge).
export function krxHaltSeverity(indexChangePct, futuresChangePct = null, k200ChangePct = null) {
  const out = { circuitBreaker: null, sidecar: null, sidecarProxy: null, fired: [], note: null };
  if (indexChangePct != null) {
    if (indexChangePct <= -20)      out.circuitBreaker = 'CB3 (−20%) — trading halted for the day';
    else if (indexChangePct <= -15) out.circuitBreaker = 'CB2 (−15%) — 20-minute halt';
    else if (indexChangePct <= -8)  out.circuitBreaker = 'CB1 (−8%) — 20-minute halt';
  }
  if (futuresChangePct != null && Math.abs(futuresChangePct) >= 5) {
    out.sidecar = `Sidecar (futures ${futuresChangePct >= 0 ? '+' : ''}${futuresChangePct.toFixed(1)}%) — programme trading halted 5 min`;
  } else if (futuresChangePct == null) {
    out.note = 'sidecar unconfirmed — KOSPI-200 futures unavailable on the keyless feeds; '
             + 'broker futures feed verified 2026-07-28 as ~20-min delayed, so it cannot confirm a real-time ±5% trigger either';
    if (k200ChangePct != null && Math.abs(k200ChangePct) >= 5) {
      out.sidecarProxy = `Sidecar LIKELY (K200 cash ${k200ChangePct >= 0 ? '+' : ''}${k200ChangePct.toFixed(1)}%, proxy — futures not available)`;
    }
  }
  if (out.circuitBreaker) out.fired.push(out.circuitBreaker);
  if (out.sidecar) out.fired.push(out.sidecar);
  if (out.sidecarProxy) out.fired.push(out.sidecarProxy);
  return out;
}

// The Korea washout-exhausting cluster: won stops weakening AND VKOSPI peaks & rolls.
// Distinct from creditState — this is the Korea-LOCAL gate. (CSOP 7709 units, the old
// third leg, were retired — no reliable keyless source.)
export function koreaStress(korea) {
  const won = usdkrwRead(korea?.usdkrw);
  const vol = vkospiRead(korea?.vkospi);
  const halt = krxHaltSeverity(korea?.kospiChangePct ?? null, korea?.futuresChangePct ?? null, korea?.kospi200ChangePct ?? null);

  const legs = {
    wonStabilizing:  won.dir === 'falling' || won.dir === 'flat',
    vkospiRolling:   vol.rolling === true,
  };

  // Both legs need a measured direction before any exhaustion claim. Without priors we say so
  // rather than defaulting to a cluster word.
  const haveDirection = won.dir != null && vol.dir != null;
  const stillStressed = won.weakeningWon || vol.band === 'EXTREME' || vol.band === 'HIGH';

  let cluster, note;
  if (!haveDirection) {
    cluster = 'unknown';
    note = 'Korea gate — no prior print on ' + [won.dir == null ? 'USD/KRW' : null, vol.dir == null ? 'VKOSPI' : null].filter(Boolean).join(' + ') + '; direction unavailable';
  } else if (halt.circuitBreaker) {
    // A halt day is never "exhausting", regardless of what the vol print did.
    cluster = 'active';
    note = `Korea halt fired — ${halt.circuitBreaker}`;
  } else if (legs.wonStabilizing && legs.vkospiRolling) {
    cluster = 'exhausting';
    note = `Korea washout draining — won ${won.dir} (${won.delta >= 0 ? '+' : '−'}${Math.abs(won.delta ?? 0)} 1d), VKOSPI ${vol.band} rolling over (${vol.changePct}% 1d)`;
  } else if (stillStressed) {
    cluster = 'active';
    note = `Korea stress active — ${won.flag}; VKOSPI ${vol.band} ${vol.word ? vol.word.toLowerCase() : ''}`.trim();
  } else {
    cluster = 'mixed';
    note = 'Korea stress mixed — no clean cluster; ' + won.flag;
  }

  return { gate: 'korea-local', cluster, note, legs, won, vol, halt, regime: won.regime };
}

// Roll everything into one regime object the generator consumes. `korea` is the
// Asia-only local gate; null for EU/US. It sits ALONGSIDE credit (the global OAS
// gate), never merged into it.
export function computeRegime({ quotes, names, macro, korea }) {
  // Staleness gate: a regime label computed from prior-close prints while that market is OPEN
  // is a confident WRONG conclusion (2026-07-23: EU regime read green off Wed closes while
  // STMicro was -15.2% intraday). If ANY constituent is stale-while-open, flag the equity
  // axes so the UI suppresses their labels rather than publishing a stale read.
  const staleWhileOpen = quotes.some(q => freshness(q.sym, q).state === 'stale');

  const split  = memoryVsFoundry(quotes, names);
  const aiAxis = aiLeveredVsNon(quotes, names);
  if (staleWhileOpen) { split.stale = true; aiAxis.stale = true; }

  return {
    split,                                     // Memory vs Foundry
    aiAxis,                                    // AI-levered vs non-AI (second axis)
    staleWhileOpen,                            // true → equity-derived reads are unreliable now
    credit: creditState(macro?.oas?.value, macro?.oas?.series),  // GLOBAL gate — 2-D (level × direction)
    oil:    oilRead(macro?.wti),
    us2y:   macro?.us2y?.value ?? null,
    korea:  korea ? koreaStress(korea) : null, // KOREA-LOCAL gate — deleveraging exhausting?
  };
}
