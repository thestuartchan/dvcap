// test/dayTradeRegime.test.mjs — day trades by gamma regime (lib/dayTradeRegime.js). SYNTHETIC
// fixtures only: made-up contracts, prices and dates; no account data. Nothing touches the network.
import { roundTrips, inScope, classify, captureBefore, dayContext, fadeOrBreak, directionOf, stats, analyse, smTercile, dataFlags, isOpex, nyIso, bucketOf } from '../lib/dayTradeRegime.js';
import { parseCboeCsv, parseDix, prevOf } from '../lib/dayTradeRegimeData.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

// A fill in lib/flexTrades.js parseTrades' shape.
let oid = 1;
const opt = (root, right, strike, expiry, side, qty, px, time, extra = {}) => ({ tradeId: `${oid++}:c`, conid: `${root}${right}${strike}${expiry}`, root, assetCategory: 'OPT', symbol: `${root} x`,
  right, strike, expiry, side, qty, rawPrice: px, price: px, commission: 1, multiplier: 100, date: time.slice(0, 4) + '-' + time.slice(4, 6) + '-' + time.slice(6, 8), time, openClose: side === 'buy' ? 'O' : 'C', ...extra });
const fut = (root, side, qty, px, time) => ({ tradeId: `${oid++}:f`, conid: `${root}Z6`, root, assetCategory: 'FUT', side, qty, rawPrice: px, price: px, commission: 0.62, multiplier: 5,
  date: time.slice(0, 4) + '-' + time.slice(4, 6) + '-' + time.slice(6, 8), time, openClose: '' });

