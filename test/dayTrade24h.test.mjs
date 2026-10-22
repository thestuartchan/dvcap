// The inbox's day-trade rule is the planner's: a position opened and back to zero within 24 hours of
// IBKR's fill times (lib/journalInbox.js dayTradeOrders). Calls bought one day and the rest sold at
// the next open were offered as four unjournaled fills. Made-up ticker, order ids and prices.
import { parseTradeConfirms } from '../lib/flexTrades.js';
import { processInbox, dayTradeOrders } from '../lib/journalInbox.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

const tc = (d, rows) => `<FlexQueryResponse queryName="same-day" type="TCF"><FlexStatements count="1"><FlexStatement accountId="U0000000" fromDate="${d}" toDate="${d}" period="Today"><TradeConfirms>${rows.join('')}</TradeConfirms></FlexStatement></FlexStatements></FlexQueryResponse>`;
const opt = (o) => `<TradeConfirm accountId="U0000000" currency="USD" assetCategory="OPT" symbol="XYZ x" conid="101" underlyingSymbol="XYZ" multiplier="100" strike="109" expiry="20261023" putCall="C" tradeID="" tradeDate="${o.d}" dateTime="${o.d};${o.t}" buySell="${o.side}" quantity="${o.side === 'SELL' ? -o.q : o.q}" price="${o.px}" commission="-1.05" orderID="${o.oid}" levelOfDetail="ORDER" transactionType="ExchTrade" />`;

// Wednesday: bought 50 at 10:15, sold 25 and 20 in the afternoon — 5 still open.
const wed = parseTradeConfirms(tc('20261021', [
  opt({ d: '20261021', t: '101500', side: 'BUY', q: 50, px: 0.91, oid: 7001 }),
  opt({ d: '20261021', t: '130000', side: 'SELL', q: 25, px: 1.15, oid: 7002 }),
  opt({ d: '20261021', t: '140000', side: 'SELL', q: 20, px: 1.00, oid: 7003 }),
]));
const s1 = processInbox({ trades: wed, today: '2026-10-21', from: '2026-10-01', provisional: true });
const offered = (r) => r.drafts.filter(d => d.source === 'unjournaled').map(d => d.fill.orderId).sort();
eq('Wednesday: 5 still open, so the three fills are offered', offered(s1), ['7001', '7002', '7003']);

// Thursday's Sync now holds only Thursday's sale; Wednesday's orders are known as their cards.
const thu = (t) => parseTradeConfirms(tc('20261022', [opt({ d: '20261022', t, side: 'SELL', q: 5, px: 1.30, oid: 7004 })]));
const early = processInbox({ trades: thu('093100'), today: '2026-10-22', from: '2026-10-01', provisional: true, drafts: s1.drafts, seen: s1.seen });
eq('the rest sold at the next open, under 24 hours: all four are a day trade, nothing offered', [offered(early), early.fate['7004']], [[], 'dayTrade']);
const late = processInbox({ trades: thu('103000'), today: '2026-10-22', from: '2026-10-01', provisional: true, drafts: s1.drafts, seen: s1.seen });
eq('sold after 24 hours: a swing — the sale is offered beside the three', offered(late), ['7001', '7002', '7003', '7004']);

// The rule itself.
const u = (orderId, side, qty, minute, date = '2026-10-23') => ({ orderId, type: 'STK', root: 'ABC', currency: 'USD', legs: [], side, qty, minute, date });
const FRI_3PM = Date.UTC(2026, 9, 23, 15, 0) / 60000, MON_931 = Date.UTC(2026, 9, 26, 9, 31) / 60000;
eq('Friday afternoon to Monday morning is not a day trade', [...dayTradeOrders([u('a', 'BUY', 10, FRI_3PM), u('b', 'SELL', 10, MON_931, '2026-10-26')])], []);
eq('untimed fills fall back to one date', [...dayTradeOrders([u('a', 'BUY', 10, null), u('b', 'SELL', 10, null)])].sort(), ['a', 'b']);
eq('untimed across two dates is not', [...dayTradeOrders([u('a', 'BUY', 10, null), u('b', 'SELL', 10, null, '2026-10-26')])], []);
eq('a round trip and then a new position: only the round trip', [...dayTradeOrders([u('a', 'BUY', 10, FRI_3PM), u('b', 'SELL', 10, FRI_3PM + 30), u('c', 'BUY', 5, FRI_3PM + 60)])].sort(), ['a', 'b']);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
