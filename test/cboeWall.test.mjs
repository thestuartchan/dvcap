// test/cboeWall.test.mjs — CBOE closed its delayed data to automated clients on 19 Nov 2026 (a
// Cloudflare bot wall). dvcap does not ask: every CBOE fetcher answers walled at once; the capture's
// cross-check says unavailable rather than disagree; a Signal Board row more than two sessions old
// stops voting; the console's greeks read UW's contracts; the settled rung's vols come from Yahoo,
// with a vol solved from the last trade where Yahoo has none. Fake tickers and made-up numbers only.
import { fetchCboeChain, fetchCboeGreeks, fetchCboeIndex, CBOE_WALLED } from '../lib/cboe.js';
import { crossCheck } from '../lib/gexStore.js';
import { buildSignalBoard, STALE_SESSIONS } from '../lib/signalBoard.js';
import { osiOf, uwContractGreeks } from '../lib/uw.js';
import { fetchYahooIvChain, oiWeightedIv } from '../lib/optionsChain.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// ── CBOE is not asked ──
{
  const real = globalThis.fetch; let asked = 0;
  globalThis.fetch = async () => { asked++; return { ok: true, json: async () => ({}) }; };
  try {
    const [a, b, c] = await Promise.all([fetchCboeChain('XYZ'), fetchCboeGreeks('XYZ', ['XYZ|2030-01-18|C|10']), fetchCboeIndex('XYZ')]);
    eq('walled is on', CBOE_WALLED, true);
    eq('every fetcher answers walled, with no request made', [a.walled, b.walled, c.walled, asked], [true, true, true, 0]);
    const x = await crossCheck('XYZ', { spot: 100 });
    eq('the capture cross-check is unavailable, not a disagreement', [x.ok, x.unavailable, /unavailable/.test(x.reason)], [false, true, true]);
  } finally { globalThis.fetch = real; }
}

// ── a stale row does not vote ──
{
  const days = (n, end) => { const out = []; let t = Date.parse(`${end}T12:00:00Z`); while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) out.unshift(d.toISOString().slice(0, 10)); t -= 86400000; } return out; };
  const ser = (vals, end) => { const ds = days(vals.length, end); return vals.map((v, i) => ({ date: ds[i], value: v })); };
  const S = { hyg: ser([80, 80.2, 80.1, 79.8, 79.5, 79.2, 79], '2030-01-08'), lqd: ser([110, 110, 110, 110, 110, 110, 110], '2030-01-08') };
  const fresh = buildSignalBoard(S, { today: '2030-01-09' }).rows.find(r => r.id === 'hyg_lqd');
  const stale = buildSignalBoard(S, { today: '2030-01-15' }).rows.find(r => r.id === 'hyg_lqd');
  eq(`a row ${STALE_SESSIONS} or fewer sessions old votes`, fresh.vote, true);
  eq('older than that: shown, flagged, not voting', [stale.vote, stale.stale, stale.flags.some(f => /stale: as of 2030-01-08/.test(f))], [false, 5, true]);
}

// ── the console's greeks from UW ──
{
  eq('an equity contract key becomes its OSI symbol', osiOf('XYZ|2030-03-15|P|102.5'), 'XYZ300315P00102500');
  eq('an option on a future is not asked about', osiOf('6JZ6|2030-12-04|C|0.0064'), null);
  let q = null;
  const get = async (path, o) => { q = { path, o }; return { data: [
    { option_symbol: 'XYZ300315P00102500', nbbo_bid: '2.10', nbbo_ask: '2.30', delta: '-0.41', gamma: '0.05', theta: '-0.02', vega: '0.11', implied_volatility: '0.31', open_interest: '1200', last_tape_time: '2030-01-02T20:59:00Z' },
    { option_symbol: 'XYZ300315C00110000', nbbo_bid: '1', nbbo_ask: '1.2', delta: '0.3' },
  ] }; };
  const r = await uwContractGreeks({ root: 'XYZ', keys: ['XYZ|2030-03-15|P|102.5'], get });
  eq('one request, the held contracts named', [q.path, q.o.query['option_symbol[]']], ['/api/stock/XYZ/option-contracts', ['XYZ300315P00102500']]);
  eq('only the held contract comes back, with delta and a mid mark', [Object.keys(r.greeks), r.greeks['XYZ|2030-03-15|P|102.5'].delta, r.greeks['XYZ|2030-03-15|P|102.5'].mark, r.greeks['XYZ|2030-03-15|P|102.5'].source], [['XYZ|2030-03-15|P|102.5'], -0.41, 2.2, 'uw']);
  eq('nothing to ask about is a plain no', (await uwContractGreeks({ root: '6JZ6', keys: ['6JZ6|2030-12-04|C|0.0064'], get })).ok, false);
}

// ── the settled rung's vols from Yahoo ──
{
  const now = new Date('2030-01-03T10:00:00Z');
  const lt = Math.floor(Date.parse('2030-01-02T20:30:00Z') / 1000);
  const chain = (exp) => ({ spot: 100, expiry: exp, expirationDates: [Math.floor(Date.parse('2030-01-18T00:00:00Z') / 1000), Math.floor(Date.parse('2030-02-15T00:00:00Z') / 1000)],
    calls: [{ contractSymbol: 'XYZW300118C00100000', strike: 100, impliedVolatility: 0.22, openInterest: 0 },
            { contractSymbol: 'XYZ300118C00101000', strike: 101, impliedVolatility: 0.00001, lastPrice: 2.4, lastTradeDate: lt, openInterest: 0 },
            { contractSymbol: 'XYZ300118C00150000', strike: 150, impliedVolatility: 0.5 }],
    puts: [{ contractSymbol: 'XYZ300118P00099000', strike: 99, impliedVolatility: 0.00001, openInterest: 5 }] });
  const fake = async (sym, unix) => (unix ? { ...chain(), expiry: new Date(unix * 1000).toISOString().slice(0, 10) } : { ...chain(), expiry: '2030-01-18' });
  const y = await fetchYahooIvChain('XYZ', { expiries: ['2030-01-18'], now, chainOf: fake, auth: null, gapMs: 0 });
  const k = (s) => y.contracts.find(c => c.strike === s);
  eq('in-band contracts kept whatever Yahoo\'s own open interest', y.contracts.map(c => c.strike).sort((a, b) => a - b), [99, 100, 101]);
  eq('a live vol is the vol', k(100).iv, 0.22);
  ok('the sentinel is no vol, and a vol is solved from the last trade', k(101).iv == null && k(101).ivLast > 0.05 && k(101).ivLast < 1.5);
  eq('no last trade, no solved vol', [k(99).iv, k(99).ivLast ?? null], [null, null]);
  const roots = await fetchYahooIvChain('XYZ', { expiries: ['2030-01-18'], roots: ['XYZ', 'XYZW'], now, chainOf: fake, auth: null, gapMs: 0 });
  eq('a two-root book keeps each contract\'s root', roots.contracts.map(c => c.root).sort(), ['XYZ', 'XYZ', 'XYZW']);
  eq('OI-weighted vol', +oiWeightedIv([{ oi: 1, iv: 0.2 }, { oi: 3, iv: 0.4 }, { oi: 0, iv: 9 }]).toFixed(3), 0.35);
  eq('no chain, a plain refusal', (await fetchYahooIvChain('XYZ', { chainOf: async () => null, auth: null })).ok, false);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
if (fail) process.exit(1);
