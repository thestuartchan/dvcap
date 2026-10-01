#!/usr/bin/env node
// scripts/korea-fetch.mjs — read KOFIA and the KRX investor-flow widget, merge into
// data/korea_kofia.json. Run by .github/workflows/korea-fetch.yml, which commits the file.
//
// Replaces the daily paste for everything except the CSOP 7709 units (CSOP refuses automated
// requests). The paste stays as the fallback, through the same merge (lib/koreaStore.js).
//
// SAFE BY DEFAULT. Nothing is written unless every check passes for that source:
//   KOFIA — the page parses through parseKofia's recompute-% guard and the unit gate. A failure on
//           either writes nothing from KOFIA and exits non-zero, so the workflow goes red.
//   KRX   — a flow table is only stored once it is final: an earlier Seoul date, or today's after
//           15:45. A morning read of an intraday partial is skipped, not stored.
// Each source is independent: KRX failing does not stop KOFIA, and the reverse.
//
//   node scripts/korea-fetch.mjs            fetch, merge, write
//   node scripts/korea-fetch.mjs --dry      fetch and report, write nothing
import { readFileSync, writeFileSync } from 'node:fs';
import { kofiaFromHtml, krxFlowsFromJson, flowIsFinal, KOFIA_MAIN_URL, KRX_MAIN_URL, KRX_FLOW_URL } from '../lib/koreaAuto.js';
import { normaliseStore, unitProblems, applyKofia, applyFlows, appendSnapshot, storeChanged, FLOW_KEYS, KOSDAQ_FLOW_KEYS } from '../lib/koreaStore.js';

const PATH = 'data/korea_kofia.json';
const DRY = process.argv.includes('--dry');
const UA = 'Mozilla/5.0 (compatible; dvcap-korea/1.0)';
const now = new Date();

async function get(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers || {}) }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r;
}

async function readKofia() {
  const html = await (await get(KOFIA_MAIN_URL)).text();
  return kofiaFromHtml(html, now);
}

// The widget's request needs the session cookie the front page sets — the same thing a browser
// sends. No login is involved; the page is public.
async function readKrx() {
  const page = await get(KRX_MAIN_URL);
  const cookie = (page.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const one = async (mktId) => {
    const r = await get(KRX_FLOW_URL, { method: 'POST',
      headers: { Cookie: cookie, Referer: KRX_MAIN_URL, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: `mktId=${mktId}` });
    return krxFlowsFromJson(await r.json());
  };
  return { kospi: await one('STK'), kosdaq: await one('KSQ') };
}

const store = normaliseStore(JSON.parse(readFileSync(PATH, 'utf8')));
const before = JSON.parse(JSON.stringify(store));
const snapshot = {}, report = [];
let failed = false;

try {
  const k = await readKofia();
  if (!k.list.length) throw new Error('no KOFIA rows found — the page layout may have changed');
  if (k.anyMismatch) throw new Error(`recomputed % disagrees with the page for ${k.list.filter(f => f.mismatch).map(f => f.key).join(', ')} — nothing saved from KOFIA`);
  const problems = unitProblems(k.list, store.latest);
  if (problems.length) throw new Error(`unit check failed: ${problems.map(p => `${p.key} ${p.error}`).join('; ')}`);
  const saved = applyKofia(store, k.list, snapshot);
  report.push(`KOFIA: ${k.list.map(f => `${f.key} ${f.asOf}`).join(', ')}${k.missing.length ? ` · missing ${k.missing.join(', ')}` : ''}`);
  if (!saved.length) report.push('KOFIA: nothing new');
} catch (e) { failed = true; report.push(`KOFIA FAILED — ${e.message}`); }

try {
  const { kospi, kosdaq } = await readKrx();
  for (const [name, flows, keys] of [['KOSPI', kospi, FLOW_KEYS], ['KOSDAQ', kosdaq, KOSDAQ_FLOW_KEYS]]) {
    if (!flows) { failed = true; report.push(`KRX ${name} FAILED — the widget's answer was not the expected shape`); continue; }
    if (!flowIsFinal(flows.date, now)) { report.push(`KRX ${name}: ${flows.date} is still in session — skipped`); continue; }
    applyFlows(store, flows, keys, snapshot);
    report.push(`KRX ${name}: ${flows.date} foreign ${flows.foreignNet} · inst ${flows.instNet} · retail ${flows.retailNet} (십억원)`);
  }
} catch (e) { failed = true; report.push(`KRX FAILED — ${e.message}`); }

const changed = storeChanged(before, store);
if (changed) appendSnapshot(store, snapshot, now.toISOString());
for (const line of report) console.log(line);
console.log(changed ? (DRY ? 'changed (dry run — not written)' : `writing ${PATH}`) : 'no change');
if (changed && !DRY) writeFileSync(PATH, JSON.stringify(store, null, 2) + '\n');
process.exit(failed ? 1 : 0);
