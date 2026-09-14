// regimeEngine.js — the four-state regime, computed the same way wherever it is asked for.
//
// Why this exists: every input to the regime lived in src/App.jsx — the recession source table,
// its weights and decay, the announced-print overlays, the labour signal, the context builder —
// so the regime could only be computed by a browser with the dashboard open. The daily regime
// log was therefore written by a localStorage guard on the client, and had holes wherever nobody
// opened the page. Moved here verbatim (nothing below changed on the way), exported, and composed
// into regimeSnapshot(), which the dashboard and the pre-read cron now both call on the same
// indicators payload. One engine, two callers, no drift.
import { consensusFor, calendarWindow, HORIZON, horizonOf, consensusVintage } from './recession.js';
import { deriveRegimeProbabilities } from './regimeProb.js';
import { consensusAlive, regimeVintage as regimeVintageOf } from './regimeVintage.js';
import { REGIMES } from './regimes.js';

export const ANNOUNCED_PRINTS = {
  pceCore: {
    period: "2026-06-01", label: "June core PCE", value: 3.3, mom: 0.1,
    headline: 3.7, headlineMom: -0.1, prev: 3.4,
    source: "BEA", released: "2026-07-30",
    note: "cooled from May's 3.4% (~3-year high)",
  },
  gdpGrowth: {
    period: "2026-04-01", label: "Q2 2026 advance GDP", value: 1.5, prev: 2.1,
    source: "BEA advance estimate", released: "2026-07-30",
    note: "decelerating from Q1's +2.1%, below consensus — drag from government spending and inventories; consumer spending accelerated",
  },
};
// Return the announced print only while it is NEWER than what the live series carries.
export function announced(key, fredAsOf) {
  const a = ANNOUNCED_PRINTS[key];
  if (!a) return null;
  if (fredAsOf && String(fredAsOf) >= a.period) return null;   // FRED caught up → retire
  return a;
}

// ─── ANNOUNCED LABOUR PRINT (Amendment 3 — July Employment Situation) ──────────
// The July 2026 Employment Situation released 08:30 ET on 2026-08-07, ahead of FRED's ingest,
// so the live labour series still carry June until FRED updates. Rather than hardcode over the
// live fields, the released figures are overlaid here and AUTO-RETIRE the moment FRED's own
// emp-pop asOf reaches July. Values are the published figures; per-series deltas are computed
// against the live prior at overlay time so the month-over-month move is real, not asserted.
// emp-pop is not published as a headline — it is the identity participation × (1 − U3).
export const LABOR_ANNOUNCED = {
  period: "2026-07-01", released: "2026-08-07", source: "BLS Employment Situation",
  u3: 4.1, participation: 61.4,
  empPop: +(61.4 * (1 - 4.1 / 100)).toFixed(1),   // 58.9 — identity, not a fabricated print
  payrollsDeltaK: -23,                             // the monthly change itself
  // Extras with no single live FRED series — the fixture the amendment supplies.
  revisions: [{ month: "May", k: -66 }, { month: "June", k: -37 }],
  twelveMoAvgK: 34,
  ytd: { householdK: -833, payrollK: 392, laborForceK: -1100 },
  ahe: { mom: 0.3, yoy: 3.5 },
};
// Returns { labor, applied, extras } — labor merged with the July overlay when FRED is behind.
export function overlayJulyLabor(labor) {
  if (!labor) return { labor, applied: false, extras: null };
  const live = labor.empPop;
  if (live?.date && String(live.date) >= LABOR_ANNOUNCED.period) return { labor, applied: false, extras: null };
  const A = LABOR_ANNOUNCED;
  const d = (v, key) => labor[key]?.value != null ? +(v - labor[key].value).toFixed(1) : null;
  const set = (key, value, delta) => labor[key]
    ? { ...labor[key], value, delta, prev: labor[key].value ?? null, date: A.period, announced: true }
    : labor[key];
  const merged = {
    ...labor,
    u3: set("u3", A.u3, d(A.u3, "u3")),
    participation: set("participation", A.participation, d(A.participation, "participation")),
    empPop: set("empPop", A.empPop, d(A.empPop, "empPop")),
    payrolls: labor.payrolls
      ? { ...labor.payrolls, delta: A.payrollsDeltaK, date: A.period, announced: true }
      : labor.payrolls,
  };
  return { labor: merged, applied: true, extras: A };
}

