// labor.js — the unemployment interpretation layer.
//
// Why this exists: U3 alone scored June 2026 GREEN. The rate fell from 4.3% to 4.2%, which
// looks like improvement — but it fell because people LEFT the labour force, not because
// anyone was hired. Emp-pop fell 0.2pp over the same month. A gauge that can print "improving"
// on that is worse than no gauge.
//
// The control is the employment–population ratio: employed ÷ working-age population. It cannot
// be gamed by labour-force exit, because leaving the labour force doesn't shrink the
// denominator. That is why it, not U3, decides the verdict.
//
// Rendered in BOTH the Macro and Indicators tabs — the logic lives here once.

// Series contract. `expectTitle` is asserted against FRED's own metadata at fetch time so a
// repurposed or mistyped ID fails LOUDLY instead of silently rendering the wrong series.
export const LABOR_SERIES = {
  u3:          { id: 'UNRATE',       label: 'Unemployment rate (U3)',    unit: '%',  expectTitle: 'unemployment rate' },
  participation:{ id: 'CIVPART',     label: 'Labor force participation', unit: '%',  expectTitle: 'labor force participation rate' },
  primeAge:    { id: 'LNS11300060',  label: 'Prime-age participation (25–54)', unit: '%', expectTitle: 'labor force participation rate' },
  empPop:      { id: 'EMRATIO',      label: 'Employment–population ratio', unit: '%', expectTitle: 'employment-population ratio' },
  u6:          { id: 'U6RATE',       label: 'U-6 underemployment',       unit: '%',  expectTitle: 'total unemployed' },
  longTerm:    { id: 'LNS13025703',  label: 'Long-term unemployed share', unit: '%', expectTitle: '27 weeks' },
  // The COUNT behind the share. The share can dip month-to-month while the count still grows
  // year-over-year (June 2026 did exactly that), so the two answer different questions and
  // both are needed. Seasonally adjusted, to match every other series here.
  longTermCount:{ id: 'UEMP27OV',    label: 'Long-term unemployed (27wk+)', unit: 'k', expectTitle: '27 weeks' },
  payrolls:    { id: 'PAYEMS',       label: 'Nonfarm payrolls',          unit: 'k',  expectTitle: 'all employees' },
  household:   { id: 'CE16OV',       label: 'Household survey employment', unit: 'k', expectTitle: 'employment level' },
  // F1 — the quits rate. Every other series here measures whether people HAVE work; this one
  // measures whether they are confident enough to leave it. It comes from JOLTS (establishment
  // side) and so moves independently of the participation/emp-pop mechanics computed off the
  // household survey — which is exactly why it earns a slot: it can disagree with them, and
  // that disagreement is information the other series structurally cannot produce.
  quits:       { id: 'JTSQUR',       label: 'Quits rate',                unit: '%',  expectTitle: 'quits' },
};

// Tunables.
export const LONG_TERM_ELEVATED = 25;      // % of unemployed out 27+ weeks
export const SURVEY_DIVERGENCE_K = 250;    // payroll vs household gap (thousands) that flags
export const FLAT_EPS = 0.049;             // pp move below this is "flat" (one decimal series)

