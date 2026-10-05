// lib/gexLevels.js — the downside of the book, named for what it does rather than for what it is
// made of.
//
// ── WHY "PUT WALL" HAD TO GO ─────────────────────────────────────────────────
// The headline PUT WALL tile was wrong on four consecutive boards, in two different ways:
//
//   17 Sep  spot 716    PUT WALL 700   the largest NEGATIVE net-gamma node below spot — hedging
//                                      there accelerates a fall; a trapdoor labelled as a wall
//   18 Sep  spot 721    PUT WALL 700   same, while 0DTE carried −118M at 716 and −64M at 715,
//                                      nearer spot and ignored
//   21 Sep  spot 729    PUT WALL 700   a sum across expiries that 0 of 8 expiries peaked at —
//                                      the panel's own footnote said so under the tile
//   22 Sep  spot 743.8  PUT WALL 740   +50M, POSITIVE gamma, 0.5% below spot: the at-the-money
//                                      pin, labelled as a wall
//
// One cause: walls() picks the strike with the most put-side gamma-weighted open interest, and
// never asks the sign of the NET gamma there, how far from spot it sits, or whether any expiry
// actually peaks at it. "Wall" means one thing everywhere else on the panel — a level where dealer
// hedging leans AGAINST price — and a picker that does not test for that will label a trapdoor,
// a sum and a pin as a wall, which it did, on four boards running.
//
// So the put side is three objects now, and they never share a word:
//
//   PUT SUPPORT   positive net gamma below spot, far enough from spot to be a level rather than
//                 the pin, that at least one expiry peaks at, big enough to matter. Green. This
//                 is the wall, and when nothing qualifies the tile says so — an honest blank
//                 beats a wrong number.
//   TRAPDOOR      the most negative net-gamma strike below spot: hedging there accelerates a
//                 fall. Nearest (inside 3%) and largest (inside 10%) shown separately when they
//                 differ, because on 18 Sep they were 716 and 700 and both mattered. Purple,
//                 never "wall".
//   PIN BOX       the strikes around spot carrying the nearest expiry's gamma — what the
//                 22 Sep "put wall 740" actually was. Grey.
//
// The call side keeps its picker and gains its qualifier: a positive node ABOVE spot is a
// ceiling; the same node BELOW spot (17 Sep, 715 with spot 716) is a magnet, and gets that word.
//
// Everything here is arithmetic on the per-strike rows and the per-expiry grid that lib/gex.js
// already computes; no chain is re-read. Observational throughout — the pre-read runs its lines
// through assertObservational.

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// ── THE THRESHOLDS, STATED ───────────────────────────────────────────────────
export const SUPPORT_MIN_DIST_PCT = 1.0;   // inside this (or one ATR) is the pin box, not a wall
export const SUPPORT_MAX_DIST_PCT = 5.0;   // beyond this the tile prints "none inside 5%"
export const SUPPORT_MIN_SHARE = 0.05;     // of total below-spot positive gamma
// The near trapdoor: the LARGEST negative node within ~2% below spot (2.25% — two percent plus a
// strike's slack). At 1.5% QQQ's 2 Oct board named 742 (−57M) while 736 (−234M, mostly the 5 Oct
// expiry) sat 2.06% below — the cliff was just outside the window and a small cell won by default.
export const TRAPDOOR_NEAR_PCT = 2.25;
export const TRAPDOOR_TODAY_VETO = 0.25;    // …skipping a strike whose TODAY cell is positive and over a quarter of its net
export const TRAPDOOR_PAIR_FRAC = 0.5;      // an adjacent qualifying strike at least half the size is named with it (760/761)
export const TRAPDOOR_DEEP_PCT = 10;
export const TRAPDOOR_MIN_FRAC = 0.25;     // a near node counts at a quarter of the largest one (implied: the largest in the window wins)
// The deep trapdoor is looked for within 5% of spot. Further out it is not a level the day can
// reach: QQQ's 30 Sep deep read 700, 5.9% away.
export const TRAPDOOR_DEEP_MAX_PCT = 5.0;
export const TRAPDOOR_GAP_PCT = 1.0;       // the deep one sits at least this far below the near one
export const TRAPDOOR_DEEP_MIN_FRAC = 0.10; // …and is at least a tenth of the near one's size
export const PIN_HALF_PCT = 0.5;           // (no longer bounds the box — kept for callers that print it)
export const PIN_MAX_PCT = 5;              // the positive run is not followed past 5% of spot
export const PIN_TAIL_FRAC = 0.05;         // …nor into the tail: a cell under 5% of the run's peak ends it
export const CALL_WALL_MAX_PCT = 5;        // the call wall is the largest positive node above spot within 5%
export const PIN_MIN_SHARE = 0.10;         // of the nearest expiry's gross gamma
export const BALANCE_MIN_RATIO = 0.5;      // same sign: the larger side ≥ 2× the smaller is asymmetric (5 Oct brief)

// ── FORMATTING, SHARED WITH THE PANEL AND THE BRIEF ──────────────────────────
export const fmtM = (v) => {
  const x = num(v);
  if (x == null) return '—';
  const a = Math.abs(x), s = x < 0 ? '−' : '+';
  if (a >= 1e9) return `${s}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}${Math.round(a / 1e6)}M`;
  if (a >= 1e3) return `${s}${Math.round(a / 1e3)}K`;
  return `${s}${Math.round(a)}`;
};
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// '2026-10-16' → 'Oct-16'. Short enough for a tile, unambiguous inside a quarter.
export const shortExpiry = (e) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(e || ''));
  return m ? `${MON[+m[2] - 1]}-${m[3]}` : (e ? String(e) : '—');
};
const fmtK = (k) => k == null ? '—' : (Number.isInteger(k) ? String(k) : (+k).toFixed(2));
const pctBelow = (k, spot) => +((1 - k / spot) * 100).toFixed(1);

