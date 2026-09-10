// lib/gexStore.js — the GEX capture and read, and the keys they share.
//
// WHY THIS IS A LIB AND NOT TWO API ROUTES. Vercel's Hobby plan caps a deployment at 12 Serverless
// Functions. Adding api/gex.js and api/gex-snapshot.js took this project from 11 to 13, and the
// whole deployment silently stopped shipping — the live site kept serving the previous build, so
// /api/atr answered 200 while both new routes 404'd and nothing anywhere said why. That is the
// second free-tier cap to bite in a day, after the 2-cron limit that took the US pre-read dark.
//
// So the two routes collapse into one function with a mode, and the work moves here where it can
// be read and tested independently of the HTTP shell.
import { snapshotSymbol } from './optionsChain.js';
import { gexSummary, walls, gammaGrid } from './gex.js';
import { yearsTo } from './blackscholes.js';
import { fetchCboeChain, cboeSummary, compareGex } from './cboe.js';
import { fetchOccOi, mergeOccIv, MIN_OCC_COVERAGE, defaultExpiries, occVintage } from './occ.js';
import { fredLatest } from './fred.js';
import { kvGetJson, kvSetJson } from './kv.js';
import { upsertByDate } from './series.js';
import { yahooDailyOHLC } from './yahoo.js';

// QQQ FIRST. It leads every rendering that walks this list, and it is the book the day trades are
// placed against; SPY is the corroborating second opinion. The order was incidental and showed up
// as SPY heading the pre-read's map.
export const GEX_SYMBOLS = ['QQQ', 'SPY'];
// Dividend yields. The RISK-FREE rate comes from FRED below and is never hardcoded; these move a
// few basis points a year and affect gamma at the fourth decimal.
export const DIV_YIELD = Object.freeze({ SPY: 0.012, QQQ: 0.005 });
export const RAW_KEY = (sym, date) => `dvcap:gex:${sym}:${date}`;
export const SERIES_KEY = 'dvcap:gex:series:v1';
export const RAW_INDEX_KEY = 'dvcap:gex:rawindex:v1';
// What OCC's file looked like last time it was fetched, per symbol, so the code can tell whether it
// has ROLLED rather than trusting a publication hour. See the note on occVintage in lib/occ.js.
export const OCC_VINTAGE_KEY = 'dvcap:occ:vintage:v1';
export const RAW_RETENTION_DAYS = 30;

// 20-day average dollar volume — close x volume, not share count, because the figure GEX is
// normalised against is money traded and share counts are not comparable across two names at
// different prices. Under ten bars it is a guess, and the normalisation is better absent.
export async function adv20Usd(symbol) {
  try {
    const bars = await yahooDailyOHLC(symbol, '3mo');
    const rows = bars.filter(b => b.volume > 0 && b.close > 0).slice(-20);
    if (rows.length < 10) return null;
    return Math.round(rows.reduce((a, b) => a + b.close * b.volume, 0) / rows.length);
  } catch { return null; }
}

// TWO SESSIONS, ONE ROW, AND THE FIRST ONE WINS.
//
// The first run of the day reads open interest that OCC settled overnight, and it is the reading
// worth keeping. It is NOT a pre-open run and has not been since the schedule moved to 15:15 UTC:
// Yahoo does not serve open interest before the US open, which is the whole reason it moved. The
// evening run reads the same day late,
// after that day's expiries have decayed, and it produces a materially different picture: measured
// on 2026-09-01 across the close, net GEX halved (−$5.07B to −$2.75B), the flip moved four points
// and the fragility zone tripled from 6.5 to 17.1 points, turning a usable read into an unusable
// one.
//
// upsertByDate replaced the row wholesale, so the evening reading overwrote the morning one and
// every historical row would have been the wrong vintage — permanently, since open interest is not
// served historically anywhere. The pre-open figures are now canonical and the close is stored
// BESIDE them, which also makes the open-to-close change readable instead of destroying it.
//
// If the pre-open run failed, the close run writes canonical and says so via `vintage`. Losing the
// day entirely because the first of two runs missed would be a worse trade than a labelled one.
export function sessionFor(now = new Date()) {
  // Before 17:00 UTC is pre-open or intraday for the US; after is the close run.
  return now.getUTCHours() < 17 ? 'open' : 'close';
}

