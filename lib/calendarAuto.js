// lib/calendarAuto.js — the macro calendar, read from the people who set the dates.
//
// data/calendar.json is kept by hand and ran out on 30 Dec 2026; every month past that showed only
// the weekly claims rule. The dates that matter most are all published ahead by the bodies that set
// them, so they are read from there instead:
//   Federal Reserve   federalreserve.gov FOMC calendar        decision day (the meeting's 2nd day)
//   ECB               ecb.europa.eu Governing Council schedule monetary-policy decision day
//   Bank of Japan     boj.or.jp MPM schedule                  decision day (the meeting's last day)
//   BEA               bea.gov release schedule                GDP, Personal Income and Outlays (PCE)
//   Census            census.gov indicator calendar           retail sales, durable goods, housing starts
//   BLS (via FRED)    FRED's release calendar                 CPI, PPI, payrolls, JOLTS — bls.gov refuses scripts
//   Earnings          Nasdaq's per-symbol earnings date        the names in data/earnings_watch.json; company IR
//                                                             pages refuse scripts. A date the company has not
//                                                             announced is Zacks' estimate and says so ("est.").
//   Korea earnings    OpenDART (lib/dartEarnings.js)          Samsung Electronics and SK hynix: the IR-call
//                                                             date from their IR notice, and preliminary
//                                                             results once filed (needs DART_API_KEY)
//   Latest FOMC       federalreserve.gov statement            the action, the target range and any dissents
//
// Raw pages only, parsed here; no summary of anyone's calendar is trusted in between. Each source is
// read independently and a failure in one is reported by name and costs only that source's rows.
// The parsers are pure — the fetching is the caller's (api/playbook.js), which caches the result.
//
// THE HAND-KEPT LIST STILL WINS. Where data/calendar.json has an event of the same kind on the same
// day, its row (and its wording) is kept and the automatic one is dropped — see kindOf.

import EARNINGS_WATCH from '../data/earnings_watch.json' with { type: 'json' };
import { EARNINGS_NAMES } from './universeAdded.js';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const text = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();
const monthOf = (w) => MONTHS[String(w || '').toLowerCase().replace(/\.$/, '')] || null;

// One event in the shape data/calendar.json uses, marked automatic and with its source.
const ev = (date, title, o) => ({ date, title, region: o.region, tier: o.tier, ...(o.scope ? { scope: o.scope } : {}),
  ...(o.time ? { time: o.time, tz: o.tz } : {}), kind: o.kind, auto: true, source: o.source });

// ── Federal Reserve ──────────────────────────────────────────────────────────
// "<year> FOMC Meetings" panels; each meeting a month cell ("October", "Apr/May") and a date cell
// ("27-28", "16-17*", "30-1*"). The decision is the second day; * marks a Summary of Economic
// Projections. A month cell naming two months puts the second day in the second month.
export function parseFomc(html) {
  const s = String(html || ''), out = [];
  for (const m of s.matchAll(/(\d{4}) FOMC Meetings/g)) {
    const year = +m[1];
    const next = s.indexOf('FOMC Meetings', m.index + 20);
    const seg = s.slice(m.index, next > 0 ? next : m.index + 60000);
    for (const r of seg.matchAll(/fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g)) {
      const months = r[1].split('/').map(x => monthOf(x.trim()));
      const d = /(\d{1,2})\s*[-–]\s*(\d{1,2})(\*)?/.exec(r[2]);
      if (!d || !months[0]) continue;
      const mon = months[months.length - 1];
      const day2 = +d[2], day1 = +d[1];
      if (!mon || !(day2 >= 1 && day2 <= 31)) continue;
      // "Apr/May 30-1": the second day is in the second month. One month and day2 < day1 cannot happen.
      if (months.length === 1 && day2 < day1) continue;
      out.push(ev(iso(year, mon, day2), `FOMC decision${d[3] ? ' + projections (dots)' : ''}`,
        { region: 'US', tier: 1, scope: 'global', time: '14:00', tz: 'America/New_York', kind: 'fomc', source: 'federalreserve.gov' }));
    }
  }
  return out;
}

// ── ECB ──────────────────────────────────────────────────────────────────────
// Rows of "DD/MM/YYYY" then a description. The decision is the monetary-policy meeting's day with
// the press conference ("Day 2), followed by press conference", or a one-day meeting followed by one).
export function parseEcb(html) {
  const t = text(html), out = [];
  for (const m of t.matchAll(/(\d{2})\/(\d{2})\/(\d{4})\s+([^]*?)(?=\s\d{2}\/\d{2}\/\d{4}\s|$)/g)) {
    const desc = m[4];
    if (!/monetary policy meeting/i.test(desc) || /non-monetary/i.test(desc) || !/press conference/i.test(desc)) continue;
    out.push(ev(iso(+m[3], +m[2], +m[1]), 'ECB decision',
      { region: 'EU', tier: 1, scope: 'global', time: '14:15', tz: 'Europe/Berlin', kind: 'ecb', source: 'ecb.europa.eu' }));
  }
  return out;
}

