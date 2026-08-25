// lib/analystViews.js — the analyst-view board.
//
// PURPOSE. This section is not an estimator. Its job is to answer "what do Wall Street and the
// other professionals think about a recession or the upcoming REGIME, and do the signals still
// agree with them?" A weighted average of their probabilities answers none of that: it throws away
// the reasoning, flattens disagreement into false precision, and cannot tell you when a thesis has
// broken. So each source is modelled the way lib/scenarios.js models a scenario — a named view with
// 2–4 stated CONDITIONS, each carrying a live value — plus two things scenarios.js doesn't need:
//
//   • IMPLIED REGIME. A house at 15% citing lower oil, solid capex and +2% GDP is not "15%
//     recession"; it is a REFLATIONARY GROWTH call. Mapping every view onto the dashboard's own
//     four regimes is what lets the section answer the "upcoming regimes" half of the question in
//     the same language as everything else.
//   • THE HOUSE'S OWN FLAGGED RISK (`critical: true`). Analysts routinely name the variable that
//     would invalidate them. When that variable fires it is worth more than any other condition
//     breaking, because the author already told you it was decisive.
//
// Conditions are hand-curated from what each house actually published — the same prose already in
// RECESSION_SOURCES notes — and are evaluated against live dashboard fields. No condition invents a
// figure: each reads a value the dashboard already sources and stamps.

// Condition helper. `met` is true / false / null (input unavailable → renders "n/a", never counted
// as met and never as a clean miss — same discipline as lib/scenarios.js).
const cond = (label, met, display, opts = {}) => ({
  label, met: met == null ? null : !!met, display,
  critical: !!opts.critical, why: opts.why || null,
});

const n = (v) => (v == null || !Number.isFinite(+v)) ? null : +v;

// live = {
//   oil, gdpGrowth, gdpGrowthPrev, creditSpread, yieldSpread, unemployment,
//   empPopDelta, septHikeOdds, fedHawkish (bool), capexRising (bool)
// } — any field may be absent; conditions that need it render null.
export const VIEW_CFG = Object.freeze({
  oilLow: 95,          // "lower oil" — post-peace-deal regime (Brent ~$91 at the time of writing)
  oilShock: 105,       // the "sustained oil shock" the March vintages were conditional on
  gsGdpPath: 2.0,      // Goldman's stated H2-2026 GDP path
  hikeOddsContained: 25, // Sept hike odds below this = the Fed-hike risk is not yet firing
  dsgeRecession: -1,   // NY Fed DSGE recession definition: 4Q output growth below −1%
});

// Each entry: the house's view, the regime it IMPLIES, and the conditions it rests on.
// `probKey` matches the RECESSION_SOURCES row name so the live/merged probability can be attached.
export function buildViews(live = {}, cfg = VIEW_CFG) {
  const oil = n(live.oil), gdp = n(live.gdpGrowth), spread = n(live.yieldSpread);
  const hike = n(live.septHikeOdds);
  const oilTxt = oil == null ? 'n/a' : `WTI $${oil.toFixed(2)}`;
  const gdpTxt = gdp == null ? 'n/a' : `${gdp > 0 ? '+' : ''}${gdp}% Q2`;

  return [
    {
      key: 'Goldman Sachs', house: 'Goldman Sachs', kind: 'analyst',
      impliedRegime: 'ref',
      call: 'Soft landing — growth holds, inflation cools',
      conditions: [
        cond('Oil stays low', oil == null ? null : oil < cfg.oilLow, oilTxt,
          { why: 'the post-peace-deal oil path is what took their odds from 30% back to 15%' }),
        cond('AI capex holds up', live.capexRising == null ? null : !!live.capexRising,
          live.capexRising == null ? 'n/a' : 'big-four 2026 ~$725B, +77% YoY'),
        cond(`GDP on their +${cfg.gsGdpPath}% H2 path`, gdp == null ? null : gdp >= cfg.gsGdpPath, gdpTxt),
        cond('Fed-hike risk contained', hike == null && live.fedHawkish == null ? null
          : !(live.fedHawkish === true || (hike != null && hike >= cfg.hikeOddsContained)),
          [hike != null ? `Sept odds ${hike}%` : null, live.fedHawkish ? 'Fed language hawkish' : null].filter(Boolean).join(' · ') || 'n/a',
          { critical: true, why: 'Goldman named Fed rate-hike risk as THE new variable — their own flagged invalidator' }),
      ],
    },
    {
      key: 'NY Fed Yield Curve Model', house: 'NY Fed — Yield Curve', kind: 'model',
      impliedRegime: 'ref',
      call: 'No recession signal — curve is upward sloping',
      conditions: [
        cond('10Y−3M spread positive', spread == null ? null : spread > 0,
          spread == null ? 'n/a' : `${spread >= 0 ? '+' : ''}${spread.toFixed(2)}%`,
          { why: 'the model IS the spread — a re-inversion is the signal, not a caveat' }),
      ],
    },
    {
      key: 'July FOMC Minutes', house: 'FOMC — July minutes', kind: 'policy',
      impliedRegime: 'stag',
      call: 'Further tightening "likely necessary" — hawkish, two-sided risk',
      conditions: [
        cond('Fed language still hawkish', live.fedHawkish == null ? null : !!live.fedHawkish,
          live.fedHawkish == null ? 'n/a' : (live.fedHawkish ? 'Hawkish Hold' : 'not hawkish')),
        cond('Hike odds still live', hike == null ? null : hike >= 20, hike == null ? 'n/a' : `Sept ${hike}%`),
      ],
    },
    // ── Theses that BROKE. These were the March vintages: each was explicitly conditional on a
    // sustained oil shock, and each condition is now testably false. They are kept — not hidden —
    // because a broken thesis with the signal that broke it is the clearest demonstration that the
    // framework works, and it is the reason they are excluded from the consensus.
    {
      key: 'JPMorgan', house: 'JPMorgan', kind: 'analyst', archived: true,
      impliedRegime: 'def',
      call: 'Markets complacent over a sustained oil shock',
      conditions: [
        cond(`Sustained oil shock (>$${cfg.oilShock})`, oil == null ? null : oil > cfg.oilShock, oilTxt,
          { critical: true, why: 'the entire call was conditional on oil staying at $105–115' }),
      ],
    },
    {
      key: "Moody's Analytics (Zandi)", house: "Moody's (Zandi)", kind: 'analyst', archived: true,
      impliedRegime: 'def',
      call: '"On the precipice" — if oil stays elevated weeks, not months',
      conditions: [
        cond('Oil still elevated', oil == null ? null : oil > 100, oilTxt,
          { critical: true, why: "Zandi's own stated condition — it was not met" }),
      ],
    },
    {
      key: 'EY-Parthenon (Daco)', house: 'EY-Parthenon (Daco)', kind: 'analyst', archived: true,
      impliedRegime: 'def',
      call: 'Risks rise IF geopolitical tensions persist',
      conditions: [
        cond('Geopolitical premium persists', oil == null ? null : oil > 100, oilTxt,
          { critical: true, why: 'framed conditionally; the tension resolved' }),
      ],
    },
    {
      key: 'NY Fed DSGE Model', house: 'NY Fed — DSGE', kind: 'model', archived: true,
      impliedRegime: 'def',
      call: `Model: 4Q output growth below ${cfg.dsgeRecession}%`,
      conditions: [
        cond(`Output growth below ${cfg.dsgeRecession}%`, gdp == null ? null : gdp < cfg.dsgeRecession, gdpTxt,
          { why: 'the model definition — nowhere near triggering' }),
      ],
    },
  ];
}

