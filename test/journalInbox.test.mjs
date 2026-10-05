// test/journalInbox.test.mjs — notes written from chat, matched to the fills IBKR reports.
//
// The brief's acceptance table, case by case, against the real route handler and a Redis stand-in:
// what a note may do (append one, count them), what it may never do (read, edit, pass any other
// gate), how it meets its fill, and that nothing a note says reaches the channel or the repo.
import { validateNote, orderUnits, matchNote, processInbox, applyDraft, journalLine, draftCounts, expectationText,
         tradingDaysBetween, chooseCandidate, appendProcessed, whyNot, explainWaiting, assembledSpreads, fmtPx, amendTargets, productRoot, retryAmends, resolveAmend, amendRow, INBOX_KEY, DRAFTS_KEY } from '../lib/journalInbox.js';
import { parseTrades } from '../lib/flexTrades.js';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// ── A REDIS STAND-IN ─────────────────────────────────────────────────────────
// lib/kv.js speaks Upstash's REST protocol through fetch; this answers the commands it sends.
const mem = new Map();
const redis = (args) => {
  const [cmd, key, ...rest] = args;
  const list = () => { if (!Array.isArray(mem.get(key))) mem.set(key, []); return mem.get(key); };
  switch (cmd) {
    case 'GET': return mem.has(key) && !Array.isArray(mem.get(key)) ? mem.get(key) : null;
    case 'SET': mem.set(key, rest[0]); return 'OK';
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
process.env.GITHUB_TOKEN = 'unused'; process.env.GITHUB_REPO = 'x/y';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith(process.env.KV_REST_API_URL)) {
    const result = redis(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ result }) };
  }
  throw new Error(`unexpected network call in a test: ${url}`);
};

const { default: manualEntry } = await import('../api/manual-entry.js');
const { runJournal, resolveDraft } = await import('../lib/journalStore.js');
const { hasServiceKey, authorised } = await import('../lib/apiauth.js');

const call = async (handler, { method = 'GET', query = {}, headers = {}, body = undefined } = {}) => {
  const out = { status: 200, body: null, headers: {} };
  const res = {
    setHeader: (k, v) => { out.headers[k] = v; },
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
  };
  await handler({ method, query, headers: { host: 'test', ...headers }, body }, res);
  return out;
};
const TOKEN = { 'x-journal-token': process.env.JOURNAL_INBOX_TOKEN };
const NOTE_Q = { kind: 'journal-note' };

// ── The two notes the brief says will be sent first ──
const SPY_NOTE = {
  id: 'claude-2026-09-30-spy-750-720p', kind: 'open', written_at: '2026-09-30T15:32:00Z', trade_date: '2026-09-30',
  instrument: { type: 'COMBO', symbol: 'SPY', legs: [
    { right: 'P', strike: 750, expiry: '2026-11-20', side: 'BUY', ratio: 1 },
    { right: 'P', strike: 720, expiry: '2026-11-20', side: 'SELL', ratio: 1 }] },
  expected: { qty: 2, price: 4.40, tolerance_pct: 3 },
  tag: 'hedge',
  rationale: 'Credit-led / hawkish-Fed drawdown hedge; nothing else in the book pays in that scenario.',
  levels: { take_profit: 'half at ~8.80 (2x)', review: 'SPY close > 785 AND HY OAS < 2.8%', hard_date: '2026-11-20', decide_by: '2026-11-06' },
  rules: ['Add #3 Fri 2 Oct after NFP per the conditional table'],
  supersedes: null,
};
const NFLX_NOTE = {
  id: 'claude-2026-09-30-nflx-trim', kind: 'plan', written_at: '2026-09-30T15:40:00Z', trade_date: '2026-09-30',
  instrument: { type: 'STK', symbol: 'NFLX', side: 'SELL' }, expected: { qty: 200 },
  tag: 'position', rationale: 'Single-name cap breach at 17.4% of NLV; 215 reaches the 10% cap.',
};

// Flex rows as the statement emits them at ORDER level.
const O = (a) => `<Order ${Object.entries({ currency: 'USD', levelOfDetail: 'ORDER', ...a }).map(([k, v]) => `${k}="${v}"`).join(' ')} />`;
const SPY_LEGS = (order, date = '20260930', buy = 10.10, sell = 5.70) => [
  O({ ibOrderID: order, conid: `${order}1`, symbol: 'SPY   261120P00750000', underlyingSymbol: 'SPY', assetCategory: 'OPT', putCall: 'P', strike: 750, expiry: '20261120', multiplier: 100, buySell: 'BUY', quantity: 2, tradePrice: buy, ibCommission: -1.3, tradeDate: date }),
  O({ ibOrderID: order, conid: `${order}2`, symbol: 'SPY   261120P00720000', underlyingSymbol: 'SPY', assetCategory: 'OPT', putCall: 'P', strike: 720, expiry: '20261120', multiplier: 100, buySell: 'SELL', quantity: -2, tradePrice: sell, ibCommission: -1.3, tradeDate: date }),
];
const NFLX_SELL = (order, qty = 215, date = '20261001') => O({ ibOrderID: order, conid: '15124833', symbol: 'NFLX', assetCategory: 'STK', multiplier: 1, buySell: 'SELL', quantity: -qty, tradePrice: 1180.5, ibCommission: -1, tradeDate: date });
// A swing: bought and still open at the close — the only kind of fill offered without a note.
const HELD = O({ ibOrderID: '888', conid: '8881', symbol: 'QQQ   261016C00750000', underlyingSymbol: 'QQQ', assetCategory: 'OPT', putCall: 'C', strike: 750, expiry: '20261016', multiplier: 100, buySell: 'BUY', quantity: 5, tradePrice: 9.1, ibCommission: -3, tradeDate: '20260930' });
const ZERO_DTE = O({ ibOrderID: '777', conid: '7771', symbol: 'QQQ   260930C00745000', underlyingSymbol: 'QQQ', assetCategory: 'OPT', putCall: 'C', strike: 745, expiry: '20260930', multiplier: 100, buySell: 'BUY', quantity: 5, tradePrice: 1.2, ibCommission: -3, tradeDate: '20260930' });
const trades = (...xs) => parseTrades(`<FlexQueryResponse><Orders>${xs.flat().join('')}</Orders></FlexQueryResponse>`);
const US = JSON.parse(readFileSync('data/holidays.json', 'utf8')).US.closed;

