// test/optionLedger.test.mjs — every way an option card can drift from IBKR, read from IBKR's own
// record (lib/optionLedger.js). Statement-shaped rows (<Order>, <OptionEAE>) through the real
// parsers. Fake tickers, made-up figures.
import { optionPlans, positionsByContract, costsByContract, planLine, planFix, autoApplies, applyPlans, ledgerWindow, sameTradeCards, sameTradeLine, rolledContracts, coveredBy, entrylessCards, entrylessLine } from '../lib/optionLedger.js';
import { parseTrades } from '../lib/flexTrades.js';
import { orderUnits } from '../lib/journalInbox.js';
import { parseOptionEae } from '../lib/optionExpiry.js';
import { optionContractOf, parseStatement, reconcile, classOf } from '../lib/flex.js';
import { derivePosition } from '../lib/positions.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const EXP = '20261030', EXPI = '2026-10-30';
const ord = (o) => `<Order accountId="U0000000" currency="USD" assetCategory="OPT" symbol="${o.root || 'ZZZ'} ${o.k}${o.pc}" conid="${o.root || 'ZZZ'}${o.k}${o.pc}" underlyingSymbol="${o.root || 'ZZZ'}" multiplier="100" strike="${o.k}" expiry="${o.exp || EXP}" putCall="${o.pc}" tradeDate="${o.d}" dateTime="${o.d};${o.t || '150000'}" buySell="${o.side}" quantity="${o.side === 'SELL' ? -o.q : o.q}" tradePrice="${o.px}" ibCommission="0" ibOrderID="${o.oid}" levelOfDetail="ORDER" transactionType="ExchTrade" />`;
const eaeRow = (e) => `<OptionEAE symbol="${e.root || 'ZZZ'} x" underlyingSymbol="${e.root || 'ZZZ'}" putCall="${e.pc}" strike="${e.k}" expiry="${EXP}" date="${e.d || EXP}" transactionType="${e.type}"${e.q != null ? ` quantity="${e.q}"` : ''} />`;
const stmt = (orders = [], eaes = []) => `<FlexQueryResponse><FlexStatements count="1"><FlexStatement accountId="U0000000" fromDate="20261019" toDate="20261030"><Trades>${orders.join('')}</Trades><OptionEAE>${eaes.join('')}</OptionEAE></FlexStatement></FlexStatements></FlexQueryResponse>`;
const pos = (lines) => positionsByContract(lines.map(([k, pc, qty, root]) => ({ root: root || 'ZZZ', strike: k, putCall: pc, expiry: EXP, qty })), optionContractOf);
const leg = (right, strike, side = 'long') => ({ right, strike, expiry: EXPI, side, ratio: 1 });
const card = (id, side, legs, fills, root = 'ZZZ') => ({ id, instrument: legs.length > 1 ? 'spread' : 'option', symbol: root, underlying: root, side, legs, multiplier: 100, fills });
const run = (rows, { orders = [], eaes = [], held = [], asOf = EXPI, ...o } = {}) => {
  const x = stmt(orders, eaes);
  return optionPlans(rows, { positions: pos(held), units: orderUnits(parseTrades(x)), eae: parseOptionEae(x), asOf, ...o });
};
const brief = (p) => p.state === 'plan' ? p.fills.map(f => `${f.kind}:${f.side} ${f.qty}@${f.price} ${f.date}`) : p.why;

// ── 1. THE MSFT CASE: two single-leg cards, entries typed by hand, each sold on its own ──
{
  const put = card('p', 'long', [leg('P', 520)], [{ id: 'f1', side: 'buy', qty: 1, price: 9.21, date: '2026-10-27' }]);
  const call = card('c', 'long', [leg('C', 545)], [{ id: 'g1', side: 'buy', qty: 1, price: 6.66, date: '2026-10-27' }]);
  const orders = [
    ord({ k: 520, pc: 'P', side: 'BUY', q: 1, px: 9.21, d: '20261027', oid: 100 }), ord({ k: 545, pc: 'C', side: 'BUY', q: 1, px: 6.66, d: '20261027', oid: 101 }),
    ord({ k: 520, pc: 'P', side: 'SELL', q: 1, px: 1.45, d: '20261029', oid: 200 }), ord({ k: 545, pc: 'C', side: 'SELL', q: 1, px: 0.39, d: '20261029', oid: 201 }),
  ];
  const out = run([put, call], { orders });
  eq('each card: its own exit, not the entry typed by hand', out.map(brief), [['trade:sell 1@1.45 2026-10-29'], ['trade:sell 1@0.39 2026-10-29']]);
  eq('the hand-typed entry is recognised and given IBKR\'s order id', out.map(p => p.adopt), [[{ fillId: 'f1', tradeId: '100' }], [{ fillId: 'g1', tradeId: '101' }]]);
  eq('the banner says what IBKR did, rounded to the cent', planLine(out[0]), '2026-10-30 P 520: at IBKR, sold 1 at 1.45 on 2026-10-29 — not yet on the card');
  eq('nothing is written without asking', out.map(autoApplies), [false, false]);
}

