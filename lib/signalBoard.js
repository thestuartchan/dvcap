// lib/signalBoard.js — the Signal Board: one row per market signal, each in one state against fixed
// thresholds, counted by CLUSTER so overlapping signals vote once; and the trade-day call v2 beside it.
//
// WHY ONE ENGINE (brief of 20 Oct 2026, docs/signal-board-audit.md). The same signals were being
// computed in five places — the Market Read page, the two skills' prose steps, the Gamma tab, the
// market-state engine and the cross-check feed — with different windows and, for the cushion and the
// trade-day zones, different definitions. This module is the single source for each row. Where a
// definition already lived in dvcap it is IMPORTED, not re-derived: the credit, rates-vol and breadth
// readings come from lib/marketState.js's components, the cushion from lib/squeeze.js +
// lib/trendTells.js, the Brent box from lib/crossCheck.js's rangeOf. Every number is market data;
// nothing here calls a model (scripts/check-no-llm-feeds.mjs).
//
// STATES. 'on' (risk-on), 'neutral', 'off' (risk-off), or null when the input is missing. Each row
// carries its thresholds in the open, `on` and `off`, and ONE set serves both directions: a row is
// risk-off past `off` and risk-on past `on`, whichever side it is on. Most cut-points are the
// 2012–2026 quartiles of the row's own history (computed 20 Oct, stated per row); the ones marked
// [Guessing] have no history behind them yet and are scored from the snapshot log.
//
// LEAN = CLUSTER COUNT. Macro (credit, rates, oil), Dealers & vol (the brief's "Positioning"; renamed
// because the connector's leak filter rejects any answer containing that word), Tape, Narrative. A
// cluster's state is the sign of (rows on − rows off); the lean is (clusters on − clusters off) over
// the clusters that read. Rows marked `vote: false` are shown and scored but do not vote (days to
// opex is a clock, not a state; the Asia row's 14-year test found no edge — scripts/kospi-crown-backtest.py;
// the Narrative row's 2017–2026 test found none either — scripts/narrative-backtest.mjs;
// the crypto rows' 2015–2026 test found none worth a vote — scripts/crypto-signal-backtest.py).
//
// PURE: series in, board out. The fetch is lib/signalBoardFeed.js; the tests run on synthetic series.
import { creditComponent, ratesVolComponent, breadthComponent, pctRank, last, ago } from './marketState.js';
import { gexPercentile } from './squeeze.js';
import { rangeOf } from './crossCheck.js';
import { ZONE_AT, zoneOf, CUSHION, bandLean } from './trendTells.js';
import MODEL from './tradeDayModel.json' with { type: 'json' };

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
const sgn = (v, d = 1, unit = '') => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}${unit}`);

// ── THE CLUSTERS ─────────────────────────────────────────────────────────────
export const CLUSTERS = Object.freeze([
  { id: 'macro', label: 'Macro', dims: ['credit', 'rates', 'oil'] },
  { id: 'dealers', label: 'Dealers & vol', dims: ['dealers'] },
  { id: 'tape', label: 'Tape', dims: ['tape', 'asia', 'crypto'] },
  { id: 'narrative', label: 'Narrative', dims: ['narrative'] },
]);
export const STATE_WORD = Object.freeze({ on: 'risk-on', neutral: 'neutral', off: 'risk-off' });

// ── ONE THRESHOLD RULE ───────────────────────────────────────────────────────
// `dir` +1: higher is risk-on (on ≥ t.on, off ≤ t.off). `dir` −1: higher is risk-off (off ≥ t.off,
// on ≤ t.on). The same two numbers decide both directions.
export function stateOf(value, t) {
  const v = num(value);
  if (v == null || !t) return null;
  if (t.dir > 0) return v >= t.on ? 'on' : v <= t.off ? 'off' : 'neutral';
  return v >= t.off ? 'off' : v <= t.on ? 'on' : 'neutral';
}
// How far the value is from changing state, in units of the gap between the two thresholds — so a
// bp row and a ratio row compare. Returns { to, at, dist } for the nearest boundary that would change
// the state, or null.
export function flipDistance(value, t) {
  const v = num(value);
  if (v == null || !t) return null;
  const width = Math.abs(t.on - t.off) || 1;
  const s = stateOf(v, t);
  const cand = [];
  // Neutral flips at either threshold; an extreme state flips back to neutral at its own threshold.
  if (s === 'neutral') { cand.push({ to: 'on', at: t.on }, { to: 'off', at: t.off }); }
  else if (s === 'on') cand.push({ to: 'neutral', at: t.on });
  else cand.push({ to: 'neutral', at: t.off });
  const best = cand.map(c => ({ ...c, dist: Math.abs(v - c.at) / width })).sort((a, b) => a.dist - b.dist)[0];
  // Which side of the threshold the change happens on: thresholds are inclusive, so leaving an extreme
  // state means crossing strictly past its threshold.
  const rising = best.to === 'neutral' ? (s === 'off') === (t.dir > 0) : (best.to === 'on') === (t.dir > 0);
  const when = best.to === 'neutral' ? (rising ? 'above' : 'below') : (rising ? 'at or above' : 'at or below');
  return { ...best, when, dist: r3(best.dist) };
}

// ── THE THRESHOLDS ───────────────────────────────────────────────────────────
// Quartiles are 2012-06 → 2026-10 daily, Yahoo closes (n ≈ 3,616): HYG/LQD 5d p25 −0.48% / p75 +0.51%;
// 10Y 5d p25 −6.3bp / p75 +7.4bp; VIX ÷ SPX 20d realised p25 1.10 / p75 1.65; VIX9D ÷ VIX p25 0.88 /
// p75 1.00; RSP ÷ QQQ 20d p25 −2.3% / p75 +1.3%; RSP ÷ SPY 20d p25 −0.86% / p75 +0.64%.
export const THRESHOLDS = Object.freeze({
  hygLqd5d:   { dir: +1, on: 0.5, off: -0.5, unit: '%', basis: 'HYG ÷ LQD over 5 sessions; ±0.5% ≈ the 2012–26 quartiles' },
  hyOas5d:    { dir: -1, on: -10, off: 10, unit: 'bp', basis: 'HY OAS over 5 prints; ±10bp [Guessing — no FRED history in the build; scored from the log]' },
  ust10y5d:   { dir: -1, on: -7, off: 7, unit: 'bp', basis: '10Y yield over 5 sessions; ±7bp ≈ the 2012–26 quartiles' },
  movePct:    { dir: -1, on: 25, off: 75, unit: 'pctile', basis: 'MOVE, percentile of two years; quartiles' },
  brentBox:   { dir: -1, on: 20, off: 80, unit: '% of box', basis: 'Brent front close in its 20-day high–low box; top fifth risk-off, bottom fifth risk-on' },
  cushion:    { dir: +1, on: 60, off: 20, unit: 'pctile', basis: 'SqueezeMetrics GEX vs the 252 sessions before it; negative GEX is risk-off whatever the percentile; <20th and ≥60th are the trade-day table\'s band edges' },
  vixRv:      { dir: +1, on: 1.65, off: 1.10, unit: '×', basis: 'VIX ÷ SPX 20-day realised vol; ≤1.10 realised is catching up with implied; quartiles' },
  vix9dVix:   { dir: -1, on: 0.88, off: 1.00, unit: '×', basis: 'VIX9D ÷ VIX; ≥1.00 the front is inverted; quartiles' },
  skewPct:    { dir: -1, on: 25, off: 75, unit: 'pctile', basis: 'Cboe SKEW, percentile of a year; quartiles [Guessing on direction — scored from the log]' },
  putCallPct: { dir: -1, on: 25, off: 75, unit: 'pctile', basis: 'Cboe equity put/call, percentile of a year; read as hedging demand, not contrarian [Guessing on direction — scored from the log]' },
  rspQqq20d:  { dir: +1, on: 1.3, off: -2.3, unit: '%', basis: 'RSP ÷ QQQ over 20 sessions; rising = broadening (the Market Read\'s convention); quartiles' },
  rspSpy20d:  { dir: +1, on: 0.64, off: -0.86, unit: '%', basis: 'RSP ÷ SPY over 20 sessions (lib/marketState.js breadth); quartiles' },
  maCount:    { dir: +1, on: 4, off: 1, unit: 'of 4', basis: 'closes above the 20/50/100/200-day averages: all four risk-on, one or none risk-off' },
  kospi1d:    { dir: +1, on: 1, off: -1, unit: '%', basis: 'KOSPI close vs prior close, ±1%' },
  // Crypto (shown, not voted). Quartiles 2015-04 → 2026-10 (BTC) / 2017-11 → (ETH), Yahoo closes:
  // BTC ÷ QQQ 20 sessions p25 −7.8% / p75 +12.5%; ETH ÷ BTC 20 days p25 −7.5% / p75 +5.6%; BTC off its
  // 52-week closing high p25 −44% / p75 −7.4%. BTC's trend row reuses maCount.
  btcQqq20d:  { dir: +1, on: 12, off: -8, unit: '%', basis: 'BTC ÷ QQQ over 20 US sessions: crypto leading (+) or lagging (−) equity risk appetite; ≈ the 2015–26 quartiles' },
  ethBtc20d:  { dir: +1, on: 5.5, off: -7.5, unit: '%', basis: 'ETH ÷ BTC over 20 days: speculative breadth inside crypto; ≈ the 2017–26 quartiles' },
  btcOffHigh: { dir: +1, on: -7.5, off: -45, unit: '%', basis: 'BTC close vs its 52-week closing high (the macro spine\'s pctOffHi definition); ≈ the 2015–26 quartiles' },
});

// ── SERIES HELPERS ───────────────────────────────────────────────────────────
// Series are ascending [{date, value}]; bars are ascending [{date, open, high, low, close}].
const values = (s) => (s || []).map(o => num(o?.value)).filter(v => v != null);
const pctChg = (s, n) => { const a = last(s), b = ago(s, n); return a && b && b.value ? (a.value / b.value - 1) * 100 : null; };
// a ÷ b on the dates both have.
export function ratioSeries(a = [], b = []) {
  const m = new Map((b || []).map(o => [o.date, num(o.value)]));
  return (a || []).filter(o => num(o.value) != null && m.get(o.date)).map(o => ({ date: o.date, value: o.value / m.get(o.date) }));
}
export const sma = (s, n) => { const v = values(s); return v.length >= n ? v.slice(-n).reduce((x, y) => x + y, 0) / n : null; };
// Annualised close-to-close realised vol over n sessions, in vol points.
export function realisedVol(s, n = 20) {
  const v = values(s); if (v.length < n + 1) return null;
  const r = []; for (let i = v.length - n; i < v.length; i++) r.push(Math.log(v[i] / v[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) * Math.sqrt(252) * 100;
}
// Consecutive down closes ending the session BEFORE the last one.
export function downRunBefore(s) {
  const v = values(s); let n = 0;
  for (let i = v.length - 2; i >= 1 && v[i] < v[i - 1]; i--) n++;
  return n;
}
// The third Friday of a month (the standard monthly), or the Thursday before it when that Friday is a
// listed US holiday — the same rule as lib/gammaMcp.js isStandardMonthly.
export function nextMonthlyOpex(today, holidays = []) {
  const closed = new Set(holidays);
  const t0 = Date.parse(`${today}T12:00:00Z`);
  for (let k = 0; k < 3; k++) {
    const d = new Date(t0); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + k);
    const first = d.getUTCDay();
    const fri = 1 + ((5 - first + 7) % 7) + 14;
    d.setUTCDate(fri);
    let iso = d.toISOString().slice(0, 10);
    if (closed.has(iso)) { d.setUTCDate(fri - 1); iso = d.toISOString().slice(0, 10); }
    if (iso >= today) return iso;
  }
  return null;
}
// Weekdays from `from` (exclusive) to `to` (inclusive), less listed holidays: trading sessions to go.
export function sessionsBetween(from, to, holidays = []) {
  if (!from || !to || to < from) return null;
  const closed = new Set(holidays); let n = 0;
  for (let t = Date.parse(`${from}T12:00:00Z`) + 864e5; t <= Date.parse(`${to}T12:00:00Z`); t += 864e5) {
    const d = new Date(t), iso = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !closed.has(iso)) n++;
  }
  return n;
}

// The first US session after `date` (weekdays, less listed holidays).
export function nextSession(date, holidays = []) {
  const closed = new Set(holidays);
  for (let t = Date.parse(`${date}T12:00:00Z`) + 864e5, k = 0; k < 10; t += 864e5, k++) {
    const d = new Date(t), iso = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !closed.has(iso)) return iso;
  }
  return null;
}
export const isSession = (date, holidays = []) => { const d = new Date(`${date}T12:00:00Z`).getUTCDay(); return d !== 0 && d !== 6 && !holidays.includes(date); };

// ── A ROW ────────────────────────────────────────────────────────────────────
function row(dim, id, label, { value = null, roc = null, rocLabel = '', state, tkey, text, asOf = null, vote = true, flags = [], extra = {} }) {
  const t = tkey ? THRESHOLDS[tkey] : null;
  const st = state !== undefined ? state : stateOf(value, t);
  return {
    dim, id, label, value: value == null ? null : (Math.abs(value) >= 100 ? r1(value) : r3(value)), roc: roc == null ? null : r2(roc), roc_label: rocLabel,
    state: st, thresholds: t ? { on: t.on, off: t.off, dir: t.dir, unit: t.unit } : null,
    benchmark: t ? t.basis : null, text: text ?? null, as_of: asOf, vote: vote && st != null, flags,
    flip: st != null && t && value != null ? flipDistance(value, t) : null, ...extra,
  };
}

// ── THE ROWS ─────────────────────────────────────────────────────────────────
export function creditRows(S) {
  const hl = ratioSeries(S.hyg, S.lqd);
  const ch = pctChg(hl, 5);
  const c = creditComponent(S);   // the market-state engine's own credit reading: one definition of the HY OAS change
  return [
    row('credit', 'hyg_lqd', 'HYG ÷ LQD, 5 sessions', { value: ch, roc: pctChg(hl, 1), rocLabel: '1d %', tkey: 'hygLqd5d', asOf: last(hl)?.date ?? null,
      text: ch == null ? 'no HYG/LQD closes' : `HYG ÷ LQD ${sgn(ch, 2, '%')} over 5 sessions` }),
    row('credit', 'hy_oas', 'HY OAS, 5 prints', { value: c?.facts?.hyChg5Bp ?? null, roc: c?.facts?.hyOas ?? null, rocLabel: 'level %', tkey: 'hyOas5d', asOf: c?.asOf ?? null,
      text: c ? c.read : 'no HY OAS (FRED, a session late)' }),
  ];
}
export function ratesRows(S) {
  const t = S.tnx || [];
  const a = last(t), b = ago(t, 5), b1 = ago(t, 1);
  // Yahoo's ^TNX is the yield in percent.
  const bp = a && b ? (a.value - b.value) * 100 : null;
  const m = ratesVolComponent(S);
  return [
    row('rates', 'ust10y', '10Y yield, 5 sessions', { value: bp, roc: a && b1 ? (a.value - b1.value) * 100 : null, rocLabel: '1d bp', tkey: 'ust10y5d', asOf: a?.date ?? null,
      text: a ? `10Y ${a.value.toFixed(2)}%, ${sgn(bp, 1, 'bp')} over 5 sessions` : 'no 10Y closes' }),
    row('rates', 'move', 'MOVE (rates vol)', { value: m?.facts?.movePctile ?? null, roc: m?.facts?.moveChg5Pct ?? null, rocLabel: '5d %', tkey: 'movePct', asOf: m?.asOf ?? null,
      text: m ? m.read : 'no MOVE closes' }),
  ];
}
export function oilRows(S) {
  const b = (S.brent || []).filter(x => [x.high, x.low, x.close].every(Number.isFinite));
  if (b.length < 21) return [row('oil', 'brent_box', 'Brent in its 20-day box', { state: null, text: 'fewer than 21 Brent bars' })];
  const box = rangeOf(b, 20);                                   // the cross-check's own box, today included
  const prior = b.slice(-21, -1), lastBar = b[b.length - 1];
  const hi = Math.max(...prior.map(x => x.high)), lo = Math.min(...prior.map(x => x.low));
  const breakout = lastBar.close > hi ? 'up' : lastBar.close < lo ? 'down' : null;
  const chg = (lastBar.close / b[b.length - 2].close - 1) * 100;
  return [row('oil', 'brent_box', 'Brent in its 20-day box', { value: box?.pct ?? null, roc: chg, rocLabel: '1d %', tkey: 'brentBox', asOf: lastBar.date,
    flags: breakout ? [`breakout ${breakout}: closed ${breakout === 'up' ? 'above' : 'below'} the prior 20 sessions' ${breakout === 'up' ? 'high' : 'low'} (${(breakout === 'up' ? hi : lo).toFixed(2)})`] : [],
    text: `Brent ${lastBar.close.toFixed(2)}, ${Math.round(box?.pct ?? 0)}% of the 20-day box ${box?.lo}–${box?.hi}`, extra: { breakout } })];
}
export function dealerRows(S, { today = null, holidays = [] } = {}) {
  const out = [];
  // Cushion: the Gamma tab's own percentile (lib/squeeze.js), negative GEX overriding.
  const sq = S.squeeze || [];
  const sl = sq.length ? sq[sq.length - 1] : null;
  const pct = sl ? gexPercentile(sq, sl[0]) : null;
  const neg = sl ? sl[1] < 0 : false;
  const prevPct = sq.length > 1 ? gexPercentile(sq, sq[sq.length - 2][0]) : null;
  out.push(row('dealers', 'cushion', 'Gamma cushion (SPX GEX percentile)', { value: pct == null ? null : pct * 100, roc: pct != null && prevPct != null ? (pct - prevPct) * 100 : null, rocLabel: '1d pts',
    tkey: 'cushion', state: neg ? 'off' : undefined, asOf: sl?.[0] ?? null, flags: neg ? ['GEX negative'] : [],
    text: sl ? `${neg ? 'negative GEX — ' : ''}${pct == null ? '—' : Math.round(pct * 100)}th percentile of the trailing year ($${(sl[1] / 1e9).toFixed(1)}bn)` : 'no SqueezeMetrics GEX', extra: { gex: sl?.[1] ?? null, gex_negative: neg } }));
  // VIX vs realised.
  const v = last(S.vix), rv = realisedVol(S.spx, 20);
  const vr = v && rv ? v.value / rv : null;
  out.push(row('dealers', 'vix_rv', 'VIX ÷ 20-day realised', { value: vr, roc: v && ago(S.vix, 1) ? v.value - ago(S.vix, 1).value : null, rocLabel: 'VIX 1d pts', tkey: 'vixRv', asOf: v?.date ?? null,
    text: vr == null ? 'no VIX or SPX closes' : `VIX ${v.value.toFixed(1)} vs realised ${rv.toFixed(1)} (${vr.toFixed(2)}×)` }));
  // VIX9D / VIX.
  const v9 = last(S.vix9d);
  const v9r = v9 && v && v9.date === v.date ? v9.value / v.value : null;
  out.push(row('dealers', 'vix9d_vix', 'VIX9D ÷ VIX', { value: v9r, tkey: 'vix9dVix', asOf: v9?.date ?? null,
    text: v9r == null ? 'no VIX9D on the VIX date' : `VIX9D ${v9.value.toFixed(1)} ÷ VIX ${v.value.toFixed(1)} = ${v9r.toFixed(2)}${v9r >= 1 ? ' — front inverted' : ''}` }));
  // SKEW.
  const sk = last(S.skew), skP = sk ? pctRank((S.skew || []).slice(-252), sk.value) : null;
  out.push(row('dealers', 'skew', 'Cboe SKEW', { value: skP, roc: sk && ago(S.skew, 5) ? sk.value - ago(S.skew, 5).value : null, rocLabel: '5d pts', tkey: 'skewPct', asOf: sk?.date ?? null,
    text: sk ? `SKEW ${sk.value.toFixed(1)}, ${Math.round(skP)}th percentile of a year` : 'no SKEW closes' }));
  // Put/call: the cross-check feed's Cboe history (lib/crossCheckFeed.js), not a second fetch.
  const pc = S.putCall;
  out.push(row('dealers', 'put_call', 'Equity put/call', { value: num(pc?.equity_pct_rank_1y), roc: num(pc?.sessions?.at?.(-1)?.equity), rocLabel: 'last ratio', tkey: 'putCallPct', asOf: pc?.as_of ?? null,
    text: pc ? `equity put/call ${pc.sessions?.at?.(-1)?.equity ?? '—'}, ${pc.equity_pct_rank_1y ?? '—'}th percentile (${pc.rank_sample_sessions ?? '?'} sessions)` : 'put/call not cached yet (the cross-check feed fills it)' }));
  // Days to the next monthly opex: a clock, shown, never a vote.
  const opex = today ? nextMonthlyOpex(today, holidays) : null;
  const dte = opex ? sessionsBetween(today, opex, holidays) : null;
  out.push(row('dealers', 'opex', 'Sessions to monthly opex', { value: dte, state: dte == null ? null : 'neutral', vote: false, asOf: today,
    flags: dte != null && dte <= 3 ? ['opex week: the monthly cushion expires'] : [], text: opex ? `${opex} — ${dte} session${dte === 1 ? '' : 's'}` : 'no date', extra: { opex } }));
  return out;
}
// A close against its 20/50/100/200-day averages, with the distance to each — the trend-following
// trigger levels the brief asks for (lib/cta.js gives the replica's own flips; these are the plain MAs).
export function maRow(id, label, s, { dim = 'tape', vote = true, flags = [] } = {}) {
  const lastV = last(s);
  const mas = [20, 50, 100, 200].map(n => ({ n, ma: sma(s, n) }));
  if (!lastV || mas.some(m => m.ma == null)) return row(dim, id, label, { state: null, vote, text: 'fewer than 200 closes' });
  const above = mas.filter(m => lastV.value > m.ma).length;
  const dist = mas.map(m => ({ n: m.n, ma: r2(m.ma), dist_pct: r2((lastV.value / m.ma - 1) * 100) }));
  const nearest = [...dist].sort((a, b) => Math.abs(a.dist_pct) - Math.abs(b.dist_pct))[0];
  return row(dim, id, label, { value: above, roc: pctChg(s, 1), rocLabel: '1d %', tkey: 'maCount', asOf: lastV.date, vote, flags,
    text: `${lastV.value.toFixed(2)}: above ${above} of 4 · ` + dist.map(d => `${d.n}d ${sgn(d.dist_pct, 1, '%')}`).join(' · ') + ` · nearest ${nearest.n}d at ${nearest.ma}`,
    extra: { mas: dist } });
}
export function tapeRows(S) {
  const rq = ratioSeries(S.rsp, S.qqq);
  const rqc = pctChg(rq, 20);
  const br = breadthComponent(S);  // the market-state engine's breadth reading
  return [
    row('tape', 'rsp_qqq', 'RSP ÷ QQQ, 20 sessions', { value: rqc, roc: pctChg(rq, 5), rocLabel: '5d %', tkey: 'rspQqq20d', asOf: last(rq)?.date ?? null,
      text: rqc == null ? 'no RSP/QQQ closes' : `RSP ÷ QQQ ${sgn(rqc, 1, '%')} over 20 sessions` }),
    row('tape', 'breadth', 'Breadth: RSP ÷ SPY, 20 sessions', { value: br?.facts?.rspSpyChg20Pct ?? null, roc: br?.facts?.iwmSpyChg20Pct ?? null, rocLabel: 'IWM ÷ SPY 20d %', tkey: 'rspSpy20d', asOf: br?.asOf ?? null,
      text: br ? br.read : 'no breadth closes' }),
    maRow('soxx_ma', 'SOXX vs 20/50/100/200-day', S.soxx),
    maRow('qqq_ma', 'QQQ vs 20/50/100/200-day', S.qqq),
  ];
}
// THE ASIA ROW. KOSPI's daily close (KRX's index close; the KSE index feed is stale intraday and is not
// read). Crown's pattern — an up close after ≥2 down closes — is flagged, with its tested record: US up
// the next session 59.6% (QQQ, n 416) against a 55.7% base, 2012–2026, and no open→close edge
// (53.8% vs 53.9%). Not the >80% claimed, so the row does not vote.
export const KOSPI_TEST = Object.freeze({ n: 416, qqq_cc: 59.6, qqq_base_cc: 55.7, qqq_oc: 53.8, qqq_base_oc: 53.9, spx_cc: 58.9, spx_base_cc: 54.3, span: '2012–2026' });
export function asiaRows(S) {
  const k = S.kospi || [];
  const a = last(k), b = ago(k, 1);
  if (!a || !b) return [row('asia', 'kospi', 'KOSPI', { state: null, vote: false, text: 'no KOSPI closes' })];
  const chg = (a.value / b.value - 1) * 100;
  const run = downRunBefore(k);
  const crown = chg > 0 && run >= 2;
  return [row('asia', 'kospi', 'KOSPI close', { value: chg, roc: run, rocLabel: 'down closes before', tkey: 'kospi1d', vote: false, asOf: a.date,
    flags: crown ? [`Crown pattern: up after ${run} down closes — tested ${KOSPI_TEST.span}: US up next session ${KOSPI_TEST.qqq_cc}% (QQQ, n ${KOSPI_TEST.n}) vs ${KOSPI_TEST.qqq_base_cc}% base; open→close no edge`] : [],
    text: `KOSPI ${a.value.toFixed(2)} ${sgn(chg, 2, '%')}${run ? ` after ${run} down close${run === 1 ? '' : 's'}` : ''}` })];
}
// THE CRYPTO ROWS (shown, scored from the snapshot log, NOT voted). BTC-USD and ETH-USD daily closes from
// Yahoo — the same symbol and source the macro spine reads (lib/quotes.js getMacro → yahooTrend), whose
// 52-week-high and 50/200-day definitions these reuse; the board fetches the series itself because the
// spine keeps only the summary. BTC's averages are over its own 7-day daily bars (200 bars = 200 days).
// BTC ÷ QQQ is taken on the dates both have, so 20 means 20 US sessions; ETH ÷ BTC is 20 crypto days.
//
// WHY NONE VOTES (scripts/crypto-signal-backtest.py, US sessions 2015-04 → 2026-10, crypto read as of the
// bar before the US close). Next-session QQQ hit rates sit 0–4 points off the base and Spearman is
// ≤ 0.05 on every row; ETH ÷ BTC and the 52-week drawdown show nothing. The best, BTC ÷ QQQ, is one-sided:
// risk-on was followed by QQQ up 59.8% vs a 56.0% base (n 752), 66.2% vs 60.1% over 5 sessions, in both
// halves of the sample — but risk-off was followed by a fall 44.6% vs 44.0%, and a voting row votes both
// ways. It is the candidate to promote once the snapshot log confirms it.
//
// THE 200-DAY BREAK FLAG. BTC's first close below its 200-day average after ≥ 20 closes above it. The
// one crypto event with a record: QQQ fell ≥ 5% within 20 sessions after 7 of 13 (54%) against 24% of
// all days, and against 28% after QQQ's own first close below its 50-day (n 29). Thirteen events,
// clustered in sell-offs, so a flag with its numbers, not a vote.
export const BTC_TEST = Object.freeze({ span: '2015–2026', n_break: 13, qqq_dd5_20s: 54, base_dd5_20s: 24, qqq50_dd5_20s: 28, n_qqq50: 29,
  btc_qqq_on_1d: 59.8, btc_qqq_base_1d: 56.0, btc_qqq_n_on: 752 });
