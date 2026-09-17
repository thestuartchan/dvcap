// test/catalystFeed.test.mjs — the catalyst window's inputs: the one calendar over a range, the
// per-name earnings cache with its fetchedAt, region filtering, and the assembled lookup. The feed
// and the store are injected: no network, no Redis, the same answer in every environment.
import { earningsCached, macroFor, regionFor, catalystLookup, EARNINGS_KEY, EARNINGS_TTL_MS } from '../lib/catalystFeed.js';
import { eventsBetween } from '../lib/calendar.js';
import { sizerRun, sizeTrade, mismatchReview } from '../lib/sizer.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

const memKv = (seed = {}) => { const m = new Map(Object.entries(seed)); return {
  configured: () => true, get: async k => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, m }; };
const noKv = { configured: () => false };
const T0 = Date.parse('2026-09-17T12:00:00Z');
const answer = (sym, date, status = 'confirmed', fetchedAt = '2026-09-17T11:00:00Z') =>
  ({ ok: true, symbol: sym, date, status, time: null, source: 'Nasdaq (Zacks)', fetchedAt });
const failing = async (sym) => ({ ok: false, symbol: sym, date: null, status: 'unavailable', source: 'Nasdaq (Zacks)', fetchedAt: '2026-09-17T12:00:00Z', why: 'feed error — HTTP 503' });
const counting = (impl) => { const f = async (s) => { f.calls++; return impl(s); }; f.calls = 0; return f; };

// ── THE CALENDAR OVER A RANGE ────────────────────────────────────────────────
{
  const ev = eventsBetween('2026-09-16', '2026-09-18');
  ok('the FOMC is in the range', ev.some(e => e.date === '2026-09-16' && /FOMC/.test(e.title)));
  ok('the weekly claims rule expands into the range', ev.some(e => e.date === '2026-09-17' && /Jobless Claims/.test(e.title) && e.recurring));
  ok('the last day is inclusive', ev.some(e => e.date === '2026-09-18'));
  ok('nothing outside it', ev.every(e => e.date >= '2026-09-16' && e.date <= '2026-09-18'));
  eq('a bad range is empty', [eventsBetween('2026-09-18', '2026-09-16'), eventsBetween('x', '2026-09-16')], [[], []]);
  ok('sorted by date', ev.every((e, i) => i === 0 || e.date >= ev[i - 1].date));
}

// ── REGION AND THE MACRO LEG ─────────────────────────────────────────────────
{
  eq('US by default, ASIA and EU by suffix', [regionFor('INTC'), regionFor('7709.HK'), regionFor('000660.KS'), regionFor('7709'), regionFor('SAP.DE')], ['US', 'ASIA', 'ASIA', 'ASIA', 'EU']);
  const us = macroFor('INTC', '2026-09-17', '2026-10-16');
  ok('tier 1 only', us.every(e => e.tier <= 1));
  ok('no ASIA-only event for a US name', !us.some(e => /China activity/.test(e.title)));
  ok('but a global one (BoJ) stays', us.some(e => /BoJ/.test(e.title)));
  ok('monthly opex is generated in', us.some(e => e.date === '2026-10-16' && e.title === 'Monthly opex' && e.generated));
  const hk = macroFor('7709.HK', '2026-09-11', '2026-09-20');
  ok('an HK name sees the ASIA calendar', hk.some(e => /China activity/.test(e.title)));
  ok('and not the US-only ones', !hk.some(e => e.region === 'US' && e.scope !== 'global') && hk.some(e => e.region === 'US' && e.scope === 'global'));
}