const dir = (d, eps = FLAT_EPS) => d == null ? null : d > eps ? 'up' : d < -eps ? 'down' : 'flat';
const pp = (d, digits = 1) => d == null ? '—' : `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(digits)}pp`;
const k = v => v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('en-US')}k`;

// ── P1.2 — the 2×2. Never score U3 in isolation. ─────────────────────────────
// Emp-pop is the control: it cannot be gamed by labour-force exit.
// R2 (Amendment 3) — a HARD OVERRIDE sits above the 2×2: if nonfarm payrolls are negative for
// the month, the verdict is RED regardless of what the 2×2 returns. A contracting payroll count
// is the establishment survey showing outright job losses; it is not a "watch" condition, and
// the 2×2's AMBER (correct for a U3-down / emp-pop-down month like June) understates it.
export function laborVerdict(u3Delta, empPopDelta, payrollsK = null) {
  const u = dir(u3Delta), e = dir(empPopDelta);
  // The 2×2 read first — may be UNKNOWN when a direction is missing. 'flat' resolves toward the
  // non-improving side: a flat emp-pop does not corroborate a falling U3, so it cannot earn GREEN.
  let base, baseRead;
  if (u == null || e == null) {
    base = 'UNKNOWN';
    baseRead = `cannot score the 2×2 — ${u == null ? 'U3' : 'emp-pop'} direction unavailable`;
  } else {
    const uDown = u === 'down', eUp = e === 'up';
    if (uDown && eUp)       { base = 'GREEN';   baseRead = 'Rate fell because more people are working. Genuine improvement.'; }
    else if (uDown && !eUp) { base = 'AMBER';   baseRead = 'Rate fell for the wrong reason — the share of the population employed also fell. Exit-driven, not hiring-driven.'; }
    else if (!uDown && eUp) { base = 'NEUTRAL'; baseRead = 'Rate rose because people re-entered the labour force to look for work. Normal in a recovering market.'; }
    else                    { base = 'RED';     baseRead = 'Genuine deterioration. Fewer people working and more looking.'; }
  }
  // R2 — the HARD OVERRIDE, above the 2×2 and applied even when the 2×2 is unscorable
  // ("regardless of what the 2×2 returns"). Records `from` so the card can explain that the RED
  // came from the payroll count, not the 2×2 — the establishment survey saw the job losses the
  // household survey's falling rate hid.
  if (payrollsK != null && payrollsK < 0 && base !== 'RED') {
    return {
      verdict: 'RED', color: 'red', u3: u, empPop: e, override: { from: base, reason: 'negative payrolls' },
      read: `Payrolls contracted outright (${k(payrollsK)}) — the establishment survey shows net job losses. The 2×2 read ${base}${base === 'UNKNOWN' ? ' (unscorable)' : ' because the unemployment rate fell on labour-force exit, not hiring'}. A shrinking payroll count is not a watch condition.`,
    };
  }
  const color = { GREEN: 'green', AMBER: 'amber', NEUTRAL: 'muted', RED: 'red' }[base] || 'muted';
  return { verdict: base, color, read: baseRead, u3: u, empPop: e, override: null };
}

// ── P1.3 — interpretation strings, computed from the values ──────────────────
// Each takes (value, delta, extra) and returns { text, flag } so they update rather than
// going stale. `flag` is null when nothing is worth raising.

// Prime-age participation is the DEMOGRAPHICS CONTROL. Retirements and immigration shrink the
// headline participation rate; they do not explain 25–54s leaving. If prime-age holds while
// headline falls, the demographic story survives and this must NOT flag.
export function primeAgeRead(value, delta, headlineDelta) {
  if (value == null || delta == null) return { text: null, flag: null };
  const falling = dir(delta) === 'down', headlineFalling = dir(headlineDelta) === 'down';
  const flag = (falling && headlineFalling) ? 'AMBER' : null;
  const text = falling
    ? `Prime-age participation ${value.toFixed(1)}% (${pp(delta)}). Participation declines are usually blamed on retirements and a shrinking immigrant population. This fall is concentrated in 25–54s, who mostly do neither — that points to discouragement, not demographics.`
    : `Prime-age participation ${value.toFixed(1)}% (${pp(delta)}). Holding up${headlineFalling ? ' while headline participation falls — consistent with the demographic explanation (retirements, immigration), not discouragement' : ''}.`;
  return { text, flag };
}

// The SHARE and the COUNT can disagree: the share dips when the total unemployed pool grows
// faster than the long-term cohort, even as the cohort itself keeps growing. Flag on EITHER
// the share rising while elevated, or the count still building year-over-year — a falling
// share on a rising count is not an improvement, and scoring only the share would miss it.
export function longTermRead(value, delta, yoyCountK) {
  if (value == null) return { text: null, flag: null };
  const rising = dir(delta) === 'up';
  const countBuilding = yoyCountK != null && yoyCountK > 0;
  const elevated = value > LONG_TERM_ELEVATED;
  const flag = (elevated && (rising || countBuilding)) ? 'AMBER' : null;
  const sticky = rising || countBuilding;
  const divergence = (!rising && countBuilding)
    ? ` The share eased while the count still grew — the pool is not shrinking, the rest of the unemployed grew faster.`
    : '';
  return {
    text: `More than ${value >= 25 ? 'a quarter' : `${value.toFixed(0)}%`} of the unemployed have been out of work 27+ weeks (${value.toFixed(1)}%${delta != null ? `, ${pp(delta)}` : ''}${yoyCountK != null ? `; count ${k(yoyCountK)} over the year` : ''}). The unemployed pool is getting ${sticky ? 'stickier' : 'less sticky'} — people who lose jobs are taking ${sticky ? 'longer' : 'less time'} to find new ones.${divergence}`,
    flag,
  };
}

// The level matters less than the direction — track the spread as its own series.
export function u6SpreadRead(u6, u3, priorSpread) {
  if (u6 == null || u3 == null) return { text: null, flag: null, spread: null };
  const spread = +(u6 - u3).toFixed(1);
  const d = priorSpread != null ? +(spread - priorSpread).toFixed(1) : null;
  const widening = dir(d) === 'up';
  return {
    spread,
    text: `Underemployment is running ${spread.toFixed(1)}pp above the headline rate (U-6 ${u6.toFixed(1)}% vs U-3 ${u3.toFixed(1)}%${d != null ? `, ${pp(d)} vs prior` : ''}). ${widening ? 'Widening means part-time-for-economic-reasons and discouraged workers are building beneath the surface.' : d != null && dir(d) === 'down' ? 'Narrowing — slack beneath the headline is easing.' : 'Flat — no change in the slack beneath the headline.'}`,
    flag: widening ? 'AMBER' : null,
  };
}

export function payrollsRead(changeK, revisionsK) {
  if (changeK == null) return { text: null, flag: null };
  const revDown = revisionsK != null && revisionsK < 0;
  return {
    text: `Payrolls ${k(changeK)}${revisionsK != null ? ` with ${k(revisionsK)} of prior revisions` : ''}.${revDown ? ' The initial print consistently overstates; treat the revision trend as the signal, not the headline.' : ''}`,
    flag: revDown ? 'AMBER' : null,
  };
}

// The two surveys measure different things and disagree monthly, but a large opposite-signed
// gap is its own signal — household is noisier but leads at turning points.
export function surveyDivergenceRead(payrollsK, householdK) {
  if (payrollsK == null || householdK == null) return { text: null, flag: null, gapK: null };
  const opposite = Math.sign(payrollsK) !== Math.sign(householdK);
  const gapK = Math.round(Math.abs(payrollsK - householdK));
  const flag = (opposite && gapK > SURVEY_DIVERGENCE_K) ? 'AMBER' : null;
  return {
    gapK, opposite,
    text: opposite
      ? `Household employment ${k(householdK)} vs payrolls ${k(payrollsK)} — the two surveys disagree sharply (${gapK.toLocaleString('en-US')}k apart). Household is noisier month-to-month but leads at turning points; sustained divergence in this direction has historically preceded payroll weakness.`
      : `Household ${k(householdK)} and payrolls ${k(payrollsK)} point the same way — the surveys agree.`,
    flag,
  };
}

// ── F1 — quits rate, and the conflict it is here to surface ──────────────────
// Quits is the cleanest worker-confidence read: people quit when they believe another job is
// available. It is a JOLTS (establishment) series, so it is mechanically independent of the
// household-survey ratios above.
//
// The interpretation rule is deliberately NON-resolving. In June 2026 JOLTS showed quits and
// hires rising in the same month the household survey showed participation collapsing. Those
// two datasets genuinely disagree; picking a winner would manufacture a confidence the data
// does not support. So when they diverge we FLAG the divergence and report both readings —
// the conflict is the finding.
export const QUITS_HEALTHY = 2.2;   // pre-2020 normal ran ~2.3–2.4%; below this is soft
export const QUITS_WEAK = 1.9;      // at/below this, workers are staying put

export function quitsRead(quits = {}, empPop = {}) {
  const { value, delta, yearAgo } = quits;
  if (value == null) return { available: false, note: 'quits rate — no print' };

  const trend = dir(delta, 0.049);
  const yoy = yearAgo != null ? +(value - yearAgo).toFixed(2) : null;
  const level = value <= QUITS_WEAK ? 'weak' : value < QUITS_HEALTHY ? 'soft' : 'healthy';

  // The conflict test. Quits RISING while emp-pop FALLS is the specific shape that says the
  // two surveys are telling different stories about the same month.
  const empPopDir = dir(empPop?.delta);
  const conflict = (trend === 'up' && empPopDir === 'down') || (trend === 'down' && empPopDir === 'up');

  return {
    available: true, value, delta, yoy, level, trend, conflict,
    empPopDelta: empPop?.delta ?? null,
    // Level and direction are separate readings and the note must not blur them: a weak level
    // that is rising is not the same story as a healthy level that is falling.
    note: `Quits ${value.toFixed(1)}% (${level})${delta != null ? `, ${pp(delta)} m/m` : ''}${yoy != null ? `, ${pp(yoy)} y/y` : ''}.`,
    conflictNote: conflict
      ? `⚠ Surveys disagree: quits ${trend === 'up' ? 'rising' : 'falling'} (${pp(delta)}) while employment–population is ${empPopDir === 'down' ? 'falling' : 'rising'} (${pp(empPop?.delta)}). JOLTS is the establishment survey, emp-pop the household survey — they are measuring different things and this month they do not agree. Reported as a conflict, not resolved: workers confident enough to quit is hard to square with employment shrinking, and which one is revised away is not yet knowable.`
      : null,
    verdict: level === 'weak' ? 'AMBER' : 'GREEN',
  };
}

// ── P1.5 — the composed summary line ─────────────────────────────────────────
export function laborSummary(s = {}) {
  const v = laborVerdict(s.u3?.delta, s.empPop?.delta, s.payrolls?.changeK);
  if (v.verdict === 'UNKNOWN') return { verdict: v, headline: null, body: null };
  const exitDriven = v.verdict === 'AMBER';
  // R2 — the payroll override outranks the exit-driven framing: when the establishment survey
  // shows job losses, that is the headline, not "low-hire, low-fire".
  if (v.override) {
    return {
      verdict: v,
      headline: 'The economy shed jobs while the unemployment rate fell — the rate improved only because people left the labour force.',
      body: `Nonfarm payrolls ${k(s.payrolls?.changeK)} for the month, yet U3 fell to ${s.u3?.value?.toFixed(1) ?? '—'}% and the employment–population ratio ${dir(s.empPop?.delta) === 'down' ? `fell ${pp(s.empPop?.delta)} to ` : 'sits at '}${s.empPop?.value?.toFixed(1) ?? '—'}%. The establishment survey saw the job losses the household survey's falling rate hid. This is RED on the payroll count, above whatever the U3/emp-pop 2×2 (${v.override.from}) returned.`,
    };
  }
  return {
    verdict: v,
    headline: exitDriven
      ? 'Low-hire, low-fire, with the exit door doing the work the firing door usually does.'
      : v.verdict === 'RED' ? 'Deteriorating on both counts — fewer employed and more looking.'
      : v.verdict === 'GREEN' ? 'Improving for the right reason — employment is rising, not just the rate falling.'
      : 'Rate rose on re-entry, not job loss — participation is recovering.',
    body: exitDriven
      ? `Nobody is being laid off en masse, but hiring has stalled and people are leaving the labour force rather than keep looking. The headline rate is structurally unable to show this: U3 fell to ${s.u3?.value?.toFixed(1) ?? '—'}% while the employment–population ratio fell ${pp(s.empPop?.delta)} to ${s.empPop?.value?.toFixed(1) ?? '—'}%.`
      : null,
  };
}

