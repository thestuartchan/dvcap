// lib/crossCheck.js — the read-only cross-check JSON: sources a market read is checked against.
//
// Served at /api/g/<gamma slug>/crosscheck (api/gex.js), for the Current Market Read skill's
// "cross-check" section. It REPORTS DATA AND SIMPLE STATISTICS ONLY — levels, five-print changes,
// percentile ranks — and never says whether anything "aligns"; the reader judges that against the
// day's read. Every block carries as_of, fetched_at_utc, cadence and a status (fresh | stale |
// unavailable, with an error when unavailable), and one failing source never fails the response.
//
// DATA ONLY. The payload is built from named market fields; no key, credential or private figure
// is ever read here, errors are scrubbed of URLs and query strings, and the route refuses to send
// a body in which any of the banned words appears as a word (crossCheckLeaks).
//
// Pure where it can be: every compute* function is a function of its arguments. The fetchers at the
// bottom are injected into buildCrossCheck, so the tests run without the network.

const num = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);

// ── WHAT MAY NEVER BE SENT ───────────────────────────────────────────────────
// The gamma feed's list. Matched as WORDS here — delimited by anything that is not a letter — because
// the brief's own block name, "positioning", contains "position"; "api_key=" and "token" are still
// caught, "positioning" is not.
export const CROSSCHECK_BANNED = Object.freeze(['position', 'qty', 'nlv', 'journal', 'alert', 'key', 'token']);
export function crossCheckLeaks(json) {
  const s = String(typeof json === 'string' ? json : JSON.stringify(json)).toLowerCase();
  return CROSSCHECK_BANNED.filter(w => new RegExp(`(^|[^a-z])${w}s?([^a-z]|$)`).test(s));
}
// An error string, made safe to send: no URLs, no query strings, none of the banned words, short.
export function scrubError(e) {
  let s = String(e?.message || e || 'unknown error');
  s = s.replace(/https?:\/\/\S+/g, '<source>').replace(/[?&][a-z_]+=[^\s&]*/gi, '');
  for (const w of CROSSCHECK_BANNED) s = s.replace(new RegExp(`(^|[^a-z])${w}s?(?=[^a-z]|$)`, 'gi'), '$1[redacted]');
  return s.slice(0, 160);
}

// ── FRESHNESS ────────────────────────────────────────────────────────────────
// In business days. A block is stale when its latest observation is older than its publication lag
// plus one and a half cadences — so a daily FRED series that publishes a day late is fresh on a
// Monday reading Friday's print, and a weekly COT report (Tuesday data, Friday release) is fresh
// until the following week's release is overdue.
export const CADENCE = Object.freeze({
  credit:            { cadence: 'daily_lag1',  every: 1, lag: 1, ttlS: 6 * 3600 },
  real_yields:       { cadence: 'daily_lag1',  every: 1, lag: 1, ttlS: 6 * 3600 },
  term_premium:      { cadence: 'daily_lag2',  every: 1, lag: 2, ttlS: 12 * 3600 },
  breadth:           { cadence: 'daily',       every: 1, lag: 1, ttlS: 3600 },
  auctions:          { cadence: 'on_event',    every: null, lag: 0, ttlS: 3600 },
  positioning:       { cadence: 'weekly_fri',  every: 5, lag: 3, ttlS: 12 * 3600 },
  gamma_independent: { cadence: 'daily_lag1',  every: 1, lag: 1, ttlS: 6 * 3600 },
  sentiment_aaii:    { cadence: 'weekly_thu',  every: 5, lag: 0, ttlS: 24 * 3600 },
  put_call:          { cadence: 'daily_lag1',  every: 1, lag: 1, ttlS: 6 * 3600 },
});
export function bizDaysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (b <= a) return 0;
  let n = 0;
  for (let t = a + 864e5; t <= b; t += 864e5) { const d = new Date(t).getUTCDay(); if (d !== 0 && d !== 6) n++; }
  return n;
}
export function statusOf(block, asOf, today) {
  const c = CADENCE[block];
  if (!asOf) return 'unavailable';
  if (!c || c.every == null) return 'fresh';
  const age = bizDaysBetween(asOf, today);
  return age != null && age > c.lag + 1.5 * c.every ? 'stale' : 'fresh';
}

