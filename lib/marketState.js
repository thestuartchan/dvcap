// lib/marketState.js — ONE market state, measured from the data, read by every tab.
//
// WHY THIS REPLACES WHAT CAME BEFORE. The dashboard carried sixteen overlapping "state" systems.
// The one that sized positions ("Stagflation 65%") was a lookup on strategists' recession odds —
// a lower recession probability produced MORE stagflation, and no market price entered it. This
// module answers three questions, each on its own clock, from measured inputs only:
//
//   REGIME      where growth and inflation are heading (weeks → months). The two measured axes in
//               lib/quadrant.js, turned from signs into scores, into probabilities over the four
//               quadrants, with the direction of travel.
//   CONDITIONS  how much risk the system will carry (days → weeks). One 0–100 stress score from
//               credit, rates vol, real yields, equity vol, funding, the dollar and breadth, each
//               component shown with its own contribution.
//   POLICY      whether the Fed is adding or removing fuel: the statement stance, what the futures
//               price, and net liquidity (Fed assets − TGA − reverse repo).
//
// The strategists' view is not an input. The Street tab shows it beside this as a cross-check.
//
// PURE: every function here is a function of its arguments. The inputs are fetched by
// lib/marketStateFeed.js (server) and the indicators payload (lib/quadrant.js measuredAxes).
import { REGIME_SIZING, CONDITION_SIZING } from './sizing.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const r0 = (v) => v == null ? null : Math.round(v);
const r1 = (v) => v == null ? null : +v.toFixed(1);
const r2 = (v) => v == null ? null : +v.toFixed(2);

// ── SERIES HELPERS ───────────────────────────────────────────────────────────
// Series are ascending [{date, value}]. Components read every series AS OF ONE DATE (`upTo`): FRED
// and Yahoo keep different calendars, and trimming each series by a count of observations put the
// credit reading of one day next to the VIX of another — early in the calibration they were weeks
// apart. A null date means "everything".
export const upTo = (s, date) => (!Array.isArray(s) ? [] : date == null ? s : s.filter(o => o.date <= date));
export const trim = (s, back = 0) => (Array.isArray(s) ? (back > 0 ? s.slice(0, Math.max(0, s.length - back)) : s) : []);
export const last = (s) => (s && s.length ? s[s.length - 1] : null);
export const ago = (s, n) => (s && s.length > n ? s[s.length - 1 - n] : null);
// Percentile rank of v within the series (0–100), mid-rank: ties count half. Without that, a
// gauge that has not moved at all read as its own 100th percentile.
export function pctRank(s, v) {
  const vals = (s || []).map(o => o.value).filter(Number.isFinite);
  if (!vals.length || v == null) return null;
  const below = vals.filter(x => x < v).length, tied = vals.filter(x => x === v).length;
  return ((below + tied / 2) / vals.length) * 100;
}
// Value of a series on or before a date.
export function onOrBefore(s, date) {
  let hit = null;
  for (const o of s || []) { if (o.date <= date) hit = o; else break; }
  return hit;
}

// ── CONDITIONS ───────────────────────────────────────────────────────────────
// Each component returns { score 0–100 (higher = more stress), read, facts, asOf } or null when
// its inputs are missing. Scores blend WHERE a gauge is (its two-year percentile) with HOW FAST it
// is moving, because stress announces itself in the speed long before the level: HY OAS at 3.02%
// is a low level and +36bp in five sessions is a fast move, and the second is the news.
export const CONDITION_WEIGHTS = Object.freeze({
  credit: 0.25, equityVol: 0.20, ratesVol: 0.15, realYield: 0.15, funding: 0.10, breadth: 0.10, dollar: 0.05,
});
export const CONDITION_LABEL = Object.freeze({
  credit: 'Credit', equityVol: 'Equity vol', ratesVol: 'Rates vol', realYield: 'Real yields',
  funding: 'Funding', breadth: 'Breadth', dollar: 'Dollar',
});
// CALIBRATED on two years of daily history (Sep 2024 – Sep 2026, 471 sessions): median 41, 90th
// percentile 65, 97th 75. The April 2025 tariff crash peaked at 91 and the March 2026 oil shock at
// 84 — the only two Crisis episodes; the December 2024 hawkish Fed day reached 74. So Calm is
// about the quieter half of days, Stress the top ~6%, Crisis the top ~2%.
export const BANDS = Object.freeze([
  { id: 'calm',    label: 'Calm',    max: 45 },
  { id: 'caution', label: 'Caution', max: 70 },
  { id: 'stress',  label: 'Stress',  max: 82 },
  { id: 'crisis',  label: 'Crisis',  max: Infinity },
]);
export const STRESS_AT = 70;
// The conditions score as stored, banded and shown: one decimal, cut toward zero (scores are 0–100).
export const conditionsScore = (v) => (v == null ? null : Math.floor(v * 10 + 1e-9) / 10);
export const bandOf = (score) => score == null ? null : BANDS.find(b => score < b.max);

const blend = (level, speed) => (level == null ? speed : speed == null ? level : 0.5 * level + 0.5 * speed);
const sgn = (v, d = 0) => v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;

export function creditComponent(S, date = null) {
  const hy = upTo(S.hyOas, date), ig = upTo(S.igOas, date);
  const now = last(hy), then = ago(hy, 5);
  if (!now) return null;
  const pct = pctRank(hy, now.value);
  const chg = then ? (now.value - then.value) * 100 : null;          // bp over 5 sessions
  const score = clamp(blend(pct, chg == null ? null : clamp(50 + chg * 1.25)));
  const igNow = last(ig), igThen = ago(ig, 5);
  const igChg = igNow && igThen ? (igNow.value - igThen.value) * 100 : null;
  return {
    score: r0(score), asOf: now.date,
    facts: { hyOas: r2(now.value), hyChg5Bp: r0(chg), hyPctile: r0(pct), igOas: r2(igNow?.value ?? null), igChg5Bp: r0(igChg) },
    read: `HY OAS ${now.value.toFixed(2)}% (${r0(pct)}th percentile, 2y), ${sgn(chg)}bp over 5 sessions`
      + (igNow ? `; IG ${igNow.value.toFixed(2)}% (${sgn(igChg)}bp)` : ''),
  };
}

export function ratesVolComponent(S, date = null) {
  const m = upTo(S.move, date);
  const now = last(m), then = ago(m, 5);
  if (!now) return null;
  const pct = pctRank(m, now.value);
  const chgPct = then ? (now.value / then.value - 1) * 100 : null;
  const score = clamp(blend(pct, chgPct == null ? null : clamp(50 + chgPct * 1.5)));
  return {
    score: r0(score), asOf: now.date,
    facts: { move: r1(now.value), moveChg5Pct: r1(chgPct), movePctile: r0(pct) },
    read: `MOVE ${now.value.toFixed(1)} (${r0(pct)}th percentile), ${sgn(chgPct, 1)}% over 5 sessions`,
  };
}

export function realYieldComponent(S, date = null) {
  const s = upTo(S.realYield, date);
  const now = last(s), then = ago(s, 40);
  if (!now) return null;
  const pct = pctRank(s, now.value);
  const chg = then ? (now.value - then.value) * 100 : null;          // bp over ~2 months
  const score = clamp(blend(pct, chg == null ? null : clamp(50 + chg * 0.6)));
  return {
    score: r0(score), asOf: now.date,
    facts: { realYield: r2(now.value), realChg40Bp: r0(chg), realPctile: r0(pct) },
    read: `10Y real ${now.value.toFixed(2)}% (${r0(pct)}th percentile), ${sgn(chg)}bp over ~2 months`,
  };
}

