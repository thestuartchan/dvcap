// sessions.js — exchange trading hours, so a print can be labeled by the market's
// actual state, not a blunt "stale" flag. This is the seed of the Layer 3 timezone
// engine; the Pre-Read uses marketState() to say "prior close" (market shut — the
// honest, expected state for a pre-market brief) vs "delayed" (open but the keyless
// feed lags) vs "no print" (miss).
//
// Hours are expressed in EXCHANGE-LOCAL wall-clock minutes-since-midnight. We resolve
// "now" into each exchange's local time via Intl (DST-safe), so there is NO manual
// UTC/DST arithmetic — the source of most market-hours bugs.

import HOLIDAYS from '../data/holidays.json' with { type: 'json' };

const MIN = (h, m = 0) => h * 60 + m;

// sessions: array of [openMin, closeMin] local; a gap between two = lunch break.
const EXCHANGES = {
  SEHK:     { tz: 'Asia/Hong_Kong', sessions: [[MIN(9, 30), MIN(12)], [MIN(13), MIN(16)]] }, // HK, lunch 12:00-13:00
  KRX:      { tz: 'Asia/Seoul',     sessions: [[MIN(9),     MIN(15, 30)]] },                  // Korea, continuous
  TWSE:     { tz: 'Asia/Taipei',    sessions: [[MIN(9),     MIN(13, 30)]] },                  // Taiwan, continuous
  TSE:      { tz: 'Asia/Tokyo',     sessions: [[MIN(9),     MIN(11, 30)], [MIN(12, 30), MIN(15, 30)]] }, // Japan, lunch 11:30-12:30
  EURONEXT: { tz: 'Europe/Paris',   sessions: [[MIN(9),     MIN(17, 30)]] },                  // Amsterdam/Paris
  XETRA:    { tz: 'Europe/Berlin',  sessions: [[MIN(9),     MIN(17, 30)]] },                  // Frankfurt
  LSE:      { tz: 'Europe/London',  sessions: [[MIN(8),     MIN(16, 30)]] },                  // London
  US:       { tz: 'America/New_York', sessions: [[MIN(9, 30), MIN(16)]] },                    // NYSE/NASDAQ regular
  // CME globex (energy/metals/index futures) is a near-24h week, NOT an equity session:
  // Sunday 18:00 ET through Friday 17:00 ET, with a 17:00–18:00 maintenance halt each day.
  // Scoring oil against NYSE hours mislabels every overnight and Sunday-reopen tick as a
  // "prior close", and — worse — fails to catch Friday's settle being served as a live tick
  // through the weekend. `globex: true` switches marketState onto the week-based rule below.
  CME:      { tz: 'America/New_York', globex: true, sessions: [[MIN(18), MIN(17)]] },
  // SPOT CRYPTO NEVER CLOSES. Mapped to US by the suffixless default, a BTC quote fetched two
  // minutes ago on a Saturday was labelled "prior close" — every weekend and every night, the
  // dashboard called a live price stale. `always: true` is a third session model alongside the
  // equity day and the globex week: no weekend, no holiday, no close.
  CRYPTO:   { tz: 'UTC', always: true, sessions: [[MIN(0), MIN(24)]] },
};

