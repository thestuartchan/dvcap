// growth.js — the WEEKLY leg of the growth axis.
//
// Why this exists: the growth read leaned on one monthly series (payrolls, with emp-pop as the
// control), which lands three to five weeks after the month it describes. A regime whose growth
// input is that slow can only ever confirm a turn, never see one coming. This leg gives the axis a
// weekly pulse from series that turn earlier: initial and continuing claims, the New York Fed's
// Weekly Economic Index, and the Atlanta Fed's GDPNow. None of them is the axis on its own — the
// composite below says what the WEEKLY data is consistent with, and which leg is carrying it.
//
// Every threshold is a named constant so the "flips if" line is computed from the same numbers
// the verdict used, and a change to one cannot leave the other describing a rule that no longer
// exists (the regimeFlipsIf discipline from lib/regime.js).
//
// `now` is injectable everywhere an age is computed. The 2026-09-14 golden failure — six call
// sites reading the wall clock while the fixture was pinned — is not repeated here.
import { observationAge } from './gates.js';

// Series contract. `expectTitle` is asserted against FRED's own metadata at fetch time, the same
// way lib/labor.js does it, so a repurposed or mistyped id fails loudly. `lagBizDays` is the
// series' OWN publication rhythm: claims print Thursday for the week ending the prior Saturday,
// continuing claims one week behind that, the WEI on Tuesday for the prior Saturday. GDPNow is
// aged by its release date (the FRED vintage), not by the quarter it forecasts — see api side.
export const GROWTH_SERIES = {
  claims:     { id: 'ICSA',   label: 'Initial claims',          unit: 'k', expectTitle: 'initial claims',          lagBizDays: 8,  scale: 1 / 1000 },
  continuing: { id: 'CCSA',   label: 'Continuing claims',       unit: 'k', expectTitle: 'continued claims',        lagBizDays: 13, scale: 1 / 1000 },
  wei:        { id: 'WEI',    label: 'Weekly Economic Index',   unit: '%', expectTitle: 'weekly economic index',   lagBizDays: 8,  scale: 1 },
  gdpNow:     { id: 'GDPNOW', label: 'GDPNow',                  unit: '%', expectTitle: 'gdpnow',                  lagBizDays: 15, scale: 1 },
};

// ── TUNABLES — one copy, used by both the verdict and the flips-if line ──────
export const CLAIMS_WINDOW = 4;          // weeks in the smoothing average
export const CLAIMS_LOOKBACK = 12;       // weeks between the two averages compared (~one quarter)
export const CLAIMS_RISE_PCT = 10;       // 4wk avg up this much vs a quarter ago → weakening
export const CLAIMS_FALL_PCT = -10;      // down this much → strengthening
export const CONTINUING_RISE_PCT = 5;    // the slower series moves less; a smaller bar
export const CONTINUING_FALL_PCT = -5;
export const WEI_STRONG = 1.5;           // WEI is scaled to GDP y/y; ~trend growth
export const WEI_CONTRACT = 0;           // below zero the weekly composite says contraction
export const GDPNOW_STRONG = 2.0;        // % SAAR, ~trend
export const GDPNOW_WEAK = 1.0;          // below this the nowcast is stall-speed
export const MIN_LEGS = 2;               // fewer usable legs than this → no verdict

