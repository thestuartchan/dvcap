// test/sameDayFills.test.mjs — "Sync now" (IBKR's same-day Trade Confirmation report) and
// "Confirm all exact matches". Fake order ids and a fake account throughout; a Redis stand-in and a
// Flex stand-in answer through fetch, so nothing touches the network.
import { parseTradeConfirms, parseTrades, planTrades, tcSections } from '../lib/flexTrades.js';
import { orderUnits, matchNote, processInbox, applyDraft, validateNote, exactMatch, bulkCandidates, bulkLabel, bulkSummary, DRAFTS_KEY, PROCESSED_KEY, INBOX_KEY } from '../lib/journalInbox.js';
import { adoptProvisional, upgradeDrafts, skipOnSameDay, syncNowLine, skippedNote, recordLag, lagText, nyEpochMs, provisionalBadge } from '../lib/sameDayFills.js';
import { fillOf } from '../lib/journalInbox.js';
import { derivePosition } from '../lib/positions.js';
import { mintSession, sessionCookie } from '../lib/session.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

// ── FIXTURES (fake ids) ──────────────────────────────────────────────────────
const tc = (rows) => `<FlexQueryResponse queryName="same-day" type="TCF"><FlexStatements count="1"><FlexStatement accountId="U0000000" fromDate="20261012" toDate="20261012" period="Today"><TradeConfirms>${rows.join('')}</TradeConfirms></FlexStatement></FlexStatements></FlexQueryResponse>`;
const opt = (o) => `<TradeConfirm accountId="U0000000" currency="USD" assetCategory="OPT" symbol="${o.u} x" conid="${o.conid}" underlyingSymbol="${o.u}" multiplier="100" strike="${o.k}" expiry="${o.exp}" putCall="${o.r}" tradeID="${o.tid || ''}" tradeDate="20261012" dateTime="20261012;${o.t || '101200'}" buySell="${o.side}" quantity="${o.side === 'SELL' ? -o.q : o.q}" price="${o.px}" commission="${o.c ?? -5.2}" orderID="${o.oid}" levelOfDetail="${o.lvl || 'ORDER'}" transactionType="ExchTrade" />`;
const stk = (o) => `<TradeConfirm accountId="U0000000" currency="USD" assetCategory="${o.cat || 'STK'}" symbol="${o.sym}" conid="${o.conid}" ${o.u ? `underlyingSymbol="${o.u}"` : ''} multiplier="${o.m || 1}" tradeID="${o.tid || ''}" tradeDate="20261012" dateTime="20261012;${o.t || '101500'}" buySell="${o.side}" quantity="${o.side === 'SELL' ? -o.q : o.q}" price="${o.px}" commission="${o.c ?? -1}" orderID="${o.oid}" levelOfDetail="${o.lvl || 'ORDER'}" transactionType="ExchTrade" />`;

const FCX = [
  opt({ u: 'FCX', conid: 9001, k: 75, exp: '20261120', r: 'C', side: 'BUY', q: 8, px: 5.10, oid: 900001 }),
  opt({ u: 'FCX', conid: 9002, k: 85, exp: '20261120', r: 'C', side: 'SELL', q: 8, px: 2.40, oid: 900001 }),
];
const SPLIT = [
  opt({ u: 'SPY', conid: 9101, k: 750, exp: '20261120', r: 'C', side: 'BUY', q: 2, px: 30.00, oid: 900004, t: '102000' }),
  opt({ u: 'SPY', conid: 9102, k: 760, exp: '20261120', r: 'C', side: 'SELL', q: 2, px: 24.00, oid: 900005, t: '102100' }),
];
const SOFI_EXEC = [
  stk({ sym: 'SOFI', conid: 7001, side: 'BUY', q: 100, px: 20.00, oid: 900002, tid: 'e1', lvl: 'EXECUTION', c: -0.5, t: '101500' }),
  stk({ sym: 'SOFI', conid: 7001, side: 'BUY', q: 50, px: 20.03, oid: 900002, tid: 'e2', lvl: 'EXECUTION', c: -0.5, t: '101530' }),
];
const MES = [stk({ sym: 'MESZ6', u: 'MES', cat: 'FUT', conid: 6001, m: 5, side: 'BUY', q: 1, px: 7900.25, oid: 900003, c: -0.62 })];

