// lib/impliedCorrelation.js — implied correlation and dispersion, for Market Watch › Drivers (11 Oct 2026).
//
// THE IDEA. An index can look calm because its stocks are moving in different directions — high
// single-stock vol, low correlation between them, a quiet sum. The risk the gauges watch for is
// correlation snapping back while the index falls: the stocks start moving together, and the
// cushion that kept the index calm is gone.
//
//   COR1M          Cboe 1-Month Implied Correlation — the top 50 S&P 500 names, from their options.
//   VIXEQ − VIX    Cboe's average single-stock implied vol in the S&P 500, less index vol, in
//                  points. Wide: the stocks are far more volatile than the index, so they are
//                  offsetting. Closing while VIX rises: the offset is going.
//   DSPX           Cboe S&P 500 Dispersion Index — the cross-check on the gap.
//
// DISPLAY ONLY. These are information beside the volatility drivers; they feed no score and block
// nothing. scripts/correlation-backtest.py is the test a gauge would have to pass before it could
// enter the regime score (the rule the gamma flip is held to), and the 11 Oct run did not pass it:
// nothing beyond VIX on drawdowns or trend days. What it did find is the summary's History line.
//
// READ RAW. Cboe publishes each index's full daily history as a CSV; Yahoo carries some of the
// same symbols as a fallback. Whichever answered, and its as-of date, travels with every row.
// A series that cannot be read is "not available" with the reason — never estimated.

export const CBOE_HISTORY_URL = (sym) => `https://cdn.cboe.com/api/global/us_indices/daily_prices/${encodeURIComponent(sym)}_History.csv`;
export const YAHOO_CHART_URL = (sym) => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2y`;
export const CORR_SYMBOLS = Object.freeze({ COR1M: '^COR1M', VIXEQ: '^VIXEQ', VIX: '^VIX', DSPX: '^DSPX' });
export const CORR_TIMEOUT_MS = 12000;
export const RANGE_SESSIONS = 60;
export const YEAR_SESSIONS = 252;
export const SPARK_SESSIONS = 60;
// A fallback needs enough history to say anything: a percentile and a 60-session range. Yahoo
// carries COR1M and VIXEQ with only the latest point, which is not a series.
export const MIN_SESSIONS = RANGE_SESSIONS + 21;

const num = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
const r2 = (v) => (v == null ? null : +v.toFixed(2));

// "MM/DD/YYYY,…" rows → [{date, close}], oldest first. The close is the CLOSE column where there is
// one (COR1M, VIX) and the single value column where there is not (VIXEQ, DSPX).
export function parseCboeHistory(csv) {
  const lines = String(csv || '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const head = lines[0].split(',').map(h => h.trim().toUpperCase());
  if (head[0] !== 'DATE') return [];
  const ci = head.includes('CLOSE') ? head.indexOf('CLOSE') : head.length - 1;
  const out = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(c[0] || '').trim());
    const v = num(c[ci]);
    if (!m || v == null) continue;
    out.push({ date: `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`, close: v });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function parseYahooChart(j) {
  const r = j?.chart?.result?.[0];
  const ts = r?.timestamp || [], cl = r?.indicators?.quote?.[0]?.close || [];
  const off = r?.meta?.gmtoffset ?? 0;
  const out = [];
  ts.forEach((t, i) => { const v = num(cl[i]); if (v != null) out.push({ date: new Date((t + off) * 1000).toISOString().slice(0, 10), close: v }); });
  return out;
}

// Cboe first, Yahoo if Cboe fails or is short. { ok, rows, source, asOf } or { ok: false, error }.
export async function fetchSeries(name, { fetchImpl = fetch, timeoutMs = CORR_TIMEOUT_MS } = {}) {
  const get = async (url, as) => {
    const r = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: as === 'json' ? 'application/json' : 'text/csv,*/*' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return as === 'json' ? r.json() : r.text();
  };
  const why = [];
  try {
    const rows = parseCboeHistory(await get(CBOE_HISTORY_URL(name), 'text'));
    if (rows.length >= MIN_SESSIONS) return { ok: true, rows, source: 'Cboe', asOf: rows[rows.length - 1].date };
    why.push(`Cboe: ${rows.length} sessions`);
  } catch (e) { why.push(`Cboe: ${e.message}`); }
  const ysym = CORR_SYMBOLS[name];
  if (ysym) {
    try {
      const rows = parseYahooChart(await get(YAHOO_CHART_URL(ysym), 'json'));
      if (rows.length >= MIN_SESSIONS) return { ok: true, rows, source: 'Yahoo', asOf: rows[rows.length - 1].date };
      why.push(`Yahoo: ${rows.length} session${rows.length === 1 ? '' : 's'}, not a history`);
    } catch (e) { why.push(`Yahoo: ${e.message}`); }
  }
  return { ok: false, error: why.join('; ') };
}

// VIXEQ − VIX on the dates both have.
export function gapSeries(a = [], b = []) {
  const m = new Map(b.map(r => [r.date, r.close]));
  return a.filter(r => m.has(r.date)).map(r => ({ date: r.date, close: r2(r.close - m.get(r.date)) }));
}

// The numbers every row shows. Changes are in points; the percentile is where today sits among
// the year before it (0 = lowest); the range is the PREVIOUS 60 sessions, so today can break it.
export function gaugeStats(rows = []) {
  const n = rows.length;
  if (n < MIN_SESSIONS) return null;
  const last = rows[n - 1].close;
  const ch = (k) => (n > k ? r2(last - rows[n - 1 - k].close) : null);
  const year = rows.slice(Math.max(0, n - 1 - YEAR_SESSIONS), n - 1).map(r => r.close);
  const prior = rows.slice(n - 1 - RANGE_SESSIONS, n - 1).map(r => r.close);
  const lo = Math.min(...prior), hi = Math.max(...prior);
  const below = year.filter(v => v < last).length / year.length;
  return {
    latest: last, date: rows[n - 1].date, ch5: ch(5), ch20: ch(20),
    pct1y: Math.round(below * 100),
    // The backtest's "bottom 10%": under a tenth of the year's closes sit below today's. Taken from
    // the unrounded share, so a row reading "10%" is in the bucket only when it really is.
    low10: below < 0.10,
    range60: { lo, hi }, brk: last > hi ? 'above' : last < lo ? 'below' : null,
    spark: rows.slice(-SPARK_SESSIONS).map(r => r.close),
  };
}

// ── THE THREE ROWS AND THEIR COLOURS ──
// red = bad, green = good, neutral = neither; the benchmark is named in the read.
//   COR1M          rising over 5 sessions is red (the stocks moving more together), falling green.
//   VIXEQ − VIX    closing WHILE VIX RISES is red (the offset going in a sell-off); closing because
//                  VIXEQ fell, without VIX rising, is neutral — "broad calm"; widening is green.
//   DSPX           the cross-check: neutral, and says whether it agrees with the gap's direction.
const rangeWord = (s, dp = 1) => `${s.brk === 'above' ? 'above' : s.brk === 'below' ? 'below' : 'inside'} its 60-day range (${s.range60.lo.toFixed(dp)}–${s.range60.hi.toFixed(dp)})`;
const pts = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`);