// ── STATISTICS ───────────────────────────────────────────────────────────────
// Mid-rank percentile of the last value within the list (0–100): ties count half.
export function pctRank(values = [], v) {
  const xs = values.filter(Number.isFinite);
  if (!xs.length || !Number.isFinite(v)) return null;
  const below = xs.filter(x => x < v).length, tied = xs.filter(x => x === v).length;
  return Math.round(((below + tied / 2) / xs.length) * 100);
}
// The change over five prints: the last value against the one five observations before it.
export function chg5(series = []) {
  if (series.length < 6) return null;
  return series[series.length - 1].value - series[series.length - 6].value;
}
export const dir5 = (bp, band = 3) => (bp == null ? null : bp > band ? 'widening' : bp < -band ? 'tightening' : 'flat');

// ── BLOCKS ───────────────────────────────────────────────────────────────────
// Each compute* returns the block's fields (as_of included); buildCrossCheck adds status and times.
export function computeCredit(series = []) {
  const s = series.slice(-10);
  if (!s.length) return null;
  const bp = chg5(series); const chg = bp == null ? null : Math.round(bp * 100);
  return { as_of: s[s.length - 1].date, series: s.map(o => ({ date: o.date, value: r2(o.value) })), chg_5d_bp: chg, dir_5d: dir5(chg) };
}
export function computeRealYields({ real = [], breakeven = [] } = {}) {
  if (!real.length && !breakeven.length) return null;
  const one = (s) => {
    if (!s.length) return null;
    const bp = chg5(s);
    return { as_of: s[s.length - 1].date, series: s.slice(-10).map(o => ({ date: o.date, value: r2(o.value) })), chg_5d_bp: bp == null ? null : Math.round(bp * 100) };
  };
  const tips = one(real), be = one(breakeven);
  const dates = [tips?.as_of, be?.as_of].filter(Boolean).sort();
  return { as_of: dates[dates.length - 1] ?? null, tips_10y: tips, breakeven_10y: be };
}
export function computeTermPremium(series = []) {
  const s = series.slice(-10);
  if (!s.length) return null;
  const bp = chg5(series);
  return { as_of: s[s.length - 1].date, model: 'ACM (NY Fed)', tenor: '10Y',
    series: s.map(o => ({ date: o.date, value: r2(o.value) })), chg_5d_bp: bp == null ? null : Math.round(bp * 100) };
}
// RSP over SPY on the dates both closed.
export function computeBreadth({ rsp = {}, spy = {} } = {}) {
  const dates = Object.keys(spy).filter(d => Number.isFinite(rsp[d]) && Number.isFinite(spy[d])).sort();
  if (dates.length < 2) return null;
  const ratio = dates.map(d => ({ date: d, value: rsp[d] / spy[d] }));
  const last = ratio.length - 1, back = Math.max(0, last - 5);
  const sd = dates[dates.length - 1], s5 = dates[back];
  return {
    as_of: sd,
    ratio_rsp_spy: ratio.slice(-6).map(o => ({ date: o.date, value: r4(o.value) })),
    ratio_chg_5d_pct: last >= 5 ? r2((ratio[last].value / ratio[back].value - 1) * 100) : null,
    spy_chg_5d_pct: last >= 5 ? r2((spy[sd] / spy[s5] - 1) * 100) : null,
  };
}
// Coupon auctions (notes, bonds, TIPS, FRNs) held in the last three days, each against the average
// of the previous six of the same type and tenor. Bills are left out: there are a dozen a week and
// the cross-check is about the coupon curve. No tail — that needs the when-issued yield, which no
// free feed carries, so it is omitted rather than estimated.
export function computeAuctions(rows = [], today, { days = 3, run = 6, groupOf = (r) => `${r.type}|${r.tenor}` } = {}) {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - days * 864e5).toISOString().slice(0, 10);
  const done = rows.filter(r => r.auctionDate && r.bidToCover != null).sort((a, b) => b.auctionDate.localeCompare(a.auctionDate));
  const recent = done.filter(r => r.auctionDate >= from && r.auctionDate <= today);
  const avg = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const items = recent.map(r => {
    const prev = done.filter(p => groupOf(p) === groupOf(r) && p.auctionDate < r.auctionDate).slice(0, run);
    return {
      cusip: r.cusip, security_term: r.term, security_type: r.type, auction_date: r.auctionDate, reopening: !!r.reopening,
      high_yield: r.highYield, bid_to_cover: r.bidToCover, indirect_pct: r.indirectPct, direct_pct: r.directPct, dealer_pct: r.dealerPct,
      prev_n: prev.length,
      prev_avg: prev.length ? { bid_to_cover: r2(avg(prev.map(p => p.bidToCover))), indirect_pct: r1(avg(prev.map(p => p.indirectPct))),
                                direct_pct: r1(avg(prev.map(p => p.directPct))), dealer_pct: r1(avg(prev.map(p => p.dealerPct))) } : null,
    };
  });
  return { as_of: today, window_days: days, scope: 'coupon auctions (notes, bonds, TIPS, FRNs); bills excluded; tail omitted (needs when-issued data)',
    items, note: items.length ? null : `no coupon auctions in the last ${days} days` };
}
// One CFTC market: the latest net, its weekly change, and where it sits in 52 weeks.
export function computeCotMarket(series = [], { trader }) {
  const s = series.filter(o => Number.isFinite(o.net));
  if (!s.length) return null;
  const last = s[s.length - 1], prev = s[s.length - 2] ?? null;
  const yr = s.slice(-52).map(o => o.net);
  const rank = pctRank(yr, last.net);
  return { report_date: last.date, trader, net: last.net, net_chg_wk: prev ? last.net - prev.net : null,
    pct_rank_52w: rank, extreme: rank == null ? null : rank <= 10 || rank >= 90, weeks_in_rank: yr.length };
}
// SqueezeMetrics DIX.csv: date, price, dix, gex.
export function parseDixCsv(text) {
  return String(text || '').trim().split(/\r?\n/).slice(1).map(l => l.split(','))
    .map(([date, price, dix, gex]) => ({ date, price: num(price), dix: num(dix), gex: num(gex) }))
    .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.dix != null);
}
export function computeDix(rows = []) {
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const yr = rows.slice(-252);
  return {
    as_of: last.date, source: 'SqueezeMetrics DIX.csv',
    series: rows.slice(-10).map(r => ({ date: r.date, price: r2(r.price), dix: r4(r.dix), gex: r.gex == null ? null : Math.round(r.gex) })),
    gex_sign: last.gex == null ? null : last.gex > 0 ? 'positive' : last.gex < 0 ? 'negative' : 'zero',
    dix_pct_rank_1y: pctRank(yr.map(r => r.dix), last.dix),
    gex_pct_rank_1y: pctRank(yr.map(r => r.gex), last.gex),
  };
}
// Cboe's daily market statistics JSON: the ratios block, by name.
export function parseCboeDaily(json, date) {
  const get = (re) => num((json?.ratios || []).find(x => re.test(String(x?.name || '')))?.value);
  const total = get(/^TOTAL PUT\/CALL/i), equity = get(/^EQUITY PUT\/CALL/i), index = get(/^INDEX PUT\/CALL/i);
  return total == null && equity == null && index == null ? null : { date, total, equity, index };
}
export function computePutCall(history = []) {
  const h = history.filter(x => x && x.date).sort((a, b) => a.date.localeCompare(b.date));
  if (!h.length) return null;
  const last = h[h.length - 1];
  const yr = h.slice(-252);
  return { as_of: last.date, sessions: h.slice(-5), equity_pct_rank_1y: pctRank(yr.map(x => x.equity), last.equity),
    rank_sample_sessions: yr.filter(x => Number.isFinite(x.equity)).length };
}
// AAII's weekly survey rows: { date, bullish, neutral, bearish } as fractions or percents.
export function computeAaii(rows = []) {
  const r = rows.filter(x => x && x.date && Number.isFinite(x.bullish) && Number.isFinite(x.bearish)).sort((a, b) => a.date.localeCompare(b.date));
  if (!r.length) return null;
  const pct = (v) => (v <= 1 ? v * 100 : v);
  const last = r[r.length - 1];
  const spreads = r.slice(-52).map(x => pct(x.bullish) - pct(x.bearish));
  return { as_of: last.date, survey_date: last.date, bullish: r1(pct(last.bullish)), neutral: r1(pct(last.neutral)), bearish: r1(pct(last.bearish)),
    bull_bear_spread: r1(pct(last.bullish) - pct(last.bearish)), spread_pct_rank_1y: pctRank(spreads, spreads[spreads.length - 1]) };
}

