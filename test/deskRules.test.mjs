// test/deskRules.test.mjs — the Position Desk's rules on the close (lib/deskRules.js), the same-day
// summary (lib/sameDayFills.js todayNet) and the job health states (lib/cronRouter.js). Fake tickers.
import { normalizeMirror, evaluateRule, runChecks, newHits, deskAlertCard, checksView, periodEnds, directionOf } from '../lib/deskRules.js';
import { todayNet, legKeyOf } from '../lib/sameDayFills.js';
import { attachToday, bookView, bookRpc } from '../lib/bookMcp.js';
import { JOBS, prevSlot, healthOf, statusView, healthSummary, failureCard } from '../lib/cronRouter.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// ── THE MIRROR ───────────────────────────────────────────────────────────────
{
  const n = normalizeMirror({ positions: [
    { deskId: 'zzq', dvcapId: 'zzq-1', name: 'ZZQ Dec spread', group: 'trade', thesis: 'private', pnl: 123,
      rules: [{ id: 'r1', kind: 'stop', text: 'Stop: close below 50', level: '50', symbol: 'nasdaq:zzq', cond: 'close_below', alert: { alertId: 'x' } },
              { id: 'r2', kind: 'nonsense', level: 'abc', symbol: 'not a symbol', cond: 'whenever' }] },
    { deskId: 'old', group: 'closed', rules: [{ id: 'r1', kind: 'stop', level: 1 }] },
  ] }, { now: 'T' });
  eq('only the named fields are kept', Object.keys(n.mirror.positions[0]).sort(), ['deskId', 'dvcapId', 'group', 'name', 'rules', 'side']);
  eq('a rule is cleaned field by field', n.mirror.positions[0].rules[0], { id: 'r1', kind: 'stop', text: 'Stop: close below 50', level: 50, symbol: 'NASDAQ:ZZQ', cond: 'close_below', cadence: 'daily', source: 'stu' });
  eq('junk becomes nulls, never a guess', [n.mirror.positions[0].rules[1].kind, n.mirror.positions[0].rules[1].level, n.mirror.positions[0].rules[1].symbol, n.mirror.positions[0].rules[1].cond], ['review', null, null, null]);
  eq('closed positions are dropped', n.mirror.positions.length, 1);
  eq('a position without a deskId is refused', normalizeMirror({ positions: [{ rules: [] }] }).error, 'every position needs a deskId');
  eq('positions must be a list', normalizeMirror({}).error, 'positions must be an array');
}

// ── ONE RULE ─────────────────────────────────────────────────────────────────
{
  const q = { close: 49, atr: 2 };
  eq('below the stop: hit, with the number that matters', evaluateRule({ level: 50, symbol: 'X:ZZQ', cond: 'close_below' }, { quote: q }), { state: 'hit', price: 49, note: 'close 49, 1 below 50' });
  eq('within half an ATR: near', evaluateRule({ level: 48.5, symbol: 'X:ZZQ', cond: 'close_below' }, { quote: q }).state, 'near');
  eq('further: ok', evaluateRule({ level: 45, symbol: 'X:ZZQ', cond: 'close_below' }, { quote: q }).state, 'ok');
  eq('a take-profit on the spread\'s value, near within 10%', evaluateRule({ level: 11.25, cond: 'close_above' }, { mark: 10.97 }), { state: 'near', price: 10.97, note: 'value 10.97, 0.28 below 11.25' });
  eq('a date rule is due on the day', evaluateRule({ cond: 'date 2026-11-06' }, { today: '2026-11-06' }).state, 'due');
  eq('and counts down before it', evaluateRule({ cond: 'date 2026-11-09' }, { today: '2026-11-06' }).note, '3 days to Mon 9 Nov');
  eq('a weekly rule waits for the week\'s close', evaluateRule({ level: 50, symbol: 'X:ZZQ', cond: 'weekly_close_below' }, { quote: q, isWeekEnd: false }).state, 'skip');
  eq('and is judged on it', evaluateRule({ level: 50, symbol: 'X:ZZQ', cond: 'weekly_close_below' }, { quote: q, isWeekEnd: true }).state, 'hit');
  eq('no condition on a long stop: below', directionOf({ kind: 'stop' }, 'long'), 'below');
  eq('and on a short: above', directionOf({ kind: 'stop' }, 'short'), 'above');
  eq('an add with no condition is not guessed', evaluateRule({ kind: 'add', level: 50, symbol: 'X:ZZQ' }, { quote: q, side: 'long' }).state, 'unchecked');
  eq('no close came back: unchecked, and says why', evaluateRule({ level: 50, symbol: 'X:ZZQ', cond: 'close_below' }, {}).note, 'no close for X:ZZQ');
}