// ── PARSING THE SAME-DAY REPORT ──────────────────────────────────────────────
{
  const one = parseTradeConfirms(tc([FCX[0]]));
  eq('a single-leg option: one trade, keyed order:conid, the contract read', [one.length, one[0].tradeId, one[0].root, one[0].right, one[0].strike, one[0].expiry, one[0].qty, one[0].side, one[0].rawPrice],
    [1, '900001:9001', 'FCX', 'C', 75, '2026-11-20', 8, 'buy', 5.1]);
  const u1 = orderUnits(one);
  eq('… and one OPT unit', [u1.length, u1[0].type, u1[0].orderId], [1, 'OPT', '900001']);

  const combo = orderUnits(parseTradeConfirms(tc(FCX)));
  eq('a 2-leg combo filled as ONE order is one COMBO unit, net 2.70 debit', [combo.length, combo[0].type, combo[0].legs.length, combo[0].qty, combo[0].side, combo[0].rawPrice], [1, 'COMBO', 2, 8, 'BUY', 2.7]);

  const split = orderUnits(parseTradeConfirms(tc(SPLIT)));
  eq('a combo filled as separate single-leg orders stays two OPT units', split.map(u => [u.type, u.orderId]), [['OPT', '900004'], ['OPT', '900005']]);
  const spyNote = validateNote({ id: 'spy-call-spread', kind: 'open', trade_date: '2026-10-12', instrument: { type: 'COMBO', symbol: 'SPY',
    legs: [{ right: 'C', strike: 750, expiry: '2026-11-20', side: 'BUY', ratio: 1 }, { right: 'C', strike: 760, expiry: '2026-11-20', side: 'SELL', ratio: 1 }] }, expected: { qty: 2, price: 6 } }).note;
  eq('… and neither order matches the COMBO note as one, as on the statement path', split.map(u => matchNote(spyNote, u)), [null, null]);

  const sofi = parseTradeConfirms(tc(SOFI_EXEC));
  eq('shares at EXECUTION level: the pieces of one order are summed at the average price', [sofi.length, sofi[0].tradeId, sofi[0].qty, sofi[0].rawPrice, sofi[0].commission],
    [1, '900002:7001', 150, 20.01, 1]);
  eq('… the per-execution tradeID is ignored, so the key is the order the statement uses', parseTrades('<Order ibOrderID="900002" conid="7001" symbol="SOFI" assetCategory="STK" currency="USD" multiplier="1" buySell="BUY" quantity="150" tradePrice="20.01" ibCommission="-1" tradeDate="20261012" />')[0].tradeId, sofi[0].tradeId);
  const fut = orderUnits(parseTradeConfirms(tc(MES)));
  eq('a future: one FUT unit under its product root', [fut[0].type, fut[0].root, fut[0].qty, fut[0].multiplier, fut[0].side], ['FUT', 'MES', 1, 5, 'BUY']);
  eq('an empty report is no trades, not an error', parseTradeConfirms(tc([])), []);
}

// ── WHAT A QUERY SET TO "ORDER" ACTUALLY SENDS (12 Oct, first live run) ──────
// <Order> rows, plus <SymbolSummary> totals — not <TradeConfirm>. Reading only <TradeConfirm> said
// "no fills" over a report of filled orders.
{
  const asOrder = (row) => row.replace('<TradeConfirm ', '<Order ').replace('levelOfDetail="ORDER"', '');
  const summary = '<SymbolSummary accountId="U0000000" currency="USD" assetCategory="OPT" symbol="FCX x" underlyingSymbol="FCX" buySell="BUY" quantity="8" price="5.10" levelOfDetail="SYMBOL_SUMMARY" />';
  const xml = tc([summary, ...FCX.map(asOrder), asOrder(stk({ sym: 'SOFI', conid: 7001, side: 'BUY', q: 150, px: 20.01, oid: 900002 }))]);
  const got = parseTradeConfirms(xml);
  eq('Order-level rows are read; the symbol summary is not a fill', [got.length, got.map(t => t.tradeId)], [3, ['900001:9001', '900001:9002', '900002:7001']]);
  eq('… and make the same units as before', orderUnits(got).map(u => [u.type, u.orderId, u.qty]), [['COMBO', '900001', 8], ['STK', '900002', 150]]);
  const onlySummary = tc([summary]);
  eq('only symbol summaries: nothing parsed, and the line says to set the level to Order', [parseTradeConfirms(onlySummary).length, skippedNote(tcSections(onlySummary))],
    [0, ' — the report has only symbol summaries; set the query\'s level of detail to Order']);
  const noIds = tc(FCX.map(asOrder).map(r => r.replace(/orderID="\d+"/, '')));
  eq('rows that cannot be read are counted by reason, never shown', syncNowLine({ fate: {}, units: [], sections: tcSections(noIds) }),
    'No fills in IBKR\'s same-day report yet — but the report had 2 rows and none could be read (2 no order id); check the query\'s fields');
}