// VIX over VIX3M: under ~0.85 is deep contango (calm), 1.0 and above is backwardation (stress).
export function equityVolComponent(S, date = null) {
  const v = upTo(S.vix, date), v3 = upTo(S.vix3m, date), v9 = upTo(S.vix9d, date);
  const now = last(v);
  if (!now) return null;
  const pct = pctRank(v, now.value);
  const back3 = onOrBefore(v3, now.date);
  const ratio = back3 && back3.value > 0 ? now.value / back3.value : null;
  const ts = ratio == null ? null : clamp(((ratio - 0.85) / 0.20) * 100);
  const score = clamp(blend(pct, ts));
  const nine = onOrBefore(v9, now.date);
  return {
    score: r0(score), asOf: now.date,
    facts: { vix: r2(now.value), vix3m: r2(back3?.value ?? null), vix9d: r2(nine?.value ?? null), ratio: r2(ratio), vixPctile: r0(pct),
             structure: ratio == null ? null : ratio >= 1 ? 'backwardation' : ratio >= 0.95 ? 'flat' : 'contango' },
    read: `VIX ${now.value.toFixed(1)} (${r0(pct)}th percentile)` + (ratio == null ? '' : `, ${ratio >= 1 ? 'backwardated' : ratio >= 0.95 ? 'flat' : 'contango'} vs 3-month (${ratio.toFixed(2)})`),
  };
}

// SOFR over EFFR, 5-day average so a quarter-end print alone does not read as a funding squeeze.
export function fundingComponent(S, date = null) {
  const so = upTo(S.sofr, date), ef = upTo(S.effr, date);
  if (!so.length || !ef.length) return null;
  const spreads = [];
  for (const o of so.slice(-8)) { const e = onOrBefore(ef, o.date); if (e) spreads.push({ date: o.date, bp: (o.value - e.value) * 100 }); }
  const recent = spreads.slice(-5);
  if (!recent.length) return null;
  const avg = recent.reduce((a, x) => a + x.bp, 0) / recent.length;
  const res = upTo(S.reserves, date), resNow = last(res), res4 = ago(res, 4);
  // WRESBAL is published in $ millions; the change is carried in $ billions.
  const resChg = resNow && res4 ? (resNow.value - res4.value) / 1000 : null;
  const score = clamp(30 + avg * 10 + (resChg != null && resChg < -150 ? 10 : 0));
  return {
    score: r0(score), asOf: recent[recent.length - 1].date,
    facts: { sofrEffr5Bp: r1(avg), reservesBn: r0(resNow ? resNow.value / 1000 : null), reservesChg4w: r0(resChg) },
    read: `SOFR − EFFR ${sgn(avg, 1)}bp (5-day avg)` + (resNow ? `; reserves $${(resNow.value / 1e6).toFixed(2)}T, ${sgn(resChg)}bn over 4 weeks` : ''),
  };
}

export function dollarComponent(S, date = null) {
  const d = upTo(S.dxy, date);
  const now = last(d), then = ago(d, 20);
  if (!now || !then) return null;
  const chg = (now.value / then.value - 1) * 100;
  return {
    score: r0(clamp(50 + chg * 20)), asOf: now.date,
    facts: { dxy: r2(now.value), dxyChg20Pct: r2(chg) },
    read: `DXY ${now.value.toFixed(2)}, ${sgn(chg, 2)}% over 20 sessions`,
  };
}

// Equal-weight vs cap-weight and small vs large: narrowing leadership reads as stress building.
export function breadthComponent(S, date = null) {
  const spy = upTo(S.spy, date), rsp = upTo(S.rsp, date), iwm = upTo(S.iwm, date);
  const ratioChg = (a) => {
    const n = last(a), t = ago(a, 20);
    if (!n || !t) return null;
    const sn = onOrBefore(spy, n.date), st = onOrBefore(spy, t.date);
    if (!sn || !st) return null;
    return ((n.value / sn.value) / (t.value / st.value) - 1) * 100;
  };
  const eq = ratioChg(rsp), sm = ratioChg(iwm);
  const parts = [eq, sm].filter(v => v != null);
  if (!parts.length) return null;
  const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
  return {
    score: r0(clamp(50 - avg * 6)), asOf: last(spy)?.date ?? null,
    facts: { rspSpyChg20Pct: r1(eq), iwmSpyChg20Pct: r1(sm) },
    read: `Equal-weight vs cap-weight ${sgn(eq, 1)}%, small vs large ${sgn(sm, 1)}% over 20 sessions`,
  };
}

const COMPONENTS = Object.freeze({
  credit: creditComponent, equityVol: equityVolComponent, ratesVol: ratesVolComponent, realYield: realYieldComponent,
  funding: fundingComponent, breadth: breadthComponent, dollar: dollarComponent,
});
export const MIN_COMPONENTS = 4;

// The composite at one point in time (`back` sessions ago). Weights renormalise over the
// components that read; fewer than MIN_COMPONENTS is no read at all.
// The calendar the history steps along: the equity-vol series (every trading day), else HY OAS.
export const calendarOf = (S = {}) => ((S.vix && S.vix.length) ? S.vix : (S.hyOas || []));
export function conditionsAt(S = {}, back = 0) {
  const cal = calendarOf(S);
  const date = back > 0 ? (cal[cal.length - 1 - back]?.date ?? null) : null;
  if (back > 0 && !date) return { score: null, band: null, components: {}, present: 0, date: null };
  const comps = {};
  for (const [k, fn] of Object.entries(COMPONENTS)) {
    const c = fn(S, date);
    if (c && c.score != null) comps[k] = { ...c, weight: CONDITION_WEIGHTS[k], label: CONDITION_LABEL[k] };
  }
  const present = Object.values(comps);
  if (present.length < MIN_COMPONENTS) return { score: null, band: null, components: comps, present: present.length, date };
  const w = present.reduce((a, c) => a + c.weight, 0);
  const score = present.reduce((a, c) => a + c.score * c.weight, 0) / w;
  for (const c of present) c.contribution = r1((c.score * c.weight) / w);
  // ONE NUMBER, TO ONE DECIMAL. The band used to be read from the unrounded score while the page
  // and the trigger cards used the rounded one, so 69.6 printed "70 · Caution" in the header and
  // "70 → 70 · TRIGGERED" on the stress card at the same time. The score is rounded once, here, and
  // that value is what is banded, compared with every trigger, and shown. TRUNCATED, not rounded:
  // rounding put 69.96 at 70.0 and into stress before the score had reached the line. Cutting to
  // a tenth never crosses a band or a trigger the exact score has not crossed.
  const s1 = conditionsScore(score);
  return { score: s1, band: bandOf(s1), components: comps, present: present.length, date: date ?? last(calendarOf(S))?.date ?? null };
}

// Today, five sessions ago, and a short history for the sparkline and the recovery test.
export function conditions(S = {}, { history = 40 } = {}) {
  const now = conditionsAt(S, 0);
  const hist = [];
  for (let b = history - 1; b >= 0; b--) {
    const c = conditionsAt(S, b);
    if (c.score != null && c.date) hist.push({ date: c.date, score: c.score });
  }
  const weekAgo = hist.length > 5 ? hist[hist.length - 6].score : null;
  const peak20 = hist.slice(-20).reduce((m, h) => Math.max(m, h.score), -Infinity);
  const change5 = now.score != null && weekAgo != null ? r1(now.score - weekAgo) : null;
  return {
    ...now, weekAgo, change5, peak20: Number.isFinite(peak20) ? peak20 : null, history: hist,
    trend: change5 == null ? null : change5 >= 5 ? 'rising' : change5 <= -5 ? 'easing' : 'steady',
  };
}

