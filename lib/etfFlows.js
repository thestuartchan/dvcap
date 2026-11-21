// lib/etfFlows.js — daily ETF inflows and outflows for the market recap, from Unusual Whales'
// /api/etfs/{ticker}/in-outflow (api.unusualwhales.com/docs, EtfController.in_outflow).
//
// WHY IT EXISTS (21 Nov 2026). The recap's "ETF Flows" section had only the bitcoin and ether spot
// funds (TrueNorth). Stu's UW key, which dvcap already holds server-side (lib/uw.js), reads the same
// creations-and-redemptions figure for any ETF. The recap is written by a scheduled task that has no
// UW key of its own, so it reads the flows through this door.
//
// LICENCE. UW data is for Stu's personal use. This door answers only the journal read key (the key
// the scheduled tasks' environment sends to /api/flex-sync and nowhere else), never caches publicly,
// and its numbers go to the private channel only (lib/privatePost.js). Nothing here is logged.
//
// THE DOOR. GET /api/flex-sync?uw=etf-flows[&date=YYYY-MM-DD] with x-journal-key. It reads a fixed
// list of ETFs (ETF_FLOW_TICKERS) — the caller cannot choose tickers — and answers each fund's flow
// on the day and over the five sessions to it. One UW call per fund; the answer is kept six hours
// per date so a retry does not spend the allowance again.
import { uwConfigured, uwGet } from './uw.js';
import { hasJournalReadKey } from './apiauth.js';
import { kvGetJson, kvSetJsonEx, kvConfigured } from './kv.js';

export const ETF_FLOW_TICKERS = Object.freeze([
  ['SPY', 'S&P 500'], ['VOO', 'S&P 500'], ['IVV', 'S&P 500'], ['QQQ', 'Nasdaq 100'], ['IWM', 'Russell 2000'],
  ['DIA', 'Dow'], ['VTI', 'Total market'], ['RSP', 'Equal-weight S&P'],
  ['XLK', 'Technology'], ['SMH', 'Semiconductors'], ['SOXX', 'Semiconductors'], ['IGV', 'Software'],
  ['XLF', 'Financials'], ['XLE', 'Energy'], ['XLV', 'Health care'], ['XLI', 'Industrials'],
  ['XLY', 'Consumer discretionary'], ['XLP', 'Consumer staples'], ['XLU', 'Utilities'], ['XLB', 'Materials'],
  ['XLRE', 'Real estate'], ['XLC', 'Communication services'],
  ['TLT', '20+ year Treasuries'], ['IEF', '7–10 year Treasuries'], ['SHY', '1–3 year Treasuries'],
  ['SGOV', 'T-bills'], ['BIL', 'T-bills'], ['TIP', 'TIPS'], ['HYG', 'High-yield credit'], ['LQD', 'Investment-grade credit'],
  ['GLD', 'Gold'], ['SLV', 'Silver'], ['USO', 'Oil'], ['IBIT', 'Bitcoin'], ['ETHA', 'Ether'],
  ['EEM', 'Emerging markets'], ['EFA', 'Developed ex-US'], ['FXI', 'China large caps'],
]);
export const ETF_FLOW_LABEL = Object.freeze(Object.fromEntries(ETF_FLOW_TICKERS));
export const FLOW_CACHE_TTL_S = 6 * 3600;
const CONCURRENCY = 6;

const num = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : null; };
const rowsOf = (a) => {
  if (Array.isArray(a)) return a;
  if (a && Array.isArray(a.data)) return a.data;
  if (a && a.data && Array.isArray(a.data.data)) return a.data.data;
  return null;
};

// The dollar flow of one row. UW names it change_prem (shares created or redeemed × price); a row
// with only the share change and the close is priced here; anything else is not a flow (null).
export function rowFlow(r) {
  for (const k of ['change_prem', 'net_flow', 'flow', 'net_inflow', 'flow_usd']) {
    const v = num(r?.[k]);
    if (v != null) return v;
  }
  const sh = num(r?.change), px = num(r?.close);
  return sh != null && px != null ? sh * px : null;
}

// → [{ date, flow }] oldest first, or null when the answer has no usable rows.
export function normaliseFlowRows(answer) {
  const rows = rowsOf(answer);
  if (!rows) return null;
  const out = rows.map(r => ({ date: String(r?.date || r?.trading_date || '').slice(0, 10), flow: rowFlow(r) }))
    .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.flow != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  return out.length ? out : null;
}

// One fund's day and five-session flow, on `date` or the last session before it.
export function fundSummary(ticker, rows, date) {
  const upto = (rows || []).filter(r => r.date <= date);
  if (!upto.length) return null;
  const last = upto.at(-1);
  const week = upto.slice(-5).reduce((s, r) => s + r.flow, 0);
  return { ticker, label: ETF_FLOW_LABEL[ticker] || ticker, date: last.date, day: Math.round(last.flow), week: Math.round(week) };
}

// Biggest inflows and outflows on the day (funds reporting that day only).
export function rankFlows(funds, n = 3) {
  const day = funds.filter(Boolean);
  const latest = day.reduce((m, f) => (f.date > m ? f.date : m), '');
  const same = day.filter(f => f.date === latest);
  const inflows = same.filter(f => f.day > 0).sort((a, b) => b.day - a.day).slice(0, n);
  const outflows = same.filter(f => f.day < 0).sort((a, b) => a.day - b.day).slice(0, n);
  return { date: latest || null, inflows, outflows };
}

const isoDay = (d) => d.toISOString().slice(0, 10);

export async function fetchEtfFlows({ date = isoDay(new Date()), tickers = ETF_FLOW_TICKERS.map(t => t[0]), get = uwGet } = {}) {
  const start = isoDay(new Date(Date.parse(`${date}T12:00:00Z`) - 12 * 86400000));
  const funds = [], missing = [];
  let fields = null;
  const queue = [...tickers];
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      try {
        const ans = await get(`/api/etfs/${t}/in-outflow`, { query: { start_date: start, end_date: date } });
        const raw = rowsOf(ans);
        if (!fields && raw?.length) fields = Object.keys(raw[0]).slice(0, 20);   // names only, to check the shape
        const s = fundSummary(t, normaliseFlowRows(ans), date);
        if (s) funds.push(s); else missing.push({ ticker: t, why: 'no rows' });
      } catch (e) { missing.push({ ticker: t, why: String(e?.message || e).slice(0, 40) }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  funds.sort((a, b) => tickers.indexOf(a.ticker) - tickers.indexOf(b.ticker));
  const ranked = rankFlows(funds);
  return { ok: funds.length > 0, date: ranked.date, asked: date, funds, ...ranked, missing, fields, source: 'unusual-whales in-outflow' };
}

export async function etfFlowsRoute(req, res, { fetchImpl = fetchEtfFlows } = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!hasJournalReadKey(req)) return res.status(401).json({ error: 'not authorised for ETF flows' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!uwConfigured()) return res.status(503).json({ error: 'UW_API_KEY unset' });
  const asked = String(req.query?.date || '');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : isoDay(new Date());
  const key = `dvcap:etfflows:v1:${date}`;
  if (kvConfigured() && String(req.query?.fresh || '') !== '1') {
    const hit = await kvGetJson(key).catch(() => null);
    if (hit?.ok) return res.status(200).json({ ...hit, cached: true });
  }
  const out = await fetchImpl({ date });
  if (out.ok && kvConfigured()) await kvSetJsonEx(key, out, FLOW_CACHE_TTL_S).catch(() => null);
  return res.status(out.ok ? 200 : 502).json(out);
}