// ── THE SAME-DAY PATH DRAFTS ONLY, AND LEAVES DAY TRADES OUT ─────────────────
const FCX_NOTE = validateNote({ id: 'fcx-nov-75-85c', kind: 'open', trade_date: '2026-10-12', tag: 'swing', rationale: 'copper',
  instrument: { type: 'COMBO', symbol: 'FCX', legs: [{ right: 'C', strike: 75, expiry: '2026-11-20', side: 'BUY', ratio: 1 }, { right: 'C', strike: 85, expiry: '2026-11-20', side: 'SELL', ratio: 1 }] },
  expected: { qty: 8, price: 2.70, tolerance_pct: 3 } }).note;
const zeroDte = opt({ u: 'SPY', conid: 9201, k: 780, exp: '20261012', r: 'C', side: 'BUY', q: 5, px: 1.2, oid: 900010 });
const oneDte = opt({ u: 'IWM', conid: 9202, k: 250, exp: '20261013', r: 'P', side: 'BUY', q: 3, px: 0.8, oid: 900011 });
const qqq = opt({ u: 'QQQ', conid: 9203, k: 760, exp: '20261120', r: 'C', side: 'BUY', q: 1, px: 9.0, oid: 900012 });
// One report is one level of detail; this one is ORDER, as the query is set up (the PR's steps).
const SOFI = stk({ sym: 'SOFI', conid: 7001, side: 'BUY', q: 150, px: 20.01, oid: 900002, c: -1, t: '101530' });
const sameDay = parseTradeConfirms(tc([...FCX, SOFI, zeroDte, oneDte, qqq]));
const run = processInbox({ notes: [FCX_NOTE], trades: sameDay, today: '2026-10-12', provisional: true, skipUnjournaled: (u) => skipOnSameDay(u), now: '2026-10-12T14:20:00Z' });
const fcxDraft = run.drafts.find(d => d.id === 'd-900001');
eq('the note matched its fill; the draft is marked same-day', [fcxDraft?.source, fcxDraft?.fill?.provisional, fcxDraft?.checks.map(c => c.ok)], ['note', true, [true, true]]);
eq('fates: FCX matched, SOFI unjournaled, 0DTE a day trade, 1DTE and QQQ options left out', run.fate,
  { 900001: 'matched', 900002: 'unjournaled', 900010: 'dayTrade', 900011: 'excluded', 900012: 'excluded' });
eq('the one-line answer', syncNowLine({ fate: run.fate, units: run.units }), '5 fills found, 1 matched a note ✓, 1 unjournaled, 3 day trades left out');
eq('nothing in the report: said, with what to do', syncNowLine({ fate: {}, units: [] }), 'No fills in IBKR\'s same-day report yet — if you just traded, it is not in IBKR\'s report yet; try again in a few minutes');
eq('a note for today with nothing to match: not silent', syncNowLine({ fate: { 1: 'unjournaled' }, units: [{ orderId: '1', type: 'STK' }], waitingToday: 1 }),
  '1 fill found, 0 matched a note, 1 unjournaled · 1 note for today still waiting — not in IBKR\'s report yet, try again in a few minutes');
const again = processInbox({ notes: [], trades: sameDay, today: '2026-10-12', seen: run.seen, drafts: run.drafts, provisional: true, skipUnjournaled: (u) => skipOnSameDay(u) });
eq('a second click drafts nothing twice', [again.drafts.length, again.fate['900001'], again.fate['900002']], [run.drafts.length, 'seen', 'seen']);

// ── INTRADAY → NEXT MORNING ──────────────────────────────────────────────────
const confirmed = applyDraft([], fcxDraft, {}, { today: '2026-10-12' });
const sofiDraft = run.drafts.find(d => d.id === 'd-900002');
const both = applyDraft(confirmed.rows, sofiDraft, {}, { today: '2026-10-12' });
const rows = both.rows;
eq('confirmed from the same-day report: written provisional', rows.map(r => r.fills.map(f => [f.tradeId, f.provisional?.since])), [[['900001', '2026-10-12']], [['900002:7001', '2026-10-12']]]);
const badge = provisionalBadge(rows[0].fills[0]);
eq('the card says same-day', [badge.text, badge.warn], ['same-day', false]);