// ── Bank of Japan ────────────────────────────────────────────────────────────
// A table per year ("Table : 2026"); each row's first cell is the meeting ("Oct. 29 (Thurs.), 30
// (Fri.)", or across months "Apr. 30 (Thurs.), May 1 (Fri.)"). The decision is the last day. A row
// that spills into the next year says so ("Jan. 27 (Wed.), 2027").
export function parseBoj(html) {
  const s = String(html || ''), out = [];
  for (const tb of s.matchAll(/Table\s*:\s*(\d{4})([\s\S]*?)<\/table>/g)) {
    const year = +tb[1];
    for (const row of tb[2].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cell = /<td[^>]*>([\s\S]*?)<\/td>/.exec(row[1]);
      if (!cell) continue;
      const c = text(cell[1]).replace(/\[PDF[^\]]*\]/g, '');
      const parts = [...c.matchAll(/(?:([A-Z][a-z]{2,4})\.?\s+)?(\d{1,2})\s*\([A-Za-z.]+\)/g)];
      if (!parts.length) continue;
      let mon = null;
      for (const p of parts) if (p[1]) mon = monthOf(p[1]);
      const last = parts[parts.length - 1];
      const yr = /,\s*(\d{4})\s*$/.exec(c) ? +/,\s*(\d{4})\s*$/.exec(c)[1] : year;
      if (!mon) continue;
      out.push(ev(iso(yr, mon, +last[2]), 'BoJ decision',
        { region: 'ASIA', tier: 1, scope: 'global', kind: 'boj', source: 'boj.or.jp' }));
    }
  }
  // The same table is sometimes repeated (e.g. a printable copy); one row per date.
  return [...new Map(out.map(e => [e.date, e])).values()];
}

