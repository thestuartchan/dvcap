// lib/disclosures.js — politicians' and insiders' trades, read from the filings themselves.
//
// WHY (8 Nov 2026). Stu asked how close to "real time" congressional trades can get. By law they
// can't be: a member has up to 45 days to file, and every vendor (Unusual Whales, Quiver, Capitol
// Trades, FMP) scrapes the same official filing. The earliest public moment is the filing itself,
// so this reads the House Clerk's index directly every hour and posts what is new — hours ahead of
// the vendors, never ahead of the law. Corporate insiders (SEC Form 4, due in two business days)
// are the faster signal, so every new Form 4 across the market is read every 30 minutes beside it.
//
// FILTERED, NOT A FIREHOSE. Most filings are $1k–15k noise. A congressional trade is posted when it
// is on the watchlist, is $250k+ at the bottom of its band, is an option, belongs to a cluster
// (3+ members, same ticker, same side, 30 days) or was filed more than 45 days late. A Form 4 is
// reported when it is an open-market buy of $500k+ (any company), a CEO/CFO/President buying
// $100k+, any open-market buy on the watchlist, an unplanned $1M+ sale on the watchlist, or part of
// a cluster (3+ insiders buying one company in 14 days). Friday brings a roundup of the week.
//
// WHAT IT NEVER CARRIES. The private disclosures channel gets public-filing data only: no position,
// size, cost or fill. "Watchlist" means a ticker dvcap tracks, never "held".
//
// THE SENATE. Its search site (efdsearch.senate.gov) needs a user to accept a prohibition agreement
// before searching; that is Stu's call to make, so the Senate is not read here yet.
//
// Pure parsing and scoring up top (tested in test/disclosures.test.mjs); the fetchers take an
// injected fetch so the route stays thin.
import { inflateRawSync } from 'node:zlib';

export const HOUSE_INDEX_URL = (y) => `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${y}FD.zip`;
export const HOUSE_PTR_URL = (y, id) => `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${y}/${id}.pdf`;
export const SUBS_URL = (cik) => `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`;
export const CONGRESS_SEEN_KEY = 'dvcap:disclosures:house:seen:v1';
export const CONGRESS_HIST_KEY = 'dvcap:disclosures:house:trades:v1';
export const INSIDER_SEEN_KEY = 'dvcap:disclosures:form4:seen:v1';
export const BIG_MIN = 250001;            // bottom of the $250,001–$500,000 band
export const LATE_DAYS = 45;
export const CLUSTER_MEMBERS = 3, CLUSTER_DAYS = 30;
export const SELL_MIN_USD = 1_000_000;
export const MAX_NEW_PER_RUN = 25;        // PDFs fetched per hourly run; the rest wait for the next

// ── ZIP ──────────────────────────────────────────────────────────────────────
// The House index is one zip with two members (YYYYFD.txt, YYYYFD.xml). A dependency for that would
// be heavier than the twenty lines it takes to walk the central directory.
export function unzipEntry(buf, wanted) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) return null;
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20);
    const nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nlen);
    if (typeof wanted === 'function' ? wanted(name) : name === wanted) {
      const ln = b.readUInt16LE(local + 26), lx = b.readUInt16LE(local + 28);
      const data = b.subarray(local + 30 + ln + lx, local + 30 + ln + lx + csize);
      return method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null;
    }
    p += 46 + nlen + xlen + clen;
  }
  return null;
}

// ── HOUSE INDEX ──────────────────────────────────────────────────────────────
const tag = (block, t) => { const m = block.match(new RegExp(`<${t}>([^<]*)</${t}>`)); return m ? m[1].trim() : ''; };
const usDate = (s) => { const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };

// Periodic Transaction Reports (FilingType P) only: the trade filings.
export function parseHouseIndex(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<Member>([\s\S]*?)<\/Member>/g)) {
    if (tag(m[1], 'FilingType') !== 'P') continue;
    const docId = tag(m[1], 'DocID');
    if (!/^\d+$/.test(docId)) continue;
    const name = [tag(m[1], 'Prefix'), tag(m[1], 'First'), tag(m[1], 'Last'), tag(m[1], 'Suffix')].filter(Boolean).join(' ');
    out.push({ docId, name, district: tag(m[1], 'StateDst'), year: +tag(m[1], 'Year') || null, filed: usDate(tag(m[1], 'FilingDate')) });
  }
  return out;
}

