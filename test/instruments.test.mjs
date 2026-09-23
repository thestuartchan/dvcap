// test/instruments.test.mjs — options and spreads in the journal (console rework, Step 2).
//
// Built on the brief's own acceptance cases, with the arithmetic done by hand first:
//   SOFI Nov20 17/20 ×15 @ 0.85  → max loss $1,275 · max profit $3,225 · breakeven 17.85 · hard date 13 Nov
//   XLE Jan27 55C ×5 @ 9.607     → delta ~0.90 · delta-notional ~$29k (13.7% of $211k) · hard date 8 Jan 2027
//   close 5 of 15 SOFI @ 1.65    → realised +$400 · 10 remain
import {
  instrumentOf, isDerivativeRow, legsOf, underlyingOf, legLabel, spreadShape, comboMark, markOf, comboGreeks,
  definedRisk, defaultHardDate, hardDateLimit, hardDateCheck, dteOf, optionDerived, exposureLines, optionRow,
  optionLevelVocab, normalizeLeg, MAX_LEGS, OPTION_MULTIPLIER, LEVEL_ON,
} from '../lib/instruments.js';
import { derivePosition, positionPnl, levelHits } from '../lib/positions.js';
import { bookExposure } from '../lib/bookExposure.js';
import { isOptionTrade, showsOnCard } from '../lib/tradecard.js';
import { planTrades } from '../lib/flexTrades.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const near = (n, g, w, tol) => eq(`${n} (${g} ≈ ${w} ± ${tol})`, Math.abs(g - w) <= tol, true);

const SOFI_LEGS = [
  { right: 'C', strike: 17, expiry: '2026-11-20', side: 'long', ratio: 1 },
  { right: 'C', strike: 20, expiry: '2026-11-20', side: 'short', ratio: 1 },
];
const XLE_LEGS = [{ right: 'C', strike: 55, expiry: '2027-01-15', side: 'long', ratio: 1 }];
const TODAY = '2026-09-24';

// ── WHICH KIND OF ROW ────────────────────────────────────────────────────────
{
  eq('a plain row is shares', instrumentOf({ symbol: 'SOFI' }), 'shares');
  eq('a margined row is a future', instrumentOf({ symbol: 'MNQ', margined: true }), 'future');
  eq('an explicit spread is a spread', instrumentOf({ symbol: 'SOFI', instrument: 'spread', legs: SOFI_LEGS }), 'spread');
  eq('a legacy option symbol reads as an option without being rewritten', instrumentOf({ symbol: "QQQ Oct16'26 730C", multiplier: 100 }), 'option');
  eq('and its legs are lifted from the symbol', legsOf({ symbol: "QQQ Oct16'26 730C" }), [{ right: 'C', strike: 730, expiry: '2026-10-16', side: 'long', ratio: 1 }]);
  eq('and its underlying is the root', underlyingOf({ symbol: "QQQ Oct16'26 730C" }), 'QQQ');
  eq('a spread row\'s underlying is its symbol', underlyingOf({ symbol: 'SOFI', instrument: 'spread', legs: SOFI_LEGS }), 'SOFI');
  ok('options and spreads are derivative rows', isDerivativeRow({ instrument: 'option', legs: XLE_LEGS }) && isDerivativeRow({ instrument: 'spread', legs: SOFI_LEGS }));
  ok('shares and futures are not', !isDerivativeRow({ symbol: 'SOFI' }) && !isDerivativeRow({ symbol: 'MNQ', margined: true }));
  eq('a malformed leg is dropped, not guessed at', normalizeLeg({ right: 'C', strike: 0, expiry: '2026-11-20', side: 'long' }), null);
  eq('a leg written with type/put is read', normalizeLeg({ type: 'put', strike: 15, expiry: '2026-11-20', side: 'short' }), { right: 'P', strike: 15, expiry: '2026-11-20', side: 'short', ratio: 1 });
  eq('at most four legs', MAX_LEGS, 4);
  eq('the option multiplier', OPTION_MULTIPLIER, 100);
  eq('a level watches the combo or the underlying', LEVEL_ON, ['combo', 'underlying']);
}

