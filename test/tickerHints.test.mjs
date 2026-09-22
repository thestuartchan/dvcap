// test/tickerHints.test.mjs — the feed's spelling is not yours, and now it says so.
import { AMBIGUOUS, tickerHint, resolvedLabel } from '../lib/tickerHints.js';
import { atrSummary } from '../lib/atr.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);
{
  const h = tickerHint('wti');
  ok('WTI is named as the stock it is', /W&T Offshore/.test(h.resolves));
  ok('and crude is offered', h.meant.some(m => m.sym === 'CL=F') && /CL=F/.test(h.text));
  ok('GOLD is a listed company, gold is GC=F', /Gold\.com/.test(tickerHint('GOLD').resolves) && tickerHint('GOLD').meant[0].sym === 'GC=F');
  ok('a bare BTC is the trust, not the coin', /Trust/.test(tickerHint('BTC').resolves) && tickerHint('BTC').meant[0].sym === 'BTC-USD');
  ok('an index word points at the caret spelling', tickerHint('VIX').meant[0].sym === '^VIX' && tickerHint('SPX').meant[0].sym === '^GSPC');
  eq('an ordinary ticker gets no hint', [tickerHint('QQQ'), tickerHint('INTC'), tickerHint('CL=F'), tickerHint(''), tickerHint(null)], [null, null, null, null, null]);
  ok('every entry offers at least one alternative with a reason', Object.values(AMBIGUOUS).every(a => a.meant.length >= 1 && a.meant.every(m => m.sym && m.what)));
  ok('no alternative is itself ambiguous', Object.values(AMBIGUOUS).every(a => a.meant.every(m => !AMBIGUOUS[m.sym])));
}
{
  eq('the resolved label names the instrument and its kind', resolvedLabel({ name: 'W&T Offshore, Inc.', quoteType: 'EQUITY' }), 'W&T Offshore, Inc. · stock');
  eq('a future reads as one', resolvedLabel({ name: 'Crude Oil Nov 26', quoteType: 'FUTURE' }), 'Crude Oil Nov 26 · future');
  eq('no name, no label', [resolvedLabel({}), resolvedLabel(null), resolvedLabel({ quoteType: 'EQUITY' })], [null, null, null]);
  eq('an unknown type is passed through lowercased', resolvedLabel({ name: 'X', quoteType: 'WEIRD' }), 'X · weird');
}
{
  // The ATR summary carries the close it was taken against, so a stock sizer has a price.
  const bars = Array.from({ length: 30 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, high: 101 + i * 0.1, low: 99 + i * 0.1, close: 100 + i * 0.1 }));
  const s = atrSummary(bars, 14);
  ok('lastClose is the last bar\'s close', Math.abs(s.lastClose - (100 + 29 * 0.1)) < 1e-9);
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
