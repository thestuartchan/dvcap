// lib/optionsChain.js — fetch, parse and trim an option chain from Yahoo's keyless endpoint.
//
// WHY THIS IS STORED AND PRICE BARS ARE NOT. Open interest cannot be re-fetched. Yahoo and OCC
// serve today's snapshot and nothing else, so a day not captured is gone permanently — and the
// signal being built is day-over-day ΔOI, which is precisely the thing a snapshot cannot give you
// later. Daily OHLC is the opposite: re-derivable from any provider on demand, which is why that
// cache was cut and this one is not.
//
// Same origin and the same manners as the rest of the Yahoo client: an 8s AbortSignal, and a
// 120ms stagger between calls because the keyless endpoint refuses a burst.

import { yahooAuth } from './yahoo.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const BASE = 'https://query1.finance.yahoo.com/v7/finance/options';

export const STRIKE_BAND_PCT = 10;   // beyond ±10% of spot gamma is negligible — see the atr tests
export const FETCH_GAP_MS = 120;

// ── THE IMPLIED-VOL SENTINEL ────────────────────────────────────────────────
// Yahoo does not return null when it cannot solve an implied vol. It returns 1e-5, which is a
// number, is greater than zero, and passes any "is it present" check. Gamma goes as 1/sigma, so
// on a real QQQ chain those contracts price at a gamma of ~1073 against ~0.07 for a genuine 15%
// vol — fifteen thousand times larger. Measured on a live chain, 32 of 200 contracts carrying
// open interest had it: sixteen percent of the book, each one able to swamp the aggregate and
// invent a wall at whatever strike it happened to sit on.
//
// So implausible vols are REJECTED AND COUNTED, not merely allowed through because they are
// positive. The observed plausible range on that chain was 0.0515 to 2.125; the band below is
// wide enough to keep every real quote and exclude the sentinel by three orders of magnitude.
export const MIN_IV = 0.03;    // 3% — below the 5.15% floor seen on a healthy chain, above the junk
export const MAX_IV = 5.0;     // 500% — above this it is a data error, not a quote

// ── THE SENTINEL IS NOT THE ONLY WAY THE VOL FIELD BREAKS ───────────────────
// A per-contract band cannot catch this one, because each value is individually plausible.
// Measured on QQQ at 13:40 UTC on 2026-09-02, ten minutes after the open — a chain that passed
// EVERY OTHER GUARD in this file (1,046 contracts carrying open interest, coverage fine, front
// expiry healthy, ok:true, reason:null):
//
//     expiry        open interest    OI-weighted IV
//     2026-09-02        251,426          10.6%
//     2026-09-04        395,592           9.2%
//     2026-09-18      1,388,869           4.7%
//     2026-12-18        761,892           2.7%
//
// Implied vol FALLING monotonically to 2.7% four months out is not a market condition; nothing
// about QQQ in December is priced at a third of the realised vol of the index. Every one of those
// numbers is a legal quote taken alone. It is the aggregate that is impossible.
//
// It matters because of the shape of the gamma formula, not the size of the error. Gamma carries
// sigma in the denominator, but d1 does too — so a vol that is too low does not scale gamma up
// evenly, it makes d1 enormous for any strike off spot, drives phi(d1) to zero, and collapses the
// whole surface onto the money. That produces the two symptoms seen together on the live recompute:
// an aggregate net GEX of −$13.2M against −$2.75B on the settled chain, AND a flip zone 0.24 wide
// that the fragility test called CLEAR — because there was no gamma left anywhere else to move it.
//
// So the chain is checked in aggregate as well as per contract. 10% sits with roughly a factor of
// two of headroom on both sides: the broken chain reads 5.4% (6.1% after the raised MIN_IV), the
// settled chain from the day before reads 20.4%, and OI-weighting pulls the figure UP rather than
// down, because far strikes carry the skew.
export const MIN_OI_WTD_IV = 0.10;