// The next morning's statement: <Order> rows, ibOrderID — the same ids.
const stmtOrders = (sofiPx = '20.01') => '<FlexStatement toDate="20261012">' +
  '<Order ibOrderID="900001" conid="9001" symbol="FCX x" underlyingSymbol="FCX" assetCategory="OPT" currency="USD" multiplier="100" strike="75" expiry="20261120" putCall="C" buySell="BUY" quantity="8" tradePrice="5.10" ibCommission="-5.2" tradeDate="20261012" />' +
  '<Order ibOrderID="900001" conid="9002" symbol="FCX y" underlyingSymbol="FCX" assetCategory="OPT" currency="USD" multiplier="100" strike="85" expiry="20261120" putCall="C" buySell="SELL" quantity="-8" tradePrice="2.40" ibCommission="-5.2" tradeDate="20261012" />' +
  `<Order ibOrderID="900002" conid="7001" symbol="SOFI" assetCategory="STK" currency="USD" multiplier="1" buySell="BUY" quantity="150" tradePrice="${sofiPx}" ibCommission="-1" tradeDate="20261012" />` +
  '</FlexStatement>';
{
  const stmt = parseTrades(stmtOrders());
  const ad = adoptProvisional(rows, orderUnits(stmt), { asOf: '2026-10-12' });
  eq('the statement adopts both by order id and clears the mark', [ad.adopted.map(a => [a.rowId, a.how]), ad.rows.flatMap(r => r.fills.map(f => !!f.provisional))],
    [[[rows[0].id, 'order id'], [rows[1].id, 'order id']], [false, false]]);
  const withD = ad.rows.map(r => ({ ...r, derived: derivePosition(r.fills, { multiplier: r.multiplier, side: r.side }) }));
  const plan = planTrades(withD, stmt, { from: '2026-10-01', today: '2026-10-13', positions: [{ root: 'SOFI', currency: 'USD', qty: 150 }] });
  eq('… so the planner sees SOFI as already recorded: no duplicate', [plan.apply.length, plan.creates.length, plan.skipped.alreadyRecorded], [0, 0, 1]);
  eq('… and the row still holds 150, once', derivePosition(ad.rows[1].fills, {}).qty, 150);

  const fixed = adoptProvisional(rows, orderUnits(parseTrades(stmtOrders('20.05'))), { asOf: '2026-10-12' });
  eq('the statement corrects the price when it differs, and names the root for the gate', [fixed.corrected[0]?.fixed.map(x => x.field), fixed.rows[1].fills[0].price > 20.04, fixed.roots], [['price'], true, ['SOFI']]);

  const without = adoptProvisional(rows, orderUnits(parseTrades('<FlexStatement toDate="20261012"></FlexStatement>')), { asOf: '2026-10-12' });
  eq('a statement that lacks it: flagged, kept, not deleted', [without.missing.map(m => m.fillId), without.rows.flatMap(r => r.fills.length), without.changed],
    [rows.flatMap(r => r.fills.map(f => f.id)), [1, 1], false]);
  const warn = provisionalBadge(rows[0].fills[0], without.missing);
  eq('… and the card says which statement did not have it', [warn.text, warn.warn], ['not in IBKR\'s 2026-10-12 statement', true]);
  const older = adoptProvisional(rows, [], { asOf: '2026-10-09' });
  eq('a statement from before the fill flags nothing', older.missing.length, 0);

  const otherIds = stmtOrders().replace(/900001/g, '555001').replace(/900002/g, '555002');
  const fb = adoptProvisional(rows, orderUnits(parseTrades(otherIds)), { asOf: '2026-10-12' });
  eq('if the two reports ever disagree on the order id, one same contract/side/qty/date order is adopted, named as such', [fb.adopted.map(a => a.how.startsWith('contract')), fb.rows[0].fills[0].tradeId],
    [[true, true], '555001']);
}
{
  // A same-day draft still waiting when the statement arrives takes the statement's numbers.
  const units = orderUnits(parseTrades(stmtOrders('20.05')));
  const up = upgradeDrafts(run.drafts, units, { asOf: '2026-10-12', fillOf, rematch: (n, u) => matchNote(n, u) });
  const s = up.drafts.find(d => d.id === 'd-900002');
  eq('a waiting same-day draft takes the statement\'s numbers and is no longer provisional', [s.fill.provisional, s.fill.rawPrice, up.changed], [undefined, 20.05, 2]);
}