// ── WORDS AND SHAPES ─────────────────────────────────────────────────────────
{
  eq('the SOFI vertical, in words', legLabel(SOFI_LEGS), "Nov20'26 17/20 C");
  eq('the XLE call, in words', legLabel(XLE_LEGS), "Jan15'27 55C");
  eq('a vertical is a vertical', spreadShape(SOFI_LEGS), 'vertical');
  eq('a single is a single', spreadShape(XLE_LEGS), 'single');
  eq('same strike, different expiry is a calendar', spreadShape([{ ...XLE_LEGS[0] }, { ...XLE_LEGS[0], expiry: '2026-12-18', side: 'short' }]), 'calendar');
  eq('different strike and expiry is a diagonal', spreadShape([{ ...XLE_LEGS[0] }, { ...XLE_LEGS[0], strike: 60, expiry: '2026-12-18', side: 'short' }]), 'diagonal');
  eq('two longs are not a defined shape', spreadShape([SOFI_LEGS[0], { ...SOFI_LEGS[1], side: 'long' }]), 'other');
  eq('a 2:1 ratio is not a vertical', spreadShape([SOFI_LEGS[0], { ...SOFI_LEGS[1], ratio: 2 }]), 'other');
  eq('the vocabulary names what is watched', optionLevelVocab('stop', 'combo').verb, 'combo mark breaks below');
  eq('and the underlying when asked', optionLevelVocab('stop', 'underlying').verb, 'underlying breaks below');
  eq('TP is the target', optionLevelVocab('sell').label, 'TP');
}

// ── SOFI Nov20 17/20 ×15 @ 0.85 ──────────────────────────────────────────────
{
  const r = definedRisk(SOFI_LEGS, 0.85, { qty: 15 });
  eq('a debit call vertical', [r.shape, r.debit, r.width], ['vertical', true, 3]);
  eq('max loss $1,275', r.maxLoss, 1275);
  eq('max profit $3,225', r.maxProfit, 3225);
  eq('breakeven 17.85', r.breakeven, 17.85);
  eq('hard date defaults to expiry − 7: 13 Nov', defaultHardDate(SOFI_LEGS), '2026-11-13');
  eq('and may not be later than the trading day before expiry', hardDateLimit(SOFI_LEGS), '2026-11-19');
  eq('19 Nov is allowed', hardDateCheck('2026-11-19', SOFI_LEGS).ok, true);
  eq('20 Nov is not', hardDateCheck('2026-11-20', SOFI_LEGS).ok, false);
  ok('and the refusal names the limit', /no later than 2026-11-19/.test(hardDateCheck('2026-11-20', SOFI_LEGS).reason));
  eq('a missing hard date is refused', hardDateCheck(null, SOFI_LEGS).ok, false);
  eq('57 days to expiry on the 24th', dteOf(SOFI_LEGS, TODAY), 57);
  // A price typed the wrong way round for the strikes is named, not computed.
  ok('a credit price on a debit vertical is a mismatch', /debit/.test(definedRisk(SOFI_LEGS, -0.85).mismatch || ''));
  // The credit version of the same strikes.
  const credit = definedRisk([{ ...SOFI_LEGS[0], side: 'short' }, { ...SOFI_LEGS[1], side: 'long' }], -0.85, { qty: 15 });
  eq('the credit vertical: max profit is the credit', [credit.debit, credit.maxProfit, credit.maxLoss, credit.breakeven], [false, 1275, 3225, 17.85]);
  // Puts.
  const put = definedRisk([{ right: 'P', strike: 20, expiry: '2026-11-20', side: 'long' }, { right: 'P', strike: 17, expiry: '2026-11-20', side: 'short' }], 1.10, { qty: 10 });
  eq('a debit put vertical breaks even below the long strike', [put.debit, put.maxLoss, put.maxProfit, put.breakeven], [true, 1100, 1900, 18.9]);
}

