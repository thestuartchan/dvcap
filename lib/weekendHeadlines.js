// lib/weekendHeadlines.js — the weekend headlines for the Global Macro weekend edition (23 Nov 2026).
//
// WHY A DOOR. The headlines come from Stu's TradingView news connector, which only a Claude session
// holds — dvcap's server has no news feed, and reading TradingView's private site API from the server
// would be scraping it. So a scheduled task (Sunday 17:50 ET) reads the connector, writes each story as
// one line in its own words with the provider named, and POSTs them here. The weekend edition
// (api/preread.js runGlobal, Sunday 18:20 ET) prints them when they are for the Friday close it
// covers and fresh; otherwise it posts without them.
//
// THE DOOR. POST /api/flex-sync?headlines=weekend with the journal read key (the key the session's
// environment sends to /api/flex-sync only). Bounds: 3–8 items, each a line of at most 160 characters
// and a named provider; the Friday they follow; nothing else. GET reads back what is stored.
// Worst case if the key leaked: wrong lines in one weekend post, labelled with their provider.
import { kvGetJson, kvSetJson, kvConfigured } from './kv.js';
import { hasJournalReadKey } from './apiauth.js';

export const HEADLINES_KEY = 'dvcap:headlines:weekend:v1';
export const MAX_ITEMS = 8, MIN_ITEMS = 3, MAX_LINE = 160;
export const FRESH_HOURS = 6;

// → { ok: true, doc } | { ok: false, error }
export function validateHeadlines(body = {}, { now = new Date() } = {}) {
  const forSession = String(body.forSession || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(forSession)) return { ok: false, error: 'forSession must be the Friday (YYYY-MM-DD)' };
  if (new Date(`${forSession}T12:00:00Z`).getUTCDay() !== 5) return { ok: false, error: `${forSession} is not a Friday` };
  if (forSession > now.toISOString().slice(0, 10)) return { ok: false, error: 'forSession is in the future' };
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length < MIN_ITEMS || items.length > MAX_ITEMS) return { ok: false, error: `${MIN_ITEMS}–${MAX_ITEMS} items, got ${items.length}` };
  const clean = [];
  for (const it of items) {
    const line = String(it?.line || '').replace(/\s+/g, ' ').trim();
    const provider = String(it?.provider || '').replace(/\s+/g, ' ').trim();
    if (!line || line.length > MAX_LINE) return { ok: false, error: `each line must be 1–${MAX_LINE} characters` };
    if (!provider || provider.length > 40) return { ok: false, error: 'each line needs its provider' };
    if (/https?:\/\/|<@|@everyone|@here/i.test(line + provider)) return { ok: false, error: 'no links or mentions' };
    clean.push({ line, provider });
  }
  return { ok: true, doc: { forSession, items: clean, at: now.toISOString() } };
}

// The lines the weekend edition prints, or null when the stored set is for another Friday or stale.
export function headlineLines(doc, session, { now = new Date() } = {}) {
  if (!doc || doc.forSession !== session || !Array.isArray(doc.items) || !doc.items.length) return null;
  if (now - new Date(doc.at) > FRESH_HOURS * 3600e3) return null;
  return doc.items.map(it => `${it.line} _(${it.provider})_`);
}

export async function readHeadlines() {
  if (!kvConfigured()) return null;
  return kvGetJson(HEADLINES_KEY).catch(() => null);
}

export async function headlinesRoute(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!hasJournalReadKey(req)) return res.status(401).json({ error: 'not authorised for headlines' });
  if (!kvConfigured()) return res.status(500).json({ error: 'store not configured' });
  if (req.method === 'GET') return res.status(200).json({ ok: true, doc: await readHeadlines() });
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'the body is not JSON' }); } }
  const v = validateHeadlines(body || {});
  if (!v.ok) return res.status(422).json({ error: v.error });
  const ok = await kvSetJson(HEADLINES_KEY, v.doc);
  return ok ? res.status(200).json({ ok: true, saved: v.doc.items.length, forSession: v.doc.forSession }) : res.status(502).json({ error: 'the store did not take the write' });
}
