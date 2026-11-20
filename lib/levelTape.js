// lib/levelTape.js — THE LEVEL TAPE: three gamma books, captured through the session, graded after
// the close on how price actually treated each level (Stu's call, 18 Nov 2026).
//
// WHY. dvcap's settled-OI levels and UW's flow levels disagree by design: one is the book that
// settled last night, the other is the positioning today's ask/bid-sided trades built (UW's
// "directionalized volume", its default source=vol). Agreement between them (lib/uwGamma.js) says
// nothing about which one price RESPECTS. This does.
//
// WHAT IS CAPTURED, every 15 minutes 09:45–15:45 ET, per name:
//   dvcap   settled OI repriced at the live spot (lib/gexStore.js settledGex): call wall on dvcap's
//           definition, put support, the flip
//   uwFlow  UW /gex-levels source=vol: call wall, put wall, flip, magnet
//   uwOi    UW /gex-levels source=oi: the same four on open interest
//   prem    watch names only: UW net premium (net-prem-ticks), to see how the name is trading
// The book pair (QQQ, SPY) always; up to WATCH_MAX names Stu adds for today and the next session.
//
// THE RULE ("Standard", chosen by Stu), graded on 5-minute regular-session bars:
//   tested   a bar's range comes within 0.1% of the level
//   broke    from the test bar through the next 30 minutes, a 5-min CLOSE goes through the level by
//            more than 0.1%
//   held     no such close, and within those 30 minutes price moves 0.2%+ away on the side it came from
//   stalled  tested, neither of the above (also: a test too late in the day to finish its window)
//   untested never reached by the close
// A level is graded once a day, from the first capture that named it; a later capture naming a
// level within 0.1% of it is the same level.
//
// LICENCE. Every UW number here is personal-use. The tape, the grades and the tallies live under
// their own Redis keys (not documents, so never in the public data backup) and are read only through
// the gated /api/gex?tape= routes (dashboard session or the scheduler's service key). Job answers
// carry counts and part states, never a level, a premium or a watched name.
import HOLIDAYS from '../data/holidays.json' with { type: 'json' };
import { gexLevelsOf, netPremSummary, uwUsage } from './uw.js';
import { localDateStr, localMinutesOfDay } from './sessions.js';

export const TAPE_RULE = Object.freeze({ testPct: 0.1, throughPct: 0.1, bouncePct: 0.2, windowMin: 30, barMin: 5 });
export const TAPE_EVERY_MIN = 15;
export const TAPE_FIRST = '09:45';
export const TAPE_LAST = '15:45';
export const BOOK_SYMBOLS = Object.freeze(['QQQ', 'SPY']);
export const WATCH_MAX = 3;
export const WATCH_ROOT_RE = /^[A-Z]{1,6}$/;
// Past this share of UW's daily allowance the tape stops asking UW (dvcap's own levels still run).
export const UW_BUDGET_SHARE = 0.8;
export const SOURCES = Object.freeze(['dvcap', 'uwFlow', 'uwOi']);
export const SOURCE_LABEL = Object.freeze({ dvcap: 'dvcap · settled OI', uwFlow: 'UW · flow', uwOi: 'UW · OI' });
export const KINDS = Object.freeze(['callWall', 'putWall', 'flip', 'magnet']);
export const KIND_LABEL = Object.freeze({ callWall: 'Call wall', putWall: 'Put wall', flip: 'Flip', magnet: 'Magnet' });
export const OUTCOMES = Object.freeze(['held', 'broke', 'stalled', 'untested']);

export const WATCH_KEY = 'dvcap:watch:v1';
export const TAPE_KEY = (sym, date) => `dvcap:levels:tape:v1:${sym}:${date}`;
export const TAPE_INDEX_KEY = (date) => `dvcap:levels:index:v1:${date}`;
export const TAPE_TTL_S = 21 * 86400;
export const TAPE_MAX_CAPTURES = 40;
export const SCORE_DAY_KEY = (date) => `dvcap:levels:score:v1:${date}`;
export const SCORE_DAY_TTL_S = 45 * 86400;
export const SCORE_AGG_KEY = 'dvcap:levels:agg:v1';
export const SCORE_AGG_DAYS = 130;
export const TAPE_HEALTH_KEY = 'dvcap:levels:health:v1';

