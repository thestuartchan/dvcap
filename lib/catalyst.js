// catalyst.js — does the thing the trade depends on happen before the contract dies?
//
// Three option positions in one month were defined-duration contracts on theses with no event
// inside the contract's life: AVGO 390C to 16 Oct on December earnings, IRM 120C to 16 Oct on
// November earnings, INTC 115C to 2 Oct on 21 Oct earnings — nineteen days after expiry. The sizer
// answered how many; this answers WHEN, beside it. Information only: nothing here blocks, gates or
// requires a field, and amber is the ceiling. Discipline comes from the log.
//
// Three sources merged: the macro calendar the board already keeps, the earnings feed
// (lib/earnings.js), and a hand-kept read-across map (data/readacross.json) — never inferred.
import { LEVERAGED_ETF, CASH_LIKE_ETF } from './bookExposure.js';

export const TAIL_DAYS = 14;        // the window runs to expiry + this: a catalyst just after expiry is the case to surface
export const TIGHT_TRADING_DAYS = 5; // own earnings fewer than this many trading days before expiry → TIGHT

// Broad ETFs and indices carry no earnings; the lookup is skipped, macro events only.
export const BROAD_ETF = Object.freeze(['QQQ', 'SPY', 'IWM', 'DIA', 'RSP', 'VTI', 'VOO', 'IVV', 'MDY',
  'XLE', 'XLK', 'XLF', 'XLU', 'XLP', 'XLY', 'XLV', 'XLI', 'XLB', 'XLRE', 'XLC', 'SMH', 'SOXX', 'XBI', 'IBB', 'KRE', 'XOP', 'ITB', 'XHB',
  'GLD', 'SLV', 'GDX', 'USO', 'UNG', 'TLT', 'IEF', 'SHY', 'HYG', 'LQD', 'TIP', 'BND', 'AGG',
  'KWEB', 'FXI', 'MCHI', 'EEM', 'EWY', 'EWJ', 'EWT', 'EWZ', 'EFA', 'VGK', 'ARKK', 'IYT',
  'TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'SPXL', 'SPXS', 'UPRO', 'TNA', 'TZA', 'FNGU', 'UVXY', 'VXX', 'SVIX',
  ...CASH_LIKE_ETF]);
// Single-name leveraged wrappers track ONE company; its earnings are the wrapper's catalyst.
export const SINGLE_NAME_ETF = Object.freeze({ AAPU: 'AAPL', TSLL: 'TSLA', NVDL: 'NVDA', MSFU: 'MSFT', AMZU: 'AMZN', GGLL: 'GOOGL', METU: 'META', PLTU: 'PLTR', CONL: 'COIN' });

export function instrumentKind(symbol) {
  const s = String(symbol || '').toUpperCase().trim();
  if (!s) return 'unknown';
  if (s.startsWith('^') || /=F$/.test(s)) return 'index';
  // FOREIGN BEFORE THE TABLES. 7709.HK joined the leveraged table on 2026-09-22 (it is CSOP's 2×
  // wrapper); it is still a Hong Kong listing with no US earnings feed, and that is what decides
  // the lookup.
  if (/^\d{1,5}(\.HK)?$/.test(s) || /\.(KS|KQ|T|TW|L|PA|DE|AS)$/.test(s)) return 'foreign';
  if (SINGLE_NAME_ETF[s]) return 'single-name-etf';
  if (BROAD_ETF.includes(s) || (Object.prototype.hasOwnProperty.call(LEVERAGED_ETF, s) && !SINGLE_NAME_ETF[s])) return 'etf';
  return 'single-name';
}
// The name whose earnings are looked up for this symbol, or null when there is none to look up.
export function earningsNameFor(symbol) {
  const k = instrumentKind(symbol);
  if (k === 'single-name') return String(symbol).toUpperCase().trim();
  if (k === 'single-name-etf') return SINGLE_NAME_ETF[String(symbol).toUpperCase().trim()];
  return null;
}
// Keys of the read-across map whose lists name this symbol.
export function readAcrossFor(symbol, map = {}) {
  const s = String(symbol || '').toUpperCase().trim();
  const bare = s.replace(/\.HK$/, '').replace(/^0+(?=\d)/, '');
  return Object.entries(map || {})
    .filter(([k, v]) => !k.startsWith('_') && Array.isArray(v) && v.some(x => { const t = String(x).toUpperCase(); return t === s || t.replace(/\.HK$/, '').replace(/^0+(?=\d)/, '') === bare; }))
    .map(([k]) => k.toUpperCase());
}