// True when the last close is the first below its 200-day average after ≥ `run` closes above it.
export function btc200Break(s, run = 20) {
  const v = values(s);
  if (v.length < 200 + run) return false;
  const maAt = (i) => v.slice(i - 199, i + 1).reduce((a, b) => a + b, 0) / 200;
  const n = v.length - 1;
  if (!(v[n] < maAt(n))) return false;
  for (let i = n - run; i < n; i++) if (!(v[i] > maAt(i))) return false;
  return true;
}
// Close vs the highest close of the 365 days to the last one (yahooTrend's pctOffHi, on a dated window).
export function offHigh(s, days = 365) {
  const a = last(s);
  if (!a) return null;
  const from = new Date(Date.parse(`${a.date}T12:00:00Z`) - days * 864e5).toISOString().slice(0, 10);
  const win = (s || []).filter(o => o.date > from && num(o.value) != null);
  // A year of bars, or no reading: a shorter history would call its own high the 52-week one.
  if (!win.length || Date.parse(`${(s || []).find(o => num(o.value) != null)?.date}T12:00:00Z`) > Date.parse(`${from}T12:00:00Z`)) return null;
  const hi = win.reduce((m, o) => (o.value > m.value ? o : m), win[0]);
  return { pct: (a.value / hi.value - 1) * 100, high: hi.value, high_date: hi.date };
}
export function cryptoRows(S) {
  const btc = S.btc || [], eth = S.eth || [];
  const brk = btc200Break(btc);
  const out = [maRow('btc_ma', 'BTC vs 20/50/100/200-day', btc, { dim: 'crypto', vote: false,
    flags: brk ? [`BTC 200-day break: first close below after ≥20 above — tested ${BTC_TEST.span}: QQQ fell ≥5% within 20 sessions after ${BTC_TEST.qqq_dd5_20s}% of ${BTC_TEST.n_break} breaks vs ${BTC_TEST.base_dd5_20s}% of all days`] : [] })];
  out[0].break_200d = brk;
  const bq = ratioSeries(btc, S.qqq), bqc = pctChg(bq, 20);
  out.push(row('crypto', 'btc_qqq', 'BTC ÷ QQQ, 20 sessions', { value: bqc, roc: pctChg(bq, 5), rocLabel: '5d %', tkey: 'btcQqq20d', vote: false, asOf: last(bq)?.date ?? null,
    text: bqc == null ? 'no BTC/QQQ closes' : `BTC ÷ QQQ ${sgn(bqc, 1, '%')} over 20 sessions — crypto ${bqc >= 0 ? 'leading' : 'lagging'} equities` }));
  const eb = ratioSeries(eth, btc), ebc = pctChg(eb, 20);
  out.push(row('crypto', 'eth_btc', 'ETH ÷ BTC, 20 days', { value: ebc, roc: pctChg(eb, 5), rocLabel: '5d %', tkey: 'ethBtc20d', vote: false, asOf: last(eb)?.date ?? null,
    text: ebc == null ? 'no ETH/BTC closes' : `ETH ÷ BTC ${last(eb).value.toFixed(4)}, ${sgn(ebc, 1, '%')} over 20 days` }));
  const oh = offHigh(btc), a = last(btc);
  out.push(row('crypto', 'btc_dd', 'BTC off its 52-week high', { value: oh?.pct ?? null, roc: pctChg(btc, 1), rocLabel: '1d %', tkey: 'btcOffHigh', vote: false, asOf: a?.date ?? null,
    text: oh ? `BTC ${Math.round(a.value).toLocaleString('en-US')}, ${sgn(oh.pct, 1, '%')} from its 52-week closing high ${Math.round(oh.high).toLocaleString('en-US')} (${oh.high_date})` : 'fewer than a year of BTC closes',
    extra: { high: oh ? r1(oh.high) : null, high_date: oh?.high_date ?? null } }));
  return out;
}
// NARRATIVE: AI build-out coverage and its tone, from GDELT (lib/narrativeFeed.js — article counts and a
// dictionary tone score, no model). Daily series in, UTC calendar days (GDELT runs seven days a week):
// S.narrative = [{date, count, norm, tone}], count = matching articles, norm = all articles that day.
//
// THE MEASURES. Share = count ÷ norm (per cent of all coverage). Coverage trend = the 5-day mean share
// against the 20-day mean share (%), with 5-vs-prior-5 and 20-vs-prior-20 shown beside it. Tone = the
// article-weighted mean tone of the last 5 days; its change = that minus the 5 days before.
//
// THE RULE (one pair of numbers, both directions): risk-off when coverage is rising (5d vs 20d ≥ +10%)
// while tone is falling (5-day change ≤ −0.25) — the story is getting louder and worse; risk-on when tone
// is improving (≥ +0.25) and coverage is not fading (5d vs 20d ≥ −10%); neutral otherwise. ±10% and
// ±0.25 are the 2017–2026 quartiles of the two measures (p25 −10.9% / p75 +10.5%; p25 −0.25 / p75
// +0.25, n 3,518 days), set from their distributions, not from returns. scripts/narrative-backtest.mjs tests
// the state against next-session SOXX and QQQ; docs/signal-board-audit.md has the result.
export const NARRATIVE_RULE = Object.freeze({ coverage: 10, tone: 0.25,
  basis: 'GDELT AI build-out coverage (AI capex, data centres, hyperscalers, AI chips): risk-off when 5d share vs 20d ≥ +10% while 5d tone change ≤ −0.25; risk-on when tone change ≥ +0.25 and coverage ≥ −10%; ±10% / ±0.25 ≈ the 2017–26 quartiles' });