// ── THE CLOSE ────────────────────────────────────────────────────────────────
{
  const mirror = normalizeMirror({ positions: [{ deskId: 'zzq', dvcapId: 'zzq-1', name: 'ZZQ', rules: [
    { id: 's', kind: 'stop', text: 'close below 50', level: 50, symbol: 'X:ZZQ', cond: 'close_below' },
    { id: 't', kind: 'tp', text: 'spread 11.25', level: 11.25, cond: 'close_above' },
    { id: 'd', kind: 'stop', text: 'draft stop', level: 60, symbol: 'X:ZZQ', cond: 'close_below', source: 'draft' }] }] }).mirror;
  const day1 = runChecks(mirror, { quotes: { 'X:ZZQ': { close: 52, atr: 2 } }, marks: { 'zzq-1': { mark: 10.97 } }, today: '2026-11-05', now: 'A' });
  eq('day one: stop ok, take-profit near, draft hit', day1.positions[0].rules.map(r => r.state), ['ok', 'near', 'hit']);
  const day2 = runChecks(mirror, { quotes: { 'X:ZZQ': { close: 49, atr: 2 } }, marks: { 'zzq-1': { mark: 11.4 } }, today: '2026-11-06', prev: day1, now: 'B' });
  const nh = newHits(day1, day2);
  eq('day two: Stu\'s stop and take-profit are news, the draft is not', nh.fresh.map(x => x.rule.id), ['s', 't']);
  const again = newHits(day2, runChecks(mirror, { quotes: { 'X:ZZQ': { close: 48, atr: 2 } }, marks: { 'zzq-1': { mark: 11.5 } }, today: '2026-11-09', prev: day2 }));
  eq('still hit the next day: not news again', again.fresh.length, 0);
  const card = deskAlertCard(nh, { today: '2026-11-06', now: 'T' }).embeds[0];
  eq('a card: title, counts, red for a hit', [card.title, card.description, card.color], ['Desk rules at the close · Fri 6 Nov', '2 hit', 0xe74c3c]);
  ok('a field per rule: position, rule and the number', card.fields[0].name === '🔴 ZZQ' && /Stop · close below 50/.test(card.fields[0].value) && /close 49/.test(card.fields[0].value));
  eq('nothing new: no card', deskAlertCard({ fresh: [], near: [{}] }), null);
  ok('no mentions', JSON.stringify(deskAlertCard(nh, { today: '2026-11-06' }).allowed_mentions) === '{"parse":[]}');
  eq('counts for the log', day2.counts, { hit: 3, due: 0, near: 0, ok: 0, unchecked: 0 });
  const v = checksView(day2);
  eq('the connector carries states, not the rule text', Object.keys(v.positions[0].rules[0]).sort(), ['checkedAt', 'id', 'note', 'price', 'state']);
  eq('Friday 6 Nov 2026 ends the week, not the month', periodEnds('2026-11-06'), { isWeekEnd: true, isMonthEnd: false });
  eq('Wednesday 25 Nov ends neither (Thanksgiving is a holiday, Friday trades)', periodEnds('2026-11-25', ['2026-11-26']), { isWeekEnd: false, isMonthEnd: false });
  eq('Monday 30 Nov ends the month', periodEnds('2026-11-30').isMonthEnd, true);
}

// ── TODAY'S FILLS ────────────────────────────────────────────────────────────
{
  const t = (o) => ({ date: '2026-11-06', qty: 1, side: 'buy', tradeId: Math.random().toString(36), ...o });
  const trades = [
    t({ root: 'ZZD', symbol: 'ZZD 261218C00450000', right: 'C', strike: 450, expiry: '2026-12-18', qty: 4 }),
    t({ root: 'ZZD', symbol: 'ZZD 261218C00450000', right: 'C', strike: 450, expiry: '2026-12-18', qty: 4, side: 'sell' }),
    t({ root: 'ZZD', symbol: 'ZZD 261218C00460000', right: 'C', strike: 460, expiry: '2026-12-18', qty: 4, side: 'sell' }),
    t({ root: 'ZZD', symbol: 'ZZD 261218C00460000', right: 'C', strike: 460, expiry: '2026-12-18', qty: 4 }),
    t({ root: 'ZZM', symbol: 'ZZMZ6', assetCategory: 'FUT', side: 'sell' }),
    t({ root: 'ZZB', symbol: 'ZZB', tradeId: 'known-1' }),
    t({ root: 'USFR', symbol: 'USFR', qty: 100 }),
    t({ root: 'ZZY', symbol: 'ZZY', date: '2026-11-05' }),
  ];
  const items = todayNet(trades, { known: new Set(['known-1']), today: '2026-11-06', isCash: (s) => s === 'USFR' });
  eq('per contract, today only, booked and cash left out', items.map(i => [i.key, i.bought, i.sold, i.net]),
     [['ZZD|2026-12-18|C|450', 4, 4, 0], ['ZZD|2026-12-18|C|460', 4, 4, 0], ['ZZM', 0, 1, -1]]);
  ok('no prices or order ids in the summary', !JSON.stringify(items).match(/price|tradeId|orderId/));
  eq('leg keys match the book\'s', legKeyOf({ root: 'zzd', right: 'C', strike: '450', expiry: '2026-12-18' }), 'ZZD|2026-12-18|C|450');
  const positions = [
    { id: 'a', symbol: 'ZZD', side: 'long', legs: [{ right: 'C', strike: 460, expiry: '2026-12-18', side: 'short' }, { right: 'C', strike: 450, expiry: '2026-12-18', side: 'long' }] },
    { id: 'b', symbol: 'ZZP', side: 'long', legs: [] },
  ];
  const sd = attachToday(positions, { date: '2026-11-06', at: 'X', items }, '2026-11-06T18:00:00Z');
  eq('bought and sold the same day: change 0, read from the held-long leg', positions[0].today, { bought: 4, sold: 4, change: 0, contracts: 2 });
  eq('a fill with no position is unbooked', sd.unbooked.map(u => [u.symbol, u.instrument, u.net]), [['ZZM', 'future', -1]]);
  eq('yesterday\'s summary is ignored', attachToday([], { date: '2026-11-05', items }, '2026-11-06T18:00:00Z'), null);
  const credit = [{ id: 'c', symbol: 'ZZE', side: 'short', legs: [{ right: 'P', strike: 90, expiry: '2026-12-18', side: 'short' }] }];
  attachToday(credit, { date: '2026-11-06', items: todayNet([t({ root: 'ZZE', right: 'P', strike: 90, expiry: '2026-12-18', qty: 2, side: 'sell' })], { today: '2026-11-06' }) }, '2026-11-06T18:00:00Z');
  eq('a short put sold more today: the position grew by 2', credit[0].today.change, 2);
}