// ── LIQUIDITY ────────────────────────────────────────────────────────────────
// Net liquidity = Fed assets ($mn → $bn) − TGA − reverse repo, at the latest weekly date the three
// share, and its four-week change. Draining means the system is losing reserves to the Treasury or
// the RRP; adding means the reverse.
export function liquidity(S = {}) {
  const fa = S.fedAssets || [];
  if (!fa.length) return null;
  const at = (i) => {
    const f = fa[i];
    if (!f) return null;
    const t = onOrBefore(S.tga, f.date), r = onOrBefore(S.rrp, f.date);
    if (!t || !r) return null;
    // WALCL and WTREGEN are published in $ millions, RRPONTSYD in $ billions.
    return { date: f.date, net: f.value / 1000 - t.value / 1000 - r.value, fed: f.value / 1000, tga: t.value / 1000, rrp: r.value };
  };
  const now = at(fa.length - 1), then = at(fa.length - 5);
  if (!now) return null;
  const chg4w = then ? now.net - then.net : null;
  return {
    asOf: now.date, net: r0(now.net), chg4w: r0(chg4w), fed: r0(now.fed), tga: r0(now.tga), rrp: r0(now.rrp),
    impulse: chg4w == null ? null : chg4w >= 100 ? 'adding' : chg4w <= -100 ? 'draining' : 'flat',
  };
}

// ── POLICY ───────────────────────────────────────────────────────────────────
// The statement stance is kept by hand (App's FED_LANGUAGE_STATUS); the pricing comes from the ZQ
// strip (lib/fedpath.js nextMeetingOdds); liquidity from above.
const STANCE = { active_tightening: 'tightening', hawkish_hold: 'tightening', hawkish_tilt: 'holding', neutral: 'holding', dovish_tilt: 'holding', active_easing: 'easing' };
export function policy({ stance = null, stanceAsOf = null, next = null, liquidity: liq = null } = {}) {
  const dir = STANCE[stance] || (stance ? 'holding' : null);
  return {
    stance: dir, stanceRaw: stance, stanceAsOf,
    // lib/fedpath.js nextMeetingOdds names them hikePct / cutPct.
    next: next ? { meeting: next.meeting ?? next.date ?? null, hikeOdds: num(next.hikeOdds ?? next.hikePct), cutOdds: num(next.cutOdds ?? next.cutPct),
                   moves: num(next.moves), asOf: next.asOf ?? null } : null,
    liquidity: liq,
  };
}

// ── REGIME ───────────────────────────────────────────────────────────────────
// Each axis has three legs of different speed (lib/quadrant.js). A leg's score is its net lean
// over its usable inputs, in [−1, 1]. The axis LEVEL weights the faster legs more, because the
// market leads the surveys by weeks and the surveys lead the printed data by more; the DRIFT is the
// fast leg minus the slow one — which way the axis is turning. Probabilities come from the level
// with an uncertainty that widens when the legs disagree.
export const LEG_WEIGHTS = Object.freeze({
  growth: { market: 0.45, weekly: 0.35, monthly: 0.20 },
  inflation: { market: 0.45, nowcast: 0.35, printed: 0.20 },
});
export const QUADRANTS = Object.freeze({
  ref:  { id: 'ref',  label: 'Reflationary growth', short: 'Reflation' },
  inf:  { id: 'inf',  label: 'Inflationary boom',   short: 'Inflationary boom' },
  stag: { id: 'stag', label: 'Stagflation',         short: 'Stagflation' },
  def:  { id: 'def',  label: 'Deflationary bust',   short: 'Deflationary bust' },
});
const quadrantOf = (g, i) => (g >= 0 ? (i >= 0 ? 'inf' : 'ref') : (i >= 0 ? 'stag' : 'def'));

export function legScore(p) {
  if (!p || p.lean == null || !(p.usable > 0) || p.score == null) return null;
  return Math.max(-1, Math.min(1, p.score / p.usable));
}

// Standard normal CDF (Abramowitz–Stegun 7.1.26 through erf).
export function phi(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export function axisScore(pulses = {}, weights = {}) {
  const legs = Object.entries(weights).map(([k, w]) => ({ k, w, s: legScore(pulses[k]) })).filter(x => x.s != null);
  if (!legs.length) return null;
  const W = legs.reduce((a, x) => a + x.w, 0);
  const level = legs.reduce((a, x) => a + x.s * x.w, 0) / W;
  const keys = Object.keys(weights);
  const fast = legs.find(x => x.k === keys[0]), slow = legs.find(x => x.k === keys[keys.length - 1]);
  const drift = fast && slow ? fast.s - slow.s : 0;
  const mean = legs.reduce((a, x) => a + x.s, 0) / legs.length;
  const disp = Math.sqrt(legs.reduce((a, x) => a + (x.s - mean) ** 2, 0) / legs.length);
  return { level: r2(level), drift: r2(drift), dispersion: r2(disp), legs: Object.fromEntries(legs.map(x => [x.k, r2(x.s)])), usable: legs.length };
}

export function regime(axes = null) {
  const g = axisScore(axes?.growth?.pulses, LEG_WEIGHTS.growth);
  const i = axisScore(axes?.inflation?.pulses, LEG_WEIGHTS.inflation);
  if (!g || !i) return { available: false, reason: !g ? 'growth axis has no usable leg' : 'inflation axis has no usable leg' };
  const sg = 0.30 + 0.30 * g.dispersion, si = 0.30 + 0.30 * i.dispersion;
  const pg = phi(g.level / sg), pi = phi(i.level / si);
  const raw = { ref: pg * (1 - pi), inf: pg * pi, stag: (1 - pg) * pi, def: (1 - pg) * (1 - pi) };
  // Whole percentages that sum to 100: largest remainders get the leftover points.
  const floors = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Math.floor(v * 100)]));
  let left = 100 - Object.values(floors).reduce((a, b) => a + b, 0);
  for (const [k] of Object.entries(raw).sort((a, b) => (b[1] * 100 % 1) - (a[1] * 100 % 1))) { if (left <= 0) break; floors[k] += 1; left -= 1; }
  const probs = floors;
  const top = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  const id = top[0][0];
  // Where the drift points: the quadrant the axes reach if the fast legs are right.
  const toward = quadrantOf(g.level + g.drift, i.level + i.drift);
  const drifting = toward !== id && (Math.abs(g.drift) >= 0.5 || Math.abs(i.drift) >= 0.5) ? toward : null;
  // A top probability within ten points of the next is not a regime; the headline says so and
  // describes the axes instead of naming a quadrant the data does not support.
  const contested = top[0][1] - top[1][1] < 10;
  const words = axisWords(g, i);
  const lead = contested ? 'Between regimes' : QUADRANTS[id].short;
  return {
    available: true, id, label: QUADRANTS[id].label, probs, growth: g, inflation: i, drifting, contested, words,
    headline: lead + (drifting ? `, drifting toward ${QUADRANTS[drifting].short.toLowerCase()}` : ''),
  };
}

// Plain words for an axis: where it is, and which way its fast leg is pulling.
export function axisWords(g, i) {
  const gw = g.level > 0.25 ? 'firm' : g.level < -0.25 ? 'weakening' : 'flat';
  const gt = g.drift <= -0.5 ? ' and turning down' : g.drift >= 0.5 ? ' and turning up' : '';
  const iw = i.level > 0.25 ? 'hot' : i.level < -0.25 ? 'cool' : 'steady';
  const it = i.drift >= 0.5 ? ' and heating' : i.drift <= -0.5 ? ' and cooling' : '';
  return { growth: `growth ${gw}${gt}`, inflation: `inflation ${iw}${it}` };
}

