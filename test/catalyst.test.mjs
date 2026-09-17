// test/catalyst.test.mjs — the catalyst window: does the thing the trade depends on happen before
// the contract dies? Information only; amber is the ceiling. The acceptance table from the brief.
import { catalystWindow, instrumentKind, earningsNameFor, readAcrossFor, monthlyOpex, tradingDaysBetween, TAIL_DAYS, TIGHT_TRADING_DAYS } from '../lib/catalyst.js';
import { parseNasdaqEarnings, parseUsDate } from '../lib/earnings.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

const MACRO = [
  { date: '2026-09-16', title: 'FOMC decision + dot plot (SEP)', tier: 1 },
  { date: '2026-09-17', title: 'US Initial Jobless Claims (weekly)', tier: 2 },
  { date: '2026-10-28', title: 'FOMC decision', tier: 1 },
  ...monthlyOpex('2026-09-11', '2026-12-31'),
];
const FEED = (symbol, date, status = 'confirmed') => ({ ok: true, symbol, date, status, time: null, source: 'Nasdaq (Zacks)', fetchedAt: '2026-09-11T12:00:00Z' });
const NONE = (symbol) => ({ ok: false, symbol, date: null, status: 'unavailable', source: 'Nasdaq (Zacks)', fetchedAt: '2026-09-11T12:00:00Z', why: 'the vendor has not published a date' });

// ── INSTRUMENTS ──────────────────────────────────────────────────────────────
{
  eq('a broad ETF has no earnings to look up', [instrumentKind('QQQ'), earningsNameFor('QQQ')], ['etf', null]);
  eq('a sector ETF likewise', [instrumentKind('XLE'), earningsNameFor('XLE')], ['etf', null]);
  eq('a cash ETF likewise', earningsNameFor('USFR'), null);
  eq('a single-name wrapper looks up its underlying', [instrumentKind('AAPU'), earningsNameFor('AAPU')], ['single-name-etf', 'AAPL']);
  eq('a single name looks up itself', earningsNameFor('intc'), 'INTC');
  eq('a foreign code is not looked up on a US feed', [instrumentKind('7709.HK'), instrumentKind('000660.KS'), earningsNameFor('7709')], ['foreign', 'foreign', null]);
  eq('an index or future is macro only', [instrumentKind('^VIX'), instrumentKind('CL=F')], ['index', 'index']);
}

// ── THE READ-ACROSS MAP: KEY IS THE NAME WHOSE EARNINGS MATTER ───────────────
{
  const map = { _README: 'x', MU: ['000660.KS', '7709.HK'], NVDA: ['AVGO', 'ARM', 'AAPU'] };
  eq('7709 is mapped to MU', readAcrossFor('7709.HK', map), ['MU']);
  eq('and so is the bare code', readAcrossFor('7709', map), ['MU']);
  eq('AVGO is mapped to NVDA', readAcrossFor('avgo', map), ['NVDA']);
  eq('a name in no list has no read-across', readAcrossFor('INTC', map), []);
  eq('the README key is not a name', readAcrossFor('x', map), []);
}

// ── OPEX AND TRADING DAYS ────────────────────────────────────────────────────
{
  eq('the third Fridays in the window', monthlyOpex('2026-09-11', '2026-11-30').map(e => e.date), ['2026-09-18', '2026-10-16', '2026-11-20']);
  eq('trading days between, weekends out', tradingDaysBetween('2026-09-11', '2026-09-18'), 4);
  eq('and holidays out', tradingDaysBetween('2026-09-04', '2026-09-11', ['2026-09-07']), 3);
  eq('nothing between adjacent days', tradingDaysBetween('2026-09-11', '2026-09-12'), 0);
}