// ── 2. A STRANGLE ON ONE CARD, BOUGHT AS A COMBO, SOLD LEG BY LEG ──
{
  const s = card('s', 'long', [leg('P', 520), leg('C', 545)], [{ id: 'f1', side: 'buy', qty: 2, price: 8.5, date: '2026-10-26' }]);
  const orders = [
    ord({ k: 520, pc: 'P', side: 'BUY', q: 2, px: 4.0, d: '20261026', oid: 300 }), ord({ k: 545, pc: 'C', side: 'BUY', q: 2, px: 4.5, d: '20261026', oid: 300 }),
    ord({ k: 545, pc: 'C', side: 'SELL', q: 2, px: 6.0, d: '20261029', t: '143000', oid: 301 }), ord({ k: 520, pc: 'P', side: 'SELL', q: 2, px: 1.5, d: '20261029', t: '143100', oid: 302 }),
  ];
  const [p] = run([s], { orders });
  eq('one exit for the card, at the legs\' combined price', brief(p), ['trade:sell 2@7.5 2026-10-29']);
  eq('…carrying both orders', p.fills[0].orders, ['301', '302']);
  eq('the combo entry is adopted once', p.adopt, [{ fillId: 'f1', tradeId: '300' }]);
}

// ── 3. PARTIAL CLOSE, ADD, AND A ROUND TRIP INSIDE THE WINDOW ──
{
  const c3 = card('c3', 'long', [leg('C', 100)], [{ id: 'a', side: 'buy', qty: 3, price: 2, date: '2026-10-20', tradeId: '400' }]);
  eq('sold 1 of 3: a partial close', run([c3], { orders: [ord({ k: 100, pc: 'C', side: 'SELL', q: 1, px: 3.1, d: '20261023', oid: 401 })], held: [[100, 'C', 2]] }).map(brief), [['trade:sell 1@3.1 2026-10-23']]);
  eq('a sell on a long card is a reduce', planFix(run([c3], { orders: [ord({ k: 100, pc: 'C', side: 'SELL', q: 1, px: 3.1, d: '20261023', oid: 401 })], held: [[100, 'C', 2]] })[0]).side, 'reduce');
  eq('bought 1 more: an add', run([c3], { orders: [ord({ k: 100, pc: 'C', side: 'BUY', q: 1, px: 2.4, d: '20261022', oid: 402 })], held: [[100, 'C', 4]] }).map(brief), [['trade:buy 1@2.4 2026-10-22']]);
  eq('sold 2, bought 1 back: both, in order', run([c3], { orders: [ord({ k: 100, pc: 'C', side: 'SELL', q: 2, px: 3, d: '20261022', oid: 403 }), ord({ k: 100, pc: 'C', side: 'BUY', q: 1, px: 2.5, d: '20261023', oid: 404 })], held: [[100, 'C', 2]] }).map(brief),
    [['trade:sell 2@3 2026-10-22', 'trade:buy 1@2.5 2026-10-23']]);
  eq('agrees with IBKR: nothing to say', run([c3], { held: [[100, 'C', 3]] }), []);
  eq('the entry, recorded with its id, is not read again', run([c3], { orders: [ord({ k: 100, pc: 'C', side: 'BUY', q: 3, px: 2, d: '20261020', oid: 400 }), ord({ k: 100, pc: 'C', side: 'SELL', q: 3, px: 4, d: '20261028', oid: 405 })] }).map(brief), [['trade:sell 3@4 2026-10-28']]);
}