const r1 = v => v == null ? null : +Number(v).toFixed(1);
const pct = (a, b) => (a == null || b == null || b === 0) ? null : +((a / b - 1) * 100).toFixed(1);
const fmtK = v => v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)}M` : `${Math.round(v)}k`;
const sgn = v => v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
const bar = v => Number(v).toFixed(1);   // a threshold prints with one decimal: "below 2.0", never "below 2"

// Latest N and the N before a lookback, from an ascending {date,value} history. Null when the
// history is too short — an average over fewer weeks than the window is a different statistic
// and would be presented under the same name.
function windowAverages(history, window, lookback, scale) {
  const h = (history || []).filter(o => o && Number.isFinite(o.value));
  if (h.length < window + lookback) return null;
  const avg = arr => arr.reduce((s, o) => s + o.value * scale, 0) / arr.length;
  const latest = avg(h.slice(-window));
  const prior = avg(h.slice(-(window + lookback), -lookback));
  return { latest: r1(latest), prior: r1(prior), change: pct(latest, prior) };
}

function vintageOf(date, lagBizDays, now) {
  if (!date) return { available: false, late: true, bizDays: null, note: 'no observation date' };
  const age = observationAge(date, now);
  if (!age?.available) return { available: false, late: true, bizDays: null, note: age?.note || 'age unknown' };
  const late = age.bizDays > lagBizDays;
  return { available: true, late, bizDays: age.bizDays, tolerance: lagBizDays,
           note: late ? `has not printed since ${date} (${age.bizDays} business days)` : null };
}

// One leg → { key, label, available, reason, score, value, unit, date, vintage, read, detail }.
// `score` is −1 / 0 / +1 — the leg's vote on growth. A leg that is missing, unverified-and-empty,
// or LATE is excluded (available:false with the reason), never counted as flat: an absent input
// is not a zero.
function claimsLeg(raw, key, m, now) {
  if (!raw?.ok) return { key, label: m.label, available: false, reason: raw?.error || 'no print' };
  const v = vintageOf(raw.date, m.lagBizDays, now);
  if (v.late) return { key, label: m.label, available: false, reason: v.note, date: raw.date, vintage: v,
                       value: r1(raw.value * m.scale), unit: m.unit };
  const w = windowAverages(raw.history, CLAIMS_WINDOW, CLAIMS_LOOKBACK, m.scale);
  if (!w) return { key, label: m.label, available: false, reason: `needs ${CLAIMS_WINDOW + CLAIMS_LOOKBACK} weekly prints, have ${(raw.history || []).length}`,
                   date: raw.date, vintage: v, value: r1(raw.value * m.scale), unit: m.unit };
  const rise = key === 'claims' ? CLAIMS_RISE_PCT : CONTINUING_RISE_PCT;
  const fall = key === 'claims' ? CLAIMS_FALL_PCT : CONTINUING_FALL_PCT;
  const score = w.change >= rise ? -1 : w.change <= fall ? 1 : 0;
  const dirWord = score < 0 ? 'rising' : score > 0 ? 'falling' : 'steady';
  return {
    key, label: m.label, available: true, score, unit: m.unit,
    value: r1(raw.value * m.scale), date: raw.date, vintage: v,
    avg: w.latest, prior: w.prior, change: w.change,
    read: `${m.label} ${CLAIMS_WINDOW}-week average ${fmtK(w.latest)}, ${sgn(w.change)}% vs a quarter ago — ${dirWord}`,
    // The bar as a LEVEL the reader can watch for, computed from the base the change is measured against.
    flip: score === 0
      ? `${m.label.toLowerCase()} average above ${fmtK(w.prior * (1 + rise / 100))} (${sgn(rise)}%) or below ${fmtK(w.prior * (1 + fall / 100))} (${sgn(fall)}%)`
      : score < 0 ? `${m.label.toLowerCase()} average back below ${fmtK(w.prior * (1 + rise / 100))}`
      : `${m.label.toLowerCase()} average back above ${fmtK(w.prior * (1 + fall / 100))}`,
  };
}

function weiLeg(raw, m, now) {
  if (!raw?.ok) return { key: 'wei', label: m.label, available: false, reason: raw?.error || 'no print' };
  const v = vintageOf(raw.date, m.lagBizDays, now);
  const value = r1(raw.value);
  if (v.late) return { key: 'wei', label: m.label, available: false, reason: v.note, date: raw.date, vintage: v, value, unit: m.unit };
  const h = (raw.history || []).filter(o => Number.isFinite(o?.value));
  const fourAgo = h.length >= 5 ? r1(h[h.length - 5].value) : null;
  const trend = fourAgo == null ? null : r1(value - fourAgo);
  const score = value >= WEI_STRONG ? 1 : value < WEI_CONTRACT ? -1 : 0;
  const word = score > 0 ? 'at or above trend' : score < 0 ? 'in contraction' : 'below trend but positive';
  return {
    key: 'wei', label: m.label, available: true, score, unit: m.unit, value, date: raw.date, vintage: v, trend,
    read: `WEI ${sgn(value)} (GDP-scaled y/y), ${word}${trend != null ? `, ${sgn(trend)} over four weeks` : ''}`,
    flip: score > 0 ? `WEI below ${bar(WEI_STRONG)}` : score < 0 ? `WEI back above ${bar(WEI_CONTRACT)}` : `WEI above ${bar(WEI_STRONG)} or below ${bar(WEI_CONTRACT)}`,
  };
}

// GDPNow arrives with its RELEASE date as `asOf` (the FRED vintage) and the quarter it forecasts
// as `quarter`; `prev` is the previous estimate for the SAME quarter. Aged by release date: a
// nowcast that has not been re-issued in three weeks is between releases, not stale, and the
// tolerance reflects that.
function gdpNowLeg(raw, m, now) {
  if (!raw?.ok) return { key: 'gdpNow', label: m.label, available: false, reason: raw?.error || 'no print' };
  const v = vintageOf(raw.asOf, m.lagBizDays, now);
  const value = r1(raw.value);
  if (v.late) return { key: 'gdpNow', label: m.label, available: false, reason: v.note, date: raw.asOf, vintage: v, value, unit: m.unit };
  const delta = raw.prev == null ? null : r1(value - raw.prev);
  const score = value >= GDPNOW_STRONG ? 1 : value < GDPNOW_WEAK ? -1 : 0;
  const word = score > 0 ? 'at or above trend' : score < 0 ? 'stall-speed' : 'below trend';
  return {
    key: 'gdpNow', label: m.label, available: true, score, unit: m.unit, value, date: raw.asOf, quarter: raw.quarter, vintage: v, delta,
    read: `GDPNow ${value}% SAAR for ${raw.quarter || 'the quarter'}, ${word}${delta != null ? `, ${sgn(delta)}pp vs the prior estimate` : ''}`,
    flip: score > 0 ? `GDPNow below ${bar(GDPNOW_STRONG)}` : score < 0 ? `GDPNow back above ${bar(GDPNOW_WEAK)}` : `GDPNow above ${bar(GDPNOW_STRONG)} or below ${bar(GDPNOW_WEAK)}`,
  };
}

export const MARKET_LABEL = Object.freeze({
  EXPANDING: 'PAYING FOR GROWTH', MIXED: 'FLAT', SOFTENING: 'TILTING TO SAFETY', CONTRACTING: 'PAYING FOR SAFETY', INSUFFICIENT: 'INSUFFICIENT',
});
export const VERDICT_STATUS = Object.freeze({
  EXPANDING: 'BENIGN', MIXED: 'WATCH', SOFTENING: 'WATCH', CONTRACTING: 'ELEVATED', INSUFFICIENT: 'WATCH',
});

// The composite, shared by the weekly and the market legs. `what` names the kind of leg in the
// prose ("weekly legs", "market ratios"). Series names keep their own case — "GDPNow", not
// "gdpnow" — because a name is not a word.
function compose(legs, what, raw) {
  const usable = legs.filter(l => l.available);
  const excluded = legs.filter(l => !l.available);
  const sum = usable.reduce((s, l) => s + l.score, 0);
  let verdict;
  if (usable.length < MIN_LEGS) verdict = 'INSUFFICIENT';
  else if (sum > 0) verdict = 'EXPANDING';
  else if (sum === 0) verdict = 'MIXED';
  else if (sum <= -2) verdict = 'CONTRACTING';
  else verdict = 'SOFTENING';
  const status = VERDICT_STATUS[verdict];
  const signs = new Set(usable.map(l => Math.sign(l.score)));
  const agreement = usable.length >= MIN_LEGS && signs.size === 1 ? 'confirmed' : 'split';
  const positives = usable.filter(l => l.score > 0), negatives = usable.filter(l => l.score < 0), flats = usable.filter(l => l.score === 0);
  const names = arr => arr.map(l => l.label).join(', ');
  const cap = str => str.charAt(0).toUpperCase() + str.slice(1);

  // What the arrangement is consistent with — never what to do.
  let read;
  if (verdict === 'INSUFFICIENT') {
    read = `Only ${usable.length} of ${legs.length} ${what} usable — no ${what.split(' ')[0]} growth read`;
  } else if (agreement === 'confirmed') {
    const market = what === 'market ratios';
    read = sum > 0 ? (market ? `All ${usable.length} ${what} are paying for growth` : `All ${usable.length} ${what} point to growth at or above trend`)
      : sum < 0 ? (market ? `All ${usable.length} ${what} are paying for safety` : `All ${usable.length} ${what} point to weakening growth`)
      : (market ? `All ${usable.length} ${what} sit inside their bands — no growth tilt priced` : `All ${usable.length} ${what} sit inside their bands — growth below trend, not turning`);
  } else {
    const parts = [];
    if (negatives.length) parts.push(`${names(negatives)} weakening`);
    if (positives.length) parts.push(`${names(positives)} firm`);
    if (flats.length) parts.push(`${names(flats)} steady`);
    read = `${cap(what)} split — ${parts.join('; ')}`;
  }
  // The nearest exits. For a confirmed read, the leg whose flip would break the agreement; for a
  // split, every leg's own bar, because any one of them changes the balance.
  const flipsIf = verdict === 'INSUFFICIENT'
    ? (excluded.length ? `Reads once ${names(excluded)} ${excluded.length === 1 ? 'prints' : 'print'}.` : null)
    : `Flips if ${usable.map(l => l.flip).join(', or ')}.`;
  const worst = usable.reduce((w, l) => (l.vintage?.bizDays ?? 0) > (w?.bizDays ?? -1) ? l.vintage : w, null);
  return {
    verdict, label: verdict, status, score: sum, usable: usable.length, of: legs.length, agreement,
    legs, excluded: excluded.map(l => ({ key: l.key, label: l.label, reason: l.reason })),
    read, flipsIf,
    vintage: worst ? { bizDays: worst.bizDays, late: false } : null,
    unverified: Object.entries(raw || {}).filter(([, v]) => v && v.ok && v.verified === false).map(([k, v]) => ({ key: k, mismatch: v.mismatch })),
  };
}

// The weekly leg. `raw` is api/indicators.js's `growth` block: { claims, continuing, wei, gdpNow }.
export function growthPulse(raw = {}, { now = new Date() } = {}) {
  return compose([
    claimsLeg(raw.claims, 'claims', GROWTH_SERIES.claims, now),
    claimsLeg(raw.continuing, 'continuing', GROWTH_SERIES.continuing, now),
    weiLeg(raw.wei, GROWTH_SERIES.wei, now),
    gdpNowLeg(raw.gdpNow, GROWTH_SERIES.gdpNow, now),
  ], 'weekly legs', raw);
}

// ── THE MARKET-IMPLIED LEG ───────────────────────────────────────────────────
// Five relative-performance ratios that price growth before the data reports it: cyclicals over
// defensives, the equal-weight index over the cap-weighted one, copper over gold, small caps over
// large, transports over the index. Each is scored on its change over MARKET_LOOKBACK sessions —
// a trend, never a level, because the level of a ratio carries no information about growth
// (XLY/XLP at 1.4 means nothing; XLY/XLP up 3% in a month means the market is paying for
// cyclicality). Keyless, daily, from the same Yahoo path the tape classifier uses.
//
// Copper/gold is the most volatile pair and gets a wider bar; the others share one. A ratio is
// aged by the date of its last session and excluded when the feed has gone quiet — a ratio that
// has not printed in three business days is a broken feed, not a flat market.
export const MARKET_PAIRS = {
  cyclicals:  { num: 'XLY',  den: 'XLP',  label: 'Cyclicals / defensives', risePct: 2,  fallPct: -2 },
  breadth:    { num: 'RSP',  den: 'SPY',  label: 'Equal-weight / cap-weight', risePct: 1.5, fallPct: -1.5 },
  copperGold: { num: 'HG=F', den: 'GC=F', label: 'Copper / gold',           risePct: 4,  fallPct: -4 },
  smallLarge: { num: 'IWM',  den: 'SPY',  label: 'Small / large caps',       risePct: 2,  fallPct: -2 },
  transports: { num: 'IYT',  den: 'SPY',  label: 'Transports / index',       risePct: 2,  fallPct: -2 },
};
export const MARKET_LOOKBACK = 20;       // sessions — one month of trading
export const MARKET_LAG_BIZ_DAYS = 3;    // a ratio older than this has a broken feed behind it

function ratioLeg(raw, key, m, now) {
  if (!raw?.ok) return { key, label: m.label, available: false, reason: raw?.error || 'no series' };
  const series = (raw.series || []).filter(o => o && Number.isFinite(o.value) && o.date);
  const last = series[series.length - 1];
  const v = vintageOf(last?.date, MARKET_LAG_BIZ_DAYS, now);
  if (v.late) return { key, label: m.label, available: false, reason: v.note, date: last?.date, vintage: v, value: last?.value ?? null, unit: 'x' };
  if (series.length < MARKET_LOOKBACK + 1) return { key, label: m.label, available: false, reason: `needs ${MARKET_LOOKBACK + 1} sessions, have ${series.length}`,
                                                    date: last.date, vintage: v, value: last.value, unit: 'x' };
  const base = series[series.length - 1 - MARKET_LOOKBACK];
  const change = pct(last.value, base.value);
  const score = change >= m.risePct ? 1 : change <= m.fallPct ? -1 : 0;
  const word = score > 0 ? 'paying for growth' : score < 0 ? 'paying for safety' : 'flat';
  const pair = `${m.num}/${m.den}`;
  // Four significant figures, not three decimals: copper/gold sits near 0.0013 and "below 0.001" is not a bar.
  const lvl = f => f == null ? '—' : Number(f.toPrecision(4)).toString();
  return {
    key, label: m.label, available: true, score, unit: 'x',
    value: +last.value.toPrecision(5), date: last.date, vintage: v, base: +base.value.toPrecision(5), baseDate: base.date, change,
    read: `${m.label} (${pair}) ${sgn(change)}% over ${MARKET_LOOKBACK} sessions — ${word}`,
    flip: score === 0
      ? `${pair} above ${lvl(base.value * (1 + m.risePct / 100))} (${sgn(m.risePct)}%) or below ${lvl(base.value * (1 + m.fallPct / 100))} (${sgn(m.fallPct)}%) vs the ${base.date} base`
      : score > 0 ? `${pair} back below ${lvl(base.value * (1 + m.risePct / 100))}`
      : `${pair} back above ${lvl(base.value * (1 + m.fallPct / 100))}`,
  };
}

// `raw` is api/indicators.js's `growthMarket` block: { pairs: { cyclicals: {ok, series}, … } }.
export function marketPulse(raw = {}, { now = new Date() } = {}) {
  const pairs = raw.pairs || {};
  const legs = Object.entries(MARKET_PAIRS).map(([key, m]) => ratioLeg(pairs[key], key, m, now));
  const out = compose(legs, 'market ratios', {});
  out.unverified = [];
  out.label = MARKET_LABEL[out.verdict];
  return out;
}

// ── THE TWO LEGS AGAINST EACH OTHER ──────────────────────────────────────────
// The market leg leads the data by one to three months, so the informative state is not
// agreement but the market turning while the weekly data has not — that is what a turning point
// looks like from inside it. Named as such, rather than as a conflict.
const lean = v => v === 'EXPANDING' ? 1 : (v === 'SOFTENING' || v === 'CONTRACTING') ? -1 : v === 'MIXED' ? 0 : null;
export function growthAxis({ weekly, market } = {}) {
  const w = lean(weekly?.verdict), m = lean(market?.verdict);
  if (w == null && m == null) return { state: 'insufficient', read: 'Neither leg has enough usable inputs for a growth read' };
  if (w == null) return { state: 'market-only', read: `Only the market leg reads (${market.verdict.toLowerCase()}) — the weekly data has too few usable legs` };
  if (m == null) return { state: 'data-only', read: `Only the weekly data reads (${weekly.verdict.toLowerCase()}) — the market ratios are not usable` };
  if (w === m) return { state: 'confirmed', read: w > 0 ? 'Market and weekly data agree: growth at or above trend'
    : w < 0 ? 'Market and weekly data agree: growth weakening' : 'Market and weekly data agree: growth below trend, not turning' };
  if (m < 0 && w >= 0) return { state: 'turning-down', read: 'The market is paying for safety while the weekly data still reads firm — the market leads; a turning point looks like this from inside it' };
  if (m > 0 && w <= 0) return { state: 'turning-up', read: 'The market is paying for growth while the weekly data still reads soft — the market leads; a turning point looks like this from inside it' };
  return { state: 'split', read: `Market ${market.verdict.toLowerCase()}, weekly data ${weekly.verdict.toLowerCase()}` };
}