export function correlationRows({ cor1m, vixeq, vix, dspx } = {}) {
  const meta = (f) => (f?.ok ? { source: f.source, asOf: f.asOf } : { source: null, asOf: null });
  const na = (id, label, reason) => ({ id, label, available: false, reason });
  const rows = [];

  const c = cor1m?.ok ? gaugeStats(cor1m.rows) : null;
  if (!c) rows.push(na('cor1m', 'COR1M · 1-month implied correlation', cor1m?.error || 'too little history'));
  else {
    const tone = c.ch5 > 0 ? 'bad' : c.ch5 < 0 ? 'good' : 'neutral';
    rows.push({ id: 'cor1m', label: 'COR1M · 1-month implied correlation', unit: '', available: true, ...c, ...meta(cor1m), tone,
      read: `${c.ch5 > 0 ? 'Rising' : c.ch5 < 0 ? 'Falling' : 'Flat'} over 5 sessions (${pts(c.ch5)}) · ${rangeWord(c)}` });
  }

  const vq = vixeq?.ok ? vixeq.rows : null, vx = vix?.ok ? vix.rows : null;
  const g = vq && vx ? gaugeStats(gapSeries(vq, vx)) : null;
  if (!g) rows.push(na('gap', 'VIXEQ − VIX · stock vol over index vol', !vq ? `VIXEQ: ${vixeq?.error || 'not read'}` : !vx ? `VIX: ${vix?.error || 'not read'}` : 'too few shared sessions'));
  else {
    const sv = gaugeStats(vx), se = gaugeStats(vq);
    const vixUp = (sv?.ch5 ?? 0) > 0;
    const closing = g.ch5 < 0;
    const tone = closing && vixUp ? 'bad' : closing ? 'neutral' : g.ch5 > 0 ? 'good' : 'neutral';
    const why = closing && vixUp ? `closing while VIX rises (${pts(sv.ch5)})`
      : closing ? `closing as single-stock vol eases (VIXEQ ${pts(se?.ch5)}) — broad calm`
      : g.ch5 > 0 ? 'widening — the stocks offsetting more' : 'unchanged';
    rows.push({ id: 'gap', label: 'VIXEQ − VIX · stock vol over index vol', unit: ' pts', available: true, ...g, tone,
      source: vixeq.source === vix.source ? vixeq.source : `${vixeq.source} + ${vix.source}`, asOf: g.date,
      parts: { vixeq: se?.latest ?? null, vix: sv?.latest ?? null },
      read: `${pts(g.ch5)} over 5 sessions, ${why} · ${rangeWord(g)}` });
  }

  const d = dspx?.ok ? gaugeStats(dspx.rows) : null;
  if (!d) rows.push(na('dspx', 'DSPX · S&P 500 dispersion (cross-check)', dspx?.error || 'too little history'));
  else {
    const gapRow = rows.find(r => r.id === 'gap' && r.available);
    const agree = gapRow && d.ch5 != null && gapRow.ch5 != null && d.ch5 !== 0 && gapRow.ch5 !== 0
      ? (Math.sign(d.ch5) === Math.sign(gapRow.ch5) ? 'agrees with the gap' : 'disagrees with the gap') : null;
    rows.push({ id: 'dspx', label: 'DSPX · S&P 500 dispersion (cross-check)', unit: '', available: true, ...d, ...meta(dspx), tone: 'neutral',
      read: `${d.ch5 > 0 ? 'Rising' : d.ch5 < 0 ? 'Falling' : 'Flat'} over 5 sessions (${pts(d.ch5)})${agree ? ` — ${agree}` : ''} · ${rangeWord(d)}` });
  }
  return rows;
}

