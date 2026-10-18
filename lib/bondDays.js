// lib/bondDays.js — business days as the US bond market counts them.
//
// The rate series the dashboard ages (DGS2/DGS10, DFII10, T10YIE, EFFR, the term premium) are
// Treasury and Fed prints. They do not print on a day the bond market is shut, and the bond
// market shuts on two days the stock exchange stays open: Columbus Day and Veterans Day (SIFMA's
// recommended closes, which the Fed's H.15 follows). Counting only the exchange's holidays made a
// Friday print read "2 business days old" on the Tuesday after Columbus Day, and flagged it stale
// when nothing newer could exist.
//
// Both days are fixed rules, so they are computed rather than typed into a list. Veterans Day on
// a Saturday is not moved to the Friday (SIFMA kept the market open on 10 Nov 2023); on a Sunday
// it is observed on the Monday.
import HOLIDAYS from '../data/holidays.json' with { type: 'json' };

const iso = (d) => d.toISOString().slice(0, 10);
const nthMonday = (y, m, n) => { const d = new Date(Date.UTC(y, m, 1)); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); d.setUTCDate(d.getUTCDate() + 7 * (n - 1)); return iso(d); };

// The bond-only closures for a year: the second Monday of October and 11 November (or the 12th
// when the 11th is a Sunday). Saturday's Veterans Day closes nothing.
export function bondOnlyClosures(year) {
  const out = [nthMonday(year, 9, 2)];
  const vd = new Date(Date.UTC(year, 10, 11)), wd = vd.getUTCDay();
  if (wd === 0) out.push(`${year}-11-12`); else if (wd !== 6) out.push(`${year}-11-11`);
  return out;
}

const EXCHANGE = new Set(HOLIDAYS?.US?.closed || []);
const bondCache = new Map();
export function bondClosed(date) {
  const y = Number(date.slice(0, 4));
  if (!bondCache.has(y)) bondCache.set(y, new Set(bondOnlyClosures(y)));
  return EXCHANGE.has(date) || bondCache.get(y).has(date);
}

// Weekdays after `from` up to and including today (UTC), skipping closures. `calendar` is
// 'bond' for Treasury/Fed prints, 'exchange' for anything that settles on the stock-exchange
// calendar (ZQ futures settle on Columbus and Veterans Day). Null for a missing or bad date.
export function businessDaysSince(from, { now = new Date(), calendar = 'bond' } = {}) {
  const d = new Date(`${from}T00:00:00Z`);
  if (!from || isNaN(d.getTime())) return null;
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const shut = calendar === 'bond' ? bondClosed : (x) => EXCHANGE.has(x);
  let n = 0;
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6 || shut(iso(d))) continue;
    n++;
  }
  return n;
}
