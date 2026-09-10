// lib/occ.js — settled open interest, from the clearing house that settles it.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// A gamma map is open interest × gamma. The gamma half we compute ourselves and can compute at any
// spot; the open-interest half has to come from somewhere, and every source we had was wrong in the
// hour the map is actually read.
//
// YAHOO serves no open interest at all before the US open — measured 2026-09-02 at 09:30 UTC: 209
// contracts, 922,440 of volume, and zero OI on every one of them. So the morning capture fails and
// the panel falls back to repricing the PREVIOUS session's stored chain, which is yesterday's
// positioning wearing today's spot.
//
// CBOE publishes open interest, implied vol and its own per-contract gamma, keyless, in under a
// second — and its open interest is a settlement behind at the hour that matters. Measured
// 2026-09-10 at 01:30 UTC against OCC on the same 10,170 QQQ series: 3,477 of them disagreed, OCC
// net +621,592 contracts, and the gap was spread across EVERY expiry rather than concentrated in
// the one that had just expired. The clincher was the following day's expiry — CBOE 111,953 against
// OCC 227,301, roughly double, which is what the prior session's trading had built. 2,299 series
// higher on OCC and 1,178 lower is the signature of one settlement newer, not of one being broken.
//
// An earlier check of ours found CBOE and OCC in exact agreement and recorded that as a property of
// the two sources. It was a property of the HOUR it ran in.
//
// ── SO: OCC FOR THE POSITIONS, CBOE FOR THE SURFACE ──────────────────────────
// OCC publishes what it settled and no greeks at all. CBOE publishes a live implied-vol surface.
// Neither is sufficient and together they are exactly right: OCC's open interest, CBOE's implied
// vol, our own spot, and gamma recomputed here at that spot through the same Black-Scholes path
// every other rung uses.
//
// ── WHEN IT PUBLISHES ────────────────────────────────────────────────────────
// Measured on 2026-09-10: the file moved from 12,720,040 contracts at 22:42 UTC to 12,893,337 by
// 01:10 UTC, then did not change one series through 08:48 UTC — seven and a half hours flat. So the
// settlement lands overnight, well before any pre-read fires, and is stable all morning. The US
// brief (13:00 UTC) and the European one (08:00 UTC) both read a file that settled hours earlier.
// The Asia brief at 23:00 UTC sits inside the publication window and must not assume it.
//
// ── THE FORMAT ───────────────────────────────────────────────────────────────
// Tab-separated, one row per STRIKE carrying both legs:
//   QQQ<tab><tab>2026<tab>09<tab>09<tab>490<tab>000<tab>C P <tab>0<tab>31<tab>180000000
//   root      (blank)  year month day  strike-int strike-dec  which  callOI putOI  poslimit
// The strike is integer + thousandths, so 490 + 000 is 490.000 and 631 + 500 would be 631.50.
//
// THE ROOT IS MATCHED EXACTLY. The SPY file also carries `2SPY` — adjusted series from a corporate
// action, a different deliverable and a different contract. Folding those into SPY's open interest
// would inflate it with positions that are not on the underlying at all.

export const OCC_URL = (symbol) =>
  `https://marketdata.theocc.com/series-search?symbolType=U&symbol=${encodeURIComponent(symbol)}`;
export const OCC_TIMEOUT_MS = 8000;

const int = (v) => { const n = Number.parseInt(String(v).trim(), 10); return Number.isFinite(n) ? n : null; };

// Key on the three things that identify a contract, in the same units lib/gex.js works in.
export const occKey = (expiry, type, strike) => `${expiry}|${type}|${strike}`;

export function parseOccSeries(text, root) {
  const want = String(root || '').trim().toUpperCase();
  if (!want) return null;
  const oi = new Map();
  let rows = 0, skippedRoot = 0, totalOi = 0;
  const expiries = new Set();

  for (const line of String(text || '').split('\n')) {
    const parts = line.replace(/\r/g, '').split('\t');
    if (parts.length < 9) continue;
    const sym = parts[0].trim().toUpperCase();
    if (!sym) continue;
    // Columns after the root, with the blank second column dropped.
    const f = parts.slice(1).filter(x => x !== '');
    if (f.length < 8) continue;
    const [yy, mm, dd, si, sd, , c, p] = f;
    const year = int(yy), month = int(mm), day = int(dd);
    if (year == null || month == null || day == null) continue;   // header and prose lines
    if (sym !== want) { skippedRoot++; continue; }                // 2SPY and other adjusted series

    const whole = int(si), frac = int(sd);
    if (whole == null || frac == null) continue;
    const strike = +(whole + frac / 1000).toFixed(3);
    if (!(strike > 0)) continue;

    const expiry = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const callOi = int(c) ?? 0, putOi = int(p) ?? 0;
    // A strike with no open interest on either side carries no gamma exposure by construction, and
    // dropping it here keeps the contract counts comparable with every other rung.
    if (callOi > 0) oi.set(occKey(expiry, 'call', strike), callOi);
    if (putOi > 0) oi.set(occKey(expiry, 'put', strike), putOi);
    if (callOi > 0 || putOi > 0) expiries.add(expiry);
    totalOi += callOi + putOi;
    rows++;
  }
  if (!rows) return null;
  return { oi, rows, skippedRoot, totalOi, expiries: [...expiries].sort() };
}