// ── 4. EXPIRY, EXERCISE, ASSIGNMENT ──
{
  const lp = card('lp', 'long', [leg('P', 90)], [{ id: 'a', side: 'buy', qty: 2, price: 1, date: '2026-10-20', tradeId: '500' }]);
  const exp = run([lp], { eaes: [eaeRow({ k: 90, pc: 'P', type: 'Expiration', q: -2 })] });
  eq('expired worthless: closed at 0 on the day IBKR booked it', exp.map(brief), [['expiration:sell 2@0 2026-10-30']]);
  eq('…and that alone is written without asking', autoApplies(exp[0]), true);
  const applied = applyPlans([lp], exp);
  eq('applied once', applied[0].fills.length, 2);
  eq('…and never twice', applyPlans(applied, exp)[0].fills.length, 2);
  eq('an expiration with no quantity is sized from what was held', run([lp], { eaes: [eaeRow({ k: 90, pc: 'P', type: 'Expiration' })] }).map(brief), [['expiration:sell 2@0 2026-10-30']]);

  const sp = card('sp', 'short', [leg('P', 80)], [{ id: 'a', side: 'sell', qty: 1, price: 1.2, date: '2026-10-20', tradeId: '501' }]);
  const asg = run([sp], { eaes: [eaeRow({ k: 80, pc: 'P', type: 'Assignment', q: 1 })] });
  eq('a short put assigned: bought back at 0, the shares come as their own trade', asg.map(brief), [['assignment:buy 1@0 2026-10-30']]);
  eq('…offered, not written', autoApplies(asg[0]), false);
  eq('a buy on a short card is a reduce, not an add', planFix(asg[0]).side, 'reduce');
  eq('…and the banner says the shares are coming', /assigned on 2026-10-30 — the shares arrive as their own trade/.test(planLine(asg[0])), true);

  const vert = card('v', 'long', [leg('C', 100), leg('C', 110, 'short')], [{ id: 'a', side: 'buy', qty: 4, price: 1.5, date: '2026-10-20', tradeId: '503' }]);
  eq('a spread with every leg expired: closed at 0', run([vert], { eaes: [eaeRow({ k: 100, pc: 'C', type: 'Expiration', q: -4 }), eaeRow({ k: 110, pc: 'C', type: 'Expiration', q: 4 })] }).map(brief), [['expiration:sell 4@0 2026-10-30']]);
  eq('a spread with one leg silent: not closed, said', run([vert], { eaes: [eaeRow({ k: 100, pc: 'C', type: 'Expiration', q: -4 })] }).map(p => p.state), ['unexplained']);
  const lc = card('lc', 'long', [leg('C', 50)], [{ id: 'a', side: 'buy', qty: 1, price: 3, date: '2026-10-20', tradeId: '502' }]);
  eq('a long call exercised', run([lc], { eaes: [eaeRow({ k: 50, pc: 'C', type: 'Exercise', q: -1 })] }).map(brief), [['exercise:sell 1@0 2026-10-30']]);
}

// ── 5. SPREADS ──
{
  const pcs = card('pcs', 'short', [leg('P', 55, 'long'), leg('P', 48, 'short')], [{ id: 'a', side: 'sell', qty: 3, price: 1.5, date: '2026-10-20', tradeId: '600' }]);
  const back = [ord({ k: 55, pc: 'P', side: 'BUY', q: 3, px: 0.8, d: '20261028', oid: 601 }), ord({ k: 48, pc: 'P', side: 'SELL', q: 3, px: 0.2, d: '20261028', oid: 601 })];
  eq('a credit spread bought back as a combo: a buy of the card at the net debit', run([pcs], { orders: back }).map(brief), [['trade:buy 3@0.6 2026-10-28']]);
  const rolled = [ord({ k: 55, pc: 'P', side: 'BUY', q: 3, px: 0.8, d: '20261028', oid: 602 })];
  eq('one leg closed on its own, no price for every leg on one day: said, not guessed', run([pcs], { orders: rolled, held: [[48, 'P', 3]] }).map(brief), ['its legs were traded on their own at IBKR, and no order priced every leg on one day to divide its cost — split it by hand']);
  const both = [
    ord({ k: 55, pc: 'P', side: 'BUY', q: 3, px: 0.8, d: '20261024', oid: 603 }), ord({ k: 48, pc: 'P', side: 'SELL', q: 3, px: 0.2, d: '20261024', oid: 603 }),
    ord({ k: 55, pc: 'P', side: 'SELL', q: 1, px: 1.0, d: '20261026', oid: 604 }), ord({ k: 48, pc: 'P', side: 'BUY', q: 1, px: 0.3, d: '20261026', oid: 604 }),
  ];
  eq('closed as a combo, then one re-opened as a combo: one fill per order', run([pcs], { orders: both, held: [[55, 'P', -1], [48, 'P', 1]] }).map(brief), [['trade:buy 3@0.6 2026-10-24', 'trade:sell 1@0.7 2026-10-26']]);
}