// ── SIZING ───────────────────────────────────────────────────────────────────
// The regime multiplier is the EXPECTED multiplier over the quadrant probabilities, so a close call
// sizes between the two cases instead of jumping when the top one flips. Conditions multiply it.
// One table, in lib/sizing.js beside the regime multipliers it scales.
export { CONDITION_SIZING };
export function sizing(state, { regimeSizing = REGIME_SIZING } = {}) {
  const probs = state?.regime?.available ? state.regime.probs : null;
  // Normalised by the probabilities' own sum, as lib/sizing.js regimeMultiplier does — rounded
  // percentages need not add to exactly 100, and the two figures must not differ by that.
  const W = probs ? Object.values(probs).reduce((a, p) => a + (+p || 0), 0) : 0;
  const regimeMult = probs && W > 0
    ? Object.entries(probs).reduce((a, [k, p]) => a + (regimeSizing[k]?.mult ?? 0.6) * (+p || 0) / W, 0)
    : null;
  const band = state?.conditions?.band?.id ?? null;
  const condMult = band ? CONDITION_SIZING[band] : null;
  const total = regimeMult != null && condMult != null ? regimeMult * condMult : regimeMult ?? condMult;
  return { regimeMult: r2(regimeMult), condMult, total: r2(total), band };
}

// ── STAGE ── the ONE derivation (Posture, Indicators and the Console used to compute their own).
export const STAGES = Object.freeze([
  { n: 1, id: 'surveil',  label: 'Surveillance',          plan: 'Signals in normal range. Hold the plan; no new hedges.' },
  { n: 2, id: 'insure',   label: 'Accumulate insurance',  plan: 'Build hedges while they are cheap; trim leverage; no new aggressive adds.' },
  { n: 3, id: 'defend',   label: 'Insurance active',      plan: 'Hedges on at full size; gross exposure down; adds only from cash.' },
  { n: 4, id: 'deploy',   label: 'Deploy',                plan: 'Stress easing from a peak: redeploy cash in tranches, roll hedges off.' },
]);
export function stage(state) {
  const c = state?.conditions;
  if (!c || c.score == null) return null;
  // Deploy only after a real stress episode that is now easing: a 20-session peak in Stress or
  // worse, and the score down at least 15 from it.
  if (c.peak20 != null && c.peak20 >= STRESS_AT && c.score <= c.peak20 - 15 && c.trend === 'easing') return STAGES[3];
  if (c.band.id === 'stress' || c.band.id === 'crisis') return STAGES[2];
  if (c.band.id === 'caution') return STAGES[1];
  return STAGES[0];
}

// ── HEDGE PHASE ── for the Hedges tab's crash guide, from the conditions layer rather than a pick.
export function hedgePhase(state) {
  const c = state?.conditions;
  if (!c || c.score == null) return null;
  const inverted = (c.components?.equityVol?.facts?.ratio ?? 0) >= 1;
  if (c.peak20 != null && c.peak20 >= STRESS_AT && c.score <= c.peak20 - 15) return { id: 'recovery', why: `conditions easing from a ${c.peak20} peak to ${c.score}` };
  if ((c.band.id === 'stress' || c.band.id === 'crisis') && inverted) return { id: 'liquidity', why: `${c.band.label} with the VIX curve inverted` };
  return { id: 'preCrash', why: `${c.band.label}${c.trend ? `, ${c.trend}` : ''} — hedges are still priced for calm` };
}

// ── IF / THEN ────────────────────────────────────────────────────────────────
// ── THE PLAYBOOKS ────────────────────────────────────────────────────────────
// What to do as each trigger APPROACHES, decided in advance — the one-line plan (`plan`) said only
// what to do once it hit, the same sentence at 10% and at 99%. Five stages, keyed to proximity:
//   prep (60–84%)    decide: the cut list, the stops, the hedge priced
//   arm (85–99%)     pre-position: partial cuts, half the hedge
//   triggered (100%) execute in full
//   spec             an opportunistic trade beside the triggered stage — small, and labelled so
//   unwind           what reverses it, and in how many tranches
// Sizes are against the standing limits (lib/leverage.js BOOK_LIMITS: target 1.0×, position
// ≤ 1.2× + swing ≤ 0.3×, ceiling 1.5×). GENERIC ON PURPOSE: this module ships in the page's script,
// which is reachable without the login, so no holding is named here. The dashboard lays the live
// book beside each playbook from the Console's own summary, which only exists after login.
export const STAGE_AT = Object.freeze({ prep: 60, arm: 85, triggered: 100 });
export const STAGE_LABEL = Object.freeze({ watch: 'Watch', prep: 'Prep', arm: 'Arm', triggered: 'Triggered', spec: 'Speculative', unwind: 'Unwind' });
export const stageOf = (proximity) => (proximity == null ? 'watch' : proximity >= STAGE_AT.triggered ? 'triggered'
  : proximity >= STAGE_AT.arm ? 'arm' : proximity >= STAGE_AT.prep ? 'prep' : 'watch');

// ── THE INSTRUMENT MENU (8 Oct) ── the instruments Stu picked from the ranked menu of 7 Oct, by
// job. The playbooks below use these and nothing else; each names its kit by code. Instruments, not
// holdings: nothing here says what is held or how much.
export const INSTRUMENTS = Object.freeze({
  A1: 'SPY put spreads', A2: 'QQQ put spreads', A3: 'MNQ / MES short', A4: 'XSP options (cash-settled, European)',
  B1: 'SMH put spreads', B2: 'QQQ vs RSP pair', B4: 'SOXS (days only)',
  C1: 'Bills: USFR / SGOV / BIL', C2: 'IEF', C3: 'TLT and TLT spreads', C4: 'ZN / micro 10Y yield futures', C5: 'IB01 (London bills)', C6: 'TMF / TBT (tactical, days only)',
  D1: 'Micro 2Y vs 10Y yield futures', D2: 'ZT vs ZN, duration-matched',
  E1: 'Yen futures and options (6J)', E2: 'UUP / UDN', E4: 'M6E micro euro',
  F1: 'VIX call spreads', F3: 'Short SPY put spreads (income)',
  G1: 'HYG put spreads', G2: 'HYG vs IEF pair',
  H1: 'Gold futures (MGC; 1OZ for smaller steps)', H2: 'XLE and XLE calls', H3: 'Oil: MCL / BNO', H4: 'GLDM / GLD', H5: 'GDX', H6: 'Copper: micro futures / COPX',
  I1: 'XLF / KRE', I2: 'RSP', I3: 'IWM', I4: 'Defensives: XLP / XLU / XLV', I6: 'Pipelines (AMLP)',
  J1: 'EWY', J3: 'FXI / KWEB',
  K1: 'IBIT', K2: 'ETHA',
});

