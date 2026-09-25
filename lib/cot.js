// lib/cot.js — the CFTC's weekly positioning report, as a check on the CTA replica (lib/cta.js).
//
// WHY THIS, AND WHY ONLY AS A CHECK. The replica is a model of what trend funds would hold. The
// Commitments of Traders report is what large speculators DID hold, by law, every Tuesday — released
// the following Friday at 15:30 New York time. It is real data, but it is not CTA data: the
// category that holds CTAs also holds discretionary hedge funds and relative-value books. So it
// cannot replace the model; it can say, week by week, whether the model's direction is borne out.
//
//   Equities, Treasuries and the dollar — Traders in Financial Futures, LEVERAGED FUNDS.
//   Crude and gold                      — Disaggregated report, MANAGED MONEY, the closer proxy.
//
// JUDGED AGAINST ITS OWN HISTORY, NOT ZERO. Leveraged funds are structurally short S&P and Treasury
// futures — the cash-futures basis trade is a short future against a long cash position, and it is
// large. A raw sign would call every week "short" whatever trend funds did. So each week's net is
// placed against its own three-year average in standard deviations, and it is that direction the
// replica is compared with. The week's change in the net is compared with the replica's change
// over the same Tuesday-to-Tuesday week, which is the cleaner test of the two.
//
// WHERE IT TESTS THE MODEL, AND WHERE IT DOES NOT — measured, 2026-09-25, 52 weeks of Tuesdays:
//   crude, managed money      weekly changes agree 28 of 44 clear weeks, correlation +0.26
//   gold, managed money       agree 25 of 34, +0.34
//   S&P, leveraged funds      agree 11 of 42, −0.60
//   Nasdaq, 10-year, dollar   agree 14–15 of 42–44, −0.29 to −0.54
// Managed money in commodities is the textbook CTA proxy and it bears the replica out. Leveraged
// funds in financial futures run the OTHER way: that category is dominated by basis and relative-
// value books, which take the other side of real-money futures demand. So the track record is
// computed live, per market, and a market whose record does not track is said not to test the
// replica — rather than a single week's verdict being read as a check everywhere.
//
// Source: the CFTC's public reporting API (Socrata), keyless. No figure here comes from anywhere else.

export const COT_BASE = 'https://publicreporting.cftc.gov/resource';
export const TFF = 'gpe5-46if';            // Traders in Financial Futures, futures only
export const DISAGG = '72hh-3qpy';         // Disaggregated, futures only
export const COT_MARKETS = Object.freeze([
  { key: 'ES', dataset: TFF, code: '13874A', trader: 'leveraged funds', long: 'lev_money_positions_long', short: 'lev_money_positions_short' },
  { key: 'NQ', dataset: TFF, code: '209742', trader: 'leveraged funds', long: 'lev_money_positions_long', short: 'lev_money_positions_short' },
  { key: 'ZN', dataset: TFF, code: '043602', trader: 'leveraged funds', long: 'lev_money_positions_long', short: 'lev_money_positions_short' },
  { key: 'DX', dataset: TFF, code: '098662', trader: 'leveraged funds', long: 'lev_money_positions_long', short: 'lev_money_positions_short' },
  { key: 'CL', dataset: DISAGG, code: '067651', trader: 'managed money', long: 'm_money_positions_long_all', short: 'm_money_positions_short_all' },
  { key: 'GC', dataset: DISAGG, code: '088691', trader: 'managed money', long: 'm_money_positions_long_all', short: 'm_money_positions_short_all' },
]);
export const HISTORY_WEEKS = 156;          // three years
export const Z_CLEAR = 0.5;                // a net inside half a standard deviation of its average says little
export const MOVE_CLEAR = 0.05;            // nor does a replica that moved less than five points in the week
export const TRACK_WEEKS = 52;
// A record that "tracks": the weekly changes agree more often than not, and move together.
export const TRACK_MIN_HIT = 0.55;
export const TRACK_MIN_CORR = 0.15;

const num = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
const round = (x, dp) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(dp));

