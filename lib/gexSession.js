// lib/gexSession.js — which US session a gamma board belongs to, and whether anything has traded
// since it was taken.
//
// WHY (P3, 18 Oct audit). The weekend board was the book AFTER the 16 Oct monthly expiry had
// rolled off — net GEX roughly halved — and the header said only "3.4h ago", in the colour of a
// fresh intraday print. Hours since the capture are the right measure inside a session and the
// wrong one across a close: overnight and over a weekend nothing trades, while a single open in
// between makes the board a previous session's however few hours have passed.
//
// Everything is read in New York wall-clock terms, compared as "YYYY-MM-DD HHMM" strings, so no
// UTC or DST arithmetic happens here. Full-day closures and early closes come from
// data/holidays.json (the same file lib/sessions.js reads).
import HOLIDAYS from '../data/holidays.json' with { type: 'json' };
import { dubaiEt } from './timeFmt.js';

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const HALF_CLOSE_MIN = 13 * 60;
const CLOSED = new Set(HOLIDAYS?.US?.closed || []);
const HALF = new Set(HOLIDAYS?.US?.half || []);

const NY_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function nyClock(t) {
  const p = Object.fromEntries(NY_PARTS.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  const h = p.hour === '24' ? 0 : +p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, min: h * 60 + +p.minute };
}
const key = (date, min) => `${date} ${String(min).padStart(4, '0')}`;
const dayMs = (date) => Date.parse(`${date}T12:00:00Z`);
const shift = (date, n) => new Date(dayMs(date) + n * 86400000).toISOString().slice(0, 10);
const dow = (date) => new Date(dayMs(date)).getUTCDay();

export const isTradingDay = (date) => dow(date) !== 0 && dow(date) !== 6 && !CLOSED.has(date);
export const closeMinOf = (date) => (HALF.has(date) ? HALF_CLOSE_MIN : CLOSE_MIN);
function walk(date, step) {
  for (let i = 1; i <= 10; i++) { const d = shift(date, step * i); if (isTradingDay(d)) return d; }
  return null;
}
export const nextTradingDay = (date) => walk(date, 1);
export const prevTradingDay = (date) => walk(date, -1);

// The standard monthly expiry: the third Friday, or the Thursday before it when that Friday is an
// exchange holiday (Good Friday). March, June, September and December are the quarterlies.
export function monthlyExpiry(month) {
  const first = `${month}-01`;
  const toFri = (5 - dow(first) + 7) % 7;
  const third = shift(first, toFri + 14);
  return CLOSED.has(third) ? shift(third, -1) : third;
}
export function expiryKind(date) {
  if (!date || monthlyExpiry(date.slice(0, 7)) !== date) return null;
  return [3, 6, 9, 12].includes(+date.slice(5, 7)) ? 'quarterly' : 'monthly';
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayLabel = (date) => `${WD[dow(date)]} ${+date.slice(8, 10)} ${MON[+date.slice(5, 7) - 1]}`;

// The session a capture belongs to:
//   pre       before the open on a trading day — that day's settled book, before anything trades
//   intraday  between the open and the close
//   close     after the close, or any time on a weekend or holiday — the last session's close
// `expiry` is set when a monthly (or quarterly) expiry rolled off between that session's open
// and the book: a close on expiry day, or the pre-open of the session after one.
export function boardSession(asOf) {
  const t = asOf ? Date.parse(asOf) : NaN;
  if (!Number.isFinite(t)) return null;
  const { date, min } = nyClock(t);
  let phase, day;
  if (!isTradingDay(date)) { phase = 'close'; day = prevTradingDay(date); }
  else if (min < OPEN_MIN) { phase = 'pre'; day = date; }
  else if (min < closeMinOf(date)) { phase = 'intraday'; day = date; }
  else { phase = 'close'; day = date; }
  if (!day) return null;
  const rolled = phase === 'close' ? expiryKind(day) : phase === 'pre' ? expiryKind(prevTradingDay(day)) : null;
  // A session is named in ET (it is New York's session); an intraday capture is a clock time, and
  // a clock time is written Dubai first, ET in brackets (lib/timeFmt.js).
  const what = phase === 'close' ? 'close ET' : phase === 'pre' ? 'pre-open ET' : dubaiEt(new Date(t));
  const label = `${dayLabel(day)} ${what}${rolled ? `, after ${rolled} expiry` : ''}`;
  // The first minute anything trades after the capture: the open (pre), the capture itself
  // (intraday), or the next session's open (close).
  const next = nextTradingDay(day);
  const tradesFrom = phase === 'pre' ? key(day, OPEN_MIN) : phase === 'intraday' ? key(date, min) : next ? key(next, OPEN_MIN) : null;
  return { date: day, phase, expiry: rolled, label,
           tradesFrom, closesAt: key(day, closeMinOf(day)), nextOpen: next ? key(next, OPEN_MIN) : null };
}

// Where `now` stands relative to that session: has anything traded since, has the session closed
// since (an intraday board), and has the NEXT session opened (which makes any board from this one
// a previous session's, however few hours have passed).
export function sinceSession(sess, now = new Date()) {
  if (!sess) return null;
  const n = nyClock(now);
  const k = key(n.date, n.min);
  // tradesFrom is always a minute the market is open (an open, or an intraday capture), so
  // reaching it is enough: a weekend or an overnight before the next open has not.
  const tradedSince = sess.tradesFrom != null && k > sess.tradesFrom;
  return {
    tradedSince,
    closedSince: sess.phase !== 'close' && k >= sess.closesAt,
    nextOpened: sess.nextOpen != null && k >= sess.nextOpen,
  };
}