// ── VALIDATION ───────────────────────────────────────────────────────────────
{
  eq('the brief\'s SPY note validates', validateNote(SPY_NOTE).ok, true);
  eq('and so does the NFLX plan', validateNote(NFLX_NOTE).ok, true);
  eq('an unknown kind is refused', validateNote({ ...SPY_NOTE, kind: 'yolo' }).ok, false);
  eq('an unknown field is refused, not dropped', validateNote({ ...SPY_NOTE, qty: 2 }).error, 'unknown field: qty');
  eq('a COMBO with one leg is refused', validateNote({ ...SPY_NOTE, instrument: { ...SPY_NOTE.instrument, legs: SPY_NOTE.instrument.legs.slice(0, 1) } }).ok, false);
  eq('an amend must name what it supersedes', validateNote({ id: 'amend-1', kind: 'amend', trade_date: '2026-09-30' }).ok, false);
  eq('an amend that does is fine without an instrument', validateNote({ id: 'amend-1', kind: 'amend', trade_date: '2026-09-30', supersedes: 'SPY-abc', levels: { stop: 'close below 2.20' } }).ok, true);
  eq('a hard date that is not a date is refused', validateNote({ ...SPY_NOTE, levels: { hard_date: 'Nov 20' } }).ok, false);
}

// ── TRADING DAYS ─────────────────────────────────────────────────────────────
{
  eq('30 Sep → 7 Oct is five sessions', tradingDaysBetween('2026-09-30', '2026-10-07', US), 5);
  eq('30 Sep → 6 Oct is four', tradingDaysBetween('2026-09-30', '2026-10-06', US), 4);
  eq('Thanksgiving is not a session', tradingDaysBetween('2026-11-25', '2026-11-27', US), 1);
}

// ── ORDERS: THE LEGS OF ONE COMBO ARE ONE EVENT ──────────────────────────────
{
  const u = orderUnits(trades(SPY_LEGS('900')));
  eq('two legs sharing an order id are one unit', u.length, 1);
  eq('it is a COMBO of 2 at the net debit 4.40', [u[0].type, u[0].qty, u[0].side, u[0].rawPrice], ['COMBO', 2, 'BUY', 4.4]);
  eq('each leg keeps its right, strike, expiry, side and ratio', u[0].legs.map(l => `${l.side} ${l.strike}${l.right} ${l.expiry} ×${l.ratio}`),
    ['BUY 750P 2026-11-20 ×1', 'SELL 720P 2026-11-20 ×1']);
  ok('the fill price carries the commission, as every console fill does', u[0].price > 4.4 && u[0].price < 4.42);
}

// ── CASE 1: the SPY hedge, one match, one DRAFT ──────────────────────────────
const TODAY = '2026-10-01';
{
  const n = validateNote(SPY_NOTE).note;
  const out = processInbox({ notes: [n], trades: trades(SPY_LEGS('900')), today: TODAY, holidays: US, now: '2026-10-01T12:00:00Z' });
  const d = out.drafts.filter(x => x.kind === 'fill');
  eq('one draft', d.length, 1);
  eq('a combo, from the note, in state DRAFT', [d[0].fill.type, d[0].source, d[0].state], ['COMBO', 'note', 'DRAFT']);
  eq('tag and levels come from the note', [d[0].note.tag, d[0].note.levels.take_profit, d[0].note.levels.hard_date], ['hedge', 'half at ~8.80 (2x)', '2026-11-20']);
  eq('the fill numbers come from IBKR', [d[0].fill.qty, d[0].fill.rawPrice, d[0].fill.date], [2, 4.4, '2026-09-30']);
  eq('the card reads "note expected 2 @ 4.40, IBKR filled 2 @ 4.40 ✓"', expectationText(d[0]).text, 'note expected 2 @ 4.40, IBKR filled 2 @ 4.40 ✓');
  eq('the note left the inbox as drafted', out.leaving.map(l => l.outcome), ['drafted']);
  eq('and the combo was not also offered as unjournaled', out.counts.unjournaled, 0);

  // Confirming it opens ONE spread row, fill at the combo price, legs as held.
  const r = applyDraft([], d[0], {}, { today: TODAY });
  const row = r.rows[0];
  eq('confirm creates the row', r.how, 'created');
  eq('a SPY spread, long, ×100', [row.symbol, row.instrument, row.side, row.multiplier], ['SPY', 'spread', 'long', 100]);
  eq('legs as held: long 750P, short 720P', row.legs.map(l => `${l.side} ${l.strike}${l.right}`), ['long 750P', 'short 720P']);
  eq('one fill, buy 2 at the IBKR price', [row.fills.length, row.fills[0].side, row.fills[0].qty, row.fills[0].price === d[0].fill.price], [1, 'buy', 2, true]);
  eq('tag and the note\'s levels ride on the row', [row.tag, row.journal.levels.review, row.journal.levels.hard_date], ['hedge', 'SPY close > 785 AND HY OAS < 2.8%', '2026-11-20']);
  eq('a hard date on expiry day steps back to the last session the console allows', row.hardDate, '2026-11-19');
  eq('the rationale is the thesis', row.thesis, SPY_NOTE.rationale);
  // A second confirm of a later close finds the same row by its contracts, legs reversed.
  const closeUnit = processInbox({ notes: [], trades: trades(SPY_LEGS('901', '20261002', 5.7, 10.1).map(x => x.replace('buySell="BUY"', 'buySell="TMP"').replace('buySell="SELL"', 'buySell="BUY"').replace('buySell="TMP"', 'buySell="SELL"'))), today: '2026-10-02', holidays: US }).drafts[0];
  const r2 = applyDraft(r.rows, closeUnit, {}, { today: '2026-10-02' });
  eq('a closing order lands on the same row as a sell', [r2.how, r2.rowId, r2.rows[0].fills[1]?.side], ['added', row.id, 'sell']);
  // Typed in by hand before the statement arrived: the draft adopts that fill instead of doubling it.
  const hand = [{ id: 'SPY-hand', symbol: 'SPY', underlying: 'SPY', instrument: 'spread', side: 'long', multiplier: 100, currency: 'USD', thesis: '', levels: [], tags: [],
    legs: [{ right: 'P', strike: 750, expiry: '2026-11-20', side: 'long', ratio: 1 }, { right: 'P', strike: 720, expiry: '2026-11-20', side: 'short', ratio: 1 }],
    fills: [{ id: 'h1', side: 'buy', qty: 2, price: 4.40, date: '2026-09-30' }] }];
  const r3 = applyDraft(hand, d[0], {}, { today: TODAY });
  eq('a spread already entered by hand is adopted, not doubled', [r3.how, r3.rows[0].fills.length, r3.rows[0].fills[0].tradeId, r3.rows[0].tag], ['adopted', 1, '900', 'hedge']);
  const handOff = [{ ...hand[0], fills: [{ id: 'h1', side: 'buy', qty: 2, price: 4.90, date: '2026-09-30' }] }];
  eq('a hand fill at a different price is a different fill', applyDraft(handOff, d[0], {}, { today: TODAY }).how, 'added');
}