// ── Section D — the two-level replacement for `unemployment > 5.0 / 5.5` ─────
// Several alert/danger signals were keyed on the unemployment RATE rising. That rate can FALL
// during the very deterioration those signals exist to catch (June 2026: U3 4.3 → 4.2 while
// emp-pop fell 0.2pp), so every one of them was blind in the same way. Re-keyed onto the
// employment measures, which labour-force exit cannot flatter.
export const EMPPOP_SEVERE_DROP = 0.3;   // pp fall in a single print that counts as severe
export function laborStress(s = {}) {
  const empDown = dir(s.empPop?.delta) === 'down';
  const hhDown = s.household?.changeK != null && s.household.changeK < 0;
  const bigDrop = s.empPop?.delta != null && s.empPop.delta <= -EMPPOP_SEVERE_DROP;
  const known = s.empPop?.delta != null || s.household?.changeK != null;
  const reasons = [];
  if (empDown) reasons.push(`emp-pop ${pp(s.empPop.delta)}`);
  if (hhDown) reasons.push(`household employment ${k(s.household.changeK)}`);
  return {
    known,
    deteriorating: empDown || hhDown,
    // Severe = BOTH surveys pointing down, or a single outsized emp-pop drop.
    severe: (empDown && hhDown) || bigDrop,
    reasons,
    note: !known ? 'labour deterioration not evaluated — no employment print'
      : (empDown || hhDown) ? `labour deteriorating on ${reasons.join(' and ')}`
      : 'employment measures holding',
  };
}

