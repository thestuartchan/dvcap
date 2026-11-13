// lib/routes/flow.js — /api/flow: the Unusual Whales flow snapshot (build step 8, lib/uw.js).
//
// LICENSED FOR PERSONAL USE. Every data answer is gated by authorised() — the dashboard session
// cookie or the scheduler's service key. The one public answer, ?health=1, says which parts loaded
// and when, never a number. The snapshot lives in Redis under its own keys, which are NOT documents
// (lib/docStore.js DOCS) and so never reach the public data-backup branch.
//
//   GET /api/flow            the latest snapshot, refreshed when older than 3 minutes (session)
//   GET /api/flow?fresh=1    force a new snapshot (session)
//   GET /api/flow?daily=1    the kept daily rows for the 60-day scorecard (session)
//   GET /api/flow?snapshot=1[&close=1]   scheduler jobs uw-flow / uw-close (service key); close keeps
//                            the day's row and posts the PRIVATE close card (lib/alerts.js `flow`)
//   GET /api/flow?intraday=1&symbol=QQQ   the 0DTE flow chart's points (session), cached ~50 s per symbol
//                            so open tabs never multiply the calls
//   GET /api/flow?vol=1[&fresh=1]   volatility & earnings for QQQ, SPY and the Desk's US tickers (session),
//                            built once per New York day (UW's earnings-calendar screen, labelled as UW's)
//   GET /api/flow?gamma=1    step 11: UW's gamma board scored against dvcap's at each capture (session):
//                            the latest rows per symbol and the running agreement score
//   GET /api/flow?scorecard=1   step 13: the 60-day keep / downgrade / cancel scorecard so far (session)
//   GET /api/flow?shorts=1[&fresh=1]   short interest, borrow, short volume, FTDs for the Desk's names (session), once a NY day
//   GET /api/flow?potus=posts|schedule   scheduler jobs potus-posts / potus-schedule (service key): Trump's
//                            market-relevant posts and the morning schedule card, PRIVATE channel (lib/potus.js)
//   GET /api/flow?health=1   public: part names, ok flags, time, usage counts
import { authorised, refusalReason } from '../apiauth.js';
import { kvGetJson, kvSetJson, kvConfigured } from '../kv.js';
import { uwConfigured, uwGet, flowSnapshot, healthOf, dailyRow, closeCard, intradaySnapshot, uwUsage, UW_TICKERS, volBoard, deskTickers, namesBoard, namesCard, snapNameRows, UW_NAMES_KEY, nyDayOf } from '../uw.js';
import { DESK_RULES_KEY } from '../deskRules.js';
import { sendAlert, webhookFor } from '../alerts.js';
import { post } from '../discord.js';
import { UW_GAMMA_KEY, UW_GAMMA_HEALTH_KEY, uwGammaScore } from '../uwGamma.js';
import { scorecard, scorecardCard, outcomesOf, SCORECARD } from '../uwScorecard.js';
import { yahooDailyOHLC } from '../yahoo.js';
import { shortsBoard, darkpoolAtLevels, darkpoolCard, sectorFlow } from '../uwExtras.js';
import { newPosts, postsCard, scheduleOf, scheduleCard } from '../potus.js';

export const UW_SNAP_KEY = 'dvcap:uw:snap:v1';
export const UW_DAILY_KEY = 'dvcap:uw:daily:v1';
export const UW_DAILY_MAX = 130;
export const FRESH_MS = 3 * 60 * 1000;
export const UW_INTRADAY_KEY = (t) => `dvcap:uw:intraday:v1:${t}`;
export const UW_INTRADAY_HEALTH_KEY = 'dvcap:uw:intraday:health:v1';
export const INTRADAY_FRESH_MS = 50 * 1000;
export const UW_VOL_KEY = 'dvcap:uw:vol:v1';
export const UW_NAMES_POSTED_KEY = (day) => `dvcap:uw:names:posted:v1:${day}`;
export const UW_VOL_HEALTH_KEY = 'dvcap:uw:vol:health:v1';

