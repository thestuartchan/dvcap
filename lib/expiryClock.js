// lib/expiryClock.js — when an option stops being a position: 16:00 New York time on its expiry date.
//
// The console asked this question three ways. The option card said "past expiry" from the day
// AFTER the expiry date (a date-string compare), the exposure book and the sizer counted days to
// 21:00 UTC, which is 16:00 in New York only in winter. So on expiry afternoon an expired contract
// could sit in the book's delta-notional for hours, and in summer the DTE ticked over an hour late.
// One clock now, in one place: the listed close of the expiry day, in New York, daylight saving
// included. A contract that settles on a different clock (an AM-settled index option) is still
// counted to the close: the console holds it until the broker books the expiry either way.
import { localMinutesOfDay } from './sessions.js';

export const EXPIRY_TZ = 'America/New_York';
export const EXPIRY_CLOSE_MIN = 16 * 60;   // 16:00
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// The instant of 16:00 New York on `expiry` (YYYY-MM-DD), in ms, or null. New York is UTC−4 in
// summer and UTC−5 in winter, so the close is 20:00 or 21:00 UTC; the one that reads 16:00 there
// is the answer.
export function expiryCloseMs(expiry) {
  const e = String(expiry || '').slice(0, 10);
  if (!ISO.test(e)) return null;
  for (const h of [20, 21]) {
    const ms = Date.parse(`${e}T${h}:00:00Z`);
    if (!Number.isFinite(ms)) return null;
    if (localMinutesOfDay(EXPIRY_TZ, new Date(ms)) === EXPIRY_CLOSE_MIN) return ms;
  }
  return Date.parse(`${e}T21:00:00Z`);
}

const msOf = (now) => now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);

// Expired from the close of its expiry day, not from the next morning.
export function optionExpired(expiry, now = new Date()) {
  const close = expiryCloseMs(expiry);
  const n = msOf(now);
  return close != null && Number.isFinite(n) && n >= close;
}

// Whole days to that close, rounded as the book always has. Negative once it has passed.
export function daysToExpiry(expiry, now = new Date()) {
  const close = expiryCloseMs(expiry);
  const n = msOf(now);
  return close != null && Number.isFinite(n) ? Math.round((close - n) / 86400000) : null;
}
