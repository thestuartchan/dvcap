// gates.js — the two-dimensional regime gate: LEVEL × DIRECTION.
//
// Why: a level-only gate reported "Calm" while HY OAS ran 2.68 → 2.77 → 2.79 across three
// sessions. The level was genuinely calm; the TREND was the signal, and the gate had no way
// to say so. Every regime gate here reports both, and direction is only ever computed from
// stored prior prints (lib/series.trend) — never inferred from one reading.
//
// Thresholds are defaults and tunable per call site.

import { trend } from './series.js';
import { kofiaStale } from './kofia.js';

// Classify a value into a named band. `levels` is ordered ascending:
//   [{ max: 2.9, label: 'CALM' }, { max: 3.3, label: 'WATCH' }, { label: 'STRESS' }]
export function levelOf(value, levels) {
  if (value == null) return null;
  for (const l of levels) {
    if (l.max == null || value < l.max) return l.label;
  }
  return levels[levels.length - 1]?.label ?? null;
}

// Build a 2-D gate from a value + its dated prior series.
//   words: direction vocabulary, e.g. { rising:'WIDENING', falling:'TIGHTENING', flat:'FLAT' }
//   escalate: optional { fromLevel, whenDir, minRuns, toLevel } — e.g. Calm + Widening for 3+
//             consecutive sessions elevates to WATCH regardless of the absolute level.
// Returns { level, dir, word, compound, d1, d5, runs, escalated, effective, note }.
// `effective` is the level AFTER escalation — that is what downstream logic should read.
export function twoDimGate({ value, series, levels, words, escalate = null, digits = 2, flatEps = 0 }) {
  const level = levelOf(value, levels);
  const d1 = trend(series, { lookbackDays: 1, flatEps });
  const d5 = trend(series, { lookbackDays: 5, flatEps });

  // No stored prior → NO direction word. State the level only, and say why.
  if (!d1) {
    return { level, dir: null, word: null, compound: level, d1: null, d5: null,
             runs: 0, escalated: false, effective: level, note: 'no prior print — direction unavailable' };
  }

  const word = words[d1.dir] ?? null;
  const runs = consecutiveRuns(series, d1.dir);

  let effective = level, escalated = false;
  if (escalate && level === escalate.fromLevel && d1.dir === escalate.whenDir && runs >= escalate.minRuns) {
    effective = escalate.toLevel;
    escalated = true;
  }

  const fmt = t => t ? `${t.delta >= 0 ? '+' : '−'}${Math.abs(t.delta).toFixed(digits)} ${t.basis}` : null;
  const deltas = [fmt(d1), fmt(d5)].filter(Boolean).join(', ');
  const compound = `${level}${word ? ` · ${word}` : ''}${deltas ? ` (${deltas})` : ''}`;

  return {
    level, dir: d1.dir, word, compound, d1, d5, runs, escalated, effective,
    note: escalated ? `${runs} consecutive sessions ${word?.toLowerCase()} — elevated to ${effective}` : null,
  };
}

// How many consecutive most-recent steps moved in `dir`. Counts real print-to-print steps,
// so "3 consecutive sessions widening" means three actual prints, not three fetches.
export function consecutiveRuns(series, dir) {
  const s = (series || []).filter(r => r && r.value != null)
    .slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (s.length < 2 || !dir || dir === 'flat') return 0;
  let runs = 0;
  for (let i = s.length - 1; i > 0; i--) {
    const step = s[i].value - s[i - 1].value;
    const stepDir = step > 0 ? 'rising' : step < 0 ? 'falling' : 'flat';
    if (stepDir !== dir) break;
    runs++;
  }
  return runs;
}