// ── After the main build (11 Nov): shorts, dark pool at the Desk's levels, sector flow (lib/uwExtras.js) ──
export const UW_SHORTS_KEY = 'dvcap:uw:shorts:v1';
export const UW_SHORTS_HEALTH_KEY = 'dvcap:uw:shorts:health:v1';
export const UW_DP_POSTED_KEY = (day) => `dvcap:uw:darkpool:posted:v1:${day}`;
async function shortsFresh(kv, force = false) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  let board = kv.configured() ? await kv.get(UW_SHORTS_KEY).catch(() => null) : null;
  if (board && board.day === today && !force) return board;
  const mirror = kv.configured() ? await kv.get(DESK_RULES_KEY).catch(() => null) : null;
  board = await shortsBoard({ tickers: deskTickers(mirror).filter(t => !UW_TICKERS.includes(t)), get: (path, o = {}) => uwGet(path, o) });
  if (kv.configured()) {
    await kv.set(UW_SHORTS_KEY, board).catch(() => {});
    const tally = {};
    for (const r of board.rows) for (const [k, v] of Object.entries(r.parts)) { tally[k] ??= {}; tally[k][v] = (tally[k][v] || 0) + 1; }
    await kv.set(UW_SHORTS_HEALTH_KEY, { at: board.at, rows: board.rows.length, parts: tally }).catch(() => {});
  }
  return board;
}
// After the close: one private card when $1M+ dark-pool prints sat near a Desk level. Words only.
export async function darkpoolOut({ kv = defaultKv, deliver = post, env = process.env, now = new Date(), get = (path, o = {}) => uwGet(path, o) } = {}) {
  const mirror = kv.configured() ? await kv.get(DESK_RULES_KEY).catch(() => null) : null;
  const day = nyDayOf(now);
  const res = await darkpoolAtLevels({ mirror, get, day });
  if (!res.levels) return 'no Desk levels';
  const card = darkpoolCard(res);
  if (!card) return `nothing near ${res.levels} levels`;
  if (kv.configured() && await kv.get(UW_DP_POSTED_KEY(day)).catch(() => null)) return 'already sent today';
  const sent = await sendAlert({ source: 'flow', payload: card, items: [{ ruleId: 'flow:darkpool', title: `Dark pool at Desk levels ${day}` }] },
    { deliver, kv: kv.configured() ? kv : null, env, now }).catch(() => ({ ok: false }));
  if (sent.ok && kv.configured()) await kv.set(UW_DP_POSTED_KEY(day), true).catch(() => {});
  return sent.ok ? 'posted' : 'not posted';
}
// The sector ETF board onto a snapshot, failing alone like every other part.
export async function withSectors(snap, get = (path, o = {}) => uwGet(path, o)) {
  if (!snap) return snap;
  try { const v = sectorFlow(await get('/api/market/sector-etfs')); snap.sectors = v; snap.parts = { ...snap.parts, sectors: v ? 'ok' : 'empty' }; }
  catch (e) { snap.sectors = null; snap.parts = { ...snap.parts, sectors: String(e?.message || e).slice(0, 40) }; }
  snap.ok = Object.values(snap.parts).filter(v => v === 'ok').length; snap.of = Object.keys(snap.parts).length;
  return snap;
}