// ── PARTIAL OPEN INTEREST IS WORSE THAN NONE ────────────────────────────────
// Yahoo does not simply withhold openInterest before the open — it repopulates it PROGRESSIVELY
// through the pre-market. Measured on QQQ, 2026-09-02:
//
//     09:30 UTC   front expiry 209 contracts,   0 with OI  (0%)
//     11:00 UTC   front expiry 209 contracts,  63 with OI  (30%)
//
// Zero is easy: nothing computes and the failure is obvious. A THIRD is the dangerous case. It
// passes any "is there data" check and produces a full, confident, wrong answer — the live
// recompute at 11:00 returned net GEX of +$0.10B against −$2.75B from the settled chain, a flipped
// sign and a 27x collapse, with a flip zone 0.24 wide that the fragility test called STABLE
// because there was almost no put gamma left to reweight.
//
// So coverage is measured and a thin chain is refused. 60% is set between the 30% observed on a
// half-populated feed and the ~90% a settled chain gives, where essentially every listed strike
// near the money carries some open interest. Worth revisiting once a mid-session run has been
// observed, which is the one calibration point not yet in hand.
export const MIN_OI_COVERAGE = 0.60;
// The nearest expiry's open interest against the median expiry's. Below this the front of the
// chain has not been populated, whatever the contract counts say.
export const MIN_FRONT_OI_RATIO = 0.15;

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const dayOf = (unix) => Number.isFinite(+unix) ? new Date(+unix * 1000).toISOString().slice(0, 10) : null;