// ── A SPREAD LEGGED IN (12 Oct): one leg reaches the report before the other ─
{
  const legBuy = opt({ u: 'XYZ', conid: 9301, k: 85, exp: '20261023', r: 'C', side: 'BUY', q: 4, px: 1.75, oid: 700001, t: '103000' });
  const legSell = opt({ u: 'XYZ', conid: 9302, k: 89, exp: '20261023', r: 'C', side: 'SELL', q: 4, px: 0.54, oid: 700002, t: '102000' });
  const note = validateNote({ id: 'xyz-85-89c', kind: 'open', trade_date: '2026-10-12', instrument: { type: 'COMBO', symbol: 'XYZ',
    legs: [{ right: 'C', strike: 85, expiry: '2026-10-23', side: 'BUY', ratio: 1 }, { right: 'C', strike: 89, expiry: '2026-10-23', side: 'SELL', ratio: 1 }] },
    expected: { qty: 4, price: 1.21 } }).note;
  const first = processInbox({ notes: [note], trades: parseTradeConfirms(tc([legSell])), today: '2026-10-12', provisional: true });
  eq('one leg in the report: held for its pair, not offered as an unjournaled fill', [first.drafts.length, first.fate['700002'], syncNowLine({ fate: first.fate, units: first.units })],
    [0, 'awaitingPair', '1 fill found, 0 matched a note, 1 spread leg held for the other leg, 0 unjournaled']);
  const stale = [{ id: 'd-700002', kind: 'fill', source: 'unjournaled', note: null, checks: [], fill: { orderId: '700002' } }];
  const withdrawn = processInbox({ notes: [note], trades: parseTradeConfirms(tc([legSell])), today: '2026-10-12', drafts: stale, seen: { 700002: { date: '2026-10-12', note: null } } });
  eq('a leg offered alone before this rule is withdrawn while its note waits', withdrawn.drafts.length, 0);
  const both = processInbox({ notes: [note], trades: parseTradeConfirms(tc([legSell, legBuy])), today: '2026-10-12', seen: first.seen, provisional: true });
  const spread = both.drafts[0];
  eq('both legs in: one spread draft from the two orders', [both.drafts.length, spread.fill.orderId, spread.fill.type, spread.fill.rawPrice], [1, '700001+700002', 'COMBO', 1.21]);

  // The WFC case: the first leg had already been confirmed on its own before the spread was drafted.
  const legRow = applyDraft([], { id: 'd-700002', kind: 'fill', source: 'unjournaled', note: null, checks: [],
    fill: { ...fillOf(orderUnits(parseTradeConfirms(tc([legSell])))[0]), provisional: true } }, {}, { today: '2026-10-12' }).rows;
  const again = processInbox({ notes: [note], trades: parseTradeConfirms(tc([legSell, legBuy])), today: '2026-10-12', known: new Set(['700002']) });
  const d2 = again.drafts[0];
  eq('a spread whose leg is already on the console says so, and is never an exact match', [d2.recordedParts, exactMatch(d2).ok], [['700002'], false]);
  const refused = applyDraft(legRow, d2, {}, { today: '2026-10-12' });
  eq('… and confirming it is refused, naming the row, instead of recording the leg twice', [!!refused.error, refused.error?.includes(legRow[0].id)], [true, true]);

  // Confirmed whole, then the next morning: the statement has two single-leg orders, adopted as one.
  const made = applyDraft([], spread, {}, { today: '2026-10-12' });
  eq('the spread is written once, provisional, keyed by both orders', made.rows.map(r => [r.fills.length, r.fills[0].tradeId, !!r.fills[0].provisional]), [[1, '700001+700002', true]]);
  const stmt = '<FlexStatement toDate="20261012">' +
    '<Order ibOrderID="700001" conid="9301" symbol="XYZ a" underlyingSymbol="XYZ" assetCategory="OPT" currency="USD" multiplier="100" strike="85" expiry="20261023" putCall="C" buySell="BUY" quantity="4" tradePrice="1.75" ibCommission="-5.2" tradeDate="20261012" />' +
    '<Order ibOrderID="700002" conid="9302" symbol="XYZ b" underlyingSymbol="XYZ" assetCategory="OPT" currency="USD" multiplier="100" strike="89" expiry="20261023" putCall="C" buySell="SELL" quantity="-4" tradePrice="0.54" ibCommission="-5.2" tradeDate="20261012" />' +
    '</FlexStatement>';
  const ad = adoptProvisional(made.rows, orderUnits(parseTrades(stmt)), { asOf: '2026-10-12' });
  eq('the statement adopts the legged spread from its two orders, nothing flagged missing', [ad.adopted.length, ad.missing.length, !!ad.rows[0].fills[0].provisional], [1, 0, false]);
  const up = upgradeDrafts([spread], orderUnits(parseTrades(stmt)), { asOf: '2026-10-12', fillOf, rematch: (n, u) => matchNote(n, u) });
  eq('a waiting legged-spread draft takes the statement\'s numbers too', [up.changed, up.drafts[0].fill.provisional, up.drafts[0].fill.statementMissing], [1, undefined, undefined]);
}

