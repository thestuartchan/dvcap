// test/calendarAuto.test.mjs — the automatic macro calendar (lib/calendarAuto.js, lib/calendarAutoFetch.js).
// The snippets below copy each source page's markup shape, with made-up dates where it matters.
import { parseFomc, parseEcb, parseBoj, parseBea, parseCensus, eventsFromFred, kindsOf, mergeAuto, buildAutoCalendar,
  parseNasdaqEarnings, latestStatementUrl, parseFomcStatement, WATCH } from '../lib/calendarAuto.js';
import { autoCalendar, CAL_AUTO_KEY } from '../lib/calendarAutoFetch.js';
import { calendarMonths } from '../lib/calendarView.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const pick = (es) => es.map(e => [e.date, e.title]);

// ── Federal Reserve ──
const meeting = (mon, days) => `<div class="row fomc-meeting"><div class="fomc-meeting__month col-xs-5"><strong>${mon}</strong></div> <div class="fomc-meeting__date col-xs-4">${days}</div></div>`;
const FOMC = `<h4><a>2026 FOMC Meetings</a></h4>${meeting('October', '27-28')}${meeting('December', '8-9*')}<h4><a>2027 FOMC Meetings</a></h4>${meeting('Apr/May', '30-1')}`;
eq('the decision is the second day; * adds the projections; a meeting across months lands in the second',
  pick(parseFomc(FOMC)), [['2026-10-28', 'FOMC decision'], ['2026-12-09', 'FOMC decision + projections (dots)'], ['2027-05-01', 'FOMC decision']]);
eq('a page with no meetings gives nothing, not a guess', parseFomc('<html>maintenance</html>'), []);

// ── ECB ──
const ECB = `<dl><dt>28/10/2026</dt><dd>Governing Council of the ECB: monetary policy meeting in Frankfurt (Day 1)</dd>
<dt>29/10/2026</dt><dd>Governing Council of the ECB: monetary policy meeting in Frankfurt (Day 2), followed by press conference</dd>
<dt>25/11/2026</dt><dd>Governing Council of the ECB: non-monetary policy meeting (in Frankfurt)</dd></dl>`;
eq('only the monetary-policy day with the press conference', pick(parseEcb(ECB)), [['2026-10-29', 'ECB decision']]);

// ── Bank of Japan ──
const BOJ = `<p>Table : 2026</p><table><tr><th>Date of MPM</th></tr>
<tr><td>Oct. 29 (Thurs.), 30 (Fri.)</td><td>Oct. 30 (Fri.)</td></tr>
<tr><td>Dec. 17 (Thurs.), 18 (Fri.)</td><td>-</td><td>Dec. 28 (Mon.)</td></tr></table>
<p>Table : 2027</p><table><tr><td>Jan. 21 (Thurs.), 22 (Fri.) [PDF 100KB]</td></tr><tr><td>Apr. 30 (Fri.), May 1 (Sat.)</td></tr></table>`;
eq('the last day of each meeting, in its own year and month', pick(parseBoj(BOJ)),
  [['2026-10-30', 'BoJ decision'], ['2026-12-18', 'BoJ decision'], ['2027-01-22', 'BoJ decision'], ['2027-05-01', 'BoJ decision']]);

// ── BEA ──
const row = (d, t, title) => `<tr><td class="scheduled-date"><div class="release-date">${d}</div><small class="text-muted">${t}</small></td><td></td><td class="release-title views-field">${title}</td></tr>`;
const BEA = `<table><tr><th>Year 2026</th></tr>${row('October 29', '8:30 AM', 'GDP (Advance Estimate), 3rd Quarter 2026')}${row('October 29', '8:30 AM', 'Personal Income and Outlays, September 2026')}${row('December 2', '8:30 AM', 'GDP by County and Personal Income by County, 2025')}${row('November 4', '8:30 AM', 'U.S. International Trade in Goods and Services')}</table>`;
eq('GDP and PCE kept, county GDP and trade left out', pick(parseBea(BEA)), [['2026-10-29', 'US GDP (advance)'], ['2026-10-29', 'US PCE inflation (Personal Income and Outlays)']]);
eq('with the release time', parseBea(BEA)[0].time, '08:30');

// ── Census ──
const CENSUS = `<td>Advance Monthly Sales for Retail and Food Services</td><td>January 15, 2027</td><td>8:30 AM</td>
<td>Monthly Wholesale Trade: Sales and Inventories</td><td>January 8, 2027</td><td>10:00 AM</td>
<td>Advance Report on Durable Goods Manufacturers' Shipments, Inventories and Orders</td><td>January 27, 2027</td><td>8:30 AM</td>`;
eq('retail sales and durable goods, nothing else', pick(parseCensus(CENSUS)), [['2027-01-15', 'US retail sales'], ['2027-01-27', 'US durable goods orders']]);