const NY = 'America/New_York';
const num = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : null; };
const US_CLOSED = new Set(HOLIDAYS?.US?.closed || []);
export const nyDay = (now = new Date()) => localDateStr(NY, now instanceof Date ? now : new Date(now));
const short = (v) => String(v ?? '').replace(/\s+/g, ' ').slice(0, 60);

// ── THE WATCH LIST ───────────────────────────────────────────────────────────
// The next US session after `day` (weekends and data/holidays.json closures skipped).
export function nextSession(day, closed = US_CLOSED) {
  let t = Date.parse(`${day}T12:00:00Z`);
  for (let i = 0; i < 10; i++) {
    t += 86400000;
    const d = new Date(t), iso = d.toISOString().slice(0, 10), dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !closed.has(iso)) return iso;
  }
  return null;
}

export const activeWatch = (watch, today) => (Array.isArray(watch?.names) ? watch.names : [])
  .filter(n => n?.symbol && n.until && n.until >= today);

// Add a name for today and the next session. A name already on is extended, not duplicated.
// Returns { ok, watch, why }. `earnings` is whatever the earnings feed said ({date, time, status}).
export function addToWatch(watch, symbol0, { today, until = null, earnings = null, at = new Date().toISOString() } = {}) {
  const symbol = String(symbol0 || '').trim().toUpperCase();
  if (!WATCH_ROOT_RE.test(symbol)) return { ok: false, why: 'not an options root — letters only, up to six' };
  if (BOOK_SYMBOLS.includes(symbol)) return { ok: false, why: `${symbol} is on the tape already` };
  const end = until || nextSession(today) || today;
  const live = activeWatch(watch, today);
  const had = live.find(n => n.symbol === symbol);
  if (!had && live.length >= WATCH_MAX) return { ok: false, why: `${WATCH_MAX} names on already — remove one first` };
  const entry = { symbol, added: had?.added || at, from: had?.from || today, until: had && had.until > end ? had.until : end,
                  earnings: earnings?.date ? { date: earnings.date, time: earnings.time || null, status: earnings.status || null } : (had?.earnings || null) };
  const names = [...live.filter(n => n.symbol !== symbol), entry].sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { ok: true, watch: { names, at }, entry };
}

export function removeFromWatch(watch, symbol0, { today, at = new Date().toISOString() } = {}) {
  const symbol = String(symbol0 || '').trim().toUpperCase();
  const live = activeWatch(watch, today);
  const names = live.filter(n => n.symbol !== symbol);
  return { ok: names.length < live.length, watch: { names, at }, why: names.length < live.length ? null : `${symbol} is not on the watch list` };
}

// ── ONE CAPTURE ──────────────────────────────────────────────────────────────
// dvcap's levels off a settledGex answer: dvcap's own call wall and put support where solved, the
// raw heaviest strikes otherwise; the flip as solved. dvcap names no magnet.
export function dvcapLevelsOf(out) {
  if (!out?.ok) return null;
  const row = out.row || {}, lv = out.levels || {};
  const L = { callWall: num(lv.callWall?.strike ?? row.callWall), putWall: num(lv.support?.strike ?? row.putWall), flip: num(row.flipLevel), magnet: null };
  return Object.values(L).some(v => v != null) ? L : null;
}
const uwLevels = (answer) => {
  const g = gexLevelsOf(answer);
  return g ? { callWall: g.callWall, putWall: g.putWall, flip: g.flip, magnet: g.magnet, time: g.time || null } : null;
};
const premOf = (answer) => {
  const p = netPremSummary(answer);
  return p ? { net: p.net, netCall: p.netCall, netPut: p.netPut, ticks: p.ticks, at: p.at } : null;
};

export const uwBudgetOk = (usage = uwUsage, share = UW_BUDGET_SHARE) =>
  !(Number.isFinite(usage?.limit) && usage.limit > 0 && Number.isFinite(usage?.today) && usage.today >= usage.limit * share);