// ── CASE 2: the NFLX plan, 215 sold the next day ─────────────────────────────
{
  const n = validateNote(NFLX_NOTE).note;
  const out = processInbox({ notes: [n], trades: trades(NFLX_SELL('950')), today: '2026-10-02', holidays: US });
  const d = out.drafts[0];
  eq('a draft trim of 215', [d.kind, d.fill.root, d.fill.side, d.fill.qty], ['fill', 'NFLX', 'SELL', 215]);
  eq('flagged against the note\'s ~200', d.checks.find(c => c.field === 'qty'), { field: 'qty', note: 200, ibkr: 215, ok: false });
  eq('the card says so', expectationText(d).text, 'note expected 200, IBKR filled 215 @ 1180.50 — note said ~200');
  ok('one day after the note, inside ±1', d.checks.some(c => c.field === 'date' && c.ibkr === '2026-10-01'));
  // The planner records share fills itself; confirming annotates that row rather than adding a
  // second copy of the same sale.
  const rows = [{ id: 'NFLX-open', symbol: 'NFLX', currency: 'USD', side: 'long', tag: null, thesis: 'core', levels: [],
    fills: [{ id: 'a', side: 'buy', qty: 1000, price: 900, date: '2026-06-01' }, { id: 'b', side: 'sell', qty: 215, price: 1180.5, date: '2026-10-01', tradeId: d.fill.tradeIds[0] }] }];
  const r = applyDraft(rows, d, {}, { today: '2026-10-02' });
  eq('the sale already on the row is annotated, not doubled', [r.how, r.rows[0].fills.length, r.rows[0].tag], ['annotated', 2, 'position']);
  const typed = [{ ...rows[0], fills: [rows[0].fills[0], { id: 'b', side: 'sell', qty: 215, price: 1180, date: '2026-10-01' }] }];
  eq('a sale typed in by hand that the planner has not stamped is adopted too', [applyDraft(typed, d).how, applyDraft(typed, d).rows[0].fills.length], ['adopted', 2]);
  ok('the rationale is appended to the existing thesis', /^core\n— 2026-09-30 \(plan\): Single-name cap/.test(r.rows[0].thesis));
  // Out of window: a plan waits five sessions, not six.
  const late = processInbox({ notes: [n], trades: trades(NFLX_SELL('951', 215, '20261008')), today: '2026-10-08', holidays: US });
  eq('a sale six sessions later is not this note\'s', late.drafts.filter(x => x.kind === 'fill' && x.note).length, 0);
}

// ── CASE 3: same note, no sale by 7 Oct ──────────────────────────────────────
{
  const n = validateNote(NFLX_NOTE).note;
  const on6 = processInbox({ notes: [n], trades: [], today: '2026-10-06', holidays: US });
  eq('on 6 Oct it is still pending', [on6.counts.pending, on6.drafts.length], [1, 0]);
  const on7 = processInbox({ notes: [n], trades: [], today: '2026-10-07', holidays: US });
  eq('on 7 Oct it moves to notes without fills', [on7.drafts[0].kind, on7.leaving[0].outcome], ['unfilled', 'no-fill']);
  eq('counted as one without a fill', draftCounts(on7.drafts), { toConfirm: 0, ruleChanges: 0, unjournaled: 0, withoutFills: 1 });
}

// ── CASE 4: a fill with no note ──────────────────────────────────────────────
{
  const out = processInbox({ notes: [], trades: trades(HELD), today: TODAY, holidays: US });
  const d = out.drafts[0];
  eq('an unjournaled-fill draft for a fill held overnight', [d.kind, d.source, d.note], ['fill', 'unjournaled', null]);
  eq('counted as unjournaled', draftCounts(out.drafts).unjournaled, 1);
  const again = processInbox({ notes: [], trades: trades(HELD), today: TODAY, holidays: US, seen: out.seen, drafts: [] });
  eq('dismissed once, it is not offered again from the same 30-day window', again.drafts.length, 0);
  // DAY TRADES STAY OFF THE CONSOLE (Stu, 2 Oct): a 0DTE, or a contract taken to flat in the session.
  eq('a 0DTE fill is a day trade, not a draft', processInbox({ notes: [], trades: trades(ZERO_DTE), today: TODAY, holidays: US }).drafts.length, 0);
  const flat = trades(HELD, HELD.replace('ibOrderID="888"', 'ibOrderID="889"').replace('buySell="BUY"', 'buySell="SELL"').replace('quantity="5"', 'quantity="-5"').replace('tradePrice="9.1"', 'tradePrice="9.6"'));
  eq('a contract bought and sold flat the same day is a day trade', processInbox({ notes: [], trades: flat, today: TODAY, holidays: US }).drafts.length, 0);
  eq('an unjournaled draft that is now a day trade is withdrawn', processInbox({ notes: [], trades: trades(ZERO_DTE), today: TODAY, holidays: US,
    drafts: [{ id: 'd-777', kind: 'fill', source: 'unjournaled', fill: { orderId: '777' }, note: null, created: 'x' }] }).drafts.length, 0);
  const before = processInbox({ notes: [], trades: trades(HELD.replace('tradeDate="20260930"', 'tradeDate="20260929"')), today: TODAY, holidays: US });
  eq('a fill from before the inbox went live is history, not a draft', before.drafts.length, 0);
  const known = processInbox({ notes: [], trades: trades(NFLX_SELL('952', 100, '20260930')), known: new Set(['952:15124833']), today: TODAY, holidays: US });
  eq('a fill already entered by hand (adopted) is journaled', known.drafts.length, 0);
  // A note that arrives after its fill was offered as unjournaled upgrades that draft.
  const late = processInbox({ notes: [validateNote(SPY_NOTE).note], trades: trades(SPY_LEGS('900')), today: TODAY, holidays: US,
    seen: {}, drafts: processInbox({ notes: [], trades: trades(SPY_LEGS('900')), today: TODAY, holidays: US }).drafts });
  eq('a late note upgrades the unjournaled draft in place', [late.drafts.length, late.drafts[0].source], [1, 'note']);
}

