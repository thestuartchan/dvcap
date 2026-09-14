// inflationAxis.js — the inflation axis, in lead order: what the market prices, what the
// Cleveland Fed nowcasts, what the BLS and BEA have printed.
//
// The regime's inflation input was one monthly figure (core PCE, four to six weeks late) and a
// headline CPI. Breakevens and oil move daily, the Cleveland Fed publishes a nowcast of the
// current month every business day, and the printed data arrives last. Same discipline as the
// growth axis: every threshold a named constant, the flips-if line computed from the same
// numbers the verdict used, a late input excluded and named, the clock injectable.
//
// SIGN CONVENTION: +1 is inflation above target and rising — HOT; −1 is at or below target or
// falling — COOL. So the quadrant reads growth × inflation with no sign gymnastics.
import { observationAge } from './gates.js';
import { compose, vintageOf, sgn, bar, pct, MIN_LEGS } from './growth.js';

export const INFLATION_SERIES = {
  be5:        { id: 'T5YIE',    label: '5Y breakeven',          unit: '%', expectTitle: 'breakeven inflation', lagBizDays: 3 },
  be10:       { id: 'T10YIE',   label: '10Y breakeven',         unit: '%', expectTitle: 'breakeven inflation', lagBizDays: 3 },
  coreCpiIdx: { id: 'CPILFESL', label: 'Core CPI, 3m annualised', unit: '%', expectTitle: 'less food and energy', lagBizDays: 52 },
};
// Bands. The Fed's target is 2% on core PCE; core CPI runs a few tenths above it structurally.
export const CORE_HOT = 3.0;          // y/y core above this is hot
export const CORE_AT_TARGET = 2.5;    // at or below this is within striking distance of target
export const BE_HOT = 2.5;            // a 5Y breakeven above this prices inflation above target
export const BE_COLD = 2.0;           // below this the market prices target or under
export const OIL_LOOKBACK = 20;       // sessions
export const OIL_RISE_PCT = 10;       // a 10% move in a month is an inflation impulse
export const OIL_FALL_PCT = -10;
export const NOWCAST_STALE_DAYS = 5;  // published each business day; a week of silence is a broken feed
export const PRINT_LAG_BIZ_DAYS = 66; // a monthly print stays current until the next lands: July core PCE (dated 07-01, released late August) is the latest until late September

export const INFLATION_VOCAB = Object.freeze({
  tokens: { up: 'HOT', flat: 'BETWEEN', down: 'COOLING', deep: 'COLD' },
  status: { HOT: 'ELEVATED', BETWEEN: 'WATCH', COOLING: 'BENIGN', COLD: 'WATCH', INSUFFICIENT: 'WATCH' },
  all: { up: (n, what) => `All ${n} ${what} read inflation above target and hot`,
         down: (n, what) => `All ${n} ${what} read inflation at or below target`,
         flat: (n, what) => `All ${n} ${what} sit between target and hot — above target, not accelerating` },
  words: { pos: 'hot', neg: 'cool', flat: 'between' },
  noun: 'inflation',
});

const levelScore = (v, hot, cold) => v >= hot ? 1 : v <= cold ? -1 : 0;
const levelWord = (score, hot, cold) => score > 0 ? `above ${bar(hot)}, hot` : score < 0 ? `at or below ${bar(cold)}` : `between ${bar(cold)} and ${bar(hot)}`;
const levelFlip = (name, score, hot, cold) => score > 0 ? `${name} below ${bar(hot)}` : score < 0 ? `${name} back above ${bar(cold)}` : `${name} above ${bar(hot)} or below ${bar(cold)}`;