// ── 6. WHAT IT LEAVES TO A PERSON ──
{
  const a = card('a', 'long', [leg('C', 100)], [{ id: 'x', side: 'buy', qty: 1, price: 2, date: '2026-10-20', tradeId: '700' }]);
  const b = card('b', 'long', [leg('C', 100)], [{ id: 'y', side: 'buy', qty: 1, price: 2.1, date: '2026-10-21', tradeId: '701' }]);
  eq('a contract on two cards, IBKR agrees with their sum: nothing', run([a, b], { held: [[100, 'C', 2]] }), []);
  eq('a contract on two cards, IBKR differs: named, not guessed', run([a, b], { held: [[100, 'C', 1]] }).map(brief), ['the same contract is on another open card, so IBKR cannot say which card moved', 'the same contract is on another open card, so IBKR cannot say which card moved']);
  eq('IBKR differs and nothing it did explains it', run([a], { held: [] }).map(p => p.state), ['unexplained']);
  eq('…and the banner sends the reader to IBKR', /could not be explained .* record it by hand/.test(planLine(run([a], { held: [] })[0])), true);
  const gone = card('g', 'long', [leg('P', 90)], [{ id: 'x', side: 'buy', qty: 1, price: 1, date: '2026-10-20', tradeId: '702' }]);
  eq('expired with no EAE section in the query: says which section to add', /add that section to the saved query/.test(run([gone], { eaePresent: false })[0].why), true);
  eq('a card another check already named is skipped', run([a], { held: [], skip: new Set(['a']) }), []);
  eq('only the cards the reconciliation flagged', run([a], { held: [], flagged: new Set(['zzz']) }), []);
}

// ── 7. THE STATEMENT'S DAY ──
{
  // Sold today, recorded today from the same-day report; the statement is yesterday's and still holds it.
  const t = card('t', 'long', [leg('C', 100)], [{ id: 'x', side: 'buy', qty: 1, price: 2, date: '2026-10-20', tradeId: '800' }, { id: 'y', side: 'sell', qty: 1, price: 3, date: '2026-10-31', tradeId: '801' }]);
  eq('a fill after the statement\'s day does not count against it', run([t], { held: [[100, 'C', 1]], asOf: '2026-10-30' }), []);
}

// ── 8. RECORD IT ──
{
  const two = { rowId: 'x', state: 'plan', fills: [
    { id: 'ox-1', side: 'sell', qty: 2, price: 1.452896924, date: '2026-10-22', tradeId: '1', kind: 'trade', note: 'n' },
    { id: 'ox-2', side: 'buy', qty: 1, price: 2.5, date: '2026-10-23', tradeId: '2', kind: 'trade', note: 'n' }], adopt: [{ fillId: 'f1', tradeId: '9' }] };
  const fx = planFix(two);
  eq('several fills: recorded together, with the ids to stamp', [fx.fills.length, fx.adopt.length, fx.text], [2, 1, 'record all 2, from the statement']);
  eq('one fill: its own words, rounded to the cent', planFix({ ...two, fills: [two.fills[0]] }).text, 'record it: sold 2 at 1.45 on 2026-10-22, from the statement');
}

// ── 9. HOW FAR BACK TO READ ──
{
  const w = card('w', 'long', [leg('C', 100)], [{ id: 'x', side: 'buy', qty: 1, price: 2, date: '2026-10-20' }]);
  eq('a flagged card: read back to its last fill', ledgerWindow([w], new Set(['w']), { statementFrom: '2026-10-30', asOf: '2026-10-30' }), { from: '2026-10-20', to: '2026-10-30' });
  eq('the day\'s statement already reaches it: no second read', ledgerWindow([w], new Set(['w']), { statementFrom: '2026-10-19', asOf: '2026-10-30' }), null);
  eq('nothing flagged: no second read', ledgerWindow([w], new Set(), { statementFrom: '2026-10-30', asOf: '2026-10-30' }), null);
  const old = { ...w, fills: [{ ...w.fills[0], date: '2026-01-02' }] };
  eq('never more than IBKR\'s 92 days', ledgerWindow([old], new Set(['w']), { statementFrom: '2026-10-30', asOf: '2026-10-30' }), { from: '2026-07-30', to: '2026-10-30' });
}