// ── C.5 — Sahm Rule annotation ───────────────────────────────────────────────
// Sahm triggers on U3 rising 0.5pp above its trailing 12-month low. U3 just FELL because
// people left the labour force, which actively SUPPRESSES the rule. Same defect P1.4 fixed for
// the regime transition — it applies to Sahm identically. Do not remove Sahm; annotate it.
// R5 (Amendment 3) — when payrolls are negative the annotation is promoted to full visual
// weight: July made Sahm worse, not better — the rate FELL in a month the economy LOST jobs,
// so the rule moved FURTHER from triggering. Returns { prominent, title, text } (was a bare
// string) so the card can size it accordingly.
export function sahmAnnotation(verdict, payrollsK = null) {
  const payrollsNeg = payrollsK != null && payrollsK < 0;
  if (verdict !== 'AMBER' && verdict !== 'RED' && !payrollsNeg) return null;
  if (payrollsNeg) {
    return {
      prominent: true,
      title: 'Sahm is moving the wrong way.',
      text: 'The rule triggers on the unemployment rate rising 0.5pp above its trailing 12-month low. The rate FELL this month while payrolls contracted, pushing the rule FURTHER from firing during a month of job losses. This indicator cannot see exit-driven deterioration.',
    };
  }
  return {
    prominent: false,
    title: 'Sahm Rule —',
    text: 'Currently understated — the unemployment rate fell on labour-force exit, not hiring. This rule cannot see exit-driven deterioration.',
  };
}