const iso = d => d.toISOString().slice(0, 10);
const addDays = (isoDate, n) => { const d = new Date(isoDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
// Trading days strictly between two dates (weekdays, minus listed holidays).
export function tradingDaysBetween(from, to, holidays = []) {
  if (!from || !to || to <= from) return 0;
  const H = new Set(holidays || []);
  let n = 0;
  for (let d = new Date(from + 'T00:00:00Z'); ; ) {
    d.setUTCDate(d.getUTCDate() + 1);
    const s = iso(d);
    if (s >= to) break;
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6 && !H.has(s)) n++;
  }
  return n;
}
// Monthly options expiry: the third Friday of each month in the window.
export function monthlyOpex(from, to) {
  const out = [];
  const start = new Date(from + 'T00:00:00Z');
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); ; ) {
    const first = new Date(Date.UTC(y, m, 1));
    const firstFri = 1 + ((5 - first.getUTCDay() + 7) % 7);
    const third = iso(new Date(Date.UTC(y, m, firstFri + 14)));
    if (third > to) break;
    if (third >= from) out.push({ date: third, title: 'Monthly opex', kind: 'macro', tier: 1, generated: true });
    m++; if (m > 11) { m = 0; y++; }
  }
  return out;
}

const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const fmt = d => d ? new Date(d + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—';

// The window. `own` is lib/earnings.js's answer for the name (or null when none was looked up);
// `readAcross` is [{ key, ...answer }] for the mapped names; `macro` is [{date,title,tier}] from
// the calendar. `kind` is 'option' | 'stock'. Today is injectable.
export function catalystWindow({ symbol, kind = 'option', expiry = null, today = new Date().toISOString().slice(0, 10),
                                 macro = [], own = null, readAcross = [], holidays = [], tailDays = TAIL_DAYS } = {}) {
  const ik = instrumentKind(symbol);
  const name = earningsNameFor(symbol);
  const events = [];
  const push = (e) => { if (e?.date) events.push(e); };
  // Macro: tier 1 only — a weekly claims print is not what "is there a catalyst" means.
  for (const e of macro || []) if ((e.tier ?? 2) <= 1) push({ date: e.date, title: e.title || e.label, kind: 'macro', status: null });
  // Own earnings.
  if (own?.ok && own.date) push({ date: own.date, title: `${name} earnings`, kind: 'earnings', status: own.status, time: own.time });
  // Read-across.
  for (const r of readAcross || []) if (r?.ok && r.date) push({ date: r.date, title: `${r.key || r.symbol} earnings`, kind: 'read-across', status: r.status });

  if (kind !== 'option' || !expiry) {
    // Stocks: the next own earnings date only, no classification.
    const next = own?.ok ? own : null;
    const ra = (readAcross || []).filter(r => r?.ok && r.date);
    // The read-across is the whole point for a foreign name: 7709.HK has no US feed, but MU's
    // date is what moves it, and that is what the line says.
    const lines = ra.map(r => ({ where: 'next', date: r.date, title: `${r.key || r.symbol} earnings`, kind: 'read-across', status: r.status,
                                 text: `${fmt(r.date)}  ${r.key || r.symbol} earnings (read-across)  ${r.status || ''}`.trim() }));
    const summary = name
      ? (next ? `${name} earnings ${fmt(next.date)} · ${next.status}` : `${name} earnings date unavailable — check manually`)
      : ra.length ? `read-across: ${ra.map(r => `${r.key || r.symbol} earnings ${fmt(r.date)} · ${r.status}`).join(', ')}`
      : 'no earnings lookup — not a single name';
    return { symbol, kind, instrument: ik, name, today, expiry: null, window: null, class: null, flag: 'neutral', gapDays: null,
             own: own || null, readAcross, inside: [], after: [], lines, summary,
             feed: own ? { source: own.source, fetchedAt: own.fetchedAt } : null,
             log: { catalyst_class: null, own_earnings_date: next?.date ?? null, earnings_status: own?.status ?? (name ? 'unavailable' : null),
                    gap_days: null, inside_events: [], feed_source: own?.source ?? null, fetched_at: own?.fetchedAt ?? null } };
  }

  const to = addDays(expiry, tailDays);
  const inside = events.filter(e => e.date >= today && e.date <= expiry).sort((a, b) => a.date.localeCompare(b.date));
  // After expiry: everything inside the tail, plus the name's own earnings wherever they land — the
  // "after expiry  Oct 21  INTC earnings  +19 days" line is the point of the block, tail or no tail.
  const after = events.filter(e => (e.date > expiry && e.date <= to) || (e.kind === 'earnings' && e.date > expiry))
    .sort((a, b) => a.date.localeCompare(b.date));
  const ownInside = own?.ok && own.date >= today && own.date <= expiry;
  const ownAfter = own?.ok && own.date > expiry && own.date <= to;
  const ownBeyond = own?.ok && own.date > to;
  const gapDays = own?.ok && own.date ? dayDiff(expiry, own.date) : null;
  const tradingBefore = ownInside ? tradingDaysBetween(own.date, expiry, holidays) : null;

  let cls, flag, why;
  if (!name) { cls = 'MACRO ONLY'; flag = 'neutral'; why = 'not a single name — macro events only'; }
  else if (!own || !own.ok) { cls = 'UNKNOWN'; flag = 'neutral'; why = `${name} earnings date unavailable — check manually`; }
  else if (ownInside && tradingBefore < TIGHT_TRADING_DAYS) { cls = 'TIGHT'; flag = 'amber'; why = `own earnings ${fmt(own.date)} land ${tradingBefore} trading day${tradingBefore === 1 ? '' : 's'} before expiry — IV crush and the gap arrive at the very end`; }
  else if (ownInside) { cls = 'EVENT'; flag = 'neutral'; why = `own earnings ${fmt(own.date)}, ${tradingBefore} trading days before expiry`; }
  else if (ownAfter) { cls = 'MISMATCH'; flag = 'amber'; why = `own catalyst lands after expiry — ${fmt(own.date)}, +${gapDays} days`; }
  else if (ownBeyond) { cls = 'MISMATCH'; flag = 'amber'; why = `own catalyst lands after expiry — ${fmt(own.date)}, +${gapDays} days; no own earnings inside the life of the contract`; }
  else { cls = 'MISMATCH'; flag = 'amber'; why = `own earnings ${fmt(own.date)} already passed — none inside the life of the contract`; }

  const label = e => `${fmt(e.date)}  ${e.title}${e.kind === 'read-across' ? ' (read-across)' : ''}${e.kind === 'macro' ? '' : `  ${e.status || ''}`}`.trim();
  const lines = [
    ...inside.map(e => ({ where: 'inside', ...e, text: label(e) })),
    ...after.map(e => ({ where: 'after', ...e, text: `${label(e)}${e.kind === 'earnings' && gapDays != null ? `  +${gapDays} days` : ''}` })),
  ];
  return {
    symbol, kind, instrument: ik, name, today, expiry, window: { from: today, to },
    dte: dayDiff(today, expiry), class: cls, flag, why, gapDays, tradingBefore,
    own: own || null, readAcross, inside, after, lines,
    feed: own ? { source: own.source, fetchedAt: own.fetchedAt } : null,
    // The compact form the sizer run and the decision log carry.
    log: { catalyst_class: cls, own_earnings_date: own?.date ?? null, earnings_status: own?.status ?? (name ? 'unavailable' : null),
           gap_days: gapDays, inside_events: inside.map(e => `${e.date} ${e.title}`), feed_source: own?.source ?? null, fetched_at: own?.fetchedAt ?? null },
  };
}