// ── ROUND TRIPS ──
{
  const rts = roundTrips([
    opt('QQQ', 'C', 700, '2026-09-15', 'buy', 2, 1.00, '20260915;100000'),
    opt('QQQ', 'C', 700, '2026-09-15', 'sell', 1, 1.50, '20260915;103000', { openClose: 'C' }),
    opt('QQQ', 'C', 700, '2026-09-15', 'sell', 1, 2.00, '20260915;110000', { openClose: 'C' }),
  ]);
  eq('scaled out: one round trip, P&L from IBKR prices net of commission', [rts.length, rts[0].qty, rts[0].pnl, rts[0].entryDate, rts[0].entryMin], [1, 2, (1.5 + 2 - 2) * 100 - 3, '2026-09-15', 600]);
  const exp = roundTrips([opt('SPY', 'P', 650, '2026-09-16', 'buy', 3, 0.40, '20260916;140000')], { lastDate: '2026-09-30' });
  eq('held into expiry: closed at 0 on the expiry date', [exp.length, exp[0].expired, exp[0].pnl, exp[0].exitDate], [1, true, -120 - 1, '2026-09-16']);
  eq('still open, data ends before expiry: not a round trip yet', roundTrips([opt('SPY', 'P', 650, '2026-12-18', 'buy', 1, 5, '20260916;140000')], { lastDate: '2026-09-30' }).length, 0);
  eq('a closing fill with nothing open began before the window: left out', roundTrips([opt('QQQ', 'P', 690, '2026-09-17', 'sell', 1, 2, '20260917;100000', { openClose: 'C' })]).length, 0);
  const mes = roundTrips([fut('MES', 'buy', 2, 6600, '20260915;100000'), fut('MES', 'sell', 2, 6610, '20260915;113000')]);
  eq('a same-day futures round trip: points × multiplier, net of commission', [mes.length, mes[0].pnl, inScope(mes[0])], [1, +(10 * 2 * 5 - 1.24).toFixed(2), true]);
  const sp = roundTrips([opt('SPY', 'P', 640, '2026-09-18', 'sell', 1, 1.2, '20260918;100000', { openClose: 'O' }), opt('SPY', 'P', 640, '2026-09-18', 'buy', 1, 0.2, '20260918;150000', { openClose: 'C' })]);
  eq('a short put: short side, up direction, credit kept', [sp[0].side, directionOf(sp[0]), sp[0].pnl], ['short', 1, 100 - 2]);
}
// ── SCOPE ──
{
  const r = (o) => ({ assetCategory: 'OPT', root: 'QQQ', entryDate: '2026-09-15', exitDate: '2026-09-15', expiry: '2026-09-15', ...o });
  eq('0DTE and 1DTE QQQ/SPY options are in; a weekly is not; another name is not',
    [inScope(r({})), inScope(r({ expiry: '2026-09-16' })), inScope(r({ expiry: '2026-09-18' })), inScope(r({ root: 'AAPL' }))], [true, true, false, false]);
  eq('1DTE over a weekend counts trading days', inScope(r({ entryDate: '2026-09-18', expiry: '2026-09-21' })), true);
  eq('futures: same-day round trips only', [inScope({ assetCategory: 'FUT', root: 'MES', entryDate: '2026-09-15', exitDate: '2026-09-15' }), inScope({ assetCategory: 'FUT', root: 'MNQ', entryDate: '2026-09-15', exitDate: '2026-09-16' })], [true, false]);
}
// ── LABELS ──
{
  const cap = { asOf: '2026-09-15T02:50:00Z', flipLevel: 700, flipZoneLo: 690, flipZoneHi: 700, flipFragile: false, pin_lo: 705, pin_hi: 710, callWall: 715, trapdoor_near: 695 };
  eq('the skill\'s rule: >1% above the zone top is positive; below the bottom negative; between undecided',
    [classify(707.1, cap), classify(706.9, cap), classify(689, cap), classify(695, cap)], ['positive', 'undecided', 'negative', 'undecided']);
  eq('a fragile flip is undecided; data before the open turns positive to undecided, not negative',
    [classify(720, { ...cap, flipFragile: true }), classify(720, cap, { dataBeforeOpen: true }), classify(680, cap, { dataBeforeOpen: true })], ['undecided', 'undecided', 'negative']);
  eq('the capture used is the latest before the call', captureBefore([{ asOf: '2026-09-14T20:30:00Z', id: 1 }, cap, { asOf: '2026-09-15T20:30:00Z', id: 3 }], '2026-09-15T13:30:00Z').asOf, cap.asOf);
  eq('9:30 New York in UTC follows DST', [nyIso('2026-09-15', 570), nyIso('2026-12-15', 570)], ['2026-09-15T13:30:00.000Z', '2026-12-15T14:30:00.000Z']);
  eq('GEX terciles at the skill\'s cut-offs', [smTercile(5e9), smTercile(6e9), smTercile(8e9), smTercile(null)], ['low', 'mid', 'high', 'unknown']);
  const cal = [{ date: '2026-09-11', title: 'CPI (Aug)', region: 'US', time: '08:30' }, { date: '2026-09-11', title: 'FOMC minutes', region: 'US', time: '14:00' }, { date: '2026-09-16', title: 'FOMC rate decision', region: 'US', time: '14:00' }];
  eq('data days: CPI before the open; minutes are not a data day; FOMC after the open', [dataFlags('2026-09-11', cal).dataBeforeOpen, dataFlags('2026-09-11', cal).data, dataFlags('2026-09-16', cal).dataBeforeOpen], [true, ['CPI (Aug)'], false]);
  eq('opex is the third Friday', [isOpex('2026-09-18'), isOpex('2026-09-11')], [true, false]);
  const m = { bars: { QQQ: { '2026-09-15': { o: 708, h: 712, l: 700, c: 710, prevClose: 704, firstHour: { h: 711, l: 703 } } } },
    fut: { QQQ: { '2026-09-15': { at04: 25250, prevClose: 25000 } } }, vol: { QQQ: { '2026-09-15': 20 } }, gex: { '2026-09-15': 4e9 }, captures: { QQQ: [cap] }, calendar: [], calendarFrom: '2026-07-01' };
  const c = dayContext('QQQ', '2026-09-15', m);
  eq('the early call uses the futures-implied open (prev close × futures move)', [c.impliedOpen, c.earlyLabel, c.openLabel], [711.04, 'positive', 'positive']);
  eq('range against the implied 1σ, and the first-hour tell', [+(c.rangeRatio).toFixed(2), c.firstHourTell], [+(12 / (704 * 0.2 / Math.sqrt(252))).toFixed(2), true]);
  eq('fade or break, with a pin box', [fadeOrBreak(1, 702, cap), fadeOrBreak(-1, 702, cap), fadeOrBreak(-1, 712, cap), fadeOrBreak(1, 712, cap), fadeOrBreak(1, 706, cap), fadeOrBreak(-1, 706, cap)],
    ['fade', 'break', 'fade', 'break', 'fade', 'break']);
  eq('… without a pin box, the trapdoor-to-wall band; no capture: unclassified', [fadeOrBreak(-1, 720, { ...cap, pin_lo: null, pin_hi: null }), fadeOrBreak(1, 700, null)], ['fade', 'unclassified']);
  eq('30-minute buckets', [bucketOf(570), bucketOf(615), bucketOf(null)], ['09:30', '10:00', 'unknown']);
}
// ── SOURCES ──
eq('Cboe history CSV → date: close', parseCboeCsv('DATE,OPEN,HIGH,LOW,CLOSE\n09/14/2026,1,2,0.5,18.5\n'), { '2026-09-14': 18.5 });
eq('DIX.csv → date: gex, and the value at the previous close', prevOf(parseDix('date,price,dix,gex\n2026-09-14,1,0.4,6000000000\n2026-09-15,1,0.4,8000000000\n'), ['2026-09-15']), { '2026-09-15': 6e9 });

