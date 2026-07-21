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
};

// Map a universe symbol to its exchange key. Yahoo-format suffixes + known indices;
// suffixless symbols (NVDA, QQQ, ^VIX) are US.
export function exchangeFor(sym) {
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
export function localHour(tz, now = new Date()) {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', hour12: false,
  }).formatToParts(now).find(p => p.type === 'hour')?.value;
  let hh = parseInt(h, 10);
  if (hh === 24) hh = 0;
  return hh;
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
export function freshness(sym, q) {
  if (!q || q.price == null) return { state: 'no-print', mins: null };
  const st = marketState(sym);
  if (st === 'holiday') return { state: 'holiday', mins: null };
  if (st === 'closed')  return { state: 'prior-close', mins: null };
  if (st === 'lunch')   return { state: 'lunch', mins: null };
  if (q.stale) {
    const mins = q.ts ? Math.round(Date.now() / 1000 / 60 - q.ts / 60) : null;
    return { state: 'delayed', mins };
  }
  return { state: 'live', mins: null };
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
  if (!ex) return false;
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

  // Exchange full-day holiday? (compare in the exchange's OWN local date, DST-safe)
  if ((HOLIDAYS[exKey]?.closed || []).includes(localDateStr(ex.tz, now))) return 'holiday';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ex.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = t => parts.find(p => p.type === t)?.value;

  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return 'closed';

  let hh = parseInt(get('hour'), 10);
  if (hh === 24) hh = 0; // some ICU builds emit '24' for midnight
  const t = hh * 60 + parseInt(get('minute'), 10);

  if (ex.sessions.some(([a, b]) => t >= a && t < b)) return 'open';
  // Between the first close and the second open => lunch (only for two-session days).
  if (ex.sessions.length > 1 && t >= ex.sessions[0][1] && t < ex.sessions[1][0]) return 'lunch';
  return 'closed';
}