// deps: { spotOf(sym) → number|null, settled(sym, {spot}) → settledGex answer, uw(path, opts) | null,
//         budgetOk() → bool }. Never throws: each part fails alone and says so in `parts`.
export async function captureOne(symbol, { now = new Date(), book = false, deps } = {}) {
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const parts = {};
  const spot0 = await Promise.resolve().then(() => deps.spotOf(symbol)).catch(() => null);
  let dvcap = null, spot = num(spot0);
  try {
    const out = await deps.settled(symbol, { spot });
    dvcap = dvcapLevelsOf(out);
    if (dvcap && out?.mode === 'repriced') dvcap.mode = 'repriced';
    if (spot == null) spot = num(out?.row?.spot);
    parts.dvcap = dvcap ? (out?.mode === 'repriced' ? 'ok (repriced)' : 'ok') : `failed: ${short(out?.reason || 'no levels')}`;
  } catch (e) { parts.dvcap = `failed: ${short(e?.message || e)}`; }
  let uwFlow = null, uwOi = null, prem = null;
  if (!deps.uw) parts.uw = 'skipped: UW_API_KEY unset';
  else if (!deps.budgetOk()) parts.uw = `skipped: over ${Math.round(UW_BUDGET_SHARE * 100)}% of UW's daily allowance`;
  else {
    const T = encodeURIComponent(symbol);
    const one = async (name, fn) => { try { const v = await fn(); parts[name] = v ? 'ok' : 'empty'; return v; } catch (e) { parts[name] = `failed: ${short(e?.message || e)}`; return null; } };
    [uwFlow, uwOi, prem] = await Promise.all([
      one('uwFlow', async () => uwLevels(await deps.uw(`/api/stock/${T}/gex-levels`, { query: { source: 'vol' }, timeoutMs: 8000 }))),
      one('uwOi', async () => uwLevels(await deps.uw(`/api/stock/${T}/gex-levels`, { query: { source: 'oi' }, timeoutMs: 8000 }))),
      book ? Promise.resolve(null) : one('prem', async () => premOf(await deps.uw(`/api/stock/${T}/net-prem-ticks`, { timeoutMs: 8000 }))),
    ]);
  }
  return { at, spot, dvcap, uwFlow, uwOi, ...(book ? {} : { prem }), parts };
}

// Append a capture to the day's tape, one per 5-minute slot (a re-run replaces its own slot).
export function appendCapture(tape, cap, { symbol, date } = {}) {
  const t = tape && Array.isArray(tape.captures) ? tape : { symbol, date, captures: [] };
  const slot = (iso) => Math.floor(Date.parse(iso) / 300000);
  const caps = [...t.captures.filter(c => slot(c.at) !== slot(cap.at)), cap].sort((a, b) => a.at.localeCompare(b.at)).slice(-TAPE_MAX_CAPTURES);
  return { symbol: t.symbol || symbol, date: t.date || date, captures: caps };
}

// The scheduled capture. kv: { get, setEx(key, value, ttl), set }. Returns words and counts only.
export async function captureTape({ now = new Date(), kv, deps, isOpen = () => true } = {}) {
  if (!isOpen(now)) return { ok: true, skipped: 'US market not open' };
  const date = nyDay(now);
  const watch = activeWatch(await kv.get(WATCH_KEY).catch(() => null), date);
  const syms = [...BOOK_SYMBOLS, ...watch.map(n => n.symbol)];
  const caps = await Promise.all(syms.map(s => captureOne(s, { now, book: BOOK_SYMBOLS.includes(s), deps })));
  let kept = 0;
  for (let i = 0; i < syms.length; i++) {
    const key = TAPE_KEY(syms[i], date);
    const next = appendCapture(await kv.get(key).catch(() => null), caps[i], { symbol: syms[i], date });
    if (await kv.setEx(key, next, TAPE_TTL_S).catch(() => false)) kept++;
  }
  const idx = await kv.get(TAPE_INDEX_KEY(date)).catch(() => null);
  await kv.setEx(TAPE_INDEX_KEY(date), [...new Set([...(Array.isArray(idx) ? idx : []), ...syms])], TAPE_TTL_S).catch(() => {});
  // Part states: the book pair by name (they are public), the watch names counted, never named.
  const tally = (c) => Object.values(c.parts).filter(v => v === 'ok').length + '/' + Object.keys(c.parts).length;
  const parts = Object.fromEntries(syms.map((s, i) => [BOOK_SYMBOLS.includes(s) ? s : `watch${i - BOOK_SYMBOLS.length + 1}`, caps[i].parts]));
  await kv.set(TAPE_HEALTH_KEY, { at: now.toISOString?.() || String(now), date, parts, usage: { today: uwUsage.today, limit: uwUsage.limit } }).catch(() => {});
  const good = caps.filter(c => c.dvcap || c.uwFlow || c.uwOi).length;
  return { ok: good > 0, ...(good ? {} : { why: 'no source answered for any name' }), names: syms.length, watched: watch.length, kept,
           parts: Object.fromEntries(Object.entries(parts).map(([k], i) => [k, tally(caps[i])])) };
}