// ── PTR TEXT ─────────────────────────────────────────────────────────────────
// An e-filed PTR's text, one row per trade: "<asset> (TICKER) [ST] P 10/23/2026 11/01/2026 $1,001 -
// $15,000". Text extractors disagree on where the ticker line falls (before the code on one, after
// the amount on another), so each trade takes the last ticker since the previous trade, else the
// first one just after it. A hand-written (scanned) PTR has no text: zero trades, the filing link
// still posts if anything else flags it.
const TXN_RE = /(?:^|\s)(P|S \(partial\)|S|E)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(\$[\d,]+\s*-\s*\$[\d,]+|Over \$[\d,]+|\$[\d,]+)/g;
const TICKER_RE = /\(([A-Z][A-Z0-9.]{0,6})\)\s*\[([A-Z]{2})\]/g;
export function amountMin(band) {
  const m = String(band || '').match(/\$([\d,]+)/);
  return m ? +m[1].replace(/,/g, '') : null;
}
export function parsePtrText(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const trades = [];
  let cursor = 0;
  for (const m of t.matchAll(TXN_RE)) {
    const start = m.index, end = m.index + m[0].length;
    const win = t.slice(cursor, start);
    const before = [...win.matchAll(TICKER_RE)];
    let tick = before.length ? before[before.length - 1] : null;
    cursor = end;
    if (!tick) {
      const after = t.slice(end, end + 80);
      const a = TICKER_RE.exec(after); TICKER_RE.lastIndex = 0;
      if (a) { tick = a; cursor = end + a.index + a[0].length; }
    }
    // No ticker (a bond, a fund, private stock): keep a short asset name for the card instead.
    const asset = tick ? null : win.replace(/\b(F|S)\s+[SO]\s*:\s*[^:]*?(?=\s[A-Z][a-z]|$)/g, ' ').replace(/\s+/g, ' ').trim().slice(-60) || null;
    trades.push({
      ticker: tick ? tick[1] : null, assetType: tick ? tick[2] : null, asset,
      side: m[1].startsWith('S') ? 'sell' : m[1] === 'P' ? 'buy' : 'exchange', partial: m[1] === 'S (partial)',
      traded: usDate(m[2]), notified: usDate(m[3]), amount: m[4].replace(/\s+/g, ' '), amountMin: amountMin(m[4]),
    });
  }
  return trades;
}

// ── SCORING ──────────────────────────────────────────────────────────────────
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;
// The reasons a congressional trade is worth a line. history: earlier trades [{member, ticker, side, traded}].
export function flagsFor(tr, { member, filed, watch = new Set(), history = [], today } = {}) {
  const f = [];
  if (tr.ticker && watch.has(tr.ticker)) f.push('watchlist');
  if (tr.amountMin != null && tr.amountMin >= BIG_MIN) f.push('$250k+');
  if (tr.assetType === 'OP') f.push('option');
  if (tr.traded && filed && days(tr.traded, filed) > LATE_DAYS) f.push(`filed ${Math.round(days(tr.traded, filed))}d late`);
  if (tr.ticker && tr.side !== 'exchange') {
    const ref = today || filed;
    const others = new Set(history.filter(h => h.ticker === tr.ticker && h.side === tr.side && h.member !== member
      && h.traded && ref && days(h.traded, ref) <= CLUSTER_DAYS).map(h => h.member));
    if (others.size + 1 >= CLUSTER_MEMBERS) f.push(`cluster: ${others.size + 1} members ${tr.side === 'buy' ? 'buying' : 'selling'}`);
  }
  return f;
}