// ── CASE 5: two identical fills, one note ────────────────────────────────────
{
  const out = processInbox({ notes: [validateNote(SPY_NOTE).note], trades: trades(SPY_LEGS('900'), SPY_LEGS('905')), today: TODAY, holidays: US });
  eq('nothing is drafted as a fill', out.drafts.filter(d => d.kind === 'fill').length, 0);
  const a = out.drafts.find(d => d.kind === 'ambiguous');
  eq('both are listed as ambiguous', a.candidates.map(c => c.fill.orderId), ['900', '905']);
  eq('and neither is offered as unjournaled', out.counts.unjournaled, 0);
  const chosen = chooseCandidate(a, '905');
  eq('Stu can choose one, which becomes an ordinary draft', [chosen.kind, chosen.fill.orderId, chosen.note.id], ['fill', '905', SPY_NOTE.id]);
}

// ── MATCHING RULES ───────────────────────────────────────────────────────────
{
  const n = validateNote(SPY_NOTE).note;
  const [u] = orderUnits(trades(SPY_LEGS('900')));
  ok('the right legs match', matchNote(n, u, { holidays: US }));
  eq('a different strike does not', matchNote({ ...n, instrument: { ...n.instrument, legs: [n.instrument.legs[0], { ...n.instrument.legs[1], strike: 710 }] } }, u, { holidays: US }), null);
  eq('a leg on the other side does not', matchNote({ ...n, instrument: { ...n.instrument, legs: [{ ...n.instrument.legs[0], side: 'SELL' }, { ...n.instrument.legs[1], side: 'BUY' }] } }, u, { holidays: US }), null);
  eq('a different quantity on an open does not', matchNote({ ...n, expected: { ...n.expected, qty: 3 } }, u, { holidays: US }), null);
  eq('a price outside the tolerance does not', matchNote({ ...n, expected: { ...n.expected, price: 4.70 } }, u, { holidays: US }), null);
  eq('two sessions away does not', matchNote({ ...n, trade_date: '2026-09-28' }, u, { holidays: US }), null);
  ok('one session away does — Dubai and New York disagree about dates', matchNote({ ...n, trade_date: '2026-10-01' }, u, { holidays: US }));
}

// ── WHY A NOTE IS STILL WAITING ──────────────────────────────────────────────
{
  const n = validateNote(SPY_NOTE).note;
  const units = (xs) => orderUnits(trades(...xs));
  eq('no orders in the symbol says so', explainWaiting(n, units([ZERO_DTE]), { holidays: US }).startsWith('no SPY orders in the statement yet'), true);
  // Legs an hour apart: not paired, so the reason names the split.
  const apart = SPY_LEGS('900').map((x, i) => x.replace('ibOrderID="900"', `ibOrderID="90${i}" dateTime="20260930;${i ? '110500' : '100000'}"`));
  ok('legs filled as separate orders are named as the reason', /1 leg in IBKR's order .* 2 in the note — if a spread's legs were filled as separate orders/.test(explainWaiting(n, units([apart]), { holidays: US })));
  ok('a price outside tolerance says by how much', /net price 4\.70, the note expects 4\.40 ±3% \(6\.8% off\)/.test(explainWaiting(n, units([SPY_LEGS('900', '20260930', 10.4, 5.7)]), { holidays: US })));
  ok('a fill in the wrong week says the window', /filled 2026-10-07, outside 2026-09-30/.test(explainWaiting(n, units([SPY_LEGS('900', '20261007')]), { holidays: US })));
  eq('a match explains nothing', whyNot(n, orderUnits(trades(SPY_LEGS('900')))[0], { holidays: US }), null);
  const out = processInbox({ notes: [n, validateNote(NFLX_NOTE).note], trades: trades(ZERO_DTE), today: TODAY, holidays: US });
  eq('the run records a reason for each waiting note', Object.keys(out.why).sort(), [NFLX_NOTE.id, SPY_NOTE.id].sort());
}

// ── A YEN CALL SPREAD: FUTURES-OPTION NAMES, PRICES NEAR 0.00003 ─────────────
// The 1 Oct trade: two legs as separate orders, reported under the future's month code (6JZ6),
// priced in dollars per yen. toFixed(4) used to make both prices 0 and the note never matched.
{
  const leg = (order, strike, side, px, time) => O({ ibOrderID: order, conid: `${order}1`, symbol: `6JZ6 C${strike}`, underlyingSymbol: '6JZ6', assetCategory: 'FOP',
    putCall: 'C', strike, expiry: '20261009', multiplier: 12500000, buySell: side, quantity: side === 'BUY' ? 2 : -2, tradePrice: px, ibCommission: -5.36,
    tradeDate: '20261001', dateTime: `20261001;${time}` });
  const legs = trades([leg('720', 0.0064, 'BUY', 0.00003, '133529'), leg('721', 0.0065, 'SELL', 0.000012, '133619')]);
  const u = orderUnits(legs);
  eq('each leg keeps its premium — not 0', u.map(x => x.rawPrice), [0.00003, 0.000012]);
  eq('the 6J names agree', ['6JZ6', 'JPY', 'JPU', '6J'].map(productRoot), ['6J', '6J', '6J', '6J']);
  for (const sym of ['JPY', '6J']) {
    const n = validateNote({ id: `t-jpy-${sym.toLowerCase()}`, kind: 'open', written_at: '2026-10-01T13:00:00Z', trade_date: '2026-10-01',
      instrument: { type: 'COMBO', symbol: sym, legs: [
        { right: 'C', strike: 0.0064, expiry: '2026-10-09', side: 'BUY', ratio: 1 },
        { right: 'C', strike: 0.0065, expiry: '2026-10-09', side: 'SELL', ratio: 1 }] },
      expected: { qty: 2, price: 0.000018, tolerance_pct: 5 }, tag: 'swing', rationale: 'yen call spread into the 9 Oct expiry' }).note;
    const sp = assembledSpreads(n, u);
    eq(`a note naming ${sym}: the legs pair into one spread at the net debit`, sp.map(x => [x.type, x.qty, x.rawPrice]), [['COMBO', 2, 0.000018]]);
    const out = processInbox({ notes: [n], trades: legs, today: '2026-10-02', holidays: US });
    eq(`…and it drafts from the note, with no unjournaled legs (${sym})`, [out.counts.drafted, out.counts.unjournaled], [1, 0]);
  }
  eq('the card prints the premium', fmtPx(0.000018), '0.000018');
}