export const PLAYBOOKS = Object.freeze({
  toStress: {
    kit: ['A1', 'A2', 'A3', 'A4', 'B1', 'B4', 'C1', 'C5', 'F1', 'F3', 'G1'],
    prep: ['No adds to anything that is down (the 27 Aug rule).',
           'Keep gross inside the limits: position ≤ 1.2×, swing ≤ 0.3×.',
           'Price the hedge now: an SPY put spread (or XSP, cash-settled with no early assignment), ~90 days, strikes ~5% and ~12% below spot, ≈1% of NLV in premium. A tech-heavy book prices the QQQ spread beside it. Count any index protection already held.'],
    arm: ['Gross down to 1.1×: trim the swing with the worst R first.',
          'Buy half the hedge. For overnight speed, an MNQ or MES short covers the gap until the spread is on.',
          'AI concentration: price an SMH put spread, ~60 days — it hedges the chip complex, not one name.',
          'Day trades at half size.'],
    triggered: ['Gross capped at 1.0× NLV; pause every add.',
                'Complete the hedge (the second half). If credit is leading, add an HYG put spread, ~60 days.',
                'New swings only at 3R or better.',
                'Idle cash in the shortest bills (USFR / SGOV / BIL, or IB01 in London), not in duration.'],
    spec: ['When VIX ÷ VIX3M first crosses 1.0, buy a 60-day VIX call spread for ≈0.3–0.5% of NLV — convexity bought before it is expensive.',
           'If SMH breaks below its 60-day range while the index holds, SOXS for days, not weeks — it decays.'],
    unwind: ['When Relief triggers: let hedges roll off rather than rebuying; take gross back to 1.0× in two tranches a week apart; then sell 30–45-day SPY put spreads against cash for income.'],
  },
  hawkish: {
    kit: ['A2', 'A3', 'B2', 'C1', 'C3', 'C4', 'C6', 'D1', 'D2', 'E1', 'E2', 'I1'],
    prep: ['No new swings in long-duration growth; new risk only in short-duration sectors (energy, banks, value).',
           'Set the stop on every high-multiple position at its 20-day low, so the cut list exists before the trigger does.',
           'Cash stays in the shortest bills — no extension into IEF or TLT.'],
    arm: ['Halve the weakest high-multiple swing (the one furthest below its 20-day average).',
          'Pre-place a hedge: MNQ short ≈0.1× NLV notional, stopped above the prior day’s high — or a QQQ put spread, ~30 days, 5% out of the money.',
          'If the index is held up by a few giants, the QQQ vs RSP pair (short QQQ, long RSP) hedges the concentration rather than the market.',
          'Yen longs fight a hawkish Fed (dollar bid): first in line to close. UUP is the simple dollar-up leg.'],
    triggered: ['Swing bucket capped at 0.15× (half its 0.3× limit); high-multiple growth to half weight.',
                'Curve flattener: micro 2-year vs 10-year yield futures, short the 2-year leg — or ZT vs ZN, duration-matched, for size.',
                'New equity risk in banks (XLF / KRE) over tech.',
                'TBT for days if the 10-year breaks out — tactical only.'],
    spec: ['Fade the overshoot: when the 10Y real prints ≥ 3.10% with hike odds above 80%, buy a 30–45-day TLT call spread (or ZN calls) for ≈1% of NLV. Invalid if real yields keep rising after the FOMC.'],
    unwind: ['10Y real back under 2.85% and hike odds under 50%: cover the hedges, restore growth weights in two tranches a week apart.'],
  },
  inflationUp: {
    kit: ['C1', 'C3', 'C6', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'I6'],
    prep: ['Stop extending duration; keep cash in bills.',
           'List the long-duration tech positions and their stops.',
           'Price the inflation legs: gold (GLDM for the core; gold futures for round-the-clock trading), 90-day XLE calls, micro WTI (MCL).'],
    arm: ['Start a real-asset sleeve at ≈0.05× NLV: gold (GLDM, or 1-ounce gold futures in small steps) and energy (XLE).',
          'Trim long-duration tech by a quarter.'],
    triggered: ['Real assets to ≈0.1× NLV: gold, energy (XLE or XLE calls), oil (MCL or BNO).',
                'Short duration: a TLT put spread, or simply no bonds; TBT for days only.',
                'Pipelines (AMLP) for income that rises with prices.',
                'Long-duration tech at half weight; no new adds there.'],
    spec: ['If the 5Y breakeven rises 15bp in a week, buy a 60-day XLE call spread; GDX is the higher-beta gold leg; copper (micro futures or COPX) is the growth-confirming second leg.'],
    unwind: ['Inflation axis back under 0: halve the real-asset sleeve and keep gold as the core.'],
  },
  growthRolls: {
    kit: ['A1', 'C1', 'H1', 'H4', 'I3', 'I4', 'I6'],
    prep: ['No new cyclical swings; sizing heads toward the stagflation multiplier.',
           'Price the landing spots: gold (GLDM; gold futures for size) and income (pipelines, AMLP; bills).'],
    arm: ['Trim long-duration growth by a quarter; cut the cyclicals with the weakest breadth.',
          'Gold to ≈0.05× NLV.'],
    triggered: ['Sizing at the stagflation multiplier; gold to ≈0.1× NLV; income toward bills and pipelines.',
                'Long-duration growth at half weight; defensives (XLP / XLU / XLV) for any new equity risk.',
                'Index hedge on: an SPY put spread, ~90 days.'],
    spec: ['Pair the cycle: long defensives (XLV or XLP) against small caps (IWM), ≈0.05× NLV a side.'],
    unwind: ['Growth axis back above 0: restore cyclicals in tranches; keep gold until the inflation axis cools too.'],
  },
  growthBust: {
    kit: ['A1', 'C1', 'C2', 'C3', 'C4', 'C6', 'D1', 'D2', 'E1', 'G1', 'G2'],
    prep: ['Stop shortening duration; price IEF / TLT (or ZN) as the hedge.',
           'List the cyclical and credit-sensitive positions.'],
    arm: ['Start duration: IEF ≈0.1× NLV.', 'Cut the most cyclical swing.',
          'Credit without a rates bet: the HYG vs IEF pair (short HYG, long IEF).'],
    triggered: ['Duration is the hedge: IEF / TLT to ≈0.2× NLV, ZN for precision, or TLT call spreads.',
                'Cyclicals and credit exposure down (HYG put spreads); cash is a position.',
                'Index hedge on: an SPY put spread, ~90 days.',
                'The yen tends to rally in a bust as carry unwinds: yen futures or calls (6J).'],
    spec: ['Curve steepener: long the 2-year against the 10-year with micro yield futures (or ZT vs ZN) — the front end rallies first in a bust. TMF for days only.'],
    unwind: ['Growth axis back above 0: duration back to bills; rebuild cyclicals in tranches.'],
  },
  drain: {
    kit: ['I3', 'I4', 'K1', 'K2'],
    prep: ['No new high-beta risk (crypto, small caps, unprofitable tech) while liquidity falls.'],
    arm: ['Trim the highest-beta swing; any new equity risk in defensives (XLP / XLU / XLV).',
          'Crypto (IBIT / ETHA) at half.'],
    triggered: ['Beta down: swing bucket ≤ 0.2×; high-beta names at half weight.',
                'Keep hedges on — do not let them roll off.',
                'Defensives for any new risk.'],
    spec: ['If net liquidity falls a further $100bn, short the most liquidity-sensitive against the least: IWM vs SPY, or an IBIT put spread.'],
    unwind: ['Net liquidity flat or rising over four weeks: restore beta in two tranches, crypto last.'],
  },
  easing: {
    kit: ['C1', 'C2', 'C3', 'E2', 'E4', 'I1', 'I2', 'I3', 'J1', 'J3', 'K1', 'K2'],
    prep: ['Price the duration extension (bills → IEF) and list the rate-sensitive candidates: small caps (IWM), regional banks (KRE), breadth (RSP).'],
    arm: ['Move a third of idle cash from bills into IEF.', 'Start small caps (IWM) at ≈0.05× NLV.'],
    triggered: ['Two-thirds of idle cash from bills into IEF / TLT.',
                'Add rate-sensitive equities (IWM, KRE, RSP); the swing bucket can use its full 0.3×.',
                'A weaker dollar lifts Asia: EWY, and FXI / KWEB for China.',
                'Let hedges roll off as stress eases.'],
    spec: ['Once the first cut is fully priced, buy a 60-day IWM call spread; dollar down (UDN, or long euro with M6E) is a cheap second leg; crypto (IBIT / ETHA) rebuilds last.'],
    unwind: ['Cut odds back under 30%: return the extension to bills.'],
  },
  relief: {
    kit: ['F3', 'G1', 'G2', 'I2', 'J1', 'J3', 'K1'],
    prep: ['Write the redeploy list: which positions come back first, and in what tranche sizes.'],
    arm: ['Redeploy the first third of parked cash into the strongest setups.', 'Stop buying new protection.'],
    triggered: ['Restore the full regime multiplier; redeploy parked cash in three tranches a week apart.',
                'Roll hedges off rather than rebuying; sell 30–45-day SPY put spreads against cash for income.',
                'Breadth (RSP) and the high-beta rebound (EWY, KWEB) lead a relief rally.'],
    spec: ['Credit re-entry: close the HYG puts, and the HYG vs IEF pair the other way (long HYG) in the first week spreads tighten by 25bp. IBIT when net liquidity turns up.'],
    unwind: ['HY OAS back above 3.20% or MOVE above 105: pause the tranches.'],
  },
});

