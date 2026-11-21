// lib/etfFlows.js — ETF inflows/outflows for the recap (UW in-outflow), behind the journal read key.
import { rowFlow, normaliseFlowRows, fundSummary, rankFlows, fetchEtfFlows, etfFlowsRoute, ETF_FLOW_TICKERS } from '../lib/etfFlows.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w); if (a === b) { pass++; console.log('✅', n); } else { fail++; console.log('❌', n, ' got', a, 'want', b); } };
const ok = (n, c) => eq(n, !!c, true);

eq('the dollar flow is change_prem when UW gives it', rowFlow({ change_prem: '-1250000.5', change: 10, close: 5 }), -1250000.5);
eq('else shares created × close', rowFlow({ change: 2000, close: '50' }), 100000);
eq('no flow field and no price is not a flow', rowFlow({ change: 2000 }), null);

const ans = { data: [
  { date: '2026-11-20', change_prem: '300' }, { date: '2026-11-16', change_prem: '-50' },
  { date: '2026-11-17', change_prem: '100' }, { date: '2026-11-18', change_prem: '0' },
  { date: '2026-11-19', change_prem: '-20' }, { date: '2026-11-13', change_prem: '999' }, { date: 'bad', change_prem: '1' } ] };
const rows = normaliseFlowRows(ans);
eq('rows sorted oldest first, bad dates dropped', rows.map(r => r.date), ['2026-11-13', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
eq('an empty answer is null, not zero', normaliseFlowRows({ data: [] }), null);
eq('day and five-session sum', fundSummary('XLK', rows, '2026-11-20'), { ticker: 'XLK', label: 'Technology', date: '2026-11-20', day: 300, week: 330 });
eq('a date with no print uses the session before it', fundSummary('XLK', rows, '2026-11-19').day, -20);

const funds = [
  { ticker: 'AAA', date: '2026-11-20', day: 500 }, { ticker: 'BBB', date: '2026-11-20', day: -900 },
  { ticker: 'CCC', date: '2026-11-20', day: 200 }, { ticker: 'DDD', date: '2026-11-19', day: 5000 },
  { ticker: 'EEE', date: '2026-11-20', day: -10 } ];
const r = rankFlows(funds);
eq('ranked on the latest date only', r.date, '2026-11-20');
eq('inflows biggest first, stale fund left out', r.inflows.map(f => f.ticker), ['AAA', 'CCC']);
eq('outflows biggest first', r.outflows.map(f => f.ticker), ['BBB', 'EEE']);
const early = rankFlows([{ ticker: 'AAA', date: '2026-11-19', day: 5 }, { ticker: 'BBB', date: '2026-11-19', day: -5 }, { ticker: 'GGG', date: '2026-11-20', day: -9 }]);
eq('one fund posted early does not become the day ranked', early.date, '2026-11-19');

const calls = [];
const get = async (path, { query }) => { calls.push([path, query]); if (path.includes('/BAD/')) throw new Error('UW 402'); return ans; };
const out = await fetchEtfFlows({ date: '2026-11-20', tickers: ['XLK', 'BAD'], get });
ok('one call per fund, on UW\'s published path', calls.some(c => c[0] === '/api/etfs/XLK/in-outflow'));
eq('window ends on the date asked', calls[0][1].end_date, '2026-11-20');
eq('a refused fund is listed as missing with the status only', out.missing, [{ ticker: 'BAD', why: 'UW 402' }]);
eq('field names are reported, never values', out.fields, ['date', 'change_prem']);
ok('the fund list is fixed and has no duplicates', new Set(ETF_FLOW_TICKERS.map(t => t[0])).size === ETF_FLOW_TICKERS.length);

const mkRes = () => { const res = { h: {}, code: 0, body: null }; res.setHeader = (k, v) => { res.h[k] = v; }; res.status = (c) => { res.code = c; return res; }; res.json = (b) => { res.body = b; return res; }; return res; };
process.env.JOURNAL_READ_KEY = 'k'.repeat(24);
let res = mkRes(); await etfFlowsRoute({ method: 'GET', headers: {}, query: {} }, res);
eq('without the key: 401', res.code, 401);
ok('never cached publicly', res.h['Cache-Control'] === 'private, no-store');
res = mkRes(); await etfFlowsRoute({ method: 'POST', headers: { 'x-journal-key': 'k'.repeat(24) }, query: {} }, res);
eq('POST refused', res.code, 405);
delete process.env.UW_API_KEY;
res = mkRes(); await etfFlowsRoute({ method: 'GET', headers: { 'x-journal-key': 'k'.repeat(24) }, query: {} }, res);
eq('no UW key: 503', res.code, 503);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