// ── TRUMP POSTS AND SCHEDULE (13 Nov 2026) ── private channel only; answers carry counts and words.
export const POTUS_LAST_KEY = 'dvcap:potus:last:v1';
export const POTUS_SCHEDULE_POSTED_KEY = 'dvcap:potus:schedule:posted:v1';
export const POTUS_BACKFILL_KEY = 'dvcap:potus:backfill:v1';
export const POTUS_BACKFILL_DAYS = 7;
// The Trump channel, or the private one while its webhook is unset (lib/alerts.js CHANNELS.trump).
const potusHook = (env) => webhookFor('trump', env) || webhookFor('private', env);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// ONCE, when the Trump channel is first set (Stu, 13 Nov: "post any … that would have made it into the
// channel this past week"): the last 7 days' market-relevant posts, oldest first, ten to a message.
export async function potusBackfill({ kv, deliver, env, now, get, tickers, pause = 1200 }) {
  const since = now.getTime() - POTUS_BACKFILL_DAYS * 86400000;
  const posts = newPosts(await get('/api/potus/posts', { query: { limit: 200 } }), { since, tickers }).filter(p => p.why.length);
  let sent = 0;
  for (let i = 0; i < posts.length; i += 10) {
    const card = postsCard(posts.slice(i, i + 10));
    if (!card) continue;
    const r = await sendAlert({ source: 'potus', payload: card, items: card.embeds.map(() => ({ ruleId: 'potus:backfill', title: 'Trump post (past week)' })) },
      { deliver, kv, env, now, webhook: potusHook(env) }).catch(() => ({ ok: false }));
    if (!r.ok) return { sent, failed: true };
    sent += card.embeds.length;
    if (i + 10 < posts.length) await sleep(pause);
  }
  return { sent, failed: false };
}
export async function potusPostsOut({ kv = defaultKv, deliver = post, env = process.env, now = new Date(), get = (path, o = {}) => uwGet(path, o) } = {}) {
  if (!kv.configured()) return { ok: false, why: 'Redis unavailable' };
  const answer = await get('/api/potus/posts', { query: { limit: 50 } });
  const last = await kv.get(POTUS_LAST_KEY).catch(() => null);
  const mirror = await kv.get(DESK_RULES_KEY).catch(() => null);
  const tickers = deskTickers(mirror);
  // The past week, once, as soon as the Trump channel exists; then the ordinary run from the mark.
  if (webhookFor('trump', env) && !(await kv.get(POTUS_BACKFILL_KEY).catch(() => null))) {
    const b = await potusBackfill({ kv, deliver, env, now, get, tickers });
    if (b.failed) return { ok: false, backfill: b.sent, why: 'backfill not accepted by Discord' };
    await kv.set(POTUS_BACKFILL_KEY, { at: now.toISOString(), sent: b.sent }).catch(() => {});
    const newestAll = newPosts(answer, {}).at(-1)?.at;
    if (newestAll) await kv.set(POTUS_LAST_KEY, { at: newestAll }).catch(() => {});
    return { ok: true, backfill: b.sent };
  }
  const posts = newPosts(answer, { since: Number(last?.at) || 0, tickers });
  const newest = posts.length ? posts[posts.length - 1].at : null;
  // The first run sets the mark without sending: no backlog flood.
  if (!last) { await kv.set(POTUS_LAST_KEY, { at: newest ?? Date.now() }).catch(() => {}); return { ok: true, posts: posts.length, sent: 0, first: true }; }
  const card = postsCard(posts);
  let sent = 0;
  if (card) {
    const r = await sendAlert({ source: 'potus', payload: card, items: card.embeds.map((e, i) => ({ ruleId: `potus:${posts.filter(p => p.why.length)[i]?.at}`, title: 'Trump post' })) },
      { deliver, kv, env, now, webhook: potusHook(env) }).catch(() => ({ ok: false }));
    if (!r.ok) return { ok: false, posts: posts.length, why: 'not posted (private webhook unset or Discord refused)' };
    sent = card.embeds.length;
  }
  if (newest) await kv.set(POTUS_LAST_KEY, { at: newest }).catch(() => {});
  return { ok: true, posts: posts.length, sent };
}
export async function potusScheduleOut({ kv = defaultKv, deliver = post, env = process.env, now = new Date(), get = (path, o = {}) => uwGet(path, o) } = {}) {
  const sched = scheduleOf(await get('/api/potus/schedule', { query: { limit: 200 } }));
  if (!sched.day) return { ok: true, sent: 0, why: 'no schedule yet' };
  if (kv.configured() && (await kv.get(POTUS_SCHEDULE_POSTED_KEY).catch(() => null)) === sched.day) return { ok: true, sent: 0, why: 'already sent' };
  const card = scheduleCard(sched);
  if (!card) return { ok: true, sent: 0, why: 'nothing on it' };
  const r = await sendAlert({ source: 'potus', payload: card, items: [{ ruleId: `potus:schedule:${sched.day}`, title: `Trump schedule ${sched.day}` }] },
    { deliver, kv: kv.configured() ? kv : null, env, now, webhook: potusHook(env) }).catch(() => ({ ok: false }));
  if (r.ok && kv.configured()) await kv.set(POTUS_SCHEDULE_POSTED_KEY, sched.day).catch(() => {});
  return { ok: !!r.ok, sent: r.ok ? 1 : 0, items: sched.items.length };
}