// ── HOW FAR IS FAR ENOUGH ────────────────────────────────────────────────────
// max(1% of spot, one ATR(14)). Inside that band a strike is where price already is, and a
// "wall" you are standing on is not a wall. The ATR is the underlying's own recent daily range;
// when none is supplied the 1% floor stands alone and the basis says so.
export function distanceFloor(spot, atr = null) {
  const s = num(spot), a = num(atr);
  if (s == null || !(s > 0)) return { pts: null, pct: null, basis: 'no spot' };
  const onePct = s * SUPPORT_MIN_DIST_PCT / 100;
  if (a != null && a > onePct) return { pts: +a.toFixed(4), pct: +((a / s) * 100).toFixed(2), basis: 'ATR(14)' };
  return { pts: +onePct.toFixed(4), pct: SUPPORT_MIN_DIST_PCT, basis: a == null ? '1% (no ATR supplied)' : '1%' };
}

// ── THE GRID, INDEXED ────────────────────────────────────────────────────────
// Per-expiry peaks come from the grid rows when they carry them (gammaGrid does) and are derived
// from the cells when they do not, so a fixture of bare cells is enough to test against.
function indexGrid(grid, today = null) {
  const cells = Array.isArray(grid?.cells) ? grid.cells : [];
  const rows = Array.isArray(grid?.expiries) ? grid.expiries : [];
  const byStrike = new Map();    // strike → [{ expiry, v }]
  const posPeak = new Map(), negPeak = new Map();   // expiry → { k, v }
  for (const c of cells) {
    const k = num(c?.strike), v = num(c?.netGexUsd), e = c?.expiry;
    if (k == null || v == null || !e) continue;
    if (!byStrike.has(k)) byStrike.set(k, []);
    byStrike.get(k).push({ expiry: e, v });
    if (v > 0 && (!posPeak.has(e) || v > posPeak.get(e).v)) posPeak.set(e, { k, v });
    if (v < 0 && (!negPeak.has(e) || v < negPeak.get(e).v)) negPeak.set(e, { k, v });
  }
  const expiries = rows.length ? rows.map(r => r.expiry) : [...new Set(cells.map(c => c?.expiry).filter(Boolean))].sort();
  const peakOf = (r, key, derived) => {
    const v = num(r?.[key]);
    return v != null ? v : (derived.get(r?.expiry)?.k ?? null);
  };
  const peaks = expiries.map(e => {
    const r = rows.find(x => x.expiry === e) || { expiry: e };
    return { expiry: e, pos: peakOf(r, 'peakCallStrike', posPeak), neg: peakOf(r, 'peakPutStrike', negPeak) };
  });
  // TODAY'S expiry is the first one not already past; with no date given, the nearest.
  const front = (today ? expiries.find(e => e >= today) : expiries[0]) || null;
  return { byStrike, expiries, peaks, front };
}

// Which expiries peak at this strike, on the side that matters: a positive node is some expiry's
// largest positive cell, a negative node its largest negative one. Exact match — a peak three
// strikes away is a different level, the same rule lib/gexRead.js's wallAgreement uses.
export function peaksAt(grid, strike, sign = 1) {
  const g = indexGrid(grid);
  const k = num(strike);
  if (k == null) return { agree: 0, total: g.peaks.length, matched: [] };
  const matched = g.peaks.filter(p => (sign > 0 ? p.pos : p.neg) === k).map(p => p.expiry);
  return { agree: matched.length, total: g.peaks.length, matched };
}

// The expiry carrying most of a strike's gamma on the given side, so a tile can say "(Oct-16)".
export function heaviestExpiryAt(grid, strike, sign = 1) {
  const g = indexGrid(grid);
  const list = g.byStrike.get(num(strike)) || [];
  let best = null;
  for (const c of list) {
    if (sign > 0 ? c.v <= 0 : c.v >= 0) continue;
    if (!best || (sign > 0 ? c.v > best.v : c.v < best.v)) best = c;
  }
  return best ? { expiry: best.expiry, netGexUsd: best.v } : null;
}

const rowsOf = (byStrike) => (Array.isArray(byStrike) ? byStrike : [])
  .map(r => ({ strike: num(r?.strike), net: num(r?.netGexUsd) }))
  .filter(r => r.strike != null && r.net != null);

