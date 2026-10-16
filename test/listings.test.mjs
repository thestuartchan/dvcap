// test/listings.test.mjs — a position is priced off the listing the broker holds (lib/listings.js).
//
// 16 Oct 2026: a London-listed ETF sharing its ticker with a US fund was priced off the US one,
// 28% away, because the console quoted the bare ticker and the statement's listing was parsed and
// ignored. Fake tickers throughout.
import { LISTING_SUFFIX, quoteSymbolFor, listingCheck, markGap, MARK_GAP_PCT } from '../lib/listings.js';
import { reconcile, rowFromPosition } from '../lib/flex.js';
import { rowFromTrade } from '../lib/flexTrades.js';
import { derivePosition } from '../lib/positions.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// ── THE MAP ──
eq('an ETF on LSEETF is quoted with .L', quoteSymbolFor({ root: 'XYZ', listingExchange: 'LSEETF' }), 'XYZ.L');
eq('the LSE main market too', quoteSymbolFor({ root: 'XYZ', listingExchange: 'LSE' }), 'XYZ.L');
eq('a Hong Kong code is padded to four digits', quoteSymbolFor({ root: '981', listingExchange: 'SEHK' }), '0981.HK');
eq('Amsterdam is .AS', quoteSymbolFor({ root: 'ABC', listingExchange: 'AEB' }), 'ABC.AS');
eq('IBKR\'s TSE is Toronto, not Tokyo', [quoteSymbolFor({ root: 'ABC', listingExchange: 'TSE' }), quoteSymbolFor({ root: '1234', listingExchange: 'TSEJ' })], ['ABC.TO', '1234.T']);
eq('a US venue is the bare ticker', quoteSymbolFor({ root: 'XYZ', listingExchange: 'ARCA' }), '');
eq('lower case is read', quoteSymbolFor({ root: 'xyz', listingExchange: 'lseetf' }), 'XYZ.L');
eq('an exchange not in the map suggests nothing — no guess', quoteSymbolFor({ root: 'XYZ', listingExchange: 'MOON' }), null);
eq('nor does a missing listing', quoteSymbolFor({ root: 'XYZ' }), null);
ok('every suffix is a bare code, no dot', Object.values(LISTING_SUFFIX).every(v => !v.includes('.')));

// ── THE ROW AGAINST THE LISTING ──
const lse = { root: 'XYZ', symbol: 'XYZ', listingExchange: 'LSEETF' };
eq('a bare-ticker row on a London listing should be quoted .L', listingCheck({ symbol: 'XYZ' }, lse), { quoteAs: 'XYZ.L', listing: 'LSEETF', current: 'XYZ', explicit: false });
eq('a row already quoted .L is fine', listingCheck({ symbol: 'XYZ', quoteSymbol: 'XYZ.L' }, lse), null);
eq('so is a row whose own symbol carries the suffix', listingCheck({ symbol: 'XYZ.L' }, lse), null);
eq('a hand-set Quote as that disagrees is named as explicit — reported, never overwritten', listingCheck({ symbol: 'XYZ', quoteSymbol: 'XYZ' }, lse)?.explicit, true);
eq('a Hong Kong row quoted 0981.HK agrees with SEHK 981', listingCheck({ symbol: '0981.HK' }, { root: '981', listingExchange: 'SEHK' }), null);
eq('a US listing never asks for a change', listingCheck({ symbol: 'XYZ' }, { root: 'XYZ', listingExchange: 'NASDAQ' }), null);
eq('nor an unknown one', listingCheck({ symbol: 'XYZ' }, { root: 'XYZ', listingExchange: 'MOON' }), null);

// ── THE PRICE AGAINST THE MARK ──
eq('28% from the mark is flagged, with the gap', markGap(77, 60), 28.3);
eq('a fall is flagged the same way', markGap(50, 63), -20.6);
eq(`within ${MARK_GAP_PCT}% is a day's move, not a listing`, markGap(66, 63), null);
eq('no live price, no verdict', markGap(null, 63), null);
eq('no mark, no verdict', markGap(70, null), null);

// ── THE RECONCILIATION NAMES IT ──
const fills = [{ id: 'f1', side: 'buy', qty: 10, price: 60, date: '2026-10-01' }];
const row = (id, extra = {}) => ({ id, symbol: 'XYZ', currency: 'USD', fills, ...extra, derived: derivePosition(fills, {}) });
const pos = { symbol: 'XYZ', root: 'XYZ', assetCategory: 'STK', currency: 'USD', qty: 10, costBasisPrice: 60, markPrice: 62.5, listingExchange: 'LSEETF' };
{
  const rec = reconcile([row('x1')], [pos], { asOf: '2026-10-15' });
  eq('the row still reconciles on quantity and cost', rec.agree.map(a => a.id), ['x1']);
  eq('and is listed as quoted off the wrong listing', rec.listings.map(l => [l.id, l.quoteAs, l.listing]), [['x1', 'XYZ.L', 'LSEETF']]);
  eq('the statement\'s mark is kept per row, with the listing', rec.marks.x1, { mark: 62.5, listing: 'LSEETF' });
}
{
  const rec = reconcile([row('x1', { quoteSymbol: 'XYZ.L' })], [pos], { asOf: '2026-10-15' });
  eq('once quoted .L, nothing is listed', rec.listings, []);
}
{
  // A row that DISAGREES on quantity is still checked for its listing — the check runs before the branches.
  const rec = reconcile([row('x1')], [{ ...pos, qty: 12 }], { asOf: '2026-10-15' });
  eq('a disagreeing row is still checked', [rec.differs.length, rec.listings.length], [1, 1]);
}

// ── NEW ROWS START ON THE RIGHT LISTING ──
eq('a row added from the statement carries Quote as', rowFromPosition(pos, { asOf: '2026-10-15' }).quoteSymbol, 'XYZ.L');
eq('a US position does not', 'quoteSymbol' in rowFromPosition({ ...pos, listingExchange: 'ARCA' }, { asOf: '2026-10-15' }), false);
eq('a Hong Kong position keeps its .HK symbol and needs no Quote as', (() => { const r = rowFromPosition({ ...pos, symbol: '981', root: '981', currency: 'HKD', listingExchange: 'SEHK' }); return [r.symbol, 'quoteSymbol' in r]; })(), ['0981.HK', false]);
eq('a row opened from a trade carries it too', rowFromTrade({ root: 'XYZ', symbol: 'XYZ', listingExchange: 'LSEETF', currency: 'USD', tradeId: 't123', date: '2026-10-01', assetCategory: 'STK' }, '2026-10-01').quoteSymbol, 'XYZ.L');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
