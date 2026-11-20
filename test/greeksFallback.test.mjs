// test/greeksFallback.test.mjs — when CBOE's delayed quotes are unavailable (20 Nov 2026: a Cloudflare
// bot wall, every root 403), the greeks route fills held contracts from IBKR's statement marks and the
// console models each delta from the mark and the live underlying, labelled modelled; the mark is
// labelled the close. Fake tickers and made-up numbers only.
import { exposureGreeks, fillFromStatementMarks } from '../api/flex-sync.js';
import { optionDerived, markOf } from '../lib/instruments.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const store = { asOf: '2030-01-02', marks: { 'XYZ|2030-03-15|P|100': 6.5, 'XYZ|2030-03-15|P|80': 0 } };
{
  const f = fillFromStatementMarks({}, ['XYZ|2030-03-15|P|100', 'XYZ|2030-03-15|P|80', 'ABC|2030-03-15|C|10'], store);
  eq('two of three filled from the statement', f.filled, 2);
  eq('a mark becomes a quote at the mark', f.greeks['XYZ|2030-03-15|P|100'], { mark: 6.5, bid: 6.5, ask: 6.5, source: 'ibkr-close' });
  eq('a worthless leg carries delta 0', f.greeks['XYZ|2030-03-15|P|80'].delta, 0);
  eq('no store, nothing filled', fillFromStatementMarks({}, ['XYZ|2030-03-15|P|100'], null).filled, 0);
}
{
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  try {
    const r = await exposureGreeks('XYZ|2030-03-15|P|100,XYZ|2030-03-15|P|80,ABC|2030-03-15|C|10', { marksStore: store });
    eq('the feed refusing is reported, not hidden', r.failed.map(x => x.reason.includes('403')), [true, true]);
    eq('the statement fills what it holds', [r.matched, r.missing], [2, ['ABC|2030-03-15|C|10']]);
    ok('and the answer says where the figures came from', /IBKR statement marks/.test(r.source) && r.fallback?.asOf === '2030-01-02');
  } finally { globalThis.fetch = real; }
}
{
  const row = { id: 'x', symbol: 'XYZ', underlying: 'XYZ', instrument: 'spread', side: 'long', multiplier: 100,
    derived: { qty: 1, status: 'open', avgCost: 5 },
    legs: [{ right: 'P', strike: 100, expiry: '2030-03-15', side: 'long', ratio: 1 }, { right: 'P', strike: 80, expiry: '2030-03-15', side: 'short', ratio: 1 }] };
  const g = fillFromStatementMarks({}, ['XYZ|2030-03-15|P|100', 'XYZ|2030-03-15|P|80'], store).greeks;
  const o = optionDerived(row, { greeks: g, spots: { XYZ: 104 }, today: '2030-01-03', now: new Date('2030-01-03T15:00:00Z') });
  ok('a delta is modelled from the marks and the spot', o.netDelta != null && o.netDelta < 0);
  eq('and labelled modelled', o.deltaSource, 'modelled');
  eq('the mark is the close, not live', markOf(row, { greeks: g }).source, 'close');
  eq('a feed quote is still live', markOf(row, { greeks: { 'XYZ|2030-03-15|P|100': { bid: 6, ask: 7 }, 'XYZ|2030-03-15|P|80': { bid: 0, ask: 0.1 } } }).source, 'live');
}
console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
if (fail) process.exit(1);
