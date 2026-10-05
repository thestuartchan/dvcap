// lib/factorExposure.js — what the book has actually done against seven macro factors.
//
// READ-ONLY, AND REALISED. The exposure tile says what the book SHOULD move per unit of its
// underlyings, from deltas. This says what it DID: the book's daily P&L, rebuilt from the fills
// (the position as held at each close) times each line's daily close, regressed on each factor's
// daily move over the last 20 and 60 sessions. The two disagreeing is the finding — a hedge whose
// realised Brent beta is flat is not hedging Brent, whatever its label says.
//
// THE UNITS. A price factor moves in percent; the 10-year moves in basis points. Every slope is
// kept as dollars of book P&L per ONE of the factor's native units and reported per the factor's
// display unit — 1% for prices, 10bp for the yield. Beta is that slope as a share of NLV: a QQQ
// beta of 0.35 means the book has moved 0.35% per 1% of QQQ.
//
// CLOSE TO CLOSE. A day's P&L is the position held at the PREVIOUS close times the move to this
// close. A trade opened and closed inside one session never crosses a close and contributes
// nothing, which is correct for a factor read: intraday P&L is not a factor exposure.
//
// WHAT IT CANNOT SEE, SAID ONCE. Options are carried at their CURRENT delta on the underlying's
// close — the delta a month ago is not recorded anywhere. Futures lines and the futures factors
// are continuous front-month series, so a roll day is in both. A Hong Kong close is aligned to the
// US date it shares, which is earlier in the day and understates the beta of anything in Asia.
import { derivePosition } from './positions.js';
import { dirSign } from './side.js';
import { isLeveraged } from './leverage.js';
import { isCashEquivalent } from './cashEquivalents.js';

export const FACTORS = Object.freeze([
  { id: 'brent',  label: 'Brent front', symbol: 'BZ=F',     kind: 'pct', per: 1,  unit: '1%' },
  { id: 'wti',    label: 'WTI front',   symbol: 'CL=F',     kind: 'pct', per: 1,  unit: '1%' },
  { id: 'qqq',    label: 'QQQ',         symbol: 'QQQ',      kind: 'pct', per: 1,  unit: '1%' },
  // ^TNX is quoted as the yield in percent (5.24), so a day's change × 100 is basis points.
  { id: 'us10y',  label: 'US 10Y',      symbol: '^TNX',     kind: 'bp',  per: 10, unit: '10bp' },
  { id: 'dxy',    label: 'DXY',         symbol: 'DX-Y.NYB', kind: 'pct', per: 1,  unit: '1%' },
  { id: 'usdjpy', label: 'USD/JPY',     symbol: 'JPY=X',    kind: 'pct', per: 1,  unit: '1%' },
  { id: 'gold',   label: 'Gold',        symbol: 'GC=F',     kind: 'pct', per: 1,  unit: '1%' },
]);
export const FACTOR_SYMBOLS = FACTORS.map(f => f.symbol);
export const WINDOWS = Object.freeze([20, 60]);

// The brief's scenario. Moves are in each factor's native unit: percent, or bp for the 10-year.
export const OIL_SHOCK = Object.freeze({
  id: 'oil-shock', label: 'Oil-shock day',
  shocks: Object.freeze({ brent: 4, us10y: 15, qqq: -1.5, gold: -1 }),
});

// ── THE TAG ──────────────────────────────────────────────────────────────────
// What a line is FOR. Separate from `trade` (a free-text label) and from the exposure book's
// swing/position bucket (a sizing rule): a hedge is a position held to offset another, and the
// scenario's coverage is the sum of exactly these.
export const TAGS = Object.freeze(['hedge', 'position', 'swing', 'intraday']);
export const tagOf = (r) => (TAGS.includes(r?.tag) ? r.tag : null);

// ── THE OPEN LIST'S GROUPS ───────────────────────────────────────────────────
// What the open list filters and orders by: the tag, with two additions that are not tags.
//   cash      anything on the one cash list (lib/cashEquivalents.js) — USFR, IB01, bills. It is
//             DERIVED, not chosen: a hand-set "cash" tag could disagree with the exposure book,
//             which zeroes exactly this list and nothing else. It wins over a tag.
//   untagged  no tag set.
// The order is the order the groups are read in: what the book is for, then what is unlabelled,
// then what is parked.
export const LIST_GROUPS = Object.freeze(['position', 'swing', 'hedge', 'intraday', 'untagged', 'cash']);
export const listGroupOf = (r) => (isCashEquivalent(r) ? 'cash' : tagOf(r) || 'untagged');
export function groupCounts(rows = []) {
  const c = Object.fromEntries(LIST_GROUPS.map(g => [g, 0]));
  for (const r of rows) c[listGroupOf(r)]++;
  return c;
}
// Stable: within a group, the order it came in (size, or the custom order).
export const sortByGroup = (rows = []) => rows.map((r, i) => [r, i])
  .sort((a, b) => (LIST_GROUPS.indexOf(listGroupOf(a[0])) - LIST_GROUPS.indexOf(listGroupOf(b[0]))) || a[1] - b[1])
  .map(([r]) => r);
