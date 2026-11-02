// lib/exitLookback.js — reading the date-ranged statement that finds an option card's exit.
//
// MSFT, 2 Nov 2026. #430 taught the sync to ask IBKR for the days since an option card's last fill
// (lib/optionExits.js exitWindow), because the exit was taken before the day the statement covers.
// The banner still said "in the console, not at IBKR" after every Re-check. That ranged request:
//   - started FRESH on every call — a new SendRequest, so IBKR began building it from nothing;
//   - got only what was left of the function's 60 seconds after the day's statement;
//   - and when IBKR had not finished, was dropped without a word.
// A two-week statement takes longer to build than one day's, so it never arrived. Now it works the
// way the day's statement already does (lib/flex.js fetchStatement `pending`): a request still being
// built is remembered and the next call polls THAT one; once read, its order units are kept until
// the statement day moves on; the wait fits the time left; and the caller is told which happened,
// so the banner can say "still reading" rather than nothing.
import { fetchStatement, FLEX_WAITS_MS } from './flex.js';
import { orderUnits } from './journalInbox.js';
import { parseTrades } from './flexTrades.js';

export const RANGE_PENDING_KEY = 'dvcap:flex:range:pending:v1';
export const RANGE_UNITS_KEY = 'dvcap:flex:range:units:v1';
const PENDING_TTL_S = 15 * 60;
const UNITS_TTL_S = 24 * 3600;
const sameRange = (a, b) => !!(a && b && a.from === b.from && a.to === b.to);

// How many polls fit in `ms`: each poll is a request (~1.5s) plus the wait before it.
export function attemptsWithin(ms, waits, perRequestMs = 1500) {
  let used = perRequestMs, n = 1;   // the first poll has no wait
  while (n <= waits.length) {
    const next = used + waits[Math.min(n - 1, waits.length - 1)] + perRequestMs;
    if (next > ms) break;
    used = next; n++;
  }
  return n;
}

// back: { from, to } from exitWindow. kv: { get(key), set(key, value, ttlSeconds) }.
// → { units, state: 'read' | 'cached' | 'pending' | 'failed', error? }  (units null unless read/cached)
export async function readExitWindow(back, { token, queryId, kv, budgetMs = 20000, waits, fetchImpl, sleep } = {}) {
  try {
    const hit = await kv.get(RANGE_UNITS_KEY);
    if (sameRange(hit, back) && Array.isArray(hit.units)) return { units: hit.units, state: 'cached' };
  } catch { /* read it */ }
  let pending = null;
  try { const p = await kv.get(RANGE_PENDING_KEY); if (sameRange(p, back)) pending = p; } catch { /* fresh */ }
  const opts = { token, queryId, range: back, pending: pending ? { url: pending.url, referenceCode: pending.referenceCode } : null };
  if (waits) opts.waits = waits;
  if (fetchImpl) opts.fetchImpl = fetchImpl;
  if (sleep) opts.sleep = sleep;
  opts.attempts = attemptsWithin(budgetMs, opts.waits || FLEX_WAITS_MS);
  let got;
  try { got = await fetchStatement(opts); } catch (e) { return { units: null, state: 'failed', error: String(e?.message || e).slice(0, 120) }; }
  try {
    if (got.pending) await kv.set(RANGE_PENDING_KEY, { ...back, ...got.pending }, PENDING_TTL_S);
    else if (pending) await kv.set(RANGE_PENDING_KEY, null, 1);
  } catch { /* the next call starts fresh */ }
  if (got.ok) {
    const units = orderUnits(parseTrades(got.xml));
    try { await kv.set(RANGE_UNITS_KEY, { ...back, units }, UNITS_TTL_S); } catch { /* read again next time */ }
    return { units, state: 'read' };
  }
  return { units: null, state: got.retryable ? 'pending' : 'failed', error: got.error ? String(got.error).slice(0, 120) : null };
}

// The banner's line while the exit is still being looked for.
export function lookbackLine(back, r) {
  return r.state === 'pending'
    ? `looking for option exits back to ${back.from}: IBKR is still building that statement — Re-check in a minute`
    : `could not read the statement back to ${back.from} to look for option exits${r.error ? ` (${r.error})` : ''} — Re-check, or record the exit by hand`;
}
