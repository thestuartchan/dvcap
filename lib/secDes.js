// lib/secDes.js — a company's fundamentals and recent filings, read straight from SEC EDGAR.
//
// The ticker page's (src/TickerPanel.jsx) filing half. Three public EDGAR files, read raw:
//   company_tickers.json             ticker → CIK and the registrant's name
//   api/xbrl/companyfacts/CIK…json   every XBRL fact the company has filed
//   submissions/CIK…json             its filing index (form, date, primary document)
// No vendor sits between the filing and the number, so every figure carries the form it came
// from, the period it ends and the date it was filed. Market and filing data only: nothing here
// knows what is held.
//
// SEC FAIR ACCESS. EDGAR asks automated callers to name themselves in the User-Agent and keep to
// ten requests a second. One page view is at most three requests, and the parsed result is kept
// in KV for 12 hours (the ticker map for a week), so the site reads EDGAR a few times a day.
import { kvGetJson, kvSetJsonEx, kvConfigured } from './kv.js';

// EDGAR refuses (403) a User-Agent without a contact email, so the contact comes from the
// deployment's SEC_USER_AGENT ("dvcap <email>"), set by the owner and never written to the repo.
// Unset, nothing is sent to SEC and the page says why, rather than collecting refusals.
export const secUserAgent = () => String(process.env.SEC_USER_AGENT || '').trim() || null;
export const DES_KEY = (sym) => `dvcap:des:v1:${sym}`;
export const DES_TTL_S = 12 * 3600;
export const SEC_TICKERS_KEY = 'dvcap:sec:tickers:v1';
export const SEC_TICKERS_TTL_S = 7 * 86400;
export const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const pad = (cik) => String(cik).padStart(10, '0');
export const FACTS_URL = (cik) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${pad(cik)}.json`;
export const SUBS_URL = (cik) => `https://data.sec.gov/submissions/CIK${pad(cik)}.json`;

// The concepts the page shows, each with the US-GAAP tags companies use for it, in order of
// preference. Where a company has filed under more than one, the tag with the newest period wins
// (Microsoft moved from Revenues to the ASC 606 revenue tag in 2018, and both are still in its file).
export const FLOW = Object.freeze({
  revenue:   { label: 'Revenue',          tags: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'], unit: 'USD' },
  opIncome:  { label: 'Operating income', tags: ['OperatingIncomeLoss'], unit: 'USD' },
  netIncome: { label: 'Net income',       tags: ['NetIncomeLoss', 'ProfitLoss'], unit: 'USD' },
  eps:       { label: 'EPS (diluted)',    tags: ['EarningsPerShareDiluted', 'EarningsPerShareBasic'], unit: 'USD/shares', perShare: true },
});
export const INSTANT = Object.freeze({
  cash: { label: 'Cash & equivalents', tags: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'], unit: 'USD' },
  debt: { label: 'Long-term debt',     tags: ['LongTermDebt', 'LongTermDebtNoncurrent'], unit: 'USD' },
});
export const FILING_FORMS = new Set(['10-K', '10-Q', '8-K', '20-F', '6-K', '40-F', '10-K/A', '10-Q/A', '20-F/A']);

const days = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;
const isQuarter = (r) => r.start && r.end && days(r.start, r.end) >= 80 && days(r.start, r.end) <= 100;
const isYear = (r) => r.start && r.end && days(r.start, r.end) >= 350 && days(r.start, r.end) <= 380;
const fig = (r, extra = {}) => ({ end: r.end, start: r.start ?? null, val: r.val, form: r.form || null, filed: r.filed || null, accn: r.accn || null, ...extra });

// One value per period: the latest filing of it (a 10-K restating a quarter wins over the 10-Q).
function byPeriod(rows, keyOf) {
  const m = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r?.val) || !r.end) continue;
    const k = keyOf(r);
    const prev = m.get(k);
    if (!prev || String(r.filed || '') > String(prev.filed || '')) m.set(k, r);
  }
  return [...m.values()];
}

