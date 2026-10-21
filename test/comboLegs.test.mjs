// A combo IBKR reported leg by leg (lib/journalInbox.js assembleCombos). On 21 Oct a call spread and
// a straddle, each bought as one combo, reached the same-day report as one order per leg, and the
// inbox offered four unrelated legs. Made-up tickers and order ids throughout.
import { parseTradeConfirms } from '../lib/flexTrades.js';
import { processInbox, applyDraft, assembleCombos, COMBO_LEG_MIN } from '../lib/journalInbox.js';
import { syncNowLine } from '../lib/sameDayFills.js';
import { legsOf } from '../lib/instruments.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

const tc = (rows) => `<FlexQueryResponse queryName="same-day" type="TCF"><FlexStatements count="1"><FlexStatement accountId="U0000000" fromDate="20261012" toDate="20261012" period="Today"><TradeConfirms>${rows.join('')}</TradeConfirms></FlexStatement></FlexStatements></FlexQueryResponse>`;
const opt = (o) => `<TradeConfirm accountId="U0000000" currency="USD" assetCategory="OPT" symbol="${o.u} x" conid="${o.conid}" underlyingSymbol="${o.u}" multiplier="100" strike="${o.k}" expiry="${o.exp || '20261218'}" putCall="${o.r}" tradeID="" tradeDate="20261012" dateTime="20261012;${o.t}" buySell="${o.side}" quantity="${o.side === 'SELL' ? -o.q : o.q}" price="${o.px}" commission="-1.05" orderID="${o.oid}" levelOfDetail="ORDER" transactionType="ExchTrade" />`;

const TODAY = '2026-10-12';
const trades = parseTradeConfirms(tc([
  // A call spread bought as one combo: two orders, the same second.
  opt({ u: 'XYZ', conid: 101, k: 440, r: 'C', side: 'BUY', q: 1, px: 32.97, oid: 9001, t: '101205' }),
  opt({ u: 'XYZ', conid: 102, k: 500, r: 'C', side: 'SELL', q: 1, px: 14.26, oid: 9002, t: '101205' }),
  // A straddle bought as one combo, its legs a few seconds apart across a minute boundary.
  opt({ u: 'ABC', conid: 201, k: 705, r: 'C', side: 'BUY', q: 1, px: 24.40, oid: 9101, t: '110259', exp: '20261023' }),
  opt({ u: 'ABC', conid: 202, k: 705, r: 'P', side: 'BUY', q: 1, px: 24.80, oid: 9102, t: '110302', exp: '20261023' }),
  // A scale-out on one contract: a buy, then two sales a minute apart — three orders, never a combo.
  opt({ u: 'QRS', conid: 301, k: 109, r: 'C', side: 'BUY', q: 50, px: 0.91, oid: 9201, t: '100000', exp: '20261023' }),
  opt({ u: 'QRS', conid: 301, k: 109, r: 'C', side: 'SELL', q: 25, px: 1.15, oid: 9202, t: '120000', exp: '20261023' }),
  opt({ u: 'QRS', conid: 301, k: 109, r: 'C', side: 'SELL', q: 20, px: 1.00, oid: 9203, t: '120030', exp: '20261023' }),
  // Two different calls in one name an hour apart: separate decisions, not one combo.
  opt({ u: 'LMN', conid: 401, k: 50, r: 'C', side: 'BUY', q: 2, px: 3.00, oid: 9301, t: '100000' }),
  opt({ u: 'LMN', conid: 402, k: 55, r: 'C', side: 'BUY', q: 2, px: 1.50, oid: 9302, t: '110000' }),
]));

const res = processInbox({ trades, today: TODAY, from: '2026-10-01', provisional: true });
const byRoot = (r) => res.drafts.filter(d => d.fill.root === r);
const xyz = byRoot('XYZ'), abc = byRoot('ABC');
eq('the call spread is one draft, not two legs', [xyz.length, xyz[0]?.fill.type, xyz[0]?.fill.orderId], [1, 'COMBO', '9001+9002']);
eq('…a debit, at the legs\' net', [xyz[0]?.fill.side, xyz[0]?.fill.rawPrice, xyz[0]?.fill.legs.map(l => `${l.side} ${l.strike}${l.right}`)], ['BUY', 18.71, ['BUY 440C', 'SELL 500C']]);
eq('…and says why it was joined', xyz[0]?.assembled, { orders: 2, withinMin: COMBO_LEG_MIN });
eq('the straddle across a minute boundary is one draft', [abc.length, abc[0]?.fill.orderId, abc[0]?.fill.rawPrice], [1, '9101+9102', 49.2]);
eq('a scale-out on one contract stays three fills', byRoot('QRS').map(d => d.fill.orderId), ['9201', '9202', '9203']);
eq('two calls an hour apart stay two fills', byRoot('LMN').map(d => d.fill.orderId).sort(), ['9301', '9302']);
eq('the summary counts joined legs, and four unjournaled instead of eight', [res.fate['9001'], res.fate['9102'], res.counts.combined, res.counts.unjournaled], ['combined', 'combined', 2, 7]);
eq('…and Sync now says so', /4 legs joined into combos/.test(syncNowLine({ fate: res.fate, units: res.units })), true);

// Confirming the joined draft records one two-leg trade.
const made = applyDraft([], xyz[0], {}, { today: TODAY });
const row = made.rows?.[0];
eq('confirming makes one spread row', [made.how, made.rows?.length, legsOf(row).map(l => `${l.side} ${l.strike}${l.right}`)], ['created', 1, ['long 440C', 'short 500C']]);

// The next sync: the legs are already on the console as `9001+9002`, so neither comes back.
const known = new Set((row.fills || []).map(f => f.tradeId));
const again = processInbox({ trades, today: TODAY, from: '2026-10-01', provisional: true, known, drafts: [] });
eq('next sync: neither leg is offered again', [again.fate['9001'], again.fate['9002'], again.drafts.filter(d => d.fill.root === 'XYZ').length], ['known', 'known', 0]);

// Drafts offered before this fix are joined on the next sync.
const legDraft = (id, k, right, side, px, minute) => ({ id: `d-${id}`, kind: 'fill', state: 'DRAFT', created: '2026-10-12T10:13:00Z', source: 'unjournaled', note: null, checks: [],
  fill: { orderId: id, type: 'OPT', root: 'XYZ', currency: 'USD', date: TODAY, side, qty: 1, rawPrice: px, price: px, commission: 1.05, multiplier: 100,
    legs: [{ right, strike: k, expiry: '2026-12-18', side, ratio: 1 }], tradeIds: [`${id}:x`], minute } });
const old = assembleCombos([legDraft('8001', 440, 'C', 'BUY', 32.97, 100), legDraft('8002', 500, 'C', 'SELL', 14.26, 100)]);
eq('legs already offered as separate cards are joined', [old.drafts.length, old.drafts[0].fill.orderId], [1, '8001+8002']);
eq('an untimed leg is never joined', assembleCombos([legDraft('8001', 440, 'C', 'BUY', 32.97, null), legDraft('8002', 500, 'C', 'SELL', 14.26, null)]).made.length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
