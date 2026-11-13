// test/officials.test.mjs — the Senate and the President / VP trade filings (lib/officials.js):
// list parsing, the Senate report table, the OGE 278-T filter, cold start, once-only posting, and the
// agreement form being posted before the Senate search. Made-up filers and fake tickers only.
import { senateRows, senateTrades, senateCard, ogeFilings, ogeCard, runOge, runSenate, SENATE_SEEN_KEY, OGE_SEEN_KEY, OGE_BACKFILL_KEY } from '../lib/officials.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const memKv = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); return true; } }; };

// ── Senate list and report ──
const list = { data: [
  ['Jane', 'Sample', 'Sample, Jane (Senator)', '<a href="/search/view/ptr/aaaa-1111/" target="_blank">Periodic Transaction Report for 10/20/2030</a>', '11/04/2030'],
  ['Joe', 'Paper', 'Paper, Joe (Senator)', '<a href="/search/view/paper/bbbb-2222/" target="_blank">Periodic Transaction Report</a>', '11/02/2030'],
  ['X', 'Y', 'Y, X (Senator)', 'no link', '11/01/2030'],
] };
const rows = senateRows(list);
eq('two filings with links', rows.map(r => [r.id, r.kind, r.name, r.filed]), [['aaaa-1111', 'ptr', 'Sample, Jane', '2030-11-04'], ['bbbb-2222', 'paper', 'Paper, Joe', '2030-11-02']]);
eq('absolute link', rows[0].url, 'https://efdsearch.senate.gov/search/view/ptr/aaaa-1111/');
const page = `<table><thead><tr><th>#</th><th>Transaction Date</th><th>Owner</th><th>Ticker</th><th>Asset Name</th><th>Asset Type</th><th>Type</th><th>Amount</th><th>Comment</th></tr></thead>
<tbody><tr><td>1</td><td>10/21/2030</td><td>Self</td><td><a href="#">ZZQ</a></td><td>Sample Corp &amp; Co</td><td>Stock</td><td>Sale (Full)</td><td>$1,001 - $15,000</td><td>--</td></tr>
<tr><td>2</td><td>10/22/2030</td><td>Spouse</td><td>--</td><td>SAMPLE CITY BONDS 5% 2042</td><td>Municipal Security</td><td>Purchase</td><td>$15,001 - $50,000</td><td>--</td></tr></tbody></table>`;
const tr = senateTrades(page);
eq('report rows', tr.map(t => [t.date, t.owner, t.ticker, t.type, t.amount]), [['10/21/2030', 'Self', 'ZZQ', 'Sale (Full)', '$1,001 - $15,000'], ['10/22/2030', 'Spouse', '', 'Purchase', '$15,001 - $50,000']]);
eq('entities decoded', tr[0].asset, 'Sample Corp & Co');
const card = senateCard(rows[0], tr, { watch: new Set(['ZZQ']) });
eq('card lines, watchlist and owner marked', card.embeds[0].description.split('\n'), ['**ZZQ** Sample Corp & Co · Sale (Full) · $1,001 - $15,000 · traded 10/21/2030 · _watchlist_', '**SAMPLE CITY BONDS 5% 2042** Purchase · $15,001 - $50,000 · traded 10/22/2030 · Spouse']);
eq('no card says dvcap', [senateCard(rows[0], null), senateCard(rows[1], null), senateCard(rows[0], tr)].every(c => !/dvcap/i.test(JSON.stringify(c))), true);
eq('unread report: says so, keeps the link', [/would not serve the report automatically/.test(senateCard(rows[0], null).embeds[0].description), senateCard(rows[0], null).embeds[0].url], [true, rows[0].url]);
eq('paper filing: says scanned', /on paper/.test(senateCard(rows[1], null).embeds[0].description), true);
eq('no table: null', senateTrades('<p>nothing</p>'), null);

// ── OGE ──
const oge = { data: [
  { docDate: '2030-10-08T04:12:00Z', title: 'President', name: 'Trump, Donald J', amended: '', type: "<a href='/201/Presiden.nsf/PAS+Index/0BDCCCE7DE13AEFA85258E8A002DE2B5/$FILE/Donald-J-Trump.09.17.2030-278T.pdf'>278 Transaction</a>" },
  { docDate: '2030-05-15T04:00:00Z', title: 'President', name: 'Trump, Donald J', amended: '', type: "<a href='/201/Presiden.nsf/PAS+Index/1111/$FILE/annual.pdf'>278 Annual</a>" },
  { docDate: '2030-04-01T04:00:00Z', title: 'President', name: 'Trump, Donald J', amended: '', type: "278 Transaction (<a href='/201/Presiden.nsf/201%20Request?OpenForm'>Request this Document</a>)" },
  { docDate: '2024-04-01T04:00:00Z', title: 'Candidate', name: 'Trump, Donald J', amended: '', type: "<a href='/x/$FILE/c.pdf'>278 Transaction</a>" },
] };
const filer = { name: 'Trump, Donald J', title: 'President', label: 'President Trump' };
const of = ogeFilings(oge, filer);
eq('only posted 278-Ts in office', of.map(f => [f.id, f.through, f.posted]), [['0BDCCCE7DE13AEFA85258E8A002DE2B5', '2030-09-17', '2030-10-08']]);
eq('full PDF link, + and $ encoded', of[0].url, 'https://extapps2.oge.gov/201/Presiden.nsf/PAS%2BIndex/0BDCCCE7DE13AEFA85258E8A002DE2B5/%24FILE/Donald-J-Trump.09.17.2030-278T.pdf');
eq('the card links the PDF in its text too, and never says dvcap', [ogeCard(of[0]).embeds[0].description.includes(`[open the PDF](${of[0].url})`), /dvcap/i.test(JSON.stringify(ogeCard(of[0])))], [true, false]);
eq('card says the PDF is scanned and links it', [/scanned PDF/.test(ogeCard(of[0]).embeds[0].description), ogeCard(of[0]).embeds[0].url], [true, of[0].url]);

