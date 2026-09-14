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
    flip: score > 0 ? `WEI below ${WEI_STRONG}` : score < 0 ? `WEI back above ${WEI_CONTRACT}` : `WEI above ${WEI_STRONG} or below ${WEI_CONTRACT}`,
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
    flip: score > 0 ? `GDPNow below ${GDPNOW_STRONG}` : score < 0 ? `GDPNow back above ${GDPNOW_WEAK}` : `GDPNow above ${GDPNOW_STRONG} or below ${GDPNOW_WEAK}`,
  };
}

export const VERDICT_STATUS = Object.freeze({
  EXPANDING: 'BENIGN', MIXED: 'WATCH', SOFTENING: 'WATCH', CONTRACTING: 'ELEVATED', INSUFFICIENT: 'WATCH',
});

// The composite. `raw` is api/indicators.js's `growth` block: { claims, continuing, wei, gdpNow }.
export function growthPulse(raw = {}, { now = new Date() } = {}) {
  const legs = [
    claimsLeg(raw.claims, 'claims', GROWTH_SERIES.claims, now),
    claimsLeg(raw.continuing, 'continuing', GROWTH_SERIES.continuing, now),
    weiLeg(raw.wei, GROWTH_SERIES.wei, now),
    gdpNowLeg(raw.gdpNow, GROWTH_SERIES.gdpNow, now),
  ];
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
  const names = arr => arr.map(l => l.label.toLowerCase()).join(', ');

  // What the arrangement is consistent with — never what to do.
  let read;
  if (verdict === 'INSUFFICIENT') {
    read = `Only ${usable.length} of ${legs.length} weekly legs usable — no weekly growth read`;
  } else if (agreement === 'confirmed') {
    read = sum > 0 ? `All ${usable.length} weekly legs point to growth at or above trend`
      : sum < 0 ? `All ${usable.length} weekly legs point to weakening growth`
      : `All ${usable.length} weekly legs sit inside their bands — growth below trend, not turning`;
  } else {
    const parts = [];
    if (negatives.length) parts.push(`${names(negatives)} weakening`);
    if (positives.length) parts.push(`${names(positives)} firm`);
    if (flats.length) parts.push(`${names(flats)} steady`);
    read = `Weekly legs split — ${parts.join('; ')}`;
  }
  // The nearest exits. For a confirmed read, the leg whose flip would break the agreement; for a
  // split, every leg's own bar, because any one of them changes the balance.
  const flipsIf = verdict === 'INSUFFICIENT'
    ? (excluded.length ? `Reads once ${names(excluded)} ${excluded.length === 1 ? 'prints' : 'print'}.` : null)
    : `Flips if ${usable.map(l => l.flip).join(', or ')}.`;
  const worst = usable.reduce((w, l) => (l.vintage?.bizDays ?? 0) > (w?.bizDays ?? -1) ? l.vintage : w, null);
  return {
    verdict, status, score: sum, usable: usable.length, of: legs.length, agreement,
    legs, excluded: excluded.map(l => ({ key: l.key, label: l.label, reason: l.reason })),
    read, flipsIf,
    vintage: worst ? { bizDays: worst.bizDays, late: false } : null,
    unverified: Object.entries(raw).filter(([, v]) => v && v.ok && v.verified === false).map(([k, v]) => ({ key: k, mismatch: v.mismatch })),
  };
}