// ── A SPREAD IBKR REPORTED AS SEPARATE ORDERS ────────────────────────────────
{
  const n = validateNote(SPY_NOTE).note;
  const legs = (t1, t2) => SPY_LEGS('900').map((x, i) => x.replace('ibOrderID="900"', `ibOrderID="91${i}" dateTime="20260930;${i ? t2 : t1}"`));
  const apart = trades(legs('112600', '112631'));
  eq('two single-leg orders, the same minute: one assembled spread', assembledSpreads(n, orderUnits(apart)).map(u => [u.orderId, u.type, u.qty, u.rawPrice]), [['910+911', 'COMBO', 2, 4.4]]);
  const out = processInbox({ notes: [n], trades: apart, today: TODAY, holidays: US });
  const d = out.drafts.filter(x => x.kind === 'fill');
  eq('it drafts as one spread, from the note', [d.length, d[0]?.source, d[0]?.fill.legs.length], [1, 'note', 2]);
  eq('and neither leg is also offered as unjournaled', out.counts.unjournaled, 0);
  eq('legs filled an hour apart are not paired', assembledSpreads(n, orderUnits(trades(legs('100000', '110500')))).length, 0);
  // The 30 Sep case: legs first offered as unjournaled, the note matched on a later run.
  const first = processInbox({ notes: [], trades: apart, today: TODAY, holidays: US });
  eq('before the note, two unjournaled legs', first.counts.unjournaled, 2);
  const later = processInbox({ notes: [n], trades: apart, today: TODAY, holidays: US, seen: first.seen, drafts: first.drafts });
  eq('the note then claims both and withdraws their unjournaled drafts', [later.drafts.map(x => x.id).sort(), later.counts.drafted], [['d-910+911'], 1]);
  // Confirming it against the row the position sync already added adopts that fill.
  const row = [{ id: 'SPY-flex', symbol: 'SPY', underlying: 'SPY', instrument: 'spread', side: 'long', multiplier: 100, currency: 'USD', thesis: 'Added from the IBKR statement of 2026-09-30.', levels: [], tags: [],
    legs: [{ right: 'P', strike: 750, expiry: '2026-11-20', side: 'long', ratio: 1 }, { right: 'P', strike: 720, expiry: '2026-11-20', side: 'short', ratio: 1 }],
    fills: [{ id: 'p1', side: 'buy', qty: 2, price: 4.4106, date: '2026-09-30' }] }];
  const r = applyDraft(row, later.drafts[0], {}, { today: TODAY });
  eq('confirm links the note to the existing row — no second fill', [r.how, r.rows[0].fills.length, r.rows[0].tag, r.rows[0].thesis], ['adopted', 1, 'hedge', SPY_NOTE.rationale]);
}
{
  eq('an ordinary premium prints to the cent', fmtPx(4.4), '4.40');
  eq('a yen FOP premium is not rounded to zero', fmtPx(0.00004), '0.00004');
}

// ── AMEND ────────────────────────────────────────────────────────────────────
{
  const n = validateNote({ id: 'amend-spy-stop', kind: 'amend', trade_date: '2026-10-02', supersedes: 'SPY-j900', levels: { review: 'SPY close > 790' } }).note;
  const out = processInbox({ notes: [n], trades: [], today: '2026-10-02', holidays: US });
  eq('an amend becomes a draft edit, never a silent change', [out.drafts[0].kind, out.drafts[0].supersedes], ['amend', 'SPY-j900']);
  const rows = [{ id: 'SPY-j900', symbol: 'SPY', tag: 'hedge', thesis: 'x', fills: [], levels: [] }];
  eq('confirming it changes that row\'s levels', applyDraft(rows, out.drafts[0]).rows[0].journal.levels.review, 'SPY close > 790');
  eq('an amend naming no console trade is refused', applyDraft([], out.drafts[0]).error, 'no console trade with id SPY-j900');
}

// ── THE CHANNEL: SYMBOLS AND COUNTS ──────────────────────────────────────────
{
  const out = processInbox({ notes: [validateNote(SPY_NOTE).note, validateNote({ ...NFLX_NOTE, trade_date: '2026-09-22' }).note], trades: trades(SPY_LEGS('900'), HELD), today: TODAY, holidays: US });
  const line = journalLine(out);
  eq('the line', line, '1 journal draft to confirm (SPY) · 1 unjournaled fill (QQQ) · 1 note without a fill (NFLX)');
  for (const bad of ['hedge', '4.4', '750', '215', 'rationale', 'NLV', 'Credit', '8.80', '785', 'position']) ok(`the line carries no "${bad}"`, !line.includes(bad));
  const src = readFileSync('api/flex-sync.js', 'utf8');
  ok('the sync builds the channel line from journalLine alone', /const journaled = journal\?\.applied \? journalLine\(journal\) : ''/.test(src));
}