// Map a universe symbol to its exchange key. Yahoo-format suffixes + known indices;
// suffixless symbols (NVDA, QQQ, ^VIX) are US.
export function exchangeFor(sym) {
  // Futures (=F) run on the globex week, not an equity session. Checked FIRST so CL=F/BZ=F/
  // GC=F never fall through to the US default.
  if (/=F$/.test(sym)) return 'CME';
  // Yahoo quotes spot crypto as PAIR-QUOTE (BTC-USD, SHIB-USD, ETH-EUR). The fiat leg is what
  // distinguishes it from an ordinary dashed ticker — BRK-B is a share class, not a pair — so the
  // quote currency is matched explicitly rather than "anything with a hyphen".
  if (/^[A-Z0-9]{2,10}-(USD|USDT|USDC|EUR|GBP|JPY)$/.test(sym)) return 'CRYPTO';
  if (sym.endsWith('.HK')) return 'SEHK';
  if (sym.endsWith('.KS') || sym.endsWith('.KQ')) return 'KRX';
  if (sym.endsWith('.TW')) return 'TWSE';
  if (sym.endsWith('.T'))  return 'TSE';
  if (sym.endsWith('.AS') || sym.endsWith('.PA')) return 'EURONEXT';
  if (sym.endsWith('.DE')) return 'XETRA';
  if (sym.endsWith('.L'))  return 'LSE';
  switch (sym) {
    case '^HSI': return 'SEHK';
    case '^KS11': return 'KRX';
    case '^N225': return 'TSE';
    case '^STOXX50E': return 'EURONEXT';
    case '^GDAXI': return 'XETRA';
    case '^FTSE': return 'LSE';
    default: return 'US'; // NVDA/QQQ/SOXX/SMH/^VIX and any other suffixless symbol
  }
}

// Current hour (0-23) in an IANA timezone, DST-aware. Used to gate UTC crons onto a
// region's true local pre-read hour so they don't drift across daylight-saving shifts.
// When the exchange behind `sym` last closes today, in ITS OWN local minutes, with the zone that
// figure is measured in. Used to say whether a dated event lands inside a session or after it —
// which is most of what a calendar line is for and none of what it used to say.
export function sessionCloseMin(sym) {
  const ex = EXCHANGES[exchangeFor(sym)];
  if (!ex || !ex.sessions?.length) return null;
  // A market that never closes has no close to measure an event against. Returning NYSE's 16:00
  // for BTC would put every dated event "after the close" of a session that does not end.
  if (ex.always) return null;
  return { closeMin: ex.sessions[ex.sessions.length - 1][1], tz: ex.tz };
}

export function localHour(tz, now = new Date()) {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', hour12: false,
  }).formatToParts(now).find(p => p.type === 'hour')?.value;
  let hh = parseInt(h, 10);
  if (hh === 24) hh = 0;
  return hh;
}

// Current minutes-since-local-midnight (0–1439) in an IANA timezone, DST-aware. Same purpose
// as localHour but at minute resolution, so the pre-read cron can gate on a lead WINDOW
// (start a few minutes before the target hour) rather than only the exact top of the hour.
export function localMinutesOfDay(tz, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  let hh = parseInt(parts.find(p => p.type === 'hour')?.value, 10);
  const mm = parseInt(parts.find(p => p.type === 'minute')?.value, 10);
  if (hh === 24) hh = 0;
  return (Number.isFinite(hh) ? hh : 0) * 60 + (Number.isFinite(mm) ? mm : 0);
}

// The calendar date IN a region's own timezone, as YYYY-MM-DD. A "did this already run today"
// check has to ask the question in the region's day, not UTC's: the Asia pre-read targets 07:00
// HKT, which is the previous calendar day in UTC, so a UTC-dated check would let it post twice.
export function localDateIn(tz, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const y = get('year'), m = get('month'), d = get('day');
  return (y && m && d) ? `${y}-${m}-${d}` : null;
}

// ─── THE REGION'S OWN DAY OF WEEK ─────────────────────────────────────────────────────────────
// A cron's day-of-week field is evaluated in UTC, but a pre-read's day is the REGION'S day, and
// for Asia those are not the same day. The Asia brief targets 07:00 HKT, which is 23:00 the
// PREVIOUS calendar day in UTC — so a Friday-night UTC firing is Saturday morning in Hong Kong,
// and `* * *` delivered a pre-market brief for a market that would not open. Anyone who spotted
// the missing day filter and wrote the obvious `1-5` would have made it worse, not better: in
// UTC terms that is Tuesday-to-Saturday local.
//
// Rather than encode that offset in a cron string where it cannot be tested, the schedule is
// narrowed AND the handler asks the region directly what day it is. 0 = Sunday.
export function localWeekday(tz, now = new Date()) {
  // Intl THROWS on an invalid timezone or an invalid Date rather than returning nothing, and this
  // sits inside the pre-read's delivery gate — an exception there is a brief that fails to send,
  // which is a worse outcome than the one this function exists to prevent. Unknown returns null,
  // and the weekend check treats null as "not a weekend", so a broken clock can never silence a
  // brief; it can only fail to suppress one.
  try {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
      .formatToParts(now).find(p => p.type === 'weekday')?.value;
    const i = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
    return i < 0 ? null : i;
  } catch {
    return null;
  }
}