// ── Default calibrations (tunable) ───────────────────────────────────────────
// HY OAS: Calm <2.9 · Watch 2.9–3.3 · Stress >3.3.
// P2.2 — coarse regime context, deliberately unexcited. Rebased per the spec amendment:
// 2.90 was previously the CALM/WATCH boundary, which styled it as a tripwire the market was
// "approaching". It is not one. The series oscillated 2.81 → 2.87 → 2.84 inside a single week;
// full history runs from ~2.41 (Jun 2007) to 21.82 (Dec 2008). A 6bp range at historically
// tight levels is noise, and the LEVEL band must not imply otherwise — at these levels the
// signal lives in the trend (P2.2 trend block), not the band.
export const OAS_LEVELS = [
  { max: 3.0, label: 'CALM' },
  { max: 4.5, label: 'WATCHFUL' },
  { max: 8.0, label: 'STRESSED' },
  { label: 'RECESSIONARY' },
];
// Static historical constants for annotation ONLY. These are NOT series data — FRED restricts
// ICE BofA series to a rolling 3-year window (April 2026), so they cannot be derived from what
// we fetch and must never be presented as if they were.
export const OAS_HISTORICAL = Object.freeze({
  recordTight: { value: 2.41, when: 'Jun 2007', note: 'static constant — outside the 3Y window' },
  gfcPeak:     { value: 21.82, when: 'Dec 2008', note: 'static constant — outside the 3Y window' },
});
// Plain marker, not a gate. Rendered as a neutral reference line with no directional framing.
export const OAS_MARKER = 2.90;

// P2.1 — publication lag is TWO days and VARIABLE (it stretches across weekends and holidays).
// Never compute the observation date as today−n; read what FRED returns and age it.
export const OAS_AWAITING_DAYS = 4;      // calendar days before we stop showing a number at all
export function observationAge(obsDate, now = new Date()) {
  if (!obsDate) return { available: false, chip: 'red', note: 'no observation date' };
  const d = new Date(obsDate + 'T00:00:00Z');
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const calendarDays = Math.max(0, Math.round((end - d) / 864e5));
  let bizDays = 0;
  for (const cur = new Date(d); cur < end; ) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const wd = cur.getUTCDay();
    if (wd !== 0 && wd !== 6) bizDays++;
  }
  const awaiting = calendarDays > OAS_AWAITING_DAYS;
  const chip = bizDays <= 1 ? 'neutral' : bizDays === 2 ? 'amber' : 'red';
  return {
    available: true, obsDate, calendarDays, bizDays, awaiting, chip,
    label: `obs ${obsDate} · ${calendarDays}d old`,
  };
}
export const OAS_WORDS  = { rising: 'WIDENING', falling: 'TIGHTENING', flat: 'FLAT' };
// Escalation target must be a label that EXISTS in OAS_LEVELS — after the rebase the band is
// WATCHFUL, not WATCH. (Kept because it encodes the amendment's own thesis: at tight levels
// the trend carries the signal. It escalates on a real multi-session trend, not on the level
// nearing 2.90 — which is explicitly not a gate.)
export const OAS_ESCALATE = { fromLevel: 'CALM', whenDir: 'rising', minRuns: 3, toLevel: 'WATCHFUL' };

// VKOSPI: calibrated to THIS instrument's own 2017–2025 range (~15–25), not generic vol-index
// levels. <25 normal · 25–35 elevated · 35–50 high · 50+ extreme.
export const VKOSPI_LEVELS = [{ max: 25, label: 'NORMAL' }, { max: 35, label: 'ELEVATED' },
                              { max: 50, label: 'HIGH' }, { label: 'EXTREME' }];
export const VKOSPI_WORDS = { rising: 'RISING', falling: 'ROLLING', flat: 'FLAT' };

// USD/KRW: 1,491 is the mechanical-vs-flight flip.
export const KRW_FLIP = 1491;