// One Discord embed per filing with at least one flagged trade.
export function congressCard(filing, scored, { url } = {}) {
  const hit = scored.filter(s => s.flags.length);
  if (!hit.length) return null;
  const lines = hit.slice(0, 12).map(({ tr, flags }) =>
    `**${tr.ticker || tr.asset || '—'}** ${tr.side === 'buy' ? 'BUY' : tr.side === 'sell' ? (tr.partial ? 'SELL (partial)' : 'SELL') : 'EXCHANGE'}${tr.assetType === 'OP' ? ' option' : ''} · ${tr.amount} · traded ${tr.traded || '?'} · _${flags.join(', ')}_`);
  const rest = scored.length - hit.length;
  return { embeds: [{
    title: `🏛️ ${filing.name} (${filing.district || 'House'}) — trade filing`,
    url, color: 0x5865f2,
    description: [...lines, rest > 0 ? `+${rest} other trade${rest > 1 ? 's' : ''} in this filing, unflagged` : ''].filter(Boolean).join('\n').slice(0, 4000),
    footer: { text: `House Clerk PTR #${filing.docId} · filed ${filing.filed || '?'} · public filing, research only` },
  }], allowed_mentions: { parse: [] } };
}

// ── FORM 4 ───────────────────────────────────────────────────────────────────
const v = (block, t) => { const m = block.match(new RegExp(`<${t}>\\s*(?:<value>)?\\s*([^<]*?)\\s*(?:</value>)?\\s*</${t}>`)); return m ? m[1].trim() : ''; };
export function parseForm4(xml) {
  const x = String(xml || '');
  const issuer = x.match(/<issuer>([\s\S]*?)<\/issuer>/)?.[1] || '';
  const owner = x.match(/<reportingOwner>([\s\S]*?)<\/reportingOwner>/)?.[1] || '';
  const rel = [];
  if (v(owner, 'isDirector') === '1' || v(owner, 'isDirector') === 'true') rel.push('Director');
  if (v(owner, 'isOfficer') === '1' || v(owner, 'isOfficer') === 'true') rel.push(v(owner, 'officerTitle') || 'Officer');
  if (v(owner, 'isTenPercentOwner') === '1' || v(owner, 'isTenPercentOwner') === 'true') rel.push('10% owner');
  const plan = /<aff10b5One>\s*(1|true)\s*<\/aff10b5One>/.test(x);
  const txns = [];
  for (const m of x.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)) {
    const b = m[1];
    const shares = +v(b, 'transactionShares') || 0, price = +v(b, 'transactionPricePerShare') || 0;
    txns.push({ date: v(b, 'transactionDate') || null, code: v(b, 'transactionCode'), shares, price,
      ad: v(b, 'transactionAcquiredDisposedCode'), value: Math.round(shares * price) });
  }
  return { ticker: v(issuer, 'issuerTradingSymbol').toUpperCase(), issuer: v(issuer, 'issuerName'),
           owner: v(owner, 'rptOwnerName'), role: rel.join(', ') || 'Insider', plan, txns };
}

// Why one Form 4 is worth a line. Whole market: open-market buys of $500k+, a CEO/CFO/President
// buying $100k+. Watchlist: any open-market buy, and an unplanned sale of $1M+.
export const BIG_BUY_USD = 500_000, EXEC_BUY_USD = 100_000;
export const CLUSTER_INSIDERS = 3, INSIDER_CLUSTER_DAYS = 14;
const EXEC_RE = /\b(CEO|CFO|Chief Executive|Chief Financial|President)\b/i;
export function form4Flags(f, { watch = new Set() } = {}) {
  const p = f.txns.filter(t => t.code === 'P'), sl = f.txns.filter(t => t.code === 'S');
  const buy = p.reduce((a, t) => a + t.value, 0), sale = sl.reduce((a, t) => a + t.value, 0);
  const flags = [];
  if (buy >= BIG_BUY_USD) flags.push('$500k+ buy');
  else if (buy >= EXEC_BUY_USD && EXEC_RE.test(f.role)) flags.push('CEO/CFO buy');
  if (buy > 0 && watch.has(f.ticker) && !flags.length) flags.push('watchlist buy');
  if (sale >= SELL_MIN_USD && !f.plan && watch.has(f.ticker)) flags.push('watchlist: unplanned sale');
  return { buy, sale, flags, date: (p[0] || sl[0])?.date || null };
}
// Tickers with CLUSTER_INSIDERS+ different insiders buying inside the window. history: [{ticker, owner, date}].
export function insiderClusters(history, { today, already = [] } = {}) {
  const by = {};
  for (const h of history) if (h.date && today && days(h.date, today) <= INSIDER_CLUSTER_DAYS) (by[h.ticker] ??= new Set()).add(h.owner);
  return Object.entries(by).filter(([t, o]) => o.size >= CLUSTER_INSIDERS && !already.includes(t)).map(([ticker, o]) => ({ ticker, insiders: o.size }));
}

