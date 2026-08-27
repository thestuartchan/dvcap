// lib/inflation.js — the gap between the two core inflation series.
//
// WHY THIS IS A CARD AND NOT A FOOTNOTE. Core CPI and core PCE measure the same idea and routinely
// disagree, and which one you read changes the conclusion. Core PCE normally runs BELOW core CPI:
// shelter carries roughly a third of the CPI basket against a much smaller share of PCE, PCE chains
// its weights while CPI holds a basket fixed, and PCE counts spending made on someone's behalf that
// CPI does not. The discount is structural, not noise.
//
// So when the gap INVERTS — PCE above core CPI — it is saying something specific: the disinflation
// is concentrated in the categories CPI over-weights, principally shelter, while the ones PCE
// weights more heavily are not cooperating. A card showing core CPI alone would report progress
// that the series the Fed actually targets does not show.
//
// Nothing here fetches. Both figures come from FRED through api/indicators.js, on the same basis
// (year-over-year percent) and the same vintage as the tiles they sit under — a spread built from
// two different vintages is a number about the release calendar, not about inflation.

// Below this the two series are "in line": a tenth of a point is inside the month-to-month noise of
// either series and is not worth a reader's attention.
export const IN_LINE_PP = 0.15;
// Where the Fed's own gauge stops being consistent with its target having been reached. Not a
// forecast — a threshold for whether the gap is worth pointing at.
export const ELEVATED_PCE = 3.0;

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// Positive = PCE above core CPI = inverted from the usual relationship.
export function coreSpread(corePce, coreCpi) {
  const p = num(corePce), c = num(coreCpi);
  if (p == null || c == null) return null;
  const pp = +(p - c).toFixed(2);
  const inverted = pp >= IN_LINE_PP;
  return {
    pce: p, cpi: c, pp,
    inverted,
    inLine: Math.abs(pp) < IN_LINE_PP,
    // The case worth interrupting a reader for: core CPI looks like the job is done and the series
    // the Fed targets says it is not.
    divergent: inverted && p >= ELEVATED_PCE,
    label: inverted ? 'inverted — the Fed’s gauge is above core CPI'
      : Math.abs(pp) < IN_LINE_PP ? 'in line — the usual PCE discount has gone'
      : 'normal — PCE below core CPI, as its lighter shelter weight implies',
    tone: inverted ? 'warn' : Math.abs(pp) < IN_LINE_PP ? 'watch' : 'calm',
  };
}