// ── A. PUT SUPPORT — the wall, if there is one ───────────────────────────────
export function putSupport(byStrike, grid, { spot, atr = null } = {}) {
  const s = num(spot);
  const floor = distanceFloor(s, atr);
  const none = (reason, extra = {}) => ({ strike: null, reason, floor, ...extra });
  if (s == null || !(s > 0)) return none('no spot');
  const below = rowsOf(byStrike).filter(r => r.strike < s);
  if (!below.length) return none('no strikes below spot');
  const positiveTotal = below.reduce((a, r) => a + Math.max(0, r.net), 0);
  const rejected = [];
  const passing = [];
  for (const r of below.filter(r => r.net > 0).sort((a, b) => b.net - a.net)) {
    const dist = s - r.strike, distPct = (dist / s) * 100;
    const pk = peaksAt(grid, r.strike, 1);
    const share = positiveTotal > 0 ? r.net / positiveTotal : 0;
    let why = null;
    if (distPct > SUPPORT_MAX_DIST_PCT) why = `beyond ${SUPPORT_MAX_DIST_PCT}% of spot`;
    else if (dist < floor.pts) why = `inside the pin band (${floor.pct}% / ${floor.basis})`;
    else if (pk.agree === 0) why = `no expiry peaks there (0 of ${pk.total})`;
    else if (share < SUPPORT_MIN_SHARE) why = `under ${SUPPORT_MIN_SHARE * 100}% of below-spot positive gamma`;
    const cand = { strike: r.strike, netGexUsd: +r.net.toFixed(0), pctBelow: pctBelow(r.strike, s),
                   distancePts: +dist.toFixed(2), peaks: pk.agree, of: pk.total, matched: pk.matched,
                   share: +(share * 100).toFixed(1) };
    if (why) rejected.push({ ...cand, why }); else passing.push(cand);
  }
  // Nearest rejects first — those are the ones a reader (or CBOE) will have called the wall.
  rejected.sort((a, b) => a.distancePts - b.distancePts);
  if (!passing.length) {
    return none(`no put support inside ${SUPPORT_MAX_DIST_PCT}%`, { rejected: rejected.slice(0, 4), positiveTotal: +positiveTotal.toFixed(0) });
  }
  // The largest qualifying node is the wall. Ties in size go to the nearer strike.
  passing.sort((a, b) => b.netGexUsd - a.netGexUsd || a.distancePts - b.distancePts);
  const best = passing[0];
  const owner = heaviestExpiryAt(grid, best.strike, 1);
  return { ...best, expiry: owner?.expiry ?? best.matched[0] ?? null, floor, reason: null,
           rejected: rejected.slice(0, 4), positiveTotal: +positiveTotal.toFixed(0) };
}

// ── B. TRAPDOOR — never "wall" ───────────────────────────────────────────────
// NEAR is the LARGEST negative summed node within 1.5% below spot — not the nearest — skipping a
// strike whose TODAY cell is positive and more than a quarter of the node's net: on 30 Sep SPY's 765
// summed −316M only through Friday and 1 Oct while today's cell there was +181M, so price reaching it
// meets support today, not a hole; the real cliff was 760/761 (−985M / −627M, 761 −525M today). An
// adjacent strike that also qualifies at half the size or more is named with it ("760/761").
// DEEP is the largest negative node inside 10% at least 1% below the near one (and a tenth of its
// size) — the NEXT air pocket, never the strike next door. None qualifying is `deep: null` with a note.
export function trapdoors(byStrike, grid, { spot, today = null } = {}) {
  const s = num(spot);
  if (s == null || !(s > 0)) return { near: null, deep: null, sameStrike: false };
  const g = indexGrid(grid, today);
  const todayAt = (k) => { const hit = (g.byStrike.get(k) || []).find(c => c.expiry === g.front); return hit ? hit.v : null; };
  const neg = rowsOf(byStrike).filter(r => r.strike < s && r.net < 0);
  const describe = (r) => {
    const owner = heaviestExpiryAt(grid, r.strike, -1);
    const pk = peaksAt(grid, r.strike, -1);
    const t = todayAt(r.strike);
    return { strike: r.strike, netGexUsd: +r.net.toFixed(0), todayGexUsd: t == null ? null : +t.toFixed(0), pctBelow: pctBelow(r.strike, s),
             expiry: owner?.expiry ?? null, expiryGexUsd: owner?.netGexUsd == null ? null : +owner.netGexUsd.toFixed(0),
             peaks: pk.agree, of: pk.total };
  };
  const inside = (maxPct) => neg.filter(r => ((s - r.strike) / s) * 100 <= maxPct);
  const deepRows = inside(TRAPDOOR_DEEP_PCT);
  if (!deepRows.length) return { near: null, deep: null, sameStrike: false, deepNote: 'no negative node below spot inside 10%' };
  const deepest = deepRows.reduce((a, b) => (b.net < a.net ? b : a));
  const vetoed = [];
  const nearRows = inside(TRAPDOOR_NEAR_PCT).filter(r => {
    const t = todayAt(r.strike);
    const veto = t != null && t > 0 && t > Math.abs(r.net) * TRAPDOOR_TODAY_VETO;
    if (veto) vetoed.push({ strike: r.strike, netGexUsd: +r.net.toFixed(0), todayGexUsd: +t.toFixed(0) });
    return !veto;
  });
  const best = nearRows.length ? nearRows.reduce((a, b) => (b.net < a.net ? b : a)) : null;
  let near = best ? describe(best) : null;
  if (near) {
    // The strike grid's own spacing near spot, so "adjacent" means one strike, whatever the step.
    const ks = [...new Set(rowsOf(byStrike).map(r => r.strike))].sort((a, b) => a - b);
    const i = ks.indexOf(best.strike);
    const mates = [ks[i - 1], ks[i + 1]].map(k => nearRows.find(r => r.strike === k))
      .filter(r => r && Math.abs(r.net) >= Math.abs(best.net) * TRAPDOOR_PAIR_FRAC);
    if (mates.length) {
      const mate = mates.reduce((a, b) => (b.net < a.net ? b : a));
      const pair = [best.strike, mate.strike].sort((a, b) => a - b);
      near = { ...near, pair, pairLabel: pair.map(fmtK).join('/'), mate: describe(mate) };
    }
  }
  const below0 = near ? deepRows.filter(r => r.strike <= near.strike * (1 - TRAPDOOR_GAP_PCT / 100)
                                          && Math.abs(r.net) >= Math.abs(near.netGexUsd) * TRAPDOOR_DEEP_MIN_FRAC) : deepRows;
  const below = below0.filter(r => ((s - r.strike) / s) * 100 <= TRAPDOOR_DEEP_MAX_PCT);
  const deep = below.length ? describe(below.reduce((a, b) => (b.net < a.net ? b : a))) : null;
  const deepNote = deep ? null
    : below0.length ? `next node beyond ${TRAPDOOR_DEEP_MAX_PCT}%`
    : near ? `no negative node at least ${TRAPDOOR_GAP_PCT}% below ${fmtK(near.strike)} inside 10% of spot` : null;
  const sameStrike = !!(near && !deep && near.strike === deepest.strike);
  return { near: near ?? null, deep, deepNote, sameStrike, deepestStrike: deepest.strike, vetoed };
}