// ── THE WHOLE ANALYSIS, AND THE BAR ──
const days = Array.from({ length: 30 }, (_, i) => { const d = new Date(Date.UTC(2026, 8, 1)); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); })
  .filter(d => [1, 2, 3, 4, 5].includes(new Date(`${d}T00:00:00Z`).getUTCDay())).slice(0, 20);
function scenario(posLoss) {
  const trades = [], caps = [], bars = {}, fut = {};
  days.forEach((d, i) => {
    const positive = i % 2 === 0;
    caps.push({ date: d, asOf: `${d}T02:50:00Z`, flipLevel: 700, flipZoneLo: 690, flipZoneHi: 700, flipFragile: false, pin_lo: 705, pin_hi: 710, callWall: 715, trapdoor_near: 695 });
    bars[d] = { o: positive ? 712 : 685, h: 720, l: 680, c: 700, prevClose: positive ? 712 : 685, firstHour: { h: 705, l: 700 } };
    fut[d] = { at04: 1, prevClose: 1 };
    const t = d.replace(/-/g, '');
    const px = positive ? (posLoss ? 0.5 + (i % 3) * 0.05 : (i % 4 === 0 ? 2.0 : 0.6)) : 1.6;
    trades.push(opt('QQQ', 'C', 705, d, 'buy', 1, 1.0, `${t};100000`), opt('QQQ', 'C', 705, d, 'sell', 1, px, `${t};110000`, { openClose: 'C' }));
  });
  return { trades, m: { bars: { QQQ: bars }, fut: { QQQ: fut }, vol: { QQQ: Object.fromEntries(days.map(d => [d, 20])) }, gex: Object.fromEntries(days.map((d, i) => [d, i % 2 === 0 ? 9e9 : 4e9])),
    captures: { QQQ: caps }, calendar: [], calendarFrom: '2026-07-01' } };
}
{
  const { trades, m } = scenario(true);
  const { result, trades: rows } = analyse(trades, m, { lastDate: '2026-12-31' });
  eq('every synthetic round trip is in scope and labelled', [result.window.inScope, result.byOpen.positive.n, result.byOpen.negative.n], [20, 10, 10]);
  eq('positive days that lose every time: sitting them out meets the bar under both labels', [result.verdict.summary, result.verdict.sitOutPositiveEarly.adopt, result.verdict.sitOutPositiveOpen.adopt], ['evidence for a sit-out rule', true, true]);
  eq('the simulation counts what was kept, avoided and lost', [result.sitOut.openPositive.tradesLost, result.sitOut.openPositive.avoided > 0, result.sitOut.openPositive.kept.n], [10, true, 10]);
  eq('fade/break is classified from the underlying at entry when it is known', rows.every(r => r.setup === 'unclassified'), true);
}
{
  const { trades, m } = scenario(false);
  const { result } = analyse(trades, m, { lastDate: '2026-12-31' });
  eq('positive days that are mixed: no evidence', [result.verdict.summary, result.verdict.sitOutPositiveOpen.adopt], ['no evidence', false]);
}
eq('stats: totals, win days, the top-3 share and an interval by day', (() => { const s = stats([{ pnl: 100, entryDate: 'a' }, { pnl: -50, entryDate: 'b' }, { pnl: 30, entryDate: 'c' }]); return [s.n, s.total, s.winDays, s.top3Share, s.ciDay.length]; })(), [3, 80, 0.667, 1, 2]);

// ── THE ROUTE: the console's session only ──
process.env.TRADECARD_KEY = 'svc-0123456789';
process.env.JOURNAL_INBOX_TOKEN = 'jt-0123456789';
process.env.DASHBOARD_PASSWORD = 'session-secret-for-tests';
const { default: handler } = await import('../api/flex-sync.js');
const call = async (headers = {}, method = 'GET') => { const o = { code: 0 }; const res = { status(c) { o.code = c; return res; }, json() { return res; }, setHeader() {} };
  await handler({ method, query: { regimepnl: '1' }, headers: { host: 'x', ...headers } }, res); return o.code; };
eq('the analysis refuses no session, the journal token and the cron\'s service key', [await call(), await call({ 'x-tradecard-key': 'jt-0123456789' }), await call({ 'x-tradecard-key': 'svc-0123456789' })], [401, 401, 401]);

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