const CLOSE_FIELDS = ['asOf', 'spot', 'gexUsd', 'gexUsdInverse', 'flipLevel', 'flipZoneLo', 'flipZoneHi',
  'flipFragile', 'flipSpread', 'callWall', 'putWall', 'oiWeightedIv', 'callOi', 'putOi'];

// One symbol's cross-check against CBOE. Returns a small object destined for the stored row, or a
// null with a reason — never throws, and never blocks the capture it decorates.
export async function crossCheck(symbol, ours, expiries = null) {
  try {
    const chain = await fetchCboeChain(symbol, { expiries });
    if (!chain.ok) return { source: 'cboe', ok: false, reason: chain.reason };
    const theirs = cboeSummary(chain.contracts, chain.spot);
    if (!theirs) return { source: 'cboe', ok: false, reason: 'CBOE chain produced no priced strikes' };
    const cmp = compareGex(ours, { ...theirs, spot: chain.spot }, { spot: ours.spot });
    return {
      source: 'cboe', ok: true, asOf: chain.asOf, fetchedAt: new Date().toISOString(),
      spot: chain.spot, callWall: theirs.callWall, putWall: theirs.putWall,
      callOi: theirs.callOi, putOi: theirs.putOi, oiWeightedIv: theirs.oiWeightedIv,
      netGexUsd: theirs.netGexUsd, contracts: theirs.contracts,
      // The by-strike profile is NOT stored. It is ~140 rows per symbol per day against a series
      // that has to stay small enough to read whole, and the comparison is about the headline
      // levels. It is recomputed on demand if anyone ever wants to see it.
      agree: cmp.agree, scored: cmp.scored, clean: cmp.clean, verdict: cmp.verdict, checks: cmp.checks,
    };
  } catch (e) {
    return { source: 'cboe', ok: false, reason: `cross-check failed — ${String(e?.message || e)}` };
  }
}

