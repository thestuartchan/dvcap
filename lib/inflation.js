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
//
// ── AND THAT WAS STATED, NOT ENFORCED ────────────────────────────────────────
// The sentence above, and an identical one in the card that renders this, asserted matching
// vintages as a fact. Nothing checked it, and the two series DO NOT publish together: BLS releases
// CPI around the 11th of the following month and BEA releases PCE at the end of it. So for roughly
// two weeks of every month core CPI is one month ahead of core PCE, and this spread silently
// becomes the difference between two different months.
//
// It was true on 2026-09-10 — both series stood at 2026-07 — and false the next morning, when
// August CPI published and PCE did not. The number would have moved, the card would have explained
// the move as inflation, and the cause would have been the release calendar.
//
// The dates are OPTIONAL so every existing caller keeps working, but when both are supplied the
// result says whether they agree and the renderer is expected to say so. Same rule lib/assemble.js
// already applies to the 10s30s spread: a spread cannot be fresher than the stalest leg it is
// built from, and one built across vintages is not a spread at all.

// Below this the two series are "in line": a tenth of a point is inside the month-to-month noise of
// either series and is not worth a reader's attention.
export const IN_LINE_PP = 0.15;
// Where the Fed's own gauge stops being consistent with its target having been reached. Not a
// forecast — a threshold for whether the gap is worth pointing at.
export const ELEVATED_PCE = 3.0;

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// "2026-07-01" → "July". Written out because "07" beside "08" in a sentence about two months
// reads as a pair of numbers rather than as the thing that differs.
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
export function monthName(d) {
  const m = String(d || '').match(/^(\d{4})-(\d{2})/);
  return m ? `${MONTHS[+m[2] - 1]}${m[1] !== String(new Date().getUTCFullYear()) ? ' ' + m[1] : ''}` : String(d || '');
}

// Positive = PCE above core CPI = inverted from the usual relationship.
export function coreSpread(corePce, coreCpi, { pceDate = null, cpiDate = null } = {}) {
  const p = num(corePce), c = num(coreCpi);
  if (p == null || c == null) return null;
  // Unknown dates are not asserted to match. `sameVintage` is null when it cannot be established,
  // which a renderer must treat as "cannot vouch for it" rather than as "fine".
  const sameVintage = (pceDate && cpiDate) ? pceDate === cpiDate : null;
  const pp = +(p - c).toFixed(2);
  const inverted = pp >= IN_LINE_PP;
  return {
    pce: p, cpi: c, pp,
    pceDate, cpiDate, sameVintage,
    // A spread across two months is a fact about the release calendar. Callers render this instead
    // of the reading, rather than printing a number that describes something else.
    vintageNote: sameVintage === false
      ? `core CPI is the ${monthName(cpiDate)} print and core PCE is still ${monthName(pceDate)} — `
        + `BLS publishes CPI around the 11th and BEA publishes PCE at month end, so this gap is `
        + `part release calendar and not only inflation`
      : null,
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