// ── C. PIN BOX ───────────────────────────────────────────────────────────────
// The contiguous run of strikes around spot where TODAY's expiry cell is positive, stopping at the
// first negative cell on each side (and never at a trapdoor strike). The ±0.5% window it replaced
// cut through the book: on 30 Sep QQQ's box ran 736–744 with its floor ON the −1.8B trapdoor, and
// SPY's left out 766 (+877M), the largest cell of all, because the magnets were taken above spot
// only. Magnets are the two largest positive cells inside the box, either side of spot. Pinned when
// the box carries at least a tenth of today's gross gamma. The run also stops where the cells fall
// under 5% of its peak (the far-OTM tail), and at a trapdoor strike.
export function pinBox(byStrike, grid, { spot, today = null, exclude = [] } = {}) {
  const s = num(spot);
  if (s == null || !(s > 0)) return { pinned: false, lo: null, hi: null, reason: 'no spot' };
  const g = indexGrid(grid, today);
  if (!g.front) return { pinned: false, lo: null, hi: null, reason: 'no expiry breakdown' };
  const cells = [];
  let gross = 0;
  for (const [k, list] of g.byStrike) for (const c of list) if (c.expiry === g.front) { cells.push({ k, v: c.v }); gross += Math.abs(c.v); }
  cells.sort((a, b) => a.k - b.k);
  const bad = new Set((exclude || []).map(num).filter(v => v != null));
  // Far out of the money every call cell is a sliver of positive gamma, so "stop at the first
  // negative" alone never stops above spot (SPY ran to 805 on 30 Sep). The run also ends at a cell
  // under 5% of the largest positive cell within 2% of spot — the tail, not the pin.
  const peak = cells.filter(c => c.v > 0 && Math.abs(c.k - s) / s * 100 <= 2).reduce((m, c) => Math.max(m, c.v), 0);
  const ok = (c) => c && c.v > 0 && c.v >= peak * PIN_TAIL_FRAC && !bad.has(c.k) && Math.abs(c.k - s) / s * 100 <= PIN_MAX_PCT;
  // Nor across a stretch with no cell today: consecutive strikes (and the first from spot) more
  // than 1% of spot apart end the run — a sparse expiry is not a continuous block.
  const near = (a, b) => Math.abs(a - b) / s * 100 <= 1;
  // A FLAT CELL IS NOT A WALL. "Stop at the first negative" stopped at noise: QQQ on 1 and 2 Oct
  // had today's cells at 742 −1.9M and 743 −14.7M against +414M at 745, and the box came back empty
  // — "negative either side of spot" — around the clearest pin on the board. A cell smaller than the
  // tail threshold either way (under 5% of the peak) is stepped over, once; it is not counted in the
  // box, and two in a row still end the run, which is what keeps the far-OTM tail out.
  const flat = (c) => c && Math.abs(c.v) < peak * PIN_TAIL_FRAC && !bad.has(c.k);
  const walk = (start, step) => {
    const out = [];
    for (let i = start, prev = s, skipped = 0; i >= 0 && i < cells.length; i += step) {
      const c = cells[i];
      if (!near(c.k, prev) || Math.abs(c.k - s) / s * 100 > PIN_MAX_PCT) break;
      if (ok(c)) { out.push(c); skipped = 0; } else if (flat(c) && skipped < 1) skipped++; else break;
      prev = c.k;
    }
    return out;
  };
  let up = cells.findIndex(c => c.k >= s); if (up < 0) up = cells.length;
  const box = [...walk(up - 1, -1).reverse(), ...walk(up, 1)];
  const inBox = box.reduce((a, c) => a + Math.abs(c.v), 0);
  const share = gross > 0 ? inBox / gross : 0;
  const magnets = [...box].sort((a, b) => b.v - a.v).slice(0, 2).map(c => c.k).sort((a, b) => a - b);
  const base = { front: g.front, share: +(share * 100).toFixed(1), strikes: box.map(c => c.k), magnets,
                 magnetGex: Object.fromEntries(magnets.map(k => [k, +box.find(c => c.k === k).v.toFixed(0)])) };
  if (!box.length) return { ...base, pinned: false, lo: null, hi: null, reason: `${shortExpiry(g.front)} is negative either side of spot — no positive run to pin` };
  if (share < PIN_MIN_SHARE) {
    return { ...base, pinned: false, lo: null, hi: null,
             reason: `${shortExpiry(g.front)}'s positive run ${fmtK(box[0].k)}–${fmtK(box[box.length - 1].k)} carries ${(share * 100).toFixed(0)}% of its gamma — under ${PIN_MIN_SHARE * 100}%` };
  }
  return { ...base, pinned: true, lo: box[0].k, hi: box[box.length - 1].k, reason: null };
}

