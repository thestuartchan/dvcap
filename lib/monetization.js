// lib/monetization.js — software vs hardware, the AI monetization gate.
//
// ── WHAT THE BOARD WAS MISSING ───────────────────────────────────────────────
// Two rungs already track the AI capex cycle: SMH − SOXX (equipment against broad semis) and the
// breadth ladder (SMH → QQQ → SPY → IWM → HYG). Both measure SPENDING. Neither measures whether
// the spending is being monetized — and the two diverge at cycle turns, which makes the gap
// between them the earliest available read on peak capex. Money going into infrastructure while
// software revenue does not follow shows up in relative performance long before it shows up in
// earnings.
//
// Observed 2026-09-10: IGV +0.27% against SMH −2.27%, a 2.54pp spread reversing the SMH
// leadership the ladder had shown all week. The board had no way to surface it.
//
// ── WHY TWO SOFTWARE ETFs ────────────────────────────────────────────────────
// IGV IS CONTAMINATED FOR THIS PURPOSE. Its largest holdings include Microsoft and Oracle, two of
// the largest AI infrastructure SPENDERS. Part of IGV is therefore the same capex trade it is
// being measured against, which structurally understates the divergence.
//
// WCLD holds mid-cap pure SaaS with no hyperscalers, so it answers "is software monetizing AI"
// without the answer being partly "Microsoft is building datacentres". It is thinner with wider
// spreads — a signal instrument, not a trading one.
//
// AND THE GAP BETWEEN THEM IS ITSELF AN OUTPUT. A wide IGV − WCLD spread means the megacap
// contamination is doing the work and the apparent software strength is not broad. SKYY and PSJ
// are not substitutes: both are heavily weighted to hyperscalers, which is the same contamination
// and worse.
//
// OBSERVATIONAL. This names what an arrangement is; it never says what to hold. lib/read.js's
// assertion runs over these strings.
export const MONETIZATION_SYMS = Object.freeze({ software: 'IGV', purity: 'WCLD', hardware: 'SMH' });

// The same magnitude discipline as everything else on this board: a spread must clear a fraction
// of its own normal day before it is a reading rather than a tick.
export const SPREAD_GATE = 0.5;    // ×ATR below which the pair is "moving together"
export const PURITY_GATE = 1.0;    // ×ATR beyond which IGV is being held up by its megacaps
export const PURITY_CLEAN = 0.5;   // ×ATR inside which WCLD is genuinely participating
// A state claimed off one session is the failure mode this module would otherwise have: it
// produces a dramatic number on any volatile day, and a board that shouts on one session of
// rotation is worse than no module at all.
export const CONFIRM_SESSIONS = 5;
export const CUM_WINDOWS = Object.freeze([20, 60]);
export const ATR_WINDOW = 60;      // sessions the "normal day for this pair" is measured over

// Number(null) is 0 and Number('') is 0, so a coercion that only checks isFinite reads a MISSING
// print as an unchanged one — which here would render a dark hardware leg as SMH flat and let the
// spread be computed against nothing.
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── THE SPREAD SERIES ────────────────────────────────────────────────────────
// Daily percent change of A minus daily percent change of B, on the dates the two SHARE. An
// unaligned pair silently compares a Tuesday to a Wednesday, which is the failure lib/derived.js
// exists for one layer down.
export function spreadSeries(barsA = [], barsB = []) {
  const closeOf = (bars) => {
    const m = new Map();
    for (const b of (Array.isArray(bars) ? bars : [])) {
      const c = num(b?.close), d = b?.date;
      if (c != null && c > 0 && d) m.set(d, c);
    }
    return m;
  };
  const A = closeOf(barsA), B = closeOf(barsB);
  const dates = [...A.keys()].filter(d => B.has(d)).sort();
  const out = [];
  for (let i = 1; i < dates.length; i++) {
    const d = dates[i], p = dates[i - 1];
    const a = ((A.get(d) - A.get(p)) / A.get(p)) * 100;
    const b = ((B.get(d) - B.get(p)) / B.get(p)) * 100;
    out.push({ date: d, a: +a.toFixed(3), b: +b.toFixed(3), spread: +(a - b).toFixed(3) });
  }
  return out;
}