// ── THE CACHE ────────────────────────────────────────────────────────────────
{
  const kv = memKv();
  const feed = counting(s => answer(s, '2026-10-21'));
  const a = await earningsCached('intc', { fetcher: feed, kv, now: T0 });
  eq('first call fetches and stores', [a.date, a.cache, feed.calls, !!kv.m.get(EARNINGS_KEY('INTC'))], ['2026-10-21', 'fresh', 1, true]);
  const b = await earningsCached('INTC', { fetcher: feed, kv, now: T0 + 3600000 });
  eq('an hour later it is served from the store', [b.date, b.cache, feed.calls, b.fetchedAt], ['2026-10-21', 'kv', 1, '2026-09-17T11:00:00Z']);
  const c = await earningsCached('INTC', { fetcher: feed, kv, now: T0 + EARNINGS_TTL_MS + 1 });
  eq('a day later it fetches again', [c.cache, feed.calls], ['fresh', 2]);
  // Feed error: the last real answer is served, marked stale, its fetchedAt untouched.
  const d = await earningsCached('INTC', { fetcher: failing, kv, now: T0 + 2 * EARNINGS_TTL_MS });
  eq('a feed error serves the last answer, marked', [d.ok, d.date, d.cache, d.stale, d.fetchedAt], [true, '2026-10-21', 'kv-stale', true, '2026-09-17T11:00:00Z']);
  const e = await earningsCached('AVGO', { fetcher: failing, kv, now: T0 });
  eq('with nothing cached a feed error is unavailable and not stored', [e.ok, e.status, e.cache, kv.m.has(EARNINGS_KEY('AVGO'))], [false, 'unavailable', 'none', false]);
  const vendorNo = async (s) => ({ ok: false, symbol: s, date: null, status: 'unavailable', source: 'Nasdaq (Zacks)', fetchedAt: '2026-09-17T12:00:00Z', why: 'the vendor has not published a date' });
  const f = await earningsCached('AVGO', { fetcher: vendorNo, kv, now: T0 });
  eq('a vendor "no date" IS stored — it is an answer', [f.ok, kv.m.has(EARNINGS_KEY('AVGO'))], [false, true]);
  const g = await earningsCached('INTC', { fetcher: feed, kv: noKv, now: T0 });
  eq('no store: every call fetches', [g.cache, feed.calls], ['fresh', 3]);
  eq('no symbol is null', await earningsCached('', { fetcher: feed, kv }), null);
}