// ── THROUGH THE CONNECTOR ────────────────────────────────────────────────────
{
  let stored = null;
  const put = await bookRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'put_desk_rules', arguments: { positions: [{ deskId: 'zzq', rules: [{ id: 'r', kind: 'stop', level: 1 }] }] } } },
    { snapshot: async () => [], putRules: async (m) => { stored = m; return { ok: true }; } });
  eq('put_desk_rules stores the cleaned mirror', [JSON.parse(put.result.content[0].text).rules, stored.positions[0].deskId], [1, 'zzq']);
  const bad = await bookRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'put_desk_rules', arguments: { positions: 'all' } } }, { snapshot: async () => [], putRules: async () => ({ ok: true }) });
  ok('a malformed list is refused', bad.result.isError);
  const v = bookView([], { asOf: '2026-11-06T18:00:00Z', sameDay: { date: '2026-11-06', at: 'X', items: [] }, checks: { at: 'Y', positions: [] } });
  eq('get_positions carries the same-day block and the checks', [!!v.sameDay, v.deskChecks.at], [true, 'Y']);
}

// ── JOB HEALTH ───────────────────────────────────────────────────────────────
{
  const job = JOBS.find(j => j.id === 'desk-rules');
  const t = Date.parse('2026-11-06T21:40:00Z');          // 16:40 New York, Friday
  eq('the 16:20 slot is the one that should have run', prevSlot(job, t), '2026-11-06T21:20:00.000Z');
  eq('it ran and said ok: ok', healthOf(job, { slot: '2026-11-06T21:20:00.000Z', ok: true }, t), 'ok');
  eq('it ran and failed: failed', healthOf(job, { slot: '2026-11-06T21:20:00.000Z', ok: false }, t), 'failed');
  eq('the last run was yesterday\'s: missed', healthOf(job, { slot: '2026-11-05T21:20:00.000Z', ok: true }, t), 'missed');
  eq('inside the catch-up window it is not missed yet', healthOf(job, { slot: '2026-11-05T21:20:00.000Z', ok: true }, Date.parse('2026-11-06T21:25:00Z')), 'ok');
  eq('nothing recorded: waiting', healthOf(job, null, t), 'waiting');
  const v = statusView({ 'desk-rules': { slot: '2026-11-06T21:20:00.000Z', ok: false } }, t);
  eq('the summary counts it', healthSummary(v).failed, 1);
  eq('the same-day book runs every 30 min through the session', v.find(x => x.id === 'same-day-book').at, '09:45–16:45 every 30 min');
  const ft = failureCard({ id: 'desk-rules', slot: '2026-11-06T21:20:00.000Z', status: 500, note: 'boom' }).embeds[0];
  eq('a failure card names the job, the reason, the run and the answer', [ft.title, ft.description, ft.fields.map(f => f.value)], ['⚠️ Desk rules at the close failed', 'boom', ['01:20 Dubai (16:20 ET)', 'HTTP 500']]);
  eq('no answer: the timeout note, and the answer says none', (({ description, fields }) => [description, fields[1].value])(failureCard({ id: 'gex-recompute', slot: '2026-11-06T12:15:00.000Z', status: null, note: 'no answer within 240s' }).embeds[0]), ['no answer within 240s', 'none']);
  const dc = deskAlertCard({ fresh: [{ name: 'ZZQ', rule: { kind: 'stop', state: 'hit', text: 't', note: 'n' } }, { name: 'ZZR', rule: { kind: 'review', state: 'due', text: 't', note: 'n' } }], near: [] }, { today: '2026-11-06' }).embeds[0];
  eq('the headline splits hit from due; only due rules go amber', [dc.description, deskAlertCard({ fresh: [{ name: 'ZZR', rule: { kind: 'review', state: 'due' } }], near: [] }).embeds[0].color], ['1 hit · 1 due', 0xf1c40f]);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
