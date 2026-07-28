// gates.js — the two-dimensional regime gate: LEVEL × DIRECTION.
//
// Why: a level-only gate reported "Calm" while HY OAS ran 2.68 → 2.77 → 2.79 across three
// sessions. The level was genuinely calm; the TREND was the signal, and the gate had no way
// to say so. Every regime gate here reports both, and direction is only ever computed from
// stored prior prints (lib/series.trend) — never inferred from one reading.
//
// Thresholds are defaults and tunable per call site.

import { trend } from './series.js';

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
export const OAS_LEVELS = [{ max: 2.9, label: 'CALM' }, { max: 3.3, label: 'WATCH' }, { label: 'STRESS' }];
export const OAS_WORDS  = { rising: 'WIDENING', falling: 'TIGHTENING', flat: 'FLAT' };
export const OAS_ESCALATE = { fromLevel: 'CALM', whenDir: 'rising', minRuns: 3, toLevel: 'WATCH' };

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
  const add = (name, tripped, detail) => items.push({ name, tripped, detail });
  const na  = (name, why) => items.push({ name, tripped: null, detail: why });

  // 1) HY OAS widening
  if (credit?.dir == null) na('OAS widening', 'no prior print');
  else add('OAS widening', credit.dir === 'rising',
           `${credit.level}${credit.word ? ' · ' + credit.word : ''}`);

  // 2) USD/KRW above the flip
  const won = korea?.won;
  if (won?.level == null) na('KRW > flip', 'no print');
  else add('KRW > ' + (won.flip ?? KRW_FLIP), !!won.aboveFlip, `${won.level} (${won.regime})`);

  // 3) VIX rising
  if (vix?.dir == null) na('VIX rising', 'no prior close');
  else add('VIX rising', vix.dir === 'rising', `${vix.price}${vix.changePct != null ? ` (${vix.changePct >= 0 ? '+' : ''}${vix.changePct}% 1D)` : ''}`);

  // 4) NQ making a lower low vs the prior session
  if (!nq || nq.lowerLow == null) na('NQ lower low', 'needs two dated sessions');
  else add('NQ lower low', !!nq.lowerLow, `${nq.dayLow?.toFixed(0)} vs prior ${nq.priorLow?.toFixed(0)}`);

  // 5) Retail no longer absorbing foreign selling. Only meaningful when foreign is a NET
  //    SELLER and we hold a retail print for the same date — otherwise unavailable, not calm.
  const f = kofiaLatest?.foreignNet, r = kofiaLatest?.retailNet;
  if (f?.value == null || r?.value == null) na('Retail not absorbing', 'no retail (개인) print stored');
  else if (f.asOf && r.asOf && f.asOf !== r.asOf) na('Retail not absorbing', `date mismatch (foreign ${f.asOf} vs retail ${r.asOf})`);
  else if (f.value >= 0) add('Retail not absorbing', false, 'foreign is a net buyer — absorption not in question');
  else {
    const absorbing = r.value > 0 && r.value >= Math.abs(f.value) * 0.5;   // retail taking ≥50% of the foreign sell
    add('Retail not absorbing', !absorbing, `foreign ${f.value}, retail ${r.value}`);
  }

  const usable = items.filter(i => i.tripped !== null);
  const tripped = usable.filter(i => i.tripped);
  return {
    items,
    tripped: tripped.length,
    usable: usable.length,
    unavailable: items.filter(i => i.tripped === null).map(i => i.name),
    summary: usable.length === 0
      ? 'no gauges available'
      : `${tripped.length}/${usable.length} gauges leaning de-risking${items.some(i => i.tripped === null) ? ` (${items.filter(i => i.tripped === null).length} unavailable)` : ''}`,
    allLeaning: usable.length >= 3 && tripped.length === usable.length,
  };
}