// ── THE SCALE, AND WHAT IT ACTUALLY IS ───────────────────────────────────────
// Wilder's ATR on a bar whose high, low and close are equal reduces to the mean absolute change.
// The spread here is ALREADY a change — a daily percent difference, measured from zero — so its
// true-range analogue is its own absolute value, and the ATR reduces to the mean absolute daily
// spread. Running closeOnlyAtr over it instead would measure how much the SPREAD moves day to
// day, which makes a persistently wide gap look small and is the wrong question.
export function spreadAtrPp(series = [], window = ATR_WINDOW) {
  const vals = series.slice(-window).map(r => Math.abs(num(r?.spread))).filter(v => v != null);
  if (vals.length < 10) return null;
  return +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3);
}

export function cumSpread(series = [], n) {
  const w = series.slice(-n);
  if (w.length < Math.min(n, 5)) return null;
  return +w.reduce((a, r) => a + (num(r?.spread) ?? 0), 0).toFixed(2);
}

// How many sessions, ending with the most recent, the spread has held its sign. The trend question
// the 1d number cannot answer.
export function runLength(series = []) {
  if (!series.length) return 0;
  const last = num(series[series.length - 1]?.spread);
  if (last == null || last === 0) return 0;
  const sign = Math.sign(last);
  let n = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    const v = num(series[i]?.spread);
    if (v == null || Math.sign(v) !== sign || v === 0) break;
    n++;
  }
  return n;
}

export const STATES = Object.freeze({
  RUNNING:   'CAPEX CYCLE RUNNING',
  UNMONETIZED: 'CAPEX WITHOUT MONETIZATION',
  ROTATION:  'ROTATION TO SOFTWARE',
  TOGETHER:  'MOVING TOGETHER',
});