// Saturday or Sunday in the region's own timezone. Weekends only — a holiday calendar is
// per-market and per-year, and this deliberately does not pretend to be one; an unknown day is
// not reported as a weekend, so this can never suppress a brief it is not sure about.
export function isWeekendIn(tz, now = new Date()) {
  const d = localWeekday(tz, now);
  return d === 0 || d === 6;
}

// ─── IS THERE A SESSION AT ALL? ───────────────────────────────────────────────────────────────
// The weekend check above is the universal case. This is the region-specific one, and the data to
// answer it already existed: data/holidays.json is hand-maintained for marketState(), listing full
// -day closures per exchange. Monday 2026-09-07 is in it as a US closure — Labor Day — so the US
// brief was three days from delivering a pre-market read for a shut market by exactly the same
// mechanism as the Saturday Asia one.
//
// A region spans several exchanges, and they do not close together: Hong Kong shuts for National
// Day while Tokyo and Seoul trade. So the brief is suppressed only when EVERY exchange the region
// covers is shut. One market closed out of four is content for the brief, not a reason to skip it.
//
// Takes the region's symbols rather than the region name so this stays a pure function of
// lib/sessions.js's own vocabulary and does not reach into data/universe.js.
export function closedExchanges(symbols = [], now = new Date()) {
  const keys = [...new Set(symbols.map(exchangeFor))];
  const shut = keys.filter(k => {
    const ex = EXCHANGES[k];
    if (!ex) return false;
    // Futures run the globex week and crypto never closes at all; neither is what a regional
    // equity pre-read is about, and neither should make a region look open on a day its cash
    // markets are shut — nor, for crypto, permanently open.
    if (ex.globex || ex.always) return false;
    const d = localDateStr(ex.tz, now);
    return isWeekendIn(ex.tz, now) || (HOLIDAYS[k]?.closed || []).includes(d);
  });
  const cash = keys.filter(k => EXCHANGES[k] && !EXCHANGES[k].globex && !EXCHANGES[k].always);
  return {
    exchanges: cash,
    closed: shut,
    // allClosed is false when there are no cash exchanges to judge — unknown is never a reason
    // to silence the brief.
    allClosed: cash.length > 0 && shut.length === cash.length,
  };
}

// Market-state-aware freshness for a quote — the single source of truth for BOTH the
// Pre-Read label and the dashboard names/indices chip. Returns { state, mins }:
//   'no-print'    — no price at all
//   'holiday'     — exchange closed for a holiday today
//   'prior-close' — market shut (pre/post/weekend); the print is the last close (EXPECTED)
//   'lunch'       — mid-session lunch halt
//   'delayed'     — market OPEN but the keyless feed lags (mins = how far behind)
//   'live'        — open and fresh
// This is what stops the blanket "⚠️ stale" badge from firing on live-but-delayed feeds.
export const CADENCE_MIN = { intraday: 30, daily: 2 * 24 * 60, monthly: 45 * 24 * 60, manual: 2 * 24 * 60 };