// ── GRADING ──────────────────────────────────────────────────────────────────
// Yahoo bars ({t: unix seconds, o, h, l, c}) → the regular session of `date`, in order.
export function sessionBars(bars, date) {
  return (bars || []).filter(b => {
    if (![b?.t, b?.h, b?.l, b?.c].every(Number.isFinite)) return false;
    const d = new Date(b.t * 1000);
    if (localDateStr(NY, d) !== date) return false;
    const m = localMinutesOfDay(NY, d);
    return m >= 570 && m < 960;
  }).sort((a, b) => a.t - b.t);
}

// One level from one moment. side: +1 price above the level (it is support), −1 below (resistance).
export function gradeLevel({ level, spot = null, fromIso, bars, rule = TAPE_RULE }) {
  const L = num(level);
  if (L == null || !(L > 0)) return { outcome: null };
  const fromSec = Date.parse(fromIso) / 1000;
  const near = L * rule.testPct / 100, thr = L * rule.throughPct / 100, bnc = L * rule.bouncePct / 100;
  const i = bars.findIndex(b => b.t + rule.barMin * 60 > fromSec && b.l <= L + near && b.h >= L - near);
  if (i < 0) return { outcome: 'untested' };
  let side = Math.sign((num(spot) ?? NaN) - L);
  if (!side) side = Math.sign((i > 0 ? bars[i - 1].c : bars[i].o ?? bars[i].c) - L);
  const testAt = new Date(bars[i].t * 1000).toISOString();
  if (!side) return { outcome: 'stalled', testAt };
  const n = Math.round(rule.windowMin / rule.barMin);
  const win = bars.slice(i, i + n + 1);
  if (win.some(b => (side > 0 ? b.c < L - thr : b.c > L + thr))) return { outcome: 'broke', testAt };
  if (win.slice(1).some(b => (side > 0 ? b.h >= L + bnc : b.l <= L - bnc))) return { outcome: 'held', testAt };
  return { outcome: 'stalled', testAt };
}

// The day's distinct levels per source and kind, each from the first capture that named it.
export function levelsForDay(tape, rule = TAPE_RULE) {
  const out = [];
  for (const cap of [...(tape?.captures || [])].sort((a, b) => a.at.localeCompare(b.at))) {
    for (const src of SOURCES) {
      for (const kind of KINDS) {
        const L = num(cap?.[src]?.[kind]);
        if (L == null || !(L > 0)) continue;
        if (out.some(x => x.src === src && x.kind === kind && Math.abs(x.level - L) / L * 100 <= rule.testPct)) continue;
        out.push({ src, kind, level: L, at: cap.at, spot: num(cap.spot) });
      }
    }
  }
  return out;
}

export function scoreTape(tape, bars, rule = TAPE_RULE) {
  return levelsForDay(tape, rule).map(x => {
    const g = gradeLevel({ level: x.level, spot: x.spot, fromIso: x.at, bars, rule });
    return { ...x, distPct: x.spot > 0 ? +(((x.level - x.spot) / x.spot) * 100).toFixed(2) : null, outcome: g.outcome, testAt: g.testAt || null };
  }).filter(r => r.outcome);
}

const blank = () => ({ n: 0, held: 0, broke: 0, stalled: 0, untested: 0 });
export function tallyRows(rows) {
  const out = {};
  for (const r of rows || []) {
    const s = (out[r.src] ??= {});
    const k = (s[r.kind] ??= blank());
    k.n++; k[r.outcome] = (k[r.outcome] || 0) + 1;
  }
  return out;
}