// The transitions worth preparing for, each with a measured trigger, the live distance to it, and
// the plan decided in advance. Proximity is 0 at the calm reference and 100 at the trigger.
const prox = (v, calm, trig) => (v == null ? null : clamp(((v - calm) / (trig - calm)) * 100));
// How far each gauge is from its trigger, in its own units, and which gauges have a week-ago
// reading to compare with. The conditions components are recomputed five sessions back from the
// same series, so those parts can say whether they moved closer; the regime axes, futures odds and
// liquidity have no stored week-ago read here, and say nothing rather than a fake zero.
// Basis points, never "+0bp to go": a gap under one basis point is still a gap.
const bp = (g) => (g * 100 < 1 ? '<1bp' : `${Math.round(g * 100)}bp`);
const GAP_FMT = {
  'Conditions': g => `${g.toFixed(1)} pt`, 'HY OAS': g => bp(g), 'MOVE': g => g.toFixed(1),
  'VIX / VIX3M': g => g.toFixed(2), 'Growth axis': g => g.toFixed(2), 'Inflation axis': g => g.toFixed(2),
  'Hike odds': g => `${Math.round(g)} pts`, '10Y real': g => bp(g), 'Net liquidity, 4w': g => `$${Math.round(g)}bn`,
  'Cut odds': g => `${Math.round(g)} pts`,
};
export const WEEK_AGO_PARTS = Object.freeze(['Conditions', 'HY OAS', 'MOVE', 'VIX / VIX3M', '10Y real']);

// `prior` is the state five sessions ago (the same regime and policy, the conditions recomputed as
// of then); with it each transition carries how its proximity moved.
export function transitions(state, { prior = null } = {}) {
  const cf = state?.conditions?.components || {};
  const oas = cf.credit?.facts?.hyOas ?? null, move = cf.ratesVol?.facts?.move ?? null;
  const ratio = cf.equityVol?.facts?.ratio ?? null, real = cf.realYield?.facts?.realYield ?? null;
  const g = state?.regime?.growth?.level ?? null, i = state?.regime?.inflation?.level ?? null;
  // Where inflation is heading, not where it sits: a rollover into rising inflation is stagflation.
  const iDest = i == null ? null : i + (state?.regime?.inflation?.drift ?? 0);
  const hike = state?.policy?.next?.hikeOdds ?? null, cut = state?.policy?.next?.cutOdds ?? null;
  const liq = state?.policy?.liquidity?.chg4w ?? null;
  const band = state?.conditions?.band?.id;
  const list = [];
  const push = (t) => { const ps = t.parts.map(p => p.p).filter(p => p != null); if (ps.length) list.push({ ...t, proximity: r0(t.join === 'and' ? Math.min(...ps) : Math.max(...ps)) }); };
  if (band !== 'stress' && band !== 'crisis') push({
    id: 'toStress', title: 'Conditions → Stress', tone: 'bad', join: 'or',
    trigger: `the conditions score at ${STRESS_AT}, HY OAS at 3.50%, MOVE at 120, or the VIX curve inverted`,
    parts: [
      { label: 'Conditions', now: state?.conditions?.score ?? null, at: STRESS_AT, fmt: v => v.toFixed(1), p: prox(state?.conditions?.score ?? null, 45, STRESS_AT) },
      { label: 'HY OAS', now: oas, at: 3.5, fmt: v => `${v.toFixed(2)}%`, p: prox(oas, 2.75, 3.5) },
      { label: 'MOVE', now: move, at: 120, fmt: v => v.toFixed(1), p: prox(move, 85, 120) },
      { label: 'VIX / VIX3M', now: ratio, at: 1.0, fmt: v => v.toFixed(2), p: prox(ratio, 0.85, 1.0) },
    ],
    plan: 'Gross cap to 1.0× NLV; pause adds; open the stage-3 hedge (index put spread, ~90 days); cash yield over duration.',
  });
  if (g != null) push({
    id: 'growthRolls', title: iDest != null && iDest >= 0 ? 'Growth rolls over → Stagflation' : 'Growth rolls over → Deflationary bust', tone: 'warn', join: 'or',
    trigger: 'the growth axis turns negative',
    parts: [{ label: 'Growth axis', now: g, at: -0.25, fmt: v => v.toFixed(2), p: prox(-g, -0.75, 0.25) }],
    plan: iDest != null && iDest >= 0
      ? 'Sizing falls toward the stagflation multiplier; income toward bills and pipelines; add physical gold; trim long-duration growth.'
      : 'Duration becomes the hedge (IEF/TLT); cut cyclicals; credit exposure down; cash is a position.',
  });
  if (i != null) push({
    id: 'inflationUp', title: 'Inflation re-accelerates', tone: 'warn', join: 'or',
    trigger: 'the inflation axis turns positive',
    parts: [{ label: 'Inflation axis', now: i, at: 0.25, fmt: v => v.toFixed(2), p: prox(i, -0.75, 0.25) }],
    plan: 'Short duration; real assets and commodity producers over bonds; avoid long-duration tech; watch for the Fed to lean hawkish.',
  });
  push({
    id: 'hawkish', title: 'Hawkish repricing', tone: 'warn', join: 'or',
    trigger: 'next-meeting hike odds at 70%, or the 10Y real yield at 3.00%',
    parts: [
      { label: 'Hike odds', now: hike, at: 70, fmt: v => `${Math.round(v)}%`, p: prox(hike, 20, 70) },
      { label: '10Y real', now: real, at: 3.0, fmt: v => `${v.toFixed(2)}%`, p: prox(real, 2.2, 3.0) },
    ],
    plan: 'Duration off; cash to the shortest bills; cut high-multiple growth; hedge with a curve flattener rather than index puts.',
  });
  if (liq != null) push({
    id: 'drain', title: 'Liquidity drain', tone: 'warn', join: 'or',
    trigger: 'net liquidity down $200bn over four weeks',
    parts: [{ label: 'Net liquidity, 4w', now: liq, at: -200, fmt: v => `${v >= 0 ? '+' : '−'}$${Math.abs(v)}bn`, p: prox(-liq, 0, 200) }],
    plan: 'Risk assets lose a tailwind: trim beta, favour quality, keep hedges on.',
  });
  if (cut != null) push({
    id: 'easing', title: 'The Fed turns to easing', tone: 'good', join: 'or',
    trigger: 'next-meeting cut odds at 60%',
    parts: [{ label: 'Cut odds', now: cut, at: 60, fmt: v => `${Math.round(v)}%`, p: prox(cut, 0, 60) }],
    plan: 'Extend duration (USFR → IEF), add rate-sensitive equities; the deployment stage becomes available once stress eases.',
  });
  push({
    id: 'relief', title: 'Relief', tone: 'good', join: 'and',
    trigger: 'HY OAS back under 2.80% and MOVE under 90',
    parts: [
      { label: 'HY OAS', now: oas, at: 2.8, fmt: v => `${v.toFixed(2)}%`, p: oas == null ? null : prox(-oas, -3.5, -2.8) },
      { label: 'MOVE', now: move, at: 90, fmt: v => v.toFixed(1), p: prox(move == null ? null : -move, -120, -90) },
    ],
    plan: 'Restore the full regime multiplier; redeploy parked cash in tranches; roll hedges off rather than rebuying them.',
  });
  const was = prior ? Object.fromEntries(transitions(prior).map(t => [t.id, t])) : {};
  return list.map(t => {
    const pw = was[t.id];
    const parts = t.parts.map(p => {
      const proximity = r0(p.p);
      // Met on the exact reading, not the rounded proximity — rounding put a gauge at 99.6% of the
      // way "at trigger", the same disagreement the conditions score had with its own band.
      const met = p.p != null && p.p >= 100;
      const need = p.now == null ? null : p.at - p.now;
      const f = GAP_FMT[p.label] || (g => String(r2(g)));
      const prev = WEEK_AGO_PARTS.includes(p.label) ? pw?.parts?.find(x => x.label === p.label) : null;
      const proximityWas = prev?.proximity ?? null;
      return {
        label: p.label, now: p.now, at: p.at, text: p.now == null ? '—' : p.fmt(p.now), atText: p.fmt(p.at), proximity, met,
        gapText: p.now == null ? null : met ? 'at trigger' : `${need > 0 ? '+' : '−'}${f(Math.abs(need))} to go`,
        proximityWas, delta5: proximity != null && proximityWas != null ? proximity - proximityWas : null,
      };
    });
    // The part that decides it: the closest for an "or", the furthest for an "and".
    const live = parts.filter(p => p.proximity != null);
    const nearest = live.length ? live.reduce((a, p) => (t.join === 'and' ? (p.proximity < a.proximity ? p : a) : (p.proximity > a.proximity ? p : a))) : null;
    // A transition-level change only when every live part has a week-ago read.
    const allKnown = live.length > 0 && live.every(p => p.proximityWas != null);
    const proximityWas = allKnown ? (t.join === 'and' ? Math.min(...live.map(p => p.proximityWas)) : Math.max(...live.map(p => p.proximityWas))) : null;
    const key = t.id === 'growthRolls' && !/Stagflation/.test(t.title) ? 'growthBust' : t.id;
    return { ...t, parts, nearest: nearest ? { label: nearest.label, text: nearest.text, atText: nearest.atText, gapText: nearest.gapText } : null,
      proximityWas, delta5: proximityWas != null ? t.proximity - proximityWas : null,
      stage: stageOf(t.proximity), playbook: PLAYBOOKS[key] || null };
  }).sort((a, b) => b.proximity - a.proximity);
}