const usd = (n) => n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${n}`;
const f4Line = (r) => `${r.sale && !r.buy ? '🔴' : '🟢'} **${r.ticker}** ${r.buy ? `BUY ${usd(r.buy)}` : `SELL ${usd(r.sale)}`} · ${r.owner} (${r.role}) · ${r.date || '?'} · _${r.flags.join(', ')}_`;
// One message per run: the flagged filings and any new clusters.
export function insiderScanCard(rows, clusters = []) {
  if (!rows.length && !clusters.length) return null;
  const lines = [...clusters.map(c => `🧲 **${c.ticker}** cluster: ${c.insiders} insiders bought in the last ${INSIDER_CLUSTER_DAYS} days`), ...rows.slice(0, 20).map(f4Line)];
  return { embeds: [{ title: '📑 Insider Form 4s', color: 0x2ecc71, description: lines.join('\n').slice(0, 4000),
    footer: { text: 'SEC Form 4, open-market P/S only · public filings, research only' } }], allowed_mentions: { parse: [] } };
}
// Friday's roundup: the week's largest open-market buys and the clusters, whole market.
export function insiderRoundupCard(history, { from, to } = {}) {
  const week = history.filter(h => h.date && h.date >= from && h.date <= to);
  const top = [...week].sort((a, b) => b.value - a.value).slice(0, 10);
  const clusters = insiderClusters(week, { today: to });
  const lines = [...clusters.map(c => `🧲 **${c.ticker}**: ${c.insiders} insiders buying`),
    ...top.map(h => `🟢 **${h.ticker}** ${usd(h.value)} · ${h.owner} (${h.role}) · ${h.date}`)];
  return { embeds: [{ title: `📑 Insider buying, week of ${from} to ${to}`, color: 0x2ecc71,
    description: (lines.length ? lines.join('\n') : 'No open-market insider buys recorded this week.').slice(0, 4000),
    footer: { text: 'Largest open-market buys (code P) across all US filers · public filings, research only' } }], allowed_mentions: { parse: [] } };
}

// SEC's latest-filings feed (Atom): one entry per party, so each Form 4 appears for the issuer and
// for the insider. The issuer entry gives the folder to read.
export const CURRENT_URL = (start) => `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&start=${start}&count=100&output=atom`;
export function parseCurrentFeed(atom) {
  const out = [], seen = new Set();
  for (const m of String(atom || '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    if (!/term="4"/.test(e) || !/\(Issuer\)/.test(e)) continue;
    const href = e.match(/href="https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/(\d+)\/(\d{18})\//);
    if (!href || seen.has(href[2])) continue;
    seen.add(href[2]);
    out.push({ cik: href[1], acc: href[2] });
  }
  return out;
}

// ── WATCHLIST ────────────────────────────────────────────────────────────────
// The Trading Ideas cards' tickers, kept as the ideas card syncs, so Stu maintains nothing by hand.
// A pair idea ("XSW/SOXX", "RSP vs QQQ") gives both legs.
export const IDEAS_TICKERS_KEY = 'dvcap:disclosures:ideas-tickers:v1';
export const DISCLOSURES_EXTRA_KEY = 'dvcap:disclosures:extra-watch:v1';   // names Stu adds in chat
export function ideaTickers(ideas = []) {
  const out = new Set();
  // Tickers are written in capitals; joining words ('vs', 'and') are not.
  for (const i of Array.isArray(ideas) ? ideas : []) for (const t of String(i?.ticker || '').split(/[^A-Za-z.]+/)) if (/^[A-Z]{1,5}(\.[A-Z])?$/.test(t)) out.add(t);
  return [...out];
}
// US tickers only (HK/AE dropped): book symbols, idea tickers and the extra names, from lists or a comma string.
export function watchSet(bookSymbols = [], extra = '') {
  const s = new Set();
  for (const raw of [...bookSymbols, ...String(extra || '').split(/[\s,]+/)]) {
    const t = String(raw || '').trim().toUpperCase();
    if (/^[A-Z]{1,5}(\.[A-Z])?$/.test(t)) s.add(t);
  }
  return s;
}

// ── FETCH + RUN ──────────────────────────────────────────────────────────────
// The hourly House read. kv: {get, set}; pdfText(buf) → text; deliver(card) → posted?
export async function runCongress({ now = new Date(), fetchImpl = fetch, kv, pdfText, deliver, watch = new Set(), dry = false }) {
  const year = now.getUTCFullYear();
  const r = await fetchImpl(HOUSE_INDEX_URL(year), { signal: AbortSignal.timeout(30000) });
  if (!r.ok) return { ok: false, why: `House index HTTP ${r.status}` };
  const xml = unzipEntry(Buffer.from(await r.arrayBuffer()), n => n.endsWith('.xml'));
  if (!xml) return { ok: false, why: 'House index: no XML in the zip' };
  const ptrs = parseHouseIndex(xml.toString('utf8'));
  const seen = new Set((await kv.get(CONGRESS_SEEN_KEY).catch(() => null)) || []);
  if (!seen.size && !dry) {                               // COLD START: remember everything, post nothing
    await kv.set(CONGRESS_SEEN_KEY, ptrs.map(p => p.docId));
    return { ok: true, seeded: ptrs.length };
  }
  const fresh = ptrs.filter(p => !seen.has(p.docId)).slice(0, dry ? 5 : MAX_NEW_PER_RUN);
  let history = (await kv.get(CONGRESS_HIST_KEY).catch(() => null)) || [];
  const today = now.toISOString().slice(0, 10);
  let posted = 0, parsed = 0, flagged = 0;
  const cards = [];
  for (const f of fresh) {
    const url = HOUSE_PTR_URL(f.year || year, f.docId);
    let trades = [];
    try {
      const pr = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
      if (pr.ok) trades = parsePtrText(await pdfText(new Uint8Array(await pr.arrayBuffer())));
    } catch { /* scanned or unreadable: zero trades */ }
    parsed += trades.length;
    const scored = trades.map(tr => ({ tr, flags: flagsFor(tr, { member: f.name, filed: f.filed, watch, history, today }) }));
    history = [...history, ...trades.filter(t => t.ticker).map(t => ({ member: f.name, ticker: t.ticker, side: t.side, traded: t.traded }))];
    const card = congressCard(f, scored, { url });
    if (card) { flagged++; cards.push(card); if (!dry && deliver && await deliver(card)) posted++; }
    seen.add(f.docId);
  }
  if (!dry) {
    history = history.filter(h => h.traded && days(h.traded, today) <= 90).slice(-3000);
    await kv.set(CONGRESS_SEEN_KEY, [...seen]);
    await kv.set(CONGRESS_HIST_KEY, history);
  }
  return { ok: true, filings: ptrs.length, new: fresh.length, trades: parsed, flagged, posted, ...(dry ? { cards } : {}) };
}

export const INSIDER_HIST_KEY = 'dvcap:disclosures:form4:buys:v1';
export const INSIDER_CLUSTERS_KEY = 'dvcap:disclosures:form4:clusters:v1';
export const MAX_FORMS_PER_RUN = 150;
// Every 30 minutes: the new Form 4s across the market since the last run, flagged and batched.
export async function runInsiderScan({ now = new Date(), fetchImpl = fetch, kv, ua, deliver, watch = new Set(), dry = false }) {
  if (!ua) return { ok: false, why: 'SEC contact not configured (SEC_USER_AGENT)' };
  const h = { headers: { 'User-Agent': ua, Accept: 'application/json, application/xml, application/atom+xml' } };
  const pause = () => new Promise(r => setTimeout(r, 120));          // SEC fair access: well under 10/s
  const seen = new Set((await kv.get(INSIDER_SEEN_KEY).catch(() => null)) || []);
  const fresh = [];
  for (let start = 0; start < 400 && fresh.length < MAX_FORMS_PER_RUN; start += 100) {
    const r = await fetchImpl(CURRENT_URL(start), { ...h, signal: AbortSignal.timeout(15000) });
    if (!r.ok) { if (!start) return { ok: false, why: `SEC feed HTTP ${r.status}` }; break; }
    const page = parseCurrentFeed(await r.text());
    const unseen = page.filter(f => !seen.has(f.acc));
    fresh.push(...unseen);
    if (!page.length || unseen.length < page.length) break;          // reached what the last run read
    await pause();
  }
  if (!seen.size && !dry) {                                          // COLD START: remember, post nothing
    await kv.set(INSIDER_SEEN_KEY, fresh.map(f => f.acc));
    return { ok: true, seeded: fresh.length };
  }
  const today = now.toISOString().slice(0, 10);
  let history = (await kv.get(INSIDER_HIST_KEY).catch(() => null)) || [];
  const rows = [];
  let read = 0;
  for (const f of fresh.slice(0, MAX_FORMS_PER_RUN)) {
    try {
      const base = `https://www.sec.gov/Archives/edgar/data/${f.cik}/${f.acc}`;
      const idx = await fetchImpl(`${base}/index.json`, { ...h, signal: AbortSignal.timeout(15000) });
      await pause();
      if (!idx.ok) continue;
      const name = ((await idx.json())?.directory?.item || []).map(i => i.name).find(n => /\.xml$/i.test(n) && !/^xsl/i.test(n));
      if (!name) continue;
      const x = await fetchImpl(`${base}/${name}`, { ...h, signal: AbortSignal.timeout(15000) });
      await pause();
      if (!x.ok) continue;
      const form = parseForm4(await x.text()); read++;
      if (!form.ticker) continue;
      const sc = form4Flags(form, { watch });
      if (sc.buy > 0) history.push({ ticker: form.ticker, owner: form.owner, role: form.role, value: sc.buy, date: sc.date || today });
      if (sc.flags.length) rows.push({ ...form, ...sc });
    } catch { /* one filing failing never stops the rest */ }
    seen.add(f.acc);
  }
  history = history.filter(x => x.date && days(x.date, today) <= 30).slice(-5000);
  const sent = (await kv.get(INSIDER_CLUSTERS_KEY).catch(() => null)) || [];   // [{ticker, at}] already posted
  const recentSent = sent.filter(c => days(c.at, today) <= INSIDER_CLUSTER_DAYS);
  const clusters = insiderClusters(history, { today, already: recentSent.map(c => c.ticker) });
  const card = insiderScanCard(rows.sort((a, b) => (b.buy || b.sale) - (a.buy || a.sale)), clusters);
  const posted = card && !dry && deliver ? !!(await deliver(card)) : false;
  if (!dry) {
    await kv.set(INSIDER_SEEN_KEY, [...seen].slice(-8000));
    await kv.set(INSIDER_HIST_KEY, history);
    await kv.set(INSIDER_CLUSTERS_KEY, [...recentSent, ...clusters.map(c => ({ ticker: c.ticker, at: today }))]);
  }
  return { ok: true, new: fresh.length, forms: read, flagged: rows.length, clusters: clusters.length, posted, ...(dry ? { card } : {}) };
}

// Friday after the close: the week's roundup from what the scans recorded.
export async function runInsiderRoundup({ now = new Date(), kv, deliver, dry = false }) {
  const history = (await kv.get(INSIDER_HIST_KEY).catch(() => null)) || [];
  const to = now.toISOString().slice(0, 10), from = new Date(now.getTime() - 6 * 864e5).toISOString().slice(0, 10);
  const card = insiderRoundupCard(history, { from, to });
  const posted = !dry && deliver ? !!(await deliver(card)) : false;
  return { ok: true, buys: history.filter(h => h.date >= from).length, posted, ...(dry ? { card } : {}) };
}
