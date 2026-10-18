// lib/consoleStamps.js — the dates the Console's numbers are made of, said beside the numbers.
//
// Three figures on the Console were read as current without saying when they were from:
//   • the prices — quoted on load and on 🔄, with no time on screen, so a tab left open since
//     the morning valued the book at the morning's prices;
//   • account equity — every "× NLV" is a ratio to it, and it is typed by hand on no schedule;
//   • the statement's own NLV, which the IBKR sync now carries (lib/flex.js navOf) and nothing
//     compared the typed figure against.
// Pure: the screen asks, this answers.
import { freshness } from './sessions.js';
import { equityFreshness } from './sizing.js';

// ── PRICES AS OF ─────────────────────────────────────────────────────────────
// `symbols` are the quotes the open book is valued at; `prices` is the quote map (q.ts in unix
// seconds). The time is the OLDEST quote from a market that is open — the book is only as current
// as its oldest live price. A market that is shut is at its prior close by design and does not
// drag the time back; it is counted, not hidden. Stale is the quote module's own test (market
// open, older than the intraday cadence plus the venue's delay).
export function pricesStamp(symbols = [], prices = {}, now = Date.now()) {
  const list = [...new Set((symbols || []).filter(Boolean))];
  if (!list.length) return null;
  const reads = list.map(s => ({ s, q: prices?.[s] || null, fr: freshness(s, prices?.[s], now) }));
  const live = reads.filter(r => r.q?.ts != null && !['prior-close', 'holiday', 'no-print', 'future'].includes(r.fr.state));
  const dated = reads.filter(r => r.q?.ts != null);
  const pick = live.length ? live : dated;
  const asOfMs = pick.length ? Math.min(...pick.map(r => r.q.ts)) * 1000 : null;
  return {
    asOfMs,
    // What the time is the time of: open markets, or (all shut) the newest prior close there is.
    basis: live.length ? 'open' : dated.length ? 'closed' : null,
    stale: reads.filter(r => r.fr.state === 'stale').map(r => ({ symbol: r.s, ageMin: r.fr.ageMin })),
    closed: reads.filter(r => r.fr.state === 'prior-close' || r.fr.state === 'holiday').length,
    missing: reads.filter(r => r.fr.state === 'no-print').map(r => r.s),
    total: list.length,
  };
}

// HH:MM in the reader's own clock — the device the Console is open on.
export function clockHHMM(ms, timeZone = undefined) {
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) }).format(new Date(ms));
  } catch { return null; }
}

// ── THE DATE BESIDE EVERY "× NLV" ────────────────────────────────────────────
// "0.9× NLV" is a ratio to a figure; this is that figure's date, short. Stale past the sizing
// module's own threshold.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function nlvDate(asOf, today = new Date().toISOString().slice(0, 10)) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(asOf || ''));
  if (!m) return { text: 'NLV undated', stale: false, days: null };
  const f = equityFreshness(asOf, today);
  const sameYear = today.slice(0, 4) === m[1];
  return { text: `NLV of ${Number(m[3])} ${MON[Number(m[2]) - 1]}${sameYear ? '' : ` ${m[1]}`}`, stale: f.stale, days: f.days };
}

// ── THE TYPED FIGURE AGAINST THE STATEMENT'S ─────────────────────────────────
// `nav` is the flex note's (lib/flex.js navOf). The answer is one of:
//   missing  — the statement has no NLV section; nothing changes, and the reason is said;
//   currency — the statement is in another currency than Settings; not compared;
//   prefill  — Settings has no figure yet; the statement's is offered to fill it;
//   agrees   — within DRIFT_PCT;
//   drift    — further apart than that; flagged, with both figures and dates.
export const NAV_DRIFT_PCT = 2;
export function navCheck({ equity = null, equityAsOf = null, nav = null, baseCcy = 'USD' } = {}) {
  if (!nav) return { state: 'missing', reason: 'no IBKR statement has been read yet' };
  if (nav.value == null) return { state: 'missing', reason: nav.missing || 'not in the statement' };
  const ccy = nav.currency || null;
  if (ccy && ccy !== String(baseCcy || 'USD').toUpperCase()) {
    return { state: 'currency', value: nav.value, asOf: nav.asOf, currency: ccy,
             reason: `the statement is in ${ccy} and Settings in ${baseCcy} — not compared` };
  }
  const typed = Number(equity);
  if (equity == null || equity === '' || !Number.isFinite(typed) || typed <= 0) return { state: 'prefill', value: nav.value, asOf: nav.asOf, currency: ccy };
  const driftPct = +(((typed - nav.value) / nav.value) * 100).toFixed(1);
  const newer = !!(nav.asOf && (!equityAsOf || nav.asOf > equityAsOf));
  return { state: Math.abs(driftPct) > NAV_DRIFT_PCT ? 'drift' : 'agrees', value: nav.value, asOf: nav.asOf, currency: ccy, driftPct, newer };
}
