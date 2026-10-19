// test/secDes.test.mjs — the ticker page's filing half (lib/secDes.js). Fake ticker, made-up figures;
// EDGAR is stubbed, never reached.
import { quarters, ttm, fundamentalsFrom, filingsFrom, tickerMap, secTicker, fetchDes, FLOW, DES_KEY } from '../lib/secDes.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// A company with a June year end: three 10-Q quarters a year, the fourth only inside the 10-K.
const Q = (start, end, val, form = '10-Q', filed = end) => ({ start, end, val, form, filed, accn: `0000-${end}` });
const rev = [
  Q('2025-07-01', '2025-09-30', 100), Q('2025-10-01', '2025-12-31', 110), Q('2026-01-01', '2026-03-31', 120),
  Q('2025-07-01', '2026-06-30', 460, '10-K', '2026-07-30'),                       // the year: Q4 = 460 − 330 = 130
  Q('2026-07-01', '2026-09-30', 140),
  Q('2025-07-01', '2025-09-30', 101, '10-K', '2026-07-30'),                       // a restated quarter, filed later
];
const facts = { facts: {
  'us-gaap': {
    Revenues: { units: { USD: [Q('2019-01-01', '2019-03-31', 50)] } },                 // an older tag, superseded
    RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: rev } },
    EarningsPerShareDiluted: { units: { 'USD/shares': [Q('2025-07-01', '2025-09-30', 1.1), Q('2025-07-01', '2026-06-30', 4.9, '10-K', '2026-07-30')] } },
    CashAndCashEquivalentsAtCarryingValue: { units: { USD: [{ end: '2026-06-30', val: 900, form: '10-K', filed: '2026-07-30' }, { end: '2026-09-30', val: 950, form: '10-Q', filed: '2026-10-28' }] } },
  },
  dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: '2026-10-20', val: 1000, form: '10-Q', filed: '2026-10-28' }] } } },
} };

const r = quarters(facts, FLOW.revenue);
eq('the tag with the newest period wins', r.tag, 'RevenueFromContractWithCustomerExcludingAssessedTax');
eq('quarters in order, the fourth derived from the year', r.rows.map(x => [x.end, x.val, !!x.derived]), [['2025-09-30', 101, false], ['2025-12-31', 110, false], ['2026-03-31', 120, false], ['2026-06-30', 129, true], ['2026-09-30', 140, false]]);
eq('a restated quarter takes the later filing', r.rows[0].form, '10-K');
eq('each figure carries its form, period and filing date', Object.keys(r.rows[1]).filter(k => ['end', 'start', 'form', 'filed', 'accn'].includes(k)).length, 5);
eq('TTM is the last four consecutive quarters', ttm(r.rows), { val: 499, from: '2025-10-01', to: '2026-09-30', derived: true });
eq('fewer than four quarters is no TTM', ttm(r.rows.slice(0, 3)), null);
eq('EPS is never derived for the fourth quarter', quarters(facts, FLOW.eps).rows.map(x => x.end), ['2025-09-30']);
const f = fundamentalsFrom(facts);
eq('the latest balance-sheet figure', [f.instant.cash.val, f.instant.cash.end, f.instant.cash.form], [950, '2026-09-30', '10-Q']);
eq('a concept the company never filed is empty, not invented', [f.flow.opIncome.tag, f.flow.opIncome.quarters, f.instant.debt.val], [null, [], null]);
eq('shares outstanding from the cover page', f.shares.val, 1000);

const subs = { name: 'XYZ CORP', filings: { recent: {
  form: ['4', '10-Q', '8-K', 'SC 13G'], filingDate: ['2026-10-29', '2026-10-28', '2026-10-27', '2026-10-01'],
  reportDate: ['', '2026-09-30', '2026-10-27', ''], accessionNumber: ['a', '0000123456-26-000010', '0000123456-26-000009', 'd'],
  primaryDocument: ['f4.xml', 'xyz-20260930.htm', 'xyz8k.htm', 'g.htm'], items: ['', '', '2.02,9.01', ''], primaryDocDescription: ['', '10-Q', '8-K', ''] } } };
eq('only the periodic and current reports, with a link to the document', filingsFrom(subs, 123456).map(x => [x.form, x.url]),
  [['10-Q', 'https://www.sec.gov/Archives/edgar/data/123456/000012345626000010/xyz-20260930.htm'], ['8-K', 'https://www.sec.gov/Archives/edgar/data/123456/000012345626000009/xyz8k.htm']]);
eq('a share class is written the SEC way', secTicker('xyz.b'), 'XYZ-B');
eq('the ticker list, compacted', tickerMap({ 0: { cik_str: 123456, ticker: 'XYZ', title: 'XYZ CORP' } }), { XYZ: [123456, 'XYZ CORP'] });

// ── fetch, cache and the ways it says no ──
{
  const store = {};
  const kv = { configured: () => true, get: async (k) => store[k] ?? null, setEx: async (k, v) => { store[k] = v; } };
  const urls = [];
  const fetchImpl = async (url, opts) => {
    urls.push([url, opts?.headers?.['User-Agent']]);
    const body = url.includes('company_tickers') ? { 0: { cik_str: 123456, ticker: 'XYZ', title: 'XYZ CORP' } }
      : url.includes('companyfacts') ? facts : url.includes('submissions') ? subs : null;
    return { ok: !!body, status: body ? 200 : 404, json: async () => body };
  };
  const now = new Date('2026-10-30T08:00:00Z');
  const a = await fetchDes('xyz', { now, fetchImpl, kv });
  eq('the first read goes to EDGAR, names itself, and is kept', [a.ok, a.cache, a.name, urls.length, urls.every(u => /dvcap/.test(u[1])), !!store[DES_KEY('XYZ')]], [true, 'live', 'XYZ CORP', 3, true, true]);
  const b = await fetchDes('XYZ', { now: new Date(now.getTime() + 3600e3), fetchImpl, kv });
  eq('within 12 hours the kept copy is served', [b.cache, urls.length], ['kv', 3]);
  const etf = await fetchDes('ABCD', { now, fetchImpl, kv });
  eq('a ticker SEC does not list says why', [etf.ok, /not an SEC registrant/.test(etf.why), urls.length], [false, true, 3]);
  eq('nonsense is refused before any request', [(await fetchDes('<x>', { now, fetchImpl, kv })).why, urls.length], ['not a ticker', 3]);
  const down = async () => ({ ok: false, status: 503, json: async () => null });
  const none = { configured: () => false };
  eq('EDGAR down with nothing kept says so', (await fetchDes('XYZ', { now, fetchImpl: down, kv: none })).why, 'SEC ticker list unavailable (HTTP 503)');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
