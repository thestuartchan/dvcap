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

// The MONTHLY leading leg. Slower than the weekly series but faster than the payroll headline,
// because each of these turns before the labour market as a whole does: the Chicago Fed index is
// an 85-series composite of production, income, employment and sales (its three-month average is
// the one the Chicago Fed itself reads — −0.70 after an expansion is its recession signal); temp
// help is the employment employers shed first and hire first; manufacturing hours are cut before
// heads are. All three are dated the first of the month they describe, and a print stays the
// LATEST until the next one lands: July's Chicago Fed index is released in late August and is
// still current on 24 September, 60 business days after its observation date. So the tolerance
// is the age of the observation when the next release is due, plus slack for a delayed release —
// not the release lag, which is what 2026-09-14 measured against and wrongly excluded July.
export const MONTHLY_SERIES = {
  cfnai:    { id: 'CFNAIMA3',  label: 'Chicago Fed activity (3m avg)', unit: 'idx', expectTitle: 'national activity index', lagBizDays: 66, scale: 1 },
  tempHelp: { id: 'TEMPHELPS', label: 'Temp-help employment',         unit: 'k',   expectTitle: 'temporary help',          lagBizDays: 52, scale: 1 },
  hours:    { id: 'AWHMAN',    label: 'Manufacturing hours',           unit: 'h',   expectTitle: 'average weekly hours',    lagBizDays: 52, scale: 1 },
};
export const CFNAI_ABOVE_TREND = 0;      // the index is built so zero is trend growth
export const CFNAI_RECESSION = -0.70;    // the Chicago Fed's own signal, on the 3-month average
export const TEMP_LOOKBACK_MONTHS = 3;   // temp help and hours are scored on their 3-month change
export const TEMP_RISE_PCT = 1.5;        // ~40k on a 2.7M base
export const TEMP_FALL_PCT = -1.5;
export const HOURS_RISE = 0.3;           // hours per week over three months
export const HOURS_FALL = -0.3;

// ── ISM — THE ONE HAND-KEPT INPUT ON THIS AXIS ──────────────────────────────
// The purchasing managers' index is not on any free feed, and a search summary is not a data
// source. One number a month, keyed on the first business day, is the cheapest manual input in
// the system — and it carries the KOFIA rule: past ISM_STALE_DAYS the entry is EXCLUDED from the
// leg, not footnoted, so a missed month reads as a missing input rather than as last month's
// economy. Expiry is in calendar days from the release date the operator entered.
export const ISM_EXPANSION = 50;       // the survey's own line
export const ISM_STRONG = 52;          // above this the expansion has momentum
export const ISM_STALE_DAYS = 35;      // one release cycle plus a few days


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