// ── THE ROUTE ────────────────────────────────────────────────────────────────
{
  mem.clear();
  eq('POST without a token → 401', (await call(manualEntry, { method: 'POST', query: NOTE_Q, body: SPY_NOTE })).status, 401);
  eq('POST with the service key → 401', (await call(manualEntry, { method: 'POST', query: NOTE_Q, headers: { 'x-tradecard-key': process.env.TRADECARD_KEY }, body: SPY_NOTE })).status, 401);
  eq('POST with the service key as ?key= → 401', (await call(manualEntry, { method: 'POST', query: { ...NOTE_Q, key: process.env.TRADECARD_KEY }, body: SPY_NOTE })).status, 401);
  eq('POST with a wrong token → 401', (await call(manualEntry, { method: 'POST', query: NOTE_Q, headers: { 'x-journal-token': 'jt-0123456789abcdeX' }, body: SPY_NOTE })).status, 401);
  eq('a token in the query string is not read', (await call(manualEntry, { method: 'POST', query: { ...NOTE_Q, token: process.env.JOURNAL_INBOX_TOKEN }, body: SPY_NOTE })).status, 401);

  const r = await call(manualEntry, { method: 'POST', query: NOTE_Q, headers: TOKEN, body: SPY_NOTE });
  eq('POST with the token → 201', r.status, 201);
  eq('and echoes only { id, received_at }', Object.keys(r.body), ['id', 'received_at']);
  eq('the note is in the inbox list', mem.get(INBOX_KEY).length, 1);
  eq('a retry of the same id → 409, nothing appended', [(await call(manualEntry, { method: 'POST', query: NOTE_Q, headers: TOKEN, body: SPY_NOTE })).status, mem.get(INBOX_KEY).length], [409, 1]);
  eq('an invalid note → 400', (await call(manualEntry, { method: 'POST', query: NOTE_Q, headers: TOKEN, body: { ...SPY_NOTE, id: 'x2-note', kind: 'buy' } })).status, 400);
  eq('over 4 KB → 413', (await call(manualEntry, { method: 'POST', query: NOTE_Q, headers: TOKEN, body: { ...SPY_NOTE, id: 'big-note', rationale: 'x'.repeat(4200) } })).status, 413);
  const g = await call(manualEntry, { method: 'GET', query: NOTE_Q, headers: TOKEN });
  eq('GET with the token → { pending: n }, no note content', [g.status, g.body], [200, { pending: 1 }]);
  eq('the answer is private, no-store', g.headers['Cache-Control'], 'private, no-store');
  eq('DELETE with the token → 405', (await call(manualEntry, { method: 'DELETE', query: NOTE_Q, headers: TOKEN })).status, 405);

  // The token opens nothing else.
  eq('token on the console GET → 401', (await call(manualEntry, { method: 'GET', headers: TOKEN })).status, 401);
  eq('token on the console POST → 401', (await call(manualEntry, { method: 'POST', headers: TOKEN, body: { console: { rows: [] } } })).status, 401);
  eq('token on a draft resolve → 401', (await call(manualEntry, { method: 'POST', headers: TOKEN, body: { journalDraft: { id: 'x', action: 'dismiss' } } })).status, 401);
  const { default: flexSync } = await import('../api/flex-sync.js');
  eq('token on /api/flex-sync → 401', (await call(flexSync, { method: 'GET', headers: TOKEN })).status, 401);
  eq('token sent as the service-key header → 401', (await call(flexSync, { method: 'GET', headers: { 'x-tradecard-key': process.env.JOURNAL_INBOX_TOKEN } })).status, 401);
  // Even misconfigured with the same value in both variables, the journal token is not a service key.
  const saved = process.env.TRADECARD_KEY;
  process.env.TRADECARD_KEY = process.env.JOURNAL_INBOX_TOKEN;
  eq('same value in both variables: still not a service key', [hasServiceKey({ headers: { 'x-tradecard-key': process.env.JOURNAL_INBOX_TOKEN } }), await authorised({ headers: { 'x-tradecard-key': process.env.JOURNAL_INBOX_TOKEN } })], [false, false]);
  process.env.TRADECARD_KEY = saved;
  eq('and the real service key still works where it should', hasServiceKey({ headers: { 'x-tradecard-key': saved } }), true);

  // Rate limit: 60 an hour, counted from a fresh hour.
  for (const k of [...mem.keys()]) if (k.startsWith('dvcap:journal:rate:v1')) mem.delete(k);
  let last = 0;
  for (let i = 0; i < 60; i++) last = (await call(manualEntry, { method: 'POST', query: NOTE_Q, headers: TOKEN, body: { ...NFLX_NOTE, id: `rate-${i}` } })).status;
  eq('the 61st note in an hour → 429', [last, (await call(manualEntry, { method: 'POST', query: NOTE_Q, headers: TOKEN, body: { ...NFLX_NOTE, id: 'rate-x' } })).status], [201, 429]);
}