// ── THE LOOKUP — THE BRIEF'S ACCEPTANCE TABLE, END TO END ────────────────────
{
  const feed = async (s) => s === 'INTC' ? answer('INTC', '2026-10-21') : s === 'IRM' ? answer('IRM', '2026-11-04', 'estimated') : s === 'MU' ? answer('MU', '2026-09-23') : failing(s);
  const intc = await catalystLookup({ symbol: 'INTC', expiry: '2026-10-02', kind: 'option', today: '2026-09-17', fetcher: feed, kv: noKv });
  eq('INTC Oct02 115C: MISMATCH, +19', [intc.ok, intc.class, intc.flag, intc.gapDays], [true, 'MISMATCH', 'amber', 19]);
  ok('the macro list rides along for the sizer', Array.isArray(intc.macro) && intc.macro.some(e => e.title === 'Monthly opex'));
  ok('inside has the jobs report on expiry day', intc.inside.some(e => /jobs report/.test(e.title)));
  ok('after carries the earnings line with +19', intc.lines.some(l => l.where === 'after' && l.kind === 'earnings' && /\+19 days/.test(l.text)));
  eq('the log form is complete', Object.keys(intc.log).sort(), ['catalyst_class', 'earnings_status', 'feed_source', 'fetched_at', 'gap_days', 'inside_events', 'own_earnings_date']);
  const irm = await catalystLookup({ symbol: 'IRM', expiry: '2026-10-16', kind: 'option', today: '2026-09-17', fetcher: feed, kv: noKv });
  eq('IRM Oct16: MISMATCH, estimated', [irm.class, irm.own.status, irm.gapDays], ['MISMATCH', 'estimated', 19]);
  const qqq = await catalystLookup({ symbol: 'QQQ', expiry: '2026-10-16', kind: 'option', today: '2026-09-17', fetcher: feed, kv: noKv });
  eq('QQQ: MACRO ONLY, no feed call', [qqq.class, qqq.own, qqq.feed], ['MACRO ONLY', null, null]);
  const xle = await catalystLookup({ symbol: 'XLE', expiry: '2026-10-16', kind: 'option', today: '2026-09-17', fetcher: feed, kv: noKv });
  eq('XLE: MACRO ONLY', xle.class, 'MACRO ONLY');
  const hk = await catalystLookup({ symbol: '7709.HK', kind: 'stock', today: '2026-09-17', fetcher: feed, kv: noKv });
  eq('7709.HK reads across to MU', [hk.readAcrossKeys, hk.readAcross[0].date, hk.class], [['MU'], '2026-09-23', null]);
  ok('and says so', /read-across: MU earnings Sep 23 · confirmed/.test(hk.summary));
  const avgo = await catalystLookup({ symbol: 'AVGO', expiry: '2026-10-16', kind: 'option', today: '2026-09-17', fetcher: feed, kv: noKv });
  eq('a feed error is UNKNOWN with the manual-check wording', [avgo.class, avgo.flag], ['UNKNOWN', 'neutral']);
  ok('…', /earnings date unavailable — check manually/.test(avgo.why));
  ok('and AVGO still reads across to NVDA', avgo.readAcrossKeys.includes('NVDA'));
  const stock = await catalystLookup({ symbol: 'INTC', kind: 'stock', today: '2026-09-17', fetcher: feed, kv: noKv });
  eq('a stock: next earnings only, no class', [stock.class, stock.window], [null, null]);
  ok('…with the date and status', /INTC earnings Oct 21 · confirmed/.test(stock.summary));
  eq('no symbol', (await catalystLookup({ symbol: '' })).ok, false);
}

// ── THE RUN CARRIES THE WINDOW; THE MONTH COUNTS IT ──────────────────────────
{
  const NOW = new Date('2026-09-17T14:00:00Z');
  const r = sizeTrade({ kind: 'option', symbol: 'INTC 2026-10-02 C115', price: 112, atr: 3.1, delta: 0.45, mark: 2.4, expiry: '2026-10-02', nlv: 200000, now: NOW });
  const log = { catalyst_class: 'MISMATCH', own_earnings_date: '2026-10-21', earnings_status: 'confirmed', gap_days: 19, inside_events: ['2026-10-02 US September jobs report'], feed_source: 'Nasdaq (Zacks)', fetched_at: '2026-09-17T11:00:00Z' };
  const run = sizerRun(r, { at: '2026-09-17T14:05:00Z', window: log });
  eq('the run carries the window', run.catalystWindow, log);
  eq('and null when there was no lookup', sizerRun(r, { at: '2026-09-17T14:05:00Z' }).catalystWindow, null);
  const runs = [
    run, { ...run, at: '2026-09-10T14:00:00Z', catalystWindow: { ...log, catalyst_class: 'EVENT' } },
    { ...run, at: '2026-09-12T14:00:00Z', catalystWindow: { ...log, catalyst_class: 'TIGHT' } },
    { ...run, at: '2026-07-01T14:00:00Z' },                          // out of the month
    { ...run, kind: 'stock', at: '2026-09-15T14:00:00Z' },           // not an option
    { ...run, at: '2026-09-16T14:00:00Z', catalystWindow: null },    // no lookup: not counted
  ];
  const m = mismatchReview(runs, { now: NOW });
  eq('4 of ... the month counts option runs with a window', [m.n, m.mismatch, m.tight], [3, 1, 1]);
  eq('and says so', m.note, '1 of 3 option entries in 30d were MISMATCH, 1 TIGHT');
  ok('and names what it cannot say', /not tracked/.test(m.outcome));
  eq('nothing yet is silent', mismatchReview([], { now: NOW }).note, null);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
