// lib/uaeHolidays.js — DFM / ADX closures, from the exchange's own circulars.
//
// WHY THIS IS NOT exchange_calendars. That library has no Gulf calendar, and it could not have the
// one that matters: Eid, Arafat Day, the Hijri New Year and the Prophet's Birthday follow the moon,
// and the UAE confirms each a few days ahead. So the year is read in two passes, both from DFM:
//
//   1. THE ANNUAL CIRCULAR (late December): "Trading and Settlement Holidays for the Calendar Year
//      YYYY for Securities Market". A table of dates; the Islamic ones carry an asterisk — "may vary
//      and are subject to change". Starred dates are TENTATIVE; the rest are closures.
//   2. THE ONE-OFF CIRCULARS, a few days before each moon holiday: "DFM will be closed from
//      Tuesday, May 26, 2026, to Sunday, May 31, 2026" or "the Market will be closed on Friday,
//      28th of August 2026". These CONFIRM, and replace the tentative dates for the same occasion —
//      2026's annual list had the Prophet's Birthday on 25 Aug; the market closed on the 28th.
//
// Before DFM's annual circular for a year is out, the UAE public-holiday calendar (Google's public
// feed, which marks unconfirmed dates "(tentative)") gives that year's dates as TENTATIVE only.
//
// TENTATIVE IS NOT CLOSED. lib/sessions.js marks a session 'holiday' only on a `closed` date — a
// wrong closed date mislabels a real session, a missing one only degrades. Tentative dates are kept
// beside them so Data health can say what is coming and when it was last checked.
//
// ADX: DFM and ADX close together under the SCA's announcements; ADX's site is not readable from
// here, so DFM's circulars stand for both.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dow = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
export const isWeekday = (d) => { const w = dow(d); return w >= 1 && w <= 5; };
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();

// The occasion a line or circular is about, so a confirmation replaces the right tentative dates.
export function occasionOf(text) {
  const t = String(text || '').toLowerCase();
  if (/fitr/.test(t)) return 'eid-al-fitr';
  if (/adha|arafa|haj/.test(t)) return 'eid-al-adha';
  if (/hijri|hijra|islamic new year/.test(t)) return 'hijri-new-year';
  if (/prophet|mawlid|mouloud|mol?ulid/.test(t)) return 'prophet-birthday';
  if (/national day|commemoration|martyr/.test(t)) return 'national-day';
  if (/new year/.test(t)) return 'new-year';
  return 'other';
}

// "May 26, 2026" · "28th of August 2026" · "26 May 2026" → YYYY-MM-DD, the first real date in s.
const monthNum = (w) => { const k = String(w).toLowerCase(); return MONTHS[k.slice(0, 4)] ?? MONTHS[k.slice(0, 3)] ?? null; };
// Every date in s, in order of appearance.
function datesIn(s) {
  const hits = [];
  for (const m of String(s).matchAll(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/g)) if (monthNum(m[1])) hits.push([m.index, iso(+m[3], monthNum(m[1]), +m[2])]);
  for (const m of String(s).matchAll(/(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9}),?\s+(\d{4})/g)) if (monthNum(m[2])) hits.push([m.index, iso(+m[3], monthNum(m[2]), +m[1])]);
  return [...new Set(hits.sort((a, b) => a[0] - b[0]).map(h => h[1]))];
}
function dateIn(s) {
  for (const m of String(s).matchAll(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/g)) if (monthNum(m[1])) return iso(+m[3], monthNum(m[1]), +m[2]);
  for (const m of String(s).matchAll(/(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9}),?\s+(\d{4})/g)) if (monthNum(m[2])) return iso(+m[3], monthNum(m[2]), +m[1]);
  return null;
}

