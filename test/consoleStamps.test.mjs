// test/consoleStamps.test.mjs — the dates beside the Console's numbers (lib/consoleStamps.js), the
// statement's NLV (lib/flex.js navOf) and the one expiry clock (lib/expiryClock.js). Made-up
// tickers and figures throughout.
import { pricesStamp, clockHHMM, nlvDate, navCheck, NAV_DRIFT_PCT } from '../lib/consoleStamps.js';
import { navOf, parseStatement, NAV_MISSING } from '../lib/flex.js';
import { expiryCloseMs, optionExpired, daysToExpiry } from '../lib/expiryClock.js';
import { bookExposure, expiredLine } from '../lib/bookExposure.js';
import { optionDerived } from '../lib/instruments.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// ── P9: prices as of ──
// Wednesday 14 Oct 2026, 15:00 New York (19:00Z): US open, Hong Kong shut.
const NOW = Date.parse('2026-10-14T19:00:00Z');
const s = (iso) => Date.parse(iso) / 1000;
const P = {
  XYZ: { price: 10, ts: s('2026-10-14T18:58:00Z') },
  ABC: { price: 20, ts: s('2026-10-14T18:40:00Z') },
  '0001.HK': { price: 30, ts: s('2026-10-14T08:08:00Z') },
};
const st = pricesStamp(['XYZ', 'ABC', '0001.HK', 'NOPE'], P, NOW);
eq('the oldest quote from an open market is the time; a shut market does not drag it back', new Date(st.asOfMs).toISOString(), '2026-10-14T18:40:00.000Z');
eq('the shut market is counted, the missing quote named', [st.basis, st.closed, st.missing, st.total], ['open', 1, ['NOPE'], 4]);
eq('nothing stale inside the cadence', st.stale, []);
const late = pricesStamp(['XYZ'], { XYZ: { price: 10, ts: s('2026-10-14T17:30:00Z') } }, NOW);
eq('ninety minutes old with the market open is stale', late.stale.map(x => [x.symbol, x.ageMin]), [['XYZ', 90]]);
const weekend = pricesStamp(['XYZ'], { XYZ: { price: 10, ts: s('2026-10-16T20:00:00Z') } }, Date.parse('2026-10-18T09:00:00Z'));
eq('every market shut: the prior close is the time, and nothing is stale', [weekend.basis, weekend.stale.length, new Date(weekend.asOfMs).toISOString()], ['closed', 0, '2026-10-16T20:00:00.000Z']);
eq('no quotes at all, no time claimed', [pricesStamp([], P, NOW), pricesStamp(['XYZ'], {}, NOW).asOfMs], [null, null]);
eq('HH:MM in a given clock', [clockHHMM(Date.parse('2026-10-14T18:40:00Z'), 'Asia/Dubai'), clockHHMM(Date.parse('2026-10-14T18:40:00Z'), 'America/New_York')], ['22:40', '14:40']);

// ── P9: the date beside every "× NLV" ──
eq('the NLV date, short, stale past the threshold', [nlvDate('2026-10-16', '2026-10-18'), nlvDate('2026-09-01', '2026-10-18').stale],
  [{ text: 'NLV of 16 Oct', stale: false, days: 2 }, true]);
eq('another year carries its year; none says undated', [nlvDate('2025-12-31', '2026-01-02').text, nlvDate(null).text], ['NLV of 31 Dec 2025', 'NLV undated']);

// ── P1: the statement's NLV ──
const XML = `<FlexQueryResponse><FlexStatements><FlexStatement accountId="U0000000" fromDate="20261012" toDate="20261016">
<EquitySummaryInBase><EquitySummaryByReportDateInBase reportDate="20261015" currency="USD" total="100000.5" />
<EquitySummaryByReportDateInBase reportDate="20261016" currency="USD" total="101234.25" /></EquitySummaryInBase>
<OpenPositions><OpenPosition symbol="XYZ" assetCategory="STK" currency="USD" position="10" markPrice="10" /></OpenPositions>
</FlexStatement></FlexStatements></FlexQueryResponse>`;
eq('the newest day of the NAV section, with its date and currency', navOf(XML), { asOf: '2026-10-16', value: 101234.25, currency: 'USD', source: 'EquitySummaryByReportDateInBase' });
eq('carried on the parsed statement', parseStatement(XML).nav.value, 101234.25);
eq('Change in NAV when that is the section the query has', navOf('<ChangeInNAV fromDate="20261001" toDate="20261016" endingValue="5000" currency="USD" />'),
  { asOf: '2026-10-16', value: 5000, currency: 'USD', source: 'ChangeInNAV' });
eq('neither section: said, and no number', navOf('<OpenPositions />'), { value: null, asOf: null, currency: null, source: null, missing: NAV_MISSING });

