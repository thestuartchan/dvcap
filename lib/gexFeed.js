// lib/gexFeed.js — the gamma board as read-only JSON, for a consumer that cannot log in.
//
// GET /api/g/<slug>/<ticker> (rewritten onto api/gex.js ?feed=). No auth header — the consumer
// cannot send one — so the unguessable slug is the protection, and the payload is built HERE from
// an explicit list of gamma fields rather than by passing a board object through. Nothing about
// the account can leak because nothing about the account is ever read: this module sees a board
// and a ticker. `feedLeaks` checks the serialised answer for the brief's banned words anyway, and
// the route refuses to send anything it flags.
//
// THE SAME NUMBERS AS THE GAMMA TAB. The feed and the tab read one cache (LAST_RECOMPUTE_KEY in
// lib/gexStore.js): whichever recomputed last, the other opens on it. The strikes are the set the
// heatmap draws (mustShow + heatCells, the same calls the panel makes), and the flag on an expiry
// is the panel's own "✓ call wall + trapdoor" agreement label.
import { heatCells, withGrossShares } from './gex.js';
import { mustShow, levelsOf } from './gexLevels.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const r2 = (v) => num(v) == null ? null : +(+v).toFixed(2);
const r4 = (v) => num(v) == null ? null : +(+v).toFixed(4);
const usd = (v) => num(v) == null ? null : Math.round(+v);
const iso = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

export const FEED_TICKERS = Object.freeze(['QQQ', 'SPY']);
export const FEED_RECOMPUTE_MIN = 5;              // at most one recompute per ticker per 5 minutes
export const FEED_RATE_PER_HOUR = 30;             // per IP
export const FEED_SLUG_MIN = 32;

// The words the brief says must never appear in an answer. Checked on the serialised JSON, keys
// and values alike, case-insensitively.
export const FEED_BANNED = Object.freeze(['position', 'qty', 'nlv', 'journal', 'alert', 'key', 'token']);
export function feedLeaks(json) {
  const s = String(typeof json === 'string' ? json : JSON.stringify(json)).toLowerCase();
  return FEED_BANNED.filter(w => s.includes(w));
}

