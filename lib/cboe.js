// lib/cboe.js — the SECOND OPINION, and the only one in this project that is genuinely independent.
//
// WHY THIS EXISTS. Eight defects have been found in the gamma panel so far and not one of them was
// found by a test. Every single one was found by looking at production output and noticing it
// disagreed with something — the stored data, the panel's own table, or a screenshot of a
// commercial GEX provider. The tests were written afterwards and have held, but they are a record
// of what we already learned rather than a way of learning anything new.
//
// The check that actually did the finding was "compare our number to somebody else's at the same
// moment", performed by hand, irregularly, and only when someone happened to look. This automates
// exactly that and nothing more.
//
// WHY CBOE AND NOT ANOTHER VENDOR. A second vendor of the same Yahoo-shaped data would only catch
// transport failures. CBOE publishes the exchange's OWN open interest, its OWN implied vols, and —
// the part that matters — its OWN per-contract gamma. So the walls computed here go from their
// data through their model, touching no line of lib/blackscholes.js. When our walls and these
// walls agree, that is two independent chains and two independent greeks agreeing, which is a real
// statement. It is also free and needs no key: one public CDN endpoint, no auth, no quota.
//
// WHAT IS AND IS NOT INDEPENDENT — stated up front because a cross-check that overstates its own
// independence is worse than none:
//
//   spot          fully independent (their quote)
//   open interest fully independent (the exchange's own book)
//   implied vol   fully independent (their surface)
//   walls         fully independent — THEIR gamma, THEIR OI, none of our maths
//   flip          NOT independent. Solving a flip means repricing gamma at hypothetical spots, and
//                 their published gamma is a single number fixed at the current spot. A flip from
//                 this data would be their inputs through OUR Black-Scholes. That is worth
//                 something, but it is not the same claim, so it is not computed here at all.
//
// OPEN INTEREST DOES NOT MOVE INTRADAY, which is what makes this comparison sound despite the two
// snapshots never being simultaneous. OI settles overnight and is static all session, so a chain
// read a minute apart is the same chain. Spot is the one figure a time gap genuinely moves, so the
// spot delta is reported descriptively and never counted as a disagreement.
import { CONTRACT_MULTIPLIER } from './gex.js';

export const CBOE_URL = (symbol) => `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(symbol)}.json`;
export const CBOE_TIMEOUT_MS = 20000;

// The OSI contract symbol: root, YYMMDD, C|P, then the strike in thousandths on 8 digits.
// e.g. QQQ260909C00490000 → 2026-09-09 call at 490. The root is variable length (QQQ, SPXW), so it
// is matched greedily as letters rather than assumed to be three characters.
export const OSI_RE = /^([A-Z]+)(\d{6})([CP])(\d{8})$/;