export const RECESSION_SOURCES = [
  { name: "Goldman Sachs",             probability: "15%",    timeframe: "12-month", year: 2026, notes: "CONFIRMED CURRENT 2026-09-07: still 15%, no newer print. The path was 25% (pre-Iran war) → 30% (March peak Hormuz) → 15% (June 26, post peace deal), and 15% is also the unconditional long-run average. The row is the latest print, not an overdue one. Cites lower oil, higher real income, AI wealth effect, solid capex; GDP H2 2026 +2.0%. Flags Fed rate-hike risk as the new variable.", asOf: "2026-06-26", color: "green" },
  { name: "NY Fed Yield Curve Model",  probability: "~15%",   timeframe: "12-month", year: 2026, notes: "Fallback only — the board derives this live from the current 10Y-3M spread via the Estrella-Mishkin probit. As of 2026-09-04 the spread is 0.83ppt and the model reads 15%, still far below the 30% historical alarm threshold and further from inversion than the +62bps this row used to quote.", asOf: "2026-09-04", color: "green" },
  { name: "Kalshi prediction market",  probability: "5%",     timeframe: "End-2026", year: 2026, notes: "Fallback only — the live feed (KXRECSSNBER-26) drives the displayed value. Refreshed 2026-09-07 from that feed: 5%, down from the 22% June print this row used to carry. Real-money market, CFTC-regulated.", asOf: "2026-09-07", color: "green" },
  { name: "Kalshi prediction market",  probability: "25%",    timeframe: "End-2027", year: 2027, notes: "Fallback only — live feed KXRECSSNBER-27 drives the display. Refreshed 2026-09-07: 25%, down from the 41% this row carried. Still well above the 2026 contract, which is the point of showing both: the market prices a later reckoning, not none.", asOf: "2026-09-07", color: "amber" },
  { name: "Polymarket",                probability: "7%",     timeframe: "End-2026", year: 2026, notes: "Fallback only — live feed (us-recession-by-end-of-2026) drives the display. Refreshed 2026-09-07: 7%, down from the ~12.5% June print. Correlated with Kalshi and weighted as one block with it, not as two independent views.", asOf: "2026-09-07", color: "green" },
  { name: "BNP Paribas",               probability: "Low",    timeframe: "12-month", year: 2026, notes: "Qualitative only — excluded from weighted average. 'Well-positioned to absorb shock.' US net energy exporter status cited. No numeric update available.", color: "green" },
  { name: "July FOMC Minutes", probability: "Elevated", timeframe: "qualitative", year: 2026, notes: "Released Aug 19, 2026. 'Many participants' assessed further policy tightening would likely be necessary — a material upgrade from June's 'only a few', so the three hike dissents UNDERSTATE the committee's hawkishness. Warsh floated cutting FOMC meetings from 8 to 6 a year (no decision; 2026 schedule unaffected). Board discussed an intermeeting incident disrupting transaction settlements.", asOf: "2026-08-19", color: "amber" },
];

// Weighted-average weights per source. Sum is 1.10 (intentional — the average
// divides by the realized total weight, so it need not sum to 1.0). Sources not
// listed here (e.g. BNP "Low") are excluded automatically.
export const RECESSION_SOURCE_WEIGHTS = {
  "NY Fed DSGE Model": 0.18,
  "NY Fed Yield Curve Model": 0.20,
  "Goldman Sachs": 0.20,
  "JPMorgan": 0.15,
  "EY-Parthenon (Daco)": 0.07,
  "Moody's Analytics (Zandi)": 0.10,
  "Kalshi prediction market": 0.10, // 2026 row only; 2027 row handled separately
  "Polymarket": 0.10,
};