// ── THE CALL SIDE: THE LARGEST POSITIVE NODE ABOVE SPOT ─────────────────────
// The call wall is the strike with the largest summed positive gamma above spot, within 5%. It was
// the heaviest call-gamma strike, which on 30 Sep was SPY's 770 (+805M, peaking in 0 of 8 expiries)
// while 785 was +1.39B peaking in two and 780 +901M; CBOE said 785. The near-spot ceiling keeps its
// role as the PIN TOP (the box's upper edge). The largest node peaks in some expiry by construction,
// so "0 of N" on the wall is logged as a defect. With no positive node above spot inside 5%, the
// heaviest call-gamma strike stands in, and below spot it reads as a magnet, as before.
export function callWallOf(byStrike, grid, { spot, atr = null, callWall = null } = {}) {
  const s = num(spot);
  const rows = rowsOf(byStrike);
  const above = s == null ? [] : rows.filter(r => r.strike > s && r.net > 0 && ((r.strike / s) - 1) * 100 <= CALL_WALL_MAX_PCT);
  let k = above.length ? above.reduce((a, b) => (b.net > a.net ? b : a)).strike : null;
  const source = k != null ? 'largest positive above spot' : 'heaviest call gamma (no positive node above spot inside 5%)';
  if (k == null) k = num(callWall);
  if (k == null) {
    const cand = (Array.isArray(byStrike) ? byStrike : [])
      .map(r => ({ strike: num(r?.strike), g: num(r?.callGamma) ?? num(r?.callGexUsd) }))
      .filter(r => r.strike != null && r.g != null && r.g > 0)
      .reduce((a, b) => (!a || b.g > a.g ? b : a), null);
    k = cand?.strike ?? null;
  }
  if (k == null || s == null) return { strike: k, kind: null, netGexUsd: null, inPin: false, peaks: 0, of: 0, source };
  const floor = distanceFloor(s, atr);
  const net = rows.find(r => r.strike === k)?.net ?? null;
  const pk = peaksAt(grid, k, 1);
  const kind = k > s ? 'ceiling' : 'magnet';
  const defect = above.length > 0 && pk.total > 0 && pk.agree === 0;
  if (defect) console.warn(`[gexLevels] defect: call wall ${k} (largest positive above spot) peaks in 0 of ${pk.total} expiries`);
  return { strike: k, kind, netGexUsd: net == null ? null : +net.toFixed(0),
           pctFromSpot: +(((k / s) - 1) * 100).toFixed(1),
           inPin: floor.pts != null && Math.abs(k - s) < floor.pts,
           peaks: pk.agree, of: pk.total, source, ...(defect ? { defect: true } : {}) };
}

// ── BALANCE, WITH A DIRECTION ────────────────────────────────────────────────
// SIGN FIRST, THEN SIZE (5 Oct brief). The old rule compared magnitudes only, so −$3.16B below
// against +$5.14B above was "balanced": the two sides were nearly equal in size and opposite in
// effect — dips amplified, rallies damped — which is the opposite of balance.
//   opposite signs                       → opposed_neg_below / opposed_neg_above
//   same sign, |larger| ≥ 2 × |smaller|  → asymmetric_up / asymmetric_down
//   otherwise                            → balanced
// The rule's inputs travel with the label so a reader can check it.
export function balanceOf({ above, below } = {}) {
  const a = num(above), b = num(below);
  if (a == null || b == null) return { state: null, sentence: null };
  const usdB = (v) => `${v < 0 ? '−' : ''}$${Math.abs(v / 1e9).toFixed(2)}B`;
  const big = Math.max(Math.abs(a), Math.abs(b)), small = Math.min(Math.abs(a), Math.abs(b));
  const ratio = big > 0 ? +(small / big).toFixed(2) : 1;
  const sameSign = !(a * b < 0);
  const inputs = { above: Math.round(a), below: Math.round(b), same_sign: sameSign, ratio, asymmetric_at: BALANCE_MIN_RATIO };
  if (!sameSign) {
    const state = b < 0 ? 'opposed_neg_below' : 'opposed_neg_above';
    const words = b < 0 ? 'dips amplified, rallies damped' : 'rallies amplified, dips cushioned';
    return { state, ratio, inputs, sentence: `Gamma is opposed — ${usdB(b)} below / ${usdB(a)} above: ${words}.` };
  }
  if (ratio > BALANCE_MIN_RATIO) {
    return { state: 'balanced', ratio, inputs, sentence: `Gamma is roughly balanced either side of spot (${usdB(b)} below, ${usdB(a)} above).` };
  }
  const aboveDominates = Math.abs(a) >= Math.abs(b);
  const state = aboveDominates ? 'asymmetric_up' : 'asymmetric_down';
  const words = aboveDominates
    ? (a >= 0 ? 'upside damped, downside thin' : 'upside amplified, downside thin')
    : (b >= 0 ? 'downside cushioned, upside thin' : 'downside amplified, upside thin');
  return { state, ratio, inputs, sentence: `Gamma is asymmetric — ${usdB(a)} above / ${usdB(b)} below: ${words}.` };
}