// One expiry. `date` is the unix expiry Yahoo lists; omit it for the front expiry, which also
// returns the full `expirationDates` array used to choose the rest.
// NOT KEYLESS. The v7 options endpoint answers 401 "Invalid Crumb" without a cookie and crumb —
// the same gate api/prices.js already navigates for v7 quotes. `auth` is passed in so one
// handshake serves every expiry in a snapshot instead of one per call.
export async function fetchChain(symbol, date = null, auth = null) {
  try {
    const a = auth || await yahooAuth();
    const qs = [date ? `date=${date}` : null, a?.crumb ? `crumb=${encodeURIComponent(a.crumb)}` : null].filter(Boolean).join('&');
    const url = `${BASE}/${encodeURIComponent(symbol)}${qs ? `?${qs}` : ''}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(a?.cookie ? { Cookie: a.cookie } : {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const res = (await r.json())?.optionChain?.result?.[0];
    if (!res) return null;
    return {
      symbol: res.underlyingSymbol || symbol,
      spot: num(res.quote?.regularMarketPrice),
      expirationDates: Array.isArray(res.expirationDates) ? res.expirationDates : [],
      strikes: Array.isArray(res.strikes) ? res.strikes : [],
      calls: res.options?.[0]?.calls || [],
      puts: res.options?.[0]?.puts || [],
      expiry: dayOf(res.options?.[0]?.expirationDate),
      expiryUnix: num(res.options?.[0]?.expirationDate),
    };
  } catch {
    return null;
  }
}

// Yahoo's per-contract object → the six fields this module needs, trimmed to strikes that matter.
// A contract with no open interest is dropped: it contributes nothing to gamma exposure and would
// otherwise be most of the payload.
export function parseContracts(raw = [], type, { spot, expiry, bandPct = STRIKE_BAND_PCT } = {}) {
  const s = num(spot);
  const lo = s == null ? null : s * (1 - bandPct / 100);
  const hi = s == null ? null : s * (1 + bandPct / 100);
  const out = [];
  let ivRejected = 0, inBand = 0;
  for (const c of (Array.isArray(raw) ? raw : [])) {
    const strike = num(c?.strike);
    if (strike == null) continue;
    if (lo != null && (strike < lo || strike > hi)) continue;
    // Counted BEFORE the open-interest filter: this is the denominator for coverage, and it has to
    // be contracts that were actually relevant rather than everything the exchange lists.
    inBand++;
    const oi = num(c?.openInterest) ?? 0;
    if (!(oi > 0)) continue;
    // Yahoo's impliedVolatility is a decimal (0.2134 = 21.34%). Outside the plausible band it is
    // the unsolved-IV sentinel, not a quote — kept as null so the contract is SKIPPED downstream
    // rather than priced at effectively zero vol, which produces a gamma four orders of magnitude
    // too large and a wall at whatever strike it sits on.
    const rawIv = num(c?.impliedVolatility);
    const iv = (rawIv != null && rawIv >= MIN_IV && rawIv <= MAX_IV) ? +rawIv.toFixed(6) : null;
    if (iv == null) ivRejected++;
    out.push({
      type, strike, expiry, oi,
      volume: num(c?.volume) ?? 0,
      iv,
      last: num(c?.lastPrice), bid: num(c?.bid), ask: num(c?.ask),
    });
  }
  out.ivRejected = ivRejected;
  out.inBand = inBand;
  return out;
}

// ── choosing expiries ────────────────────────────────────────────────────────
// Front weekly, the next two weeklies, the front monthly, the next monthly, the next quarterly.
// Monthlies are the third Friday; quarterlies end a calendar quarter. Yahoo hands back a plain
// list of unix dates, so the classification is done here from the dates themselves.
const isThirdFriday = (d) => d.getUTCDay() === 5 && d.getUTCDate() >= 15 && d.getUTCDate() <= 21;
const isQuarterEnd = (d) => [2, 5, 8, 11].includes(d.getUTCMonth());

export function pickExpiries(expirationDates = [], { now = new Date(), maxWeeklies = 3 } = {}) {
  const rows = (Array.isArray(expirationDates) ? expirationDates : [])
    .map(u => ({ unix: u, d: new Date(u * 1000) }))
    .filter(r => Number.isFinite(r.unix) && r.d.getTime() >= now.getTime() - 86400000)
    .sort((a, b) => a.unix - b.unix);
  if (!rows.length) return [];

  // A date can satisfy several roles at once — the third Friday of September is a weekly, a
  // monthly AND a quarterly. So WHAT a date is (its tags) is kept separate from WHICH SLOT it
  // filled (its role). Each role claims the earliest date that satisfies it and is not already
  // claimed, which is what keeps six roles from collapsing into four expiries; the first version
  // of this silently dropped the quarterly whenever it landed on a weekly.
  const tagsOf = (d) => {
    const t = ['weekly'];
    if (isThirdFriday(d)) t.push('monthly');
    if (isThirdFriday(d) && isQuarterEnd(d)) t.push('quarterly');
    return t;
  };
  const picked = new Map();
  const take = (r, role) => {
    if (!r || picked.has(r.unix)) return false;
    picked.set(r.unix, { unix: r.unix, date: r.d.toISOString().slice(0, 10), role, tags: tagsOf(r.d) });
    return true;
  };
  const claimFirst = (pred, role) => { for (const r of rows) if (pred(r) && take(r, role)) return r; return null; };

  rows.slice(0, maxWeeklies).forEach((r, i) => take(r, i === 0 ? 'front' : `weekly+${i}`));
  claimFirst(r => isThirdFriday(r.d), 'front monthly');
  claimFirst(r => isThirdFriday(r.d), 'next monthly');
  claimFirst(r => isThirdFriday(r.d) && isQuarterEnd(r.d), 'next quarterly');
  return [...picked.values()].sort((a, b) => a.unix - b.unix);
}

// The whole snapshot for one symbol: front chain first (it carries the expiry list), then each
// chosen expiry, staggered. Returns the trimmed contracts plus what it could not get, because a
// partial chain silently treated as whole would understate every figure computed from it.
export async function snapshotSymbol(symbol, { now = new Date(), bandPct = STRIKE_BAND_PCT, gapMs = FETCH_GAP_MS } = {}) {
  // One handshake for the whole snapshot rather than one per expiry.
  const auth = await yahooAuth();
  const front = await fetchChain(symbol, null, auth);
  if (!front || front.spot == null) {
    // The same SHAPE as the success path. An early return that omits perExpiry and reason makes
    // every caller crash on the one path where it is already having a bad day.
    return { symbol, spot: null, asOf: new Date().toISOString(), date: new Date().toISOString().slice(0, 10),
      contracts: [], expiries: [], failed: ['front'], ivRejected: 0, ivUsable: 0, oiWtdIv: null,
      ivOiShare: 0, contractsSeen: 0, withOi: 0, inBand: 0, coverage: 0, frontCoverage: 0,
      frontOiRatio: 0, perExpiry: [], reason: 'could not fetch the front chain', ok: false };
  }
  const wanted = pickExpiries(front.expirationDates, { now });
  const contracts = [];
  const got = [];
  const failed = [];
  let ivRejected = 0, seen = 0, inBand = 0;
  const perExpiry = [];

  for (let i = 0; i < wanted.length; i++) {
    const w = wanted[i];
    let chain;
    if (w.unix === front.expiryUnix) chain = front;
    else {
      if (i > 0) await new Promise(r => setTimeout(r, gapMs));
      chain = await fetchChain(symbol, w.unix, auth);
    }
    if (!chain) { failed.push(w.date); continue; }
    const opts = { spot: front.spot, expiry: w.date, bandPct };
    const cs = parseContracts(chain.calls, 'call', opts), ps = parseContracts(chain.puts, 'put', opts);
    seen += (chain.calls?.length || 0) + (chain.puts?.length || 0);
    ivRejected += (cs.ivRejected || 0) + (ps.ivRejected || 0);
    inBand += (cs.inBand || 0) + (ps.inBand || 0);
    // Per-expiry, because the FRONT expiries carry most of the gamma. A chain that is well covered
    // at the back and empty at the front is not a usable chain however good the overall ratio.
    perExpiry.push({ date: w.date, inBand: (cs.inBand || 0) + (ps.inBand || 0), withOi: cs.length + ps.length,
      // OI MAGNITUDE, not just contract count. Counting was not enough: on 2026-09-02 the front
      // expiry had contracts carrying open interest and contributed 0% of the book's gamma,
      // because the amounts were tiny. A count-based check passes that; a size-based one does not.
      oi: [...cs, ...ps].reduce((a, c) => a + (c.oi || 0), 0) });
    contracts.push(...cs, ...ps);
    got.push({ ...w, contracts: (chain.calls?.length || 0) + (chain.puts?.length || 0) });
  }

  // ── "NO CHAIN" AND "NO OPEN INTEREST" ARE DIFFERENT FAILURES ────────────────
  // Yahoo serves the contracts pre-market but does NOT populate openInterest until the session is
  // under way. Measured 2026-09-02 at 09:30 UTC, four hours before the US open: the 0DTE expiry
  // returned 209 contracts with 922,440 of volume and ZERO open interest; the next weekly, 364
  // contracts and zero; the monthly, 502 contracts and sixteen.
  //
  // OCC does settle overnight — that part of the design was right — but the vendor does not serve
  // the settled figure until the market is trading. So a pre-open capture returns a full chain and
  // nothing to weight it with, and reporting that as "no chain" sends anyone debugging it to look
  // at the fetch, which is working perfectly.
  const withOi = contracts.filter(c => c.oi > 0).length;
  const coverage = inBand > 0 ? +(withOi / inBand).toFixed(3) : 0;
  // The front expiry specifically. Gamma is concentrated in the near dates, so a chain covered at
  // the back and hollow at the front produces an aggregate dominated by contracts that barely
  // matter — which is precisely the shape a half-populated pre-market feed has.
  const nearest = perExpiry[0] || null;
  const frontCoverage = nearest && nearest.inBand > 0 ? +(nearest.withOi / nearest.inBand).toFixed(3) : 0;

  // ── THE NEAR EXPIRIES CARRY THE GAMMA, SO THEY DECIDE WHETHER THE CHAIN IS REAL ──
  // Measured on the row stored 2026-09-02 12:14 UTC: the three nearest expiries carried 3.6% of the
  // gross gamma between them while the three far ones carried 96%. That is not a market condition,
  // it is a half-populated feed — and the read drawn from it said "the walls are a multi-expiry
  // level", which is exactly backwards. They looked like a multi-expiry level BECAUSE the near
  // expiries were missing.
  //
  // Self-calibrating rather than an absolute floor: compare the nearest expiry's total open
  // interest to the MEDIAN expiry's. In a healthy chain the front weekly is comparable to the rest;
  // when the feed has not filled in it is a rounding error against them. No guessed constant, and
  // it holds as the book grows or shrinks.
  const ois = perExpiry.map(e => e.oi).filter(v => v > 0).sort((a, b) => a - b);
  const medianOi = ois.length ? ois[Math.floor(ois.length / 2)] : 0;
  const frontOiRatio = medianOi > 0 ? +((nearest?.oi ?? 0) / medianOi).toFixed(3) : 0;
  const frontStarved = medianOi > 0 && frontOiRatio < MIN_FRONT_OI_RATIO;

  // The vol surface in aggregate — see MIN_OI_WTD_IV. Weighted by open interest so the strikes
  // that actually carry the book decide it, and computed over the contracts that SURVIVED the
  // per-contract band, so it is a statement about the quotes being used rather than the ones
  // already discarded.
  const usable = contracts.filter(c => c.iv != null);
  const usableOi = usable.reduce((a, c) => a + c.oi, 0);
  const totalOi = contracts.reduce((a, c) => a + c.oi, 0);
  const oiWtdIv = usableOi > 0 ? +(usable.reduce((a, c) => a + c.iv * c.oi, 0) / usableOi).toFixed(4) : null;
  // Reported, not gated. The broken chain reads 68% here and the only healthy reading in hand is
  // by contract count rather than by size, so there is no calibration point to set a floor
  // against. It goes in the payload so that one accumulates.
  const ivOiShare = totalOi > 0 ? +(usableOi / totalOi).toFixed(3) : 0;
  const ivBroken = oiWtdIv != null && oiWtdIv < MIN_OI_WTD_IV;

  const thin = coverage < MIN_OI_COVERAGE || frontCoverage < 0.5 || frontStarved || ivBroken;
  return {
    symbol, spot: front.spot,
    asOf: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    contracts, expiries: got, failed,
    ivRejected, ivUsable: usable.length, oiWtdIv, ivOiShare,
    contractsSeen: seen, withOi, inBand, coverage, frontCoverage, frontOiRatio, perExpiry,
    // The reason, not just the fact. A caller that cannot tell these apart cannot decide whether
    // to retry, wait, or go and look at the code.
    reason: seen === 0 ? 'no contracts served'
      : withOi === 0 ? 'chain served but no open interest — Yahoo does not populate it before the US open'
      : ivBroken ? `the chain's open-interest-weighted implied vol is ${(oiWtdIv * 100).toFixed(1)}% — a real ${symbol} chain sits near 20%, and gamma computed off a vol this low collapses onto the money and understates the whole book`
      : frontStarved ? `the front expiry carries ${Math.round(frontOiRatio * 100)}% of the median expiry's open interest — the near end of the chain has not been populated, and near expiries are where the gamma is`
      : thin ? `open interest only ${Math.round(coverage * 100)}% populated (${Math.round(frontCoverage * 100)}% on the front expiry) — Yahoo fills this in progressively through the pre-market, and a partial chain gives a confident wrong answer`
      : null,
    ok: !thin && failed.length === 0,
  };
}
