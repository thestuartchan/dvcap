// lib/ismCalendar.js — ISM's PMIs as the economic calendar reports them, written once a month by a
// scheduled task, for when ISM's release page will not answer dvcap's server.
//
// WHY THIS EXISTS (20 Nov 2026). The growth axis reads ISM manufacturing from ISM's own release on
// PR Newswire (lib/ismFetch.js). Since November that page has answered dvcap's server with 403 while
// answering an ordinary client, which is a refusal, and a refusal is not worked around (no browser
// disguise, no proxy, no relaying the page through another machine). Instead a scheduled task reads
// the figure from Stu's own economic-calendar connector (TradingView, FMP as the fallback) on each
// release day and POSTs it here. It is stored under its own key — never in the hand-kept doc — and
// served as the ISM feed when PR Newswire fails. A month Stu types on the Growth axis card still
// outranks it (lib/ismFeed.js mergeIsm), as it outranks the release.
//
// THE DOOR. POST /api/macro?ism=calendar with the journal read key (x-journal-key), the one key the
// scheduled tasks' environment already sends to dvcap. It opens this one write and nothing more:
// one row per survey month, every index a diffusion reading (20–80), the release date no later than
// today and after the survey month, the headline no more than ISM_MAX_MOVE from the month before,
// and the calendar named. Worst case if the key leaked: a wrong ISM month, visible on the ledger
// as "from the calendar" and overwritten by a typed one.
import { kvGetJson, kvSetJson, kvConfigured } from './kv.js';
import { hasJournalReadKey } from './apiauth.js';

export const ISM_CALENDAR_KEY = 'dvcap:ism:calendar:v1';
export const ISM_CALENDAR_SOURCES = Object.freeze(['tradingview-calendar', 'fmp-calendar']);
export const ISM_MAX_MOVE = 10;     // points month to month: the largest ISM move on record is ~8
const KEEP = 36;

const idx = (v, name) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 20 || n > 80) throw new Error(`${name} ${v} is not a diffusion-index reading (20–80)`);
  return +n.toFixed(1);
};

// → { ok: true, row } | { ok: false, error }
export function validateCalendarRow(body = {}, { series = [], now = new Date() } = {}) {
  const period = String(body.period || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) return { ok: false, error: `survey month "${body.period}" is not YYYY-MM` };
  let manufacturing, newOrders, services;
  try {
    manufacturing = idx(body.manufacturing, 'manufacturing PMI');
    newOrders = idx(body.newOrders, 'new orders');
    services = idx(body.services, 'services PMI');
  } catch (e) { return { ok: false, error: e.message }; }
  if (manufacturing == null) return { ok: false, error: 'the manufacturing PMI headline is required' };
  const asOf = String(body.asOf || '').slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return { ok: false, error: `release date "${body.asOf}" is not YYYY-MM-DD` };
  if (asOf > today) return { ok: false, error: `release date ${asOf} is in the future` };
  if (asOf.slice(0, 7) <= period) return { ok: false, error: `release date ${asOf} is not after the survey month ${period}` };
  const source = String(body.source || '');
  if (!ISM_CALENDAR_SOURCES.includes(source)) return { ok: false, error: `source must be one of ${ISM_CALENDAR_SOURCES.join(', ')}` };
  const prior = [...series].filter(r => r.period < period).sort((a, b) => a.period.localeCompare(b.period)).at(-1);
  if (prior?.manufacturing != null && Math.abs(manufacturing - prior.manufacturing) > ISM_MAX_MOVE) {
    return { ok: false, error: `manufacturing ${manufacturing} is more than ${ISM_MAX_MOVE} points from ${prior.period}'s ${prior.manufacturing} — check the calendar` };
  }
  return { ok: true, row: { period, manufacturing, newOrders, services, asOf, source: 'calendar', via: source } };
}

export function mergeCalendarRow(series = [], row) {
  return [...series.filter(r => r.period !== row.period), row].sort((a, b) => a.period.localeCompare(b.period)).slice(-KEEP);
}

// The feed's shape (lib/ismFetch.js), so mergeIsm and the growth leg read it unchanged.
export function calendarAsFeed(stored) {
  const series = (stored?.series || []).filter(r => r?.period && r.manufacturing != null);
  const latest = series.at(-1) || null;
  return latest ? { ok: true, latest, series, at: stored.at ?? null, source: 'calendar' } : { ok: false, error: 'no calendar month stored' };
}

export async function readIsmCalendar() {
  if (!kvConfigured()) return { ok: false, error: 'store not configured' };
  try { return calendarAsFeed(await kvGetJson(ISM_CALENDAR_KEY)); }
  catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
}

export async function saveIsmCalendar(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!hasJournalReadKey(req)) return res.status(401).json({ error: 'not authorised for the ISM calendar entry' });
  if (!kvConfigured()) return res.status(500).json({ error: 'store not configured' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'the body is not JSON' }); } }
  const stored = (await kvGetJson(ISM_CALENDAR_KEY).catch(() => null)) || { series: [] };
  const v = validateCalendarRow(body || {}, { series: stored.series || [] });
  if (!v.ok) return res.status(422).json({ error: v.error });
  const next = { series: mergeCalendarRow(stored.series || [], v.row), at: new Date().toISOString() };
  const ok = await kvSetJson(ISM_CALENDAR_KEY, next);
  if (!ok) return res.status(502).json({ error: 'the store did not take the write' });
  return res.status(200).json({ ok: true, saved: v.row, months: next.series.length });
}