// ── PER-SERIES STATS ── for the Drivers tiles: one format for every gauge.
// kind: 'rate' (percent levels, change in bp), 'price' (change in %), 'usd' (levels in $, change
// in the same unit). Changes are over 5 and 20 observations, which for a weekly series is 5 and 20
// weeks — the tile says which.
export const SERIES_META = Object.freeze({
  hyOas: { label: 'HY OAS', kind: 'rate', unit: '%', cadence: 'daily', src: 'ICE BofA via FRED' },
  igOas: { label: 'IG OAS', kind: 'rate', unit: '%', cadence: 'daily', src: 'ICE BofA via FRED' },
  realYield: { label: '10Y real yield', kind: 'rate', unit: '%', cadence: 'daily', src: 'FRED DFII10' },
  breakeven5: { label: '5Y breakeven', kind: 'rate', unit: '%', cadence: 'daily', src: 'FRED T5YIE' },
  // Daily observations, PUBLISHED weekly: FRED posts the week's Kim-Wright values the following
  // Monday/Tuesday (29 Sep carried 21-25 Sep), so a Friday value is routinely 11 days old before the
  // next batch. Freshness is judged on the publishing cadence; the 5/20 changes stay in days.
  termPremium: { label: '10Y term premium', kind: 'rate', unit: '%', cadence: 'daily', published: 'weekly', src: 'Kim-Wright (Fed Board) via FRED' },
  sofr: { label: 'SOFR', kind: 'rate', unit: '%', cadence: 'daily', src: 'FRED' },
  effr: { label: 'EFFR', kind: 'rate', unit: '%', cadence: 'daily', src: 'FRED' },
  rrp: { label: 'Reverse repo', kind: 'usd', unit: '$bn', cadence: 'daily', src: 'FRED RRPONTSYD', scale: 1 },
  tga: { label: 'Treasury account', kind: 'usd', unit: '$bn', cadence: 'weekly', src: 'FRED WTREGEN', scale: 1 / 1000 },
  fedAssets: { label: 'Fed assets', kind: 'usd', unit: '$bn', cadence: 'weekly', src: 'FRED WALCL', scale: 1 / 1000 },
  reserves: { label: 'Bank reserves', kind: 'usd', unit: '$bn', cadence: 'weekly', src: 'FRED WRESBAL', scale: 1 / 1000 },
  move: { label: 'MOVE', kind: 'price', unit: '', cadence: 'daily', src: 'ICE via Yahoo' },
  vix: { label: 'VIX', kind: 'price', unit: '', cadence: 'daily', src: 'Cboe via Yahoo' },
  vix3m: { label: 'VIX 3-month', kind: 'price', unit: '', cadence: 'daily', src: 'Cboe via Yahoo' },
  vix9d: { label: 'VIX 9-day', kind: 'price', unit: '', cadence: 'daily', src: 'Cboe via Yahoo' },
  dxy: { label: 'DXY', kind: 'price', unit: '', cadence: 'daily', src: 'ICE via Yahoo' },
  rsp: { label: 'RSP', kind: 'price', unit: '$', cadence: 'daily', src: 'Yahoo' },
  spy: { label: 'SPY', kind: 'price', unit: '$', cadence: 'daily', src: 'Yahoo' },
  iwm: { label: 'IWM', kind: 'price', unit: '$', cadence: 'daily', src: 'Yahoo' },
});
export function seriesStats(S = {}, { spark = 90 } = {}) {
  const out = {};
  for (const [k, meta] of Object.entries(SERIES_META)) {
    const s = S[k];
    if (!s || !s.length) continue;
    const sc = meta.scale ?? 1;
    const now = last(s), o5 = ago(s, 5), o20 = ago(s, 20);
    const ch = (o) => !o ? null : meta.kind === 'rate' ? r0((now.value - o.value) * 100) : meta.kind === 'price' ? r2((now.value / o.value - 1) * 100) : r0((now.value - o.value) * sc);
    out[k] = {
      ...meta, value: r2(now.value * sc), date: now.date, chg5: ch(o5), chg20: ch(o20),
      chgUnit: meta.kind === 'rate' ? 'bp' : meta.kind === 'price' ? '%' : meta.unit,
      pctile: r0(pctRank(s, now.value)), spark: s.slice(-spark).map(o => r2(o.value * sc)),
    };
  }
  return out;
}