// ── CONFIRM ALL EXACT MATCHES ────────────────────────────────────────────────
{
  const base = { kind: 'fill', state: 'DRAFT', source: 'note' };
  const exact = { ...base, id: 'd-1', fill: fcxDraft.fill, note: fcxDraft.note, checks: fcxDraft.checks };
  const trim = { ...exact, id: 'd-2', note: { ...exact.note, kind: 'trim' } };
  const plan = { ...exact, id: 'd-3', note: { ...exact.note, kind: 'plan' } };
  const dated = { ...exact, id: 'd-4', checks: [...exact.checks, { field: 'date', note: '2026-10-09', ibkr: '2026-10-12', ok: true, soft: true }] };
  const amend = { id: 'm-1', kind: 'amend', state: 'DRAFT', supersedes: 'FCX-1', note: { kind: 'amend' } };
  const ambiguous = { id: 'a-1', kind: 'ambiguous', state: 'DRAFT', note: exact.note, candidates: [{ fill: exact.fill, checks: exact.checks }] };
  const unjournaled = { ...base, id: 'd-5', source: 'unjournaled', note: null, fill: sofiDraft.fill, checks: [] };
  const unfilled = { id: 'n-1', kind: 'unfilled', note: exact.note };
  const noQty = { ...exact, id: 'd-6', checks: exact.checks.filter(c => c.field !== 'qty') };
  const assembled = { ...exact, id: 'd-7', fill: { ...exact.fill, orderId: '900004+900005' } };
  const differs = { ...exact, id: 'd-8', fill: { ...exact.fill, statementDiffers: true } };
  const all = [exact, trim, plan, dated, amend, ambiguous, unjournaled, unfilled, noQty, assembled, differs];
  eq('only the exact match is selected', bulkCandidates(all).map(d => d.id), ['d-1']);
  eq('amends, ambiguous drafts, unjournaled fills, notes without fills are never selected', [amend, ambiguous, unjournaled, unfilled].map(d => exactMatch(d).ok), [false, false, false, false]);
  eq('trim and plan quantities are approximate: left one by one', [exactMatch(trim).why, exactMatch(plan).why], ['a trim — its quantity is approximate', 'a plan — its quantity is approximate']);
  eq('the list names what will be confirmed', bulkSummary(all), '1 trade: FCX Nov 75/85C ×8 @ 2.70');
  eq('a share fill is named by side', bulkLabel({ fill: { root: 'SOFI', side: 'BUY', qty: 150, rawPrice: 20.01 } }), 'SOFI buy ×150 @ 20.01');
}

// ── THE ROUTE: AUTH, RATE LIMIT, AND THE LOG ─────────────────────────────────
const mem = new Map();
const redis = (args) => {
  const [cmd, key, ...rest] = args;
  const list = () => { if (!Array.isArray(mem.get(key))) mem.set(key, []); return mem.get(key); };
  switch (cmd) {
    case 'GET': return mem.has(key) && !Array.isArray(mem.get(key)) ? mem.get(key) : null;
    case 'SET': {
      if (rest.includes('NX') && mem.has(key)) return null;
      mem.set(key, rest[0]); return 'OK';
    }
    case 'INCR': { const n = (+mem.get(key) || 0) + 1; mem.set(key, String(n)); return n; }
    case 'EXPIRE': return 1;
    case 'RPUSH': list().push(rest[0]); return list().length;
    case 'LLEN': return Array.isArray(mem.get(key)) ? mem.get(key).length : 0;
    case 'LRANGE': return Array.isArray(mem.get(key)) ? mem.get(key).slice() : [];
    case 'LREM': { const l = list(); const i = l.indexOf(rest[1]); if (i >= 0) { l.splice(i, 1); return 1; } return 0; }
    default: throw new Error(`stand-in has no ${cmd}`);
  }
};
process.env.KV_REST_API_URL = 'https://stand-in.upstash.io';
process.env.KV_REST_API_TOKEN = 'stand-in';
process.env.JOURNAL_INBOX_TOKEN = 'jt-0123456789abcdef';
process.env.TRADECARD_KEY = 'svc-fedcba9876543210';
process.env.DASHBOARD_PASSWORD = 'session-secret-for-tests';
process.env.IBKR_FLEX_TOKEN = 'flex-token-fake';
process.env.GITHUB_TOKEN = 'unused'; process.env.GITHUB_REPO = 'x/y';
delete process.env.IBKR_FLEX_TC_QUERY_ID;
const flexXml = { body: tc(FCX) };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith(process.env.KV_REST_API_URL)) return { ok: true, status: 200, json: async () => ({ result: redis(JSON.parse(init.body)) }) };
  if (u.includes('/SendRequest')) return { ok: true, status: 200, text: async () => '<FlexStatementResponse><Status>Success</Status><ReferenceCode>123</ReferenceCode><Url>https://flex.example/GetStatement</Url></FlexStatementResponse>' };
  if (u.includes('/GetStatement')) return { ok: true, status: 200, text: async () => flexXml.body };
  throw new Error(`unexpected fetch ${u}`);
};
const { default: handler } = await import('../api/flex-sync.js');
const call = async ({ headers = {}, method = 'POST', query = { tc: '1' } } = {}) => {
  const out = { code: 0, body: null, headers: {} };
  const res = { status(c) { out.code = c; return res; }, json(b) { out.body = b; return res; }, setHeader(k, v) { out.headers[k] = v; } };
  await handler({ method, query, headers: { host: 'x', ...headers } }, res);
  return out;
};
eq('Sync now refuses an unauthenticated call', (await call()).code, 401);
eq('… and the journal token, however it is presented', [(await call({ headers: { 'x-journal-token': process.env.JOURNAL_INBOX_TOKEN } })).code,
  (await call({ headers: { 'x-tradecard-key': process.env.JOURNAL_INBOX_TOKEN } })).code], [401, 401]);