// ── REPRICING THE SETTLED CHAIN WHEN TODAY'S QUOTES ARE UNUSABLE ────────────
//
// The IV guard is right and it made the live-recompute button unusable exactly when it is wanted.
// Three mornings in a row — 2026-09-02 13:40, 09-08 13:36, 09-09 13:39 UTC — the QQQ chain came
// back with settled open interest, full strike coverage and a healthy front expiry, and an
// open-interest-weighted implied vol of 6.6% against a real chain's ~20%. Yahoo populates the
// quote side progressively after the bell; for the first half hour the greeks are junk while the
// positioning is fine. Refusing is correct — gamma computed off a vol that low collapses onto the
// money — but refusing was also the whole answer, so every morning the panel said "cannot".
//
// The panel's own claim about that button is the fix: "the same settled open interest, repriced at
// the current spot and time decay". Open interest settles overnight and does not move during the
// session, and neither does the implied vol the chain was last captured with. So when the ONLY
// thing wrong with the live chain is its vol surface, take the last stored chain — which passed
// every guard when it was written — and recompute it at today's spot and today's clock.
//
// What is live: the spot, and the time to every expiry. What is not: the open interest, and the
// implied vols. That is a real limitation, not a footnote — a vol shift since the capture is
// invisible here — so the result carries `mode: 'repriced'` and the date it came from, and the
// panel says so on screen rather than passing it off as a fresh read.
//
// Contracts that have expired since the capture drop out on their own: yearsTo returns null past
// expiry and contractGamma refuses a null T. They are counted and reported, because a Friday chain
// repriced on Monday has lost its heaviest expiry and the walls will have moved for that reason
// alone.
export async function repriceStored(symbol, { spot, now = new Date(), rate = null, divYield = null } = {}) {
  if (!(spot > 0)) return null;
  const series = (await kvGetJson(SERIES_KEY)) || {};
  const rows = Array.isArray(series[symbol]) ? series[symbol] : [];
  const latest = rows.length ? rows[rows.length - 1] : null;
  if (!latest?.date) return null;
  const raw = await kvGetJson(RAW_KEY(symbol, latest.date));
  if (!raw?.contracts?.length) return null;

  const nowISO = now.toISOString();
  const alive = raw.contracts.filter(c => yearsTo(c?.expiry, nowISO) != null);
  if (!alive.length) return null;

  const r = rate ?? latest.rate ?? 0;
  const q = divYield ?? latest.divYield ?? DIV_YIELD[symbol] ?? 0;
  const opts = { S: spot, r, q, now: nowISO };
  const summary = gexSummary(alive, { ...opts, date: nowISO.slice(0, 10), symbol, advUsd: latest.advUsd ?? null });
  summary.rate = r;
  summary.rateSource = rate != null ? null : (latest.rateSource ?? null);
  summary.divYield = q;
  summary.expiries = [...new Set(alive.map(c => c.expiry))].sort();
  summary.partial = false;

  return {
    row: summary,
    byStrike: walls(alive, opts).byStrike,
    grid: gammaGrid(alive, opts),
    from: latest.date,
    capturedAt: raw.asOf ?? null,
    capturedSpot: raw.spot ?? null,
    contracts: alive.length,
    expired: raw.contracts.length - alive.length,
  };
}