// The backtest's verdict (scripts/narrative-backtest.mjs, run 20 Oct 2026; entry at the next session's
// open). Sessions 2017-02 → 2026-10, n 2,431: Spearman of the state against next-session return SOXX
// +0.010 / QQQ +0.003 (1d), +0.018 / +0.018 (3d), +0.009 / +0.005 (5d). Risk-on (n 333) up 50.8% SOXX,
// 53.2% QQQ next session against 51.7% / 53.8% base; risk-off (n 162) down 50.6% / 42.6% against
// 48.3% / 46.2%. 2023 → only (n 941; on 126, off 38): Spearman −0.027 to +0.013. NO EDGE. Like the Asia
// row, it is shown and scored but does not vote, flagged for review; set `edge` true only on a log that
// shows one, and the row votes in the Narrative cluster again.
export const NARRATIVE_TEST = Object.freeze({ edge: false, span: '2017-02 → 2026-10', n: 2431,
  note: 'Spearman vs next-session SOXX +0.01, QQQ +0.00; hit rates at base' });

export function narrativeState(cov, dTone, rule = NARRATIVE_RULE) {
  const c = num(cov), t = num(dTone);
  if (c == null || t == null) return null;
  if (c >= rule.coverage && t <= -rule.tone) return 'off';
  if (t >= rule.tone && c >= -rule.coverage) return 'on';
  return 'neutral';
}
// The nearest change of state, moving one measure with the other held, in units of that measure's
// threshold gap (20 points of coverage, 0.5 of tone) — so it ranks against the other rows' flips.
export function narrativeFlip(cov, dTone, rule = NARRATIVE_RULE) {
  const c = num(cov), t = num(dTone);
  const s = narrativeState(c, t, rule);
  if (s == null) return null;
  const cands = [];
  for (const [what, v, gap, bounds] of [['tone', t, 2 * rule.tone, [-rule.tone, rule.tone]], ['coverage', c, 2 * rule.coverage, [-rule.coverage, rule.coverage]]]) {
    for (const b of bounds) {
      // Thresholds are inclusive: reaching b from below lands on it; leaving it from above means going under it.
      const up = b > v, probe = up ? b : b - gap * 1e-6;
      const to = what === 'tone' ? narrativeState(c, probe, rule) : narrativeState(probe, t, rule);
      if (to === s) continue;
      cands.push({ to, at: b, on: what, dist: r3(Math.abs(v - b) / gap), when: up ? 'at or above' : 'below',
        text: `AI build-out narrative (${STATE_WORD[s]}) → ${STATE_WORD[to]} if the ${what === 'tone' ? '5-day tone change' : '5d-vs-20d coverage'} goes ${up ? 'to' : 'below'} ${b > 0 ? '+' : ''}${b}${what === 'tone' ? '' : '%'}` });
    }
  }
  return cands.sort((a, b) => a.dist - b.dist)[0] ?? null;
}
const meanOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
// The measures at the last row of `daily` (or at index `i`, for the backtest). Null fields when short.
export function narrativeMetrics(daily = [], i = null) {
  const d = (daily || []).filter(o => num(o?.count) > 0 && num(o?.norm) > 0 && num(o?.tone) != null);
  const end = i == null ? d.length - 1 : i;
  if (end < 0) return null;
  const share = (o) => (o.count / o.norm) * 100;
  const win = (a, b) => d.slice(Math.max(0, end - a + 1), end - b + 1);   // days end−a+1 … end−b
  const mShare = (a, b) => { const w = win(a, b); return w.length === a - b ? meanOf(w.map(share)) : null; };
  const wTone = (a, b) => { const w = win(a, b); if (w.length !== a - b) return null; const n = w.reduce((x, o) => x + o.count, 0); return w.reduce((x, o) => x + o.tone * o.count, 0) / n; };
  const pc = (x, y) => (x != null && y ? (x / y - 1) * 100 : null);
  const s5 = mShare(5, 0), s20 = mShare(20, 0), t5 = wTone(5, 0), t5p = wTone(10, 5);
  return { as_of: d[end].date, share_pct: r3(share(d[end])), count: d[end].count, share5_pct: s5 == null ? null : r3(s5),
    cov_5v20: r1(pc(s5, s20)), cov_5v5: r1(pc(s5, mShare(10, 5))), cov_20v20: r1(pc(s20, mShare(40, 20))),
    tone5: t5 == null ? null : r2(t5), tone_chg5: t5 == null || t5p == null ? null : r2(t5 - t5p) };
}
export function narrativeRows(S = {}, { today = null } = {}) {
  const daily = S.narrative || [];
  const m = daily.length ? narrativeMetrics(daily) : null;
  const label = 'AI build-out narrative (GDELT)';
  if (!m || m.cov_5v20 == null || m.tone_chg5 == null) {
    return [row('narrative', 'ai_narrative', label, { state: null, vote: false, text: daily.length ? 'not available: fewer than 20 days of GDELT coverage' : 'not available: GDELT did not answer (rate limit or outage) and no cached copy' })];
  }
  // A completed UTC day is at most a day or two old; older than four and the source has stopped.
  const staleDays = today ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${m.as_of}T00:00:00Z`)) / 864e5) : 0;
  if (staleDays > 4) return [row('narrative', 'ai_narrative', label, { state: null, vote: false, asOf: m.as_of, text: `not available: GDELT's last day is ${m.as_of}, ${staleDays} days old` })];
  const st = narrativeState(m.cov_5v20, m.tone_chg5);
  const flags = [];
  if (!NARRATIVE_TEST.edge) flags.push(`under review, not voted: no tested edge on next-session SOXX/QQQ (${NARRATIVE_TEST.span}, n ${NARRATIVE_TEST.n}; ${NARRATIVE_TEST.note})`);
  const R = NARRATIVE_RULE;
  return [row('narrative', 'ai_narrative', label, { value: m.tone_chg5, roc: m.cov_5v20, rocLabel: 'coverage 5d vs 20d %', state: st, asOf: m.as_of, flags, vote: NARRATIVE_TEST.edge,
    text: `${m.share5_pct}% of coverage (5d mean), ${sgn(m.cov_5v20, 1, '%')} vs 20d (5d vs prior 5d ${sgn(m.cov_5v5, 1, '%')}, 20d vs prior 20d ${sgn(m.cov_20v20, 1, '%')}); tone ${m.tone5} (5d), ${sgn(m.tone_chg5, 2)} vs the 5 days before`,
    extra: { metrics: m, thresholds: { on: R.tone, off: -R.tone, dir: 1, unit: 'tone pts (5d change)', coverage_pct: R.coverage }, benchmark: R.basis,
      flip: narrativeFlip(m.cov_5v20, m.tone_chg5) } })];
}