// ── 10. END TO END: the reconciliation flags the card, the ledger explains it ──
{
  const op = (k, pc, q) => `<OpenPosition symbol="ZZZ   261030${pc}00${k}000" underlyingSymbol="ZZZ" assetCategory="OPT" currency="USD" multiplier="100" position="${q}" costBasisPrice="1" strike="${k}" expiry="${EXP}" putCall="${pc}" />`;
  const x = `<FlexQueryResponse><FlexStatements count="1"><FlexStatement accountId="U0000000" fromDate="20261019" toDate="20261030">
    <OpenPositions>${op(100, 'C', 2)}</OpenPositions>
    <Trades>${ord({ k: 100, pc: 'C', side: 'BUY', q: 3, px: 2, d: '20261020', oid: 900 })}${ord({ k: 100, pc: 'C', side: 'SELL', q: 1, px: 3.1, d: '20261023', oid: 901 })}${ord({ k: 520, pc: 'P', side: 'SELL', q: 1, px: 1.45, d: '20261029', oid: 902 })}</Trades>
    <OptionEAE></OptionEAE></FlexStatement></FlexStatements></FlexQueryResponse>`;
  const rows = [
    card('part', 'long', [leg('C', 100)], [{ id: 'h', side: 'buy', qty: 3, price: 2, date: '2026-10-20' }]),
    card('gone', 'long', [leg('P', 520)], [{ id: 'k', side: 'buy', qty: 1, price: 9, date: '2026-10-27' }]),
  ].map(r => ({ ...r, derived: derivePosition(r.fills, { multiplier: 100, side: r.side }) }));
  const st = parseStatement(x);
  const rec = reconcile(rows, st.positions, { asOf: EXPI, derive: (r) => derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side }) });
  const flagged = new Set(rec.report.filter(r => r.kind === 'option-differs' || r.kind === 'option-missing-at-broker').flatMap(r => r.ids || []));
  eq('the reconciliation flags both cards', [...flagged].sort(), ['gone', 'part']);
  const plans = optionPlans(rows, { positions: positionsByContract(st.positions.filter(p => classOf(p) === 'option'), optionContractOf), units: orderUnits(parseTrades(x)), eae: parseOptionEae(x), asOf: EXPI, flagged });
  eq('…and the ledger explains each: a partial close, and an exit', plans.map(p => [p.rowId, brief(p)]), [['part', ['trade:sell 1@3.1 2026-10-23']], ['gone', ['trade:sell 1@1.45 2026-10-29']]]);
  eq('…the hand-typed entry of the first adopted by its order', plans[0].adopt, [{ fillId: 'h', tradeId: '900' }]);
}