// ── THE DAILY RUN, END TO END ON THE STAND-IN ────────────────────────────────
{
  mem.clear();
  await call(manualEntry, { method: 'POST', query: NOTE_Q, headers: TOKEN, body: SPY_NOTE });
  await call(manualEntry, { method: 'POST', query: NOTE_Q, headers: TOKEN, body: NFLX_NOTE });
  const dry = await runJournal({ trades: trades(SPY_LEGS('900')), today: TODAY, holidays: US, apply: false });
  eq('a dry run reports and writes nothing', [dry.counts.drafted, mem.has(DRAFTS_KEY), mem.get(INBOX_KEY).length], [1, false, 2]);
  const run = await runJournal({ trades: trades(SPY_LEGS('900')), today: TODAY, holidays: US, apply: true });
  eq('the run drafts SPY and leaves NFLX waiting', [run.counts.drafted, run.counts.pending, mem.get(INBOX_KEY).length], [1, 1, 1]);
  eq('the one left in the inbox is the NFLX plan', JSON.parse(mem.get(INBOX_KEY)[0]).id, NFLX_NOTE.id);
  const drafts = JSON.parse(mem.get(DRAFTS_KEY)).drafts;
  eq('one draft stored', drafts.map(d => d.id), ['d-900']);
  const processed = JSON.parse(mem.get('dvcap:journal:processed:v1'));
  eq('the SPY note moved to processed', processed.map(p => [p.id, p.outcome]), [[SPY_NOTE.id, 'drafted']]);
  const g = await call(manualEntry, { method: 'GET', query: NOTE_Q, headers: TOKEN });
  eq('the pending count falls to 1', g.body, { pending: 1 });
  // The console (session-gated) can see what is still waiting and take one out; the token route cannot.
  const { readJournal, dropNote } = await import('../lib/journalStore.js');
  eq('the console read lists the pending note', (await readJournal()).pendingNotes.map(x => x.id), [NFLX_NOTE.id]);
  eq('removing it empties the inbox', [(await dropNote(NFLX_NOTE.id)).ok, (await readJournal()).pending], [true, 0]);
  eq('removing it again says it is gone', (await dropNote(NFLX_NOTE.id)).ok, false);
  eq('drop-note through the route needs the session, not the token', (await call(manualEntry, { method: 'POST', headers: TOKEN, body: { journalDraft: { id: 'x', action: 'drop-note' } } })).status, 401);
  const res = await resolveDraft({ id: 'd-900', action: 'confirm' });
  eq('confirm takes the draft off the list', [res.ok, res.drafts.length], [true, 0]);
  eq('and records the outcome', JSON.parse(mem.get('dvcap:journal:processed:v1')).map(p => p.outcome), ['drafted', 'dropped', 'confirmed']);
  eq('resolving it again says it is gone', (await resolveDraft({ id: 'd-900', action: 'dismiss' })).ok, false);
  const again = await call(manualEntry, { method: 'POST', query: NOTE_Q, headers: TOKEN, body: SPY_NOTE });
  eq('a processed id cannot be re-posted', again.status, 409);
}

// ── AMEND BY INSTRUMENT (2 Oct brief) ────────────────────────────────────────
{
  const brnt = { id: 'BRNT-open', symbol: 'BRNT.L', currency: 'USD', side: 'long', multiplier: 1, tag: 'hedge', thesis: 'Energy hedge.', levels: [], tags: [],
    fills: [{ id: 'b1', side: 'buy', qty: 100, price: 95.3, date: '2026-09-02' }],
    journal: { levels: { take_profit: 'T1 +20%', invalidation: 'ceasefire', review: 'old review' }, rules: ['old rule'] } };
  const xle = { id: 'XLE-55c', symbol: 'XLE', underlying: 'XLE', instrument: 'option', side: 'long', multiplier: 100, currency: 'USD', thesis: '', levels: [], tags: [],
    legs: [{ right: 'C', strike: 55, expiry: '2027-01-15', side: 'long', ratio: 1 }], fills: [{ id: 'x1', side: 'buy', qty: 2, price: 6.1, date: '2026-09-10' }] };
  const nflxA = { id: 'NFLX-a', symbol: 'NFLX', currency: 'USD', side: 'long', multiplier: 1, levels: [], tags: [], fills: [{ id: 'n1', side: 'buy', qty: 10, price: 60, date: '2026-08-01' }] };
  const nflxB = { ...nflxA, id: 'NFLX-b' };
  const closed = { ...nflxA, id: 'AMD-closed', symbol: 'AMD', fills: [{ id: 'a1', side: 'buy', qty: 10, price: 1, date: '2026-08-01' }, { id: 'a2', side: 'sell', qty: 10, price: 2, date: '2026-08-05' }] };
  const rows = [brnt, xle, nflxA, nflxB, closed];
  const A = { id: 'claude-2026-10-02-brnt-amend-range-trim', kind: 'amend', written_at: '2026-10-01T22:20:00Z', trade_date: '2026-10-02',
    instrument: { type: 'STK', symbol: 'BRNT' }, tag: 'hedge', rationale: 'Range-aware first trim.',
    levels: { take_profit: 'T1: Brent front closes >= $108 or BRNT +20%', invalidation: 'unchanged', review: null },
    rules: ['Crisis rule unchanged', 'Optional re-add <= $90', 'No stop'] };
  const B = { id: 'claude-2026-10-02-xle-55c-amend-exit-rule', kind: 'amend', written_at: '2026-10-01T22:20:00Z', trade_date: '2026-10-02',
    instrument: { type: 'OPT', symbol: 'XLE', legs: [{ right: 'C', strike: 55, expiry: '2027-01-15', side: 'BUY', ratio: 1 }] }, tag: 'hedge',
    rationale: 'Paired with BRNT.', levels: { take_profit: 'Trim 1 of 2 if XLE >= $70', decide_by: '2026-12-15' }, rules: ['Roll or close by 15 Dec'] };
  const v = (x) => validateNote(x).note;
  eq('BRNT (STK) finds the LSE line, once', amendTargets(v(A), rows).map(r => r.id), ['BRNT-open']);
  eq('XLE Jan27 55C (OPT) finds that option', amendTargets(v(B), rows).map(r => r.id), ['XLE-55c']);
  const rA = resolveAmend(v(A), rows, { now: 'T' });
  eq('one open trade → a draft edit on it', [rA.outcome, rA.item.kind, rA.item.supersedes, rA.item.target.label], ['amend-drafted', 'amend', 'BRNT-open', 'BRNT.L']);
  const none = resolveAmend(v({ ...A, id: 'amd-amend', instrument: { type: 'STK', symbol: 'AMD' } }), rows);
  eq('a symbol with no OPEN trade → without a fill, no draft', [none.outcome, none.item.kind, none.item.reason], ['no-target', 'unfilled', 'amend: no open trade for AMD']);
  const two = resolveAmend(v({ ...A, id: 'nflx-amend', instrument: { type: 'STK', symbol: 'NFLX' } }), rows);
  eq('two open trades → ambiguous, both listed, nothing drafted', [two.outcome, two.item.kind, two.item.candidates.map(c => c.row.id)], ['ambiguous', 'ambiguous', ['NFLX-a', 'NFLX-b']]);
  eq('choosing one drafts the edit on it', chooseCandidate(two.item, 'NFLX-b').supersedes, 'NFLX-b');
  const both = resolveAmend(v({ ...A, id: 'both-amend', supersedes: 'XLE-55c' }), rows);
  eq('supersedes wins over the instrument', both.item.supersedes, 'XLE-55c');
  eq('neither is refused', validateNote({ id: 'neither-amend', kind: 'amend', trade_date: '2026-10-02' }).ok, false);
  // The merge: levels key by key (null removes), rules replace, the rationale appended.
  const after = applyDraft(rows, rA.item, {}, { today: '2026-10-02' });
  const j = after.rows[0].journal;
  eq('confirm applies the rule change to that trade only', [after.how, after.rowId, after.rows[1] === xle], ['amended', 'BRNT-open', true]);
  eq('levels merge key by key; null removes', j.levels, { take_profit: 'T1: Brent front closes >= $108 or BRNT +20%', invalidation: 'unchanged' });
  eq('rules replace the list', j.rules, ['Crisis rule unchanged', 'Optional re-add <= $90', 'No stop']);
  ok('the rationale is appended, dated', /^Energy hedge\.\n— 2026-10-02 \(amend\): Range-aware first trim\./.test(after.rows[0].thesis));
  eq('an amend with no rules leaves the rules alone', amendRow(brnt, v({ ...A, id: 'norules', rules: undefined })).journal.rules, ['old rule']);
  eq('a decide-by on an option row is a level, the hard date moves only with hard_date', [applyDraft(rows, resolveAmend(v(B), rows).item).rows[1].journal.levels.decide_by, applyDraft(rows, resolveAmend(v(B), rows).item).rows[1].hardDate], ['2026-12-15', undefined]);

  // Through the route: resolved at ingest against the console in the store; the caller learns only
  // { id, received_at }; no inbox entry is made.
  mem.clear();
  mem.set('dvcap:console:v1', JSON.stringify({ rows }));
  const r = await call(manualEntry, { method: 'POST', query: NOTE_Q, headers: TOKEN, body: A });
  eq('the amend is accepted and echoes only id and time', [r.status, Object.keys(r.body)], [201, ['id', 'received_at']]);
  const ds = JSON.parse(mem.get(DRAFTS_KEY)).drafts;
  eq('a rule change to confirm is waiting, with no inbox entry', [ds.map(d => [d.kind, d.supersedes]), (mem.get(INBOX_KEY) || []).length], [[['amend', 'BRNT-open']], 0]);
  eq('the XLE amend lands on the option', (await call(manualEntry, { method: 'POST', query: NOTE_Q, headers: TOKEN, body: B })).status, 201);
  eq('both drafted', JSON.parse(mem.get(DRAFTS_KEY)).drafts.map(d => d.supersedes), ['BRNT-open', 'XLE-55c']);
  eq('neither supersedes nor instrument → 400', (await call(manualEntry, { method: 'POST', query: NOTE_Q, headers: TOKEN, body: { id: 'neither-2', kind: 'amend', trade_date: '2026-10-02' } })).status, 400);
  eq('counted as rule changes', draftCounts(JSON.parse(mem.get(DRAFTS_KEY)).drafts).ruleChanges, 2);
  const line = journalLine({ counts: { amends: 2 }, symbols: {} });
  ok('the channel line carries no level, rule or rationale', !/108|Crisis|Range-aware|Trim|Roll/.test(line));
}