// ── TILE TEXT ────────────────────────────────────────────────────────────────
export function supportText(sp) {
  if (!sp?.strike) return sp?.reason || 'no put support';
  return `${fmtK(sp.strike)} · ${fmtM(sp.netGexUsd)} ${shortExpiry(sp.expiry)} · peaks ${sp.peaks} of ${sp.of} · ${sp.pctBelow}% below`;
}
export function trapdoorText(td) {
  if (!td?.near && !td?.deep) return 'no negative node below spot inside 10%';
  const today = (t) => (t.todayGexUsd != null && t.todayGexUsd !== t.expiryGexUsd ? `, today ${fmtM(t.todayGexUsd)}` : '');
  const one = (t) => `${t.pairLabel || fmtK(t.strike)} · ${fmtM(t.netGexUsd)} (${shortExpiry(t.expiry)}${today(t)}) · ${t.pctBelow}% below`;
  const lead = td.near ? one(td.near) : null;
  const deep = td.deep ? `deeper: ${one(td.deep)}` : td.deepNote ? `deeper: none — ${td.deepNote}` : null;
  return [lead || `none inside ${TRAPDOOR_NEAR_PCT}%`, deep].filter(Boolean).join(' · ');
}
export function pinText(pin) {
  if (!pin?.pinned) return pin?.reason ? `no pin — ${pin.reason}` : 'no pin';
  const mag = pin.magnets?.length ? ` · magnets ${pin.magnets.map(fmtK).join('/')}` : '';
  return `${fmtK(pin.lo)}–${fmtK(pin.hi)} · ${shortExpiry(pin.front)} ${pin.share}%${mag}`;
}
export function callWallText(cw) {
  if (!cw?.strike) return '—';
  if (!cw.kind) return fmtK(cw.strike);
  return `${fmtK(cw.strike)} · ${cw.kind} (${cw.kind === 'ceiling' ? 'above' : 'below'} spot${cw.inPin ? ', inside the pin band' : ''})`;
}

// The one-line summary under the regime headline: the OBJECTS, not the labels.
export function regimeLine(lv) {
  if (!lv) return null;
  const sp = lv.support?.strike ? `Cushion at ${fmtK(lv.support.strike)}` : `Cushion: none inside ${SUPPORT_MAX_DIST_PCT}%`;
  const tds = [lv.trapdoor?.near ? (lv.trapdoor.near.pairLabel || fmtK(lv.trapdoor.near.strike)) : null, lv.trapdoor?.deep ? fmtK(lv.trapdoor.deep.strike) : null].filter(v => v != null);
  const td = tds.length ? `acceleration below ${tds.join(' and ')}` : 'no acceleration node below spot';
  const pin = lv.pin?.pinned ? `pin ${fmtK(lv.pin.lo)}–${fmtK(lv.pin.hi)}` : 'no pin';
  return `${sp}; ${td}; ${pin}.`;
}

// The same line with the sizes and the owning expiries, for the read.
export function regimeDetail(lv) {
  if (!lv) return null;
  const sp = lv.support?.strike
    ? `Cushion at ${fmtK(lv.support.strike)} (${fmtM(lv.support.netGexUsd)}, ${shortExpiry(lv.support.expiry)}, ${lv.support.pctBelow}% below, peaks ${lv.support.peaks} of ${lv.support.of})`
    : `Cushion: none inside ${SUPPORT_MAX_DIST_PCT}%`;
  const one = (t) => `${t.pairLabel || fmtK(t.strike)} (${fmtM(t.netGexUsd)}, ${shortExpiry(t.expiry)}, ${t.pctBelow}% below)`;
  const tds = [lv.trapdoor?.near, lv.trapdoor?.deep].filter(Boolean).map(one);
  const td = tds.length ? `acceleration below ${tds.join(' and ')}` : 'no acceleration node below spot inside 10%';
  const pin = lv.pin?.pinned
    ? `pin ${fmtK(lv.pin.lo)}–${fmtK(lv.pin.hi)} (${shortExpiry(lv.pin.front)} ${lv.pin.share}%${lv.pin.magnets?.length ? `, magnets ${lv.pin.magnets.map(fmtK).join('/')}` : ''})`
    : 'no pin';
  const cw = lv.callWall?.strike != null && lv.callWall.kind
    ? ` Call wall ${fmtK(lv.callWall.strike)} is a ${lv.callWall.kind} (${lv.callWall.kind === 'ceiling' ? 'above' : 'below'} spot${lv.callWall.inPin ? ', inside the pin band' : ''}).`
    : '';
  return `${sp}; ${td}; ${pin}.${cw}`;
}

// ── ALL OF IT, ONCE ──────────────────────────────────────────────────────────
// TODAY'S BOOK: the net gamma in today's expiry, and the board without it — what the book looks
// like tomorrow at the same spot. On 30 Sep SPY was +518M in total and −1.96B ex-today.
export function todaySplit(grid, { today = null } = {}) {
  const g = indexGrid(grid, today);
  if (!g.front || (today && g.front !== today)) return { expiry: today ?? null, today: 0, total: null, exToday: null };
  let total = 0, t = 0;
  for (const list of g.byStrike.values()) for (const c of list) { total += c.v; if (c.expiry === g.front) t += c.v; }
  return { expiry: g.front, today: +t.toFixed(0), total: +total.toFixed(0), exToday: +(total - t).toFixed(0) };
}

export function levelsOf({ byStrike = [], grid = null, spot, atr = null, callWall = null, today = null } = {}) {
  const s = num(spot);
  const rows = rowsOf(byStrike);
  let above = 0, below = 0;
  for (const r of rows) { if (s != null && r.strike > s) above += r.net; else if (s != null && r.strike < s) below += r.net; }
  const support = putSupport(byStrike, grid, { spot: s, atr });
  const trapdoor = trapdoors(byStrike, grid, { spot: s, today });
  // A trapdoor strike is never a pin-box edge.
  const holes = [trapdoor.near?.strike, ...(trapdoor.near?.pair || []), trapdoor.deep?.strike].filter(v => v != null);
  const pin = pinBox(byStrike, grid, { spot: s, atr, today, exclude: holes });
  const cw = callWallOf(byStrike, grid, { spot: s, atr, callWall });
  const balance = rows.length && s != null ? balanceOf({ above, below }) : { state: null, sentence: null };
  const lv = { spot: s, atr: num(atr), floor: distanceFloor(s, atr), support, trapdoor, pin, callWall: cw,
               // The near-spot ceiling the old call wall used to name: the pin box's top.
               pinTop: pin?.pinned ? pin.hi : null,
               todayBook: todaySplit(grid, { today }),
               balance: { ...balance, above: +above.toFixed(0), below: +below.toFixed(0) } };
  lv.text = { support: supportText(support), trapdoor: trapdoorText(trapdoor), pin: pinText(pin), callWall: callWallText(cw) };
  lv.summary = regimeLine(lv);
  return lv;
}