// ── THE ROW, THE FILL, THE PARTIAL CLOSE ─────────────────────────────────────
{
  const made = optionRow({ underlying: 'sofi', legs: SOFI_LEGS, qty: 15, price: 0.85, date: '2026-09-24' });
  ok('the row is built', !!made.row);
  const row = made.row;
  eq('symbol is the underlying', row.symbol, 'SOFI');
  eq('instrument is a spread', row.instrument, 'spread');
  eq('the multiplier is the option\'s', row.multiplier, 100);
  eq('hard date defaulted', row.hardDate, '2026-11-13');
  eq('one opening fill at the combo price', [row.fills.length, row.fills[0].side, row.fills[0].qty, row.fills[0].price], [1, 'buy', 15, 0.85]);
  const d = derivePosition(row.fills, { multiplier: 100, side: 'long' });
  eq('15 open at 0.85', [d.qty, d.avgCost, d.spent], [15, 0.85, 1275]);
  // Close 5 of 15 @ 1.65 → realised +$400, 10 remain.
  const d2 = derivePosition([...row.fills, { id: 'x', date: '2026-10-10', side: 'sell', qty: 5, price: 1.65 }], { multiplier: 100, side: 'long' });
  eq('close 5 of 15 at 1.65: realised +$400', d2.realized, 400);
  eq('10 remain', d2.qty, 10);
  eq('and the P&L at a 1.60 mark', positionPnl(d2, 1.60).unrealized, 750);
  // Refusals.
  eq('no underlying, no row', optionRow({ legs: SOFI_LEGS }).error, 'an underlying is required');
  ok('no legs, no row', /at least one leg/.test(optionRow({ underlying: 'SOFI', legs: [] }).error));
  ok('a quantity without a price is refused', /both a quantity and a net price/.test(optionRow({ underlying: 'SOFI', legs: SOFI_LEGS, qty: 15 }).error));
  ok('a hard date after expiry is refused', /no later than/.test(optionRow({ underlying: 'SOFI', legs: SOFI_LEGS, hardDate: '2026-11-25' }).error));
  eq('with no fill it is a setup', optionRow({ underlying: 'SOFI', legs: SOFI_LEGS }).row.fills, []);
  eq('a single leg is an option', optionRow({ underlying: 'XLE', legs: XLE_LEGS }).row.instrument, 'option');
}

// ── THE MARK, LIVE THEN TYPED THEN THE FILL ──────────────────────────────────
{
  const greeks = {
    'SOFI|2026-11-20|C|17': { mark: 1.42, bid: 1.40, ask: 1.44, delta: 0.62, theta: -0.012 },
    'SOFI|2026-11-20|C|20': { mark: 0.48, bid: 0.46, ask: 0.50, delta: 0.29, theta: -0.009 },
  };
  const cm = comboMark('SOFI', SOFI_LEGS, greeks);
  eq('combo mark is the signed sum of the legs', cm.mark, 0.94);
  eq('every leg priced', [cm.complete, cm.missing], [true, []]);
  const half = comboMark('SOFI', SOFI_LEGS, { 'SOFI|2026-11-20|C|17': greeks['SOFI|2026-11-20|C|17'] });
  eq('one leg missing: no mark, and the leg is named', [half.mark, half.missing], [null, ['SOFI|2026-11-20|C|20']]);
  eq('the midpoint is used when there is no theo', comboMark('SOFI', [SOFI_LEGS[0]], { 'SOFI|2026-11-20|C|17': { bid: 1.40, ask: 1.44 } }).mark, 1.42);
  const row = { symbol: 'SOFI', instrument: 'spread', legs: SOFI_LEGS, fills: [{ side: 'buy', qty: 15, price: 0.85, date: '2026-09-24' }] };
  eq('live wins', markOf(row, { greeks }).source, 'live');
  eq('a typed mark next', [markOf({ ...row, mark: 0.9 }).value, markOf({ ...row, mark: 0.9 }).source], [0.9, 'manual']);
  eq('then the last fill, and it says so', [markOf(row).value, markOf(row).source], [0.85, 'fill']);
  eq('nothing at all is null, not zero', markOf({ ...row, fills: [] }).value, null);
  const g = comboGreeks('SOFI', SOFI_LEGS, greeks);
  eq('net delta is the signed sum', [g.delta, g.source], [0.33, 'live']);
  eq('theta too', g.theta, -0.003);
  // A leg with a mark but no published delta is modelled, and the reading says so.
  const gm = comboGreeks('SOFI', [SOFI_LEGS[0]], { 'SOFI|2026-11-20|C|17': { mark: 1.42 } }, { spot: 16.7, now: new Date(`${TODAY}T14:00:00Z`) });
  eq('modelled when the feed gives a mark but no delta', gm.source, 'modelled');
  ok('and the modelled delta is a call delta', gm.delta > 0.4 && gm.delta < 0.8);
  eq('a leg with nothing is a hole, not a partial sum', comboGreeks('SOFI', SOFI_LEGS, {}).delta, null);
}