// ── MARKET LEG: breakevens and oil ───────────────────────────────────────────
function breakevenLeg(raw, key, m, now) {
  if (!raw?.ok) return { key, label: m.label, available: false, reason: raw?.error || 'no print' };
  const v = vintageOf(raw.date, m.lagBizDays, now);
  const value = raw.value == null ? null : +Number(raw.value).toFixed(2);
  if (v.late) return { key, label: m.label, available: false, reason: v.note, date: raw.date, vintage: v, value, unit: m.unit };
  const h = (raw.history || []).filter(o => Number.isFinite(o?.value));
  const twentyAgo = h.length >= 21 ? h[h.length - 21].value : null;
  const trend = twentyAgo == null ? null : +((value - twentyAgo) * 100).toFixed(0);   // bp over 20 sessions
  const score = levelScore(value, BE_HOT, BE_COLD);
  return {
    key, label: m.label, available: true, score, unit: m.unit, value, date: raw.date, vintage: v, trendBp: trend,
    read: `${m.label} ${value.toFixed(2)}%, ${levelWord(score, BE_HOT, BE_COLD)}${trend != null ? `, ${trend >= 0 ? '+' : '−'}${Math.abs(trend)}bp over 20 sessions` : ''}`,
    flip: levelFlip(m.label, score, BE_HOT, BE_COLD),
  };
}
function oilLeg(raw, now) {
  const label = 'Oil, 20-session';
  if (!raw?.ok) return { key: 'oil', label, available: false, reason: raw?.error || 'no series' };
  const series = (raw.series || []).filter(o => o && Number.isFinite(o.value) && o.date);
  const last = series[series.length - 1];
  const v = vintageOf(last?.date, 3, now);
  if (v.late) return { key: 'oil', label, available: false, reason: v.note, date: last?.date, vintage: v, value: last?.value ?? null, unit: '$' };
  if (series.length < OIL_LOOKBACK + 1) return { key: 'oil', label, available: false, reason: `needs ${OIL_LOOKBACK + 1} sessions, have ${series.length}`, date: last.date, vintage: v, value: last.value, unit: '$' };
  const base = series[series.length - 1 - OIL_LOOKBACK];
  const change = pct(last.value, base.value);
  const score = change >= OIL_RISE_PCT ? 1 : change <= OIL_FALL_PCT ? -1 : 0;
  const lvl = f => `$${f.toFixed(0)}`;
  return {
    key: 'oil', label, available: true, score, unit: '$', value: +last.value.toFixed(2), date: last.date, vintage: v, base: +base.value.toFixed(2), baseDate: base.date, change,
    read: `WTI ${lvl(last.value)}, ${sgn(change)}% over ${OIL_LOOKBACK} sessions — ${score > 0 ? 'an inflation impulse' : score < 0 ? 'a disinflation impulse' : 'no impulse'}`,
    flip: score === 0 ? `WTI above ${lvl(base.value * (1 + OIL_RISE_PCT / 100))} (${sgn(OIL_RISE_PCT)}%) or below ${lvl(base.value * (1 + OIL_FALL_PCT / 100))} (${sgn(OIL_FALL_PCT)}%) vs the ${base.date} base`
      : score > 0 ? `WTI back below ${lvl(base.value * (1 + OIL_RISE_PCT / 100))}` : `WTI back above ${lvl(base.value * (1 + OIL_FALL_PCT / 100))}`,
  };
}
export function marketInflation(raw = {}, { now = new Date() } = {}) {
  return compose([
    breakevenLeg(raw.be5, 'be5', INFLATION_SERIES.be5, now),
    breakevenLeg(raw.be10, 'be10', INFLATION_SERIES.be10, now),
    oilLeg(raw.oil, now),
  ], 'market gauges', { be5: raw.be5, be10: raw.be10 }, INFLATION_VOCAB);
}