// ── BLS via FRED ──
eq('FRED release dates read as their calendar names', pick(eventsFromFred({ 'Consumer Price Index': ['2026-11-10'], 'Unknown Release': ['2026-11-11'] })), [['2026-11-10', 'US CPI']]);

// ── Hand-kept rows win ──
eq('one hand-kept row can cover two kinds', kindsOf({ title: 'US core PCE (Sep) + Q3 GDP advance', region: 'US' }).sort(), ['gdp', 'pce']);
eq('minutes and the blackout are not the decision', [kindsOf({ title: 'FOMC minutes (Oct meeting)', region: 'US' }), kindsOf({ title: 'FOMC blackout begins (Oct 27–28 meeting)', region: 'US' })], [[], []]);
eq('Japan\'s CPI is not the US CPI', kindsOf({ title: 'Tokyo CPI (Oct)', region: 'ASIA' }), []);
const hand = [{ date: '2026-10-28', title: 'FOMC decision — no dot plot', region: 'US' }, { date: '2026-10-29', title: 'US core PCE (Sep) + Q3 GDP advance', region: 'US' }];
const auto = [...parseFomc(FOMC), ...parseBea(BEA)];
eq('an automatic row the hand-kept list already has is dropped; the rest stay', pick(mergeAuto(hand, auto)), [['2026-12-09', 'FOMC decision + projections (dots)'], ['2027-05-01', 'FOMC decision']]);

// ── One source failing costs only its rows, and says why ──
const built = buildAutoCalendar({ pages: { fomc: { html: FOMC }, ecb: { error: 'HTTP 403' }, boj: { html: '<html></html>' }, bea: { html: BEA }, census: { html: CENSUS } }, from: '2026-10-01' });
eq('each source reports its count or its reason', [built.sources.fomc, built.sources.ecb, built.sources.boj.ok], [{ ok: true, count: 3 }, { ok: false, error: 'HTTP 403' }, false]);
eq('one row per kind per day across sources', built.events.filter(e => e.kind === 'retail').length, 1);

// ── The Calendar tab merges them the same way ──
const view = calendarMonths({ today: '2026-10-18', extra: [{ ...auto.find(e => e.kind === 'fomc'), }, { date: '2026-12-18', title: 'BoJ decision', region: 'ASIA', tier: 1, kind: 'boj', auto: true, source: 'boj.or.jp' }] });
const rows = view.months.flatMap(m => m.weeks.flatMap(w => w.days.flatMap(d => d.events)));
eq('the tab keeps the hand-kept FOMC row and adds the BoJ meeting the hand list lacks', [rows.filter(e => e.date === '2026-10-28' && /FOMC/.test(e.title)).length, rows.some(e => e.date === '2026-12-18' && e.auto)], [1, true]);

// ── Earnings (Nasdaq per symbol) ──
const W = [{ sym: 'XYZ', name: 'Xyz Corp', aliases: ['Xyz'], region: 'US', tier: 1 }];
const said = (t) => ({ data: { reportText: t } });
eq('a company-announced date, with its timing', pick([parseNasdaqEarnings('XYZ', said('Xyz Corp Common Stock is expected* to report earnings on  11/05/2026 after market close.  The report will be for the fiscal Quarter ending Sep 2026.'), W)]),
  [['2026-11-05', 'Xyz Corp earnings (AC)']]);
eq('an algorithm\'s date is labelled an estimate', parseNasdaqEarnings('XYZ', said('Xyz Corp is estimated to report earnings on  01/28/2027. The upcoming earnings date is derived from an algorithm based on a company\'s historical reporting dates.'), W).title, 'Xyz Corp earnings — est.');
eq('no date, no row; a name off the watch list, no row', [parseNasdaqEarnings('XYZ', said("Our vendor, Zacks Investment Research, hasn't provided us with the upcoming earnings report date."), W), parseNasdaqEarnings('ABC', said('ABC is expected* to report earnings on 11/05/2026.'), W)], [null, null]);
eq('a hand-kept earnings row covers each company it names', kindsOf({ title: 'Texas Instruments + Lam Research Q3 earnings (AC)', region: 'US' }), ['earn:TXN', 'earn:LRCX']);
eq('a row that is not about earnings names none', kindsOf({ title: 'MS and GS conference', region: 'US' }), []);
eq('the watch list is public names only, each with a symbol and aliases', WATCH.every(w => /^[A-Z.]{1,6}$/.test(w.sym) && w.aliases.length > 0), true);
{
  const hand = [{ date: '2026-10-21', title: 'Texas Instruments + Lam Research Q3 earnings (AC)', region: 'US' }];
  const auto = [{ date: '2026-10-21', title: 'Texas Instruments earnings (AC)', kind: 'earn:TXN' }, { date: '2026-10-28', title: 'Microsoft earnings (AC)', kind: 'earn:MSFT' }];
  eq('the hand-kept row wins on its day; another company stays', pick(mergeAuto(hand, auto)), [['2026-10-28', 'Microsoft earnings (AC)']]);
}
{
  const b = buildAutoCalendar({ earnings: { MSFT: said('Microsoft Corporation is expected* to report earnings on 10/28/2026 after market close.'), NVDA: said('NVIDIA is estimated to report earnings on 11/18/2026. derived from an algorithm'), AAPL: { error: 'HTTP 403' } }, from: '2026-10-01' });
  eq('the earnings source reports its count, its estimates and its failures', b.sources.earnings, { ok: true, count: 2, estimated: 1, failed: 1 });
}

