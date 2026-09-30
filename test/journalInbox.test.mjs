// test/journalInbox.test.mjs — notes written from chat, matched to the fills IBKR reports.
//
// The brief's acceptance table, case by case, against the real route handler and a Redis stand-in:
// what a note may do (append one, count them), what it may never do (read, edit, pass any other
// gate), how it meets its fill, and that nothing a note says reaches the channel or the repo.
import { validateNote, orderUnits, matchNote, processInbox, applyDraft, journalLine, draftCounts, expectationText,
         tradingDaysBetween, chooseCandidate, appendProcessed, INBOX_KEY, DRAFTS_KEY } from '../lib/journalInbox.js';
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
  eq('counted as one without a fill', draftCounts(on7.drafts), { toConfirm: 0, unjournaled: 0, withoutFills: 1 });
}

// ── CASE 4: a fill with no note ──────────────────────────────────────────────
{
  const out = processInbox({ notes: [], trades: trades(ZERO_DTE), today: TODAY, holidays: US });
  const d = out.drafts[0];
  eq('an unjournaled-fill draft', [d.kind, d.source, d.note], ['fill', 'unjournaled', null]);
  eq('counted as unjournaled', draftCounts(out.drafts).unjournaled, 1);
  const again = processInbox({ notes: [], trades: trades(ZERO_DTE), today: TODAY, holidays: US, seen: out.seen, drafts: [] });
  eq('dismissed once, it is not offered again from the same 30-day window', again.drafts.length, 0);
  const before = processInbox({ notes: [], trades: trades(ZERO_DTE.replace('tradeDate="20260930"', 'tradeDate="20260929"')), today: TODAY, holidays: US });
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
  const out = processInbox({ notes: [validateNote(SPY_NOTE).note, validateNote({ ...NFLX_NOTE, trade_date: '2026-09-22' }).note], trades: trades(SPY_LEGS('900'), ZERO_DTE), today: TODAY, holidays: US });
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
  eq('an invalid note → 422', (await call(manualEntry, { method: 'POST', query: NOTE_Q, headers: TOKEN, body: { ...SPY_NOTE, id: 'x2-note', kind: 'buy' } })).status, 422);
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
  const res = await resolveDraft({ id: 'd-900', action: 'confirm' });
  eq('confirm takes the draft off the list', [res.ok, res.drafts.length], [true, 0]);
  eq('and records the outcome', JSON.parse(mem.get('dvcap:journal:processed:v1')).map(p => p.outcome), ['drafted', 'confirmed']);
  eq('resolving it again says it is gone', (await resolveDraft({ id: 'd-900', action: 'dismiss' })).ok, false);
  const again = await call(manualEntry, { method: 'POST', query: NOTE_Q, headers: TOKEN, body: SPY_NOTE });
  eq('a processed id cannot be re-posted', again.status, 409);
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
console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
