// sessions.js — exchange trading hours, so a print can be labeled by the market's
// actual state, not a blunt "stale" flag. This is the seed of the Layer 3 timezone
// engine; the Pre-Read uses marketState() to say "prior close" (market shut — the
// honest, expected state for a pre-market brief) vs "delayed" (open but the keyless
// feed lags) vs "no print" (miss).
//
// Hours are expressed in EXCHANGE-LOCAL wall-clock minutes-since-midnight. We resolve
// "now" into each exchange's local time via Intl (DST-safe), so there is NO manual
// UTC/DST arithmetic — the source of most market-hours bugs.

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

// 'open' | 'lunch' | 'closed' for a symbol at a given instant (default: now).
// Weekends are 'closed'. Exchange holidays are NOT modeled yet — a holiday reads as
// 'closed' only if it also falls outside session hours, which it always does here
// (we can't be "open" on a holiday because there are no trades; the feed will simply
// carry the prior close and be labeled accordingly). Holiday calendars are a Layer 3 add.
export function marketState(sym, now = new Date()) {
  const ex = EXCHANGES[exchangeFor(sym)];
  if (!ex) return 'closed';

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
