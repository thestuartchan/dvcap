// lib/koreaFetch.js — read KOFIA and the KRX investor-flow widget and merge them into the Korea
// store. One routine for both callers: the scheduled run (scripts/korea-fetch.mjs, which writes the
// file and lets the workflow commit it) and the panel's Fetch now button (api/korea-save.js
// ?fetch=1, which commits through the Contents API).
//
// SAFE BY DEFAULT. Nothing is merged from a source unless every check passes for it:
//   KOFIA — the page parses through parseKofia's recompute-% guard and the unit gate.
//   KRX   — a flow table is only stored once it is final: an earlier Seoul date, or today's after
//           15:45. A read of an intraday partial is skipped, not stored.
// Each source is independent: KRX failing does not stop KOFIA, and the reverse.
//
// THE LAST FETCH IS RECORDED, whether or not it changed anything. The as-of date on each reading
// says how old the figure is; only this says when anyone last looked, and whether the look worked.
import { kofiaFromHtml, krxFlowsFromJson, flowIsFinal, KOFIA_MAIN_URL, KRX_MAIN_URL, KRX_FLOW_URL } from './koreaAuto.js';
import { unitProblems, applyKofia, applyFlows, appendSnapshot, storeChanged, FLOW_KEYS, KOSDAQ_FLOW_KEYS } from './koreaStore.js';

const UA = 'Mozilla/5.0 (compatible; dvcap-korea/1.0)';

async function get(fetchImpl, url, init = {}) {
  const r = await fetchImpl(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers || {}) }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r;
}

// The widget's request needs the session cookie the front page sets — the same thing a browser
// sends. No login is involved; the page is public.
async function readKrx(fetchImpl) {
  const page = await get(fetchImpl, KRX_MAIN_URL);
  const cookie = (page.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const one = async (mktId) => {
    const r = await get(fetchImpl, KRX_FLOW_URL, { method: 'POST',
      headers: { Cookie: cookie, Referer: KRX_MAIN_URL, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: `mktId=${mktId}` });
    return krxFlowsFromJson(await r.json());
  };
  return { kospi: await one('STK'), kosdaq: await one('KSQ') };
}

// Mutates `store` (already normalised). Returns what happened, source by source, and stamps
// store.lastFetch with it.
export async function fetchKoreaInto(store, { now = new Date(), by = 'schedule', fetchImpl = fetch } = {}) {
  const before = JSON.parse(JSON.stringify(store));
  const snapshot = {}, report = [];
  const sources = { kofia: null, krx: null };

  try {
    const html = await (await get(fetchImpl, KOFIA_MAIN_URL)).text();
    const k = kofiaFromHtml(html, now);
    if (!k.list.length) throw new Error('no KOFIA rows found — the page layout may have changed');
    if (k.anyMismatch) throw new Error(`recomputed % disagrees with the page for ${k.list.filter(f => f.mismatch).map(f => f.key).join(', ')} — nothing saved from KOFIA`);
    const problems = unitProblems(k.list, store.latest);
    if (problems.length) throw new Error(`unit check failed: ${problems.map(p => `${p.key} ${p.error}`).join('; ')}`);
    // "updated" means a reading actually moved — applyKofia names every key it applied, changed or not.
    const was = JSON.parse(JSON.stringify(store));
    applyKofia(store, k.list, snapshot);
    report.push(`KOFIA: ${k.list.map(f => `${f.key} ${f.asOf}`).join(', ')}${k.missing.length ? ` · missing ${k.missing.join(', ')}` : ''}`);
    sources.kofia = storeChanged(was, store) ? 'updated' : 'nothing new';
    if (sources.kofia === 'nothing new') report.push('KOFIA: nothing new');
  } catch (e) { sources.kofia = 'failed'; report.push(`KOFIA FAILED — ${e.message}`); }

  try {
    const { kospi, kosdaq } = await readKrx(fetchImpl);
    const states = [];
    for (const [name, flows, keys] of [['KOSPI', kospi, FLOW_KEYS], ['KOSDAQ', kosdaq, KOSDAQ_FLOW_KEYS]]) {
      if (!flows) { states.push('failed'); report.push(`KRX ${name} FAILED — the widget's answer was not the expected shape`); continue; }
      if (!flowIsFinal(flows.date, now)) { states.push('in session'); report.push(`KRX ${name}: ${flows.date} is still in session — skipped`); continue; }
      const was = JSON.parse(JSON.stringify(store));
      applyFlows(store, flows, keys, snapshot);
      states.push(storeChanged(was, store) ? 'updated' : 'nothing new');
      report.push(`KRX ${name}: ${flows.date} foreign ${flows.foreignNet} · inst ${flows.instNet} · retail ${flows.retailNet} (십억원)`);
    }
    sources.krx = states.includes('failed') ? 'failed' : states.includes('updated') ? 'updated' : states.includes('in session') ? 'in session' : 'nothing new';
  } catch (e) { sources.krx = 'failed'; report.push(`KRX FAILED — ${e.message}`); }

  const changed = storeChanged(before, store);
  if (changed) appendSnapshot(store, snapshot, now.toISOString());
  const failed = sources.kofia === 'failed' || sources.krx === 'failed';
  store.lastFetch = { at: now.toISOString(), by, ok: !failed, changed, sources, report: report.slice(0, 8) };
  return { changed, failed, sources, report };
}

// "16:12 KST, 2 Oct" — the panel's header line.
export function seoulStamp(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return `${p.hour}:${p.minute} KST, ${p.day} ${p.month}`;
}
