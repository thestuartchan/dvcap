// lib/uwHistory.js — historical 1-minute bars for the noise-band research backtest (22 Nov 2026), read
// from Unusual Whales with the key dvcap already holds.
//
// WHY. Stu asked for a backtest of an intraday noise-band rule on SPY and QQQ with real option prices
// (scripts/noise-band-backtest.py). No free source reaches back far enough at one-minute resolution,
// and Stu chose Unusual Whales over a new paid feed. The research runs in a Claude session that has
// no UW key of its own, so it reads through this door.
//
// LICENCE. UW data is for Stu's personal use. This door answers only the journal read key (the key
// the session's environment sends to /api/flex-sync and nowhere else), never caches publicly, and the
// research keeps the raw rows and the results out of the repo. Nothing here is logged.
//
// THE DOOR. GET /api/flex-sync?uw=hist&kind=<kind>&date=YYYY-MM-DD with x-journal-key.
//   kind=ohlc     &ticker=SPY|QQQ     → UW /api/stock/{ticker}/ohlc/1m for that date
//   kind=option   &contract=<OSI>     → UW /api/option-contract/{id}/intraday for that date
// Only SPY and QQQ (and their options) can be asked for; the answer is UW's rows as they came, with
// UW's usage counts so the caller can pace itself.
import { uwConfigured, uwGet, uwUsage } from './uw.js';
import { hasJournalReadKey } from './apiauth.js';

export const HIST_TICKERS = Object.freeze(['SPY', 'QQQ']);
const OSI = /^(SPY|QQQ)(\d{6})([CP])(\d{8})$/;

// → { ok: true, path, query } | { ok: false, status, error }
export function histRequest(q = {}) {
  const date = String(q.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, status: 400, error: 'date must be YYYY-MM-DD' };
  if (date > new Date().toISOString().slice(0, 10)) return { ok: false, status: 400, error: 'date is in the future' };
  const kind = String(q.kind || '');
  if (kind === 'ohlc') {
    const t = String(q.ticker || '').toUpperCase();
    if (!HIST_TICKERS.includes(t)) return { ok: false, status: 400, error: `ticker must be one of ${HIST_TICKERS.join(', ')}` };
    return { ok: true, path: `/api/stock/${t}/ohlc/1m`, query: { date, limit: 2500 } };
  }
  if (kind === 'option') {
    const c = String(q.contract || '').toUpperCase();
    if (!OSI.test(c)) return { ok: false, status: 400, error: 'contract must be a SPY or QQQ option in OSI form (e.g. SPY261120C00690000)' };
    return { ok: true, path: `/api/option-contract/${c}/intraday`, query: { date } };
  }
  return { ok: false, status: 400, error: 'kind must be ohlc or option' };
}

export async function uwHistoryRoute(req, res, { get = uwGet } = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!hasJournalReadKey(req)) return res.status(401).json({ error: 'not authorised for UW history' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!uwConfigured()) return res.status(503).json({ error: 'UW_API_KEY unset' });
  const r = histRequest(req.query || {});
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  try {
    const data = await get(r.path, { query: r.query });
    return res.status(200).json({ ok: true, data, usage: { today: uwUsage.today, limit: uwUsage.limit } });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e?.message || e).slice(0, 40), usage: { today: uwUsage.today, limit: uwUsage.limit } });
  }
}