// ── The latest FOMC decision ──
eq('the newest statement the calendar page links', latestStatementUrl('<a href="/newsevents/pressreleases/monetary20260729a.htm">HTML</a> <a href="/newsevents/pressreleases/monetary20260916a.htm">HTML</a>'),
  { date: '2026-09-16', url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm' });
const STMT = (body) => `<div id="article"><p>${body}</p><p>For media inquiries, please email</p></div>`;
eq('a hike: action, size and range', parseFomcStatement(STMT('In support of its goals, the Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent, in support of the Federal Reserve\'s dual mandate.')),
  { date: null, url: null, action: 'raise', bps: 25, range: [3.75, 4], dissents: [], dissentPreferred: null });
eq('a hold with dissents, middle initials kept', parseFomcStatement(STMT('the Committee decided to maintain the target range for the federal funds rate at 3-1/2 to 3-3/4 percent.</p><p>Voting against the monetary policy action were Jane Q. Doe, John Roe, and Ann B. Poe, who preferred to raise the target range for the federal funds rate by 1/4 percentage point at this meeting.')),
  { date: null, url: null, action: 'maintain', bps: 0, range: [3.5, 3.75], dissents: ['Jane Q. Doe', 'John Roe', 'Ann B. Poe'], dissentPreferred: 'raise the target range for the federal funds rate by 1/4 percentage point at this meeting' });
eq('a page without a decision is nothing', parseFomcStatement('<p>Minutes of the meeting</p>'), null);

// ── The cache ──
{
  const store = {};
  const kv = { configured: () => true, get: async (k) => store[k] ?? null, setEx: async (k, v) => { store[k] = v; } };
  const pages = { 'federalreserve.gov': FOMC, 'ecb.europa.eu': ECB, 'boj.or.jp': BOJ, 'bea.gov': BEA, 'census.gov': CENSUS };
  let calls = 0;
  const STATEMENT = STMT('the Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent.');
  const fetchImpl = async (url) => {
    calls++;
    if (url.includes('api.nasdaq.com')) return { ok: true, status: 200, json: async () => ({ data: { reportText: url.includes('/MSFT/') ? 'Microsoft is expected* to report earnings on 10/28/2026 after market close.' : "hasn't provided" } }) };
    if (url.includes('/newsevents/pressreleases/monetary')) return { ok: true, status: 200, text: async () => STATEMENT };
    const host = Object.keys(pages).find(h => url.includes(h)); return { ok: !!host, status: host ? 200 : 404, text: async () => pages[host] };
  };
  const FOMC_WITH_LINK = FOMC + '<a href="/newsevents/pressreleases/monetary20260916a.htm">HTML</a>';
  pages['federalreserve.gov'] = FOMC_WITH_LINK;
  const READS = 5 + WATCH.length + 1;   // five pages, one earnings read per watched name, the latest statement
  const now = new Date('2026-10-18T09:00:00Z');
  // FRED is stubbed: the real one would answer during the deployment's own build (its key is set
  // there) and make this test depend on where it runs.
  const fredUp = async () => ({ dates: { 'Consumer Price Index': ['2026-11-10'] }, errors: {} });
  const fredDown = async () => ({ dates: {}, errors: { all: 'HTTP 503' } });
  const first = await autoCalendar({ now, fetchImpl, kv, fredDates: fredUp });
  eq('the first read fetches each source once and is stored', [first.cache, calls, !!store[CAL_AUTO_KEY]], ['live', READS, true]);
  eq('and carries the earnings and the decision in force', [first.events.some(e => e.kind === 'earn:MSFT' && e.date === '2026-10-28'), first.fomcLatest?.action, first.fomcLatest?.date], [true, 'raise', '2026-09-16']);
  eq('and carries the FRED dates', first.events.some(e => e.kind === 'cpi' && e.date === '2026-11-10'), true);
  const second = await autoCalendar({ now: new Date(now.getTime() + 3600e3), fetchImpl, kv, fredDates: fredUp });
  eq('within 12 hours the stored copy is served, no fetch', [second.cache, calls], ['kv', READS]);
  const down = async () => ({ ok: false, status: 503, text: async () => '' });
  const stale = await autoCalendar({ now: new Date(now.getTime() + 13 * 3600e3), fetchImpl: down, kv, fredDates: fredDown });
  eq('when every source fails later, the last good copy is served and marked stale', [stale.cache, stale.events.length === first.events.length, stale.sources.fomc.ok], ['stale', true, false]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