// ── THE ACCEPTANCE TABLE ─────────────────────────────────────────────────────
{
  // INTC Oct02'26 115C, entered 11 Sep 2026: MISMATCH, earnings 21 Oct, +19 days; inside: 16 Sep FOMC, 18 Sep opex.
  const w = catalystWindow({ symbol: 'INTC', kind: 'option', expiry: '2026-10-02', today: '2026-09-11', macro: MACRO, own: FEED('INTC', '2026-10-21') });
  eq('INTC Oct02 115C is a MISMATCH', [w.class, w.flag], ['MISMATCH', 'amber']);
  eq('with the gap in days', w.gapDays, 19);
  eq('the window runs to expiry plus the tail', w.window, { from: '2026-09-11', to: '2026-10-16' });
  eq('inside: FOMC and opex, not the weekly claims', w.inside.map(e => `${e.date} ${e.title}`), ['2026-09-16 FOMC decision + dot plot (SEP)', '2026-09-18 Monthly opex']);
  eq('after: the tail opex, then the earnings beyond the tail', w.after.map(e => `${e.date} ${e.title}`), ['2026-10-16 Monthly opex', '2026-10-21 INTC earnings']);
  ok('the after line carries +19 days and the status', /Oct 21 {2}INTC earnings {2}confirmed {2}\+19 days/.test(w.lines.find(l => l.where === 'after' && l.kind === 'earnings').text));
  ok('the why says the catalyst lands after expiry', /own catalyst lands after expiry/.test(w.why));
  eq('the log form carries what the decision log wants', [w.log.catalyst_class, w.log.own_earnings_date, w.log.earnings_status, w.log.gap_days, w.log.inside_events.length, w.log.feed_source], ['MISMATCH', '2026-10-21', 'confirmed', 19, 2, 'Nasdaq (Zacks)']);
  eq(`TAIL_DAYS is ${TAIL_DAYS}`, TAIL_DAYS, 14);
}
{
  // IRM Oct16'26 120C: earnings 4 Nov — beyond the tail. Still MISMATCH, by the "no own earnings inside the life" rule.
  const w = catalystWindow({ symbol: 'IRM', kind: 'option', expiry: '2026-10-16', today: '2026-09-11', macro: MACRO, own: FEED('IRM', '2026-11-04', 'estimated') });
  eq('IRM Oct16 120C is a MISMATCH with the earnings beyond the tail', [w.class, w.gapDays], ['MISMATCH', 19]);
  ok('and the why says no own earnings inside the life of the contract', /no own earnings inside the life of the contract/.test(w.why));
  eq('an estimated date is carried as estimated', w.log.earnings_status, 'estimated');
}
{
  const w = catalystWindow({ symbol: 'QQQ', kind: 'option', expiry: '2026-10-16', today: '2026-09-11', macro: MACRO, own: null });
  eq('QQQ Oct16 730C is MACRO ONLY — no lookup, no flag', [w.class, w.flag, w.name], ['MACRO ONLY', 'neutral', null]);
  eq('with the macro events inside', w.inside.map(e => e.date), ['2026-09-16', '2026-09-18', '2026-10-16']);
  const x = catalystWindow({ symbol: 'XLE', kind: 'option', expiry: '2027-01-15', today: '2026-09-11', macro: MACRO, own: null });
  eq('XLE Jan15 55C likewise', [x.class, x.flag], ['MACRO ONLY', 'neutral']);
}
{
  // MU mapped → 7709.HK; any 7709 entry spanning 30 Sep shows MU earnings as read-across.
  const w = catalystWindow({ symbol: '7709.HK', kind: 'option', expiry: '2026-10-16', today: '2026-09-11', macro: MACRO, own: null,
                             readAcross: [{ key: 'MU', ...FEED('MU', '2026-09-30') }] });
  ok('MU earnings show inside as read-across', w.inside.some(e => e.kind === 'read-across' && e.title === 'MU earnings' && e.date === '2026-09-30'));
  ok('labelled as such on the line', /MU earnings \(read-across\)/.test(w.lines.find(l => l.kind === 'read-across').text));
  eq('a foreign name with no own lookup is MACRO ONLY, not MISMATCH', w.class, 'MACRO ONLY');
}
{
  // Earnings feed returns error → "unavailable — check manually"; the entry is unaffected (nothing here blocks).
  const w = catalystWindow({ symbol: 'AVGO', kind: 'option', expiry: '2026-10-16', today: '2026-09-11', macro: MACRO, own: NONE('AVGO') });
  eq('an unavailable date is UNKNOWN, neutral', [w.class, w.flag], ['UNKNOWN', 'neutral']);
  ok('and says check manually', /unavailable — check manually/.test(w.why));
  eq('the log records unavailable, not a guess', [w.log.earnings_status, w.log.own_earnings_date], ['unavailable', null]);
}
// ── EVENT AND TIGHT ──────────────────────────────────────────────────────────
{
  const ev = catalystWindow({ symbol: 'MU', kind: 'option', expiry: '2026-10-16', today: '2026-09-11', macro: MACRO, own: FEED('MU', '2026-09-30') });
  eq('own earnings well inside is EVENT, neutral', [ev.class, ev.flag, ev.tradingBefore], ['EVENT', 'neutral', 11]);
  const tight = catalystWindow({ symbol: 'MU', kind: 'option', expiry: '2026-10-02', today: '2026-09-11', macro: MACRO, own: FEED('MU', '2026-09-30') });
  eq(`fewer than ${TIGHT_TRADING_DAYS} trading days before expiry is TIGHT, amber`, [tight.class, tight.flag, tight.tradingBefore], ['TIGHT', 'amber', 1]);
  ok('and says why', /IV crush and the gap arrive at the very end/.test(tight.why));
  const passed = catalystWindow({ symbol: 'MU', kind: 'option', expiry: '2026-10-16', today: '2026-10-05', macro: MACRO, own: FEED('MU', '2026-09-30') });
  eq('own earnings already passed is a MISMATCH', passed.class, 'MISMATCH');
}
// ── STOCKS: THE NEXT DATE ONLY ───────────────────────────────────────────────
{
  const s = catalystWindow({ symbol: 'INTC', kind: 'stock', today: '2026-09-11', macro: MACRO, own: FEED('INTC', '2026-10-21', 'estimated') });
  eq('a stock has no class', [s.class, s.window], [null, null]);
  ok('and shows the next date with its status', /INTC earnings Oct 21 · estimated/.test(s.summary));
  ok('an ETF stock says no lookup', /no earnings lookup/.test(catalystWindow({ symbol: 'SPY', kind: 'stock', today: '2026-09-11' }).summary));
}