// ── THE STATE ────────────────────────────────────────────────────────────────
// `series` computes conditions and liquidity here; `precomputed` takes them from the server's
// ?state=1 answer so the browser does not have to carry two years of series.
export function computeMarketState({ axes = null, series = null, precomputed = null, stance = null, stanceAsOf = null, next = null, asOf = null } = {}) {
  const condWas = precomputed ? (precomputed.conditionsWeekAgo ?? null) : (series ? conditionsAt(series, 5) : null);
  const cond = precomputed?.conditions ?? (series ? conditions(series) : { score: null, band: null, components: {}, present: 0, history: [] });
  const liq = precomputed ? (precomputed.liquidity ?? null) : (series ? liquidity(series) : null);
  const st = { asOf, regime: regime(axes), conditions: cond, policy: policy({ stance, stanceAsOf, next, liquidity: liq }) };
  st.sizing = sizing(st);
  st.stage = stage(st);
  st.hedgePhase = hedgePhase(st);
  st.transitions = transitions(st, { prior: condWas && condWas.score != null ? { ...st, conditions: condWas } : null });
  const reg = st.regime.available ? st.regime.headline : 'Regime: no read';
  const con = cond.band ? `conditions ${cond.band.label.toLowerCase()}${cond.trend && cond.trend !== 'steady' ? ` and ${cond.trend}` : ''}` : 'conditions: no read';
  st.headline = `${reg} · ${con}`;
  return st;
}

// The compact row the regime log stores beside the old engine's, so the two can be compared day by
// day and the model re-run on what was actually seen.
export function stateLogRow(st) {
  if (!st) return null;
  return {
    regime: st.regime?.available ? { id: st.regime.id, probs: st.regime.probs, g: st.regime.growth.level, gDrift: st.regime.growth.drift,
      i: st.regime.inflation.level, iDrift: st.regime.inflation.drift, drifting: st.regime.drifting } : null,
    conditions: st.conditions?.score != null ? { score: st.conditions.score, band: st.conditions.band.id,
      comps: Object.fromEntries(Object.entries(st.conditions.components).map(([k, c]) => [k, c.score])) } : null,
    policy: { stance: st.policy?.stance ?? null, hikeOdds: st.policy?.next?.hikeOdds ?? null, liq4w: st.policy?.liquidity?.chg4w ?? null },
    sizing: st.sizing?.total ?? null, stage: st.stage?.n ?? null,
  };
}

// ── INFLATION MOMENTUM ── from the index LEVELS (FRED CPILFESL, PCEPILFE), not the y/y series, so
// the short-run trend is visible: month on month, and the 3-month change annualised, beside y/y. A
// y/y that ticks up while the 3-month rate falls is base effects, not re-acceleration — the read
// says "stopped improving" only when the 3-month annualised rate is itself rising.
export const INFLATION_SERIES = Object.freeze({ cpiCore: { key: 'cpiCoreIdx', id: 'CPILFESL', label: 'Core CPI' }, pceCore: { key: 'pceCoreIdx', id: 'PCEPILFE', label: 'Core PCE' } });
export function inflationMomentum(S = {}) {
  const out = {};
  for (const [name, meta] of Object.entries(INFLATION_SERIES)) {
    const s = (S[meta.key] || []).filter(o => Number.isFinite(o.value));
    if (s.length < 13) { out[name] = null; continue; }
    const at = (i) => s[s.length - 1 - i];
    const yearAgo = (o) => s.find(x => x.date === `${+o.date.slice(0, 4) - 1}${o.date.slice(4)}`);
    const ann3 = (i) => { const a = at(i), b = at(i + 3); return a && b ? ((a.value / b.value) ** 4 - 1) * 100 : null; };
    const now = at(0), ya = yearAgo(now);
    const a3 = ann3(0), a3p = ann3(1);
    out[name] = {
      id: meta.id, label: meta.label, date: now.date, transform: 'y/y and m/m on the index level; 3-month change annualised',
      yoy: ya ? r2((now.value / ya.value - 1) * 100) : null,
      mom: r2((now.value / at(1).value - 1) * 100),
      ann3m: r2(a3), ann3mPrev: r2(a3p),
      trend3m: a3 == null || a3p == null ? null : a3 > a3p ? 'rising' : a3 < a3p ? 'easing' : 'flat',
    };
  }
  return out;
}

// ── DRIVER GROUPS ── the Drivers tab, one group per axis the state reads. `comp` is the
// conditions component the group feeds (its score is shown on the group header), `axis` the regime
// axis. The series are SERIES_META keys, rendered as uniform tiles.
export const DRIVER_GROUPS = Object.freeze([
  { id: 'growth',    label: 'Growth',            axis: 'growth',    comp: null,        series: [],
    lead: 'The growth axis: market-implied, weekly and monthly legs. Its level and drift set the regime\'s left–right.' },
  { id: 'inflation', label: 'Inflation',         axis: 'inflation', comp: null,        series: ['breakeven5'],
    lead: 'The inflation axis: market-implied, the Cleveland Fed nowcast and the prints. Its level and drift set the regime\'s up–down.' },
  { id: 'rates',     label: 'Policy & rates',    axis: null,        comp: 'realYield', series: ['realYield', 'termPremium', 'effr', 'sofr'],
    lead: 'What money costs and what the Fed is pricing. Real yields are the valuation anchor for everything long-duration.' },
  { id: 'credit',    label: 'Credit & liquidity', axis: null,       comp: 'credit',    series: ['hyOas', 'igOas', 'reserves', 'rrp', 'tga', 'fedAssets'],
    lead: 'Credit is the first place stress shows. Net liquidity is Fed assets less the Treasury account and reverse repo.' },
  { id: 'vol',       label: 'Volatility & breadth', axis: null,     comp: 'equityVol', series: ['vix', 'vix9d', 'vix3m', 'move', 'rsp', 'iwm', 'spy'],
    lead: 'The price of protection and how many stocks are carrying the index. An inverted VIX curve is stress now; narrowing breadth is stress building.' },
  { id: 'dollar',    label: 'Dollar',            axis: null,        comp: 'dollar',    series: ['dxy'],
    lead: 'A fast dollar rally tightens global financial conditions — it is funding stress for everyone who borrowed in dollars.' },
]);

// ── FEED HEALTH ── how old each series is against its cadence, in calendar days. A daily series
// crosses a weekend, and FRED's credit indices publish a session or two late, so daily is fresh
// to 4 days and stale past 7; a weekly one (Wednesday H.4.1) is fresh to 9 and stale past 16.
const HEALTH_DAYS = { daily: [4, 7], weekly: [9, 16] };
export function seriesHealth(stats = {}, now = new Date()) {
  const today = Date.parse(now.toISOString().slice(0, 10));
  return Object.entries(stats).map(([key, s]) => {
    const age = s?.date ? Math.round((today - Date.parse(s.date)) / 864e5) : null;
    const [fresh, stale] = HEALTH_DAYS[s?.published || s?.cadence] || HEALTH_DAYS.daily;
    const status = age == null ? 'missing' : age <= fresh ? 'fresh' : age <= stale ? 'late' : 'stale';
    return { key, label: s?.label ?? key, src: s?.src ?? null, cadence: s?.published ? `${s.cadence}, published ${s.published}` : (s?.cadence ?? null), date: s?.date ?? null, age, status };
  }).sort((a, b) => ['missing', 'stale', 'late', 'fresh'].indexOf(a.status) - ['missing', 'stale', 'late', 'fresh'].indexOf(b.status));
}
