// test/ismFeed.test.mjs — the ISM PMIs from ISM's own release on PR Newswire (lib/ismFeed.js), and
// how they meet the hand entry. Fixtures copy the release's shapes; the figures are made up.
import { ismLinksFromNewsroom, ismFromRelease, ismSeries, mergeIsm } from '../lib/ismFeed.js';
import { measuredAxes } from '../lib/quadrant.js';
import { handKeptLedger } from '../lib/ledger.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// ── THE NEWSROOM LIST ──
{
  const html = `
    <a href="/news-releases/manufacturing-pmi-at-51-2-march-2027-ism-manufacturing-pmi-report-302900001.html">x</a>
    <a href="/news-releases/services-pmi-at-53-march-2027-ism-services-pmi-report-302900002.html">x</a>
    <a href="/news-releases/manufacturing-pmi-at-51-2-march-2027-ism-manufacturing-pmi-report-302900001.html">dup</a>
    <a href="/news-releases/manufacturing-pmi-at-50-4-february-2027-ism-manufacturing-pmi-report-302800001.html">x</a>
    <a href="/news-releases/services-pmi-at-54-9-september-2024-services-ism-report-on-business-302266144.html">old style</a>
    <a href="/news-releases/ism-names-new-ceo-302872571.html">not a PMI</a>`;
  eq('PMI releases, newest month first, each once', ismLinksFromNewsroom(html).map(l => `${l.kind} ${l.period}`),
    ['manufacturing 2027-03', 'services 2027-03', 'manufacturing 2027-02']);
  eq('…as full URLs', ismLinksFromNewsroom(html)[0].url, 'https://www.prnewswire.com/news-releases/manufacturing-pmi-at-51-2-march-2027-ism-manufacturing-pmi-report-302900001.html');
}

// ── ONE RELEASE ──
const MFG = `<meta name="date" content="2027-04-01T15:00:00+01:00">
  <p>The Manufacturing PMI<sup>&reg;</sup>&nbsp;registered 51.2 percent in March, up 0.8 percentage points.</p>
  <table><tr><td>Manufacturing PMI<sup>&reg;</sup></td><td>51.2</td><td>50.4</td><td>+0.8</td></tr>
  <tr><td>New Orders</td><td>52.6</td><td>49.9</td><td>+2.7</td></tr></table>`;
const SVC = `<p>The Services PMI<sup>&reg;</sup>&nbsp;registered 53.0 percent.</p>
  <table><tr><td>Services PMI<sup>&reg;</sup></td><td>53.0</td><td>52.1</td></tr><tr><td>New Orders</td><td>55.0</td><td>54.0</td></tr></table>`;
{
  eq('manufacturing: headline, prior, new orders, release date', ismFromRelease(MFG, 'manufacturing'),
    { kind: 'manufacturing', pmi: 51.2, prior: 50.4, newOrders: 52.6, newOrdersPrior: 49.9, published: '2027-04-01' });
  eq('services', ismFromRelease(SVC, 'services').pmi, 53);
  eq('the table and the text disagree: nothing, not a guess', ismFromRelease(MFG.replace('registered 51.2', 'registered 51.9'), 'manufacturing'), null);
  eq('no table: nothing', ismFromRelease(MFG.replace(/<table>[\s\S]*<\/table>/, ''), 'manufacturing'), null);
}

// ── INTO THE STORE'S SHAPE, AND UNDER THE HAND ENTRY ──
{
  const releases = [
    { ...ismFromRelease(MFG, 'manufacturing'), period: '2027-03' },
    { ...ismFromRelease(SVC, 'services'), period: '2027-03' },
    { kind: 'services', pmi: 52.1, period: '2027-02' },
  ];
  const series = ismSeries(releases);
  eq('one row a month, services joined in, dated by the manufacturing release', series.at(-1),
    { period: '2027-03', manufacturing: 51.2, newOrders: 52.6, services: 53, asOf: '2027-04-01', source: 'prnewswire' });
  const feed = { ok: true, series };
  const hand = { series: [{ period: '2027-03', manufacturing: 51.0, newOrders: null, services: null, asOf: '2027-04-01' }] };
  const m = mergeIsm(feed, hand);
  eq('a typed month wins field by field; the feed fills what was not typed', [m.latest.manufacturing, m.latest.newOrders, m.latest.services, m.latest.source], [51, 52.6, 53, 'hand+prnewswire']);
  eq('latest is the newest month with a manufacturing reading', mergeIsm(feed, null).latest.period, '2027-03');
  eq('no feed: the hand entry alone, as before', mergeIsm(null, hand).latest.source, 'hand');
  eq('neither: nothing', mergeIsm(null, null).latest, null);
}

// ── THE GROWTH AXIS AND THE LEDGER READ IT ──
{
  const now = new Date('2027-04-10T12:00:00Z');
  const ind = { ismFeed: { ok: true, series: [{ period: '2027-03', manufacturing: 52.4, newOrders: 53.1, services: 53, asOf: '2027-04-01', source: 'prnewswire' }] } };
  const leg = measuredAxes(ind, { ism: null, now }).growth.pulses.monthly.legs?.find?.(l => l.key === 'ism')
    ?? measuredAxes(ind, { ism: null, now }).growth.pulses.monthly.parts?.find?.(l => l.key === 'ism');
  eq('the monthly ISM leg reads the feed with no hand entry', [leg?.available, leg?.value, leg?.handKept], [true, 52.4, false]);
  const failed = measuredAxes({ ismFeed: { ok: false, error: 'HTTP 403' } }, { ism: null, now }).growth.pulses.monthly;
  const fl = failed.legs?.find?.(l => l.key === 'ism') ?? failed.parts?.find?.(l => l.key === 'ism');
  eq('a failed feed and no entry: the leg says why', fl?.available, false);
  const L = handKeptLedger({ manual: {}, consts: { ismFeed: ind.ismFeed }, now });
  const r = (L.rows || L).find(x => x.key === 'ism');
  eq('the ledger row: fed, fresh, from the release', [r.state, r.label, r.note], ['fresh', 'ISM manufacturing PMI — PR Newswire', '2027-03 from the release']);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
