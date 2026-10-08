// lib/holdTypes.js — the sizer's three hold types, exposure on the underlying, and the
// correlation-aware cap (brief of 8 Oct 2026, Part B).
//
// WHY THREE TESTS. The sizer ran one: one ATR against you costs 1% of NLV. That is a TRADE test —
// it assumes an exit within a few ATRs. A long hold is meant to sit through several ATRs and fails
// on a drawdown, not a stop; an event trade held through earnings can gap straight through a stop.
// So the hold type picks the test, and the other two are shown beside it so a mismatch is visible
// ("as a Trade this would be 120 shares; as a Long hold, 75").
//
//   Trade      (entry − stop) × units × exposure multiplier ≤ 1R
//   Long hold  exposure × bad-case drawdown % ≤ drawdown budget (a % of the family book)
//   Event      exposure × typical event gap % ≤ 1R
//
// THE SIZER INFORMS, IT NEVER BLOCKS. Every number here is a suggestion shown beside the one typed.
// Console-only: positions, exposure and NLV never reach a public endpoint from this module.
import { leverageFor } from './leverage.js';

export const HOLD_TYPES = Object.freeze(['trade', 'long', 'event']);
export const HOLD_LABEL = Object.freeze({ trade: 'Trade', long: 'Long hold', event: 'Event' });

// Editable in one place (the Sizing card); these are the defaults.
export const HOLD_DEFAULTS = Object.freeze({
  oneR: 2000,               // USD, the trading sleeve's unit of risk
  ddBudgetPct: 2.5,         // % of the FAMILY book a long hold may lose in its bad case
  familyBook: null,         // USD; the drawdown budget's base — not the trading account's NLV
  singleNamePct: 10,        // % of NLV
  clusterPct: 15,           // % of NLV, the guide for correlation-weighted exposure
  nearDupRho: 0.9,          // at or above: one bet, summed in full
  clusterRho: 0.5,          // at or above: counted at ρ × its exposure
  ddHighBetaPct: 50,
  ddOtherPct: 30,
  highBetaAtrPct: 3,        // a daily ATR this % of price or more reads as high-beta
  atrMult: 2,               // the Trade test's stop when none is typed: this many ATRs
  corrSessions: 120,
  corrMaxAgeDays: 7,
});
export const holdSettings = (s = {}) => {
  const out = { ...HOLD_DEFAULTS };
  for (const k of Object.keys(HOLD_DEFAULTS)) { const v = s?.[k]; if (v !== '' && v != null && Number.isFinite(+v)) out[k] = +v; }
  return out;
};

const num = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
const floorTo = (x) => (Number.isFinite(x) ? Math.max(0, Math.floor(x + 1e-9)) : null);
const usd = (v) => `$${Math.round(v).toLocaleString('en-US')}`;

// ── EXPOSURE IS MEASURED ON THE UNDERLYING ───────────────────────────────────
// Per unit, in the instrument's currency:
//   stock / ETF        price
//   leveraged ETF      price × |factor|           (attributed to the underlying)
//   future             price × multiplier
//   option             |delta| × 100 × underlying price
export function exposurePerUnit({ kind = 'stock', price = null, delta = null, multiplier = null, leverage = 1 } = {}) {
  const p = num(price);
  if (!(p > 0)) return null;
  if (kind === 'option') return num(delta) != null ? Math.abs(delta) * 100 * p : null;
  if (kind === 'future') return num(multiplier) > 0 ? p * multiplier : null;
  return p * Math.abs(num(leverage) || 1);
}
// What a position is attributed to: a leveraged ETF to what it tracks (7709.HK → 000660.KS).
export function exposureRootOf(root) {
  const lv = leverageFor(root);
  return lv.known && lv.underlying && !/\s/.test(lv.underlying) ? lv.underlying : String(root || '').toUpperCase();
}
// The currency a Yahoo symbol trades in, from its suffix.
const SUFFIX_CCY = { HK: 'HKD', KS: 'KRW', KQ: 'KRW', T: 'JPY', L: 'GBP', TO: 'CAD', AX: 'AUD', SI: 'SGD', SS: 'CNY', SZ: 'CNY', TW: 'TWD', DE: 'EUR', PA: 'EUR', AS: 'EUR' };
export const ccyOfSymbol = (sym) => SUFFIX_CCY[String(sym || '').toUpperCase().split('.')[1]] || 'USD';