// ── 1. THE ANNUAL CIRCULAR ───────────────────────────────────────────────────
// Rows read "19-Mar-2026 Thursday EID AL FITR*". Returns [{ date, name, tentative }].
export function parseAnnual(text) {
  const out = [];
  const re = /(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+([A-Z'’ ()&-]+?)(\*?)(?=\s+\d{1,2}\s+\d{1,2}-[A-Za-z]{3}-|\s+\*|\s*$|\s+\d{1,2}-[A-Za-z]{3}-)/g;
  for (const m of clean(text).matchAll(re)) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (!mon) continue;
    out.push({ date: iso(+m[3], mon, +m[1]), name: clean(m[4]).replace(/\s+\d+$/, ''), tentative: m[5] === '*' });
  }
  return out;
}
export const isAnnualCircular = (headline) => /holidays for the calendar year\s+\d{4}/i.test(headline || '') && !/derivative/i.test((headline || '').replace(/excluding derivatives?/i, ''));
export const annualYear = (headline) => +((headline || '').match(/calendar year\s+(\d{4})/i)?.[1] || 0) || null;

// ── 2. A ONE-OFF CIRCULAR ────────────────────────────────────────────────────
// "closed from <date> to <date>" or "closed on <date>". Returns the closed dates (weekends dropped,
// since lib/sessions.js already closes them) and the occasion, or null when no dates can be read.
export function parseOneOff(text) {
  const t = clean(text);
  // The closure clause: from "closed" to the resumption (or the sentence's end) — the resume date
  // is never a closure.
  const clause = t.match(/closed\b(.*?)(?:\bresum|\bofficial working|\bbusiness operations|(?<!\d)\.\s|$)/i)?.[1] || '';
  const range = clause.match(/from\s+(.+?)\s+(?:to|until|till)\s+(.+)/i);
  let dates = [];
  if (range && dateIn(range[1]) && dateIn(range[2])) {
    const from = dateIn(range[1]), to = dateIn(range[2]);
    for (let d = from; d <= to && dates.length < 15; d = addDays(d, 1)) dates.push(d);
  } else dates = datesIn(clause);
  const days = dates.filter(isWeekday);
  if (!dates.length) return null;
  return { from: dates[0], to: dates[dates.length - 1], dates: days, occasion: occasionOf(t) };
}
export const isOneOffCircular = (headline) => /holiday/i.test(headline || '') && !/calendar year/i.test(headline || '') && !/expiry|settlement date/i.test(headline || '');

// ── THE UAE PUBLIC-HOLIDAY FEED (ICS) ────────────────────────────────────────
// Public holidays only (observances are not days off), not the public-sector-only days.
export function parseIcs(ics) {
  const s = String(ics || '').replace(/\r?\n[ \t]/g, '');
  const out = [];
  for (const ev of s.split('BEGIN:VEVENT').slice(1)) {
    const d = ev.match(/DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})/);
    const name = clean(ev.match(/SUMMARY:(.*)/)?.[1]);
    const desc = ev.match(/DESCRIPTION:(.*)/)?.[1] || '';
    if (!d || !/public holiday/i.test(desc) || /public sector/i.test(name)) continue;
    out.push({ date: `${d[1]}-${d[2]}-${d[3]}`, name: name.replace(/\s*\(tentative\)\s*/i, ''), tentative: /tentative/i.test(name) || /tentative/i.test(desc) });
  }
  return out;
}