// ── P1.4 — transition trigger ────────────────────────────────────────────────
// The Stagflation → Deflationary Recession roadmap used to trigger on U3 RISING. A
// participation-driven U3 DECLINE therefore blocked the trigger during exactly the
// deterioration it exists to catch. Trigger on the employment measures instead; U3 stays
// displayed, it just stops being the trigger.
export function laborDeteriorationTrigger(s = {}) {
  const reasons = [];
  if (dir(s.empPop?.delta) === 'down') reasons.push(`emp-pop ratio falling (${pp(s.empPop.delta)})`);
  if (s.household?.changeK != null && s.household.changeK < 0) reasons.push(`household employment ${k(s.household.changeK)}`);
  // R2/R8 — a negative payroll count is itself a deterioration signal (it is what tips the
  // regime toward deflationary recession), independent of the household-survey measures.
  if (s.payrolls?.changeK != null && s.payrolls.changeK < 0) reasons.push(`payrolls contracting (${k(s.payrolls.changeK)})`);
  const fired = reasons.length > 0;
  return {
    fired, reasons,
    note: fired
      ? `Deterioration trigger FIRED on ${reasons.join(' and ')} — U3 is not the trigger (it can fall on labour-force exit).`
      : 'Deterioration trigger not fired — employment measures holding.',
  };
}