// ── "Gauges leaning" (Stage 3B) ──────────────────────────────────────────────
// Counts how many independent regime tripwires point the SAME way, so "they all turned
// together" is visible at a glance. A gauge with no usable input is reported as UNAVAILABLE
// and excluded from both the numerator and the denominator — never silently counted as calm,
// which would understate the lean.
export function gaugesLeaning({ credit, korea, vix, nq, kofiaLatest } = {}) {
  const items = [];
  // B3 — every gauge carries the scenario it points at, so the count reads "2 pointing at Korea
  // mechanical, 1 at hawkish" rather than an undifferentiated N/5.
  const add = (name, tripped, detail, scenario) => items.push({ name, tripped, detail, scenario });
  const na  = (name, why, scenario) => items.push({ name, tripped: null, detail: why, scenario });

  // 1) HY OAS widening — LEVEL × DIRECTION, both required (P1).
  //    A single 1d wiggle was firing this on days the underlying trend was flat or tightening,
  //    and it fired at historically tight levels where a few-bp move is noise. Now it fires only
  //    when (a) the 5-DAY trend is rising — a sustained widening, not a one-print flicker — AND
  //    (b) OAS has cleared the CALM band (≥ 3.0). Below 3.0 a rising 5d run is still just noise.
  if (credit?.dir == null) na('OAS widening', 'no prior print', 'Hawkish / Disorderly');
  else {
    const oas = credit.d1?.to;                     // current OAS level (d1 exists once dir != null)
    const rising5d = credit.d5?.dir === 'rising';  // sustained over 5d, not a 1d wiggle
    const aboveFloor = oas != null && oas >= 3.0;  // must be out of the CALM band to count
    const d5note = credit.d5 ? ` (${credit.d5.delta >= 0 ? '+' : '−'}${Math.abs(credit.d5.delta).toFixed(2)} 5d)` : ' (no 5d prior)';
    add('OAS widening', rising5d && aboveFloor, `${credit.level}${credit.word ? ' · ' + credit.word : ''}${d5note}`, 'Hawkish / Disorderly');
  }

  // 2) USD/KRW above the flip
  const won = korea?.won;
  if (won?.level == null) na('KRW > flip', 'no print', 'Korea flight');
  else add('KRW > ' + (won.flip ?? KRW_FLIP), !!won.aboveFlip, `${won.level} (${won.regime})`, 'Korea flight');

  // 3) VIX rising — with a level floor (P1). A rising VIX only counts as de-risking once VIX is
  //    itself elevated (≥ 20). Below that, a green-to-slightly-less-green 1d tick is not a risk
  //    signal, and it was pushing the gauge up on quiet days (VIX 15.84 fired the old direction-only
  //    test).
  if (vix?.dir == null) na('VIX rising', 'no prior close', 'Vol / Disorderly');
  else add('VIX rising', vix.dir === 'rising' && vix.price != null && vix.price >= 20,
           `${vix.price}${vix.changePct != null ? ` (${vix.changePct >= 0 ? '+' : ''}${vix.changePct}% 1D)` : ''}`, 'Vol / Disorderly');

  // 4) NQ making a lower low vs the prior session
  if (!nq || nq.lowerLow == null) na('NQ lower low', 'needs two dated sessions', 'US risk-off');
  else add('NQ lower low', !!nq.lowerLow, `${nq.dayLow?.toFixed(0)} vs prior ${nq.priorLow?.toFixed(0)}`, 'US risk-off');

  // 5) Retail no longer absorbing foreign selling. Only meaningful when foreign is a NET
  //    SELLER and we hold a retail print for the same date — otherwise unavailable, not calm.
  const f = kofiaLatest?.foreignNet, r = kofiaLatest?.retailNet;
  if (f?.value == null || r?.value == null) na('Retail not absorbing', 'no retail (개인) print stored', 'Korea mechanical');
  else if (kofiaStale(f.asOf) || kofiaStale(r.asOf)) na('Retail not absorbing', `stale flows (foreign ${f.asOf}, retail ${r.asOf})`, 'Korea mechanical');   // P4 — stale manual print can't fire a live tripwire
  else if (f.asOf && r.asOf && f.asOf !== r.asOf) na('Retail not absorbing', `date mismatch (foreign ${f.asOf} vs retail ${r.asOf})`, 'Korea mechanical');
  else if (f.value >= 0) add('Retail not absorbing', false, 'foreign is a net buyer — absorption not in question', 'Korea mechanical');
  else {
    const absorbing = r.value > 0 && r.value >= Math.abs(f.value) * 0.5;   // retail taking ≥50% of the foreign sell
    add('Retail not absorbing', !absorbing, `foreign ${f.value}, retail ${r.value}`, 'Korea mechanical');
  }

  const usable = items.filter(i => i.tripped !== null);
  const tripped = usable.filter(i => i.tripped);
  // B3 — group the FIRED gauges by the scenario they point at, so the count is directional.
  const byScenario = [];
  for (const i of tripped) {
    const key = i.scenario || 'Other';
    const hit = byScenario.find(x => x.scenario === key);
    if (hit) { hit.count++; hit.gauges.push(i.name); } else byScenario.push({ scenario: key, count: 1, gauges: [i.name] });
  }
  byScenario.sort((a, b) => b.count - a.count);
  return {
    items,
    tripped: tripped.length,
    usable: usable.length,
    unavailable: items.filter(i => i.tripped === null).map(i => i.name),
    byScenario,   // [{ scenario, count, gauges }] — directional breakdown of the fired gauges
    pointing: byScenario.map(s => `${s.count} at ${s.scenario}`).join(', '),
    summary: usable.length === 0
      ? 'no gauges available'
      : `${tripped.length}/${usable.length} gauges leaning de-risking${items.some(i => i.tripped === null) ? ` (${items.filter(i => i.tripped === null).length} unavailable)` : ''}`,
    allLeaning: usable.length >= 3 && tripped.length === usable.length,
  };
}