// ── THE STATE ────────────────────────────────────────────────────────────────
// `soft`, `hard` and `pure` are today's percent changes; the series carry the history the trend
// and the scale come from.
export function monetizationGate({ soft = null, hard = null, pure = null,
                                   softHard = [], softPure = [],
                                   thirtyRising = null, thirtySource = null } = {}) {
  const s = num(soft), h = num(hard), p = num(pure);
  if (s == null || h == null) {
    return { available: false, note: `software vs hardware unavailable — need both ${MONETIZATION_SYMS.software} and ${MONETIZATION_SYMS.hardware} prints` };
  }
  const spread = +(s - h).toFixed(2);
  const atr = spreadAtrPp(softHard);
  const atrMult = atr > 0 ? +(Math.abs(spread) / atr).toFixed(1) : null;

  // ── PURITY ────────────────────────────────────────────────────────────────
  // IGV − WCLD. Wide means the megacaps are carrying IGV and the software strength is not broad.
  const gap = p == null ? null : +(s - p).toFixed(2);
  const gapAtr = spreadAtrPp(softPure);
  const gapMult = (gap != null && gapAtr > 0) ? +(Math.abs(gap) / gapAtr).toFixed(1) : null;
  const purity = gap == null || gapMult == null
    ? { state: 'unknown', gap, gapMult, note: `no ${MONETIZATION_SYMS.purity} print — purity cannot be checked, so a software lead cannot be told from a megacap one` }
    : gapMult >= PURITY_GATE && gap > 0
      ? { state: 'CONTAMINATED', gap, gapMult,
          note: `${MONETIZATION_SYMS.software} is ahead of ${MONETIZATION_SYMS.purity} by ${Math.abs(gap).toFixed(2)}pp (${gapMult}×) — the megacap holdings are carrying it and the software strength is not broad` }
      : gapMult <= PURITY_CLEAN
        ? { state: 'OK', gap, gapMult, note: `${MONETIZATION_SYMS.purity} is participating — the move is broad software, not megacap` }
        // The MAGNITUDE, not the signed gap: "ahead by −0.54pp" is what the signed value reads as
        // once the direction is already in the sentence.
        : { state: 'WATCH', gap, gapMult, note: `${MONETIZATION_SYMS.purity} is ${gap > 0 ? 'lagging' : 'ahead'} by ${Math.abs(gap).toFixed(2)}pp (${gapMult}×) — between broad and megacap-only` };

  // ── THE CANDIDATE LABEL ───────────────────────────────────────────────────
  let candidate, why;
  if (atr == null) {
    candidate = STATES.TOGETHER;
    why = 'no history for this pair, so the spread has no scale — a gap cannot be called large or small without one';
  } else if (Math.abs(spread) < SPREAD_GATE * atr) {
    candidate = STATES.TOGETHER;
    why = `${Math.abs(spread)}pp is inside ${SPREAD_GATE}×ATR (${(SPREAD_GATE * atr).toFixed(2)}pp) — an ordinary day for this pair`;
  } else if (spread < 0) {
    // Hardware leading.
    if (s < 0) { candidate = STATES.UNMONETIZED; why = `${MONETIZATION_SYMS.hardware} is leading and ${MONETIZATION_SYMS.software} is falling — infrastructure spend is not appearing in software`; }
    else { candidate = STATES.RUNNING; why = 'both are up and hardware is leading — spending is the trade'; }
  } else {
    // Software leading — and this is the case the module exists to disambiguate.
    if (purity.state === 'CONTAMINATED') {
      candidate = STATES.UNMONETIZED;
      why = `${MONETIZATION_SYMS.software} is ahead of ${MONETIZATION_SYMS.hardware}, but ${purity.note} — this is the unmonetized state wearing a rotation label`;
    } else {
      candidate = STATES.ROTATION;
      why = purity.state === 'OK'
        ? `${MONETIZATION_SYMS.software} is leading and ${MONETIZATION_SYMS.purity} is with it — either the theme maturing into monetization, or hardware de-rating on peak-spend fear`
        : `${MONETIZATION_SYMS.software} is leading; ${purity.note}`;
    }
  }

  // ── NOTHING IS LABELLED OFF ONE SESSION ───────────────────────────────────
  const run = runLength(softHard);
  const confirmed = candidate === STATES.TOGETHER || run >= CONFIRM_SESSIONS;
  const cum = Object.fromEntries(CUM_WINDOWS.map(n => [n, cumSpread(softHard, n)]));

  // ── THE RATES CONFOUND, TESTED RATHER THAN ASSUMED ────────────────────────
  // Software is longer duration than semis — a higher multiple on more distant cash flows — so on
  // a hawkish day it should UNDERPERFORM. When it outperforms into rising yields the rates
  // explanation is ruled out and the reading is cleaner. This is the only place the module gets
  // MORE confident, and it needs both halves to be true.
  const ratesRuledOut = (spread > 0 && thirtyRising === true) ? true
    : (spread > 0 && thirtyRising === false) ? false : null;

  return {
    available: true,
    softSym: MONETIZATION_SYMS.software, hardSym: MONETIZATION_SYMS.hardware, pureSym: MONETIZATION_SYMS.purity,
    soft: +s.toFixed(2), hard: +h.toFixed(2), pure: p == null ? null : +p.toFixed(2),
    spread, atr, atrMult,
    cum20: cum[20], cum60: cum[60],
    purity,
    state: confirmed ? candidate : `${candidate} (pending)`,
    candidate, confirmed, run, confirmSessions: CONFIRM_SESSIONS,
    why,
    pending: confirmed ? null
      : `${run} session${run === 1 ? '' : 's'} in this direction — ${CONFIRM_SESSIONS} are needed before the label is claimed`,
    ratesRuledOut, thirtyRising, thirtySource,
    ratesNote: ratesRuledOut === true
      ? 'software is outperforming into a rising 30-year — software is the longer-duration leg, so rising yields do not explain this and the read is cleaner'
      : ratesRuledOut === false
        ? 'the 30-year is not rising, so a duration explanation for the software lead is not ruled out'
        : null,
    tone: candidate === STATES.UNMONETIZED ? 'amber'
      : candidate === STATES.ROTATION ? (confirmed ? 'green' : 'muted')
      : candidate === STATES.RUNNING ? 'muted' : 'muted',
    // The chain the board now reads end to end: equipment → semis → software.
    chainNote: 'reads with SMH − SOXX above it: equipment → semis → software is the capex-to-monetization sequence, and movement down it is the cycle maturing',
  };
}