// ── PROCESSED NOTES EXPIRE ───────────────────────────────────────────────────
{
  const list = appendProcessed([{ id: 'old', at: '2026-08-01T00:00:00Z' }], [{ id: 'new' }], { now: '2026-10-01T00:00:00Z' });
  eq('entries older than 30 days are pruned', list.map(x => x.id), ['new']);
  const src = readFileSync('lib/journalStore.js', 'utf8');
  ok('and the key itself is written with a 30-day expiry', /kvSetJsonEx\(PROCESSED_KEY, list, PROCESSED_TTL_DAYS \* 86400\)/.test(src));
}

// ── NOTHING REACHES GIT ──────────────────────────────────────────────────────
{
  for (const f of ['lib/journalInbox.js', 'lib/journalStore.js']) {
    const src = readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    ok(`${f} touches no file and no GitHub API`, !/node:fs|from 'fs'|api\.github\.com|writeFile/.test(src));
  }
  const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(f => f && !f.startsWith('test/'));
  const hits = tracked.filter(f => { try { return readFileSync(f, 'utf8').includes(SPY_NOTE.id); } catch { return false; } });
  eq('no tracked file outside the tests carries a note id', hits, []);
}

globalThis.fetch = realFetch;
// ── HONG KONG NUMERIC ROOTS (5 Oct): "981" is 0981.HK, "8" is 0008.HK ──
{
  const hk = (sym, id) => ({ id, symbol: sym, side: 'long', multiplier: 1, fills: [{ side: 'buy', qty: 1000, price: 60, date: '2026-09-10' }] });
  const rows = [hk('0981.HK', 'SMIC'), hk('0008.HK', 'PCCW')];
  const amend = (sym) => validateNote({ id: `t-amend-${sym.toLowerCase().replace(".", "-")}`, kind: 'amend', written_at: '2026-10-05T01:00:00Z', trade_date: '2026-10-05',
    instrument: { type: 'STK', symbol: sym }, tag: 'position', rationale: 'long hold, not a trading position', rules: ['excluded from the trim list'] }).note;
  eq('981 finds 0981.HK, 8 finds 0008.HK', [amendTargets(amend('981'), rows).map(r => r.id), amendTargets(amend('8'), rows).map(r => r.id)], [['SMIC'], ['PCCW']]);
  eq('the suffixed form too', amendTargets(amend('981.HK'), rows).map(r => r.id), ['SMIC']);
  eq('and 98 is not 981', amendTargets(amend('98'), rows).length, 0);
  // The two notes that arrived before the fix: unfilled drafts, retried on the next run.
  const stale = [{ id: 'n-x', kind: 'unfilled', reason: 'amend: no open trade for 981', note: { ...amend('981'), kind: 'amend' } }];
  const r = retryAmends(stale, rows);
  eq('a stale no-target amend is retried and becomes a rule change', [r.changed, r.drafts[0].kind, r.drafts[0].supersedes], [1, 'amend', 'SMIC']);
  eq('one that still finds nothing is left as it was', retryAmends(stale, []).drafts[0], stale[0]);
  eq('the fill side agrees: 0981 and 981 are one product', productRoot('0981.HK'), productRoot('981'));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