export async function fetchOccOi(symbol, { timeoutMs = OCC_TIMEOUT_MS } = {}) {
  try {
    const r = await fetch(OCC_URL(symbol), {
      headers: { Accept: 'text/plain', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, reason: `OCC answered ${r.status}` };
    const parsed = parseOccSeries(await r.text(), symbol);
    if (!parsed) return { ok: false, reason: 'OCC payload had no parseable series rows' };
    return { ok: true, ...parsed };
  } catch (e) {
    // Never fatal. Losing this costs the top rung, not the map — gexStore falls to `repriced`.
    return { ok: false, reason: `OCC fetch failed — ${String(e?.message || e)}` };
  }
}

// ── THE MERGE ────────────────────────────────────────────────────────────────
// OCC's open interest onto CBOE's implied vol. The IV is what CBOE published; the OI replaces
// CBOE's own, which is the entire point.
//
// COVERAGE IS REPORTED, NOT ASSUMED. A contract CBOE prices and OCC does not list, or the reverse,
// is a real disagreement about what exists, and the caller decides whether what survived is enough
// to draw a map from. Silently intersecting two universes and reporting the result as complete is
// how a map ends up describing a book that is not the book.
export const MIN_OCC_COVERAGE = 0.80;   // share of CBOE's in-band OI that OCC also lists

export function mergeOccIv(occ, cboeContracts = []) {
  if (!occ?.oi?.size) return null;
  const out = [];
  let matched = 0, missingFromOcc = 0, noIv = 0;
  // THREE TOTALS, NOT TWO. The first version divided OCC's open interest on the MATCHED contracts
  // by CBOE's across ALL of them and called it coverage, which came out at 109% — a coverage figure
  // above one is a sign the ratio is measuring two different things at once. It was: how much of
  // the book survived the join, and how much bigger the newer settlement is. Those are separate
  // questions and each is worth an answer.
  let cboeOi = 0, matchedCboeOi = 0, occOi = 0;

  for (const c of cboeContracts) {
    if (!c || !(c.strike > 0) || !c.expiry || !c.type) continue;
    cboeOi += c.oi ?? 0;
    const settled = occ.oi.get(occKey(c.expiry, c.type, c.strike));
    if (settled == null) { missingFromOcc++; continue; }
    // No implied vol means no gamma can be computed here. CBOE's own gamma is not substituted:
    // it was computed at CBOE's spot, and the whole reason for this rung is to recompute at ours.
    if (!(c.iv > 0)) { noIv++; continue; }
    matched++; occOi += settled; matchedCboeOi += c.oi ?? 0;
    out.push({ expiry: c.expiry, type: c.type, strike: c.strike, oi: settled, iv: c.iv });
  }
  return {
    contracts: out, matched, missingFromOcc, noIv,
    cboeOi, matchedCboeOi, occOi,
    // HOW MUCH OF THE BOOK SURVIVED THE JOIN. Measured on open interest rather than on contract
    // count: a thousand empty far-dated strikes going missing matters far less than one
    // at-the-money strike, and counting rows says otherwise. Bounded by one by construction.
    coverage: cboeOi > 0 ? +(matchedCboeOi / cboeOi).toFixed(4) : null,
    // HOW MUCH NEWER THE SETTLEMENT IS, like for like on the contracts that joined. This is the
    // disagreement the rung exists to resolve, so it is carried rather than absorbed.
    oiDeltaVsCboe: occOi - matchedCboeOi,
  };
}

// ── WHICH EXPIRIES ───────────────────────────────────────────────────────────
// The full listed book is ~3,240 contracts inside a 10% band, against the ~1,020 the daily capture
// stores. That is not a free improvement: gexSummary solves the flip six times over a 400-step spot
// scan, so its cost is linear in contracts, and the full book took it from 2.2s to 6.8s — most of
// a Hobby function's ten-second budget, for one symbol of two.
//
// Worse, it would not be comparing like with like. The stored capture keeps six expiries — the next
// three dailies, the front monthly, and two further out — and a map drawn over a different universe
// cannot be checked against the one below it in the cascade. lib/cboe.js already makes this point
// about its own cross-check: "a comparison across two different universes measures the universes".
//
// So the caller passes the stored row's expiries and gets a like-for-like replacement. Where there
// is no stored row this reproduces the same SHAPE from whatever is listed, rather than falling back
// to everything.
export const DEFAULT_HORIZON_DAYS = [7, 30, 90];
export const DEFAULT_NEAR_COUNT = 3;

export function defaultExpiries(available = [], now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const live = [...new Set(available)].filter(d => d >= today).sort();
  if (!live.length) return [];
  const picked = new Set(live.slice(0, DEFAULT_NEAR_COUNT));
  const dayOf = (d) => Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 864e5);
  // The nearest expiry at or beyond each horizon — the front monthly and the two after it, without
  // needing to know which dates are monthlies.
  for (const h of DEFAULT_HORIZON_DAYS) {
    const hit = live.find(d => dayOf(d) >= h);
    if (hit) picked.add(hit);
  }
  return [...picked].sort();
}
