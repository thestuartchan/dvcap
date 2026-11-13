// lib/officials.js — the Senate's and the President's / Vice President's trade filings, beside the
// House reader in lib/disclosures.js, to the disclosures channel (public filings, research only).
//
// THE AGREEMENTS (Stu, 13 Nov 2026: "Yes, accept both"). Both sites put the Ethics in Government Act
// notice in front of their search: no unlawful or commercial use of a report (news media excepted),
// no credit rating, no solicitation. dvcap's use is personal research and a private channel, never
// sold or monetised. The Senate's agreement is a form posted with each session; OGE's is a page
// overlay only (its data endpoint does not check it).
//
//   SENATE  efdsearch.senate.gov: the report list (JSON) after the agreement; each new Periodic
//           Transaction Report is posted with its link. The report pages themselves sit behind the
//           site's bot protection from some networks: when one cannot be read, the card says so and
//           links it. Nothing is worked around.
//   OGE     extapps2.oge.gov: the President's and Vice President's documents (JSON list). A new
//           278-T (periodic transaction report) is posted with its PDF. The PDFs are scanned paper
//           with an OCR text layer: lib/ogeRead.js reads it into rows (row #, name, buy / sell,
//           amount bracket, a guessed ticker), and the card lists the biggest stock and fund trades
//           with their row numbers, marked as machine-read so each can be checked in the PDF.
// Cold start: everything listed is remembered and nothing is posted (no backlog flood).

export const SENATE_BASE = 'https://efdsearch.senate.gov';
export const SENATE_SEEN_KEY = 'dvcap:disclosures:senate:seen:v1';
export const OGE_LIST_URL = 'https://extapps2.oge.gov/201/Presiden.nsf/API.xsp/v3/rest';
export const OGE_SEEN_KEY = 'dvcap:disclosures:oge:seen:v1';
export const OGE_FILERS = Object.freeze([
  { search: 'Trump, Donald J', name: 'Trump, Donald J', title: 'President', label: 'President Trump' },
  { search: 'Vance, JD', name: 'Vance, JD', title: 'Vice President', label: 'Vice President Vance' },
]);
const UA = 'Mozilla/5.0 (compatible; dvcap personal research)';
import { pdfLines, rowsOf, tradesBlock, tickerIndex, annualRows, holdingsBlock } from './ogeRead.js';
import { SEC_TICKERS_KEY, TICKERS_URL, tickerMap, secUserAgent } from './secDes.js';

const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

// ── SENATE ───────────────────────────────────────────────────────────────────
// A list row: [first, last, "Last, First (Senator)", '<a href="/search/view/ptr/<id>/">…</a>', 'MM/DD/YYYY'].
export function senateRows(answer) {
  return (answer?.data || []).map(r => {
    const href = /href="([^"]+)"/.exec(String(r?.[3] || ''))?.[1] || '';
    const id = /\/view\/(ptr|paper)\/([^/]+)\//.exec(href);
    if (!id) return null;
    const [mm, dd, yy] = String(r?.[4] || '').split('/');
    return { id: id[2], kind: id[1], name: strip(r?.[2]).replace(/\s*\((Senator|Candidate|Former Senator)\)\s*$/i, ''), role: /\(([^)]+)\)\s*$/.exec(strip(r?.[2]))?.[1] || 'Senator',
      filed: yy ? `${yy}-${mm}-${dd}` : null, url: `${SENATE_BASE}${href}` };
  }).filter(Boolean);
}
// An electronic PTR page's transaction table → rows of {date, owner, ticker, asset, type, amount}.
export function senateTrades(html) {
  const table = /<table[\s\S]*?<\/table>/i.exec(String(html || ''))?.[0];
  if (!table) return null;
  const head = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(m => strip(m[1]).toLowerCase());
  const col = (re) => head.findIndex(h => re.test(h));
  const ix = { date: col(/transaction date/), owner: col(/owner/), ticker: col(/ticker/), asset: col(/asset name/), type: col(/^type$/), amount: col(/amount/) };
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].slice(1)
    .map(m => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => strip(c[1])))
    .filter(c => c.length >= 4);
  return rows.map(c => Object.fromEntries(Object.entries(ix).map(([k, i]) => [k, i >= 0 ? (c[i] || '').replace(/^--$/, '') : ''])));
}
export function senateCard(f, trades, { watch = new Set() } = {}) {
  const lines = (trades || []).slice(0, 12).map(t => `**${t.ticker || (t.asset || '—').slice(0, 60)}**${t.ticker && t.asset ? ` ${t.asset.slice(0, 40)} ·` : ''} ${t.type || '?'} · ${t.amount || '?'} · traded ${t.date || '?'}${t.owner && !/self/i.test(t.owner) ? ` · ${t.owner}` : ''}${t.ticker && watch.has(t.ticker.toUpperCase()) ? ' · _watchlist_' : ''}`);
  const more = (trades?.length || 0) - lines.length;
  const body = trades == null
    ? (f.kind === 'paper' ? 'Filed on paper (scanned): open the link for the trades.' : 'The Senate site would not serve the report automatically: open the link for the trades.')
    : !trades.length ? 'No transactions listed in the report.' : [...lines, more > 0 ? `+${more} more in the filing` : ''].filter(Boolean).join('\n');
  return { embeds: [{
    title: `🏛️ ${f.name} (Senate) — trade filing`.slice(0, 256), url: f.url, color: 0x5865f2,
    description: body.slice(0, 4000),
    footer: { text: `Senate eFD periodic transaction report · filed ${f.filed || '?'} · public filing, research only` },
  }], allowed_mentions: { parse: [] } };
}