// Step 13: the scorecard from the kept rows, step 11's gamma readings and Yahoo's daily closes.
export const UW_SCORECARD_POSTED_KEY = 'dvcap:uw:scorecard:posted:v1';
export async function scorecardNow({ kv = defaultKv, bars = yahooDailyOHLC, now = new Date() } = {}) {
  const [rows, gammaRows] = kv.configured()
    ? await Promise.all([kv.get(UW_DAILY_KEY).catch(() => null), kv.get(UW_GAMMA_KEY).catch(() => null)]) : [null, null];
  const outcomes = {};
  for (const t of UW_TICKERS) outcomes[t] = outcomesOf(await bars(t, '1y').catch(() => []));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  return scorecard({ rows: Array.isArray(rows) ? rows : [], outcomes, gamma: uwGammaScore(Array.isArray(gammaRows) ? gammaRows : []), today });
}
// After the close: the scorecard card once, on day 60 or the first close after it. Words only.
export async function scorecardOut({ kv = defaultKv, deliver = post, env = process.env, now = new Date(), bars = yahooDailyOHLC } = {}) {
  if (!kv.configured()) return 'Redis unavailable';
  if (await kv.get(UW_SCORECARD_POSTED_KEY).catch(() => null)) return 'already sent';
  // Before day 60 there is nothing to send: count the days from the kept rows, no price fetch.
  const rows = await kv.get(UW_DAILY_KEY).catch(() => null);
  const first = Array.isArray(rows) && rows.length ? rows.map(r => r.date).filter(Boolean).sort()[0] : null;
  if (!first) return 'no flow days yet';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  const day = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 86400000) + 1;
  if (day < SCORECARD.days) return `day ${day} of ${SCORECARD.days}`;
  const sc = await scorecardNow({ kv, bars, now });
  if (!sc.due) return `day ${sc.day} of ${sc.of}`;
  const card = scorecardCard(sc);
  const sent = card ? await sendAlert({ source: 'flow', payload: card, items: [{ ruleId: 'flow:scorecard', title: 'UW 60-day scorecard' }] },
    { deliver, kv, env, now }).catch(() => ({ ok: false })) : { ok: false };
  if (sent.ok) await kv.set(UW_SCORECARD_POSTED_KEY, { at: now.toISOString() }).catch(() => {});
  return sent.ok ? 'posted' : 'not posted';
}

// The day's latest scored gamma reading per symbol (step 11), for the close card's gamma line.
export async function gammaToday(day, kv = defaultKv) {
  const rows = kv.configured() ? await kv.get(UW_GAMMA_KEY).catch(() => null) : null;
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) if (r?.ok && r.date === day && (!out[r.symbol] || r.at > out[r.symbol].at)) out[r.symbol] = r;
  return out;
}

const defaultKv = { configured: kvConfigured, get: kvGetJson, set: kvSetJson };

// Keep the day's row (one per date) and post the close card once. Returns what happened, in words.
export async function closeOut(snap, { kv = defaultKv, deliver = post, env = process.env, now = new Date() } = {}) {
  const row = dailyRow(snap);
  if (!row) return { daily: 'no tide: nothing kept', alert: 'not sent' };
  let rows = kv.configured() ? await kv.get(UW_DAILY_KEY).catch(() => null) : null;
  rows = Array.isArray(rows) ? rows : [];
  const had = rows.find(r => r.date === row.date);
  const today = { ...row, posted: !!had?.posted };
  const next = [...rows.filter(r => r.date !== row.date), today].sort((a, b) => a.date.localeCompare(b.date)).slice(-UW_DAILY_MAX);
  let alert = 'already sent today';
  if (!had?.posted) {
    const card = closeCard(snap, { gamma: await gammaToday(row.date, kv).catch(() => null) });
    const sent = card ? await sendAlert({ source: 'flow', payload: card, items: [{ ruleId: 'flow:close', title: `Flow at the close ${row.date}` }] },
      { deliver, kv: kv.configured() ? kv : null, env, now }).catch(() => ({ ok: false })) : { ok: false };
    alert = sent.ok ? 'posted' : 'not posted (private webhook unset or Discord refused)';
    if (sent.ok) today.posted = true;
  }
  const saved = kv.configured() ? !!(await kv.set(UW_DAILY_KEY, next).catch(() => false)) : false;
  return { daily: saved ? `kept (${next.length} days)` : 'not kept (Redis unavailable)', alert };
}