export const r1 = v => v == null ? null : +Number(v).toFixed(1);
export const pct = (a, b) => (a == null || b == null || b === 0) ? null : +((a / b - 1) * 100).toFixed(1);
export const fmtK = v => v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)}M` : `${Math.round(v)}k`;
export const sgn = v => v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
export const bar = v => Number(v).toFixed(1);
const sgn2 = v => v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;   // an index near zero: −0.04 is not −0.0   // a threshold prints with one decimal: "below 2.0", never "below 2"

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

export function vintageOf(date, lagBizDays, now) {
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

function cfnaiLeg(raw, m, now) {
  if (!raw?.ok) return { key: 'cfnai', label: m.label, available: false, reason: raw?.error || 'no print' };
  const v = vintageOf(raw.date, m.lagBizDays, now);
  const value = raw.value == null ? null : +Number(raw.value).toFixed(2);
  if (v.late) return { key: 'cfnai', label: m.label, available: false, reason: v.note, date: raw.date, vintage: v, value, unit: m.unit };
  const delta = raw.prev == null ? null : +(value - raw.prev).toFixed(2);
  const score = value >= CFNAI_ABOVE_TREND ? 1 : value <= CFNAI_RECESSION ? -1 : 0;
  const word = score > 0 ? 'above trend' : score < 0 ? 'at the recession signal' : 'below trend';
  return {
    key: 'cfnai', label: m.label, available: true, score, unit: m.unit, value, date: raw.date, vintage: v, delta,
    read: `Chicago Fed index ${sgn2(value)} (3-month average), ${word}${delta != null ? `, ${sgn2(delta)} on the month` : ''}`,
    flip: score > 0 ? `the 3-month average below ${bar(CFNAI_ABOVE_TREND)}` : score < 0 ? `the 3-month average back above ${bar(CFNAI_RECESSION)}`
      : `the 3-month average above ${bar(CFNAI_ABOVE_TREND)} or below ${bar(CFNAI_RECESSION)}`,
  };
}

// Temp help and hours share one shape: the change over TEMP_LOOKBACK_MONTHS, against a bar in the
// series' own unit (percent of level for the count, hours for the hours).
function threeMonthLeg(raw, key, m, now) {
  if (!raw?.ok) return { key, label: m.label, available: false, reason: raw?.error || 'no print' };
  const v = vintageOf(raw.date, m.lagBizDays, now);
  const value = raw.value == null ? null : +Number(raw.value).toFixed(1);
  if (v.late) return { key, label: m.label, available: false, reason: v.note, date: raw.date, vintage: v, value, unit: m.unit };
  const h = (raw.history || []).filter(o => Number.isFinite(o?.value));
  if (h.length < TEMP_LOOKBACK_MONTHS + 1) return { key, label: m.label, available: false, reason: `needs ${TEMP_LOOKBACK_MONTHS + 1} monthly prints, have ${h.length}`,
                                                    date: raw.date, vintage: v, value, unit: m.unit };
  const base = h[h.length - 1 - TEMP_LOOKBACK_MONTHS];
  const isPct = key === 'tempHelp';
  const change = isPct ? pct(value, base.value) : +(value - base.value).toFixed(1);
  const rise = isPct ? TEMP_RISE_PCT : HOURS_RISE, fall = isPct ? TEMP_FALL_PCT : HOURS_FALL;
  const score = change >= rise ? 1 : change <= fall ? -1 : 0;
  const word = score > 0 ? 'building' : score < 0 ? 'being cut' : 'steady';
  const unitWord = isPct ? '%' : 'h';
  const lvl = isPct ? f => fmtK(f) : f => `${f.toFixed(1)}h`;
  const up = isPct ? base.value * (1 + rise / 100) : base.value + rise;
  const dn = isPct ? base.value * (1 + fall / 100) : base.value + fall;
  return {
    key, label: m.label, available: true, score, unit: m.unit, value, date: raw.date, vintage: v, base: base.value, baseDate: base.date, change,
    read: `${m.label} ${isPct ? fmtK(value) : `${value.toFixed(1)}h`}, ${sgn(change)}${unitWord} over ${TEMP_LOOKBACK_MONTHS} months — ${word}`,
    flip: score === 0
      ? `${m.label.toLowerCase()} above ${lvl(up)} (${sgn(rise)}${unitWord}) or below ${lvl(dn)} (${sgn(fall)}${unitWord}) vs ${base.date.slice(0, 7)}`
      : score > 0 ? `${m.label.toLowerCase()} back below ${lvl(up)}`
      : `${m.label.toLowerCase()} back above ${lvl(dn)}`,
  };
}

function ismLeg(entry, now) {
  const label = 'ISM manufacturing';
  const L = entry?.latest;
  if (!L || L.manufacturing == null) return { key: 'ism', label, available: false, reason: 'no ISM entry — hand-keyed monthly from the release', handKept: true };
  const asOf = L.asOf || null;
  const t = asOf ? Date.parse(asOf + 'T00:00:00Z') : NaN;
  const days = Number.isFinite(t) ? Math.floor((now.getTime() - t) / 864e5) : null;
  if (days == null) return { key: 'ism', label, available: false, reason: 'ISM entry has no release date', handKept: true, value: L.manufacturing, unit: 'pmi' };
  if (days > ISM_STALE_DAYS) return { key: 'ism', label, available: false, reason: `ISM entry from ${asOf} is ${days} days old — past the ${ISM_STALE_DAYS}-day cycle`,
                                       handKept: true, date: asOf, value: L.manufacturing, unit: 'pmi', vintage: { available: true, late: true, bizDays: null, days } };
  const pmi = +Number(L.manufacturing).toFixed(1);
  const no = L.newOrders == null ? null : +Number(L.newOrders).toFixed(1);
  const sv = L.services == null ? null : +Number(L.services).toFixed(1);
  let score = pmi >= ISM_STRONG ? 1 : pmi < ISM_EXPANSION ? -1 : 0;
  // New orders is the leading component. A headline still above 50 with new orders below it is
  // an expansion whose next month is already weaker; the leg does not vote FOR growth on it.
  const ordersCap = no != null && no < ISM_EXPANSION && score > 0;
  if (ordersCap) score = 0;
  const word = pmi < ISM_EXPANSION ? 'contracting' : pmi >= ISM_STRONG ? 'expanding with momentum' : 'expanding, barely';
  const prev = (entry.series || []).filter(r => r.period && r.period < (L.period || '')).sort((a, b) => a.period < b.period ? 1 : -1)[0] || null;
  const delta = prev?.manufacturing == null ? null : +(pmi - prev.manufacturing).toFixed(1);
  return {
    key: 'ism', label, available: true, score, unit: 'pmi', value: pmi, date: asOf, period: L.period || null, handKept: true,
    vintage: { available: true, late: false, bizDays: 0, days }, delta, newOrders: no, services: sv,
    read: `ISM manufacturing ${pmi.toFixed(1)}${L.period ? ` (${L.period})` : ''}, ${word}`
      + (no != null ? `; new orders ${no.toFixed(1)}${ordersCap ? ' — the leading component is already below 50, so no vote for growth' : ''}` : '')
      + (sv != null ? `; services ${sv.toFixed(1)}` : ''),
    flip: score > 0 ? `ISM below ${bar(ISM_STRONG)}` : score < 0 ? `ISM back above ${bar(ISM_EXPANSION)}`
      : ordersCap ? `new orders back above ${bar(ISM_EXPANSION)}` : `ISM above ${bar(ISM_STRONG)} or below ${bar(ISM_EXPANSION)}`,
  };
}

export const MARKET_LABEL = Object.freeze({
  EXPANDING: 'PAYING FOR GROWTH', MIXED: 'FLAT', SOFTENING: 'TILTING TO SAFETY', CONTRACTING: 'PAYING FOR SAFETY', INSUFFICIENT: 'INSUFFICIENT',
});
export const VERDICT_STATUS = Object.freeze({
  EXPANDING: 'BENIGN', MIXED: 'WATCH', SOFTENING: 'WATCH', CONTRACTING: 'ELEVATED', INSUFFICIENT: 'WATCH',
});

// The composite, shared by every leg of every axis. `vocab` names the verdicts and the words —
// growth expands and contracts, a market pays for growth or safety, inflation runs hot or cold —
// while the arithmetic (usable legs, the sum of votes, agreement, the nearest exits) is one copy.
// Series names keep their own case — "GDPNow", not "gdpnow" — because a name is not a word.
export const GROWTH_VOCAB = Object.freeze({
  tokens: { up: 'EXPANDING', flat: 'MIXED', down: 'SOFTENING', deep: 'CONTRACTING' },
  status: { EXPANDING: 'BENIGN', MIXED: 'WATCH', SOFTENING: 'WATCH', CONTRACTING: 'ELEVATED', INSUFFICIENT: 'WATCH' },
  all: { up: (n, what) => `All ${n} ${what} point to growth at or above trend`,
         down: (n, what) => `All ${n} ${what} point to weakening growth`,
         flat: (n, what) => `All ${n} ${what} sit inside their bands — growth below trend, not turning` },
  words: { pos: 'firm', neg: 'weakening', flat: 'steady' },
  noun: 'growth',
});
export const MARKET_VOCAB = Object.freeze({
  ...GROWTH_VOCAB,
  all: { up: (n, what) => `All ${n} ${what} are paying for growth`,
         down: (n, what) => `All ${n} ${what} are paying for safety`,
         flat: (n, what) => `All ${n} ${what} sit inside their bands — no growth tilt priced` },
});
export function compose(legs, what, raw, vocab = GROWTH_VOCAB) {
  const usable = legs.filter(l => l.available);
  const excluded = legs.filter(l => !l.available);
  const sum = usable.reduce((s, l) => s + l.score, 0);
  const T = vocab.tokens;
  let verdict;
  if (usable.length < MIN_LEGS) verdict = 'INSUFFICIENT';
  else if (sum > 0) verdict = T.up;
  else if (sum === 0) verdict = T.flat;
  else if (sum <= -2) verdict = T.deep;
  else verdict = T.down;
  const status = vocab.status[verdict];
  const lean = verdict === 'INSUFFICIENT' ? null : Math.sign(sum);
  const signs = new Set(usable.map(l => Math.sign(l.score)));
  const agreement = usable.length >= MIN_LEGS && signs.size === 1 ? 'confirmed' : 'split';
  const positives = usable.filter(l => l.score > 0), negatives = usable.filter(l => l.score < 0), flats = usable.filter(l => l.score === 0);
  const names = arr => arr.map(l => l.label).join(', ');
  const cap = str => str.charAt(0).toUpperCase() + str.slice(1);

  // What the arrangement is consistent with — never what to do.
  let read;
  if (verdict === 'INSUFFICIENT') {
    read = `Only ${usable.length} of ${legs.length} ${what} usable — no ${what.split(' ')[0]} ${vocab.noun} read`;
  } else if (agreement === 'confirmed') {
    read = sum > 0 ? vocab.all.up(usable.length, what) : sum < 0 ? vocab.all.down(usable.length, what) : vocab.all.flat(usable.length, what);
  } else {
    const parts = [];
    if (negatives.length) parts.push(`${names(negatives)} ${vocab.words.neg}`);
    if (positives.length) parts.push(`${names(positives)} ${vocab.words.pos}`);
    if (flats.length) parts.push(`${names(flats)} ${vocab.words.flat}`);
    read = `${cap(what)} split — ${parts.join('; ')}`;
  }
  // The nearest exits. For a confirmed read, the leg whose flip would break the agreement; for a
  // split, every leg's own bar, because any one of them changes the balance.
  const flipsIf = verdict === 'INSUFFICIENT'
    ? (excluded.length ? `Reads once ${names(excluded)} ${excluded.length === 1 ? 'prints' : 'print'}.` : null)
    : `Flips if ${usable.map(l => l.flip).join(', or ')}.`;
  const worst = usable.reduce((w, l) => (l.vintage?.bizDays ?? 0) > (w?.bizDays ?? -1) ? l.vintage : w, null);
  return {
    verdict, label: verdict, status, lean, score: sum, usable: usable.length, of: legs.length, agreement,
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

// The monthly leading leg. `raw` is api/indicators.js's `growthMonthly` block: { cfnai, tempHelp, hours }.
// `ism` is the hand-kept entry from data/manual_entry.json: { latest, series }.
export function monthlyPulse(raw = {}, { now = new Date(), ism = null } = {}) {
  return compose([
    cfnaiLeg(raw.cfnai, MONTHLY_SERIES.cfnai, now),
    threeMonthLeg(raw.tempHelp, 'tempHelp', MONTHLY_SERIES.tempHelp, now),
    threeMonthLeg(raw.hours, 'hours', MONTHLY_SERIES.hours, now),
    ismLeg(ism, now),
  ], 'monthly legs', raw);
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
  const out = compose(legs, 'market ratios', {}, MARKET_VOCAB);
  out.unverified = [];
  out.label = MARKET_LABEL[out.verdict];
  return out;
}

// ── THE LEGS AGAINST EACH OTHER, IN LEAD ORDER ──────────────────────────────
// Market → weekly data → monthly leading series: each leads the next by roughly a month. The
// informative state is not agreement but the faster legs having turned while the slower ones have
// not — that is what a turning point looks like from inside it — so the axis names which legs
// have moved and which are still reading the prior state, rather than reporting a conflict.
const lean = v => v === 'EXPANDING' ? 1 : (v === 'SOFTENING' || v === 'CONTRACTING') ? -1 : v === 'MIXED' ? 0 : null;
const LEG_NAME = { market: 'the market', weekly: 'the weekly data', monthly: 'the monthly leading series' };
const leanWord = l => l > 0 ? 'firm' : l < 0 ? 'weakening' : 'flat';
export function growthAxis({ market, weekly, monthly } = {}) {
  const present = [['market', market], ['weekly', weekly], ['monthly', monthly]]
    .map(([k, p]) => ({ key: k, lean: lean(p?.verdict), verdict: p?.verdict, label: p?.label || p?.verdict }))
    .filter(x => x.lean != null);
  const names = arr => arr.map(x => LEG_NAME[x.key]).join(' and ');
  if (!present.length) return { state: 'insufficient', read: 'No leg has enough usable inputs for a growth read' };
  if (present.length === 1) {
    const only = present[0];
    return { state: only.key === 'market' ? 'market-only' : 'data-only',
             read: `Only ${LEG_NAME[only.key]} reads (${only.label.toLowerCase()}) — the other legs have too few usable inputs` };
  }
  if (present.every(x => x.lean === present[0].lean)) {
    const l = present[0].lean;
    return { state: 'confirmed', read: l > 0 ? `${cap(names(present))} agree: growth at or above trend`
      : l < 0 ? `${cap(names(present))} agree: growth weakening` : `${cap(names(present))} agree: growth below trend, not turning` };
  }
  // A turn is a MONOTONE run along lead order — the faster legs have moved and the slower ones
  // are following: (weak, flat, firm) is a turn down as much as (weak, weak, firm) is. Anything
  // that reverses along the way is a split.
  const leans = present.map(x => x.lean);
  const mono = dir => leans.every((l, k) => k === 0 || (dir > 0 ? l <= leans[k - 1] : l >= leans[k - 1]));
  // mono(-1): each lean ≥ the one before it along lead order — the faster legs are LOWER, so the
  // axis is turning down. mono(1) is the mirror.
  const downward = mono(-1), upward = mono(1);
  if ((downward || upward) && leans[0] !== leans[leans.length - 1]) {
    const a = leans[0], b = leans[leans.length - 1];
    const leading = present.filter(x => x.lean === a), trailing = present.filter(x => x.lean === b);
    const who = leading.length === 1 && leading[0].key === 'market' ? 'the market leads' : 'the faster series lead';
    return { state: downward ? 'turning-down' : 'turning-up',
             read: `${cap(names(leading))} ${leading.length > 1 ? 'are' : 'is'} ${leanWord(a)} while ${names(trailing)} still ${trailing.length > 1 ? 'read' : 'reads'} ${leanWord(b)} — ${who}; a turning point looks like this from inside it` };
  }
  return { state: 'split', read: cap(present.map(x => `${LEG_NAME[x.key]} ${x.label.toLowerCase()}`).join(', ')) };
}
const cap = str => str.charAt(0).toUpperCase() + str.slice(1);