// A small cookie jar: the agreement is per session, carried by Django's csrftoken + sessionid.
function jar() {
  const c = new Map();
  return {
    take(res) { for (const line of (res.headers.getSetCookie?.() || [])) { const [kv] = line.split(';'); const i = kv.indexOf('='); if (i > 0) c.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); } },
    header() { return [...c].map(([k, v]) => `${k}=${v}`).join('; '); },
    get: (k) => c.get(k),
  };
}
export async function senateSession({ fetchImpl = fetch } = {}) {
  const j = jar();
  const home = await fetchImpl(`${SENATE_BASE}/search/home/`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  j.take(home);
  const token = /name="csrfmiddlewaretoken" value="([^"]+)"/.exec(await home.text())?.[1];
  if (!home.ok || !token) throw new Error(`Senate home HTTP ${home.status}`);
  const agree = await fetchImpl(`${SENATE_BASE}/search/home/`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${SENATE_BASE}/search/home/`, Cookie: j.header() },
    body: `prohibition_agreement=1&csrfmiddlewaretoken=${encodeURIComponent(token)}` });
  j.take(agree);
  if (agree.status >= 400) throw new Error(`Senate agreement HTTP ${agree.status}`);
  return j;
}
const mdy = (d) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
export async function runSenate({ now = new Date(), fetchImpl = fetch, kv, deliver, watch = new Set(), dry = false, lookbackDays = 30, maxNew = 10 }) {
  const j = await senateSession({ fetchImpl });
  const from = new Date(now.getTime() - lookbackDays * 86400000);
  const body = new URLSearchParams({ start: '0', length: '100', report_types: '[11]', filer_types: '[]',
    submitted_start_date: `${mdy(from)} 00:00:00`, submitted_end_date: '', candidate_state: '', senator_state: '', office_id: '', first_name: '', last_name: '',
    csrfmiddlewaretoken: j.get('csrftoken') || '' });
  const r = await fetchImpl(`${SENATE_BASE}/search/report/data/`, { method: 'POST', body, signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${SENATE_BASE}/search/`, 'X-CSRFToken': j.get('csrftoken') || '', Cookie: j.header() } });
  if (!r.ok) return { ok: false, why: `Senate list HTTP ${r.status}` };
  const rows = senateRows(await r.json());
  const seen = new Set((await kv.get(SENATE_SEEN_KEY).catch(() => null)) || []);
  if (!seen.size && !dry) { await kv.set(SENATE_SEEN_KEY, rows.map(x => x.id)); return { ok: true, seeded: rows.length }; }
  const fresh = rows.filter(x => !seen.has(x.id)).slice(0, dry ? 3 : maxNew);
  let posted = 0, read = 0;
  const cards = [];
  for (const f of fresh) {
    let trades = null;
    if (f.kind === 'ptr') {
      try {
        const pr = await fetchImpl(f.url, { headers: { 'User-Agent': UA, Referer: `${SENATE_BASE}/search/`, Cookie: j.header() }, signal: AbortSignal.timeout(20000) });
        if (pr.ok) { trades = senateTrades(await pr.text()); if (trades) read++; }
      } catch { /* linked, not read */ }
    }
    const card = senateCard(f, trades, { watch });
    cards.push(card);
    if (!dry && deliver && await deliver(card)) posted++;
    seen.add(f.id);
  }
  if (!dry) await kv.set(SENATE_SEEN_KEY, [...seen].slice(-2000));
  return { ok: true, listed: rows.length, new: fresh.length, read, posted, ...(dry ? { cards } : {}) };
}