// ── 11. ONE TRADE ON SEVERAL CARDS ──
{
  const strangle = card('s', 'long', [leg('P', 520), leg('C', 545)], [{ id: 'a', side: 'buy', qty: 1, price: 15.87, date: '2026-10-27' }, { id: 'b', side: 'sell', qty: 1, price: 1.85, date: '2026-10-29' }]);
  const p = card('p', 'long', [leg('P', 520)], [{ id: 'a', side: 'buy', qty: 1, price: 9.21, date: '2026-10-27' }, { id: 'b', side: 'sell', qty: 1, price: 1.45, date: '2026-10-29' }]);
  const c = card('c', 'long', [leg('C', 545)], [{ id: 'a', side: 'buy', qty: 1, price: 6.66, date: '2026-10-27' }, { id: 'b', side: 'sell', qty: 1, price: 0.39, date: '2026-10-29' }]);
  const g = sameTradeCards([strangle, p, c], { asOf: '2026-11-02' });
  eq('the strangle and its two legs on their own cards: one trade on three cards', g.map(x => x.cards.map(k => k.id)), [['s', 'p', 'c']]);
  eq('…said, with the cards named', /one trade on 3 cards — 520P\/545C \(closed\), 520P \(closed\), 545C \(closed\)/.test(sameTradeLine(g[0])), true);
  // A proper leg-out: the parent hands its units to the legs on the 28th, at cost.
  const parent = card('s', 'long', [leg('P', 520), leg('C', 545)], [{ id: 'a', side: 'buy', qty: 1, price: 15.87, date: '2026-10-27' }, { id: 't', side: 'sell', qty: 1, price: 15.87, date: '2026-10-28', transfer: true }]);
  const legP = card('p', 'long', [leg('P', 520)], [{ id: 't', side: 'buy', qty: 1, price: 9.21, date: '2026-10-28', transfer: true }, { id: 'b', side: 'sell', qty: 1, price: 1.45, date: '2026-10-29' }], 'ZZZ');
  const legC = card('c', 'long', [leg('C', 545)], [{ id: 't', side: 'buy', qty: 1, price: 6.66, date: '2026-10-28', transfer: true }, { id: 'b', side: 'sell', qty: 1, price: 0.39, date: '2026-10-29' }], 'ZZZ');
  eq('a leg-out split (linked to its parent) is one trade, not a duplicate', sameTradeCards([parent, { ...legP, splitFrom: 's' }, { ...legC, splitFrom: 's' }], { asOf: '2026-11-02' }), []);
  eq('linked, but the parent still held after the split and was sold again: a double count', sameTradeCards([strangle, { ...p, splitFrom: 's' }, { ...c, splitFrom: 's' }], { asOf: '2026-11-02' }).map(x => x.cards.length), [3]);
  const later = card('n', 'long', [leg('P', 520)], [{ id: 'a', side: 'buy', qty: 1, price: 2, date: '2026-10-29' }]);
  eq('the same contract bought again after the first card closed: two trades', sameTradeCards([p, later], { asOf: '2026-11-02' }), []);
  eq('marked as separate trades by hand: left alone', sameTradeCards([{ ...strangle, notSameTradeAs: ['p', 'c'] }, p, c], { asOf: '2026-11-02' }), []);
  const old = { ...p, fills: p.fills.map(f => ({ ...f, date: f.date.replace('2026-10', '2026-07') })) };
  const oldC = { ...c, fills: c.fills.map(f => ({ ...f, date: f.date.replace('2026-10', '2026-07') })) };
  eq('closed long ago: not raised again', sameTradeCards([old, { ...oldC, legs: old.legs }], { asOf: '2026-11-02' }), []);
}

