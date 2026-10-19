#!/usr/bin/env node
// scripts/supplychain-build.mjs — the supplier / customer / competitor map, read from filings.
//
//   SEC_USER_AGENT="Your Name you@example.com" node scripts/supplychain-build.mjs [TICKER ...]
//
// For each company in lib/supplyChain.js SC_UNIVERSE (or the tickers given): find its latest
// annual report on EDGAR (10-K, or 20-F / 40-F for a foreign filer), read the primary document raw,
// and keep the links lib/supplyChain.js extractLinks finds in it, each with the filing and the
// sentence. A 10-K filer's latest 10-Q, when it was filed after that 10-K, is read the same way and
// laid on top (mergeQuarter): customer shares change every quarter. Foreign filers report half-
// yearly on 6-K with no fixed form, so they are annual only. Writes data/supplychain.json. Prints
// counts only.
//
//   --if-newer   read only the companies whose latest annual report or 10-Q on EDGAR is newer than
//                the one stored, and leave the file untouched when none is (the weekly job).
//
// SEC FAIR ACCESS. EDGAR refuses document requests whose User-Agent carries no contact address,
// and asks for at most ten requests a second. The contact is the person running the script, so it
// comes from SEC_USER_AGENT and is never written into the repository or the output. Requests are
// spaced 200 ms apart.
//
// A company keeps its previous links when its fetch fails this run (listed under `missing` with
// the reason), so one bad night does not empty the map.
import fs from 'node:fs';
import { SC_UNIVERSE, filingText, extractLinks, mergeQuarter } from '../lib/supplyChain.js';

const OUT = new URL('../data/supplychain.json', import.meta.url);
const UA = String(process.env.SEC_USER_AGENT || '').trim();
if (!/@/.test(UA)) {
  console.error('SEC_USER_AGENT must name a contact, e.g. "Jane Doe jane@example.com" (SEC fair-access policy). Nothing fetched.');
  process.exit(2);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let last = 0;
async function get(url, as = 'text') {
  const wait = 200 - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  last = Date.now();
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.replace(/^https:\/\/[^/]+/, '')}`);
  return as === 'json' ? r.json() : r.text();
}

const ANNUAL = new Set(['10-K', '20-F', '40-F']);
const args = process.argv.slice(2);
const ifNewer = args.includes('--if-newer');
const named = args.filter(a => !a.startsWith('--')).map(t => t.toUpperCase());
const tickers = named.length ? named : SC_UNIVERSE;
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { companies: {} };

const map = await get('https://www.sec.gov/files/company_tickers.json', 'json');
const cikOf = Object.fromEntries(Object.values(map).map(r => [String(r.ticker).toUpperCase(), r.cik_str]));

const companies = { ...(prev.companies || {}) };
const missing = { ...(ifNewer ? prev.missing || {} : {}) };
const filingAt = (cik, r, i) => {
  const acc = r.accessionNumber[i];
  return { form: r.form[i], accession: acc, url: `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/${r.primaryDocument[i]}`, date: r.filingDate[i] };
};
let read = 0;
for (const t of tickers) {
  try {
    const cik = cikOf[t.replace('.', '-')] ?? cikOf[t];
    if (!cik) throw new Error('no CIK for this ticker on EDGAR');
    const sub = await get(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`, 'json');
    const r = sub.filings?.recent || {};
    const i = (r.form || []).findIndex(f => ANNUAL.has(f));
    if (i < 0) throw new Error('no annual report in the recent filings');
    const filing = filingAt(cik, r, i);
    const q = filing.form === '10-K' ? (r.form || []).findIndex(f => f === '10-Q') : -1;
    const quarter = q >= 0 && r.filingDate[q] > filing.date ? filingAt(cik, r, q) : null;
    const had = prev.companies?.[t];
    if (ifNewer && had && had.filing?.accession === filing.accession && (had.quarter?.accession || null) === (quarter?.accession || null)) continue;
    const links = extractLinks(filingText(await get(filing.url)), { filer: t, filing });
    const qLinks = quarter ? extractLinks(filingText(await get(quarter.url)), { filer: t, filing: quarter }) : [];
    const merged = quarter ? mergeQuarter(links, qLinks) : links;
    companies[t] = { cik, name: sub.name, asOf: quarter?.date || filing.date, filing, ...(quarter ? { quarter } : {}), links: merged };
    delete missing[t];
    read++;
    console.log(`${t}: ${filing.form} ${filing.date}${quarter ? ` + 10-Q ${quarter.date}` : ''} · ${merged.filter(l => l.named).length} named, ${merged.filter(l => !l.named).length} anonymised`);
  } catch (e) {
    missing[t] = String(e?.message || e);
    console.log(`${t}: not read (${missing[t]})`);
  }
}
if (ifNewer && !read) { console.log('no newer filing for any company; file unchanged'); process.exit(0); }

const out = {
  _README: 'Supplier, customer and competitor links read from each company\'s own latest annual report on EDGAR, plus its latest 10-Q when filed after it (scripts/supplychain-build.mjs; method in docs/supply-chain.md). Each link quotes the sentence and names the filing it came from. relation = what the counterparty is to the filer. named=false is an anonymised customer as the filing states it.',
  _generated: new Date().toISOString(),
  companies: Object.fromEntries(Object.entries(companies).sort(([a], [b]) => a.localeCompare(b))),
  missing,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
const all = Object.values(out.companies).flatMap(c => c.links || []);
console.log(`\n${Object.keys(out.companies).length} companies · ${all.filter(l => l.named).length} named links · ${all.filter(l => !l.named).length} anonymised · ${Object.keys(missing).length} not read`);