// ── THE DERIVED BLOCK, ON THE BRIEF'S TWO POSITIONS ──────────────────────────
{
  const nlv = 211000;
  const xle = { id: 'xle', symbol: 'XLE', instrument: 'option', legs: XLE_LEGS, side: 'long', multiplier: 100,
    fills: [{ side: 'buy', qty: 5, price: 9.607, date: '2026-09-24' }] };
  xle.derived = derivePosition(xle.fills, { multiplier: 100, side: 'long' });
  const greeks = { 'XLE|2027-01-15|C|55': { mark: 9.80, delta: 0.90, theta: -0.01 } };
  const o = optionDerived(xle, { greeks, spots: { XLE: 64.4 }, nlv, today: TODAY });
  eq('a single-leg option', [o.instrument, o.shape, o.label], ['option', 'single', "Jan15'27 55C"]);
  eq('delta ~0.90, live', [o.netDelta, o.deltaSource], [0.9, 'live']);
  eq('delta-notional 0.90 × 64.4 × 100 × 5', o.deltaNotional, 28980);
  eq('13.7% of NLV', o.pctNlv, 13.7);
  eq('hard date 8 Jan 2027', o.hardDate, '2027-01-08');
  eq('and it is the default', o.hardDateDefault, true);
  eq('a stored date equal to the default still reads as the default', optionDerived({ ...xle, hardDate: '2027-01-08' }, { greeks, spots: {}, nlv, today: TODAY }).hardDateDefault, true);
  eq('a different stored date is the user\'s', optionDerived({ ...xle, hardDate: '2027-01-06' }, { greeks, spots: {}, nlv, today: TODAY }).hardDateDefault, false);
  eq('premium at risk is the mark × 100 × 5', o.premiumAtRisk, 4900);
  eq('max loss is what was paid', o.maxLoss, 4803.5);
  eq('a long call\'s profit is unlimited', [o.maxProfit, o.unlimited], [null, 'profit']);
  eq('breakeven 64.607', o.breakeven, 64.607);
  eq('not reached, not expired', [o.hardDateReached, o.expired], [false, false]);
  // The hard date, reached.
  const late = optionDerived(xle, { greeks, spots: { XLE: 64.4 }, nlv, today: '2027-01-08' });
  eq('from the morning of the hard date the row flags', late.hardDateReached, true);
  eq('and past expiry it says so', optionDerived(xle, { greeks, spots: { XLE: 64.4 }, nlv, today: '2027-01-16' }).expired, true);
  // A typed hard date past the limit is carried but refused.
  const bad = optionDerived({ ...xle, hardDate: '2027-01-20' }, { greeks, spots: {}, nlv, today: TODAY });
  eq('a hard date after the limit is refused with the limit named', [bad.hardDateOk, bad.hardDateLimit], [false, '2027-01-14']);
  // The SOFI vertical, with a short row's delta flipped.
  const sofi = { id: 's', symbol: 'SOFI', instrument: 'spread', legs: SOFI_LEGS, side: 'long', multiplier: 100, fills: [{ side: 'buy', qty: 15, price: 0.85, date: '2026-09-24' }] };
  sofi.derived = derivePosition(sofi.fills, { multiplier: 100, side: 'long' });
  const sg = { 'SOFI|2026-11-20|C|17': { mark: 1.42, delta: 0.62 }, 'SOFI|2026-11-20|C|20': { mark: 0.48, delta: 0.29 } };
  const so = optionDerived(sofi, { greeks: sg, spots: { SOFI: 16.7 }, nlv, today: TODAY });
  eq('the vertical\'s numbers', [so.maxLoss, so.maxProfit, so.breakeven, so.hardDate, so.dte], [1275, 3225, 17.85, '2026-11-13', 57]);
  eq('combo mark live at 0.94', [so.mark, so.markSource], [0.94, 'live']);
  eq('net delta 0.33 → delta-notional 0.33 × 16.7 × 100 × 15', so.deltaNotional, 8266.5);
  eq('the risk is measured from the entry, not the mark', so.premiumAtRisk, 1410);
  const short = optionDerived({ ...sofi, side: 'short', fills: [{ side: 'sell', qty: 15, price: 0.85, date: '2026-09-24' }] }, { greeks: sg, spots: { SOFI: 16.7 }, nlv, today: TODAY });
  eq('a short row carries the opposite delta', short.netDelta, -0.33);
  eq('a share row has no option block', optionDerived({ symbol: 'SOFI', derived: { qty: 500 } }, {}), null);
}