// HIGH-BETA, FOR THE DEFAULT DRAWDOWN: a leveraged product, or a daily ATR of highBetaAtrPct+.
export function defaultDrawdown({ atrPct = null, leverage = 1 } = {}, S = HOLD_DEFAULTS) {
  const high = Math.abs(num(leverage) || 1) > 1 || (num(atrPct) ?? 0) >= S.highBetaAtrPct;
  return { pct: high ? S.ddHighBetaPct : S.ddOtherPct, highBeta: high,
           why: Math.abs(num(leverage) || 1) > 1 ? 'leveraged product' : num(atrPct) != null ? `daily ATR ${(+atrPct).toFixed(1)}% of price` : 'no ATR' };
}

// ── THE THREE TESTS ──────────────────────────────────────────────────────────
// `fx` turns the instrument's currency into USD (1 for a US name): 1R and the budgets are dollars,
// and a Hong Kong price is not. `stopDist` is entry − stop on the instrument the price is quoted in
// (the underlying for an option); null takes atrMult × ATR. A leveraged ETF's Trade test uses the
// ETF's OWN price and ATR, which already contain the leverage, so its risk multiplier is 1.
export function holdTests({ kind = 'stock', price = null, atr = null, atrPct = null, delta = null, multiplier = null, leverage = 1,
                            entry = null, stop = null, atrMult = null, ddPct = null, gapPct = null, fx = 1, settings = {} } = {}) {
  const S = holdSettings(settings);
  const f = num(fx) > 0 ? +fx : 1;
  const e = num(entry) ?? num(price);
  const k = num(atrMult) ?? S.atrMult;
  const stopTyped = num(stop) != null && e != null && Math.abs(e - stop) > 0;
  const dist = stopTyped ? Math.abs(e - stop) : (num(atr) > 0 ? k * atr : null);
  // Per unit, what one share / contract / option moves by per point of the quoted price.
  const pointValue = kind === 'option' ? (num(delta) != null ? Math.abs(delta) * 100 : null) : kind === 'future' ? num(multiplier) : 1;
  const expo = exposurePerUnit({ kind, price, delta, multiplier, leverage });
  const out = {};

  // TRADE
  const riskPer = dist != null && pointValue != null ? dist * pointValue * f : null;
  out.trade = riskPer > 0
    ? { size: floorTo(S.oneR / riskPer), budget: S.oneR, perUnit: riskPer,
        detail: `1R ${usd(S.oneR)} ÷ ${usd(riskPer)} at risk per ${kind === 'option' ? 'contract' : kind === 'future' ? 'contract' : 'share'} (stop ${stopTyped ? `${(+stop).toLocaleString('en-US')}, ${(Math.abs(e - stop)).toFixed(2)} away` : `${k} ATR = ${dist.toFixed(2)}`})` }
    : { size: null, budget: S.oneR, detail: dist == null ? 'no stop and no ATR' : 'no delta or multiplier' };

  // LONG HOLD — exposure × bad-case drawdown ≤ the drawdown budget on the FAMILY book.
  const dd = num(ddPct) ?? defaultDrawdown({ atrPct, leverage }, S).pct;
  const famBook = num(S.familyBook);
  const ddBudget = famBook > 0 ? famBook * S.ddBudgetPct / 100 : null;
  const maxExpLong = ddBudget != null && dd > 0 ? ddBudget / (dd / 100) : null;
  out.long = maxExpLong != null && expo > 0
    ? { size: floorTo(maxExpLong / (expo * f)), budget: ddBudget, maxExposure: maxExpLong, ddPct: dd,
        detail: `${S.ddBudgetPct}% of the family book ${usd(famBook)} = ${usd(ddBudget)} ÷ ${dd}% bad case = ${usd(maxExpLong)} of exposure` }
    : { size: null, budget: ddBudget, ddPct: dd, detail: ddBudget == null ? 'set the family book value' : 'no exposure per unit' };

  // EVENT — exposure × typical gap ≤ 1R.
  const g = num(gapPct);
  const maxExpEvent = g > 0 ? S.oneR / (g / 100) : null;
  out.event = maxExpEvent != null && expo > 0
    ? { size: floorTo(maxExpEvent / (expo * f)), budget: S.oneR, maxExposure: maxExpEvent, gapPct: g,
        detail: `1R ${usd(S.oneR)} ÷ ${g}% gap = ${usd(maxExpEvent)} of exposure` }
    : { size: null, budget: S.oneR, gapPct: g, detail: g > 0 ? 'no exposure per unit' : 'no event gap — type one, or size it once to load the last four earnings moves' };

  for (const t of HOLD_TYPES) out[t] = { ...out[t], type: t, name: `${HOLD_LABEL[t]} test` };
  return { ...out, exposurePerUnit: expo, fx: f, settings: S };
}