// ── CLUSTERS, LEAN, WHAT FLIPS IT ────────────────────────────────────────────
export function clusterOf(rows, c) {
  const mine = rows.filter(r => c.dims.includes(r.dim) && r.vote);
  if (!mine.length) return { id: c.id, label: c.label, state: null, on: 0, off: 0, neutral: 0, rows: 0 };
  const on = mine.filter(r => r.state === 'on').length, off = mine.filter(r => r.state === 'off').length;
  const net = on - off;
  return { id: c.id, label: c.label, state: net > 0 ? 'on' : net < 0 ? 'off' : 'neutral', on, off, neutral: mine.length - on - off, rows: mine.length };
}
export function leanOf(clusters) {
  const read = clusters.filter(c => c.state != null);
  const on = read.filter(c => c.state === 'on').length, off = read.filter(c => c.state === 'off').length;
  const net = on - off;
  return { state: net > 0 ? 'on' : net < 0 ? 'off' : 'neutral', on, off, of: read.length,
    text: !read.length ? 'no cluster reads' : `${net > 0 ? 'Risk-on' : net < 0 ? 'Risk-off' : 'No'} lean: ${on} of ${read.length} clusters risk-on, ${off} risk-off` };
}
// The 2–3 voting rows nearest a state change, in threshold-gap units.
export function whatFlips(rows, n = 3) {
  return rows.filter(r => r.vote && r.flip).sort((a, b) => a.flip.dist - b.flip.dist).slice(0, n)
    .map(r => ({ id: r.id, label: r.label, from: r.state, to: r.flip.to, at: r.flip.at, value: r.value, dist: r.flip.dist,
      text: r.flip.text ?? `${r.label}: ${r.value} (${STATE_WORD[r.state]}) → ${STATE_WORD[r.flip.to]} ${r.flip.when} ${r.flip.at}${r.thresholds?.unit ? ` ${r.thresholds.unit}` : ''}` }));
}