// Raw API rows → per market, oldest first: { date, net, oi }.
export function cotSeries(rows = []) {
  const out = {};
  for (const m of COT_MARKETS) {
    out[m.key] = rows.filter(r => r?.cftc_contract_market_code === m.code)
      .map(r => {
        const L = num(r[m.long]), S = num(r[m.short]);
        return { date: String(r.report_date_as_yyyy_mm_dd || '').slice(0, 10), net: L != null && S != null ? L - S : null, oi: num(r.open_interest_all) };
      })
      .filter(r => r.date && r.net != null)
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  return out;
}

// The latest week, against its own history.
export function cotRead(series = []) {
  if (series.length < 3) return null;
  const last = series.at(-1), prev = series.at(-2);
  const hist = series.slice(-HISTORY_WEEKS);
  const mean = hist.reduce((a, r) => a + r.net, 0) / hist.length;
  const sd = Math.sqrt(hist.reduce((a, r) => a + (r.net - mean) ** 2, 0) / hist.length);
  return {
    date: last.date, prevDate: prev.date,
    net: last.net, netChange: last.net - prev.net,
    netPctOI: last.oi ? round(last.net / last.oi * 100, 1) : null,
    z: sd > 0 ? round((last.net - mean) / sd, 2) : null,
    weeks: hist.length,
  };
}

const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const verdict = (a, b) => (a === 0 || b === 0 ? 'unclear' : a === b ? 'agrees' : 'disagrees');
const clearMove = (d) => (d != null && Math.abs(d) >= MOVE_CLEAR ? sign(d) : 0);

// THIS WEEK: the change in the net against the replica's change over the same Tuesday-to-Tuesday
// week. `posAt(date)` is the replica's position at that Tuesday's close.
export function weekCheck(read, posAt) {
  if (!read || typeof posAt !== 'function') return null;
  const p1 = posAt(read.date), p0 = posAt(read.prevDate);
  const dPos = p1 != null && p0 != null ? p1 - p0 : null;
  return { week: verdict(sign(read.netChange), clearMove(dPos)), replicaThen: round(p1, 2), replicaMove: round(dPos, 2) };
}

// THE RECORD: the same test over the last TRACK_WEEKS weeks — how often the clear weeks agreed, and
// the correlation of the two weekly changes. Whether the category tests the replica at all.
export function cotTrack(series = [], posAt, weeks = TRACK_WEEKS) {
  if (typeof posAt !== 'function' || series.length < 3) return null;
  const tail = series.slice(-(weeks + 1));
  const pos = new Map(tail.map(r => [r.date, posAt(r.date)]));
  const dn = [], dp = [];
  let clear = 0, agree = 0;
  for (let i = 1; i < tail.length; i++) {
    const p1 = pos.get(tail[i].date), p0 = pos.get(tail[i - 1].date);
    if (p1 == null || p0 == null) continue;
    const n = tail[i].net - tail[i - 1].net, p = p1 - p0;
    dn.push(n); dp.push(p);
    const v = verdict(sign(n), clearMove(p));
    if (v !== 'unclear') { clear += 1; if (v === 'agrees') agree += 1; }
  }
  if (dn.length < 8) return null;
  const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
  const ma = mean(dn), mb = mean(dp);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < dn.length; i++) { sab += (dn[i] - ma) * (dp[i] - mb); saa += (dn[i] - ma) ** 2; sbb += (dp[i] - mb) ** 2; }
  const corr = saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
  const hit = clear ? agree / clear : null;
  return { weeks: dn.length, clear, agree, hit: round(hit, 2), corr: round(corr, 2),
           tracks: hit != null && corr != null && hit >= TRACK_MIN_HIT && corr >= TRACK_MIN_CORR };
}

// The book: which markets the CFTC data tests the replica in, and this week's verdicts there.
export function calibrationSummary(checks = []) {
  const ok = checks.filter(Boolean);
  const tested = ok.filter(c => c.track?.tracks);
  const dates = ok.map(c => c.date).filter(Boolean).sort();
  const clear = tested.filter(c => c.week && c.week !== 'unclear');
  return {
    date: dates.at(-1) ?? null,
    tested: tested.map(c => c.key),
    untested: ok.filter(c => c.track && !c.track.tracks).map(c => c.key),
    week: { agree: clear.filter(c => c.week === 'agrees').length, clear: clear.length },
  };
}

// ── FETCH ────────────────────────────────────────────────────────────────────
// Two queries, one per report, three years of Tuesdays for the markets above.
export async function fetchCot({ weeks = HISTORY_WEEKS + 2, fetchImpl = fetch, timeoutMs = 15000, today = new Date() } = {}) {
  const since = new Date(today.getTime() - weeks * 7 * 86400000).toISOString().slice(0, 10);
  const rows = [];
  for (const ds of [TFF, DISAGG]) {
    const ms = COT_MARKETS.filter(m => m.dataset === ds);
    const fields = [...new Set(['report_date_as_yyyy_mm_dd', 'cftc_contract_market_code', 'open_interest_all', ...ms.flatMap(m => [m.long, m.short])])];
    const where = `cftc_contract_market_code in(${ms.map(m => `'${m.code}'`).join(',')}) AND report_date_as_yyyy_mm_dd >= '${since}T00:00:00.000'`;
    const url = `${COT_BASE}/${ds}.json?${new URLSearchParams({ $select: fields.join(','), $where: where, $order: 'report_date_as_yyyy_mm_dd', $limit: '5000' })}`;
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, error: `CFTC HTTP ${r.status}`, series: {} };
    const j = await r.json();
    if (!Array.isArray(j)) return { ok: false, error: 'unexpected CFTC response', series: {} };
    rows.push(...j);
  }
  return { ok: true, error: null, series: cotSeries(rows) };
}