// ── THE RATE LINE, NEVER "0.00%" ─────────────────────────────────────────────
// Six boards printed 0.00% against a funds range near 4%: a fetch failure displayed as a value.
// Live prints as a value; the last good print prints dated and marked stale; nothing prints as
// unavailable, and the columns the rate actually moves are greyed rather than priced at zero.
export const RATE_FAR_DAYS = 35;
export function rateLine(row) {
  if (!row) return '';
  const r = num(row.rate);
  const status = row.rateStatus || (r > 0 ? 'live' : 'unavailable');
  if (status === 'unavailable' || !(r > 0)) {
    return ` Risk-free rate unavailable — no live DTB3 print and no last good one; expiries ${RATE_FAR_DAYS}+ days out are priced at 0% and greyed in the grid.`;
  }
  const src = String(row.rateSource || 'DTB3').replace(/\s*\(stale\)\s*$/, '');
  return ` Risk-free rate ${(r * 100).toFixed(2)}% (${src}${status === 'stale' ? ', stale — FRED did not answer, last good print' : ''}).`;
}
export const rateFarOut = (expiry, now = Date.now()) => {
  const t = Date.parse(String(expiry || ''));
  return Number.isFinite(t) && (t - now) / 864e5 >= RATE_FAR_DAYS;
};

// ── THE NEGATIVE STACK ───────────────────────────────────────────────────────
// A contiguous run of negative-net strikes starting right under spot is the sentence a day trader
// wants first: "negative 735–745 directly under spot, 2% of air to 730". Walked down from the
// nearest listed strike below spot while the net stays negative; the first positive node after it
// is where the air ends. Touching means the top of the run is inside the pin half-width of spot.
export const STACK_TOUCH_PCT = 0.6;
export const STACK_SLIVER = 0.1;   // leading positive gamma under this share of the run below is stepped over

export function negativeStack(byStrike, { spot } = {}) {
  const s = num(spot);
  const rows = rowsOf(byStrike).filter(r => r.strike < (s ?? -Infinity)).sort((a, b) => b.strike - a.strike);
  if (s == null || !rows.length) return { strikes: [], touching: false, lo: null, hi: null, netGexUsd: null, nextPositive: null, airPct: null };
  const run = [];
  let i = 0;
  // A SLIVER IS NOT A FLOOR. On 2026-09-25 SPY sat at 767.18 with 767 at +52M and every strike from
  // 766 to 755 negative — about −2.0B together — and the brief printed "no negative stack under
  // spot" because the walk stopped at the first strike. Leading positive strikes are stepped over
  // when together they are under a tenth of the negative run beneath them; a real positive floor,
  // anything larger, still ends the stack before it starts.
  const firstNeg = rows.findIndex(r => r.net < 0);
  if (firstNeg > 0) {
    const lead = rows.slice(0, firstNeg).reduce((a, r) => a + r.net, 0);
    let k = firstNeg, below = 0;
    const edge0 = s * (1 - SUPPORT_MAX_DIST_PCT / 100);
    while (k < rows.length && rows[k].net < 0 && rows[k].strike >= edge0) { below += rows[k].net; k++; }
    if (lead < STACK_SLIVER * Math.abs(below)) i = firstNeg;
  }
  // The stack starts at the first listed strike below spot. If that is positive there is no
  // stack, and the honest line says so. The walk stops at the support window (5%): on SPY the
  // whole 10% band below spot was negative, and "negative 700–768" is true and useless.
  const edge = s * (1 - SUPPORT_MAX_DIST_PCT / 100);
  while (i < rows.length && rows[i].net < 0 && rows[i].strike >= edge) { run.push(rows[i]); i++; }
  const truncated = i < rows.length && rows[i].net < 0 && rows[i].strike < edge;
  const next = truncated ? null : (rows.slice(i).find(r => r.net > 0) || null);
  if (!run.length) {
    return { strikes: [], touching: false, lo: null, hi: null, netGexUsd: null,
             nextPositive: next ? { strike: next.strike, netGexUsd: +next.net.toFixed(0), pctBelow: pctBelow(next.strike, s) } : null,
             airPct: null, truncated: false };
  }
  const hi = run[0].strike, lo = run[run.length - 1].strike;
  const touching = ((s - hi) / s) * 100 <= STACK_TOUCH_PCT;
  const net = run.reduce((a, r) => a + r.net, 0);
  return {
    strikes: run.map(r => r.strike), touching, lo, hi, netGexUsd: +net.toFixed(0),
    nextPositive: next ? { strike: next.strike, netGexUsd: +next.net.toFixed(0), pctBelow: pctBelow(next.strike, s) } : null,
    // From the top of the stack to the first positive node: the distance a fall is undamped over.
    airPct: next ? +(((hi - next.strike) / s) * 100).toFixed(1) : null,
    // True when the run reached the window's edge still negative — there is no positive node
    // inside 5% at all.
    truncated,
  };
}