const fakeOge = async () => ({ ok: true, json: async () => oge });
const kv = memKv(); const posted = []; const deliver = async (c) => { posted.push(c); return 'id'; };
eq('OGE cold start: remembered, nothing posted', [(await runOge({ fetchImpl: fakeOge, kv, deliver, backfillFrom: null })).seeded, posted.length], [1, 0]);
kv.m.set(OGE_SEEN_KEY, ['old']);
eq('OGE: a new filing is posted once', [(await runOge({ fetchImpl: fakeOge, kv, deliver, backfillFrom: null })).posted, (await runOge({ fetchImpl: fakeOge, kv, deliver, backfillFrom: null })).posted], [1, 0]);
// The one-off backfill: filings posted since the date, to both channels, once, even if already seen.
{
  const bkv = memKv(); bkv.m.set(OGE_SEEN_KEY, ['0BDCCCE7DE13AEFA85258E8A002DE2B5']);
  const a = [], b = [];
  const r1 = await runOge({ fetchImpl: fakeOge, kv: bkv, deliver: async (c) => { a.push(c); return 'id'; }, alsoDeliver: async (c) => { b.push(c); return 'id'; }, backfillFrom: '2030-10-01' });
  eq('backfill: the in-window filing, to both channels', [r1.backfilled, r1.of, a.length, b.length], [1, 1, 1, 1]);
  eq('backfill: flagged', !!bkv.m.get(OGE_BACKFILL_KEY), true);
  const r2 = await runOge({ fetchImpl: fakeOge, kv: bkv, deliver: async (c) => { a.push(c); return 'id'; }, alsoDeliver: async (c) => { b.push(c); return 'id'; }, backfillFrom: '2030-10-01' });
  eq('backfill: never twice, and nothing new', [r2.backfilled, r2.new, a.length], [undefined, 0, 1]);
  const ekv = memKv();
  eq('backfill before any seeding: everything else is remembered, not posted', [(await runOge({ fetchImpl: fakeOge, kv: ekv, deliver: async () => 'id', backfillFrom: '2031-01-01' })).backfilled, ekv.m.get(OGE_SEEN_KEY).length], [0, 1]);
}

// ── the Senate run: agreement first, then the list, then the report ──
const calls = [];
const res = (body, { status = 200, cookies = [], json = false } = {}) => ({ ok: status < 400, status,
  headers: { getSetCookie: () => cookies }, text: async () => body, json: async () => (json ? body : JSON.parse(body)) });
const fakeSenate = async (url, opts = {}) => {
  calls.push([opts.method || 'GET', url.replace('https://efdsearch.senate.gov', ''), String(opts.body || '').slice(0, 40)]);
  if (url.endsWith('/search/home/') && !opts.method) return res('<input name="csrfmiddlewaretoken" value="TOK">', { cookies: ['csrftoken=CS; Path=/'] });
  if (url.endsWith('/search/home/')) return res('', { status: 302, cookies: ['sessionid=S1; Path=/'] });
  if (url.endsWith('/search/report/data/')) return res(list, { json: true });
  if (url.includes('/view/ptr/')) return res(page);
  return res('', { status: 404 });
};
const skv = memKv(); skv.m.set(SENATE_SEEN_KEY, ['zzz']);
const sp = []; const s = await runSenate({ fetchImpl: fakeSenate, kv: skv, deliver: async (c) => { sp.push(c); return 'id'; } });
eq('the agreement is posted before the search', calls.slice(0, 3).map(c => [c[0], c[1]]), [['GET', '/search/home/'], ['POST', '/search/home/'], ['POST', '/search/report/data/']]);
eq('agreement body carries the form token', calls[1][2], 'prohibition_agreement=1&csrfmiddlewareto');
eq('two new filings posted, one read', [s.new, s.posted, s.read], [2, 2, 1]);
eq('the report trades are on the card', /\*\*ZZQ\*\*/.test(sp[0].embeds[0].description), true);
eq('seen, so never twice', (await runSenate({ fetchImpl: fakeSenate, kv: skv, deliver: async () => 'id' })).new, 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
