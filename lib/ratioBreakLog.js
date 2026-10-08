// lib/ratioBreakLog.js — the Ratios break log, kept in Redis (lib/ratioBreaks.js for the stages).
//
// APPEND-ONLY, like the decision log: one record per break, keyed by ratio, direction and day-1
// date. Each run recomputes every break from two years of closes and MERGES — a record is filled in
// and moved up a stage, never removed — so the log keeps breaks older than the closes it is built
// from. The first run is the backfill. Market data only: ratios of public prices and SPY for
// context. Nothing here reads a position or the book, so the log is served publicly.
import { kvGetJson, kvSetJson, kvConfigured } from './kv.js';
import { yahooDailyCloses } from './yahoo.js';
import { CARDS, LEGS, ratioSeries, staleness } from './ratios.js';
import { breakTimeline, mergeBreakLogs } from './ratioBreaks.js';

export const BREAKS_KEY = 'dvcap:ratios:breaks:v1';
export const MAX_BREAKS = 1500;   // ~180 breaks in two years across seven ratios; well inside a Redis value

export async function readBreakLog() {
  if (!kvConfigured()) return { log: [], at: null, available: false };
  const s = await kvGetJson(BREAKS_KEY).catch(() => null);
  return { log: Array.isArray(s?.log) ? s.log : [], at: s?.at || null, available: true };
}

// Every card's breaks from its closes. A card with a leg behind is skipped, not guessed.
export function freshBreaks(closes = {}, { now = Date.now() } = {}) {
  const spy = (closes.SPY || []).map(([d, v]) => ({ d, v }));
  return CARDS.flatMap(c => (staleness(c, closes, { now }) ? [] : breakTimeline(ratioSeries(c, closes).points, { ratio: c.short, spy }).breaks));
}

export async function updateBreakLog({ now = Date.now() } = {}) {
  const closes = {};
  for (let i = 0; i < LEGS.length; i += 3) {
    if (i > 0) await new Promise(r => setTimeout(r, 120));
    await Promise.all(LEGS.slice(i, i + 3).map(async (s) => { const d = await yahooDailyCloses(s, '2y').catch(() => null); closes[s] = d?.ok ? d.closes : []; }));
  }
  const fresh = freshBreaks(closes, { now });
  const prev = await readBreakLog();
  const log = mergeBreakLogs(prev.log, fresh).slice(0, MAX_BREAKS);
  const at = new Date(now).toISOString();
  const written = prev.available ? !!(await kvSetJson(BREAKS_KEY, { log, at }).catch(() => false)) : false;
  return { ok: true, at, fresh: fresh.length, stored: prev.log.length, total: log.length, written,
           skipped: CARDS.filter(c => staleness(c, closes, { now })).map(c => c.short) };
}