// ── ASSEMBLY ─────────────────────────────────────────────────────────────────
export const BLOCKS = Object.freeze(Object.keys(CADENCE));
// `sources` maps a block to an async function returning its computed fields (or throwing).
// `cache` is { get(block), set(block, value) } — a KV per block — so a slow or failing source serves
// its last good copy, marked stale by its own date, and a missing one is `unavailable` with why.
export async function buildCrossCheck({ sources = {}, cache = null, now = new Date(), timeoutMs = 20000 } = {}) {
  const today = now.toISOString().slice(0, 10);
  const blocks = {};
  await Promise.all(BLOCKS.map(async (name) => {
    const c = CADENCE[name];
    const hit = cache ? await Promise.resolve().then(() => cache.get(name)).catch(() => null) : null;
    const young = hit?.fetched_at_utc && now.getTime() - Date.parse(hit.fetched_at_utc) < c.ttlS * 1000;
    if (young && hit.data) { blocks[name] = finish(name, hit.data, hit.fetched_at_utc, today); return; }
    try {
      const fn = sources[name];
      if (!fn) throw new Error('no source configured');
      const data = await Promise.race([fn({ now, today }), new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs))]);
      if (!data) throw new Error('source returned no data');
      const fetched = now.toISOString();
      if (cache) { try { await cache.set(name, { data, fetched_at_utc: fetched }); } catch { /* served uncached */ } }
      blocks[name] = finish(name, data, fetched, today);
    } catch (e) {
      blocks[name] = hit?.data
        ? { ...finish(name, hit.data, hit.fetched_at_utc, today), refresh_error: scrubError(e) }
        : { status: 'unavailable', cadence: c.cadence, as_of: null, fetched_at_utc: now.toISOString(), error: scrubError(e) };
    }
  }));
  const ordered = Object.fromEntries(BLOCKS.map(b => [b, blocks[b]]));
  return { as_of_utc: now.toISOString(), blocks: ordered };
}
function finish(name, data, fetchedAt, today) {
  const asOf = data.as_of ?? data.report_date ?? null;
  return { status: statusOf(name, asOf, today), cadence: CADENCE[name].cadence, as_of: asOf, fetched_at_utc: fetchedAt, ...data };
}
// Statuses only — for the dashboard's Data health tab, which may show that a source is down
// without showing its data.
export function crossCheckHealth(payload) {
  return Object.fromEntries(Object.entries(payload?.blocks || {}).map(([k, b]) => [k, { status: b?.status ?? 'unavailable', as_of: b?.as_of ?? null, fetched_at_utc: b?.fetched_at_utc ?? null, error: b?.error ?? b?.refresh_error ?? null }]));
}