// Verdict for one view. A house's OWN flagged risk (critical) firing outranks the raw count: the
// author already told you that variable was decisive.
export function evaluateView(view) {
  const known = view.conditions.filter(c => c.met !== null);
  const met = known.filter(c => c.met).length;
  const criticalBroken = view.conditions.some(c => c.critical && c.met === false);
  const total = known.length;

  // Severity is a function of BOTH how much broke and whether the decisive condition is one of
  // them. Ordering matters: an earlier version returned "under pressure" for any critical break,
  // which made a thesis with 1-of-4 conditions left read as LESS severe than a non-critical
  // 1-of-4 ("cracking") — a critical failure must never soften the verdict.
  const brokenFrac = total ? (total - met) / total : 0;
  let verdict, tone, note;
  if (!total) {
    verdict = 'unverifiable'; tone = 'muted';
    note = 'no live input available for this thesis right now';
  } else if (met === 0) {
    verdict = 'void'; tone = 'red';
    note = criticalBroken
      ? 'the condition the house itself named as decisive is false — this call no longer describes the world'
      : 'none of the stated conditions hold';
  } else if (criticalBroken && brokenFrac > 0.5) {
    verdict = 'void'; tone = 'red';
    note = `the house's own flagged condition failed and ${total - met} of ${total} conditions are gone — the call no longer describes the world`;
  } else if (criticalBroken) {
    verdict = 'under pressure'; tone = 'amber';
    note = "the house's own flagged risk has fired — treat the level as a floor, not a current view";
  } else if (met === total) {
    verdict = 'holding'; tone = 'green';
    note = 'every stated condition still checks out';
  } else {
    verdict = 'cracking'; tone = 'amber';
    note = `${total - met} of ${total} stated conditions no longer hold`;
  }
  return { ...view, met, total, criticalBroken, brokenFrac: +brokenFrac.toFixed(2), verdict, tone, note };
}

export const evaluateViews = (views) => views.map(evaluateView);

// Where the professionals cluster, by IMPLIED REGIME — weighting only views that still hold or are
// merely cracking. A void thesis contributes nothing: its author's stated world no longer exists.
export function regimeCluster(evaluated = []) {
  const counts = {};
  for (const v of evaluated) {
    if (v.verdict === 'void' || v.verdict === 'unverifiable') continue;
    counts[v.impliedRegime] = (counts[v.impliedRegime] || 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return { counts, top: ranked[0]?.[0] ?? null, ranked };
}

// The divergence read — the actual product of this section. Analysts vs the market vs the
// dashboard's own engine. Agreement is confirmation; disagreement is where the information is.
export function divergenceRead({ cluster, engineRegime, marketProb, analystProb } = {}) {
  const parts = [];
  if (cluster?.top && engineRegime) {
    parts.push(cluster.top === engineRegime
      ? `The professionals and your engine agree on ${engineRegime}.`
      : `The professionals cluster on ${cluster.top}; your engine reads ${engineRegime} — they disagree, which is the thing to resolve.`);
  }
  if (marketProb != null && analystProb != null) {
    const gap = +(marketProb - analystProb).toFixed(1);
    if (Math.abs(gap) >= 5) {
      parts.push(gap > 0
        ? `Real money prices recession ${Math.abs(gap)}pp HIGHER than the analysts — the market is more worried than the desks.`
        : `Real money prices recession ${Math.abs(gap)}pp LOWER than the analysts — the desks are more worried than the market.`);
    } else {
      parts.push('Market pricing and analyst views are within 5pp — no meaningful divergence.');
    }
  }
  return parts.join(' ');
}