// ── THE EXPOSURE BOOK SEES EVERY LEG ─────────────────────────────────────────
{
  const sofi = { id: 's', symbol: 'SOFI', instrument: 'spread', legs: SOFI_LEGS, side: 'long', multiplier: 100, currency: 'USD', derived: { qty: 15 } };
  const lines = exposureLines(sofi);
  eq('a vertical is two lines', lines.length, 2);
  eq('signed by the leg', lines.map(l => l.qty), [15, -15]);
  eq('each carries its contract', lines.map(l => l.contract.strike), [17, 20]);
  eq('and no cost of its own — a leg is priced by the feed or counted unpriced', lines.map(l => l.derived.avgCost), [undefined, undefined]);
  eq('a share row passes through', exposureLines({ id: 'x', symbol: 'SOFI', derived: { qty: 500 } }).length, 1);
  // Through the book: shares + the two legs sum under SOFI.
  const rows = [{ id: 'sh', symbol: 'SOFI', qty: 500, derived: { qty: 500 } }, ...lines.map(l => ({ ...l, qty: l.qty }))];
  const book = bookExposure({ rows, greeks: { 'SOFI|2026-11-20|C|17': { delta: 0.62, mark: 1.42 }, 'SOFI|2026-11-20|C|20': { delta: 0.29, mark: 0.48 } }, underlyings: { SOFI: 16.7 }, nlv: 211000 });
  const g = book.byUnderlying.SOFI;
  eq('shares 500 × 16.7', g.shares, 8350);
  eq('options 0.33 × 16.7 × 100 × 15', g.options, 8266.5);
  near('combined ~7.9% of NLV', g.pctNlv, 7.9, 0.05);
  eq('three lines, none unpriced', [g.lines, g.unpriced], [3, 0]);
  // A leg's premium is at the feed's mark, not the combo's average.
  const leg = book.lines.find(l => l.contract?.strike === 17);
  eq('the leg is priced at its own mark', leg.mark, 1.42);
}

// ── LEVELS ON THE COMBO, ALERTS THROUGH THE SAME ENGINE ──────────────────────
{
  const row = { id: 's', symbol: 'SOFI', instrument: 'spread', legs: SOFI_LEGS, side: 'long',
    levels: [{ id: 'tp', kind: 'sell', at: 1.60 }, { id: 'st', kind: 'stop', at: 0.43 }, { id: 'us', kind: 'stop', at: 15.50, on: 'underlying' }] };
  const priceOf = (r, lv) => (lv?.on === 'underlying' ? 16.7 : 1.62);
  const hits = levelHits([row], priceOf);
  eq('combo mark ≥ 1.60 fires the TP', hits.map(h => h.level.id), ['tp']);
  const drop = levelHits([row], (r, lv) => (lv?.on === 'underlying' ? 15.4 : 0.9));
  eq('the underlying trigger fires on its own price', drop.map(h => h.level.id), ['us']);
  eq('a share row\'s priceOf still works with one argument', levelHits([{ id: 'x', symbol: 'A', side: 'long', levels: [{ kind: 'stop', at: 10 }] }], () => 9).length, 1);
}

// ── NEVER ON THE CARD, NEVER IN THE PLANNER ──────────────────────────────────
{
  const spread = { id: 's', symbol: 'SOFI', instrument: 'spread', legs: SOFI_LEGS, multiplier: 100, derived: { status: 'open', qty: 15 }, fills: [] };
  ok('a spread is an option trade to the card', isOptionTrade(spread));
  ok('and does not show on it', !showsOnCard(spread));
  ok('a share row still does', showsOnCard({ symbol: 'SOFI', multiplier: 1 }));
  // The statement's SOFI share trade must land on the share row, not the spread.
  const shares = { id: 'sh', symbol: 'SOFI', currency: 'USD', derived: { status: 'open', qty: 500 }, fills: [{ id: 'f', side: 'buy', qty: 500, price: 16.675, date: '2026-09-20' }] };
  const trade = { tradeId: 't1', root: 'SOFI', symbol: 'SOFI', currency: 'USD', date: '2026-09-25', side: 'sell', qty: 200, price: 19.25, assetCategory: 'STK', multiplier: 1 };
  const plan = planTrades([shares, spread], [trade], { today: '2026-09-26' });
  eq('applied to the share row, not refused as ambiguous', plan.apply.map(a => a.rowId), ['sh']);
  eq('nothing reported', plan.report.length, 0);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