// ── THE LADDER'S RAW MATERIAL ────────────────────────────────────────────────
// The heaviest nodes either side of spot, each with the expiry that owns most of it, so the brief
// can print "748 · 750 (3 of 8, ceiling) · 752 · 755 (Fri)" above and the trapdoors, the support
// and the pivot-after-today below — nearest first, never more than a handful.
export const LADDER_ABOVE_PCT = 2.5;
export const LADDER_BELOW_PCT = 3.0;
export const LADDER_MAX = 4;

export function ladderNodes(byStrike, grid, { spot, levels = null, callWall = null, pivotAfter = null, today = null } = {}) {
  const s = num(spot);
  const rows = rowsOf(byStrike);
  if (s == null || !rows.length) return { above: [], below: [] };
  const owner = (k, sign) => heaviestExpiryAt(grid, k, sign)?.expiry ?? null;
  const cw = num(callWall) ?? num(levels?.callWall?.strike);
  const above = rows.filter(r => r.strike > s && r.net > 0 && ((r.strike - s) / s) * 100 <= LADDER_ABOVE_PCT)
    .sort((a, b) => b.net - a.net).slice(0, LADDER_MAX)
    .map(r => ({ strike: r.strike, netGexUsd: +r.net.toFixed(0), expiry: owner(r.strike, 1),
                 wall: r.strike === cw, peaks: r.strike === cw ? peaksAt(grid, r.strike, 1) : null }))
    .sort((a, b) => a.strike - b.strike);
  // Below: the negative nodes inside 3%, the deep trapdoor if it is further, the support, and the
  // pivot after today's expiry — deduplicated by strike, nearest first.
  const seen = new Map();
  const put = (k, o) => { if (num(k) == null) return; if (!seen.has(k)) seen.set(k, { strike: k, ...o }); else Object.assign(seen.get(k), o); };
  for (const r of rows.filter(r => r.strike < s && r.net < 0 && ((s - r.strike) / s) * 100 <= LADDER_BELOW_PCT)
    .sort((a, b) => a.net - b.net).slice(0, LADDER_MAX)) {
    put(r.strike, { netGexUsd: +r.net.toFixed(0), expiry: owner(r.strike, -1), kind: 'negative' });
  }
  const deep = levels?.trapdoor?.deep;
  if (deep?.strike != null) put(deep.strike, { netGexUsd: deep.netGexUsd, expiry: deep.expiry, kind: 'negative', deep: true });
  const near = levels?.trapdoor?.near;
  if (near?.strike != null) put(near.strike, { netGexUsd: near.netGexUsd, expiry: near.expiry, kind: 'negative' });
  const sp = levels?.support;
  if (sp?.strike != null) put(sp.strike, { netGexUsd: sp.netGexUsd, expiry: sp.expiry, kind: 'support', peaks: { agree: sp.peaks, total: sp.of } });
  // A call wall BELOW spot is a magnet, and it belongs on the below line with that word — on
  // 23 Sep QQQ's heaviest call strike was 740 with spot 740.69, and the ladder said nothing.
  if (cw != null && cw < s && levels?.callWall?.kind === 'magnet') {
    const r = rows.find(x => x.strike === cw);
    put(cw, { magnet: true, ...(seen.has(cw) ? {} : { netGexUsd: r ? +r.net.toFixed(0) : null, expiry: owner(cw, 1), kind: r && r.net < 0 ? 'negative' : 'positive' }) });
  }
  const pv = num(pivotAfter);
  if (pv != null && pv < s) put(+pv.toFixed(2), { kind: 'pivot' });
  const below = [...seen.values()].sort((a, b) => b.strike - a.strike);
  return { above, below, today };
}

// ── WHAT GETS PERSISTED PER BOARD ────────────────────────────────────────────
// Flat, so the monthly review can answer "how often did price stop at put support versus fall
// through the trapdoor" — which is the question the label exists for.
export function levelsLog(lv, { rate = null, rateStatus = null } = {}) {
  return {
    put_support_strike: lv?.support?.strike ?? null,
    trapdoor_near: lv?.trapdoor?.near?.strike ?? null,
    trapdoor_deep: lv?.trapdoor?.deep?.strike ?? (lv?.trapdoor?.sameStrike ? lv.trapdoor.near.strike : null),
    pin_lo: lv?.pin?.pinned ? lv.pin.lo : null,
    pin_hi: lv?.pin?.pinned ? lv.pin.hi : null,
    call_wall_strike: lv?.callWall?.strike ?? null,
    call_wall_kind: lv?.callWall?.kind ?? null,
    balance_state: lv?.balance?.state ?? null,
    rf_rate: num(rate),
    rf_status: rateStatus ?? (num(rate) != null ? 'live' : 'unavailable'),
  };
}

// Strikes the strike table may never drop: the support, both trapdoors, the pin box, and the
// flip-zone edges. The table is the evidence for the tiles and cannot be allowed to hide what the
// tiles are about.
export function mustShow(lv, { flipZoneLo = null, flipZoneHi = null } = {}) {
  const out = new Set();
  const add = (v) => { const x = num(v); if (x != null) out.add(x); };
  add(lv?.support?.strike); add(lv?.trapdoor?.near?.strike); add(lv?.trapdoor?.deep?.strike);
  for (const k of lv?.trapdoor?.near?.pair || []) add(k);
  add(lv?.callWall?.strike);
  if (lv?.pin?.pinned) for (const k of lv.pin.strikes || []) add(k);
  return { strikes: [...out], flipZone: (num(flipZoneLo) != null && num(flipZoneHi) != null) ? { lo: +flipZoneLo, hi: +flipZoneHi } : null };
}
