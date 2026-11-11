// lib/uwGamma.js — UW build step 11: Unusual Whales' gamma board scored against dvcap's.
//
// At each dvcap capture (gex-snapshot-open 10:15 ET, gex-snapshot-close 17:00 ET) UW's book is read
// at the same moment and scored with the SAME checks the CBOE second opinion uses (lib/cboe.js
// compareGex): call wall on dvcap's definition, put wall against put support or trapdoor. Then two
// UW-only lines: the flip, and the regime (spot above or below the flip) both books call.
//
// Like with like: UW's per-strike book is read on OPEN INTEREST (call_gamma_oi / put_gamma_oi) and
// its levels with source=oi, the basis dvcap's board is built on. The flow-weighted levels in the
// flow panel are a different object and are not scored here.
//
// LICENSED FOR PERSONAL USE. The rows live under their own Redis key (not a document, so never in
// the public data backup) and are read only through /api/flow?gamma=1 (dashboard session). The
// capture's job answer carries a part state per symbol, never a UW number.
import { compareGex, TOL } from './cboe.js';
import { uwConfigured, uwGet } from './uw.js';
import { kvGetJson, kvSetJson, kvConfigured } from './kv.js';

export const UW_GAMMA_KEY = 'dvcap:uw:gamma:v1';
export const UW_GAMMA_HEALTH_KEY = 'dvcap:uw:gamma:health:v1';
export const UW_GAMMA_MAX = 520;          // ~130 sessions × 2 symbols × open and close
export const UW_GAMMA_BAND_PCT = 10;      // dvcap's strike band: ±10% of spot
export const UW_GAMMA_PAGES = 3;          // 500 strikes a page; the band is ~140 on QQQ

const num = (v) => { const n = typeof v === 'string' ? Number(v) : v; return Number.isFinite(n) ? n : null; };
const rowsOf = (a) => (Array.isArray(a) ? a : Array.isArray(a?.data) ? a.data : null);
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

// UW's per-strike rows → the shape cboeSummary returns, so compareGex reads both vendors the same way.
// UW signs the sides already (call gamma positive, put gamma negative, dollars per 1% move).
export function uwStrikeBook(answer) {
  const rows = rowsOf(answer);
  if (!rows || !rows.length) return null;
  const by = new Map();
  const prices = [], times = [];
  for (const r of rows) {
    const k = num(r?.strike), c = num(r?.call_gamma_oi), p = num(r?.put_gamma_oi);
    if (k == null || (c == null && p == null)) continue;
    const row = by.get(k) || { strike: k, call: 0, put: 0 };
    row.call += Math.max(0, c ?? 0);
    row.put += Math.abs(Math.min(0, p ?? 0));
    by.set(k, row);
    if (num(r.price) != null) prices.push(num(r.price));
    if (r.time) times.push(String(r.time));
  }
  const strikes = [...by.values()].sort((a, b) => a.strike - b.strike).map(r => ({ ...r, netGexUsd: r.call - r.put }));
  if (!strikes.length) return null;
  const heaviest = (key) => strikes.reduce((a, b) => (b[key] > a[key] ? b : a));
  const cw = heaviest('call'), pw = heaviest('put');
  return {
    callWall: cw.call > 0 ? cw.strike : null, putWall: pw.put > 0 ? pw.strike : null,
    callWallNet: cw.netGexUsd, putWallNet: pw.netGexUsd,
    netGexUsd: strikes.reduce((a, r) => a + r.netGexUsd, 0),
    spot: median(prices), asOf: times.sort().at(-1) || null, strikes: strikes.length,
    byStrike: strikes,
  };
}

// The flip and the regime. Near = within the wall tolerance (0.5% of spot): the flip is a solved
// level, so two vendors land a little apart even on one book.
export function flipChecks(oursFlip, uwFlip, spot, tol = TOL) {
  const a = num(oursFlip), b = num(uwFlip), s = num(spot);
  if (a == null || b == null || !(s > 0)) {
    return [{ name: 'flip', ours: a, theirs: b, state: 'unknown', detail: 'one side did not solve a flip', score: true }];
  }
  const gapPct = Math.abs(a - b) / s * 100;
  const side = (f) => (s >= f ? 'above' : 'below');
  return [
    { name: 'flip', ours: a, theirs: b, state: gapPct <= tol.wallNearPct ? 'near' : 'differ', score: true,
      detail: `${Math.abs(a - b).toFixed(2)} apart (${gapPct.toFixed(2)}% of spot)`, gapPct: +gapPct.toFixed(2) },
    { name: 'regime', ours: side(a), theirs: side(b), state: side(a) === side(b) ? 'match' : 'differ', score: true,
      detail: side(a) === side(b) ? `both put spot ${side(a)} the flip` : 'the books put spot on opposite sides of the flip' },
  ];
}

