// test/cashEquivalents.test.mjs — one list of what is cash, and the 6 Oct acceptance cases:
// IB01 on the LSE, directly held T-bills, and the two leverage numbers.
import { readFileSync, readdirSync } from 'node:fs';
import { isCashEquivalent, cashKind, isAccumulating, US_CASH_EQUIVALENTS, NON_US_CASH_EQUIVALENTS } from '../lib/cashEquivalents.js';
import { classOf, autoAddable, cashBookOf, reconcile, parseStatement } from '../lib/flex.js';
import { planTrades } from '../lib/flexTrades.js';
import { showsOnCard, isCashLeg, diffRows } from '../lib/tradecard.js';
import { bookExposure, equityDelta } from '../lib/bookExposure.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// ── the list itself ──
ok('IB01 with its LSE listing is cash', isCashEquivalent({ symbol: 'IB01', listingExchange: 'LSEETF', assetCategory: 'STK' }));
ok('IB01.L as the console writes it is cash', isCashEquivalent('IB01.L'));
ok('IB01 by conid alone is cash', isCashEquivalent({ symbol: 'X', conid: 354802220 }));
ok('a bare IB01 with no exchange is NOT matched — non-US tickers collide', !isCashEquivalent('IB01'));
ok('IB01N on MEXI is out', !isCashEquivalent({ symbol: 'IB01N', listingExchange: 'MEXI' }));
ok('TBIL on NASDAQ is cash', isCashEquivalent({ symbol: 'TBIL', listingExchange: 'NASDAQ' }));
ok('TBIL on the ASX is a different fund, not cash', !isCashEquivalent({ symbol: 'TBIL', listingExchange: 'ASX' }));
ok('TBIL.AX is not cash', !isCashEquivalent('TBIL.AX'));
eq('cashKind: a bill, a fund, neither', [cashKind({ assetCategory: 'BILL', symbol: '912797XX' }), cashKind('USFR'), cashKind('AAPL')], ['bill', 'fund', null]);
ok('IB01 is accumulating; USFR is not', isAccumulating('IB01.L') && !isAccumulating('USFR'));

// #4 USFR and SGOV unchanged.
for (const s of ['USFR', 'SGOV']) {
  ok(`${s} is still cash`, isCashEquivalent(s) && isCashEquivalent({ symbol: s, listingExchange: 'ARCA', assetCategory: 'STK' }));
  eq(`${s} still has delta 0`, equityDelta(s).delta, 0);
  ok(`${s} is still off the card`, !showsOnCard({ symbol: s }));
}

// #5 SHY / JPST / MINT — decided OUT (lib/cashEquivalents.js header: SHY carries ~1.9 duration,
// JPST and MINT are credit). They are ordinary ETFs: delta 1, on the card, auto-addable.
for (const s of ['SHY', 'JPST', 'MINT']) {
  ok(`${s} is not a cash equivalent`, !isCashEquivalent(s) && !US_CASH_EQUIVALENTS.includes(s));
  eq(`${s} carries delta 1`, equityDelta(s).delta, 1);
  eq(`${s} classes as shares`, classOf({ symbol: s, assetCategory: 'STK' }), 'shares');
}

// ── #1 Flex position IB01 (LSE), 2,500 @ 122.06 ──
const IB01 = { symbol: 'IB01', root: 'IB01', assetCategory: 'STK', listingExchange: 'LSEETF', conid: '354802220',
               currency: 'USD', qty: 2500, markPrice: 122.06, positionValue: 305150, multiplier: 1 };
eq('#1 IB01 classes as cash', classOf(IB01), 'cash');
ok('#1 IB01 is never auto-added', !autoAddable(IB01));
const rec = reconcile([], [IB01], { today: '2026-10-06', asOf: '2026-10-06' });
eq('#1 reconcile adds nothing for IB01', rec.adds, []);
eq('#1 reconcile reports it in the cash book', rec.report.map(r => `${r.kind}:${r.root}`), ['cash:IB01']);
const ib01Row = { id: 'ib01', symbol: 'IB01.L', qty: 2500, livePrice: 122.06, derived: { status: 'open', qty: 2500 } };
eq('#1 IB01 has delta 0', equityDelta('IB01.L').delta, 0);
ok('#1 IB01 is a cash leg and not on the card', isCashLeg(ib01Row) && !showsOnCard(ib01Row));
const withIb01 = bookExposure({ rows: [ib01Row], nlv: 600000 });
eq('#1 IB01 contributes nothing to delta-notional', withIb01.deltaNotional, 0);
eq('#1 and nothing to the position or swing buckets', [withIb01.buckets.positionUsd ?? null, withIb01.buckets.swingUsd ?? null].map(v => v || 0), [0, 0]);