// ── NOWCAST LEG: the Cleveland Fed ───────────────────────────────────────────
// `raw` is api/indicators.js's `cleveland` block: { ok, period, asOf, coreCpi, corePce, cpi, pce,
// prior: { period, coreCpi, coreCpiActual, … } } — year-over-year, current month.
function nowcastLeg(raw, key, label, now) {
  if (!raw?.ok) return { key, label, available: false, reason: raw?.error || 'nowcast unavailable' };
  const value = raw[key] == null ? null : +Number(raw[key]).toFixed(2);
  if (value == null) return { key, label, available: false, reason: `no ${label} in the nowcast` };
  const t = raw.asOf ? Date.parse(raw.asOf + 'T00:00:00Z') : NaN;
  const days = Number.isFinite(t) ? Math.floor((now.getTime() - t) / 864e5) : null;
  if (days == null) return { key, label, available: false, reason: 'nowcast carries no date' };
  const age = observationAge(raw.asOf, now);
  if (age?.bizDays > NOWCAST_STALE_DAYS) return { key, label, available: false, reason: `nowcast has not updated since ${raw.asOf} (${age.bizDays} business days)`, date: raw.asOf, value, unit: '%' };
  const score = levelScore(value, CORE_HOT, CORE_AT_TARGET);
  const prior = raw.prior || null;
  const err = (prior && prior[key] != null && prior[`${key}Actual`] != null) ? +(prior[`${key}Actual`] - prior[key]).toFixed(2) : null;
  return {
    key, label, available: true, score, unit: '%', value, date: raw.asOf, period: raw.period, vintage: { available: true, late: false, bizDays: age?.bizDays ?? 0 },
    read: `${label} nowcast ${value.toFixed(2)}% y/y for ${raw.period || 'this month'}, ${levelWord(score, CORE_HOT, CORE_AT_TARGET)}${err != null ? `; last month's print came in ${sgn(err)}pp vs its nowcast` : ''}`,
    flip: levelFlip(`the ${label} nowcast`, score, CORE_HOT, CORE_AT_TARGET),
  };
}
export function nowcastInflation(raw = {}, { now = new Date() } = {}) {
  return compose([
    nowcastLeg(raw, 'coreCpi', 'Core CPI', now),
    nowcastLeg(raw, 'corePce', 'Core PCE', now),
  ], 'nowcast legs', {}, INFLATION_VOCAB);
}

// ── PRINTED LEG: what the BLS and BEA have released ──────────────────────────
// `raw` = { coreCpiYoY: {value, date}, corePceYoY: {value, date}, coreCpiIdx: fredLabor block }.
function yoyLeg(raw, key, label, now) {
  if (!raw || raw.value == null) return { key, label, available: false, reason: 'no print' };
  const v = vintageOf(raw.date, PRINT_LAG_BIZ_DAYS, now);
  const value = +Number(raw.value).toFixed(2);
  if (v.late) return { key, label, available: false, reason: v.note, date: raw.date, vintage: v, value, unit: '%' };
  const score = levelScore(value, CORE_HOT, CORE_AT_TARGET);
  return { key, label, available: true, score, unit: '%', value, date: raw.date, vintage: v,
    read: `${label} ${value.toFixed(2)}% y/y (${String(raw.date).slice(0, 7)}), ${levelWord(score, CORE_HOT, CORE_AT_TARGET)}`,
    flip: levelFlip(label, score, CORE_HOT, CORE_AT_TARGET) };
}
function threeMonthLeg(raw, m, now) {
  if (!raw?.ok) return { key: 'coreCpi3m', label: m.label, available: false, reason: raw?.error || 'no print' };
  const v = vintageOf(raw.date, m.lagBizDays, now);
  if (v.late) return { key: 'coreCpi3m', label: m.label, available: false, reason: v.note, date: raw.date, vintage: v, unit: '%' };
  const h = (raw.history || []).filter(o => Number.isFinite(o?.value));
  if (h.length < 4) return { key: 'coreCpi3m', label: m.label, available: false, reason: `needs 4 monthly index prints, have ${h.length}`, date: raw.date, vintage: v, unit: '%' };
  const last = h[h.length - 1].value, base = h[h.length - 4].value;
  const value = +((Math.pow(last / base, 4) - 1) * 100).toFixed(2);   // three-month change, annualised
  const score = levelScore(value, CORE_HOT, CORE_AT_TARGET);
  return { key: 'coreCpi3m', label: m.label, available: true, score, unit: '%', value, date: raw.date, vintage: v,
    read: `Core CPI ${value.toFixed(2)}% annualised over three months to ${String(raw.date).slice(0, 7)}, ${levelWord(score, CORE_HOT, CORE_AT_TARGET)}`,
    flip: levelFlip('the 3-month annualised rate', score, CORE_HOT, CORE_AT_TARGET) };
}
export function printedInflation(raw = {}, { now = new Date() } = {}) {
  return compose([
    yoyLeg(raw.coreCpiYoY, 'coreCpiYoY', 'Core CPI', now),
    yoyLeg(raw.corePceYoY, 'corePceYoY', 'Core PCE', now),
    threeMonthLeg(raw.coreCpiIdx, INFLATION_SERIES.coreCpiIdx, now),
  ], 'printed legs', { coreCpiIdx: raw.coreCpiIdx }, INFLATION_VOCAB);
}