// The line under the bold suggestion: the other two hold types, so a mismatch is visible.
export function otherTypesLine(tests, chosen, unit = 'shares') {
  const others = HOLD_TYPES.filter(t => t !== chosen && tests?.[t]);
  const parts = others.map(t => `as ${anA(HOLD_LABEL[t])}, ${tests[t].size == null ? '—' : `${tests[t].size.toLocaleString('en-US')} ${unit}`}`);
  return parts.length ? `${cap(parts[0])}${parts.length > 1 ? `; ${parts.slice(1).join('; ')}` : ''}.` : null;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const anA = (w) => `${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}`;

// THE LEVERAGED-ETF LINE. Information only, on a Long hold.
export function leveragedLongHoldNote(root, holdType) {
  const lv = leverageFor(root);
  if (holdType !== 'long' || !lv.known || Math.abs(lv.factor) === 1) return null;
  return `Daily-reset ${Math.abs(lv.factor)}× ETF: over weeks it does not track ${Math.abs(lv.factor)}× the underlying; volatility drag applies. Your rule: leveraged ETFs are 1–3 day trades.`;
}

// ── THE TYPICAL EVENT GAP ────────────────────────────────────────────────────
// The last four earnings reactions from daily bars. The report time is not always known, so each
// reaction is the larger of the report day's move and the next day's — one of them is the gap.
export function earningsReactions(bars = [], dates = [], { n = 4 } = {}) {
  const b = (bars || []).filter(x => x && Number.isFinite(x.close));
  const idx = new Map(b.map((x, i) => [x.date, i]));
  const out = [];
  for (const d of [...dates].sort().reverse()) {
    let i = idx.get(d);
    if (i == null) { i = b.findIndex(x => x.date > d); if (i < 0) continue; }   // reported on a non-session: the next session
    if (i < 1) continue;
    const day = b[i].close / b[i - 1].close - 1;
    const next = i + 1 < b.length ? b[i + 1].close / b[i].close - 1 : null;
    const move = next != null && Math.abs(next) > Math.abs(day) ? next : day;
    out.push({ date: d, movePct: +(move * 100).toFixed(2) });
    if (out.length >= n) break;
  }
  const avg = out.length ? +(out.reduce((a, r) => a + Math.abs(r.movePct), 0) / out.length).toFixed(2) : null;
  return { reactions: out, avgAbsPct: avg };
}

// ── CORRELATION, AND THE CAP IT SCALES ───────────────────────────────────────
// ρ of daily returns over the last `sessions` common dates. `a`, `b`: [[date, close]].
export function returnCorrelation(a = [], b = [], sessions = HOLD_DEFAULTS.corrSessions) {
  const mb = new Map(b);
  const common = a.filter(([d]) => mb.has(d)).map(([d, c]) => [c, mb.get(d)]).slice(-(sessions + 1));
  if (common.length < Math.min(40, sessions / 2)) return null;
  const xs = [], ys = [];
  for (let i = 1; i < common.length; i++) { xs.push(Math.log(common[i][0] / common[i - 1][0])); ys.push(Math.log(common[i][1] / common[i - 1][1])); }
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? +(sxy / Math.sqrt(sxx * syy)).toFixed(3) : null;
}
// The pair table: { "A|B": ρ } over every pair of the symbols given, A < B.
export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
export function correlationTable(closes = {}, sessions = HOLD_DEFAULTS.corrSessions) {
  const syms = Object.keys(closes).filter(s => (closes[s] || []).length).sort();
  const out = {};
  for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++) {
    const r = returnCorrelation(closes[syms[i]], closes[syms[j]], sessions);
    if (r != null) out[pairKey(syms[i], syms[j])] = r;
  }
  return out;
}