// ── CSOP 7709 units-outstanding tripwire (P2, standalone) ─────────────────────
// The China-tech deleveraging tell, kept OUT of the gaugesLeaning cluster on purpose: it is a
// single, position-specific signal (a leveraged China-tech ETF SHEDDING units means creations
// are reversing and holders are exiting the trade, which leads the name), not one of the broad
// macro/US de-risking gauges. Folding it in would inflate that cluster's denominator with an
// unrelated instrument. Fires on a >3% one-day unit drop OR two consecutive down days, and only
// on a FRESH print — a stale unit count is a stale signal, so it reads UNAVAILABLE rather than
// re-firing yesterday's move as today's. `units7709` = { value, delta, asOf }; `series` =
// the dated unit-count history (for the consecutive-down-days test).
export function csop7709Tripwire({ units7709, series } = {}) {
  const u = units7709;
  if (!u || u.value == null || u.delta == null) {
    return { available: false, tripped: null, note: 'no unit print stored' };
  }
  if (u.asOf && kofiaStale(u.asOf)) {
    return { available: false, tripped: null, stale: true, asOf: u.asOf, note: `stale print (${u.asOf}) — signal withheld` };
  }
  const prev = u.value - u.delta;                                  // reconstruct the prior level
  const dayPct = prev > 0 ? +((u.delta / prev) * 100).toFixed(1) : null;
  const bigDrop = dayPct != null && dayPct <= -3;                  // >3% shed in a day
  const twoDown = consecutiveRuns(series, 'falling') >= 2;         // or two consecutive down days
  const tripped = bigDrop || twoDown;
  return {
    available: true,
    tripped,
    asOf: u.asOf ?? null,
    level: +(u.value / 1e6).toFixed(1),                           // millions of units
    dayPct,
    reason: bigDrop ? 'one-day unit drop >3%' : twoDown ? 'two consecutive down days' : null,
    detail: `${(u.value / 1e6).toFixed(1)}M units${dayPct != null ? ` (${dayPct >= 0 ? '+' : ''}${dayPct}% 1d)` : ''}${twoDown && !bigDrop ? ' · 2 consecutive down days' : ''}`,
  };
}