// ── THE LEGS AGAINST EACH OTHER, IN LEAD ORDER ──────────────────────────────
const LEG_NAME = { market: 'the market', nowcast: 'the nowcast', printed: 'the printed data' };
const leanWord = l => l > 0 ? 'hot' : l < 0 ? 'cool' : 'between';
const cap = str => str.charAt(0).toUpperCase() + str.slice(1);
export function inflationAxis({ market, nowcast, printed } = {}) {
  const present = [['market', market], ['nowcast', nowcast], ['printed', printed]]
    .map(([k, p]) => ({ key: k, lean: p?.lean ?? null, label: p?.label || p?.verdict }))
    .filter(x => x.lean != null);
  const names = arr => arr.map(x => LEG_NAME[x.key]).join(' and ');
  if (!present.length) return { state: 'insufficient', lean: null, read: 'No leg has enough usable inputs for an inflation read' };
  if (present.length === 1) {
    const only = present[0];
    return { state: `${only.key}-only`, lean: only.lean, read: `Only ${LEG_NAME[only.key]} reads (${only.label.toLowerCase()}) — the other legs have too few usable inputs` };
  }
  const sumLean = Math.sign(present.reduce((s, x) => s + x.lean, 0));
  if (present.every(x => x.lean === present[0].lean)) {
    const l = present[0].lean;
    return { state: 'confirmed', lean: l, read: l > 0 ? `${cap(names(present))} agree: inflation above target and hot`
      : l < 0 ? `${cap(names(present))} agree: inflation at or below target` : `${cap(names(present))} agree: above target, not accelerating` };
  }
  // A turn is a MONOTONE run along lead order — the faster legs have moved and the slower ones
  // are following: (cool, between, hot) is a turn toward cool as much as (cool, cool, hot) is.
  // Anything that reverses along the way is a split.
  const leans = present.map(x => x.lean);
  const mono = dir => leans.every((l, k) => k === 0 || (dir > 0 ? l <= leans[k - 1] : l >= leans[k - 1]));
  // mono(-1): each lean ≥ the one before it along lead order — the faster legs are LOWER, so the
  // axis is turning cool. mono(1) is the mirror.
  const coolward = mono(-1), hotward = mono(1);
  if ((hotward || coolward) && leans[0] !== leans[leans.length - 1]) {
    const a = leans[0], b = leans[leans.length - 1];
    const leading = present.filter(x => x.lean === a), trailing = present.filter(x => x.lean === b);
    return { state: hotward ? 'turning-hot' : 'turning-cool', lean: sumLean,
             read: `${cap(names(leading))} ${leading.length > 1 ? 'read' : 'reads'} ${leanWord(a)} while ${names(trailing)} still ${trailing.length > 1 ? 'read' : 'reads'} ${leanWord(b)} — the faster series lead; a turn looks like this from inside it` };
  }
  return { state: 'split', lean: sumLean, read: cap(present.map(x => `${LEG_NAME[x.key]} ${x.label.toLowerCase()}`).join(', ')) };
}
export { MIN_LEGS };
