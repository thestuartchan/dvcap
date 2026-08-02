// recon.js — OAS/HYG reconciliation (P2.5).
//
// Purpose, stated plainly: establish whether the HYG proxy is ACTUALLY predictive. The card
// is easy to trust by habit — it is live, it is on screen, and it tells a story. This module
// exists to check that story against what the published spread later did, so the card can be
// demoted or dropped on evidence.
//
// The reconciliation can only run with a lag: HY OAS for date D publishes ~2 business days
// later (variable, stretching over weekends). So each day we look BACK for logged days whose
// OAS observation has since landed and which have not been scored yet.

// Direction convention: HYG DOWN means credit is being sold, which implies the spread should
// WIDEN (OAS up). So agreement = OPPOSITE signs.
export function directionAgreed(hygChg, oasChg) {
  if (hygChg == null || oasChg == null) return null;
  if (hygChg === 0 || oasChg === 0) return null;      // no direction to compare
  return Math.sign(hygChg) !== Math.sign(oasChg);
}

// The OAS change ON a given observation date, vs the immediately preceding observation.
// Returns null when that date has not published yet, or has no prior to compare against —
// never an assumed or interpolated value.
export function oasChangeOn(series, date) {
  const s = (series || []).filter(r => r?.date && r.value != null)
    .slice().sort((a, b) => a.date.localeCompare(b.date));
  const i = s.findIndex(r => r.date === date);
  if (i < 1) return null;
  return { chg: +(s[i].value - s[i - 1].value).toFixed(4), value: s[i].value, prevDate: s[i - 1].date };
}

// Which logged days can now be scored? Requires a stored HYG reading for the day AND the
// matching OAS observation to have published. Already-scored dates are skipped.
export function pendingReconciliations(history, oasSeries, existingRecon = []) {
  const done = new Set((existingRecon || []).map(r => r.date));
  const out = [];
  for (const row of history || []) {
    if (!row?.date || done.has(row.date)) continue;
    if (row.hyg_chg == null) continue;                 // nothing to score against
    const oas = oasChangeOn(oasSeries, row.date);
    if (!oas) continue;                                // OAS for that date has not landed yet
    out.push({
      date: row.date,
      hyg_chg: row.hyg_chg,
      hyg_qqq_divergence: row.hyg_qqq_divergence ?? null,
      oas_actual_chg: oas.chg,
    });
  }
  return out;
}

// Hit rate, with an explicit "not yet meaningful" state. A handful of days proves nothing, and
// presenting an early rate as if it did would be the same habit-trust this module guards against.
export const RECON_MIN_SAMPLE = 20;
export function reconStats(rows = []) {
  const scored = rows.filter(r => r && r.direction_agreed != null);
  const n = scored.length;
  const agreed = scored.filter(r => r.direction_agreed).length;
  if (n === 0) return { n: 0, agreed: 0, rate: null, verdict: 'no scored days yet' };
  const rate = +((agreed / n) * 100).toFixed(1);
  if (n < RECON_MIN_SAMPLE) {
    return { n, agreed, rate, sufficient: false,
      verdict: `${agreed}/${n} agreed (${rate}%) — below the ${RECON_MIN_SAMPLE}-day minimum, not yet meaningful` };
  }
  // Near or below chance is the demote/drop signal the spec asks for.
  const verdict = rate < 45 ? `${rate}% over ${n} days — at or below chance; the proxy is not earning its place`
    : rate < 55 ? `${rate}% over ${n} days — indistinguishable from chance; treat as decoration, not signal`
    : `${rate}% over ${n} days — better than chance`;
  return { n, agreed, rate, sufficient: true, belowChance: rate < 55, verdict };
}
