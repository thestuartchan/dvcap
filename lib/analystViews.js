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
      published: '2026-06-26',
      sourceNote: 'Goldman Sachs, 26 Jun 2026 — 15%, post peace deal. Trajectory 25% (pre-war) → 30% (Mar, Hormuz) → 15%. Cites lower oil, real income, AI wealth effect, solid capex; H2 GDP +2.0%.',
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
      key: 'Morgan Stanley', house: 'Morgan Stanley', kind: 'analyst',
      impliedRegime: 'ref',
      call: '"Capex Over Consumption" — AI investment carries growth while the consumer fades',
      published: '2026 midyear outlook',
      sourceNote: 'Morgan Stanley Midyear Economic Outlook 2026 — base case GDP 2.3% (2026), no recession, conditional on gradual Middle East de-escalation',
      conditions: [
        cond('AI capex still carrying growth', live.capexRising == null ? null : !!live.capexRising,
          live.capexRising == null ? 'n/a' : 'big-four 2026 ~$725B, +77% YoY',
          { critical: true, why: 'the whole thesis is named after this leg — if capex rolls, nothing is holding the economy up' }),
        cond('Middle East de-escalation holds', oil == null ? null : oil < cfg.oilLow, oilTxt,
          { why: 'their base case is explicitly conditional on de-escalation; the downside scenario is Brent $140–160' }),
        cond('GDP near their 2.3% path', gdp == null ? null : gdp >= 2.0, gdpTxt),
      ],
    },
    {
      key: 'Bank of America', house: 'Bank of America', kind: 'analyst',
      impliedRegime: 'ref',
      call: 'Soft landing — the Fed is close to "sticking the landing"',
      published: '2026 outlook',
      sourceNote: 'BofA 2026 outlook — real GDP ~2.3%, unemployment ~4.3%, core PCE ~3.3% (inflation stays above target). Secondary-source summary; verify against the primary note before relying on the exact figures.',
      conditions: [
        cond('Labour market not cracking', live.unemployment == null ? null : live.unemployment <= 4.6,
          live.unemployment == null ? 'n/a' : `U3 ${live.unemployment}%`,
          { why: 'their soft-landing call rests on unemployment holding near 4.3%' }),
        cond('Consumer still spending', live.empPopFalling == null ? null : !live.empPopFalling,
          live.empPopFalling == null ? 'n/a' : (live.empPopFalling ? 'emp-pop falling' : 'emp-pop stable'),
          { critical: true, why: 'the landing sticks only while the consumer holds — employment share is the tell' }),
      ],
    },
    {
      key: 'Deutsche Bank', house: 'Deutsche Bank', kind: 'analyst',
      impliedRegime: 'ref',
      call: 'No recession — growth picks up, Fed cuts below 3.5% by year-end',
      published: '2025-11-24',
      sourceNote: 'Deutsche Bank World Outlook, published 24 Nov 2025 — an ANNUAL outlook written before the Iran war and the hawkish turn. Named downside risk: "a pickup in layoffs, which would undermine consumer spending."',
      conditions: [
        cond('Fed cutting toward 3.5%', live.fedHawkish == null ? null : !live.fedHawkish,
          live.fedHawkish == null ? 'n/a' : (live.fedHawkish ? 'Hawkish Hold — hikes priced, not cuts' : 'easing'),
          { critical: true, why: 'their central policy assumption was a dovish Fed shift; the opposite happened' }),
        cond('Layoffs not picking up', live.empPopFalling == null ? null : !live.empPopFalling,
          live.empPopFalling == null ? 'n/a' : (live.empPopFalling ? 'emp-pop falling' : 'emp-pop stable'),
          { why: 'the downside risk Deutsche named by name' }),
        cond('AI productivity upside intact', live.capexRising == null ? null : !!live.capexRising,
          live.capexRising == null ? 'n/a' : 'capex +77% YoY',
          { why: 'their upside case: AI replicating the 1990s boom, +0.5–0.7pp to growth' }),
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
      published: '2026-03-01',
      sourceNote: 'JPMorgan, March 2026 — 35%, explicitly conditional on a sustained oil shock (Brent $105–115). No post-deal revision published.',
      conditions: [
        cond(`Sustained oil shock (>$${cfg.oilShock})`, oil == null ? null : oil > cfg.oilShock, oilTxt,
          { critical: true, why: 'the entire call was conditional on oil staying at $105–115' }),
      ],
    },
    {
      key: "Moody's Analytics (Zandi)", house: "Moody's (Zandi)", kind: 'analyst', archived: true,
      impliedRegime: 'def',
      call: '"On the precipice" — if oil stays elevated weeks, not months',
      published: '2026-03-01',
      sourceNote: "Moody's Analytics (Zandi), March 2026 — ~49% peak. Zandi's own stated condition: oil elevated 'weeks not months'. It was not met.",
      conditions: [
        cond('Oil still elevated', oil == null ? null : oil > 100, oilTxt,
          { critical: true, why: "Zandi's own stated condition — it was not met" }),
      ],
    },
    {
      key: 'EY-Parthenon (Daco)', house: 'EY-Parthenon (Daco)', kind: 'analyst', archived: true,
      impliedRegime: 'def',
      call: 'Risks rise IF geopolitical tensions persist',
      published: '2026-03-01',
      sourceNote: 'EY-Parthenon (Daco), March 2026 — 40%, framed conditionally on geopolitical tensions persisting. They resolved; no revision published.',
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

// How much a thesis counts toward its regime. A HEAD COUNT is wrong: it lets four impaired views
// outvote three intact ones. Under a $112 oil-shock test the reflationary side was three theses of
// which one was holding and two were void/cracking, against three fully intact deflationary ones —
// and a raw count called that a tie, then broke it by object insertion order. Conviction weights
// fix both: a house whose stated conditions still check out speaks louder than one whose don't.
export const VERDICT_WEIGHT = Object.freeze({
  holding: 1.0,
  cracking: 0.5,
  'under pressure': 0.4,   // the house's OWN flagged risk fired — worse than generic cracking
  void: 0,
  unverifiable: 0,
});

// Two regimes within this much of each other is a genuine split, not a winner — reported as
// contested rather than resolved, the same discipline the regime engine uses on its top two.
export const CLUSTER_CONTESTED_MARGIN = 0.5;

// Where the professionals cluster, by IMPLIED REGIME, weighted by how well each thesis is holding.
export function regimeCluster(evaluated = []) {
  const scores = {}, counts = {};
  for (const v of evaluated) {
    const w = VERDICT_WEIGHT[v.verdict] ?? 0;
    if (w <= 0) continue;
    scores[v.impliedRegime] = +((scores[v.impliedRegime] || 0) + w).toFixed(2);
    counts[v.impliedRegime] = (counts[v.impliedRegime] || 0) + 1;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0] || [null, 0];
  const [second, secondScore] = ranked[1] || [null, 0];
  const contested = !!(second && (topScore - secondScore) <= CLUSTER_CONTESTED_MARGIN);
  // How much of the leading side is actually intact — "ref leads, but on impaired theses" is a
  // materially different read from "ref leads on holding theses".
  const topViews = evaluated.filter(v => v.impliedRegime === top);
  const topHolding = topViews.filter(v => v.verdict === 'holding').length;
  return {
    scores, counts, ranked, top, topScore, second, secondScore, contested,
    topHolding, topTotal: topViews.length,
    impaired: top != null && topHolding < topViews.filter(v => (VERDICT_WEIGHT[v.verdict] ?? 0) > 0).length,
  };
}

// The divergence read — the actual product of this section. Analysts vs the market vs the
// dashboard's own engine. Agreement is confirmation; disagreement is where the information is.
export function divergenceRead({ cluster, engineRegime, marketProb, analystProb } = {}) {
  const parts = [];
  if (cluster?.contested && cluster.top && cluster.second) {
    parts.push(`The professionals are SPLIT — ${cluster.top} and ${cluster.second} are within ${CLUSTER_CONTESTED_MARGIN} of each other on conviction-weighted theses. There is no house view to follow here.`);
  } else if (cluster?.top && engineRegime) {
    parts.push(cluster.top === engineRegime
      ? `The professionals and your engine agree on ${engineRegime}.`
      : `The professionals cluster on ${cluster.top}; your engine reads ${engineRegime} — they disagree, which is the thing to resolve.`);
  }
  if (cluster?.impaired && cluster.top) {
    parts.push(`Note the quality of that lead: only ${cluster.topHolding} of the ${cluster.top} theses is fully holding — the rest are cracking or running on a flagged risk that already fired.`);
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
