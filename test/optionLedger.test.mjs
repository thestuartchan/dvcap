// test/optionLedger.test.mjs — every way an option card can drift from IBKR, read from IBKR's own
// record (lib/optionLedger.js). Statement-shaped rows (<Order>, <OptionEAE>) through the real
// parsers. Fake tickers, made-up figures.
import { optionPlans, positionsByContract, planLine, planFix, autoApplies, applyPlans, ledgerWindow } from '../lib/optionLedger.js';
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
  eq('one leg closed on its own: said, not guessed', run([pcs], { orders: rolled, held: [[48, 'P', 3]] }).map(brief), ['its legs changed by different amounts at IBKR (a leg closed or rolled on its own)']);
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

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
