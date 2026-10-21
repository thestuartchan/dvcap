// Dirham (AED) and the UAE exchanges (DFM, ADX) end to end: the quote symbol a statement row gets,
// the session it trades in, the currency the sizer converts, the journal's dollar figure, the cash
// book, and how the money prints. Tickers are made up (XYZ, ABC).
import { quoteSymbolFor, listingCheck, statementMark } from '../lib/listings.js';
import { consoleSymbolOf, exchangeZone } from '../lib/fillAudit.js';
import { USD_PER } from '../lib/dayTradeJournal.js';
import { ccyOfSymbol } from '../lib/holdTypes.js';
import { sizeTrade } from '../lib/sizer.js';
import { fmtCcy } from '../lib/fxrates.js';
import { exchangeFor, marketState, sessionCloseMin, feedDelayFor, EXCHANGE_LABEL } from '../lib/sessions.js';
import { instrumentKind, earningsNameFor } from '../lib/catalyst.js';
import { cashBookOf } from '../lib/flex.js';
import { bookExposure } from '../lib/bookExposure.js';
import { regionOf, addEntry } from '../lib/universeAdded.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const PEG = 3.6725;

// ── THE QUOTE SYMBOL ─────────────────────────────────────────────────────────
eq('DFM listing → .AE', quoteSymbolFor({ root: 'XYZ', listingExchange: 'DFM', currency: 'AED' }), 'XYZ.AE');
eq('ADX listing → .AE', quoteSymbolFor({ root: 'ABC', listingExchange: 'ADX', currency: 'AED' }), 'ABC.AE');
eq('no listing, dirhams → .AE', quoteSymbolFor({ root: 'XYZ', currency: 'AED' }), 'XYZ.AE');
eq('a named listing wins over the currency', quoteSymbolFor({ root: 'XYZ', listingExchange: 'LSEETF', currency: 'AED' }), 'XYZ.L');
eq('no listing, dollars → nothing suggested, as before', quoteSymbolFor({ root: 'XYZ', currency: 'USD' }), null);
eq('a bare dirham row is told its quote symbol', listingCheck({ symbol: 'XYZ' }, { root: 'XYZ', currency: 'AED' })?.quoteAs, 'XYZ.AE');
eq('…and a row already on .AE is left alone', listingCheck({ symbol: 'XYZ.AE' }, { root: 'XYZ', listingExchange: 'DFM', currency: 'AED' }), null);
eq('a dirham fill is named <root>.AE', consoleSymbolOf({ symbol: 'XYZ', currency: 'AED', assetCategory: 'STK' }), 'XYZ.AE');
eq('a dirham fill dates in Dubai', exchangeZone('AED'), 'Asia/Dubai');

// ── NO FEED PRICE: THE STATEMENT'S CLOSE ─────────────────────────────────────
const note = { asOf: '2026-10-20', marks: { r1: { mark: 4.12, listing: 'ADX' }, r2: { mark: 0 } } };
eq('an unpriced share row takes IBKR\'s close, dated', statementMark({ id: 'r1' }, note), { price: 4.12, asOf: '2026-10-20' });
eq('…not an option row', statementMark({ id: 'r1' }, note, { derivative: true }), null);
eq('…not a future', statementMark({ id: 'r1', margined: true }, note), null);
eq('…not a zero or missing mark', [statementMark({ id: 'r2' }, note), statementMark({ id: 'r3' }, note), statementMark({ id: 'r1' }, null)], [null, null, null]);

// ── THE SESSION ──────────────────────────────────────────────────────────────
eq('.AE trades on the UAE session', exchangeFor('XYZ.AE'), 'UAE');
eq('…which closes 15:00 Dubai', sessionCloseMin('XYZ.AE'), { closeMin: 900, tz: 'Asia/Dubai' });
eq('open at 12:00 Dubai on a Wednesday', marketState('XYZ.AE', new Date('2026-10-21T08:00:00Z')), 'open');
eq('shut on a Saturday', marketState('XYZ.AE', new Date('2026-10-24T08:00:00Z')), 'closed');
eq('a 15-minute feed', feedDelayFor('XYZ.AE'), 15);
eq('labelled DFM/ADX', EXCHANGE_LABEL.UAE, 'DFM/ADX');
eq('no US earnings lookup for a UAE listing', [instrumentKind('XYZ.AE'), earningsNameFor('XYZ.AE')], ['foreign', null]);

// ── THE SIZER ────────────────────────────────────────────────────────────────
eq('.AE prices in dirhams', ccyOfSymbol('XYZ.AE'), 'AED');
const base = { kind: 'stock', symbol: 'XYZ.AE', nlv: 1_000_000 };
const local = sizeTrade({ ...base, price: 3.6725, atr: 0.3, fx: 1 / PEG });
const dollars = sizeTrade({ ...base, symbol: 'XYZ', price: 1, atr: 0.3 / PEG });
eq('a dirham name sizes like its dollar equivalent', local.tests.map(t => t.size), dollars.tests.map(t => t.size));
eq('…its delta is in dollars', Math.round(local.deltaAdded), Math.round(dollars.deltaAdded));
eq('…and the inputs are reported as quoted, with the rate', [local.price, local.atr, +local.fx.toFixed(6)], [3.6725, 0.3, +(1 / PEG).toFixed(6)]);
const viaHold = sizeTrade({ ...base, price: 3.6725, atr: 0.3, hold: { type: 'trade', fx: 1 / PEG } });
eq('the hold type\'s rate is used when no fx is passed', Math.round(viaHold.deltaAdded ?? 0) > 0 && viaHold.fx === 1 / PEG, true);
eq('a dollar name is unchanged', sizeTrade({ ...base, symbol: 'XYZ', price: 50, atr: 2 }).fx, 1);

// ── THE JOURNAL AND THE MONEY ────────────────────────────────────────────────
eq('the journal converts dirhams at the peg', +(367.25 * USD_PER.AED).toFixed(2), 100);
eq('AED prints as a word, with a space', [fmtCcy(1234.5, 'AED'), fmtCcy(-50, 'AED')], ['AED 1,235', '-AED 50']);
eq('the dollar sign is unchanged', fmtCcy(1234, 'USD'), '$1,234');

// ── THE CASH BOOK ────────────────────────────────────────────────────────────
const cb = cashBookOf({ toDate: '20261021', positions: [], cash: [
  { currency: 'BASE_SUMMARY', endingCash: 10000 }, { currency: 'USD', endingCash: 5000 }, { currency: 'AED', endingCash: 3672.5 }, { currency: 'HKD', endingCash: 0 } ] });
eq('dirham cash is read from the statement', cb.otherCash, [{ currency: 'AED', amount: 3672.5 }]);
const toBase = (amt, ccy) => ccy === 'AED' ? amt / PEG : ccy === 'USD' ? amt : null;
const bx = bookExposure({ rows: [], nlv: 100000, cashBook: cb, toBase });
eq('…and counted in dollars', [bx.cashEquivalents.total, bx.cashEquivalents.otherCash[0].usd], [6000, 1000]);
const noRate = bookExposure({ rows: [], nlv: 100000, cashBook: cb, toBase: null });
eq('…or left out, never added as dollars, when there is no rate', [noRate.cashEquivalents.total, noRate.cashEquivalents.otherCash[0].usd], [5000, null]);

// ── THE WATCHLIST ────────────────────────────────────────────────────────────
eq('no pre-read region for a UAE listing', regionOf('XYZ.AE'), null);
eq('…and the refusal says why', /DFM \/ ADX/.test(addEntry({}, 'watch', 'XYZ.AE').error), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