eq('… and the cron\'s service key: it is the console\'s session only', (await call({ headers: { 'x-tradecard-key': process.env.TRADECARD_KEY } })).code, 401);
const cookie = sessionCookie(await mintSession(process.env.DASHBOARD_PASSWORD)).split(';')[0];
const notSetUp = await call({ headers: { cookie } });
eq('signed in, but no TC query configured: said, not silent', [notSetUp.code, notSetUp.body.ok, notSetUp.body.setup, /IBKR_FLEX_TC_QUERY_ID/.test(notSetUp.body.line)], [200, false, true, true]);
eq('a second click inside a minute is refused with how long to wait', [(await call({ headers: { cookie } })).code], [429]);

mem.delete('dvcap:flex:tc:lock:v1');
process.env.IBKR_FLEX_TC_QUERY_ID = '999999';
mem.set(INBOX_KEY, [JSON.stringify({ ...FCX_NOTE, received_at: '2026-10-12T14:00:00Z' })]);
const synced = await call({ headers: { cookie } });
eq('signed in, configured: the fills drafted and one line back', [synced.code, synced.body.ok, synced.body.line, synced.body.journal.drafts.map(d => [d.id, d.fill.provisional])],
  [200, true, '1 fill found, 1 matched a note ✓, 0 unjournaled', [['d-900001', true]]]);
eq('nothing about the book is written by Sync now — only the drafts, seen, processed, lag and lock keys', [...mem.keys()].filter(k => /console/.test(k)), []);

// Bulk confirm through the console's route: one log entry per trade, with bulk: true.
const { default: entry } = await import('../api/manual-entry.js');
const callEntry = async (body) => {
  const out = { code: 0, body: null };
  const res = { status(c) { out.code = c; return res; }, json(b) { out.body = b; return res; }, setHeader() {}, end() { return res; } };
  await entry({ method: 'POST', query: {}, headers: { host: 'x', cookie, 'content-type': 'application/json' }, body }, res);
  return out;
};
const stored = JSON.parse(mem.get(DRAFTS_KEY));
stored.drafts.push({ id: 'm-x', kind: 'amend', state: 'DRAFT', supersedes: 'X-1', note: { id: 'x', kind: 'amend' } });
mem.set(DRAFTS_KEY, JSON.stringify(stored));
const bulk = await callEntry({ journalDraft: { action: 'confirm-many', ids: ['d-900001', 'm-x'] } })
const log = JSON.parse(mem.get(PROCESSED_KEY) || '[]').filter(e => e.bulk);
eq('bulk confirm clears the exact match, refuses the amend, and logs one entry per trade with bulk: true',
  [bulk.code, bulk.body.journal.confirmed, bulk.body.journal.refused, bulk.body.journal.drafts.map(d => d.id), log.map(e => [e.id, e.outcome, e.bulk])],
  [200, ['d-900001'], ['m-x'], ['m-x'], [['fcx-nov-75-85c', 'confirmed', true]]]);

// ── A SPLIT SURVIVES A SAVE (17 Oct) ──────────────────────────────────────────
// The store's fill whitelist dropped `transfer`, so a split's bookkeeping entries read as typed-in
// fills after the first save. Kept now, recovered from the note on older rows, and the leg row
// keeps the name of the row it came out of.
{
  const { CONSOLE_KEY } = await import('../lib/kv.js');
  const legRow = { id: 'XYZ-s-50C', symbol: 'XYZ', instrument: 'option', multiplier: 100, splitFrom: 'XYZ-s', tags: ['split'],
    legs: [{ right: 'C', strike: 50, expiry: '2026-11-20', side: 'long', ratio: 1 }],
    fills: [{ id: 't1', side: 'buy', qty: 4, price: 0.9, date: '2026-10-05', transfer: true, note: 'transfer in: split from XYZ-s on 2026-10-05' },
            { id: 't2', side: 'buy', qty: 1, price: 0.9, date: '2026-10-05', note: 'transfer in: split from XYZ-s on 2026-10-05 (saved before the flag was kept)' },
            { id: 'f1', side: 'sell', qty: 2, price: 1.2, date: '2026-10-06', note: 'typed by hand' }] };
  // The handler reads the data file from GitHub first; there is none here.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => /api\.github\.com/.test(String(url)) ? { ok: false, status: 404, json: async () => ({}), text: async () => '' } : realFetch(url, init);
  const saved = await callEntry({ console: { rows: [legRow] } });
  globalThis.fetch = realFetch;
  const back = JSON.parse(mem.get(CONSOLE_KEY)).rows[0];
  eq('a save keeps the transfer flag, recovers it from the note, and adds it nowhere else', [saved.code, back.fills.map(f => !!f.transfer)], [200, [true, true, false]]);
  eq('and the leg row keeps splitFrom', back.splitFrom, 'XYZ-s');
}

