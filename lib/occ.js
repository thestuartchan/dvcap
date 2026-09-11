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

// ── A STORED LIST GOES STALE ONE DATE AT A TIME ──────────────────────────────
// The stored capture's expiry list is replayed so the recompute is like-for-like with the rung
// below it. But a list captured yesterday names yesterday's dates, and an expiry that has passed
// is not a like-for-like anything — it contributes nothing and takes a slot.
//
// Measured 2026-09-11 16:04Z: the settled QQQ recompute ran on `2026-09-10, 2026-09-11, 2026-09-14,
// 2026-09-18, 2026-10-16, 2026-12-18` — six dates, one of them already expired, so the map was
// drawn over FIVE and the front expiry's share was a share of five. The denominator shrank without
// the number that reports it changing its wording.
//
// So a replayed list is pruned of dates that have gone and topped back up from what is actually
// listed, by the same shape rule that built it. The sample stays the size it was meant to be.
export function refreshExpiries(stored = [], available = [], now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const live = [...new Set(stored)].filter(d => d >= today).sort();
  const want = defaultExpiries(available, now);
  // Topped up in the DEFAULT order — nearest first, then each horizon — so what comes back is the
  // set that rule would have chosen, not whatever happens to sort first.
  for (const d of want) { if (live.length >= want.length) break; if (!live.includes(d)) live.push(d); }
  return { expiries: live.sort(), dropped: [...new Set(stored)].filter(d => d < today).sort() };
}

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

// ── KNOWING WHETHER THE FILE HAS ROLLED, WITHOUT TRUSTING A CLOCK ────────────
// "Pull at 08:00 UTC" is only as good as the measurement behind it, and a measurement is a fact
// about one day. OCC could shift its publication by an hour and nothing in a scheduled fetch would
// notice — it would simply serve the previous session's positioning under today's date, which is
// the exact failure the whole rung was built to escape.
//
// So the file says whether it rolled, by remembering what it looked like last time. The fingerprint
// is the row count and the total open interest: OCC republishes the entire series list at each
// settlement, so a byte-identical total across a settlement boundary means it has not published.
// Measured 2026-09-10: 12,720,040 at 22:42Z became 12,893,337 by 01:10Z and then did not move one
// series through 10:20Z — nine hours identical inside a session, and a clean change across the roll.
//
// THE TEST IS AGAINST THE MARKET'S OWN BOUNDARY, not against an hour. A settlement covers the
// session that has just closed, so the question is whether this fingerprint was first seen AFTER
// the most recent close. That is true of a file published overnight and false of one that has not
// rolled yet, whatever time it is asked.
export const US_CLOSE_UTC_HOUR = 20;   // 16:00 ET; the settlement covers the session ending here

// ── A CHANGED FILE IS NOT NECESSARILY A FINISHED ONE ─────────────────────────
// The roll was observed through a 2h28m gap — 12,720,040 at 22:42Z, 12,893,337 by 01:10Z, nothing
// in between. That says the file changed. It does NOT say the change was atomic, and if OCC writes
// the series list progressively then a fetch landing mid-write returns a real, parseable, PARTIAL
// book: fewer contracts, less open interest, and walls drawn from whatever had been written so far.
// That is a worse failure than a stale file, because a stale one is at least internally consistent.
//
// Two independent guards, because neither is sufficient alone:
//
//   1. STABILITY. A file still being written changes between fetches. A fingerprint that has held
//      for this long is complete or nothing observable distinguishes it from complete.
//   2. SIZE AGAINST THE LAST KNOWN-GOOD VINTAGE. A partial write is SMALLER. A file whose row count
//      has collapsed against the last complete one is suspect however stable it looks — and this
//      catches the case where a partial write is fetched twice and looks settled.
//
// The coverage floor in mergeOccIv is a third, from a different direction: it measures what share
// of CBOE's in-band book OCC also lists, so a half-written file fails it regardless of these two.
export const OCC_CONFIRM_MIN = 20;      // minutes a fingerprint must hold before it counts as settled
export const OCC_SHRINK_TOL = 0.10;     // row count may fall this far vs the last vintage (expiries roll off)

export function occFingerprint(parsed) {
  if (!parsed) return null;
  return `${parsed.rows}:${parsed.totalOi}`;
}

// The most recent US equity close at or before `now`, as an instant. Weekends walk back to Friday:
// a Saturday fetch is still describing Friday's settlement.
export function priorUsClose(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), US_CLOSE_UTC_HOUR, 0, 0));
  if (d > now) d.setUTCDate(d.getUTCDate() - 1);
  // Sunday (0) and Saturday (6) have no close of their own.
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

// `seen` is what was stored last time: { fingerprint, firstSeenAt }. Returns the same shape updated,
// plus the verdict. A first-ever fetch cannot know when the file rolled and says so rather than
// assuming it just did.
export function occVintage(parsed, seen = null, now = new Date()) {
  const fp = occFingerprint(parsed);
  if (!fp) return null;
  const changed = !seen?.fingerprint || seen.fingerprint !== fp;
  const firstSeenAt = changed ? now.toISOString() : seen.firstSeenAt;
  const close = priorUsClose(now);
  // Unknown, not true. On a first fetch there is no evidence the file rolled, and treating absence
  // of evidence as a pass is how a stale book gets drawn as a current one.
  const rolledSinceClose = (changed && !seen?.fingerprint) ? null
    : (Date.parse(firstSeenAt) >= close.getTime());
  const unchangedMin = (now - Date.parse(firstSeenAt)) / 60000;
  // Held long enough to be taken as finished. A first observation is never confirmed: it has been
  // stable for zero minutes by definition, and there is nothing to compare it against.
  const confirmed = !!seen?.fingerprint && unchangedMin >= OCC_CONFIRM_MIN;
  // A partial write is SMALLER. Expiries roll off legitimately, so a tolerance — but a collapse is
  // a collapse. null when there is no prior size to judge against.
  const priorRows = seen?.rows ?? null;
  const shrank = priorRows ? (parsed.rows < priorRows * (1 - OCC_SHRINK_TOL)) : null;

  return {
    fingerprint: fp, firstSeenAt, changed, rows: parsed.rows,
    priorClose: close.toISOString(),
    rolledSinceClose,
    unchangedHours: +(unchangedMin / 60).toFixed(2), unchangedMin: Math.round(unchangedMin),
    confirmed, shrank, priorRows,
    // COMPLETE means: it rolled after the close, it has held still, and it did not shrink. Any of
    // the three unknown leaves this null rather than true — the whole point is that absence of
    // evidence is not evidence.
    complete: (rolledSinceClose === true && confirmed && shrank === false) ? true
            : (rolledSinceClose === false || shrank === true) ? false : null,
    note: rolledSinceClose === null ? 'first observation — no prior fingerprint to compare against'
        : rolledSinceClose === false ? `NOT rolled since the ${close.toISOString().slice(0, 10)} close — this is the previous session's book`
        : shrank ? `rolled, but ${parsed.rows} rows against ${priorRows} last time — too small, possibly a partial write`
        : !confirmed ? `rolled, but only ${Math.round(unchangedMin)}min old — not yet held long enough to call finished`
        : `settled after the ${close.toISOString().slice(0, 10)} close, stable ${(unchangedMin / 60).toFixed(1)}h`,
  };
}