// Constant-time comparison of the presented slug with the stored one. Unequal lengths are
// rejected before the comparison, which leaks only the length — and the length is public (32+).
export function slugMatches(given, stored) {
  const a = String(given || ''), b = String(stored || '');
  if (b.length < FEED_SLUG_MIN || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The hourly bucket a request counts against. The IP is hashed by the caller before it gets here,
// so the store never holds an address.
export function rateBucket(ipHash, now = new Date()) {
  return `dvcap:gex:feed:rl:v1:${ipHash}:${now.toISOString().slice(0, 13)}`;
}

// The agreement label the panel prints on an expiry row: which headline level that expiry's own
// peak lands on. Same three tests, same order, same words.
export function expiryFlag(e, { callWall = null, levels = null } = {}) {
  const mC = callWall != null && e?.peakCallStrike === callWall;
  const mT = !!levels?.trapdoor && (e?.peakPutStrike === levels.trapdoor.near?.strike || e?.peakPutStrike === levels.trapdoor.deep?.strike);
  const mS = levels?.support?.strike != null && e?.peakCallStrike === levels.support.strike;
  return [mC ? 'call wall' : null, mS ? 'support' : null, mT ? 'trapdoor' : null].filter(Boolean).join(' + ') || null;
}

// ── WHICH DAY'S OPEN INTEREST ─────────────────────────────────────────────────
// OCC publishes each session's settled open interest overnight (~06:00–07:00 ET). The chain's
// vintage (lib/gexStore.js occVintage) says whether the file has rolled since the last close.
const NY_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const nyDate = (t) => NY_DAY.format(new Date(t));
export function oiSettledLabel(vintage) {
  if (!vintage?.priorClose) return 'OI settled';
  return vintage.rolledSinceClose === false ? `OI from before the ${nyDate(vintage.priorClose)} close (today's not yet published)`
    : `OI settled ${nyDate(vintage.priorClose)}`;
}
// A board repriced on YESTERDAY's open interest because today's file has not rolled: the vintage
// says not rolled and its last close is before today (New York). After today's close the file
// legitimately has not rolled yet and the OI is today's — not stale.
export function oiStaleReason(vintage, now = new Date()) {
  if (!vintage || vintage.rolledSinceClose !== false || !vintage.priorClose) return null;
  return nyDate(vintage.priorClose) < nyDate(now) ? 'oi_not_published' : null;
}
export const nyToday = (now = new Date()) => nyDate(now);

// "DTB3 2026-09-25" → "2026-09-25".
const dateIn = (s) => (String(s || '').match(/\d{4}-\d{2}-\d{2}/) || [null])[0];

// board: { row, levels, grid, byStrike, decay?, crossCheck? } — a recompute record or a stored board.
// `today` is the New York trading date the payload is for: expiries before it are dropped (a board
// recomputed yesterday still carried yesterday's expiry the next morning), the shares re-based on
// what is left, and the levels rebuilt by lib/gexLevels.js from the board's own rows at its spot —
// so a record stored before a rule changed is read with today's rules.
export function gexFeedPayload(ticker, board, { mode = 'settled', asOf = null, sourceSnapshot = null, today = null, staleReason = null } = {}) {
  const row = board?.row || {};
  const day = today ?? (iso(asOf) ?? iso(row.asOf) ? nyDate(iso(asOf) ?? iso(row.asOf)) : null);
  const rawGrid = board?.grid || null;
  const expired = !!(day && rawGrid?.expiries?.some(e => String(e.expiry) < day));
  const grid = rawGrid ? withGrossShares(rawGrid, { from: day }) : null;
  // With an expiry dropped, the per-strike nets are rebuilt from the cells that remain.
  let byStrike = board?.byStrike || null;
  if (expired && grid?.cells) {
    const m = new Map();
    for (const c of grid.cells) m.set(c.strike, (m.get(c.strike) || 0) + (Number(c.netGexUsd) || 0));
    byStrike = [...m.entries()].sort((a, b) => a[0] - b[0]).map(([strike, netGexUsd]) => ({ strike, netGexUsd }));
  }
  const lv = (byStrike?.length && num(row.spot))
    ? levelsOf({ byStrike, grid, spot: +row.spot, atr: row.atr ?? board?.levels?.atr ?? null, callWall: row.callWall, today: day })
    : (board?.levels || null);
  const cw = lv?.callWall || null;
  const sup = lv?.support || null;
  const tdoor = (t) => t ? { strike: num(t.strike), ...(t.pair ? { pair: t.pair.map(num), label: t.pairLabel } : {}),
                             gamma: usd(t.netGexUsd), gamma_today: usd(t.todayGexUsd), expiry: t.expiry ?? null } : null;
  const pin = lv?.pin?.pinned ? lv.pin : null;
  const tb = lv?.todayBook || null;

  // The heatmap's strike set, exactly as the panel builds it.
  const m = mustShow(lv, { flipZoneLo: row.flipZoneLo, flipZoneHi: row.flipZoneHi });
  const heat = heatCells(grid, { must: m.strikes, flipZone: m.flipZone });

  const cc = board?.crossCheck || null;
  const checks = Array.isArray(cc?.checks) ? cc.checks.filter(c => c.score) : [];
  const item = (c) => ({ check: c.name, ours: c.ours ?? null, theirs: c.theirs ?? null });

  return {
    ticker,
    as_of_utc: iso(asOf) ?? iso(row.asOf),
    source_snapshot_utc: iso(sourceSnapshot) ?? iso(row.asOf),
    mode,
    spot: r2(row.spot),
    net_gex_per_1pct: usd(row.gexUsd),
    // The board without today's expiry — what it looks like tomorrow at the same spot.
    net_ex_today: usd(tb?.exToday),
    net_today: usd(tb?.today),
    flip: {
      line: r2(row.flipLevel),
      zone_lo: r2(row.flipZoneLo),
      zone_hi: r2(row.flipZoneHi),
      zone_pct: r2(row.flipSpreadPctOfSpot),
      // Usable = a single level the board stands behind. A fragile flip (the zone is wide as the
      // dealer put assumption varies) is flagged on the tab as "a zone, not a line".
      usable: row.flipLevel != null && !row.flipFragile,
    },
    call_wall: {
      strike: num(cw?.strike ?? row.callWall),
      kind: cw?.kind ?? null,
      gamma: usd(cw?.netGexUsd),
      expiries_peaking: cw?.peaks ?? null,
      of: cw?.of ?? null,
    },
    // The near-spot ceiling the call wall used to name: the pin box's upper edge.
    pin_top: num(lv?.pinTop),
    put_support: {
      strike: num(sup?.strike),
      gamma: usd(sup?.netGexUsd),
      expiry: sup?.expiry ?? null,
      peaks: sup?.peaks ?? null,
      of: sup?.of ?? null,
    },
    trapdoor: { near: tdoor(lv?.trapdoor?.near), deep: tdoor(lv?.trapdoor?.deep),
                ...(lv?.trapdoor?.deep ? {} : { deep_note: lv?.trapdoor?.deepNote ?? null }) },
    pin_box: pin ? { lo: num(pin.lo), hi: num(pin.hi), expiry: pin.front ?? null, share_pct: r2(pin.share),
                     magnets: (pin.magnets || []).map(num), magnet_gamma: Object.fromEntries(Object.entries(pin.magnetGex || {}).map(([k, v]) => [k, usd(v)])) } : null,
    balance: lv?.balance ? { below: usd(lv.balance.below), above: usd(lv.balance.above), state: lv.balance.state ?? null } : null,
    // share_pct is of GROSS gamma (Σ|cell|), on the full chain; net and gross beside it.
    expiries: (grid?.expiries || []).map(e => ({
      date: e.expiry, share_pct: r2(e.shareOfAbs), net: usd(e.netGexUsd), gross: usd(e.grossGexUsd),
      peak_put: num(e.peakPutStrike), peak_call: num(e.peakCallStrike),
      flag: expiryFlag(e, { callWall: num(cw?.strike ?? row.callWall), levels: lv }),
    })),
    strikes: heat ? heat.strikes.map(k => ({
      strike: k,
      by_expiry: Object.fromEntries(heat.expiries.filter(e => heat.at.has(`${e}|${k}`)).map(e => [e, usd(heat.at.get(`${e}|${k}`))])),
    })) : [],
    post_expiry_pivot: board?.decay?.moves?.flip ? { from: r2(board.decay.moves.flip.from), to: r2(board.decay.moves.flip.to) } : null,
    cross_check: cc ? {
      agrees: checks.filter(c => c.state === 'match').map(item),
      disagrees: checks.filter(c => c.state !== 'match').map(item),
      cboe_snapshot_utc: iso(cc.asOf),
    } : null,
    // "live" only for a print dated the board's own day; an older one says stale.
    risk_free: { rate: r4(row.rate), source: row.rateSource ?? null, as_of: dateIn(row.rateSource),
                 status: row.rateStatus === 'live' && dateIn(row.rateSource) !== (iso(asOf) ?? iso(row.asOf) ?? '').slice(0, 10) ? 'stale' : (row.rateStatus ?? null) },
    ...(staleReason ? { stale_reason: staleReason } : {}),
  };
}