// ── A PLAN NOTE FOR A TRADE ALREADY HELD (SPY, 9 Oct) ─────────────────────────
{
  const { CONSOLE_KEY } = await import('../lib/kv.js');
  const held = applyDraft([], { id: 'd-1', kind: 'fill', source: 'unjournaled', note: null, checks: [], fill: { orderId: '800001', type: 'COMBO', root: 'XYZ', currency: 'USD',
    date: '2026-10-01', side: 'BUY', qty: 3, rawPrice: 2.10, price: 2.13, multiplier: 100, tradeIds: ['800001:1', '800001:2'],
    legs: [{ right: 'P', strike: 500, expiry: '2026-12-18', side: 'BUY', ratio: 1 }, { right: 'P', strike: 480, expiry: '2026-12-18', side: 'SELL', ratio: 1 }] } }, {}, { today: '2026-10-01' }).rows;
  const plan = validateNote({ id: 'xyz-500-480p-plan', kind: 'plan', trade_date: '2026-10-09', rationale: 'take half off at the review',
    instrument: { type: 'COMBO', symbol: 'XYZ', legs: [{ right: 'P', strike: 500, expiry: '2026-12-18', side: 'BUY', ratio: 1 }, { right: 'P', strike: 480, expiry: '2026-12-18', side: 'SELL', ratio: 1 }] },
    levels: { review: '2026-10-30', hard_date: '2026-12-11' }, rules: ['take half off'] }).note;
  const zeroDte = opt({ u: 'XYZ', conid: 9401, k: 510, exp: '20261009', r: 'P', side: 'BUY', q: 1, px: 1.1, oid: 800009 }).replace(/20261012/g, '20261009');
  const r = processInbox({ notes: [plan], trades: parseTradeConfirms(tc([zeroDte])), today: '2026-10-09', rows: held });
  const w = r.why[plan.id];
  eq('a plan for a spread already held says so and names the trade', [w.held?.map(h => h.id), /you already hold this/.test(w.reason)], [[held[0].id], true]);
  eq('… and a same-day option is never offered as its nearest order', /800009/.test(w.reason), false);
  eq('a close note for a held trade is not flagged (closing it is the point)', processInbox({ notes: [{ ...plan, id: 'xyz-close', kind: 'close' }], trades: [], today: '2026-10-09', rows: held }).why['xyz-close'].held, undefined);

  mem.set(CONSOLE_KEY, JSON.stringify({ rows: held }));
  mem.set(INBOX_KEY, [JSON.stringify({ ...plan, received_at: '2026-10-09T15:00:00Z' })]);
  const wrong = await callEntry({ journalDraft: { action: 'note-to-amend', id: plan.id, rowId: 'NOT-A-ROW' } });
  eq('treating it as a rule change on a trade it does not describe is refused, nothing changed', [wrong.code, mem.get(INBOX_KEY).length], [409, 1]);
  const ok = await callEntry({ journalDraft: { action: 'note-to-amend', id: plan.id, rowId: held[0].id } });
  const amend = ok.body.journal?.drafts?.find(d => d.id === `m-${plan.id}`);
  eq('treated as a rule change: the note leaves the inbox and becomes an amend draft on that trade',
    [ok.code, amend?.kind, amend?.supersedes, ok.body.journal.pending, JSON.parse(mem.get(PROCESSED_KEY)).some(e => e.id === plan.id && e.outcome === 'converted-to-amend')],
    [200, 'amend', held[0].id, 0, true]);
}

// ── THE LAG ──────────────────────────────────────────────────────────────────
{
  eq('Flex times are New York time', new Date(nyEpochMs('20261012;101200')).toISOString(), '2026-10-12T14:12:00.000Z');
  const t = parseTradeConfirms(tc([FCX[0]]));
  const first = recordLag({}, { trades: [], at: '2026-10-12T14:14:00Z' });
  const second = recordLag(first.store, { trades: t, at: '2026-10-12T14:19:00Z' });
  eq('the lag is bounded by the sync that missed it and the one that saw it', [second.lags[0].overMin, second.lags[0].upToMin, lagText(second.lags[0])], [2, 7, 'IBKR\'s report showed it 2–7 min after the fill']);
  eq('an order is measured once', recordLag(second.store, { trades: t, at: '2026-10-12T14:25:00Z' }).lags.length, 0);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