export function parseOsi(sym) {
  const m = OSI_RE.exec(String(sym || '').trim());
  if (!m) return null;
  const [, root, ymd, cp, strike] = m;
  const expiry = `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`;
  // A parse that yields an impossible date is a parse failure, not a contract on the 47th.
  const d = new Date(`${expiry}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== expiry) return null;
  const k = +strike / 1000;
  if (!(k > 0)) return null;
  return { root, expiry, type: cp === 'C' ? 'call' : 'put', strike: k };
}

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// CBOE stamps "YYYY-MM-DD HH:MM:SS" with no zone. Measured against the wall clock on 2026-09-09 it
// ran 106 seconds behind UTC, so it is read as UTC. If that is ever wrong the error shows up as a
// constant hours-wide age on the panel rather than as a silently wrong number.
export function cboeAsOf(ts) {
  const s = String(ts || '').trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return null;
  return `${s.replace(' ', 'T')}Z`;
}

// The payload → the same six fields lib/gex.js works in. Trimmed to the expiries and the strike
// band the other side actually used, because a comparison across two different universes measures
// the universes.
export function parseCboe(json, { expiries = null, bandPct = 10 } = {}) {
  const spot = num(json?.data?.current_price);
  const raw = Array.isArray(json?.data?.options) ? json.data.options : [];
  if (spot == null || !raw.length) return null;
  const want = expiries && expiries.length ? new Set(expiries) : null;
  const lo = spot * (1 - bandPct / 100), hi = spot * (1 + bandPct / 100);

  const contracts = [];
  let seen = 0, inBand = 0, unparsed = 0;
  for (const o of raw) {
    const p = parseOsi(o?.option);
    if (!p) { unparsed++; continue; }
    seen++;
    if (want && !want.has(p.expiry)) continue;
    if (p.strike < lo || p.strike > hi) continue;
    inBand++;
    const oi = num(o?.open_interest);
    // Zero open interest carries no gamma exposure by construction. Dropped, exactly as the Yahoo
    // side drops it, so the contract counts are comparable.
    if (!(oi > 0)) continue;
    contracts.push({
      expiry: p.expiry, type: p.type, strike: p.strike, oi,
      iv: num(o?.iv), gamma: num(o?.gamma),
    });
  }
  return { spot, asOf: cboeAsOf(json?.timestamp), contracts, seen, inBand, withOi: contracts.length, unparsed };
}

export async function fetchCboeChain(symbol, { expiries = null, bandPct = 10, timeoutMs = CBOE_TIMEOUT_MS } = {}) {
  try {
    const r = await fetch(CBOE_URL(symbol), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, reason: `CBOE answered ${r.status}` };
    const parsed = parseCboe(await r.json(), { expiries, bandPct });
    if (!parsed) return { ok: false, reason: 'CBOE payload had no spot or no contracts' };
    if (!parsed.contracts.length) return { ok: false, reason: 'no CBOE contracts survived the expiry and strike filter' };
    return { ok: true, ...parsed };
  } catch (e) {
    // Never fatal. This is a second opinion; losing it costs the comparison, not the capture.
    return { ok: false, reason: `CBOE fetch failed — ${String(e?.message || e)}` };
  }
}

// Dollar gamma per 1% move, from THEIR gamma and THEIR open interest. The formula matches
// toDollarGex in lib/gex.js — gamma x OI x multiplier x S^2 x 1% — but the gamma going into it was
// computed by CBOE, not here, which is the whole point.
export function cboeSummary(contracts = [], spot) {
  const s = num(spot);
  if (s == null || !contracts.length) return null;
  const scale = CONTRACT_MULTIPLIER * s * s * 0.01;
  const byStrike = new Map();
  let callOi = 0, putOi = 0, ivNum = 0, ivDen = 0, priced = 0;
  for (const c of contracts) {
    const g = num(c.gamma), oi = num(c.oi), k = num(c.strike);
    if (c.type === 'call') callOi += oi ?? 0; else putOi += oi ?? 0;
    const iv = num(c.iv);
    if (iv != null && iv > 0 && oi > 0) { ivNum += iv * oi; ivDen += oi; }
    if (g == null || oi == null || k == null) continue;
    priced++;
    const row = byStrike.get(k) || { strike: k, call: 0, put: 0 };
    const dollars = g * oi * scale;
    if (c.type === 'call') row.call += dollars; else row.put += dollars;
    byStrike.set(k, row);
  }
  const rows = [...byStrike.values()].sort((a, b) => a.strike - b.strike)
    .map(r => ({ ...r, netGexUsd: r.call - r.put }));
  if (!rows.length) return null;
  // The heaviest strike each side, which is what "wall" means on the other side of the comparison
  // too — same definition, so a mismatch is a real mismatch rather than a definitional one.
  const heaviest = (key) => rows.reduce((a, b) => (b[key] > a[key] ? b : a)).strike;
  return {
    callWall: heaviest('call'), putWall: heaviest('put'),
    netGexUsd: rows.reduce((a, r) => a + r.netGexUsd, 0),
    callOi, putOi, contracts: contracts.length, priced,
    oiWeightedIv: ivDen > 0 ? +(ivNum / ivDen).toFixed(4) : null,
    byStrike: rows,
  };
}

// ── WHAT COUNTS AS AGREEMENT ─────────────────────────────────────────────────
// Three states, not two. "Differs" and "differs by a strike" are not the same finding: the walls
// disagreed by 17 points on 2026-09-08 because our vol surface was broken, and by nothing at all
// on 2026-09-09 once it healed. A binary pass/fail would have called a one-strike rounding
// difference the same event as that, and a check that cries wolf gets ignored, which costs more
// than not having it.
//
// The tolerances are deliberately loose. This is a tripwire for the class of failure that has
// actually happened here — a wall in the wrong place by tens of points, open interest an order of
// magnitude out, a vol surface at a third of its true level — and not an attempt to reconcile two
// vendors to the basis point. Two feeds will never agree exactly and a check that demands it will
// be switched off within a week.
export const TOL = Object.freeze({
  wallNearPct: 0.5,    // within 0.5% of spot — a strike or two apart on a $700 name
  oiPct: 10,           // 10% on total open interest; vendors clean and stamp differently
  ivPts: 5,            // 5 percentage points of implied vol
  spotPct: 0.5,        // reported, never scored: the snapshots are minutes apart by construction
});

const pctOf = (a, b) => (b ? Math.abs(a - b) / Math.abs(b) * 100 : null);

// One comparison line. `score:false` marks a figure that is reported for context but must never
// contribute to a verdict — the spot, whose difference is a clock, not an error.
function check(name, ours, theirs, { state, detail, score = true }) {
  return { name, ours, theirs, state, detail, score };
}

export function compareGex(ours, theirs, { spot = null, tol = TOL } = {}) {
  if (!ours || !theirs) return { ok: false, reason: 'nothing to compare', checks: [], agree: 0, scored: 0 };
  const s = num(spot) ?? num(ours.spot);
  const checks = [];

  const wall = (name, a, b) => {
    if (a == null || b == null) return check(name, a, b, { state: 'unknown', detail: 'one side did not solve it' });
    if (a === b) return check(name, a, b, { state: 'match', detail: 'same strike' });
    const gap = Math.abs(a - b);
    const gapPct = s ? (gap / s) * 100 : null;
    const near = gapPct != null && gapPct <= tol.wallNearPct;
    return check(name, a, b, {
      state: near ? 'near' : 'differ',
      detail: `${gap.toFixed(2)} apart${gapPct != null ? ` (${gapPct.toFixed(2)}% of spot)` : ''}`,
    });
  };
  checks.push(wall('call wall', num(ours.callWall), num(theirs.callWall)));
  checks.push(wall('put wall', num(ours.putWall), num(theirs.putWall)));

  const within = (name, a, b, limit, unit, fmt = (v) => v) => {
    if (a == null || b == null) return check(name, a, b, { state: 'unknown', detail: 'one side is missing' });
    const d = unit === 'pct' ? pctOf(a, b) : Math.abs(a - b);
    const shown = unit === 'pct' ? `${d.toFixed(1)}% apart` : `${d.toFixed(1)} pts apart`;
    return check(name, fmt(a), fmt(b), { state: d <= limit ? 'match' : 'differ', detail: shown });
  };
  checks.push(within('call OI', num(ours.callOi), num(theirs.callOi), tol.oiPct, 'pct'));
  checks.push(within('put OI', num(ours.putOi), num(theirs.putOi), tol.oiPct, 'pct'));
  checks.push(within('OI-weighted IV',
    ours.oiWeightedIv == null ? null : +(ours.oiWeightedIv * 100).toFixed(1),
    theirs.oiWeightedIv == null ? null : +(theirs.oiWeightedIv * 100).toFixed(1),
    tol.ivPts, 'pts'));

  // Context only. Two chains fetched a minute or two apart cannot have the same spot, and treating
  // that as a failure would make the check fire every day for the one reason that is not a defect.
  const os = num(ours.spot), ts = num(theirs.spot);
  const sd = (os != null && ts != null) ? pctOf(os, ts) : null;
  checks.push(check('spot', os, ts, {
    state: 'context',
    score: false,
    detail: sd == null ? 'one side is missing'
      : `${Math.abs(os - ts).toFixed(2)} apart (${sd.toFixed(2)}%) — the snapshots are minutes apart, so this is a clock, not a disagreement`,
  }));

  const scored = checks.filter(c => c.score && c.state !== 'unknown');
  const agree = scored.filter(c => c.state === 'match' || c.state === 'near').length;
  const differ = scored.filter(c => c.state === 'differ');
  return {
    ok: true, checks, agree, scored: scored.length,
    // The verdict names the WALLS specifically when they are what broke, because they are the
    // output a trade is placed against and the rest is diagnosis.
    verdict: scored.length === 0 ? 'nothing could be scored'
      : differ.length === 0 ? `agrees with CBOE on all ${scored.length} checks`
        : `disagrees with CBOE on ${differ.map(c => c.name).join(', ')}`,
    clean: scored.length > 0 && differ.length === 0,
  };
}