// ── THE FEED PARSER, ON WHAT NASDAQ ACTUALLY ANSWERED ────────────────────────
{
  const intc = { status: { rCode: 200 }, data: { announcement: 'Earnings announcement* for INTC: Oct 22, 2026', reportText: 'Intel Corporation Common Stock is estimated to report earnings on  10/22/2026. The upcoming earnings date is derived from an algorithm based on a company\'s historical reporting dates.' } };
  eq('an algorithm-derived date is estimated', parseNasdaqEarnings(intc, 'INTC', { fetchedAt: 'T' }), { ok: true, symbol: 'INTC', date: '2026-10-22', status: 'estimated', time: null, source: 'Nasdaq (Zacks)', fetchedAt: 'T', text: intc.data.reportText.slice(0, 220) });
  const mu = { status: { rCode: 200 }, data: { announcement: 'Earnings announcement* for MU: Sep 30, 2026', reportText: 'Micron Technology, Inc. Common Stock is expected* to report earnings on  09/30/2026 after market close.' } };
  const m = parseNasdaqEarnings(mu, 'MU');
  eq('an expected date is confirmed, with the time of day', [m.status, m.date, m.time], ['confirmed', '2026-09-30', 'after close']);
  const avgo = { status: { rCode: 200 }, data: { announcement: 'Earnings announcement* for AVGO: ', reportText: 'Our vendor, Zacks Investment Research, hasn\'t provided us with the upcoming earnings report date.' } };
  const a = parseNasdaqEarnings(avgo, 'AVGO');
  eq('no date is unavailable, with the reason', [a.ok, a.status, a.why], [false, 'unavailable', 'the vendor has not published a date']);
  const qqq = { status: { rCode: 400, bCodeMessage: [{ code: 400 }] }, data: null };
  eq('a 400 is not a single name', parseNasdaqEarnings(qqq, 'QQQ').why, 'not a listed single name on the feed');
  eq('both date spellings parse', [parseUsDate('Nov 4, 2026'), parseUsDate('11/04/2026'), parseUsDate('soon')], ['2026-11-04', '2026-11-04', null]);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