// One symbol, one moment. `get` is uwGet (tests pass a fake). Never throws.
export async function uwGammaCheck({ symbol, ours, levels = null, get, now = new Date() }) {
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const S = num(ours?.spot);
  if (!(S > 0)) return { symbol, at, ok: false, reason: 'no dvcap spot' };
  try {
    const T = encodeURIComponent(symbol);
    const lo = Math.floor(+(S * (1 - UW_GAMMA_BAND_PCT / 100)).toFixed(6)), hi = Math.ceil(+(S * (1 + UW_GAMMA_BAND_PCT / 100)).toFixed(6));
    const rows = [];
    for (let page = 0; page < UW_GAMMA_PAGES; page++) {
      const r = rowsOf(await get(`/api/stock/${T}/spot-exposures/strike`, { query: { min_strike: lo, max_strike: hi, limit: 500, page }, timeoutMs: 8000 })) || [];
      rows.push(...r);
      if (r.length < 500) break;
    }
    const book = uwStrikeBook(rows);
    if (!book) return { symbol, at, ok: false, reason: 'UW returned no strikes' };
    const lv = await get(`/api/stock/${T}/gex-levels`, { query: { source: 'oi' }, timeoutMs: 8000 }).catch(() => null);
    const L = lv?.data && !Array.isArray(lv.data) ? lv.data : lv;
    const uwFlip = num(L?.gamma_flip);
    const cmp = compareGex(ours, { ...book, spot: book.spot ?? S }, { spot: S, levels, vendor: 'UW' });
    // UW's book carries no open interest or vol totals: those rows can never score, so they go.
    const checks = cmp.checks.filter(c => !(c.state === 'unknown' && /OI|IV/.test(c.name)) && c.name !== 'spot');
    checks.push(...flipChecks(ours.flipLevel, uwFlip, S));
    const scored = checks.filter(c => c.score && c.state !== 'unknown');
    const differ = scored.filter(c => c.state === 'differ');
    return {
      symbol, at, ok: true, uwAt: book.asOf, spot: S, uwSpot: book.spot, strikes: book.strikes,
      uwLevels: { callWall: num(L?.call_wall), putWall: num(L?.put_wall), flip: uwFlip, magnet: num(L?.gamma_magnet) },
      checks: checks.map(({ name, ours: o, theirs: t, state, detail, score }) => ({ name, ours: o, theirs: t, state, detail, score })),
      agree: scored.length - differ.length, scored: scored.length,
      verdict: !scored.length ? 'nothing could be scored' : !differ.length ? `agrees with UW on all ${scored.length} checks` : `differs from UW on ${differ.map(c => c.name).join(', ')}`,
    };
  } catch (e) {
    return { symbol, at, ok: false, reason: String(e?.message || e).slice(0, 60) };
  }
}

// The capture's hook (lib/gexStore.js captureGex): the check when the key is set, else a skip.
export async function uwGammaCapture({ symbol, ours, levels, now, env = process.env }) {
  if (!uwConfigured(env)) return { symbol, ok: false, reason: 'UW_API_KEY unset', skipped: true };
  return uwGammaCheck({ symbol, ours, levels, now, get: (path, o = {}) => uwGet(path, { ...o, env }) });
}

// Keep the moment's rows (one per symbol, date and session) and the part states for ?health=1.
export async function keepUwGamma(entries, { date, session, kv = { configured: kvConfigured, get: kvGetJson, set: kvSetJson } } = {}) {
  const good = (entries || []).filter(e => e?.ok);
  if (!kv.configured()) return { kept: 0, why: 'Redis unavailable' };
  const parts = Object.fromEntries((entries || []).map(e => [e.symbol, e.ok ? 'ok' : e.skipped ? 'skipped' : 'failed']));
  await kv.set(UW_GAMMA_HEALTH_KEY, { at: new Date().toISOString(), date, session, parts }).catch(() => {});
  if (!good.length) return { kept: 0 };
  let rows = await kv.get(UW_GAMMA_KEY).catch(() => null);
  rows = Array.isArray(rows) ? rows : [];
  const id = (r) => `${r.date}|${r.session}|${r.symbol}`;
  const fresh = good.map(e => ({ ...e, date, session }));
  const ids = new Set(fresh.map(id));
  const next = [...rows.filter(r => !ids.has(id(r))), ...fresh]
    .sort((a, b) => id(a).localeCompare(id(b))).slice(-UW_GAMMA_MAX);
  const ok = await kv.set(UW_GAMMA_KEY, next).catch(() => false);
  return { kept: ok ? fresh.length : 0 };
}

// The running score: per symbol and check, how often the books agree (match or near) over the kept
// sessions, plus the typical flip gap. Unscored and unknown lines are left out of the counts.
export function uwGammaScore(rows, { session = null } = {}) {
  const out = {};
  for (const r of rows || []) {
    if (!r?.ok || (session && r.session !== session)) continue;
    const s = (out[r.symbol] ??= { sessions: 0, checks: {}, flipGaps: [], first: r.date, last: r.date });
    s.sessions++;
    if (r.date < s.first) s.first = r.date;
    if (r.date > s.last) s.last = r.date;
    for (const c of r.checks || []) {
      if (!c.score || c.state === 'unknown' || c.state === 'same_source') continue;
      const t = (s.checks[c.name] ??= { agree: 0, of: 0 });
      t.of++;
      if (c.state === 'match' || c.state === 'near') t.agree++;
      if (c.name === 'flip' && num(c.ours) != null && num(c.theirs) != null && r.spot > 0) s.flipGaps.push(Math.abs(c.ours - c.theirs) / r.spot * 100);
    }
  }
  for (const s of Object.values(out)) {
    s.medianFlipGapPct = s.flipGaps.length ? +median(s.flipGaps).toFixed(2) : null;
    delete s.flipGaps;
  }
  return out;
}