// An empty or unknown filter shows everything.
export const filterByGroups = (rows = [], groups = []) => {
  const want = (groups || []).filter(g => LIST_GROUPS.includes(g));
  return want.length ? rows.filter(r => want.includes(listGroupOf(r))) : rows;
};

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const day = (d) => String(d || '').slice(0, 10);

// ── ALIGNMENT ────────────────────────────────────────────────────────────────
// [{date, close}] or {date: close} → a sorted [[date, close]].
export function closesOf(series) {
  const pairs = Array.isArray(series)
    ? series.map(b => Array.isArray(b) ? [day(b[0]), num(b[1])] : [day(b?.date), num(b?.close)])
    : Object.entries(series || {}).map(([d, c]) => [day(d), num(c)]);
  return pairs.filter(([d, c]) => d && c != null && c > 0).sort((a, b) => a[0].localeCompare(b[0]));
}

// The calendar is the days EVERY factor printed. A line's close on a calendar day is its last
// close on or before it, but no older than `maxGapDays` — a line that stopped printing a week ago
// is missing, not flat.
export function calendarOf(factorCloses) {
  const sets = Object.values(factorCloses).map(s => new Set(closesOf(s).map(([d]) => d)));
  if (!sets.length || sets.some(s => !s.size)) return [];
  const [first, ...rest] = sets;
  return [...first].filter(d => rest.every(s => s.has(d))).sort();
}

export function closeOn(pairs, dates, { maxGapDays = 5 } = {}) {
  const out = [];
  let j = -1;
  for (const d of dates) {
    while (j + 1 < pairs.length && pairs[j + 1][0] <= d) j++;
    const hit = j >= 0 ? pairs[j] : null;
    const gap = hit ? (Date.parse(d) - Date.parse(hit[0])) / 86400000 : Infinity;
    out.push(hit && gap <= maxGapDays ? hit[1] : null);
  }
  return out;
}

// A factor's move from one calendar day to the next, in its native unit.
export function factorMoves(pairs, dates, kind) {
  const c = closeOn(pairs, dates);
  return c.map((v, i) => {
    if (i === 0 || v == null || c[i - 1] == null) return null;
    return kind === 'bp' ? +((v - c[i - 1]) * 100).toFixed(4) : +((v / c[i - 1] - 1) * 100).toFixed(6);
  });
}

// ── POSITION HISTORY ─────────────────────────────────────────────────────────
// The signed quantity held after each fill date, from the same engine as the row. [[date, qty]].
export function holdingsOf(row) {
  const fills = (row?.fills || []).filter(f => f && (f.side === 'buy' || f.side === 'sell') && day(f.date));
  const dates = [...new Set(fills.map(f => day(f.date)))].sort();
  const s = dirSign(row?.side);
  return dates.map(d => {
    const p = derivePosition(fills.filter(f => day(f.date) <= d), { multiplier: row?.multiplier, side: row?.side });
    return [d, +(s * (p.qty || 0)).toFixed(6)];
  });
}
export function qtyAt(holdings, date) {
  let q = 0;
  for (const [d, v] of holdings || []) { if (d <= date) q = v; else break; }
  return q;
}

// ── A LINE ───────────────────────────────────────────────────────────────────
// Everything the maths needs about one row, resolved by the caller (who knows the quote symbol,
// the multiplier, the delta and the rate to base):
//   { id, label, tag, closes, perUnit, fx, holdings, qtyNow }
// `perUnit` is underlying units per 1 of the row's quantity: the multiplier for a share or a
// future, the combo's delta × multiplier for an option or a spread. The holdings carry the
// direction, so `perUnit` must not — for an option row that is the combo delta BEFORE the row's
// direction is applied. `fx` is base currency per 1 of the row's.
// Daily P&L in base on each calendar day, as held ('held') or with today's quantity throughout
// ('current').
export function linePnl(line, dates, { mode = 'held', maxGapDays = 5 } = {}) {
  const c = closeOn(closesOf(line.closes), dates, { maxGapDays });
  const per = num(line.perUnit) ?? 1, fx = num(line.fx) ?? 1;
  return c.map((v, i) => {
    if (i === 0) return null;
    const q = mode === 'current' ? (num(line.qtyNow) ?? 0) : qtyAt(line.holdings, dates[i - 1]);
    if (!q) return 0;
    if (v == null || c[i - 1] == null) return null;
    return (v - c[i - 1]) * q * per * fx;
  });
}