// ── 12. LEG-OUTS: the card splits into one card per leg ──
{
  // A strangle bought as one combo; the put sold on its own on the 29th, the call still held.
  const s2 = card('str', 'long', [leg('P', 520), leg('C', 545)], [{ id: 'f1', side: 'buy', qty: 2, price: 8.5, date: '2026-10-26', tradeId: '300' }]);
  const orders = [
    ord({ k: 520, pc: 'P', side: 'BUY', q: 2, px: 4.0, d: '20261026', oid: 300 }), ord({ k: 545, pc: 'C', side: 'BUY', q: 2, px: 4.5, d: '20261026', oid: 300 }),
    ord({ k: 520, pc: 'P', side: 'SELL', q: 2, px: 1.5, d: '20261029', oid: 310 }),
  ];
  const [p] = run([s2], { orders, held: [[545, 'C', 2]] });
  eq('one leg sold on its own: a split, not "unexplained"', [p.state, p.kind, p.newRows.map(n => n.id)], ['plan', 'split', ['str-520P', 'str-545C']]);
  eq('the card hands its 2 units over at its average cost, no P&L', [p.fills[0].transfer, p.fills[0].side, p.fills[0].qty, p.fills[0].price, p.fills[0].date], [true, 'sell', 2, 8.5, '2026-10-29']);
  eq('the cost is divided by the entry order\'s leg prices (4.00 / 4.50 of 8.50)', p.newRows.map(n => n.fills[0].price), [4, 4.5]);
  eq('the put card records its sale; the call card just holds', p.newRows.map(n => n.fills.filter(f => !f.transfer).map(f => `${f.side} ${f.qty}@${f.price}`)), [['sell 2@1.5'], []]);
  eq('each leg card names the card it came from (one trade on the closed card)', p.newRows.map(n => [n.splitFrom, n.tags.includes('split'), /^transfer in: split from str on 2026-10-29/.test(n.fills[0].note)]), [['str', true, true], ['str', true, true]]);
  eq('the banner says what happened', planLine(p), '2026-10-30 P 520 / 2026-10-30 C 545: legged out at IBKR — 520P sold 2 at 1.50 on 2026-10-29; 545C still held — splits into one card per leg, cost divided by IBKR order 300 on 2026-10-26');
  eq('…offered, never written by itself', [autoApplies(p), planFix(p).newRows.length], [false, 2]);
  // No order priced both legs (entry outside the window): IBKR's own cost basis per leg.
  const x = stmt([ord({ k: 520, pc: 'P', side: 'SELL', q: 2, px: 1.5, d: '20261029', oid: 310 })]);
  const costs = costsByContract([{ root: 'ZZZ', strike: 520, putCall: 'P', expiry: EXP, costBasisPrice: 3.9 }, { root: 'ZZZ', strike: 545, putCall: 'C', expiry: EXP, costBasisPrice: 4.6 }], optionContractOf);
  const [q] = optionPlans([s2], { positions: pos([[545, 'C', 2]]), costs, units: orderUnits(parseTrades(x)), eae: [], asOf: EXPI });
  eq('…or by IBKR\'s cost basis per leg', [q.kind, q.refFrom, q.newRows.map(n => n.fills[0].price)], ['split', 'IBKR\'s cost basis per leg', [3.9, 4.6]]);
  // A credit spread: one leg bought back on its own.
  const pcs2 = card('pcs2', 'short', [leg('P', 55, 'long'), leg('P', 48, 'short')], [{ id: 'a', side: 'sell', qty: 3, price: 1.5, date: '2026-10-20', tradeId: '600' }]);
  const o2 = [ord({ k: 55, pc: 'P', side: 'SELL', q: 3, px: 2.2, d: '20261020', oid: 600 }), ord({ k: 48, pc: 'P', side: 'BUY', q: 3, px: 0.7, d: '20261020', oid: 600 }),
    ord({ k: 55, pc: 'P', side: 'BUY', q: 3, px: 0.8, d: '20261028', oid: 611 })];
  const [c2] = run([pcs2], { orders: o2, held: [[48, 'P', 3]] });
  eq('a credit spread legged out: the short leg bought back, the long leg kept', c2.newRows.map(n => [n.side, n.fills.map(f => `${f.side} ${f.qty}@${f.price}`)]), [['short', ['sell 3@2.2', 'buy 3@0.8']], ['long', ['buy 3@0.7']]]);
}