// Expected publication cadence per source, in days — how often THIS source actually publishes a
// recession probability. The as-of chip used to flag every row past a flat 45 days as "stale",
// which conflated two different things: a number that is simply the source's LATEST print (a
// research house publishes episodically — Goldman's 60-day-old 15% is its current view, not an
// overdue fetch) and a number that is genuinely PAST DUE (the NY Fed DSGE model publishes monthly;
// at 177 days something is actually wrong). Flagging both identically trained the eye to ignore the
// flag and sent the reader hunting for updates that do not exist. Within cadence → neutral "latest";
// past cadence → amber "overdue", which now means something. This is presentation only: the
// weighted average is unaffected — recencyFactor() above still decays every source linearly to
// zero at 180 days regardless of cadence, which is the correct treatment for the MATH.
export const RECESSION_SOURCE_CADENCE = {
  "NY Fed DSGE Model": 30,              // quarterly-ish model run, published monthly
  "NY Fed Yield Curve Model": 30,       // monthly update (auto-fed daily here)
  "Kalshi prediction market": 1,        // live market — any gap is a feed failure
  "Kalshi prediction market 2027": 1,
  "Polymarket": 1,
  "Goldman Sachs": 120,                 // episodic research note, event-driven
  "JPMorgan": 120,
  "Moody's Analytics (Zandi)": 120,
  "EY-Parthenon (Daco)": 120,
  "BNP Paribas": 120,
  "July FOMC Minutes": 45,              // tied to the FOMC calendar (8 meetings/yr)
};
export const RECESSION_DEFAULT_CADENCE = 90;

// Age + whether the source is genuinely OVERDUE for its own cadence.
export function recessionAsOfState(name, asOf) {
  if (!asOf) return null;
  const days = Math.round((Date.now() - new Date(asOf + "T00:00:00Z")) / 864e5);
  const cadence = RECESSION_SOURCE_CADENCE[name] ?? RECESSION_DEFAULT_CADENCE;
  return { days, cadence, overdue: days > cadence };
}

// Parse a probability string ("~15%", "35.8%", "Low") to a number, or null.
export const parseProbability = (probStr) => {
  if (!probStr || probStr === "Low" || probStr === "High") return null;
  const cleaned = probStr.replace("~", "").replace("%", "").trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
};

// A source's weight decays LINEARLY to zero by this age. A March-2026 crisis-peak estimate
// (≈160 days old on 2026-08-07) was carrying full weight in the average that feeds the regime
// engine — a defect. Decay (rather than a hard 45-day cliff) fades old vintages without a jump,
// and fully drops anything ≥180 days. Sources with no asOf are treated as current.
export const RECESSION_STALE_ZERO_DAYS = 180;
export function recencyFactor(asOf, nowIso) {
  if (!asOf || !nowIso) return 1;
  const age = Math.round((Date.parse(nowIso) - Date.parse(asOf)) / 86400000);
  if (!Number.isFinite(age) || age <= 0) return 1;
  if (age >= RECESSION_STALE_ZERO_DAYS) return 0;
  return +(1 - age / RECESSION_STALE_ZERO_DAYS).toFixed(3);
}

// Weighted average of the 2026 recession-probability sources, recency-decayed. The Kalshi 2027
// row is pulled out separately as the delayed-reckoning modifier input. `nowIso` (YYYY-MM-DD)
// drives the decay; pass null to disable it (full weight, the old behaviour).
export const computeWeightedRecessionProb = (sources, nowIso = null) => {
  let weightedSum = 0, totalWeight = 0, kalshi2027 = null;
  const decayed = [];
  sources.forEach(source => {
    if (source.name === "Kalshi prediction market" && source.year === 2027) {
      kalshi2027 = parseProbability(source.probability);
      return;
    }
    // A1 — archived vintages (condition invalidated) are excluded outright, not decayed. Decay
    // handles aging; it does not handle a forecast whose stated precondition no longer holds.
    if (source.archived) return;
    const weight = RECESSION_SOURCE_WEIGHTS[source.name];
    const prob = parseProbability(source.probability);
    if (!weight || prob === null) return;
    const factor = recencyFactor(source.asOf, nowIso);
    if (factor < 0.999) decayed.push({ name: source.name, asOf: source.asOf, factor });
    const eff = weight * factor;
    if (eff > 0) { weightedSum += prob * eff; totalWeight += eff; }
  });
  const weightedAvg = totalWeight > 0 ? weightedSum / totalWeight : null;

  // ── Horizon-split consensus (lib/recession.js) ──
  // `weightedAvg` above is the LEGACY all-horizons blend, kept only so the change is auditable.
  // It mixed rolling-12m forecasts with calendar-year contracts whose window shrinks toward
  // Dec 31, which dragged the number down for calendar reasons alone. The regime engine now
  // consumes `rolling` — the horizon it actually asks about ("recession within 12 months").
  const rows = sources
    .filter(s => !(s.name === "Kalshi prediction market" && s.year === 2027))
    .map(s => ({
      name: s.name, prob: parseProbability(s.probability),
      weight: RECESSION_SOURCE_WEIGHTS[s.name] || 0,
      recency: recencyFactor(s.asOf, nowIso),
      asOf: s.asOf, year: s.year, timeframe: s.timeframe, archived: s.archived,
    }));
  const rolling  = consensusFor(rows, HORIZON.ROLLING);
  const calendar = consensusFor(rows, HORIZON.CALENDAR);
  const calWindow = calendarWindow(nowIso || new Date().toISOString().slice(0, 10), 2026);

  return {
    weightedAvg,          // legacy blend — displayed for comparison, no longer drives the engine
    regimeInput: rolling.value ?? weightedAvg,   // what the regime engine consumes
    rolling, calendar, calWindow,
    kalshi2027, decayed,
    // The share of the rolling consensus's nominal weight still alive after decay — the number
    // that grades the regime's vintage for the sizer, the action card and the header.
    alive: consensusAlive(rows.filter(r => horizonOf(r.timeframe) === HORIZON.ROLLING)),
  };
};