// Humanize an age in minutes → "12m ago" / "15h ago" / "2d ago". Never negative.
export function humanizeAge(min) {
  if (min == null) return '';
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

// Returns { state, ageMin }. state ∈ no-print | future | holiday | prior-close | lunch |
// stale | live. ageMin is always ≥ 0 (a ts ahead of now is caught as 'future', not a
// negative age). 'stale' = market OPEN but older than the intraday cadence.
export function freshness(sym, q, now = Date.now()) {
  if (!q || q.price == null) return { state: 'no-print', ageMin: null };
  const ts = q.ts ?? null;
  if (ts && ts * 1000 > now + 5 * 60 * 1000) return { state: 'future', ageMin: null }; // >5m ahead
  const ageMin = ts != null ? Math.max(0, Math.round((now / 1000 - ts) / 60)) : null;
  const st = marketState(sym, new Date(now));
  if (st === 'holiday') return { state: 'holiday', ageMin };
  if (st === 'closed')  return { state: 'prior-close', ageMin };
  if (st === 'lunch')   return { state: 'lunch', ageMin };
  if (ageMin == null || ageMin > CADENCE_MIN.intraday) return { state: 'stale', ageMin };
  return { state: 'live', ageMin };
}

// Single-vocabulary display phrase (no leading separator). live → "". Shared by the
// Pre-Read and dashboard so wording matches everywhere.
export function freshnessText(fr) {
  if (!fr) return '';
  switch (fr.state) {
    case 'prior-close': return 'prior close';
    case 'holiday':     return 'holiday';
    case 'lunch':       return 'lunch';
    case 'future':      return '⚠ date';
    case 'no-print':    return 'no print';
    case 'stale':       return `stale · ${humanizeAge(fr.ageMin)}`;
    default:            return ''; // live
  }
}

// Explicit session PHASE for a symbol's own exchange (finer than marketState — splits the
// closed state into pre-open vs post-close vs weekend so a badge can say WHICH closed state
// it is). 'live' | 'lunch' | 'pre' | 'post' | 'holiday' | 'weekend' | 'closed'.
export function sessionPhase(sym, now = new Date()) {
  const exKey = exchangeFor(sym);
  const ex = EXCHANGES[exKey];
  if (!ex) return 'closed';
  if (ex.always) return 'live';
  if ((HOLIDAYS[exKey]?.closed || []).includes(localDateStr(ex.tz, now))) return 'holiday';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ex.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = t => parts.find(p => p.type === t)?.value;

  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return 'weekend';

  let hh = parseInt(get('hour'), 10);
  if (hh === 24) hh = 0;
  const t = hh * 60 + parseInt(get('minute'), 10);
  const open  = ex.sessions[0][0];
  const close = ex.sessions[ex.sessions.length - 1][1];

  if (ex.sessions.some(([a, b]) => t >= a && t < b)) return 'live';
  if (ex.sessions.length > 1 && t >= ex.sessions[0][1] && t < ex.sessions[1][0]) return 'lunch';
  if (t < open)  return 'pre';
  if (t >= close) return 'post';
  return 'closed';
}

// Current wall-clock "HH:MM" in an IANA timezone (24h), for the region session badge.
export function localClock(tz, now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
}

// ── P6.1 — echoed-close junk guard ───────────────────────────────────────────
// Snapshot feeds echo the prior session's close outside trading hours: IBKR returns `last`
// with is_close:true, and Yahoo can serve a settle that equals prevClose exactly. Either way
// the field is not a live print and must not be read as one. Equality is only suspicious when
// the market is SHUT — an unchanged price during a live session is perfectly ordinary.
export function isEchoedClose(q, sym, now = new Date()) {
  if (!q || q.price == null) return false;
  const shut = marketState(sym, now) !== 'open';
  if (!shut) return false;
  if (q.isClose === true || q.is_close === true) return true;
  return q.prevClose != null && q.price === q.prevClose;
}

// ── P6.3 — date sanity ───────────────────────────────────────────────────────
// Asserts that a weekday NAME matches the date it is attached to. Hand-written and generated
// headers drift (a recent handoff read "Fri Aug 1, 2026"; Aug 1 was a Saturday), and a wrong
// weekday quietly miscommunicates which session is being discussed. Returns
// { ok, expected, given } — ok:true when there is nothing to check.
const DOW_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export function assertWeekday(dateStr, weekdayName) {
  if (!dateStr || !weekdayName) return { ok: true, expected: null, given: null };
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { ok: true, expected: null, given: null };
  const idx = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  const expected = DOW_NAMES[idx];
  const given = String(weekdayName).trim().toLowerCase();
  // Accept 3-letter abbreviations as well as full names.
  const ok = expected === given || expected.slice(0, 3) === given.slice(0, 3);
  return { ok, expected, given, note: ok ? null : `date/weekday mismatch — ${dateStr} is a ${expected[0].toUpperCase() + expected.slice(1)}, not "${weekdayName}"` };
}

// Short display names for exchanges (for the Pre-Read's half-day heads-up).
export const EXCHANGE_LABEL = {
  SEHK: 'HKEX', KRX: 'KRX', TWSE: 'TWSE', TSE: 'TSE',
  EURONEXT: 'Euronext', XETRA: 'Xetra', LSE: 'LSE', US: 'NYSE/Nasdaq',
};

// Is `sym`'s exchange on an early-close (half) session today? (exchange-local date)
export function isHalfDay(sym, now = new Date()) {
  const exKey = exchangeFor(sym);
  const ex = EXCHANGES[exKey];
  if (!ex || ex.always) return false;
  return (HOLIDAYS[exKey]?.half || []).includes(localDateStr(ex.tz, now));
}

// Given a list of symbols, the distinct display names of exchanges on a half-day today.
// Used to build the Pre-Read's "HALF DAY" heads-up (a region can span several exchanges).
export function halfDayLabels(syms, now = new Date()) {
  const set = new Set();
  for (const s of syms) {
    if (isHalfDay(s, now)) set.add(EXCHANGE_LABEL[exchangeFor(s)] || exchangeFor(s));
  }
  return [...set];
}

// Current calendar date ("YYYY-MM-DD") in an IANA timezone, DST-aware. Used to decide
// "today" per region so the Pre-Read's calendar drops events that are already in the past
// for that region's local day.
export function localDateStr(tz, now = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const g = t => p.find(x => x.type === t)?.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

// 'open' | 'lunch' | 'holiday' | 'closed' for a symbol at a given instant (default: now).
// Weekends are 'closed'; exchange holidays (data/holidays.json, hand-maintained) are
// 'holiday' regardless of clock time, so a print on a shut exchange is labeled honestly
// instead of being expected live. Half-day early closes are NOT modeled (would read as
// a normal session, then 'closed' after the real close — an acceptable approximation).
export function marketState(sym, now = new Date()) {
  const exKey = exchangeFor(sym);
  const ex = EXCHANGES[exKey];
  if (!ex) return 'closed';

  // Always-open venues short-circuit everything below: no holiday calendar, no weekend, no hours.
  if (ex.always) return 'open';

  // Exchange full-day holiday? (compare in the exchange's OWN local date, DST-safe)
  if ((HOLIDAYS[exKey]?.closed || []).includes(localDateStr(ex.tz, now))) return 'holiday';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ex.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = t => parts.find(p => p.type === t)?.value;

  const wd = get('weekday');
  let hh0 = parseInt(get('hour'), 10);
  if (hh0 === 24) hh0 = 0;
  const t0 = hh0 * 60 + parseInt(get('minute'), 10);

  // Globex week: open Sunday 18:00 ET → Friday 17:00 ET, minus a 17:00–18:00 daily halt.
  // Deliberately evaluated BEFORE the weekend short-circuit, because Sunday evening IS a
  // live session for futures — that is exactly the reopen the weekend guard has to respect.
  if (ex.globex) {
    if (wd === 'Sat') return 'closed';
    if (wd === 'Sun') return t0 >= MIN(18) ? 'open' : 'closed';
    if (wd === 'Fri' && t0 >= MIN(17)) return 'closed';
    if (t0 >= MIN(17) && t0 < MIN(18)) return 'closed';   // daily maintenance halt
    return 'open';
  }

  if (wd === 'Sat' || wd === 'Sun') return 'closed';

  let hh = parseInt(get('hour'), 10);
  if (hh === 24) hh = 0; // some ICU builds emit '24' for midnight
  const t = hh * 60 + parseInt(get('minute'), 10);

  if (ex.sessions.some(([a, b]) => t >= a && t < b)) return 'open';
  // Between the first close and the second open => lunch (only for two-session days).
  if (ex.sessions.length > 1 && t >= ex.sessions[0][1] && t < ex.sessions[1][0]) return 'lunch';
  return 'closed';
}
