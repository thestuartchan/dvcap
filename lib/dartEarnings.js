// lib/dartEarnings.js — Samsung Electronics' and SK hynix's earnings dates, from DART.
//
// Korea-listed names are not on Nasdaq's calendar, and the exchange's own IR calendar (KIND)
// refuses scripts. Both companies file with DART, Korea's disclosure system, and OpenDART serves
// those filings through an official API keyed by a free registration (DART_API_KEY, set in the
// deployment and never written anywhere else). Two filings matter:
//
//   기업설명회(IR)개최(안내공시)   an IR-meeting notice, filed about a week ahead. The meeting is
//                                  the earnings call; its date is inside the filing, not in the
//                                  list, so the filing itself is read (document.xml, a ZIP).
//   …(잠정)실적(공정공시)          preliminary results. Samsung files these early in the month after
//                                  quarter end; once filed, that quarter has reported.
//
// SERVER ONLY: this reads ZIPs with node:zlib, so it is imported by lib/calendarAutoFetch.js and
// never by anything the browser bundles (lib/calendarAuto.js is, through lib/calendarView.js).
//
// A date is only emitted when the notice yields exactly one plausible date in the next 60 days.
// Anything less certain is reported by receipt number and left out — a missing row beats a wrong
// one. The route stays public-safe: dates, titles and receipt numbers only, and the key never
// appears in a message.
import { inflateRawSync } from 'node:zlib';
import EARNINGS_WATCH from '../data/earnings_watch.json' with { type: 'json' };

export const DART_WATCH = Object.freeze(EARNINGS_WATCH.dart || []);
const LIST_URL = 'https://opendart.fss.or.kr/api/list.json';
const DOC_URL = 'https://opendart.fss.or.kr/api/document.xml';
export const DART_SOURCE = 'DART (opendart.fss.or.kr)';
const DAY = 86400000;
const ymd = (d) => d.toISOString().slice(0, 10);
const compact = (iso) => iso.replace(/-/g, '');
const pad = (n) => String(n).padStart(2, '0');

// ── The list (list.json) ─────────────────────────────────────────────────────
// { status: '000', list: [{ corp_code, corp_name, report_nm, rcept_no, rcept_dt: 'YYYYMMDD' }] };
// '013' is "no filings in the window", which is an answer, not a failure.
export const isIrNotice = (name) => /기업설명회/.test(String(name || ''));
export const isPrelim = (name) => /잠정/.test(String(name || '')) && /실적/.test(String(name || ''));
export function parseDartList(json) {
  const status = String(json?.status ?? '');
  if (status === '013') return { ok: true, filings: [] };
  if (status !== '000') return { ok: false, error: `DART status ${status || 'missing'}${json?.message ? ` (${String(json.message).slice(0, 80)})` : ''}` };
  const filings = (json.list || []).map(f => ({
    corp: String(f.corp_code || ''), name: String(f.report_nm || '').replace(/\s+/g, ''),
    rcept: String(f.rcept_no || ''), date: /^\d{8}$/.test(String(f.rcept_dt)) ? `${f.rcept_dt.slice(0, 4)}-${f.rcept_dt.slice(4, 6)}-${f.rcept_dt.slice(6, 8)}` : null,
  })).filter(f => f.rcept && f.date);
  return { ok: true, filings };
}