// Two Kalshi rows share the name "Kalshi prediction market" (2026 vs 2027), so a bare name is
// not a unique key for feed/override addressing. This composite key disambiguates them and is
// used identically on the server (api/indicators recessionFeeds keys) and in the manual store.
export const recessionSrcKey = (r) =>
  (r.name === "Kalshi prediction market" && r.year === 2027) ? "Kalshi prediction market 2027" : r.name;

// Merge live auto-feeds (Task 1a) and manual overrides (Task 1b) over the static rows.
// Precedence per row: manual override > auto-feed > static default. Only probability/asOf/notes
// are touched; weight and timeframe always come from the static definition. `source` records the
// provenance so the table can badge each row (📡 live / ✍️ manual / static).
export function mergeRecessionSources(statics, feeds = {}, manual = {}) {
  const fmtPct = (v) => (/%/.test(String(v)) ? String(v) : `${v}%`);
  return statics.map((r) => {
    const key = recessionSrcKey(r);
    const man = manual[key];
    if (man && man.probability != null && man.probability !== "") {
      return { ...r, probability: fmtPct(man.probability), asOf: man.asOf || r.asOf,
        notes: man.notes || r.notes, source: "manual", sourceAt: man.enteredAt || null };
    }
    const auto = feeds[key];
    if (auto && auto.probability != null) {
      // Live rows carry their OWN note ("Live real-money market…", "Model-derived…") so the row's
      // static prose — written for the old hand-entered value — can't contradict the fresh number.
      return { ...r, probability: fmtPct(auto.probability), asOf: auto.asOf || r.asOf, notes: auto.note || r.notes, source: "auto" };
    }
    return { ...r, source: "static" };
  });
}

export const CONSENSUS_VINTAGE_BASE = {
  asOf: "2026-06-30",
  // The releases the refresh waits on, with the date each actually lands. Once the last one is in
  // the past the refresh stops being deferred and starts being owed.
  gatedOn: [
    { date: "2026-08-07", label: "July Employment Situation" },
    { date: "2026-08-28", label: "BLS benchmark revision" },
  ],
};
export const CONSENSUS_VINTAGE = consensusVintage(CONSENSUS_VINTAGE_BASE);

// The prior static split, used only when the engine has no consensus to work from.
export const FALLBACK_REGIMES = { stagflation: 48, reflationary: 17, deflationary: 30, inflationary: 5 };