export function buildSignalBoard(S = {}, { today = null, holidays = [], at = null } = {}) {
  const rows = [
    ...creditRows(S), ...ratesRows(S), ...oilRows(S),
    ...dealerRows(S, { today, holidays }), ...tapeRows(S), ...asiaRows(S), ...cryptoRows(S), ...narrativeRows(S, { today }),
  ];
  const clusters = CLUSTERS.map(c => clusterOf(rows, c));
  return { at, today, rows, clusters, lean: leanOf(clusters), flips: whatFlips(rows),
    method: 'Fixed thresholds per row (one set both directions); a cluster is the sign of rows on − rows off; the lean counts clusters, not rows. Market data only.' };
}

// ── TRADE-DAY CALL v2 ────────────────────────────────────────────────────────
// log R̂ = const + cush·cushion(0–100) + gap·|gap|/implied + prevR·prior-day R + ivchg·overnight IV change,
// fit 2012–2020 and scored 2021→ (scripts/trade-day-v2-calibrate.py; the betas match PR #384's
// scripts/trade-day-checkpoint-backtest.py). The residual is close to log-normal, so P(R ≥ 1) =
// Φ(log R̂ / σ); out of sample by predicted quintile QQQ 0.23/0.32/0.41/0.51/0.67 against realised
// 0.24/0.39/0.46/0.50/0.63, SPX 0.15/0.23/0.32/0.43/0.61 against 0.15/0.21/0.34/0.38/0.55.
// R = session high − low ÷ open ÷ (prior-close VXN or VIX ÷ 100 ÷ √252). SPY is called on the SPX
// model and VIX. The coefficients live in lib/tradeDayModel.json. The quarterly walk-forward refit
// (scripts/trade-day-refit.py, .github/workflows/trade-day-refit.yml) only PROPOSES new ones under
// docs/trade-day-refit/; a person copies them into the JSON.
export const TRADE_DAY_MODEL = Object.freeze({ QQQ: Object.freeze({ ...MODEL.r.QQQ }), SPY: Object.freeze({ ...MODEL.r.SPY }), fit: MODEL.r.fit });
// P(TREND DAY) (spec A.2). Trend day = the session closes in the top or bottom 20% of its own high–low
// range — a close-location day, base ≈ 49%, NOT the Gamma tab's ATR trend day (lib/trendTells.js, ≈ 24%).
// Fitted like P(R ≥ 1) on the same pre-open inputs plus the negative-GEX band (logistic), and scored
// walk-forward 2016→ (scripts/trade-day-refit.py). SKILL = a positive Brier skill score over the base rate
// with its 90% block-bootstrap interval above zero. On 20 Oct 2026 neither ticker had it (QQQ BSS +0.004
// [−0.004, +0.012], SPY +0.002 [−0.005, +0.010], n 2,714), so `skill` is false and the call shows the
// cushion band's base rate instead, and says so. Flip `skill` only from a refit that shows it.
export const TREND_MODEL = Object.freeze({ QQQ: MODEL.trend.QQQ, SPY: MODEL.trend.SPY, definition: MODEL.trend.definition });
const TREND_X = ['cush', 'neg', 'gap', 'prevR', 'ivchg'];
// One ticker's P(trend): the logistic when it has skill, else the band's base rate. `band` is the cushion
// band id (bandKey below).
export function trendDayProb(ticker, { cushionPct = null, gexNegative = false, gapSigma = null, prevR = null, ivChg = null, band = null } = {}) {
  const m = TREND_MODEL[ticker];
  if (!m || band == null) return null;
  const [bandPct, bandN] = m.bands[band] || [null, null];
  const all = m.base_pct, o = m.oos;
  const tested = `walk-forward ${o.span}, n ${o.n}: Brier ${o.brier_model} vs ${o.brier_base} for the base rate`;
  if (m.skill && cushionPct != null && prevR != null) {
    const x = { cush: cushionPct, neg: gexNegative ? 1 : 0, gap: gapSigma ?? 0, prevR, ivchg: ivChg ?? 0 };
    const z = m.coef.const + TREND_X.reduce((a, k) => a + m.coef[k] * x[k], 0);
    const p = 1 / (1 + Math.exp(-z));
    return { p: r2(p), source: 'model', skill: true, band_pct: bandPct, band_n: bandN, base_pct: all,
      text: `P(trend day) ${Math.round(p * 100)}% from the model (${tested}); all days ${all}%.` };
  }
  return { p: bandPct == null ? null : r2(bandPct / 100), source: 'band base rate', skill: false, band_pct: bandPct, band_n: bandN, base_pct: all,
    text: `P(trend day) ${bandPct}%: the cushion band's base rate (${bandN} days), all days ${all}%. The fitted model shows no out-of-sample skill over the base rate (${tested}), so the band's rate is shown instead.` };
}
// Per cushion band (negative GEX first, as lib/trendTells.js CUSHION): median R and the share of days
// R ≥ 1.0 — the distribution, not a mean. QQQ / SPX daily 2012-05 → 2026-10.
export const BAND_STATS = Object.freeze({
  QQQ: { neg: [1.20, 68, 317], p0: [1.10, 60, 403], p20: [1.01, 51, 586], p40: [0.92, 42, 671], p60: [0.88, 38, 672], p80: [0.78, 26, 987] },
  SPY: { neg: [1.13, 63, 317], p0: [1.02, 51, 403], p20: [0.92, 39, 586], p40: [0.80, 31, 671], p60: [0.76, 28, 672], p80: [0.68, 17, 987] },
});
// THE ZONE RULE, ONCE: on the median R a call expects.
// The rule itself lives in lib/trendTells.js beside the cushion bands it also labels.
export { ZONE_AT, zoneOf };
export const ZONE_WORD = Object.freeze({ trade: 'Trade', selective: 'Selective', 'lean skip': 'Lean skip' });

// Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf), good to 1e-7.
export function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
const bandKey = (pct, neg) => (neg ? 'neg' : pct == null ? null : pct < 20 ? 'p0' : pct < 40 ? 'p20' : pct < 60 ? 'p40' : pct < 80 ? 'p60' : 'p80');

// One ticker's pre-open call. cushionPct 0–100; gapSigma |open − prior close| ÷ prior close ÷ implied
// (null before a futures-implied open is known → 0, said so); prevR the prior session's R; ivChg the
// overnight change in VXN/VIX as a fraction (null → 0).
// `gapSource` names where the open came from ('actual open', 'futures-implied (NQ=F 08:35 ET)', …);
// `gapNote` replaces the default sentence in `assumed` when the gap is taken as 0 (why it is).
export function tradeDayCall(ticker, { cushionPct = null, gexNegative = false, gapSigma = null, prevR = null, ivChg = null, gapSource = null, gapNote = null } = {}) {
  const m = TRADE_DAY_MODEL[ticker];
  if (!m || cushionPct == null || prevR == null) return { ticker, ok: false, why: cushionPct == null ? 'no cushion' : 'no prior-day range' };
  const lp = m.const + m.cush * cushionPct + m.gap * (gapSigma ?? 0) + m.prevR * prevR + m.ivchg * (ivChg ?? 0);
  const median = r2(Math.exp(lp)), mean = Math.exp(lp + m.sigma ** 2 / 2), p1 = normCdf(lp / m.sigma);
  const bk = bandKey(cushionPct, gexNegative), bs = BAND_STATS[ticker][bk];
  // The band's lean for THIS ticker (QQQ its own median, SPY the S&P's) — the Gamma tab's chip, same rule.
  const lean = bandLean(CUSHION.find(b => b.key === bk), ticker);
  const tr = trendDayProb(ticker, { cushionPct, gexNegative, gapSigma, prevR, ivChg, band: bk });
  return { ticker, ok: true, iv: m.iv, median_r: r2(median), mean_r: r2(mean), p_r_ge_1: r2(p1), zone: zoneOf(median),
    p_trend: tr?.p ?? null, trend: tr,
    inputs: { cushion_pct: r1(cushionPct), gex_negative: !!gexNegative, gap_sigma: gapSigma == null ? null : r2(gapSigma), gap_source: gapSigma == null ? null : (gapSource || 'open'), prev_r: r2(prevR), iv_chg: ivChg == null ? null : r3(ivChg) },
    assumed: [gapSigma == null ? (gapNote || 'gap 0 (no futures-implied open yet)') : null, ivChg == null ? 'IV unchanged overnight' : null].filter(Boolean),
    band: { id: bk, median_r: bs[0], share_ge_1: bs[1], n: bs[2], lean },
    text: `${ticker}: median ${median.toFixed(2)}× implied, P(≥1.0×) ${Math.round(p1 * 100)}% — ${ZONE_WORD[zoneOf(median)]}. Cushion band history: median ${bs[0]}×, ${bs[1]}% of ${bs[2]} days ≥1.0×.${tr ? ` ${tr.text}` : ''}` };
}