function pickTag(facts, tags, unit) {
  let best = null;
  for (const t of tags) {
    const rows = facts?.facts?.['us-gaap']?.[t]?.units?.[unit];
    if (!Array.isArray(rows) || !rows.length) continue;
    const latest = rows.reduce((a, r) => (String(r.end) > a ? String(r.end) : a), '');
    if (!best || latest > best.latest) best = { tag: t, rows, latest };
  }
  return best;
}

// The last `n` discrete quarters of a flow concept. A company's fourth quarter is usually filed
// only inside the 10-K as the full year, so it is DERIVED — the year less the three quarters filed
// within it — and marked so. EPS is never derived that way: share counts move inside a year, so
// per-share figures do not add, and a missing fourth quarter stays missing.
export function quarters(facts, def, n = 8) {
  const t = pickTag(facts, def.tags, def.unit);
  if (!t) return { tag: null, rows: [] };
  const q = byPeriod(t.rows.filter(isQuarter), r => `${r.start}|${r.end}`);
  const out = q.map(r => fig(r));
  if (!def.perShare) {
    const years = byPeriod(t.rows.filter(isYear), r => `${r.start}|${r.end}`);
    for (const y of years) {
      const inside = out.filter(r => r.start >= y.start && r.end <= y.end && !r.derived);
      if (inside.length !== 3) continue;
      const lastEnd = inside.map(r => r.end).sort().at(-1);
      if (out.some(r => r.end === y.end)) continue;
      const start = new Date(Date.parse(`${lastEnd}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      if (!isQuarter({ start, end: y.end })) continue;
      out.push(fig({ ...y, start, val: y.val - inside.reduce((a, r) => a + r.val, 0) }, { derived: 'full year less the three quarters filed in it' }));
    }
  }
  out.sort((a, b) => a.end.localeCompare(b.end));
  return { tag: t.tag, rows: out.slice(-n) };
}

// Trailing twelve months: the last four quarters, only when they are four consecutive ones.
export function ttm(rows) {
  const last = rows.slice(-4);
  if (last.length < 4) return null;
  for (let i = 1; i < 4; i++) if (days(last[i - 1].end, last[i].start || last[i].end) > 5) return null;
  return { val: +last.reduce((a, r) => a + r.val, 0).toFixed(4), from: last[0].start, to: last[3].end, derived: last.some(r => r.derived) };
}

export function latestInstant(facts, def) {
  const t = pickTag(facts, def.tags, def.unit);
  if (!t) return null;
  const rows = byPeriod(t.rows.filter(r => !r.start), r => r.end);
  const r = rows.sort((a, b) => a.end.localeCompare(b.end)).at(-1);
  return r ? { ...fig(r), tag: t.tag } : null;
}

export function sharesOutstanding(facts) {
  const rows = facts?.facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares;
  if (!Array.isArray(rows) || !rows.length) return null;
  const r = byPeriod(rows, x => x.end).sort((a, b) => a.end.localeCompare(b.end)).at(-1);
  return r ? fig(r) : null;
}

export function fundamentalsFrom(facts) {
  const flow = {};
  for (const [k, def] of Object.entries(FLOW)) {
    const q = quarters(facts, def);
    flow[k] = { label: def.label, unit: def.unit, tag: q.tag, quarters: q.rows, ttm: def.perShare && q.rows.slice(-4).some(r => r.derived) ? null : ttm(q.rows) };
  }
  const instant = Object.fromEntries(Object.entries(INSTANT).map(([k, def]) => [k, { label: def.label, unit: def.unit, ...(latestInstant(facts, def) || { val: null }) }]));
  const gaap = !!facts?.facts?.['us-gaap'];
  return { gaap, ifrs: !!facts?.facts?.['ifrs-full'], flow, instant, shares: sharesOutstanding(facts) };
}

export function filingsFrom(subs, cik, n = 12) {
  const r = subs?.filings?.recent;
  if (!r?.form) return [];
  const out = [];
  for (let i = 0; i < r.form.length && out.length < n; i++) {
    if (!FILING_FORMS.has(r.form[i])) continue;
    const accn = r.accessionNumber[i];
    out.push({ form: r.form[i], filed: r.filingDate[i], period: r.reportDate?.[i] || null, items: r.items?.[i] || null,
      desc: r.primaryDocDescription?.[i] || null,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(accn).replace(/-/g, '')}/${r.primaryDocument[i]}` });
  }
  return out;
}

// SEC writes a share class with a dash (BRK-B); exchanges and Yahoo use a dot.
export const secTicker = (sym) => String(sym || '').trim().toUpperCase().replace(/\./g, '-');

// company_tickers.json → { TICKER: [cik, name] }, the compact form kept in KV.
export function tickerMap(json) {
  const m = {};
  for (const v of Object.values(json || {})) if (v?.ticker && v.cik_str) m[String(v.ticker).toUpperCase()] = [v.cik_str, v.title || null];
  return m;
}

async function getJson(url, fetchImpl, ua = secUserAgent()) {
  if (!ua) return { error: 'SEC contact not configured (SEC_USER_AGENT)' };
  try {
    const r = await fetchImpl(url, { headers: { 'User-Agent': ua, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return { json: await r.json() };
  } catch (e) { return { error: String(e?.message || e).slice(0, 120) }; }
}

const KV = { configured: kvConfigured, get: kvGetJson, setEx: kvSetJsonEx };

// The page's filing half for one symbol. ok:false says why (not an SEC registrant, EDGAR down).
export async function fetchDes(symbol, { now = new Date(), fetchImpl = fetch, kv = KV } = {}) {
  const sym = secTicker(symbol);
  if (!/^[A-Z0-9-]{1,10}$/.test(sym)) return { ok: false, symbol: sym, why: 'not a ticker' };
  const kvOn = (() => { try { return kv.configured(); } catch { return false; } })();
  const cached = kvOn ? await kv.get(DES_KEY(sym)).catch(() => null) : null;
  const age = cached?.at ? (now - Date.parse(cached.at)) / 1000 : Infinity;
  if (cached && age >= 0 && age < DES_TTL_S) return { ...cached, cache: 'kv' };

  let map = kvOn ? await kv.get(SEC_TICKERS_KEY).catch(() => null) : null;
  if (!map?.m) {
    const t = await getJson(TICKERS_URL, fetchImpl);
    if (t.error) return cached ? { ...cached, cache: 'stale', why: `SEC ticker list: ${t.error}` } : { ok: false, symbol: sym, why: `SEC ticker list unavailable (${t.error})` };
    map = { m: tickerMap(t.json), at: now.toISOString() };
    if (kvOn) await kv.setEx(SEC_TICKERS_KEY, map, SEC_TICKERS_TTL_S).catch(() => {});
  }
  const hit = map.m[sym];
  if (!hit) return { ok: false, symbol: sym, why: 'not an SEC registrant under this ticker — ETFs, funds and many non-US listings file differently or not at all' };
  const [cik, name] = hit;
  const [facts, subs] = await Promise.all([getJson(FACTS_URL(cik), fetchImpl), getJson(SUBS_URL(cik), fetchImpl)]);
  if (facts.error && subs.error) {
    return cached ? { ...cached, cache: 'stale', why: `EDGAR: ${facts.error}` } : { ok: false, symbol: sym, cik, name, why: `EDGAR unavailable (${facts.error})` };
  }
  const out = {
    ok: true, symbol: sym, cik, name: subs.json?.name || name,
    fiscalYearEnd: subs.json?.fiscalYearEnd || null, sic: subs.json?.sicDescription || null,
    fundamentals: facts.json ? fundamentalsFrom(facts.json) : null,
    fundamentalsWhy: facts.error ? `XBRL facts unavailable (${facts.error})` : null,
    filings: subs.json ? filingsFrom(subs.json, cik) : [],
    filingsWhy: subs.error ? `filing index unavailable (${subs.error})` : null,
    source: 'SEC EDGAR (company_tickers, XBRL companyfacts, submissions)', at: now.toISOString(),
  };
  if (kvOn) await kv.setEx(DES_KEY(sym), out, DES_TTL_S).catch(() => {});
  return { ...out, cache: 'live' };
}