// ── REGRESSION ───────────────────────────────────────────────────────────────
export function ols(y, x) {
  const pts = [];
  for (let i = 0; i < y.length; i++) if (y[i] != null && x[i] != null) pts.push([x[i], y[i]]);
  const n = pts.length;
  if (n < 3) return { slope: null, r2: null, n };
  const mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [a, b] of pts) { sxx += (a - mx) ** 2; sxy += (a - mx) * (b - my); syy += (b - my) ** 2; }
  if (!(sxx > 0)) return { slope: null, r2: null, n };
  const slope = sxy / sxx;
  return { slope, r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : 0, n, sxx, mx };
}

// Least squares with an intercept on several regressors, by the normal equations. Returns the
// slopes in the order given, or null when the system is singular (a factor that never moved).
export function olsMulti(y, xs) {
  const k = xs.length, rows = [];
  for (let i = 0; i < y.length; i++) {
    if (y[i] == null || xs.some(x => x[i] == null)) continue;
    rows.push([1, ...xs.map(x => x[i]), y[i]]);
  }
  if (rows.length < k + 3) return null;
  const m = k + 1;
  const A = Array.from({ length: m }, (_, a) => Array.from({ length: m + 1 }, (_, b) =>
    rows.reduce((s, r) => s + r[a] * (b < m ? r[b] : r[m]), 0)));
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c2 = col; c2 <= m; c2++) A[r][c2] -= f * A[col][c2];
    }
  }
  return A.slice(1).map((r, i) => r[m] / A[i + 1][i + 1]);
}

// The last `n` entries of every series, by calendar position.
const tail = (arr, n) => arr.slice(Math.max(0, arr.length - n));

// ── THE PANEL'S NUMBERS ──────────────────────────────────────────────────────
// factorCloses: { [factorId]: closes }. lines: see linePnl. nlv: base-currency equity or null.
export function factorExposure({ factorCloses = {}, lines = [], nlv = null, mode = 'held', windows = WINDOWS, top = 5 } = {}) {
  const dates = calendarOf(Object.fromEntries(FACTORS.map(f => [f.id, factorCloses[f.id] || []])));
  const need = Math.max(...windows) + 1;
  if (dates.length < 3) return { ok: false, reason: 'no common factor history', dates: [] };
  const moves = Object.fromEntries(FACTORS.map(f => [f.id, factorMoves(closesOf(factorCloses[f.id]), dates, f.kind)]));

  const usable = [], skipped = [];
  for (const l of lines) {
    if (l.skip) { skipped.push({ id: l.id, label: l.label, why: l.skip }); continue; }
    if (!closesOf(l.closes).length) { skipped.push({ id: l.id, label: l.label, why: 'no price history' }); continue; }
    usable.push({ ...l, pnl: linePnl(l, dates, { mode }) });
  }
  // The book's day is the sum of its lines; a day on which a held line has no price is not a day
  // the book can be measured on, so it drops out rather than counting that line as flat.
  const book = dates.map((_, i) => {
    if (i === 0) return null;
    let s = 0;
    for (const l of usable) { if (l.pnl[i] == null) return null; s += l.pnl[i]; }
    return s;
  });

  const eq = num(nlv);
  const byWindow = {};
  for (const w of windows) {
    const idx = (arr) => tail(arr, w);
    const y = idx(book);
    byWindow[w] = FACTORS.map(f => {
      const x = idx(moves[f.id]);
      const fit = ols(y, x);
      if (fit.slope == null) return { factor: f.id, label: f.label, unit: f.unit, n: fit.n, slope: null };
      // Each line's share of the slope. OLS is linear in y, so the lines' slopes on the SAME days
      // sum to the book's exactly — which is what makes "which lines drive it" a decomposition
      // rather than a second, disagreeing regression.
      const keep = y.map((v, i) => v != null && x[i] != null);
      const contrib = usable.map(l => {
        const ly = idx(l.pnl).map((v, i) => keep[i] ? v : null);
        const s = ols(ly, x.map((v, i) => keep[i] ? v : null)).slope;
        return { id: l.id, label: l.label, tag: l.tag ?? null, usd: s == null ? 0 : +(s * f.per).toFixed(2) };
      }).filter(c => c.usd !== 0).sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd));
      const usd = fit.slope * f.per;
      return {
        factor: f.id, label: f.label, unit: f.unit, n: fit.n,
        usdPerUnit: +usd.toFixed(2),
        beta: eq ? +(usd / eq * 100).toFixed(3) : null,
        r2: +fit.r2.toFixed(3),
        top: contrib.slice(0, top),
      };
    });
  }
  return {
    ok: true, mode, dates, first: dates[0], last: dates.at(-1),
    sessions: book.filter(v => v != null).length, short: dates.length < need,
    windows: byWindow, lines: usable.map(l => ({ id: l.id, label: l.label, tag: l.tag ?? null })), skipped,
  };
}