// THE CHECKPOINTS (PR #384, docs/trade-day-checkpoint.md): the first 30 / 60 minutes' range ÷ open ÷
// implied, against bands at about the quartiles. Stats per band from scripts/trade-day-v2-calibrate.py:
// [n, median R_rest, share R_rest ≥ its median %, share full-day R ≥ 1.0 %]. 30-minute bars 2025-01 →
// 2026-10 for 10:00; hourly 2023-01 → 2026-10 for 10:30.
// `trend` (10:30 only): per band [n, share of sessions that ended a trend day %] — close in the top or bottom
// 20% of the day's range, the P(trend) definition — from Yahoo hourly bars 2024-10 → 2026-10 (the free
// record; scripts/trade-day-v2-calibrate.py). Base 45% QQQ / 41% SPY in that sample: the first hour barely
// moves it, so it is shown as history, not a signal. 10:00 has no trend share: Yahoo's 30-minute bars
// reach back only 60 sessions.
export const CHECKPOINTS = Object.freeze({
  QQQ: { '10:00': { quiet: 0.33, confirm: 0.50, stats: { quiet: [122, 0.60, 34, 13], middle: [186, 0.73, 46, 27], confirm: [138, 0.98, 70, 67] } },
         '10:30': { quiet: 0.43, confirm: 0.70, stats: { quiet: [244, 0.63, 39, 18], middle: [467, 0.71, 47, 36], confirm: [232, 0.86, 68, 78] },
                    trend: { span: '2024-10 → 2026-10', base: 45, quiet: [144, 43], middle: [227, 44], confirm: [122, 47] } } },
  SPY: { '10:00': { quiet: 0.25, confirm: 0.40, stats: { quiet: [129, 0.59, 31, 9], middle: [189, 0.67, 46, 21], confirm: [128, 0.88, 75, 52] } },
         '10:30': { quiet: 0.32, confirm: 0.55, stats: { quiet: [238, 0.54, 28, 11], middle: [465, 0.70, 51, 27], confirm: [240, 0.82, 71, 59] },
                    trend: { span: '2024-10 → 2026-10', base: 41, quiet: [142, 37], middle: [223, 44], confirm: [128, 42] } } },
});
export function checkpointRead(ticker, at, { firstRange = null, open = null, implied = null } = {}) {
  const c = CHECKPOINTS[ticker]?.[at];
  if (!c) return null;
  const th = { quiet_below: c.quiet, confirm_at: c.confirm };
  if (num(firstRange) == null || !(num(open) > 0) || !(num(implied) > 0)) {
    return { ticker, at, ok: false, ...th, text: `${ticker} ${at} ET: confirm at ≥${c.confirm}σ first range, quiet below ${c.quiet}σ` };
  }
  const fr = firstRange / open / implied;
  const band = fr >= c.confirm ? 'confirm' : fr < c.quiet ? 'quiet' : 'middle';
  const [n, med, geMed, ge1] = c.stats[band];
  const td = c.trend?.[band] || null;
  const trend = td ? { trend_day_pct: td[1], trend_n: td[0], trend_base_pct: c.trend.base, trend_span: c.trend.span } : {};
  return { ticker, at, ok: true, fr_sigma: r2(fr), band, ...th, history: { n, rest_median_r: med, rest_ge_median_pct: geMed, day_ge_1_pct: ge1, ...trend },
    text: `${ticker} ${at} ET: first range ${fr.toFixed(2)}σ — ${band === 'confirm' ? 'confirms a moving day' : band === 'quiet' ? 'quiet: a range day is likelier' : 'no signal'}; such days: rest-of-day median ${med}×, full day ≥1.0× ${ge1}% (n ${n})${td ? `; ended a trend day ${td[1]}% (n ${td[0]}, base ${c.trend.base}%)` : ''}.` };
}