// ── The filing (document.xml is a ZIP) ───────────────────────────────────────
// Read through the central directory, so a data descriptor after a member does not matter. Stored
// (0) and deflated (8) members only, which is what DART serves.
export function unzipEntries(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = b.readUInt16LE(p + 10), size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28), extraLen = b.readUInt16LE(p + 30), commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (b.readUInt32LE(local) !== 0x04034b50) throw new Error('bad local header');
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.slice(start, start + size);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8) out.push({ name, data: inflateRawSync(raw) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
// DART's documents are UTF-8; an older one may be EUC-KR. Whichever decodes without replacement
// characters is used.
export function decodeText(data) {
  const utf = new TextDecoder('utf-8').decode(data);
  if (!/�/.test(utf)) return utf;
  try { return new TextDecoder('euc-kr').decode(data); } catch { return utf; }
}
const textOf = (xml) => String(xml || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// The meeting date: a date right after 일시 / 일자 / 개최, as "2026-10-29", "2026.10.29" or
// "2026년 10월 29일", optionally followed by a time ("10:00", "오후 4시"). Exactly one distinct
// date between today and 60 days out, or nothing.
export function irDateFromText(text, { today }) {
  const t = textOf(text);
  const found = new Map();
  const re = /(일시|일자|개최)[^0-9]{0,30}(\d{4})\s*(?:[-.]\s*|년\s*)(\d{1,2})\s*(?:[-.]\s*|월\s*)(\d{1,2})(?:\s*일(?![시자]))?([^0-9]{0,12}(?:(\d{1,2}):(\d{2})|(오전|오후)\s*(\d{1,2})\s*시))?/g;
  for (const m of t.matchAll(re)) {
    const y = +m[2], mo = +m[3], d = +m[4];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const date = `${y}-${pad(mo)}-${pad(d)}`;
    const ms = Date.parse(`${date}T00:00:00Z`), t0 = Date.parse(`${today}T00:00:00Z`);
    if (!(ms >= t0 && ms <= t0 + 60 * DAY)) continue;
    let time = null;
    if (m[6]) time = `${pad(+m[6])}:${m[7]}`;
    else if (m[8]) { const h = +m[9] + (m[8] === '오후' && +m[9] < 12 ? 12 : 0); time = `${pad(h)}:00`; }
    if (!found.has(date) || (!found.get(date) && time)) found.set(date, time);
  }
  if (found.size !== 1) return null;
  const [[date, time]] = [...found];
  return { date, time };
}

const rowOf = (w, date, title, extra = {}) => ({ date, title, region: w.region || 'ASIA', tier: w.tier ?? 1,
  ...(extra.time ? { time: extra.time, tz: 'Asia/Seoul' } : {}), kind: extra.kind, auto: true, source: DART_SOURCE,
  ...(extra.rcept ? { rcept: extra.rcept } : {}) });

// One company's filings → its rows and what could not be read. `docs` is { rcept_no: text }.
export function dartRows(w, filings = [], docs = {}, { today }) {
  const rows = [], notes = [];
  const mine = filings.filter(f => f.corp === w.corp).sort((a, b) => b.date.localeCompare(a.date) || b.rcept.localeCompare(a.rcept));
  const ir = mine.find(f => isIrNotice(f.name));
  if (ir) {
    const got = docs[ir.rcept] != null ? irDateFromText(docs[ir.rcept], { today }) : null;
    if (got) rows.push(rowOf(w, got.date, `${w.name} earnings (IR call)`, { time: got.time, kind: `earn:${w.code}`, rcept: ir.rcept }));
    else notes.push(`${w.name}: IR notice found, date not read (rcept ${ir.rcept})`);
  }
  const pre = mine.find(f => isPrelim(f.name));
  if (pre) rows.push(rowOf(w, pre.date, `${w.name} preliminary results`, { kind: `earnprelim:${w.code}`, rcept: pre.rcept }));
  return { rows, notes };
}

// ── Fetch ────────────────────────────────────────────────────────────────────
// Per company: the list, then the newest IR notice's document. At most four requests a run, and
// the answer sits in the calendar's 12-hour cache. A key in a message is masked before it is kept.
export async function fetchDartEarnings({ key = process.env.DART_API_KEY, fetchImpl = fetch, now = new Date(), watch = DART_WATCH } = {}) {
  const k = String(key || '').trim();
  if (!k) return { events: [], source: { ok: false, error: 'DART_API_KEY not set' } };
  const mask = (s) => String(s || '').split(k).join('***').slice(0, 140);
  const today = ymd(now), from = compact(ymd(new Date(now.getTime() - 45 * DAY)));
  const events = [], notes = [], failed = [];
  for (const w of watch) {
    try {
      const r = await fetchImpl(`${LIST_URL}?crtfc_key=${encodeURIComponent(k)}&corp_code=${w.corp}&bgn_de=${from}&page_count=100`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) { failed.push(`${w.name}: HTTP ${r.status}`); continue; }
      const list = parseDartList(await r.json());
      if (!list.ok) { failed.push(`${w.name}: ${mask(list.error)}`); continue; }
      const docs = {};
      const ir = list.filings.filter(f => f.corp === w.corp && isIrNotice(f.name)).sort((a, b) => b.rcept.localeCompare(a.rcept))[0];
      if (ir) {
        const d = await fetchImpl(`${DOC_URL}?crtfc_key=${encodeURIComponent(k)}&rcept_no=${ir.rcept}`, { signal: AbortSignal.timeout(15000) });
        const buf = d.ok ? Buffer.from(await d.arrayBuffer()) : null;
        if (buf && buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) {
          docs[ir.rcept] = unzipEntries(buf).map(e => decodeText(e.data)).join(' ');
        }
      }
      const got = dartRows(w, list.filings, docs, { today });
      events.push(...got.rows); notes.push(...got.notes);
    } catch (e) { failed.push(`${w.name}: ${mask(e?.message || e)}`); }
  }
  const source = events.length || (!failed.length)
    ? { ok: true, count: events.length, ...(notes.length ? { notes } : {}), ...(failed.length ? { failed } : {}) }
    : { ok: false, error: failed.join('; ') };
  return { events, source };
}
