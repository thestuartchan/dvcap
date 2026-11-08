// lib/disclosures.js — politicians' and insiders' trades, read from the filings themselves.
//
// WHY (8 Nov 2026). Stu asked how close to "real time" congressional trades can get. By law they
// can't be: a member has up to 45 days to file, and every vendor (Unusual Whales, Quiver, Capitol
// Trades, FMP) scrapes the same official filing. The earliest public moment is the filing itself,
// so this reads the House Clerk's index directly every hour and posts what is new — hours ahead of
// the vendors, never ahead of the law. Corporate insiders (SEC Form 4, due in two business days)
// are the faster signal, so a weekly read of Form 4s on the watchlist sits beside it.
//
// FILTERED, NOT A FIREHOSE. Most filings are $1k–15k noise. A congressional trade is posted when it
// is on the watchlist, is $250k+ at the bottom of its band, is an option, belongs to a cluster
// (3+ members, same ticker, same side, 30 days) or was filed more than 45 days late. A Form 4 is
// reported when it is an open-market buy (code P) on the watchlist, an open-market sale of $1M+
// not under a 10b5-1 plan, or one of 2+ insiders buying the same issuer in the window.
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

// What a week of Form 4s on the watchlist adds up to: buys always, big unplanned sales, clusters.
export function insiderDigest(forms, { watch = new Set() } = {}) {
  const buys = [], sales = [];
  for (const f of forms) {
    const p = f.txns.filter(t => t.code === 'P'), s = f.txns.filter(t => t.code === 'S');
    const pv = p.reduce((a, t) => a + t.value, 0), sv = s.reduce((a, t) => a + t.value, 0);
    if (p.length && watch.has(f.ticker)) buys.push({ ...f, value: pv, date: p[0].date });
    if (s.length && sv >= SELL_MIN_USD && !f.plan) sales.push({ ...f, value: sv, date: s[0].date });
  }
  const byTicker = {};
  for (const b of buys) (byTicker[b.ticker] ??= new Set()).add(b.owner);
  const clusters = Object.entries(byTicker).filter(([, s]) => s.size >= 2).map(([t, s]) => ({ ticker: t, insiders: s.size }));
  return { buys: buys.sort((a, b) => b.value - a.value), sales: sales.sort((a, b) => b.value - a.value), clusters };
}

const usd = (n) => n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${n}`;
export function insiderCard(d, { from, to } = {}) {
  const lines = [];
  if (d.clusters.length) lines.push(`**Clusters** · ${d.clusters.map(c => `${c.ticker} (${c.insiders} insiders buying)`).join(' · ')}`);
  for (const b of d.buys.slice(0, 15)) lines.push(`🟢 **${b.ticker}** BUY ${usd(b.value)} · ${b.owner} (${b.role}) · ${b.date}`);
  for (const s of d.sales.slice(0, 10)) lines.push(`🔴 **${s.ticker}** SELL ${usd(s.value)} · ${s.owner} (${s.role}) · ${s.date} · no 10b5-1 plan`);
  return { embeds: [{
    title: `📑 Insider Form 4s on the watchlist — ${from} to ${to}`, color: 0x2ecc71,
    description: (lines.length ? lines.join('\n') : 'No open-market insider buys on the watchlist, and no unplanned sales over $1M.').slice(0, 4000),
    footer: { text: 'SEC Form 4 (open-market P/S codes only; grants, exercises and gifts left out) · public filings, research only' },
  }], allowed_mentions: { parse: [] } };
}

// ── WATCHLIST ────────────────────────────────────────────────────────────────
// US tickers only: dvcap's book symbols (HK/AE/futures dropped) plus DISCLOSURES_WATCHLIST.
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

// The weekly Form 4 read over the watchlist. cikOf(ticker) → CIK or null; ua = SEC contact.
export async function runInsiders({ now = new Date(), fetchImpl = fetch, cikOf, ua, deliver, watch = new Set(), lookbackDays = 7, dry = false }) {
  if (!ua) return { ok: false, why: 'SEC contact not configured (SEC_USER_AGENT)' };
  const h = { headers: { 'User-Agent': ua, Accept: 'application/json, application/xml' } };
  const from = new Date(now.getTime() - lookbackDays * 864e5).toISOString().slice(0, 10), to = now.toISOString().slice(0, 10);
  const forms = [];
  let tickers = 0, read = 0;
  for (const t of [...watch].slice(0, 80)) {
    const cik = await cikOf(t);
    if (!cik) continue;
    tickers++;
    try {
      const r = await fetchImpl(SUBS_URL(cik), { ...h, signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const rec = (await r.json())?.filings?.recent || {};
      for (let i = 0; i < (rec.form || []).length && i < 200; i++) {
        if (rec.form[i] !== '4' || rec.filingDate[i] < from) continue;
        const doc = String(rec.primaryDocument[i] || '').replace(/^xsl[^/]+\//, '');
        const u = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(rec.accessionNumber[i]).replace(/-/g, '')}/${doc}`;
        const x = await fetchImpl(u, { ...h, signal: AbortSignal.timeout(15000) });
        if (x.ok) { forms.push(parseForm4(await x.text())); read++; }
        await new Promise(res => setTimeout(res, 120));       // SEC fair access: well under 10/s
      }
    } catch { /* one issuer failing never stops the rest */ }
  }
  const d = insiderDigest(forms, { watch });
  const card = insiderCard(d, { from, to });
  const posted = !dry && deliver ? !!(await deliver(card)) : false;
  return { ok: true, tickers, forms: read, buys: d.buys.length, sales: d.sales.length, clusters: d.clusters.length, posted, ...(dry ? { card } : {}) };
}