// ── BEA ──────────────────────────────────────────────────────────────────────
// A table headed "Year YYYY": each row a release date ("October 29"), a time ("8:30 AM") and a title.
const BEA_KEEP = [
  // "GDP (Advance Estimate), 3rd Quarter" — not "GDP by County…", which is annual and regional.
  { re: /^GDP \(/i, title: (t) => `US GDP (${/advance/i.test(t) ? 'advance' : /second/i.test(t) ? 'second' : /third/i.test(t) ? 'third' : 'estimate'})`, tier: 1, kind: 'gdp' },
  { re: /Personal Income and Outlays/i, title: () => 'US PCE inflation (Personal Income and Outlays)', tier: 1, kind: 'pce' },
];
const to24 = (t) => { const m = /(\d{1,2}):(\d{2})\s*([AP])M/i.exec(t || ''); if (!m) return null; let h = +m[1] % 12; if (/p/i.test(m[3])) h += 12; return `${pad(h)}:${m[2]}`; };
export function parseBea(html) {
  const s = String(html || ''), out = [];
  const year = +((/Year\s+(\d{4})/.exec(text(s)) || [])[1] || 0);
  if (!year) return out;
  for (const row of s.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const date = text((/class="release-date"[^>]*>([\s\S]*?)<\/div>/.exec(row[1]) || [])[1]);
    const time = text((/<small[^>]*>([\s\S]*?)<\/small>/.exec(row[1]) || [])[1]);
    const title = text((/class="release-title[^"]*"[^>]*>([\s\S]*?)<\/td>/.exec(row[1]) || [])[1]);
    const dm = /([A-Za-z]+)\s+(\d{1,2})/.exec(date);
    const keep = BEA_KEEP.find(k => k.re.test(title));
    if (!dm || !keep || !monthOf(dm[1])) continue;
    out.push(ev(iso(year, monthOf(dm[1]), +dm[2]), keep.title(title),
      { region: 'US', tier: keep.tier, time: to24(time) || '08:30', tz: 'America/New_York', kind: keep.kind, source: 'bea.gov' }));
  }
  return out;
}

// ── Census ───────────────────────────────────────────────────────────────────
// The list view: a release title, then "Month D, YYYY", then "H:MM AM". Only the three that move a
// macro read are kept.
const CENSUS_KEEP = [
  { re: /^Advance Monthly Sales for Retail and Food Services$/i, title: 'US retail sales', tier: 1, kind: 'retail' },
  { re: /^Advance Report on Durable Goods/i, title: 'US durable goods orders', tier: 2, kind: 'durables' },
  { re: /^New Residential Construction$/i, title: 'US housing starts', tier: 2, kind: 'housing' },
];
export function parseCensus(html) {
  const t = String(html || '').replace(/<[^>]+>/g, '|').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  const cells = t.split('|').map(x => x.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < cells.length - 2; i++) {
    const keep = CENSUS_KEEP.find(k => k.re.test(cells[i]));
    if (!keep) continue;
    const dm = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(cells[i + 1]);
    if (!dm || !monthOf(dm[1])) continue;
    out.push(ev(iso(+dm[3], monthOf(dm[1]), +dm[2]), keep.title,
      { region: 'US', tier: keep.tier, time: to24(cells[i + 2]) || '08:30', tz: 'America/New_York', kind: keep.kind, source: 'census.gov' }));
  }
  return [...new Map(out.map(e => [`${e.date}|${e.kind}`, e])).values()];
}

// ── BLS, through FRED's release calendar ─────────────────────────────────────
// FRED release name → how it reads on the calendar.
export const FRED_RELEASES = Object.freeze({
  'Consumer Price Index': { title: 'US CPI', tier: 1, time: '08:30', kind: 'cpi' },
  'Employment Situation': { title: 'US payrolls (Employment Situation)', tier: 1, time: '08:30', kind: 'payrolls' },
  'Producer Price Index': { title: 'US PPI', tier: 2, time: '08:30', kind: 'ppi' },
  'Job Openings and Labor Turnover Survey': { title: 'US JOLTS job openings', tier: 2, time: '10:00', kind: 'jolts' },
  // Census's list view carries next year only; FRED's calendar fills the rest of this one.
  'Advance Monthly Sales for Retail and Food Services': { title: 'US retail sales', tier: 1, time: '08:30', kind: 'retail' },
});
export function eventsFromFred(dates = {}) {
  const out = [];
  for (const [name, list] of Object.entries(dates || {})) {
    const f = FRED_RELEASES[name];
    if (!f) continue;
    for (const d of list || []) out.push(ev(d, f.title, { region: 'US', tier: f.tier, time: f.time, tz: 'America/New_York', kind: f.kind, source: 'FRED release calendar' }));
  }
  return out;
}

// ── Earnings (Nasdaq per-symbol) ─────────────────────────────────────────────
// api.nasdaq.com/api/analyst/<SYM>/earnings-date answers in prose, in one of three forms:
//   "… is expected* to report earnings on 10/28/2026 after market close."     the company announced it
//   "… is estimated to report earnings on 11/18/2026. … derived from an algorithm …"  Zacks' guess
//   "Our vendor … hasn't provided us with the upcoming earnings report date."  nothing
// The first is a date; the second is labelled an estimate; the third gives no row.
// The file's names, the names added from the dashboard, and the pre-read watchlist's US single
// names (lib/universeAdded.js).
export const WATCH = EARNINGS_NAMES;
export function parseNasdaqEarnings(sym, json, watch = WATCH) {
  const w = watch.find(x => x.sym === sym);
  const t = String(json?.data?.reportText || '');
  const m = /(expected\*?|estimated) to report earnings on\s+(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(before market open|after market close))?/i.exec(t);
  if (!w || !m) return null;
  const confirmed = /^expected/i.test(m[1]) && !/derived from an algorithm/i.test(t);
  const when = /before/i.test(m[5] || '') ? 'BMO' : /after/i.test(m[5] || '') ? 'AC' : null;
  const title = `${w.name} earnings${when ? ` (${when})` : ''}${confirmed ? '' : ' — est.'}`;
  return { ...ev(iso(+m[4], +m[2], +m[3]), title, { region: w.region, tier: w.tier, kind: `earn:${sym}`, source: 'nasdaq.com (Zacks)' }), confirmed };
}
// The earnings a hand-kept row covers, by the names it uses: "Big-bank Q3 earnings (BMO) — JPM, GS,
// WFC, C" is JPM's and GS's; "Texas Instruments + Lam Research Q3 earnings" is TXN's and LRCX's.
// The Korea-listed names read from DART (lib/dartEarnings.js) are matched the same way, by their
// KRX code; their hand-kept rows say "Q2" or "full results" rather than "earnings" ("Samsung Q2 full
// results (10:00 KST)", "SK Hynix Q2 + new KRX shares list"), so for them either word will do.
export const DART_NAMES = Object.freeze((EARNINGS_WATCH.dart || []).map(d => ({ sym: d.code, aliases: d.aliases })));
const named = (title, w) => w.aliases.some(a => new RegExp(`(^|[^A-Za-z])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z]|$)`).test(title));
function earningsKinds(title, watch = WATCH, dart = DART_NAMES) {
  const out = /\bearnings\b/i.test(title) ? watch.filter(w => named(title, w)).map(w => `earn:${w.sym}`) : [];
  if (/\b(earnings|results|Q[1-4])\b|실적/i.test(title)) out.push(...dart.filter(w => named(title, w)).map(w => `earn:${w.sym}`));
  return out;
}

// ── The latest FOMC decision (federalreserve.gov statement) ──────────────────
// The FOMC calendar page links each past meeting's statement (/newsevents/pressreleases/
// monetaryYYYYMMDDa.htm); the latest is the decision in force. Its first paragraph that says
// "decided to raise / lower / maintain the target range … to|at A to B percent" is the action;
// "Voting against the monetary policy action were …" names any dissents.
export function latestStatementUrl(calendarHtml) {
  const all = [...String(calendarHtml || '').matchAll(/\/newsevents\/pressreleases\/monetary(\d{8})a\.htm/g)].map(m => m[1]).sort();
  const d = all.at(-1);
  return d ? { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, url: `https://www.federalreserve.gov/newsevents/pressreleases/monetary${d}a.htm` } : null;
}
const frac = (s) => { const [w, f] = String(s).split('-'); const v = f ? +w + (f.split('/').reduce((a, b) => +a / +b)) : (/\//.test(w) ? w.split('/').reduce((a, b) => +a / +b) : +w); return Number.isFinite(v) ? v : null; };
export function parseFomcStatement(html, { date = null, url = null } = {}) {
  const t = text(html);
  const m = /decided to (raise|lower|maintain) the target range for the federal funds rate(?: by ([\d/]+) percentage point)? (?:to|at) ([\d/-]+) to ([\d/-]+) percent/i.exec(t);
  if (!m) return null;
  const action = m[1].toLowerCase();
  const lo = frac(m[3]), hi = frac(m[4]), step = m[2] ? frac(m[2]) : 0;
  // Names carry middle initials ("Beth M. Hammack"), so the list runs to "who preferred" or to the
  // first full stop that ends a sentence, not to the first full stop.
  const at = t.search(/Voting against the monetary policy action (?:were|was) /i);
  let names = null;
  if (at >= 0) {
    const rest = t.slice(at).replace(/^Voting against the monetary policy action (?:were|was) /i, '');
    // A full stop after a lone capital is an initial; any other ends the sentence.
    names = rest.split(/,?\s+who preferred/i)[0].split(/(?<!\b[A-Z])\.(?:\s|$)/)[0];
  }
  const against = names ? [null, names] : null;
  const prefer = /who preferred to ([^.]+)\./i.exec(t);
  return { date, url, action, bps: Math.round(step * 100), range: lo != null && hi != null ? [lo, hi] : null,
    dissents: against ? against[1].split(/,\s*(?:and\s+)?|\s+and\s+/).map(x => x.trim()).filter(Boolean) : [],
    dissentPreferred: prefer ? prefer[1].trim() : null };
}

// ── Which kind of event a row is, hand-kept or automatic ─────────────────────
// So a hand-kept "FOMC meeting (Oct 27–28), decision 2pm" and the automatic "FOMC decision" on the
// same day are recognised as one event, and the hand-kept row is kept.
const KINDS = [
  ['fomc', /\bFOMC\b.*(decision|meeting|statement|rate)|\bFed\b.*\bdecision\b/i],
  ['ecb', /\bECB\b.*(decision|meeting|rate)/i],
  ['boj', /\b(BoJ|BOJ|Bank of Japan)\b.*(decision|meeting|MPM|rate)/i],
  ['cpi', /\b(US\s+)?CPI\b(?!.*\b(China|Japan|Tokyo|Korea|Euro|UK|German|HK|Hong Kong)\b)/i],
  ['ppi', /\b(US\s+)?PPI\b(?!.*\b(China|Japan|Korea|Euro|UK|German)\b)/i],
  ['payrolls', /\b(payrolls?|NFP|Employment Situation|jobs report)\b/i],
  ['jolts', /\bJOLTS\b/i],
  ['gdp', /\b(US\s+)?GDP\b(?!.*\b(China|Japan|Korea|Euro|UK|German|Taiwan)\b)/i],
  ['pce', /\b(PCE|Personal Income)\b/i],
  ['retail', /\bretail sales\b(?!.*\b(China|Japan|Korea|Euro|UK|German)\b)/i],
  ['durables', /\bdurable goods\b/i],
  ['housing', /\bhousing starts\b/i],
];
// Every kind a row covers: a hand-kept "US core PCE (Sep) + Q3 GDP advance" is both. Minutes and
// the blackout start are about a meeting but are not its decision.
export function kindsOf(e) {
  if (e?.kind) return [e.kind];
  const title = String(e?.title || '');
  const region = String(e?.region || '').toUpperCase();
  const out = earningsKinds(title);
  for (const [k, re] of KINDS) {
    if (!re.test(title)) continue;
    if (['fomc', 'ecb', 'boj'].includes(k) && /\b(minutes|blackout|accounts)\b/i.test(title)) continue;
    // The US-only kinds need a US row: Japan's CPI is not the US CPI.
    if (['cpi', 'ppi', 'payrolls', 'jolts', 'gdp', 'pce', 'retail', 'durables', 'housing', 'fomc'].includes(k) && region && region !== 'US') continue;
    if (k === 'ecb' && region && region !== 'EU') continue;
    if (k === 'boj' && region && region !== 'ASIA') continue;
    out.push(k);
  }
  return out;
}
export const kindOf = (e) => kindsOf(e)[0] || null;

// Automatic events not already covered by a hand-kept one of the same kind on the same day.
export function mergeAuto(hand = [], auto = []) {
  const have = new Set(hand.flatMap(e => kindsOf(e).map(k => `${e.date}|${k}`)));
  const seen = new Set();
  return auto.filter(e => {
    const key = `${e.date}|${e.kind}`;
    if (have.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Every source, independently. `pages` is { fomc, ecb, boj, bea, census } raw HTML (a missing or
// failed page is { error }); `fred` is fredReleaseDates' answer. Returns the events from `from` on,
// and per source the count or the reason it gave nothing.
export function buildAutoCalendar({ pages = {}, fred = null, earnings = null, dart = null, from = '' } = {}) {
  const parsers = { fomc: parseFomc, ecb: parseEcb, boj: parseBoj, bea: parseBea, census: parseCensus };
  const events = [], sources = {};
  for (const [name, parse] of Object.entries(parsers)) {
    const p = pages[name];
    if (p == null || p.error) { sources[name] = { ok: false, error: p?.error || 'not fetched' }; continue; }
    try {
      const got = parse(p.html ?? p).filter(e => !from || e.date >= from);
      events.push(...got);
      sources[name] = got.length ? { ok: true, count: got.length } : { ok: false, error: 'page read, no dates found — its layout may have changed' };
    } catch (e) { sources[name] = { ok: false, error: `parse failed: ${String(e?.message || e).slice(0, 120)}` }; }
  }
  if (fred) {
    const got = eventsFromFred(fred.dates).filter(e => !from || e.date >= from);
    events.push(...got);
    sources.fred = got.length ? { ok: true, count: got.length, ...(Object.keys(fred.errors || {}).length ? { missing: Object.keys(fred.errors) } : {}) }
      : { ok: false, error: Object.values(fred.errors || {})[0] || 'no dates' };
  }
  // Earnings: `earnings` is { SYM: json | { error } } from the per-symbol reads.
  if (earnings) {
    const got = [], failed = [];
    for (const [sym, j] of Object.entries(earnings)) {
      if (j?.error) { failed.push(sym); continue; }
      const e = parseNasdaqEarnings(sym, j);
      if (e && (!from || e.date >= from)) got.push(e);
    }
    events.push(...got);
    const est = got.filter(e => !e.confirmed).length;
    sources.earnings = got.length ? { ok: true, count: got.length, estimated: est, ...(failed.length ? { failed: failed.length } : {}) }
      : { ok: false, error: failed.length ? `${failed.length} of ${Object.keys(earnings).length} reads failed` : 'no dates announced or estimated' };
  }
  // Korea earnings: `dart` is lib/dartEarnings.js fetchDartEarnings' answer, rows already built.
  // A preliminary-results row is in the past by nature (it is the filing date), so it is kept
  // whatever `from` says: it is what marks the quarter as reported.
  if (dart) {
    events.push(...(dart.events || []).filter(e => !from || e.date >= from || /^earnprelim:/.test(e.kind)));
    sources.dart = dart.source || { ok: false, error: 'not fetched' };
  }
  // One row per kind per day: retail sales can come from both Census and FRED.
  const one = [...new Map(events.map(e => [`${e.date}|${e.kind}`, e])).values()];
  one.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  return { events: one, sources };
}

export const AUTO_SOURCES = Object.freeze({
  fomc: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  ecb: 'https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html',
  boj: 'https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm',
  bea: 'https://www.bea.gov/news/schedule',
  census: 'https://www.census.gov/economic-indicators/calendar-listview.html',
});