const nav = { value: 100000, asOf: '2026-10-16', currency: 'USD' };
eq('an empty field is offered the statement\'s', navCheck({ equity: null, nav }).state, 'prefill');
eq('within the drift band agrees, and says when the statement is newer', navCheck({ equity: 101000, equityAsOf: '2026-10-01', nav }), { state: 'agrees', value: 100000, asOf: '2026-10-16', currency: 'USD', driftPct: 1, newer: true });
eq(`more than ${NAV_DRIFT_PCT}% apart is drift, signed`, [navCheck({ equity: 95000, nav }).state, navCheck({ equity: 95000, nav }).driftPct], ['drift', -5]);
eq('no statement section: missing, with the reason, nothing to fill', navCheck({ equity: null, nav: navOf('') }), { state: 'missing', reason: NAV_MISSING });
eq('the sync writes it into the console\'s flex note, and not into the channel message', (() => {
  const src = readFileSync('api/flex-sync.js', 'utf8');
  const tell = src.slice(src.indexOf('async function tell('), src.indexOf('async function tell(') + 1500);
  return [/nav: got\.statement\.nav \|\| null/.test(src), /nav/i.test(tell)];
})(), [true, false]);
eq('no statement read yet: missing', navCheck({ equity: 1 }).state, 'missing');
eq('another currency is not compared', navCheck({ equity: 100000, nav: { ...nav, currency: 'HKD' }, baseCcy: 'USD' }).state, 'currency');

// ── P4: one expiry clock, 16:00 New York ──
eq('16:00 New York is 20:00Z in summer time and 21:00Z in winter', [new Date(expiryCloseMs('2026-10-16')).toISOString(), new Date(expiryCloseMs('2026-12-18')).toISOString()],
  ['2026-10-16T20:00:00.000Z', '2026-12-18T21:00:00.000Z']);
eq('live at 15:59 New York, expired at 16:00', [optionExpired('2026-10-16', '2026-10-16T19:59:00Z'), optionExpired('2026-10-16', '2026-10-16T20:00:00Z')], [false, true]);
eq('days to that close', [daysToExpiry('2026-10-23', '2026-10-16T20:00:00Z'), daysToExpiry('2026-10-16', '2026-10-18T20:00:00Z')], [7, -2]);
eq('no date, no answer', [expiryCloseMs('soon'), optionExpired(null)], [null, false]);

const AFTER = new Date('2026-10-16T20:30:00Z');   // Friday 16:30 New York
const rows = [
  { symbol: 'XYZ 261016C00050000', qty: 2, multiplier: 100, livePrice: 0.01, assetCategory: 'OPT' },
  { symbol: 'XYZ 261120C00050000', qty: 1, multiplier: 100, livePrice: 2.0, assetCategory: 'OPT' },
  { symbol: 'ABC', qty: 10, livePrice: 50 },
];
const greeks = { 'XYZ|2026-10-16|C|50': { delta: 0.9 }, 'XYZ|2026-11-20|C|50': { delta: 0.5 } };
const book = bookExposure({ rows, greeks, underlyings: { XYZ: 55 }, nlv: 100000, now: AFTER });
eq('after the expiry close the expired contract is out of every figure, and named', [book.lines.map(l => l.symbol), book.expired],
  [['XYZ 261120C00050000', 'ABC'], [{ symbol: 'XYZ 261016C00050000', expiry: '2026-10-16' }]]);
eq('delta-notional is the live contract and the shares only', book.deltaNotional, 0.5 * 1 * 100 * 55 + 10 * 50);
const before = bookExposure({ rows, greeks, underlyings: { XYZ: 55 }, nlv: 100000, now: new Date('2026-10-16T19:00:00Z') });
eq('at 15:00 New York on the day it is still held', [before.lines.length, before.expired.length], [3, 0]);
eq('a share is never expired', expiredLine({ symbol: 'ABC' }, AFTER), false);

const opt = { id: 'XYZ-o', symbol: 'XYZ', instrument: 'option', multiplier: 100, legs: [{ right: 'C', strike: 50, expiry: '2026-10-16', side: 'long', ratio: 1 }],
  derived: { qty: 2, avgCost: 1 } };
eq('the option card says expired from 16:00 on the day, not from the next morning',
  [optionDerived(opt, { today: '2026-10-16', now: new Date('2026-10-16T19:59:00Z') }).expired, optionDerived(opt, { today: '2026-10-16', now: AFTER }).expired,
   optionDerived(opt, { today: '2026-10-17', now: new Date('2026-10-17T12:00:00Z') }).expired, optionDerived(opt, { today: '2026-10-15', now: new Date('2026-10-15T21:00:00Z') }).expired],
  [false, true, true, false]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