// ── R3 (Amendment 3) — payroll revision tracker ──────────────────────────────
// Revisions now carry more information than the headline print. Promote them from an
// interpretation bullet (P1.3) to a tracked metric: rolling 3-month revision trend, combined
// total, and a flag when two consecutive months revise down. `revisions` is newest-last:
// [{ month:'May', k:-66 }, { month:'June', k:-37 }].
export function revisionTrackerRead(revisions = []) {
  const rows = (revisions || []).filter(r => r && r.k != null);
  if (!rows.length) return null;
  const combinedK = Math.round(rows.reduce((a, r) => a + r.k, 0));
  const last3 = rows.slice(-3);
  let downStreak = 0;
  for (let i = rows.length - 1; i >= 0; i--) { if (rows[i].k < 0) downStreak++; else break; }
  const twoConsecutiveDown = downStreak >= 2;
  return {
    rows: last3, combinedK, downStreak, twoConsecutiveDown,
    flag: (twoConsecutiveDown || combinedK < 0) ? 'AMBER' : null,
    text: `Prior months revised ${combinedK < 0 ? 'down' : 'up'} by ${Math.abs(combinedK)}k combined (${last3.map(r => `${r.month} ${k(r.k)}`).join(', ')}). The initial print has consistently overstated. Read the revision trend, not the headline.`,
  };
}

// ── R4 (Amendment 3) — 12-month average payrolls ─────────────────────────────
// A single month is too noisy to read directly, especially under revisions of this size. The
// trailing 12-month average change is the cleaner signal. Bands per spec.
export const PAYROLL_BANDS = { healthy: 150, slowing: 75 };  // k/month; <75 = stall, <0 = contraction
export function twelveMonthAvgRead(avgK) {
  if (avgK == null) return null;
  const band = avgK < 0 ? 'contraction'
    : avgK < PAYROLL_BANDS.slowing ? 'stall speed'
    : avgK < PAYROLL_BANDS.healthy ? 'slowing'
    : 'healthy';
  const flag = band === 'contraction' ? 'RED' : band === 'stall speed' ? 'AMBER' : null;
  return {
    avgK: Math.round(avgK), band, flag,
    text: `12-month average payroll change ${k(avgK)} — ${band}. A cleaner read than any single month. Bands: >150k healthy · 75–150k slowing · <75k stall speed · <0 contraction.`,
  };
}

// ── R6 (Amendment 3) — household vs establishment YTD divergence ──────────────
// The two surveys have diverged persistently through 2026. surveyDivergenceRead handles the
// single month; this handles the year-to-date picture. Flag when the YTD gap is opposite-signed.
export function ytdDivergenceRead({ householdK, payrollK, laborForceK } = {}) {
  if (householdK == null || payrollK == null) return null;
  const opposite = Math.sign(householdK) !== Math.sign(payrollK);
  const gapK = Math.round(Math.abs(payrollK - householdK));
  return {
    householdK: Math.round(householdK), payrollK: Math.round(payrollK),
    laborForceK: laborForceK != null ? Math.round(laborForceK) : null,
    opposite, gapK,
    flag: opposite ? 'AMBER' : null,
    text: `Year-to-date: household (civilian) employment ${k(householdK)} against payroll (establishment) employment ${k(payrollK)}${laborForceK != null ? `, labour force ${k(laborForceK)}` : ''} — the surveys point ${opposite ? 'in opposite directions' : 'the same way'}, ${gapK.toLocaleString('en-US')}k apart. Household leads at turning points and is noisier month-to-month; both belong on the card so the divergence is weighted, not averaged away.`,
  };
}
