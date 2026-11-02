// lib/chinaPmi.js — China's official PMI, read from the National Bureau of Statistics on release day.
//
// THE CHINESE PAGE, NOT THE ENGLISH ONE (2 Nov 2026). NBS posts the monthly PMI release on its
// Chinese "latest releases" list at 09:30 Beijing on the last day of the month; the English copy
// follows about a week later (September's went up on 8 Oct). The Chinese page is plain HTML with
// the figures in fixed sentences, so it is read here:
//   制造业采购经理指数（PMI）为 49.3%，比上月下降 0.8 个百分点   manufacturing PMI, change
//   新订单指数为 49.4%                                         manufacturing new orders
//   非制造业商务活动指数为 49.7%，比上月下降 0.5 个百分点         non-manufacturing
//   综合PMI产出指数为 49.7%                                     composite output
// A sentence that does not match leaves its field null; the release is used only when the
// manufacturing headline itself was read.
import { kvGetJson, kvSetJsonEx, kvConfigured } from './kv.js';

export const NBS_LIST_URL = 'https://www.stats.gov.cn/sj/zxfb/';
const UA = 'Mozilla/5.0 (compatible; dvcap-china/1.0)';
const CACHE_KEY = 'dvcap:china:pmi:v1';
const CACHE_S = 6 * 3600;

const TITLE = /(\d{4})年(\d{1,2})月中国采购经理指数运行情况/;

// The newest PMI release on the list page → { url, period: 'YYYY-MM' } or null.
export function pmiLinkFromList(html, base = NBS_LIST_URL) {
  const re = /href="([^"]+)"[^>]*title='([^']*)'|href="([^"]+)"[^>]*title="([^"]*)"/g;
  for (const m of String(html || '').matchAll(re)) {
    const href = m[1] || m[3], title = m[2] || m[4];
    const t = TITLE.exec(title || '');
    if (!t) continue;
    return { url: new URL(href, base).toString(), period: `${t[1]}-${String(t[2]).padStart(2, '0')}` };
  }
  return null;
}

const text = (html) => String(html || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, '');                    // the figures are spaced inconsistently; read without spaces
// "比上月下降 0.8" → −0.8, "比上月上升 0.4" → +0.4, "与上月持平" (unchanged) → 0, nothing said → null.
const change = (m) => (m[4] === '持平' ? 0 : m[2] && m[3] != null ? (m[2] === '下降' ? -1 : 1) * Number(m[3]) : null);

// One release page → { period, published, manufacturing, mfgChange, newOrders, nonMfg, nonMfgChange, composite }
// or null when the manufacturing headline is not there.
export function pmiFromRelease(html) {
  const s = text(html);
  const title = TITLE.exec(s);
  const mfg = /制造业采购经理指数（PMI）为([\d.]+)%(?:，(?:比上月(上升|下降)([\d.]+)|与上月(持平)))?/.exec(s);
  if (!title || !mfg) return null;
  const num = (re) => { const m = re.exec(s); return m ? Number(m[1]) : null; };
  const non = /非制造业商务活动指数为([\d.]+)%(?:，(?:比上月(上升|下降)([\d.]+)|与上月(持平)))?/.exec(s);
  const pub = /name="PubDate"content="(\d{4})\/(\d{2})\/(\d{2})/.exec(String(html || '').replace(/\s+/g, ''));
  return {
    period: `${title[1]}-${String(title[2]).padStart(2, '0')}`,
    published: pub ? `${pub[1]}-${pub[2]}-${pub[3]}` : null,
    manufacturing: Number(mfg[1]),
    mfgChange: change(mfg),
    newOrders: num(/新订单指数为([\d.]+)%/),
    nonMfg: non ? Number(non[1]) : null,
    nonMfgChange: non ? change(non) : null,
    composite: num(/综合PMI产出指数为([\d.]+)%/),
  };
}

// Fetch the latest release, six hours in KV. { ok, ...pmi, source } or { ok: false, error }.
export async function fetchChinaPmi({ fetchImpl = fetch, kv = kvConfigured() } = {}) {
  if (kv) {
    try { const c = await kvGetJson(CACHE_KEY); if (c?.ok) return { ...c, cache: 'kv' }; } catch { /* a miss */ }
  }
  try {
    const get = async (url) => {
      const r = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
      return r.text();
    };
    const link = pmiLinkFromList(await get(NBS_LIST_URL));
    if (!link) throw new Error('no PMI release on the NBS list page');
    const pmi = pmiFromRelease(await get(link.url));
    if (!pmi) throw new Error('the PMI release did not read — its wording may have changed');
    const out = { ok: true, ...pmi, source: link.url };
    if (kv) { try { await kvSetJsonEx(CACHE_KEY, out, CACHE_S); } catch { /* uncached is slower, not wrong */ } }
    return out;
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}
