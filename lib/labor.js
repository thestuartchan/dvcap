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
  payrolls:    { id: 'PAYEMS',       label: 'Nonfarm payrolls',          unit: 'k',  expectTitle: 'all employees' },
  household:   { id: 'CE16OV',       label: 'Household survey employment', unit: 'k', expectTitle: 'employment level' },
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
export function laborVerdict(u3Delta, empPopDelta) {
  const u = dir(u3Delta), e = dir(empPopDelta);
  if (u == null || e == null) {
    return { verdict: 'UNKNOWN', color: 'muted',
      read: `cannot score — ${u == null ? 'U3' : 'emp-pop'} direction unavailable`, u3: u, empPop: e };
  }
  // 'flat' resolves toward the non-improving side: a flat emp-pop does not corroborate a
  // falling U3, so it cannot earn GREEN.
  const uDown = u === 'down', eUp = e === 'up', eDown = e === 'down';
  let verdict, read;
  if (uDown && eUp)        { verdict = 'GREEN';   read = 'Rate fell because more people are working. Genuine improvement.'; }
  else if (uDown && !eUp)  { verdict = 'AMBER';   read = 'Rate fell for the wrong reason — the share of the population employed also fell. Exit-driven, not hiring-driven.'; }
  else if (!uDown && eUp)  { verdict = 'NEUTRAL'; read = 'Rate rose because people re-entered the labour force to look for work. Normal in a recovering market.'; }
  else                     { verdict = 'RED';     read = 'Genuine deterioration. Fewer people working and more looking.'; }
  const color = { GREEN: 'green', AMBER: 'amber', NEUTRAL: 'muted', RED: 'red' }[verdict];
  return { verdict, color, read, u3: u, empPop: e };
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

export function longTermRead(value, delta, yoyCountK) {
  if (value == null) return { text: null, flag: null };
  const rising = dir(delta) === 'up';
  const flag = (value > LONG_TERM_ELEVATED && rising) ? 'AMBER' : null;
  return {
    text: `More than ${value >= 25 ? 'a quarter' : `${value.toFixed(0)}%`} of the unemployed have been out of work 27+ weeks (${value.toFixed(1)}%${delta != null ? `, ${pp(delta)}` : ''}${yoyCountK != null ? `, ${k(yoyCountK)} over the year` : ''}). The unemployed pool is getting ${rising ? 'stickier' : 'less sticky'} — people who lose jobs are taking ${rising ? 'longer' : 'less time'} to find new ones.`,
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

// ── P1.5 — the composed summary line ─────────────────────────────────────────
export function laborSummary(s = {}) {
  const v = laborVerdict(s.u3?.delta, s.empPop?.delta);
  if (v.verdict === 'UNKNOWN') return { verdict: v, headline: null, body: null };
  const exitDriven = v.verdict === 'AMBER';
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

// ── P1.4 — transition trigger ────────────────────────────────────────────────
// The Stagflation → Deflationary Recession roadmap used to trigger on U3 RISING. A
// participation-driven U3 DECLINE therefore blocked the trigger during exactly the
// deterioration it exists to catch. Trigger on the employment measures instead; U3 stays
// displayed, it just stops being the trigger.
export function laborDeteriorationTrigger(s = {}) {
  const reasons = [];
  if (dir(s.empPop?.delta) === 'down') reasons.push(`emp-pop ratio falling (${pp(s.empPop.delta)})`);
  if (s.household?.changeK != null && s.household.changeK < 0) reasons.push(`household employment ${k(s.household.changeK)}`);
  const fired = reasons.length > 0;
  return {
    fired, reasons,
    note: fired
      ? `Deterioration trigger FIRED on ${reasons.join(' and ')} — U3 is not the trigger (it can fall on labour-force exit).`
      : 'Deterioration trigger not fired — employment measures holding.',
  };
}