// ── THE PIPELINE, ONCE ───────────────────────────────────────────────────────
// `liveInd` is api/indicators.js's payload. `overrides` is data/manual_entry.json's `recession`
// block (manual override > auto-feed > static). `now` is injectable: the decay, the calendar
// window and the vintage all age against it, and a log row must be computable for its own date.
export function regimeSnapshot(liveInd, { overrides = {}, now = new Date() } = {}) {
  const nowIso = now.toISOString().slice(0, 10);
  const sources = mergeRecessionSources(RECESSION_SOURCES, liveInd?.recessionFeeds || {}, overrides || {});
  const recConsensus = computeWeightedRecessionProb(sources, nowIso);
  // The regime engine consumes the ROLLING-12M consensus — the horizon it actually asks about.
  const { regimeInput: recWeightedAvg, kalshi2027: recKalshi2027, decayed: recDecayed } = recConsensus;
  const cpiForRegime = liveInd?.cpiHeadlineCurrent ?? liveInd?.cpi ?? null;
  const coreHist = liveInd?.pceCoreHistory || [];
  // Overlay the announced labour print over the live (FRED-lagged) series; auto-retires when FRED
  // catches up. One computation, reused by the labour panels and the regime context.
  const { labor: laborView, applied: laborAnnounced, extras: laborExtras } = overlayJulyLabor(liveInd?.labor);
  const laborTwelveMoK = laborExtras?.twelveMoAvgK
    ?? ((laborView?.payrolls?.history?.length >= 13)
      ? Math.round((laborView.payrolls.history.at(-1).value - laborView.payrolls.history.at(-13).value) / 12)
      : null);
  const laborRegimeSignal = {
    payrollsK: laborView?.payrolls?.delta ?? null,
    empPopDelta: laborView?.empPop?.delta ?? null,
    twelveMoAvgK: laborTwelveMoK,
  };
  const regimeCtx = {
    gdpGrowth: (announced("gdpGrowth", liveInd?.asOf?.gdpGrowth)?.value) ?? liveInd?.gdpGrowth ?? null,
    gdpGrowthPrev: (announced("gdpGrowth", liveInd?.asOf?.gdpGrowth)?.prev) ?? liveInd?.gdpGrowthPrev ?? null,
    coreInflation: (announced("pceCore", liveInd?.asOf?.pceCoreCurrent)?.value) ?? liveInd?.pceCoreCurrent ?? null,
    coreCooling: coreHist.length >= 2 ? coreHist[coreHist.length - 1].value < coreHist[coreHist.length - 2].value : null,
    labor: laborRegimeSignal,
  };
  const derivedRegimes = deriveRegimeProbabilities(recWeightedAvg, cpiForRegime, recKalshi2027, regimeCtx);
  const vintage = consensusVintage(CONSENSUS_VINTAGE_BASE, now);
  const regimeVintage = regimeVintageOf({ ...(recConsensus.alive || {}), refreshDue: vintage.refreshDue, staleNote: vintage.staleNote });
  const src = derivedRegimes || FALLBACK_REGIMES;
  const byId = { stag: src.stagflation, ref: src.reflationary, def: src.deflationary, inf: src.inflationary };
  const liveRegimeId = Object.entries(byId).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const liveRegime = REGIMES.find(r => r.id === liveRegimeId) || REGIMES[0];
  return {
    sources, recConsensus, recWeightedAvg, recKalshi2027, recDecayed, cpiForRegime,
    laborView, laborAnnounced, laborExtras, laborTwelveMoK, laborRegimeSignal, regimeCtx,
    derivedRegimes, regimeVintage, liveRegimeId, liveRegime, nowIso,
  };
}

// The row the regime log stores, from a snapshot. `extra` carries what only a caller can know —
// the client's pinned view, the tape state, the same-day HYG reading. Nulls where it cannot.
export function regimeLogRow(snap, { date = snap.nowIso, extra = {}, source = 'cron' } = {}) {
  const d = snap.derivedRegimes || {};
  return {
    date,
    stagflation_p: d.stagflation ?? null, reflationary_p: d.reflationary ?? null,
    deflationary_p: d.deflationary ?? null, inflationary_p: d.inflationary ?? null,
    hawkish_repricing: extra.hawkish_repricing ?? null,
    // What only a browser knows — the pinned view — is null here, not defaulted: under the log's
    // merge rule a null never overwrites a value, so a cron row cannot erase the client's pin.
    live_regime: snap.liveRegimeId, view_regime: extra.view_regime ?? null, pinned: extra.pinned ?? null,
    hyg_chg: extra.hyg_chg ?? null, hyg_qqq_divergence: extra.hyg_qqq_divergence ?? null,
    inputs: {
      weightedRecessionProb: snap.recWeightedAvg, cpi: snap.cpiForRegime, kalshi2027: snap.recKalshi2027,
      tape: extra.tape ?? null, ladderSpread: extra.ladderSpread ?? null,
      u3: snap.laborView?.u3?.value ?? null, empPop: snap.laborView?.empPop?.value ?? null,
      oas: null, tenY: null, twoY: null,
      ...(extra.inputs || {}),
      consensusAlive: snap.regimeVintage?.alive ?? null, regimeVintage: snap.regimeVintage?.grade ?? null,
    },
    source,
  };
}