// ── THE `occ` RUNG — TODAY'S SETTLED BOOK, PRICED AT TODAY'S SPOT ────────────
// The top of the cascade in lib/gexBrief.js, declared there since the cascade was written and
// never implemented. Everything below it is a compromise:
//
//   repriced  yesterday's open interest at today's spot — the positioning is one settlement old
//   stored    yesterday's open interest at yesterday's spot — neither half is current
//
// Neither was a choice; they were what was available, because Yahoo serves no open interest before
// the US open and CBOE's is a settlement behind at that hour (both measured — see lib/occ.js).
//
// This rung takes OCC's settled open interest, CBOE's implied-vol surface, and our own spot, and
// recomputes gamma here through the same Black-Scholes path every other rung uses. The open
// interest is today's, the vol is the exchange's, and the spot is whatever the caller hands in —
// so before the open it is the pre-market print, and on the dashboard's refresh button it is the
// live one.
//
// NOTHING IS STORED. This is a read, not a capture: captureGex owns the write path and the daily
// series, and a second writer racing it would put two vintages under one date. It also means the
// rung costs nothing when it fails — the caller falls to `repriced` exactly as it does today.
export async function settledGex(symbol, { spot = null, now = new Date(), rate = null, divYield = null,
                                           bandPct = 10, minCoverage = MIN_OCC_COVERAGE,
                                           expiries = null } = {}) {
  // OCC first, because its expiry list is what the default set is chosen FROM when the caller has
  // no stored row to match. Cheap either way: 280KB against CBOE's 4.5MB.
  const occ = await fetchOccOi(symbol);
  if (!occ.ok) return { ok: false, reason: occ.reason };

  // ── HAS THE FILE ROLLED? ─────────────────────────────────────────────────
  // Asked of the file itself rather than of the clock. A scheduled pull at a measured hour is only
  // as good as the day it was measured on; if OCC ever shifts, a fixed time serves the previous
  // session's positioning under today's date — the exact failure this rung exists to escape.
  //
  // Best-effort: a KV miss costs the verdict, not the map. `rolledSinceClose` is null on a first
  // observation and the caller must read that as "unknown", never as "fine".
  let vintage = null;
  try {
    const seen = (await kvGetJson(OCC_VINTAGE_KEY)) || {};
    vintage = occVintage(occ, seen[symbol] || null, now);
    if (vintage?.changed) {
      await kvSetJson(OCC_VINTAGE_KEY, { ...seen, [symbol]: { fingerprint: vintage.fingerprint, firstSeenAt: vintage.firstSeenAt, rows: occ.rows } });
    }
  } catch { /* no memory of the last fetch — the map still draws, the verdict is absent */ }
  // LIKE FOR LIKE, OR THE CASCADE CANNOT BE CHECKED. See the note in lib/occ.js: the full listed
  // book is three times the stored capture's and costs three times as much to solve, and a map over
  // a different universe cannot be compared with the rung below it.
  const want = (expiries && expiries.length) ? expiries : defaultExpiries(occ.expiries, now);
  const cboe = await fetchCboeChain(symbol, { bandPct, expiries: want.length ? want : null });
  if (!cboe.ok) return { ok: false, reason: cboe.reason };

  const merged = mergeOccIv(occ, cboe.contracts);
  if (!merged?.contracts.length) return { ok: false, reason: 'no contract survived the OCC/CBOE join' };
  // A JOIN THAT LOSES THE BOOK IS NOT A BETTER SOURCE. Measured at 99.3% and 98.9% on QQQ and SPY;
  // a sharp fall means the two sides have stopped agreeing about what exists, and drawing a map
  // from whatever happened to match would be worse than the rung below, which at least knows what
  // it is missing.
  if (merged.coverage != null && merged.coverage < minCoverage) {
    return { ok: false, reason: `OCC covered only ${(merged.coverage * 100).toFixed(1)}% of the in-band book (floor ${(minCoverage * 100).toFixed(0)}%)` };
  }

  // Expired contracts carry no gamma and yearsTo returns null for them.
  const nowISO = now.toISOString();
  const alive = merged.contracts.filter(c => yearsTo(c?.expiry, nowISO) != null);
  if (!alive.length) return { ok: false, reason: 'every merged contract has already expired' };

  // OUR SPOT WINS WHERE WE HAVE ONE. CBOE's is its own snapshot and can be minutes behind; the
  // caller's is the pre-market or live print, which is the whole reason to recompute rather than
  // read CBOE's published gamma.
  const S = spot > 0 ? spot : cboe.spot;
  if (!(S > 0)) return { ok: false, reason: 'no usable spot' };

  const r = rate ?? 0;
  const q = divYield ?? DIV_YIELD[symbol] ?? 0;
  const opts = { S, r, q, now: nowISO };
  const summary = gexSummary(alive, { ...opts, date: nowISO.slice(0, 10), symbol });
  summary.rate = r;
  summary.divYield = q;
  summary.expiries = [...new Set(alive.map(c => c.expiry))].sort();
  summary.partial = false;

  return {
    ok: true, row: summary,
    byStrike: walls(alive, opts).byStrike,
    grid: gammaGrid(alive, opts),
    contracts: alive.length,
    expired: merged.contracts.length - alive.length,
    // The provenance, carried rather than summarised: two sources, and the reader is entitled to
    // know which half came from where and how much of the book made it through.
    oi: { source: 'OCC settled', totalOi: occ.totalOi, coverage: merged.coverage,
          matched: merged.matched, missingFromOcc: merged.missingFromOcc, noIv: merged.noIv,
          deltaVsCboe: merged.oiDeltaVsCboe },
    iv: { source: 'CBOE', asOf: cboe.asOf, spot: cboe.spot },
    expiriesUsed: want, expirySource: (expiries && expiries.length) ? 'stored capture' : 'default horizon',
    spotUsed: S, spotSource: spot > 0 ? 'caller' : 'CBOE',
    // Carried, not enforced. Refusing to draw a map because the file has not rolled would be worse
    // than the rung below it, which is the SAME book with an extra day on it; the caller shows the
    // verdict and decides.
    vintage,
  };
}