// ── THE CONFLICT FLAG (spec A.6) ─────────────────────────────────────────────
// The trade-day call reads the SqueezeMetrics cushion (all of SPX) and the tape; the gamma board reads
// this ticker's own strikes. When the two disagree the call carries a `conflict` with both views. It never
// changes the call: the zone, median R and P(R ≥ 1) stand, and the reader sees why the structure argues.
//
// THE GAMMA VIEW is read from the payload the gamma feed and the get_gamma_* tools serve (lib/gexFeed.js
// gexFeedPayload on the board lib/gexFeedBoard.js feedBoard picks), never from a second fetch.
//
// THE RULES (fixed; σ = the call's implied_1sd, the prior close × VXN or VIX ÷ 100 ÷ √252, in dollars;
// the board's own ±1σ to the nearest expiry when that is missing). A rule needs every input it names.
//   Call Trade, structure pins it:
//     pin_box     spot inside the board's pin box [bottom, top] AND net gamma at spot > 0
//     call_wall   net gamma at spot > 0 AND the board's call wall carries positive gamma AND spot within
//                 0.5σ of it (the wall is the board's own dominant call strike, lib/gexLevels.js)
//   Call Lean skip, structure is unstable:
//     below_flip  the flip is a usable line AND spot below it AND net gamma at spot < 0
//     trapdoor    the near trapdoor is below spot and within 0.5σ of it (a normal day reaches it)
//   Selective: no conflict is raised — it is already the middle call.
// A board more than CONFLICT.maxAgeDays calendar days older than the session being called raises nothing
// and says so (`gamma.stale`).
export const CONFLICT = Object.freeze({ sigma: 0.5, maxAgeDays: 4 });
const bnOf = (v) => (num(v) == null ? null : r2(v / 1e9));
// The structure, from a gexFeedPayload-shaped answer: what the rules read and nothing else.
export function gammaView(p, { target = null } = {}) {
  const spot = num(p?.spot);
  if (!p || spot == null) return null;
  const asOf = p.as_of_utc ?? null;
  const day = asOf ? String(asOf).slice(0, 10) : null;
  const age = day && target ? Math.round((Date.parse(`${target}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 864e5) : null;
  const near = p.trapdoor?.near || null;
  return {
    as_of: asOf, mode: p.mode ?? null, spot,
    net_gamma_bn: bnOf(p.net_gex_per_1pct),
    flip: num(p.flip?.line), flip_usable: !!p.flip?.usable,
    call_wall: num(p.call_wall?.strike), call_wall_gamma_bn: bnOf(p.call_wall?.gamma),
    pin_lo: num(p.pin_box?.lo), pin_hi: num(p.pin_box?.hi),
    trap_near: num(near?.strike), trap_near_gamma_bn: bnOf(near?.gamma),
    move_1sd: num(p.expiries?.[0]?.move_1sd),
    stale: age != null && age > CONFLICT.maxAgeDays,
    ...(p.stale_reason ? { stale_reason: p.stale_reason } : {}),
  };
}
const fx = (v) => (v == null ? '—' : (+v).toFixed(2));
// The rules that fire for this zone on this structure. sigma in dollars.
export function conflictRules(zone, g, sigma) {
  if (!g || g.stale) return [];
  const net = g.net_gamma_bn, sd = num(sigma) ?? g.move_1sd ?? null, near = sd == null ? null : CONFLICT.sigma * sd;
  const out = [];
  if (zone === 'trade') {
    if (g.pin_lo != null && g.pin_hi != null && net != null && net > 0 && g.spot >= g.pin_lo && g.spot <= g.pin_hi) {
      out.push({ id: 'pin_box', text: `spot ${fx(g.spot)} inside the pin box ${fx(g.pin_lo)}–${fx(g.pin_hi)} with net gamma +$${net}bn per 1%` });
    }
    if (near != null && net != null && net > 0 && g.call_wall != null && (g.call_wall_gamma_bn ?? 0) > 0 && Math.abs(g.spot - g.call_wall) <= near) {
      out.push({ id: 'call_wall', text: `spot ${fx(g.spot)} within ${CONFLICT.sigma}σ ($${fx(near)}) of the call wall ${fx(g.call_wall)} (+$${g.call_wall_gamma_bn}bn), net gamma +$${net}bn per 1%` });
    }
  } else if (zone === 'lean skip') {
    if (g.flip_usable && g.flip != null && net != null && net < 0 && g.spot < g.flip) {
      out.push({ id: 'below_flip', text: `spot ${fx(g.spot)} below the flip ${fx(g.flip)} with net gamma −$${Math.abs(net)}bn per 1%` });
    }
    if (near != null && g.trap_near != null && g.trap_near < g.spot && g.spot - g.trap_near <= near) {
      out.push({ id: 'trapdoor', text: `near trapdoor ${fx(g.trap_near)} is ${fx(g.spot - g.trap_near)} below spot, within ${CONFLICT.sigma}σ ($${fx(near)})` });
    }
  }
  return out;
}
// The conflict object for one call, or null when the views agree (or the structure cannot be read).
export function tradeConflict(call, g) {
  if (!call?.ok || !g) return null;
  const rules = conflictRules(call.zone, g, call.implied_1sd);
  if (!rules.length) return null;
  const structure = call.zone === 'trade' ? 'pinned' : 'unstable';
  const callWord = ZONE_WORD[call.zone];
  return {
    call_zone: call.zone, gamma_reads: structure, rules: rules.map(r => r.id),
    detail: rules, sigma_usd: num(call.implied_1sd) ?? g.move_1sd ?? null, gamma_as_of: g.as_of, gamma_mode: g.mode,
    overrides: false,
    text: `${call.ticker}: the call says ${callWord} (median ${call.median_r}×); the gamma board reads ${structure} — ${rules.map(r => r.text).join('; ')}. Both views shown; the call is not changed.`,
  };
}

// THE PUBLIC SHAPE. /api/indicators?board=1 (and so data/signal_board_history.json, written from it) carries
// no gamma levels: each call drops `gamma`, and `conflict` keeps only the rule ids, overrides: false and a
// generic sentence with no price in it. The connector's get_signal_board keeps the full objects. Both are
// computed the same way (tradeConflict); this only trims what leaves on the public route.
export const CONFLICT_GENERIC = Object.freeze({
  pin_box: 'live gamma shows a pin near spot',
  call_wall: 'live gamma shows a large call wall near spot',
  below_flip: 'live gamma shows spot below the flip with negative gamma',
  trapdoor: 'live gamma shows a trapdoor close below spot',
});
export function publicConflict(c, ticker) {
  if (!c) return null;
  const why = c.rules.map(id => CONFLICT_GENERIC[id] ?? 'live gamma disagrees').join('; ');
  return { call_zone: c.call_zone, gamma_reads: c.gamma_reads, rules: [...c.rules], overrides: false,
    text: `${ticker}: the call says ${ZONE_WORD[c.call_zone]}; ${why}. Both views are read; the call is not changed.` };
}
export function publicTradeDay(td) {
  if (!td?.calls) return td;
  const calls = Object.fromEntries(Object.entries(td.calls).map(([t, c]) => {
    const { gamma: _gamma, conflict, ...rest } = c || {};
    return [t, c ? { ...rest, conflict: publicConflict(conflict, t) } : c];
  }));
  return { ...td, calls };
}

// The prior session's R for a ticker: its high − low ÷ open ÷ the implied at the close BEFORE it.
export function priorR(bars = [], iv = []) {
  const b = (bars || []).filter(x => [x.open, x.high, x.low].every(Number.isFinite));
  if (b.length < 2) return null;
  const lastBar = b[b.length - 1];
  const ivm = new Map((iv || []).map(o => [o.date, num(o.value)]));
  const before = (iv || []).filter(o => o.date < lastBar.date).pop();
  const v = before ? ivm.get(before.date) : null;
  if (!v) return null;
  return (lastBar.high - lastBar.low) / lastBar.open / (v / 100 / Math.sqrt(252));
}

// The whole trade-day block from the board's inputs. `pre` optionally carries { QQQ: {open, ivNow, source},
// SPY: {...} } once a futures-implied or actual open is known (or { note } saying why it is not); `first` optionally carries
// { QQQ: { '10:00': {firstRange, open}, '10:30': {...} } } from today's intraday bars.
// `target` is the session being called: everything dated on or after it is left out, so a call made
// during or after a session never reads that session's own bar, VXN or GEX.
// `gamma` optionally carries { QQQ: payload, SPY: payload } — the gamma feed's answer for each ticker
// (lib/gexFeed.js gexFeedPayload) — for the conflict flag; without it `gamma` and `conflict` are null.
export function tradeDayBlock(S0 = {}, { pre = {}, first = {}, target = null, gamma = {} } = {}) {
  const before = (s) => (target ? (s || []).filter(o => (Array.isArray(o) ? o[0] : o.date) < target) : (s || []));
  const S = { ...S0, squeeze: before(S0.squeeze), qqqBars: before(S0.qqqBars), spyBars: before(S0.spyBars), vxn: before(S0.vxn), vix: before(S0.vix) };
  const sq = S.squeeze || [];
  const sl = sq.length ? sq[sq.length - 1] : null;
  const pct = sl ? gexPercentile(sq, sl[0]) : null;
  const out = { target, as_of: sl?.[0] ?? null, cushion_pct: pct == null ? null : r1(pct * 100), gex_negative: sl ? sl[1] < 0 : null, calls: {}, checkpoints: {} };
  for (const [t, bars, iv] of [['QQQ', S.qqqBars, S.vxn], ['SPY', S.spyBars, S.vix]]) {
    const ivLast = last(iv), lastBar = (bars || []).at?.(-1);
    const implied = ivLast ? ivLast.value / 100 / Math.sqrt(252) : null;
    const p = pre[t] || {};
    const gapSigma = p.open && lastBar?.close && implied ? Math.abs(p.open / lastBar.close - 1) / implied : null;
    const ivChg = p.ivNow && ivLast ? p.ivNow / ivLast.value - 1 : null;
    out.calls[t] = tradeDayCall(t, { cushionPct: pct == null ? null : pct * 100, gexNegative: sl ? sl[1] < 0 : false, gapSigma, prevR: priorR(bars, iv), ivChg,
      gapSource: p.source ?? null, gapNote: p.note ?? null });
    out.calls[t].implied_1sd = implied && lastBar?.close ? r2(lastBar.close * implied) : null;
    const gv = out.calls[t].ok ? gammaView(gamma?.[t], { target }) : null;
    out.calls[t].gamma = gv;
    out.calls[t].conflict = tradeConflict(out.calls[t], gv);
    out.checkpoints[t] = ['10:00', '10:30'].map(at => checkpointRead(t, at, { ...(first[t]?.[at] || {}), implied }));
  }
  return out;
}

// ── SNAPSHOTS AND SCORING ────────────────────────────────────────────────────
// One compact row per date: what each signal said and what the trade-day call was. Realised fields are
// filled later by scoreRows from closes and bars, never by hand.
// `as_of` is the last settled QQQ close the board read — forward returns run from it; `target` is the
// session the trade-day call was for.
export function snapshotRow(board, tradeDay, date) {
  const asOf = (board?.rows || []).find(r => r.id === 'qqq_ma')?.as_of ?? null;
  return {
    date, at: board?.at ?? null, as_of: asOf, target: tradeDay?.target ?? null,
    rows: Object.fromEntries((board?.rows || []).map(r => [r.id, { v: r.value, s: r.state }])),
    clusters: Object.fromEntries((board?.clusters || []).map(c => [c.id, c.state])),
    lean: board?.lean?.state ?? null,
    call: Object.fromEntries(Object.entries(tradeDay?.calls || {}).map(([t, c]) => [t, c.ok ? { median_r: c.median_r, p1: c.p_r_ge_1, zone: c.zone, p_trend: c.p_trend ?? null, conflict: c.conflict?.rules ?? null } : null])),
    fwd: null, realised: null,
  };
}
const fwdRet = (closes, date, k) => {
  const ds = Object.keys(closes || {}).sort();
  const i = ds.findIndex(d => d >= date);
  // `date` is the board's as-of session (its data close); returns run from that close.
  if (i < 0 || ds[i] !== date || i + k >= ds.length) return null;
  return r2((closes[ds[i + k]] / closes[ds[i]] - 1) * 100);
};
// Fill forward returns (1/3/5 sessions, QQQ and SOXX) from the row's as-of close, and the realised R of
// the session the call was for (the first session after the as-of date). closes: {QQQ: {date: close},
// SOXX: {...}}; sessions: {QQQ: {date: R}, SPY: {date: R}} — R already computed from bars and implied.
export function scoreRows(rows = [], { closes = {}, sessions = {}, asOfOf = (r) => r.as_of ?? r.date } = {}) {
  return rows.map(r => {
    const d = asOfOf(r);
    const fwd = {};
    for (const s of ['QQQ', 'SOXX']) for (const k of [1, 3, 5]) fwd[`${s}_${k}`] = fwdRet(closes[s], d, k);
    const realised = {};
    for (const t of ['QQQ', 'SPY']) {
      const ds = Object.keys(sessions[t] || {}).sort();
      const next = r.target && sessions[t]?.[r.target] != null ? r.target : r.target ? null : ds.find(x => x > d);
      realised[t] = next ? { date: next, r: r2(sessions[t][next]) } : null;
    }
    return { ...r, fwd: Object.values(fwd).some(v => v != null) ? fwd : r.fwd ?? null, realised: Object.values(realised).some(Boolean) ? realised : r.realised ?? null };
  });
}
// The scorecard: per signal row, per state, the hit rate (risk-on → QQQ up, risk-off → QQQ down) and
// mean forward return; per ticker, the trade-day call against realised R over the last 20 and 60.
export function scorecard(rows = []) {
  const scored = rows.filter(r => r.fwd);
  const ids = [...new Set(scored.flatMap(r => Object.keys(r.rows || {})))];
  const signals = {};
  for (const id of ids) {
    const per = {};
    for (const st of ['on', 'off']) {
      for (const h of ['QQQ_1', 'QQQ_3', 'QQQ_5', 'SOXX_1', 'SOXX_3', 'SOXX_5']) {
        const xs = scored.filter(r => r.rows?.[id]?.s === st && r.fwd[h] != null).map(r => r.fwd[h]);
        if (!xs.length) continue;
        const hits = xs.filter(x => (st === 'on' ? x > 0 : x < 0)).length;
        (per[st] ||= {})[h] = { n: xs.length, hit_pct: Math.round((hits / xs.length) * 100), mean_pct: r2(xs.reduce((a, b) => a + b, 0) / xs.length) };
      }
    }
    if (Object.keys(per).length) signals[id] = per;
  }
  const calls = {};
  for (const t of ['QQQ', 'SPY']) {
    const done = rows.filter(r => r.call?.[t] && r.realised?.[t]?.r != null);
    const win = (n) => {
      const w = done.slice(-n), judged = w.filter(r => r.call[t].zone !== 'selective');
      const hit = judged.filter(r => (r.call[t].zone === 'trade' ? r.realised[t].r >= 1 : r.realised[t].r < 1)).length;
      const brier = w.length ? w.reduce((a, r) => a + (r.call[t].p1 - (r.realised[t].r >= 1 ? 1 : 0)) ** 2, 0) / w.length : null;
      return { n: w.length, judged: judged.length, hit_pct: judged.length ? Math.round((hit / judged.length) * 100) : null, brier: brier == null ? null : r3(brier) };
    };
    calls[t] = { last20: win(20), last60: win(60) };
  }
  return { scored_days: scored.length, signals, calls };
}