// ── OGE: THE PRESIDENT AND THE VICE PRESIDENT ────────────────────────────────
// A list row: {docDate, title, type: "<a href='…/$FILE/x.pdf'>278 Transaction</a>…", name, …}.
export function ogeFilings(answer, filer) {
  return (answer?.data || []).filter(r => r?.name === filer.name && r?.title === filer.title && />\s*278 Transaction\s*</i.test(String(r?.type || '')))
    .map(r => {
      const href = /href='([^']+\.pdf)'/i.exec(String(r.type))?.[1];
      if (!href) return null;
      const id = /\/([0-9A-F]{32})\//i.exec(href)?.[1] || href;
      // `+` and `$` percent-encoded (the server answers both forms with the PDF): Discord's link
      // handling can mangle them, and Stu's tap on 13 Nov landed on a page instead of the file.
      const url = (href.startsWith('http') ? href : `https://extapps2.oge.gov${href.startsWith('/') ? '' : '/'}${href}`).replace(/\+/g, '%2B').replace(/\$/g, '%24');
      const period = /(\d{1,2})\.(\d{1,2})\.(\d{4})-278T/i.exec(href);
      return { id, url, label: filer.label, posted: String(r.docDate || '').slice(0, 10), amended: r.amended || null,
        through: period ? `${period[3]}-${period[1].padStart(2, '0')}-${period[2].padStart(2, '0')}` : null };
    }).filter(Boolean);
}
// read: tradesBlock's answer for the filing (null when the PDF could not be read: the card then just links it).
export function ogeCard(f, read = null) {
  const head = [f.through ? `**Report dated ${f.through}**` : '**Periodic transaction report**',
    `posted by OGE ${f.posted || '?'}${f.amended ? ` (amended ${f.amended})` : ''}`].join(' · ');
  const body = read?.text
    ? `${head}\n${read.text}\n\u200b\n[Open the PDF](${f.url})`
    : `${head}\nThe filing is a scanned PDF and could not be read automatically: [open the PDF](${f.url}).`;
  return { embeds: [{
    title: `🇺🇸 ${f.label} — trade report (OGE 278-T)`, url: f.url, color: 0xB22234,
    description: body.length > 4096 ? `${body.slice(0, 4000)}\n… [Open the PDF](${f.url})` : body,
    footer: { text: 'Office of Government Ethics · public filing, research only' },
  }], allowed_mentions: { parse: [] } };
}
// The filing's PDF → tradesBlock, or null. Rows under 3 means the text layer was not there to read.
export async function readOge(f, { fetchImpl = fetch, idx = null, watch = null, lines = pdfLines } = {}) {
  try {
    const r = await fetchImpl(f.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45000) });
    if (!r.ok) return null;
    const rows = rowsOf(await lines(new Uint8Array(await r.arrayBuffer())));
    return rows.length >= 3 ? tradesBlock(rows, { idx, watch, through: f.through }) : null;
  } catch { return null; }
}
// SEC's company names for the ticker guesses: the DES page's KV copy, else SEC itself (rare: new filings only).
export async function secIndex({ kv, fetchImpl = fetch } = {}) {
  const cached = await kv?.get?.(SEC_TICKERS_KEY).catch(() => null);
  if (cached?.m) return tickerIndex(cached.m);
  const ua = secUserAgent();
  if (!ua) return null;
  try {
    const r = await fetchImpl(TICKERS_URL, { headers: { 'User-Agent': ua, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    return r.ok ? tickerIndex(tickerMap(await r.json())) : null;
  } catch { return null; }
}
export const ogeUrl = (search) => `${OGE_LIST_URL}?${new URLSearchParams({ start: '0', length: '100', 'search[value]': search,
  'order[0][column]': '0', 'order[0][dir]': 'desc', 'columns[0][data]': 'docDate', 'columns[0][orderable]': 'true' })}`;
// ONE-OFF (Stu, 13 Nov 2026: "disclosures of Trump and VP all the way back to beginning of Q4"):
// every 278-T posted since OGE_BACKFILL_FROM, oldest first, once, on the first run after this ships.
export const OGE_BACKFILL_KEY = 'dvcap:disclosures:oge:backfill:q4:v4';   // v4: re-posted once with one line per company (13 Nov)
export const OGE_BACKFILL_FROM = '2026-10-01';
// `alsoDeliver`: a second channel for the same cards (Stu's Trump channel), optional.
export async function runOge({ fetchImpl = fetch, kv, deliver, alsoDeliver = null, dry = false, backfillFrom = OGE_BACKFILL_FROM, watch = null, lines = pdfLines }) {
  const all = [];
  for (const filer of OGE_FILERS) {
    const r = await fetchImpl(ogeUrl(filer.search), { headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { ok: false, why: `OGE list HTTP ${r.status}` };
    all.push(...ogeFilings(await r.json(), filer));
  }
  const seen = new Set((await kv.get(OGE_SEEN_KEY).catch(() => null)) || []);
  // Each filing to post is read (PDF → rows → the biggest trades); the SEC names load once, on demand.
  let idx;
  const cardFor = async (f) => {
    if (idx === undefined) idx = await secIndex({ kv, fetchImpl });
    return ogeCard(f, await readOge(f, { fetchImpl, idx, watch, lines }));
  };
  const send = async (card) => {
    const a = deliver ? await deliver(card) : null;
    if (alsoDeliver) await alsoDeliver(card);
    return a;
  };
  // The one-off backfill: filings posted since the date, whether or not already seen.
  let backfilled = 0;
  if (backfillFrom && !dry && !(await kv.get(OGE_BACKFILL_KEY).catch(() => null))) {
    const since = all.filter(f => String(f.posted) >= backfillFrom).sort((a, b) => String(a.posted).localeCompare(String(b.posted)));
    if (!seen.size) for (const f of all) seen.add(f.id);   // nothing seeded yet: the rest is history, not news
    for (const f of since) { if (await send(await cardFor(f))) backfilled++; }
    await kv.set(OGE_BACKFILL_KEY, { at: new Date().toISOString(), from: backfillFrom, sent: backfilled, of: since.length });
    await kv.set(OGE_SEEN_KEY, [...seen]);
    return { ok: true, listed: all.length, backfilled, of: since.length };
  }
  if (!seen.size && !dry) { await kv.set(OGE_SEEN_KEY, all.map(f => f.id)); return { ok: true, seeded: all.length }; }
  const fresh = all.filter(f => !seen.has(f.id)).sort((a, b) => String(a.posted).localeCompare(String(b.posted)));
  let posted = 0;
  const cards = [];
  for (const f of fresh) cards.push(await cardFor(f));
  for (let i = 0; i < fresh.length; i++) { if (!dry && await send(cards[i])) posted++; seen.add(fresh[i].id); }
  if (!dry) await kv.set(OGE_SEEN_KEY, [...seen]);
  return { ok: true, listed: all.length, new: fresh.length, posted, ...(dry ? { cards } : {}) };
}

// ── OGE ANNUAL REPORTS (278e): HOLDINGS ──────────────────────────────────────
// Stu, 13 Nov 2026: "yes add the holdings card". Each new annual report (OGE posts them mid-year) gets a
// card with the biggest listed stocks and funds, the biggest private holdings, property and cash, and
// the bonds in one line. First run: the latest report per filer is posted once, the rest remembered.
export const OGE_ANNUAL_SEEN_KEY = 'dvcap:disclosures:oge:annual:seen:v1';
export function ogeAnnuals(answer, filer) {
  return (answer?.data || []).filter(r => r?.name === filer.name && r?.title === filer.title && />\s*Annual \(\d{4}\)\s*</i.test(String(r?.type || '')))
    .map(r => {
      const href = /href='([^']+\.pdf)'/i.exec(String(r.type))?.[1];
      if (!href) return null;
      const id = /\/([0-9A-F]{32})\//i.exec(href)?.[1] || href;
      const url = (href.startsWith('http') ? href : `https://extapps2.oge.gov${href.startsWith('/') ? '' : '/'}${href}`).replace(/\+/g, '%2B').replace(/\$/g, '%24');
      const year = Number(/Annual \((\d{4})\)/i.exec(String(r.type))?.[1]) || null;
      return { id, url, label: filer.label, filer: filer.name, year, posted: String(r.docDate || '').slice(0, 10), amended: r.amended || null };
    }).filter(Boolean);
}
export function ogeAnnualCard(f, read = null) {
  const head = [`**Annual report ${f.year || ''}**${f.year ? ` (covers ${f.year - 1})` : ''}`.replace('  ', ' '),
    `posted by OGE ${f.posted || '?'}${f.amended ? ` (amended ${f.amended})` : ''}`].join(' · ');
  const body = read?.text
    ? `${head}\n${read.text}\n\u200b\n[Open the PDF](${f.url})`
    : `${head}\nThe report is a scanned PDF and could not be read automatically: [open the PDF](${f.url}).`;
  return { embeds: [{
    title: `🇺🇸 ${f.label} — holdings (OGE 278e annual report)`, url: f.url, color: 0xB22234,
    description: body.length > 4096 ? `${body.slice(0, 4000)}\n… [Open the PDF](${f.url})` : body,
    footer: { text: 'Office of Government Ethics · public filing, research only' },
  }], allowed_mentions: { parse: [] } };
}
export async function readOgeAnnual(f, { fetchImpl = fetch, idx = null, lines = pdfLines } = {}) {
  try {
    const r = await fetchImpl(f.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) return null;
    const rows = annualRows(await lines(new Uint8Array(await r.arrayBuffer())));
    return rows.length >= 3 ? holdingsBlock(rows, { idx }) : null;
  } catch { return null; }
}
export async function runOgeAnnual({ fetchImpl = fetch, kv, deliver, alsoDeliver = null, dry = false, lines = pdfLines }) {
  const all = [];
  for (const filer of OGE_FILERS) {
    const r = await fetchImpl(ogeUrl(filer.search), { headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { ok: false, why: `OGE list HTTP ${r.status}` };
    all.push(...ogeAnnuals(await r.json(), filer));
  }
  const seenList = await kv.get(OGE_ANNUAL_SEEN_KEY).catch(() => null);
  const seen = new Set(seenList || []);
  // First run: the latest report per filer; afterwards, whatever is new.
  const byYear = (a, b) => (b.year || 0) - (a.year || 0) || String(b.posted).localeCompare(String(a.posted));
  const fresh = seenList ? all.filter(f => !seen.has(f.id))
    : OGE_FILERS.map(fl => all.filter(f => f.filer === fl.name).sort(byYear)[0]).filter(Boolean);
  let idx, posted = 0;
  const cards = [];
  for (const f of fresh.slice(0, 4)) {
    if (idx === undefined) idx = await secIndex({ kv, fetchImpl });
    const card = ogeAnnualCard(f, await readOgeAnnual(f, { fetchImpl, idx, lines }));
    cards.push(card);
    if (!dry) {
      const a = deliver ? await deliver(card) : null;
      if (alsoDeliver) await alsoDeliver(card);
      if (a) posted++;
    }
  }
  if (!dry) await kv.set(OGE_ANNUAL_SEEN_KEY, [...new Set([...seen, ...all.map(f => f.id)])]);
  return { ok: true, listed: all.length, new: fresh.length, posted, ...(dry ? { cards } : {}) };
}