// EFFECTIVE EXPOSURE of `name`: its own, plus ρ × each other name's for ρ ≥ clusterRho; and the
// near-duplicate group (ρ ≥ nearDupRho, transitively) summed in full. `exposures`: { underlying:
// USD } with the candidate already added to its own name. Leveraged ETFs are mapped to their
// underlying first, at ρ 1.0, by the caller summing them under one key (exposureRootOf).
export function effectiveExposure(name, exposures = {}, table = {}, settings = {}) {
  const S = holdSettings(settings);
  const rho = (a, b) => (a === b ? 1 : table[pairKey(a, b)] ?? null);
  const alone = Math.abs(exposures[name] || 0);
  // The near-duplicate group: union through pairs at or above nearDupRho.
  const group = new Set([name]);
  for (let grew = true; grew;) {
    grew = false;
    for (const s of Object.keys(exposures)) if (!group.has(s) && [...group].some(g => (rho(g, s) ?? 0) >= S.nearDupRho)) { group.add(s); grew = true; }
  }
  const groupUsd = [...group].reduce((a, s) => a + Math.abs(exposures[s] || 0), 0);
  const contributors = [];
  let cluster = alone;
  for (const s of Object.keys(exposures)) {
    if (s === name) continue;
    const r = rho(name, s);
    if (r != null && r >= S.clusterRho) { const add = r * Math.abs(exposures[s] || 0); cluster += add; contributors.push({ name: s, rho: r, usd: Math.abs(exposures[s] || 0), add }); }
  }
  contributors.sort((a, b) => b.add - a.add);
  const pairs = [...group].filter(s => s !== name).map(s => ({ name: s, rho: rho(name, s) }));
  return { name, alone, group: [...group], groupUsd, cluster, contributors, nearDup: pairs };
}

// THE THREE BARS AND THEIR WARNINGS. Green inside the guide, amber at 80–100% of it, red above.
// Never blocks: a warning is text.
export const barTone = (pctNlv, capPct) => (pctNlv == null ? 'muted' : pctNlv > capPct ? 'red' : pctNlv >= 0.8 * capPct ? 'amber' : 'green');
export function exposureStrip(eff, nlv, settings = {}, label = (s) => s) {
  const S = holdSettings(settings);
  if (!(nlv > 0) || !eff) return null;
  const pct = (v) => +(v / nlv * 100).toFixed(1);
  const bars = [
    { key: 'alone', label: `${label(eff.name)} alone`, usd: eff.alone, pct: pct(eff.alone), cap: S.singleNamePct, guide: `${S.singleNamePct}% single-name cap` },
    { key: 'group', label: eff.group.length > 1 ? `Near-duplicate group (${eff.group.map(label).join(' + ')})` : 'Near-duplicate group (none)', usd: eff.groupUsd, pct: pct(eff.groupUsd), cap: S.singleNamePct, guide: `${S.singleNamePct}% single-name cap` },
    { key: 'cluster', label: 'Correlation-weighted cluster', usd: eff.cluster, pct: pct(eff.cluster), cap: S.clusterPct, guide: `${S.clusterPct}% cluster guide` },
  ].map(b => ({ ...b, tone: barTone(b.pct, b.cap) }));
  const warnings = [];
  for (const p of eff.nearDup) {
    warnings.push({ level: 'near-duplicate', text: `${label(eff.name)} and ${label(p.name)} move together (ρ ${p.rho.toFixed(2)}): treated as one bet. Combined exposure ${usd(eff.groupUsd)} = ${pct(eff.groupUsd)}% of NLV vs the ${S.singleNamePct}% single-name cap.` });
    break;   // one line names the group; the bar lists every member
  }
  if (pct(eff.cluster) > S.clusterPct) {
    const top = eff.contributors.slice(0, 3).map(c => `${label(c.name)} ${usd(c.add)} (ρ ${c.rho.toFixed(2)})`).join(', ');
    warnings.push({ level: 'cluster', text: `Effective exposure in the ${label(eff.name)} group is ${pct(eff.cluster)}% of NLV (cap guide ${S.clusterPct}%). Largest contributors: ${label(eff.name)} ${usd(eff.alone)}${top ? `, ${top}` : ''}.` });
  }
  if (pct(eff.alone) > S.singleNamePct) warnings.push({ level: 'single', text: `${label(eff.name)} alone is ${pct(eff.alone)}% of NLV, over the ${S.singleNamePct}% single-name cap.` });
  return { bars, warnings };
}