// Step 10: after the close, flow on the Desk's names (QQQ/SPY are on the close card already); one
// private card a day, only for names with notable flow. Returns words, never numbers.
export async function namesOut({ kv = defaultKv, deliver = post, env = process.env, now = new Date(), get = (path, o = {}) => uwGet(path, o), snap = null } = {}) {
  const mirror = kv.configured() ? await kv.get(DESK_RULES_KEY).catch(() => null) : null;
  const tickers = deskTickers(mirror).filter(t => !UW_TICKERS.includes(t));
  const board = tickers.length ? await namesBoard({ tickers, get, now }) : { day: nyDayOf(now), rows: [] };
  // Kept for the Desk close card (16:20): every name's row, notable or not, plus QQQ/SPY from the snapshot.
  if (kv.configured()) await kv.set(UW_NAMES_KEY, { day: board.day, rows: [...board.rows, ...snapNameRows(snap, board.day)] }).catch(() => {});
  if (!tickers.length) return { names: 0, alert: 'no Desk names' };
  const card = namesCard(board.rows, { day: board.day });
  if (!card) return { names: tickers.length, alert: 'nothing notable' };
  const key = UW_NAMES_POSTED_KEY(board.day);
  if (kv.configured() && await kv.get(key).catch(() => null)) return { names: tickers.length, alert: 'already sent today' };
  const sent = await sendAlert({ source: 'flow', payload: card, items: [{ ruleId: 'flow:names', title: `Flow on Desk names ${board.day}` }] },
    { deliver, kv: kv.configured() ? kv : null, env, now }).catch(() => ({ ok: false }));
  if (sent.ok && kv.configured()) await kv.set(key, true).catch(() => {});
  return { names: tickers.length, alert: sent.ok ? 'posted' : 'not posted' };
}

// The day's volatility board: built once per New York day (or on ?fresh=1).
async function volFresh(kv, force = false) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  let board = kv.configured() ? await kv.get(UW_VOL_KEY).catch(() => null) : null;
  if (board && board.day === today && !force) return board;
  const mirror = kv.configured() ? await kv.get(DESK_RULES_KEY).catch(() => null) : null;
  board = await volBoard({ tickers: deskTickers(mirror), get: (path, o = {}) => uwGet(path, o) });
  if (kv.configured()) {
    await kv.set(UW_VOL_KEY, board).catch(() => {});
    // Counts of part states and field NAMES only (no tickers, no numbers): to check UW's shapes.
    const tally = {};
    for (const r of board.rows) for (const [k, v] of Object.entries(r.parts)) { tally[k] ??= {}; tally[k][v] = (tally[k][v] || 0) + 1; }
    const names = (k) => [...new Set(board.rows.flatMap(r => r.fields?.[k] || []))].slice(0, 40);
    await kv.set(UW_VOL_HEALTH_KEY, { at: board.at, rows: board.rows.length, parts: tally, fields: { context: names('context'), earnings: names('earnings') }, usage: { ...uwUsage } }).catch(() => {});
  }
  return board;
}

// The 0DTE chart's snapshot for one symbol: the cached one while fresh, else a new one.
async function intradayFresh(sym, kv) {
  let snap = kv.configured() ? await kv.get(UW_INTRADAY_KEY(sym)).catch(() => null) : null;
  if (snap?.at && Date.now() - Date.parse(snap.at) <= INTRADAY_FRESH_MS) return snap;
  snap = await intradaySnapshot({ ticker: sym, get: (path, o = {}) => uwGet(path, o) });
  if (kv.configured()) {
    if (snap.ok > 0) await kv.set(UW_INTRADAY_KEY(sym), snap).catch(() => {});
    // Part states and usage counts only: what the public health answer may say.
    await kv.set(UW_INTRADAY_HEALTH_KEY, { at: snap.at, symbol: sym, parts: snap.parts, points: snap.points.length, usage: { ...uwUsage } }).catch(() => {});
  }
  return snap;
}