// ── THE SCENARIO ─────────────────────────────────────────────────────────────
// Each line's P&L on TODAY's quantity, regressed jointly on the shocked factors over the window,
// then evaluated at the shock. Jointly, because Brent and QQQ are not independent and adding four
// separate single-factor answers counts their common move once per factor. Hedge lines are the
// ones tagged hedge; coverage is what they make as a share of what everything else loses.
export function scenarioPnl({ factorCloses = {}, lines = [], scenario = OIL_SHOCK, window = 60 } = {}) {
  const ids = Object.keys(scenario.shocks);
  const dates = calendarOf(Object.fromEntries(FACTORS.map(f => [f.id, factorCloses[f.id] || []])));
  if (dates.length < 3) return { ok: false, reason: 'no common factor history' };
  const kindOf = Object.fromEntries(FACTORS.map(f => [f.id, f.kind]));
  const xs = ids.map(id => tail(factorMoves(closesOf(factorCloses[id]), dates, kindOf[id]), window));
  const out = [];
  for (const l of lines) {
    if (l.skip || !num(l.qtyNow) || !closesOf(l.closes).length) continue;
    const y = tail(linePnl(l, dates, { mode: 'current' }), window);
    const b = olsMulti(y, xs);
    if (!b) { out.push({ id: l.id, label: l.label, tag: l.tag ?? null, usd: null }); continue; }
    const usd = b.reduce((s, v, i) => s + v * scenario.shocks[ids[i]], 0);
    out.push({ id: l.id, label: l.label, tag: l.tag ?? null, usd: +usd.toFixed(2) });
  }
  const sum = (arr) => +arr.reduce((s, l) => s + (l.usd ?? 0), 0).toFixed(2);
  const hedges = out.filter(l => l.tag === 'hedge').sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  const rest = out.filter(l => l.tag !== 'hedge');
  const book = sum(out), hedge = sum(hedges), exposed = sum(rest);
  // Coverage only means something against a loss. A book that makes money on the shock before its
  // hedges has nothing to cover, and a percentage of a gain would read as a hedge ratio.
  const coverage = exposed < 0 ? Math.round(hedge / -exposed * 100) : null;
  return {
    ok: true, scenario: scenario.label, shocks: scenario.shocks, window,
    book, hedge, exposed, coverage, hedges, lines: out.sort((a, b) => (a.usd ?? 0) - (b.usd ?? 0)),
    unpriced: out.filter(l => l.usd == null).map(l => l.label),
  };
}

// ── HELD PAST THE SESSION ────────────────────────────────────────────────────
// A future or a leveraged ETF carried over a close is a swing trade or a mistake. Info only: the
// flag says what it is and what it is tagged, and does nothing.
export function overnightFlag(row, { today = new Date().toISOString().slice(0, 10), open = true } = {}) {
  if (!open) return null;
  const future = !!row?.margined;
  const lev = !future && isLeveraged(row?.symbol);
  if (!future && !lev) return null;
  const tag = tagOf(row);
  if (tag === 'swing') return null;
  const lots = row?.derived?.lots || [];
  const since = day(lots[0]?.date || row?.derived?.firstDate);
  if (!since || since >= today) return null;
  return { since, tag, what: future ? 'future' : 'leveraged ETF',
           text: `${future ? 'future' : 'leveraged ETF'} held since ${since}, tagged ${tag || 'nothing'} — not swing` };
}