// ── #2 an IB01 buy → no fill recorded, no Discord event ──
const ib01Buy = { tradeId: 't1:354802220', symbol: 'IB01', root: 'IB01', assetCategory: 'STK', listingExchange: 'LSEETF', conid: '354802220',
                  currency: 'USD', multiplier: 1, side: 'buy', qty: 2500, price: 122.06, date: '2026-10-06', levelOfDetail: 'ORDER' };
const plan = planTrades([], [ib01Buy], { today: '2026-10-06' });
ok('#2 an IB01 buy is out of the planner\'s scope', plan.skipped.outOfScope === 1 && !plan.creates.length && !plan.apply.length && !plan.adopt.length);
const billBuy = { ...ib01Buy, tradeId: 't2:1', symbol: '912797LB7', root: '912797LB7', assetCategory: 'BILL', listingExchange: null, conid: '1', qty: 100000, price: 98.8 };
const plan2 = planTrades([], [billBuy], { today: '2026-10-06' });
ok('#2 a T-bill buy is out of the planner\'s scope', plan2.skipped.outOfScope === 1 && !plan2.creates.length);
// Even if a row were typed by hand, the announcer only diffs what shows on the card.
const announceable = [ib01Row, { id: 'b', symbol: '912797LB7', assetCategory: 'BILL', derived: { status: 'open' } }].filter(showsOnCard);
eq('#2 a hand-typed IB01 or bill row raises no card event', diffRows([], announceable), []);

// ── #3 a directly held bill, $100k face, 3 months ──
const BILL = { symbol: '912797LB7', root: '912797LB7', assetCategory: 'BILL', currency: 'USD', qty: 100000, markPrice: 98.85,
               expiry: '20270107', description: 'B 01/07/27', multiplier: 1 };
eq('#3 a bill classes as cash', classOf(BILL), 'cash');
ok('#3 a bill is never auto-added', !autoAddable(BILL));
const book = cashBookOf({ toDate: '20261006', positions: [BILL, IB01], cash: [{ currency: 'USD', endingCash: 12345.67 }] });
eq('#3 a bill is valued at market (face × price / 100), not face', book.lines.find(l => l.kind === 'bill').value, 98850);
eq('#3 IBKR\'s own position value wins where given', book.lines.find(l => l.symbol === 'IB01').valueSource, 'ibkr');
eq('#3 the statement\'s USD cash is carried', [book.usdCash, book.cashSource], [12345.67, 'statement']);
eq('#3 without a Cash Report section, it says so', cashBookOf({ positions: [] }).cashSource, 'not in the statement (add the Cash Report section to the Flex query)');
eq('#3 a bill has delta 0', equityDelta('912797LB7', null, { assetCategory: 'BILL' }).delta, 0);

// An unknown category goes to 'other': reported, never added, never in the cash book or the book.
const ODD = { symbol: 'XYZW', root: 'XYZW', assetCategory: 'WAR', currency: 'USD', qty: 10, markPrice: 1, positionValue: 10 };
eq('an unknown category is \'other\'', classOf(ODD), 'other');
ok('…not auto-added', !autoAddable(ODD));
eq('…not in the cash book', cashBookOf({ positions: [ODD] }).lines, []);
eq('…and reported as unmatched', reconcile([], [ODD], { today: '2026-10-06' }).report.map(r => r.kind), ['unmatched']);