// After the close: grade every name taped on `date` and fold the counts into the running tally.
// barsOf(sym) → Yahoo 5-minute bars covering the date.
export async function scoreDay({ date, kv, barsOf, rule = TAPE_RULE } = {}) {
  const syms = await kv.get(TAPE_INDEX_KEY(date)).catch(() => null);
  if (!Array.isArray(syms) || !syms.length) return { ok: true, date, scored: 0, why: 'no tape for the date' };
  const detail = {}, counts = {}, notes = {};
  for (const sym of syms) {
    const tag = BOOK_SYMBOLS.includes(sym) ? sym : 'watch';
    const tape = await kv.get(TAPE_KEY(sym, date)).catch(() => null);
    if (!tape?.captures?.length) { notes[tag] = 'no captures'; continue; }
    const bars = sessionBars(await Promise.resolve().then(() => barsOf(sym)).catch(() => []), date);
    if (bars.length < 12) { notes[tag] = 'too few session bars'; continue; }
    const rows = scoreTape(tape, bars, rule);
    detail[sym] = rows;
    counts[sym] = tallyRows(rows);
  }
  const n = Object.keys(detail).length;
  if (!n) return { ok: false, date, scored: 0, why: Object.values(notes)[0] || 'nothing to grade', retryable: true };
  await kv.setEx(SCORE_DAY_KEY(date), { date, rule, rows: detail }, SCORE_DAY_TTL_S).catch(() => {});
  const agg = (await kv.get(SCORE_AGG_KEY).catch(() => null)) || {};
  const days = { ...(agg.days || {}), [date]: counts };
  const keep = Object.keys(days).sort().slice(-SCORE_AGG_DAYS);
  await kv.set(SCORE_AGG_KEY, { rule, days: Object.fromEntries(keep.map(d => [d, days[d]])) }).catch(() => {});
  return { ok: true, date, scored: n, levels: Object.values(detail).reduce((a, r) => a + r.length, 0), ...(Object.keys(notes).length ? { notes } : {}) };
}

// ── THE SCORECARD ────────────────────────────────────────────────────────────
// Sum the per-day tallies for one group: a book symbol, or 'watch' (every other name pooled).
export function scoreSummary(agg, group) {
  const out = { days: 0, first: null, last: null, bySrc: {} };
  for (const [date, perSym] of Object.entries(agg?.days || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const syms = Object.keys(perSym || {}).filter(s => (group === 'watch' ? !BOOK_SYMBOLS.includes(s) : s === group));
    if (!syms.length) continue;
    out.days++; out.first ??= date; out.last = date;
    for (const s of syms) {
      for (const [src, kinds] of Object.entries(perSym[s] || {})) {
        for (const [kind, c] of Object.entries(kinds || {})) {
          const t = ((out.bySrc[src] ??= {})[kind] ??= blank());
          for (const k of Object.keys(blank())) t[k] += c[k] || 0;
        }
      }
    }
  }
  for (const kinds of Object.values(out.bySrc)) {
    const all = blank();
    for (const c of Object.values(kinds)) for (const k of Object.keys(all)) all[k] += c[k];
    kinds.all = all;
    for (const c of Object.values(kinds)) {
      const tested = c.n - c.untested;
      c.tested = tested;
      c.testRate = c.n ? +(tested / c.n * 100).toFixed(0) : null;
      c.holdRate = tested ? +(c.held / tested * 100).toFixed(0) : null;
      c.breakRate = tested ? +(c.broke / tested * 100).toFixed(0) : null;
    }
  }
  return out;
}

// The latest capture's three books side by side, for the panel.
export function latestBoard(tape) {
  const caps = tape?.captures || [];
  if (!caps.length) return null;
  const last = caps[caps.length - 1];
  // The last capture where each source answered, so one failed read does not blank a column.
  const pick = (src) => [...caps].reverse().find(c => c[src]) || null;
  const cols = Object.fromEntries(SOURCES.map(src => { const c = pick(src); return [src, c ? { ...c[src], at: c.at } : null]; }));
  const prem = [...caps].reverse().find(c => c.prem)?.prem || null;
  return { at: last.at, spot: last.spot, captures: caps.length, cols, prem,
           premPath: caps.filter(c => c.prem).map(c => ({ at: c.at, net: c.prem.net })) };
}