export default async function flow(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const kv = defaultKv;
  if (q.health) {
    const snap = kv.configured() ? await kv.get(UW_SNAP_KEY).catch(() => null) : null;
    const intraday = kv.configured() ? await kv.get(UW_INTRADAY_HEALTH_KEY).catch(() => null) : null;
    const vol = kv.configured() ? await kv.get(UW_VOL_HEALTH_KEY).catch(() => null) : null;
    const gamma = kv.configured() ? await kv.get(UW_GAMMA_HEALTH_KEY).catch(() => null) : null;
    const shorts = kv.configured() ? await kv.get(UW_SHORTS_HEALTH_KEY).catch(() => null) : null;
    return res.status(200).json({ ok: true, configured: uwConfigured(), last: healthOf(snap), intraday: intraday || null, vol: vol || null, gamma: gamma || null, shorts: shorts || null });
  }
  if (!(await authorised(req))) return res.status(401).json({ ok: false, error: 'unauthorised', why: refusalReason(req) });
  if (!uwConfigured()) return res.status(200).json({ ok: false, why: 'UW_API_KEY is not set on this deployment' });
  if (q.intraday) {
    const sym = String(q.symbol || '').toUpperCase();
    if (!UW_TICKERS.includes(sym)) return res.status(400).json({ ok: false, why: `symbol must be one of ${UW_TICKERS.join(', ')}` });
    const snap = await intradayFresh(sym, kv);
    return res.status(200).json({ ok: snap.ok > 0, snap, usage: { ...uwUsage } });
  }
  if (q.vol) {
    const board = await volFresh(kv, !!q.fresh);
    return res.status(200).json({ ok: true, board: { ...board, rows: board.rows.map(({ fields: _fields, ...r }) => r) }, usage: { ...uwUsage } });
  }
  if (q.potus) {
    try {
      const out = q.potus === 'schedule' ? await potusScheduleOut() : await potusPostsOut();
      return res.status(out.ok ? 200 : 502).json(out);
    } catch (e) { return res.status(502).json({ ok: false, why: String(e?.message || e).slice(0, 60) }); }
  }
  if (q.shorts) {
    return res.status(200).json({ ok: true, board: await shortsFresh(kv, !!q.fresh) });
  }
  if (q.scorecard) {
    return res.status(200).json({ ok: true, scorecard: await scorecardNow({ kv }) });
  }
  if (q.gamma) {
    const rows = kv.configured() ? await kv.get(UW_GAMMA_KEY).catch(() => null) : null;
    const all = Array.isArray(rows) ? rows : [];
    const latest = {};
    for (const r of all) if (r?.ok && (!latest[r.symbol] || r.at > latest[r.symbol].at)) latest[r.symbol] = r;
    return res.status(200).json({ ok: true, latest, score: uwGammaScore(all), sessions: all.length });
  }
  if (q.daily) {
    const rows = kv.configured() ? await kv.get(UW_DAILY_KEY).catch(() => null) : null;
    return res.status(200).json({ ok: true, rows: Array.isArray(rows) ? rows : [] });
  }
  let snap = kv.configured() ? await kv.get(UW_SNAP_KEY).catch(() => null) : null;
  const stale = !snap?.at || Date.now() - Date.parse(snap.at) > FRESH_MS;
  if (q.snapshot || q.fresh || stale) {
    snap = await withSectors(await flowSnapshot({ get: (path, o = {}) => uwGet(path, o) }));
    if (kv.configured() && snap.ok > 0) await kv.set(UW_SNAP_KEY, snap).catch(() => {});
  }
  if (q.snapshot) {
    // The scheduler's answer carries part states only: job logs never hold UW numbers.
    const close = q.close ? await closeOut(snap) : null;
    const names = q.close ? await namesOut({ snap }).catch(() => ({ alert: 'failed' })) : null;
    const scorecardState = q.close ? await scorecardOut().catch(() => 'failed') : null;
    const darkpool = q.close ? await darkpoolOut().catch(() => 'failed') : null;
    // In-session runs also refresh the 0DTE chart's data, so its health is known without a viewer.
    if (!q.close) {
      for (const sym of UW_TICKERS) await intradayFresh(sym, kv).catch(() => null);
      await volFresh(kv).catch(() => null);   // once a day: a no-op after the first in-session run
      await shortsFresh(kv).catch(() => null);   // once a day too
    }
    return res.status(snap.ok > 0 ? 200 : 502).json({ ok: snap.ok > 0, health: healthOf(snap), close, names, scorecard: scorecardState, darkpool });
  }
  return res.status(200).json({ ok: snap.ok > 0, snap });
}