export async function captureGex({ symbols = GEX_SYMBOLS, dry = false, now = new Date(), session = null, compare = true } = {}) {
  const date = now.toISOString().slice(0, 10);
  const sess = session === 'open' || session === 'close' ? session : sessionFor(now);

  let r = null, rateSource = null;
  try {
    const dtb3 = await fredLatest('DTB3');
    if (dtb3?.value != null && Number.isFinite(+dtb3.value)) { r = +dtb3.value / 100; rateSource = `DTB3 ${dtb3.date}`; }
  } catch { /* gamma is very insensitive to r at these tenors; a null is recorded, not fatal */ }

  const results = [];
  for (const symbol of symbols) {
    const snap = await snapshotSymbol(symbol, { now });
    // A chain with no open interest is not a chain. Gamma exposure IS open interest weighted by
    // gamma — with every weight at zero the aggregate is zero, the flip is undefined and the walls
    // are wherever the tie-break lands. Writing that row would put a fabricated zero into a series
    // that cannot be rebuilt, so the day is skipped and the reason is reported verbatim.
    if (!snap || snap.spot == null || !snap.ok) {
      // Only ever on a dry run. A repriced row is not a capture: its open interest and implied
      // vols belong to another day, and writing it into the series would put a number in the
      // historical record that was never observed. The panel asks dry; the cron does not.
      const fallback = (dry && snap?.ivOnly && snap.spot > 0)
        ? await repriceStored(symbol, { spot: snap.spot, now, rate: r, divYield: DIV_YIELD[symbol] ?? 0 })
        : null;
      if (fallback) {
        results.push({ symbol, ok: true, mode: 'repriced', wrote: false, session: sess,
          reason: snap.reason, liveIv: snap.oiWtdIv ?? null,
          repricedFrom: fallback.from, capturedAt: fallback.capturedAt, capturedSpot: fallback.capturedSpot,
          contracts: fallback.contracts, expiredSinceCapture: fallback.expired,
          flip: fallback.row.flipLevel, gexUsd: fallback.row.gexUsd,
          row: fallback.row, byStrike: fallback.byStrike, grid: fallback.grid });
        continue;
      }
      results.push({ symbol, ok: false, mode: 'refused',
        reason: snap?.reason || 'no chain',
        // Said plainly rather than left for the reader to infer from a null: the fallback exists,
        // and this is a chain it cannot rescue.
        repriceable: !!snap?.ivOnly,
        contractsSeen: snap?.contractsSeen ?? 0, withOi: snap?.withOi ?? 0,
        failed: snap?.failed || null });
      continue;
    }
    const summary = gexSummary(snap.contracts, {
      S: snap.spot, r: r ?? 0, q: DIV_YIELD[symbol] ?? 0,
      now: now.toISOString(), date, symbol, advUsd: await adv20Usd(symbol),
    });
    summary.rate = r; summary.rateSource = rateSource;
    summary.divYield = DIV_YIELD[symbol] ?? 0;
    summary.expiries = snap.expiries.map(e => e.date);
    summary.partial = snap.failed.length > 0;
    summary.ivRejected = snap.ivRejected ?? null;

    // ── THE SECOND OPINION, TAKEN AT THE SAME MOMENT ──────────────────────────
    // It has to happen HERE and not in a separate pass. Two GEX readings half an hour apart are
    // not a comparison: on 2026-09-09 spot crossed the flip between 14:04 and 14:32 and net GEX
    // went from +$1.08B to −$1.08B, so a comparison run on its own schedule would have reported a
    // catastrophic disagreement about a book that had not changed at all.
    //
    // Guarded so it can never cost the capture. CBOE being down, slow, or reshaped must degrade
    // this to a null on the row — the stored series is the thing that cannot be rebuilt, and no
    // diagnostic is worth risking it.
    summary.crossCheck = compare === false ? null : await crossCheck(symbol, summary, snap.expiries.map(e => e.date));

    if (!dry) {
      await kvSetJson(RAW_KEY(symbol, date), {
        symbol, date, asOf: snap.asOf, spot: snap.spot,
        expiries: snap.expiries, failed: snap.failed, contracts: snap.contracts,
      });
      const idx = (await kvGetJson(RAW_INDEX_KEY)) || [];
      const keep = [...new Set([...idx, `${symbol}:${date}`])].sort();
      const cutoff = new Date(now.getTime() - RAW_RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
      const live = keep.filter(k => (k.split(':')[1] || '') >= cutoff);
      for (const k of keep.filter(k => !live.includes(k))) {
        const [s2, d2] = k.split(':');
        await kvSetJson(RAW_KEY(s2, d2), null);
      }
      await kvSetJson(RAW_INDEX_KEY, live);
      const series = (await kvGetJson(SERIES_KEY)) || {};
      const rows = series[symbol] || [];
      const existing = rows.find(r => r?.date === date);
      let row;
      if (sess === 'close' && existing && existing.vintage === 'open') {
        // Overlay only. The canonical pre-open figures are left exactly as they were.
        const close = {};
        for (const k of CLOSE_FIELDS) close[k] = summary[k] ?? null;
        row = { ...existing, close };
      } else {
        row = { ...summary, vintage: sess, close: existing?.close ?? null };
      }
      series[symbol] = upsertByDate(rows, row);
      await kvSetJson(SERIES_KEY, series);
    }
    results.push({ symbol, ok: true, mode: 'fresh', session: sess, contracts: snap.contracts.length, expiries: snap.expiries.length,
      failed: snap.failed, ivRejected: snap.ivRejected ?? null,
      flip: summary.flipLevel, gexUsd: summary.gexUsd, wrote: !dry,
      crossCheck: summary.crossCheck ?? null,
      // The whole row comes back, because the panel's live recompute renders from this rather than
      // from storage — a "refresh" that returned only two headline numbers and dropped the walls
      // would be a downgrade dressed as an update. byStrike only on a dry run: it is ~140 rows and
      // the scheduled writes have no reader for it.
      row: summary,
      byStrike: dry ? walls(snap.contracts, { S: snap.spot, r: r ?? 0, q: DIV_YIELD[symbol] ?? 0, now: now.toISOString() }).byStrike : null,
      grid: dry ? gammaGrid(snap.contracts, { S: snap.spot, r: r ?? 0, q: DIV_YIELD[symbol] ?? 0, now: now.toISOString() }) : null });
  }
  return { ok: true, date, session: sess, rate: r, rateSource, dry, results };
}

// The read side. The by-strike profile is rebuilt from the raw chain rather than stored twice —
// it is a view of the same numbers, and storing it would let the two drift apart.
export async function readGex(symbol) {
  const series = (await kvGetJson(SERIES_KEY)) || {};
  const rows = Array.isArray(series[symbol]) ? series[symbol] : [];
  const latest = rows.length ? rows[rows.length - 1] : null;
  let byStrike = null, grid = null;
  if (latest?.date) {
    const raw = await kvGetJson(RAW_KEY(symbol, latest.date));
    if (raw?.contracts?.length && raw.spot != null) {
      const opts = { S: raw.spot, r: latest.rate ?? 0, q: latest.divYield ?? 0, now: raw.asOf };
      byStrike = walls(raw.contracts, opts).byStrike;
      // Same contracts, the dimension walls() collapses. It answers whether the headline walls are
      // a level several expiries agree on or one expiry's book about to expire.
      grid = gammaGrid(raw.contracts, opts);
    }
  }
  return { available: rows.length > 0, symbol, symbols: GEX_SYMBOLS, latest, series: rows.slice(-180), byStrike, grid, days: rows.length };
}
