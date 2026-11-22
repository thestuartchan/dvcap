// lib/uwHistory.js — the research door: SPY/QQQ only, keyed, private.
import { histRequest, uwHistoryRoute } from '../lib/uwHistory.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w); if (a === b) { pass++; console.log('✅', n); } else { fail++; console.log('❌', n, ' got', a, 'want', b); } };
eq('1-minute bars for a date', histRequest({ kind: 'ohlc', ticker: 'qqq', date: '2020-03-16' }), { ok: true, path: '/api/stock/QQQ/ohlc/1m', query: { date: '2020-03-16', limit: 2500 } });
eq('other tickers refused', histRequest({ kind: 'ohlc', ticker: 'AAPL', date: '2020-03-16' }).status, 400);
eq('an option in OSI form', histRequest({ kind: 'option', contract: 'SPY200316P00240000', date: '2020-03-16' }).path, '/api/option-contract/SPY200316P00240000/intraday');
eq('another underlying\'s option refused', histRequest({ kind: 'option', contract: 'TSLA200316P00240000', date: '2020-03-16' }).ok, false);
eq('a path cannot be smuggled in', histRequest({ kind: 'option', contract: 'SPY200316P00240000/../x', date: '2020-03-16' }).ok, false);
eq('bad date refused', histRequest({ kind: 'ohlc', ticker: 'SPY', date: '2020/03/16' }).ok, false);
eq('unknown kind refused', histRequest({ kind: 'flow', date: '2020-03-16' }).ok, false);
const mkRes = () => { const r = { h: {}, code: 0 }; r.setHeader = (k, v) => { r.h[k] = v; }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
process.env.JOURNAL_READ_KEY = 'k'.repeat(24);
let res = mkRes(); await uwHistoryRoute({ method: 'GET', headers: {}, query: {} }, res);
eq('without the key: 401', res.code, 401);
eq('never cached publicly', res.h['Cache-Control'], 'private, no-store');
console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exit(1);