// ── THE YEAR, FROM ALL THREE ─────────────────────────────────────────────────
// circulars: [{ no, date, headline, text }] from DFM; ics: the feed's text. Returns
// { closed: [...], tentative: [...], names: { date: name }, basis: { year: 'dfm-annual' | 'feed' } }.
export function uaeCalendar({ circulars = [], ics = '', today = new Date().toISOString().slice(0, 10) } = {}) {
  const closed = new Map(), tentative = new Map(), basis = {};
  const annualYears = new Set();
  for (const c of circulars.filter(c => isAnnualCircular(c.headline))) {
    const y = annualYear(c.headline);
    if (!y) continue;
    annualYears.add(y); basis[y] = 'dfm-annual';
    for (const r of parseAnnual(c.text)) {
      if (!isWeekday(r.date)) continue;
      (r.tentative ? tentative : closed).set(r.date, { name: r.name, occasion: occasionOf(r.name), from: `DFM ${c.no}`, annual: true });
    }
  }
  // A year DFM has not published yet: the public calendar, as tentative only.
  for (const r of parseIcs(ics)) {
    const y = +r.date.slice(0, 4);
    if (annualYears.has(y) || !isWeekday(r.date) || r.date < today) continue;
    basis[y] = basis[y] || 'feed';
    if (!closed.has(r.date)) tentative.set(r.date, { name: r.name, occasion: occasionOf(r.name), from: 'UAE public calendar' });
  }
  // Confirmations, oldest first: each replaces the dates the annual list (or the feed) gave its
  // occasion within 14 days — starred or not: 2026's Prophet's Birthday was listed unstarred on
  // 25 Aug and moved to the 28th.
  const ones = circulars.filter(c => isOneOffCircular(c.headline)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const c of ones) {
    const p = parseOneOff(c.text);
    if (!p) continue;
    const near = (d, v) => v.occasion === p.occasion && Math.abs((Date.parse(d) - Date.parse(p.from)) / 864e5) <= 14;
    for (const [d, v] of [...tentative]) if (near(d, v)) tentative.delete(d);
    for (const [d, v] of [...closed]) if (v.annual && near(d, v) && !p.dates.includes(d)) closed.delete(d);
    for (const d of p.dates) { closed.set(d, { name: c.headline.replace(/^.*?due to\s+(the\s+)?/i, ''), occasion: p.occasion, from: `DFM ${c.no}` }); tentative.delete(d); }
  }
  const names = {};
  for (const [d, v] of [...closed, ...tentative]) names[d] = `${v.name} · ${v.from}`;
  return { closed: [...closed.keys()].sort(), tentative: [...tentative.keys()].filter(d => d >= today).sort(), names, basis };
}

// ── INTO data/holidays.json ──────────────────────────────────────────────────
// The UAE key is the script's own, with one exception: a closed date a person added by hand (one
// this has never written) is kept. A date this wrote that the circulars no longer support is
// removed if it is still ahead — a moved Eid must not leave its old day closed — and kept if past.
export function mergeUae(file, cal, { today = new Date().toISOString().slice(0, 10), checkedAt = new Date().toISOString() } = {}) {
  const f = { ...(file || {}) };
  const prev = f.UAE || { closed: [], half: [] };
  const managed = new Set(f._uae?.managed || []);
  const hand = (prev.closed || []).filter(d => !managed.has(d));
  const keptPast = (prev.closed || []).filter(d => managed.has(d) && d < today && !cal.closed.includes(d));
  const closed = [...new Set([...hand, ...keptPast, ...cal.closed])].sort();
  f.UAE = { closed, half: prev.half || [], tentative: cal.tentative.filter(d => !closed.includes(d)) };
  f._uae = {
    source: 'DFM circulars (annual calendar + one-off holiday circulars); UAE public calendar for years DFM has not published',
    checkedAt, basis: cal.basis, managed: [...new Set([...keptPast, ...cal.closed])].sort(),
    names: Object.fromEntries(Object.entries(cal.names).filter(([d]) => closed.includes(d) || f.UAE.tentative.includes(d)).sort()),
  };
  const before = JSON.stringify({ c: prev.closed || [], t: prev.tentative || [] });
  return { file: f, changed: before !== JSON.stringify({ c: f.UAE.closed, t: f.UAE.tentative }) };
}

// ── WHEN TO LOOK ─────────────────────────────────────────────────────────────
// Every day within three weeks of a tentative date (when the confirming circular lands), every day
// in December and January (the annual circular), otherwise once a week.
export function checkDue(file, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const last = String(file?._uae?.checkedAt || '').slice(0, 10);
  if (!last) return { due: true, why: 'never checked' };
  const ageDays = (Date.parse(today) - Date.parse(last)) / 864e5;
  const soon = (file?.UAE?.tentative || []).find(d => d >= today && (Date.parse(d) - Date.parse(today)) / 864e5 <= 21);
  if (soon) return { due: ageDays >= 1, why: `tentative holiday ${soon} within three weeks` };
  const mon = +today.slice(5, 7);
  if (mon === 12 || mon === 1) return { due: ageDays >= 1, why: 'annual-circular season' };
  return { due: ageDays >= 7, why: 'weekly check' };
}