// ── WHAT THE BACKTEST FOUND (scripts/correlation-backtest.py, run 11 Oct 2026) ──
// The panel's "History" line. Updated by hand when the script is re-run and the numbers move.
export const BACKTEST = Object.freeze({
  ran: '11 Oct 2026', span: '2006–2026',
  drawdowns: 'COR1M jumps and the gap closing with VIX up have not been followed by deeper drawdowns than VIX alone predicts',
  lowCorr: 'very low correlation (bottom 10% of the year) has been followed by weaker returns, clearly on QQQ (about −1 point over 20 sessions, −2 over 60), not by deeper drawdowns',
  trend: 'the extra trend days after a correlation jump are mostly the VIX move that comes with it',
});

// ── THE SUMMARY ── three lines over the rows: state now, what history says, and what turns it red.
// Built from the rows each day; the history line is BACKTEST's. Observational: it describes.
const levelWord = (r) => (r.low10 ? 'low (bottom 10% of the year)' : r.pct1y < 33 ? `low-ish (${r.pct1y}th percentile of the year)`
  : r.pct1y > 90 ? `high (top 10% of the year)` : r.pct1y > 67 ? `high-ish (${r.pct1y}th percentile of the year)` : `mid-range (${r.pct1y}th percentile of the year)`);
const dirWord = (v) => (v > 0 ? 'rising' : v < 0 ? 'falling' : 'flat');
export function correlationSummary(rows = []) {
  const by = Object.fromEntries(rows.filter(r => r.available).map(r => [r.id, r]));
  const c = by.cor1m, g = by.gap, d = by.dspx;
  if (!c && !g) return null;
  const bits = [];
  if (c) bits.push(`correlation ${levelWord(c)} and ${dirWord(c.ch5)}`);
  if (g) {
    const agree = d && d.ch5 && g.ch5 ? (Math.sign(d.ch5) === Math.sign(g.ch5) ? 'DSPX agrees' : 'DSPX disagrees') : null;
    bits.push(g.tone === 'bad' ? `the gap closing while VIX rises${agree ? ` (${agree})` : ''}`
      : g.ch5 > 0 ? `stocks offsetting more (gap widening${agree ? `, ${agree}` : ''})`
      : g.ch5 < 0 ? `the gap closing as single-stock vol eases — broad calm${agree ? ` (${agree})` : ''}`
      : 'the gap unchanged');
  }
  const corUp = c && (c.ch5 > 0 || c.brk === 'above');
  const sense = (g?.tone === 'bad' || (corUp && c.brk === 'above'))
    ? 'Stocks are moving together more while volatility rises — the case these gauges watch for.'
    : c && !corUp && g && g.ch5 > 0 ? 'The index is calm partly because its stocks are moving apart.'
    : corUp ? 'Stocks are moving together a little more; nothing has broken its 60-day range.'
    : 'No sign of stocks starting to move together.';
  const now = `${bits.join('; ')}. ${sense}`;
  const history = `${BACKTEST.span}: ${BACKTEST.drawdowns}; ${BACKTEST.lowCorr}.`;
  const red = [c ? `COR1M closes above ${c.range60.hi.toFixed(2)} (its 60-day high)` : null, g ? 'the gap closes while VIX rises' : null].filter(Boolean).join(', or ');
  return { now: now.charAt(0).toUpperCase() + now.slice(1), history, red: red ? `${red}.` : null, lowCorr: !!c?.low10 };
}

// The route's whole job: four reads in parallel, three rows out.
export async function correlationPayload({ fetchImpl = fetch } = {}) {
  const [cor1m, vixeq, vix, dspx] = await Promise.all(['COR1M', 'VIXEQ', 'VIX', 'DSPX'].map(s => fetchSeries(s, { fetchImpl }).catch(e => ({ ok: false, error: e.message }))));
  const rows = correlationRows({ cor1m, vixeq, vix, dspx });
  return { ok: rows.some(r => r.available), at: new Date().toISOString(), rows, summary: correlationSummary(rows),
    sources: Object.fromEntries([['COR1M', cor1m], ['VIXEQ', vixeq], ['VIX', vix], ['DSPX', dspx]].map(([k, f]) => [k, f.ok ? { source: f.source, asOf: f.asOf } : { error: f.error }])) };
}
