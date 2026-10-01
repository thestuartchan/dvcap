// lib/koreaAuto.js — the Korea manual entry, read from its two sources instead of pasted.
//
// WHAT WAS PASTED, AND WHERE IT COMES FROM
//   KOFIA freesis (freesis.kofia.or.kr/stat/main.do) — the front page lists margin loans,
//     investor deposits, CMA, KOSPI and the KR 3Y yields, each with its unit, its own MM/DD date,
//     the level, the change and the % change. That block is exactly what used to be copied.
//   KRX Data Marketplace — the front page's 투자자별 매매동향 widget answers from
//     getJsonData.cmd?bld=dbms/MDC/MAIN/MDCMAIN00103 with mktId=STK (KOSPI) or KSQ (KOSDAQ):
//     the latest session's sell, buy and net per actor, in 십억원, with its trade date.
//
// SAME CHECKS AS A PASTE. The KOFIA page is turned back into the paste's own three-line format and
// run through lib/kofia.js parseKofia, so the recompute-% guard and the unit gate that protect a
// hand paste protect this too — a page that changed shape fails the same way a bad paste does.
// Nothing here writes; lib/koreaStore.js merges, and scripts/korea-fetch.mjs commits.

import { parseKofia, KOFIA_LABELS } from './kofia.js';

export const KOFIA_MAIN_URL = 'https://freesis.kofia.or.kr/stat/main.do';
export const KRX_MAIN_URL = 'https://data.krx.co.kr/contents/MDC/MAIN/main/index.cmd';
export const KRX_FLOW_URL = 'https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd?bld=dbms/MDC/MAIN/MDCMAIN00103';
// KRX's cash market closes 15:30 Seoul; the widget is final a little after. A read before this is
// an intraday partial and is never stored as the day's flow.
export const KRX_FINAL_AFTER_KST = '15:45';

const text = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// The front page → the paste format parseKofia reads:
//   * [신용융자](#)
//   백만원 | 09/30
//   33,390,129 470,124 1.43%
// Only the labels the Korea gate maps are emitted; everything else on the page is ignored.
export function kofiaPasteFromHtml(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<dl>([\s\S]*?)<\/dl>/g)) {
    const block = m[1];
    const label = text((/class="chart-name"[^>]*>([\s\S]*?)<\/dt>/.exec(block) || [])[1]);
    if (!KOFIA_LABELS[label]) continue;
    const unit = text((/class="dan"[^>]*>([\s\S]*?)<\/span>/.exec(block) || [])[1]);
    const date = text((/class="date"[^>]*>([\s\S]*?)<\/span>/.exec(block) || [])[1]);
    const n1 = text((/class="num1"[^>]*>([\s\S]*?)<\/span>/.exec(block) || [])[1]);
    // num2a is a rise, num2b a fall; the fall already carries its minus sign.
    const n2 = text((/class="num2[ab]?"[^>]*>([\s\S]*?)<\/span>/.exec(block) || [])[1]);
    const n3 = text((/class="num3"[^>]*>([\s\S]*?)<\/span>/.exec(block) || [])[1]);
    if (!unit || !date || !n1) continue;
    out.push(`* [${label}](#)`, `${unit} | ${date}`, [n1, n2, n3].filter(Boolean).join(' '));
  }
  return out.join('\n');
}

// The page → parseKofia's result, plus which mapped labels were missing from it.
export function kofiaFromHtml(html, now = new Date()) {
  const paste = kofiaPasteFromHtml(html);
  const parsed = parseKofia(paste, now);
  // parseKofia also recognises flow rows; none can come from this page, but keep only KOFIA keys.
  const keys = new Set(Object.values(KOFIA_LABELS).map(x => x.key));
  const list = (parsed.list || []).filter(f => keys.has(f.key));
  const missing = Object.values(KOFIA_LABELS).map(x => x.key).filter(k => !list.some(f => f.key === k));
  return { list, anyMismatch: list.some(f => f.mismatch), missing, paste };
}

// The KRX widget's JSON → { date, foreignNet, instNet, retailNet } in 십억원. null when the shape
// is not the one expected — a renamed field must not become a zero.
const ACTOR = [[/외국인/, 'foreignNet'], [/기\s*관/, 'instNet'], [/개\s*인/, 'retailNet']];
export function krxFlowsFromJson(json) {
  const rows = json?.output;
  if (!Array.isArray(rows) || !rows.length) return null;
  const out = { date: null, unit: '십억원' };
  for (const r of rows) {
    const hit = ACTOR.find(([re]) => re.test(String(r?.INVST_TP || '')));
    if (!hit) continue;
    if (!/십억원/.test(String(r.INVST_TP))) return null;          // the unit is in the label
    const v = Number(String(r.NETBID_TRDVAL ?? '').replace(/,/g, ''));
    if (!Number.isFinite(v)) return null;
    out[hit[1]] = v;
    const d = String(r.TRD_DD || '');
    if (/^\d{8}$/.test(d)) out.date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }
  if (!out.date || ['foreignNet', 'instNet', 'retailNet'].some(k => out[k] == null)) return null;
  return out;
}

// Seoul wall clock, for the final-after-close rule.
export function seoulClock(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

// A flow read is final when it is for an earlier Seoul date, or today's after the close.
export function flowIsFinal(flowDate, now = new Date()) {
  const { date, time } = seoulClock(now);
  if (!flowDate) return false;
  if (flowDate < date) return true;
  return flowDate === date && time >= KRX_FINAL_AFTER_KST;
}