// parseStatement carries the listing exchange, the position value and the cash report.
const xml = `<FlexQueryResponse><FlexStatements><FlexStatement toDate="20261006">
  <OpenPositions><OpenPosition symbol="IB01" assetCategory="STK" listingExchange="LSEETF" conid="354802220" currency="USD" position="2500" markPrice="122.06" positionValue="305150" /></OpenPositions>
  <CashReport><CashReportCurrency currency="USD" endingCash="5000" /></CashReport>
</FlexStatement></FlexStatements></FlexQueryResponse>`;
const st = parseStatement(xml);
eq('the statement keeps IB01\'s exchange and value', [st.positions[0]?.listingExchange, st.positions[0]?.positionValue], ['LSEETF', 305150]);
eq('…so it classes as cash straight from the XML', classOf(st.positions[0]), 'cash');
eq('…and the cash report is read', cashBookOf(st).usdCash, 5000);

// ── #7 $300k of IB01 beside the current book ──
const NLV = 600000;
const BOOK = [
  { id: 'a', symbol: 'AAPL', qty: 1000, livePrice: 250, derived: { status: 'open', qty: 1000 } },
  { id: 'q', symbol: 'QQQ   261016C00730000', qty: 10, multiplier: 100, livePrice: 20, assetCategory: 'OPT', derived: { status: 'open', qty: 10 } },
];
const GREEKS = { 'QQQ|2026-10-16|C|730': { delta: 0.4, theta: -0.2, vega: 0.5 } };
const NOW = new Date('2026-10-06T20:00:00Z');
const before = bookExposure({ rows: BOOK, nlv: NLV, greeks: GREEKS, underlyings: { QQQ: 700 }, now: NOW });
const cashBook = { asOf: '2026-10-06', lines: [{ symbol: 'IB01', kind: 'fund', value: 300000 }], usdCash: 20000 };
const after = bookExposure({ rows: BOOK, nlv: NLV, greeks: GREEKS, underlyings: { QQQ: 700 }, now: NOW, cashBook });
eq('#7 book leverage is unchanged by $300k of IB01', after.leverage.book.ratio, before.leverage.book.ratio);
eq('#7 …and so is the 1.2× state', after.state, before.state);
eq('#7 IBKR-style leverage rises by exactly 300k / NLV', +(after.leverage.ibkr.ratio - before.leverage.ibkr.ratio).toFixed(2), 0.5);
ok('#7 both numbers are labelled', /1\.2× rule/.test(after.leverage.book.basis) && /cash equivalents included/.test(after.leverage.ibkr.basis));
eq('#7 the Cash & equivalents line sums USD cash and IB01', [after.cashEquivalents.total, after.cashEquivalents.equivalents, after.cashEquivalents.usdCash], [320000, 300000, 20000]);
eq('#7 USD cash is not in IBKR gross', after.leverage.ibkr.gross - before.leverage.ibkr.gross, 300000);
// A console IB01 row beside the cash book's IB01 is counted once.
const both = bookExposure({ rows: [...BOOK, ib01Row], nlv: NLV, greeks: GREEKS, underlyings: { QQQ: 700 }, now: NOW, cashBook });
eq('#7 IB01 in both the console and the statement is counted once', both.cashEquivalents.equivalents, 300000);
eq('#7 …and still leaves book leverage alone', both.leverage.book.ratio, before.leverage.book.ratio);

// ── #6 no local copies of the list ──
const offenders = [];
for (const dir of ['lib', 'api', 'src', 'scripts']) {
  for (const f of readdirSync(dir, { recursive: true }).filter(n => /\.(m?js|jsx)$/.test(n))) {
    const path = `${dir}/${f}`;
    if (path === 'lib/cashEquivalents.js') continue;
    const s = readFileSync(path, 'utf8');
    // A classifier list. lib/cashyield.js's SEC_YIELD_TICKERS names which funds' yields to fetch for
    // the yield card (out of scope) and decides nothing about what is cash, so it is not one.
    if (/\b(CASH_EQUIVALENTS|CASH_LIKE_ETF|CASH_LIKE)\s*=/.test(s) || /(cash|CASH)\w*\s*=\s*(new Set\()?\[\s*'(USFR|SGOV|BIL)'/.test(s)) offenders.push(path);
  }
}
eq('#6 no file defines its own cash list', offenders, []);
ok('#6 the non-US list carries IB01 with its conid', NON_US_CASH_EQUIVALENTS.some(e => e.root === 'IB01' && e.conid === '354802220'));

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