// ── 13. ROLLS: the card closes and the new contract carries its P&L ──
{
  const lc = card('lc', 'long', [leg('C', 100)], [{ id: 'a', side: 'buy', qty: 2, price: 3, date: '2026-10-20', tradeId: '700' }]);
  const rollOrder = [ord({ k: 100, pc: 'C', side: 'SELL', q: 2, px: 5, d: '20261027', oid: 710 }), ord({ k: 110, pc: 'C', side: 'BUY', q: 2, px: 2.2, d: '20261027', oid: 710, exp: '20261120' })];
  const x = stmt(rollOrder);
  const posR = positionsByContract([{ root: 'ZZZ', strike: 110, putCall: 'C', expiry: '20261120', qty: 2 }], optionContractOf);
  const [p] = optionPlans([lc], { positions: posR, units: orderUnits(parseTrades(x)), eae: [], asOf: EXPI });
  eq('rolled up and out in one order: the card closes at the order\'s price', brief(p), ['trade:sell 2@5 2026-10-27']);
  eq('…and a new card for the new contract names it', p.newRows.map(n => [n.rolledFrom, n.side, n.legs.map(l => `${l.strike}${l.right} ${l.expiry}`), n.fills.map(f => `${f.side} ${f.qty}@${f.price}`)]),
    [['lc', 'long', ['110C 2026-11-20'], ['buy 2@2.2']]]);
  eq('the banner says it rolled', /rolled into 110C \(a new card, P&L carried\)/.test(planLine(p)), true);
  eq('the statement does not add the new contract a second time', rolledContracts([p]).size === 1 && coveredBy(rolledContracts([p]))(card('z', 'long', [{ right: 'C', strike: 110, expiry: '2026-11-20', side: 'long', ratio: 1 }], [])), true);
  // The new contract already on a card the statement added: linked, not made twice.
  const added = card('ZZZ-flex-opt-110', 'long', [{ right: 'C', strike: 110, expiry: '2026-11-20', side: 'long', ratio: 1 }], [{ id: 'f0', side: 'buy', qty: 2, price: 2.2, date: '2026-10-27' }]);
  const [q] = optionPlans([lc, added], { positions: posR, units: orderUnits(parseTrades(x)), eae: [], asOf: EXPI });
  eq('already on a card: that card is linked', [q.link, (q.newRows || []).length], [{ rowId: 'ZZZ-flex-opt-110', rolledFrom: 'lc' }, 0]);
  // Closed with one order, the new contract opened by another the same day.
  const sep = stmt([ord({ k: 100, pc: 'C', side: 'SELL', q: 2, px: 5, d: '20261027', oid: 720 }), ord({ k: 110, pc: 'C', side: 'BUY', q: 2, px: 2.2, d: '20261027', oid: 721, exp: '20261120' })]);
  const [r2] = optionPlans([lc], { positions: posR, units: orderUnits(parseTrades(sep)), eae: [], asOf: EXPI });
  eq('the same shape opened the same day by its own order: a roll as well', r2.newRows.map(n => n.rolledFrom), ['lc']);
  // A plain close with nothing opened: no roll.
  eq('closed and nothing opened: no roll', optionPlans([lc], { positions: new Map(), units: orderUnits(parseTrades(stmt([ord({ k: 100, pc: 'C', side: 'SELL', q: 2, px: 5, d: '20261027', oid: 730 })]))), eae: [], asOf: EXPI })[0].roll, undefined);
  // A put credit spread rolled down as one 4-leg order: a new short card at the new credit.
  const pcs3 = card('pcs3', 'short', [leg('P', 55, 'long'), leg('P', 48, 'short')], [{ id: 'a', side: 'sell', qty: 1, price: 1.5, date: '2026-10-20', tradeId: '800' }]);
  const r4 = stmt([ord({ k: 55, pc: 'P', side: 'BUY', q: 1, px: 3.0, d: '20261027', oid: 810 }), ord({ k: 48, pc: 'P', side: 'SELL', q: 1, px: 1.0, d: '20261027', oid: 810 }),
    ord({ k: 50, pc: 'P', side: 'SELL', q: 1, px: 2.0, d: '20261027', oid: 810, exp: '20261120' }), ord({ k: 43, pc: 'P', side: 'BUY', q: 1, px: 0.6, d: '20261027', oid: 810, exp: '20261120' })]);
  const posS = positionsByContract([{ root: 'ZZZ', strike: 50, putCall: 'P', expiry: '20261120', qty: -1 }, { root: 'ZZZ', strike: 43, putCall: 'P', expiry: '20261120', qty: 1 }], optionContractOf);
  const [s4] = optionPlans([pcs3], { positions: posS, units: orderUnits(parseTrades(r4)), eae: [], asOf: EXPI });
  eq('a credit spread rolled as one order: closed at the debit, a new short card at the new credit', [brief(s4), s4.newRows.map(n => [n.side, n.legs.map(l => `${l.strike}${l.right}:${l.side}`), n.fills[0].side, n.fills[0].price])],
    [['trade:buy 1@2 2026-10-27'], [['short', ['50P:long', '43P:short'], 'sell', 1.4]]]);
}

// ── 14. WHAT THE STORE KEEPS ──
{
  const lc = card('lc', 'long', [leg('C', 100)], [{ id: 'a', side: 'buy', qty: 2, price: 3, date: '2026-10-20', tradeId: '700' }]);
  const big = stmt([ord({ k: 100, pc: 'C', side: 'SELL', q: 1, px: 5, d: '20261027', oid: 123456789012 }), ord({ k: 100, pc: 'C', side: 'SELL', q: 1, px: 5.1, d: '20261028', oid: 123456789013 })]);
  const [p] = optionPlans([lc], { positions: new Map(), units: orderUnits(parseTrades(big)), eae: [], asOf: EXPI });
  eq('every fill id fits the store\'s 16 characters, and two fills keep two ids', [p.fills.every(f => f.id.length <= 16), new Set(p.fills.map(f => f.id)).size], [true, 2]);
  const lost = card('g', 'long', [leg('P', 295), leg('P', 300, 'short')], [{ id: 'x', side: 'sell', qty: 1, price: 0, date: '2026-10-30' }]);
  eq('a card left with an exit and no entry: named', entrylessCards([lost, lc]).map(c => c.id), ['g']);
  eq('…and said plainly', /\+295P −300P: this card has no entry/.test(entrylessLine(entrylessCards([lost])[0])), true);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
