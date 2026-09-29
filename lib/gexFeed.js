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
import { heatCells } from './gex.js';
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

// "DTB3 2026-09-25" → "2026-09-25".
const dateIn = (s) => (String(s || '').match(/\d{4}-\d{2}-\d{2}/) || [null])[0];

// board: { row, levels, grid, decay?, crossCheck? } — a recompute record or a stored board.
export function gexFeedPayload(ticker, board, { mode = 'settled', asOf = null, sourceSnapshot = null } = {}) {
  const row = board?.row || {};
  const grid = board?.grid || null;
  // A board without its levels (the Yahoo fallback carries only the per-strike rows) gets them the
  // way the panel does: from the same rows, at the same spot.
  const lv = board?.levels
    || (board?.byStrike?.length && num(row.spot) ? levelsOf({ byStrike: board.byStrike, grid, spot: +row.spot, atr: row.atr ?? null, callWall: row.callWall }) : null);
  const cw = lv?.callWall || null;
  const sup = lv?.support || null;
  const tdoor = (t) => t ? { strike: num(t.strike), gamma: usd(t.netGexUsd), expiry: t.expiry ?? null } : null;
  const pin = lv?.pin?.pinned ? lv.pin : null;

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
      expiries_peaking: cw?.peaks ?? null,
      of: cw?.of ?? null,
    },
    put_support: {
      strike: num(sup?.strike),
      gamma: usd(sup?.netGexUsd),
      expiry: sup?.expiry ?? null,
      peaks: sup?.peaks ?? null,
      of: sup?.of ?? null,
    },
    trapdoor: { near: tdoor(lv?.trapdoor?.near), deep: tdoor(lv?.trapdoor?.deep) },
    pin_box: pin ? { lo: num(pin.lo), hi: num(pin.hi), expiry: pin.front ?? null, share_pct: r2(pin.share), magnets: (pin.magnets || []).map(num) } : null,
    balance: lv?.balance ? { below: usd(lv.balance.below), above: usd(lv.balance.above), state: lv.balance.state ?? null } : null,
    expiries: (grid?.expiries || []).map(e => ({
      date: e.expiry, share_pct: r2(e.shareOfAbs), net: usd(e.netGexUsd),
      peak_put: num(e.peakPutStrike), peak_call: num(e.peakCallStrike),
      flag: expiryFlag(e, { callWall: num(row.callWall), levels: lv }),
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
    risk_free: { rate: r4(row.rate), source: row.rateSource ?? null, as_of: dateIn(row.rateSource), status: row.rateStatus ?? null },
  };
}
