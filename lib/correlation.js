// lib/correlation.js — correlation collapse (D4). The book is three positions deep in Layer 3 —
// SMIC (0981.HK), SK Hynix (000660.KS), Samsung (005930.KS) — which LOOKS diversified and is not
// when they move together. High pairwise correlation means the user is running one position at
// ~50% of the book, not three at ~15%. This computes the rolling pairwise correlation of daily
// returns and flags when the three have collapsed into one.
//
// Different exchanges (SEHK vs KRX) keep different calendars, so each PAIR is aligned on its own
// common trading dates before returns are correlated — never by array index.

export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const x = xs[i], y = ys[i]; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
  const cov = sxy - (sx * sy) / n, vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n;
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
}

// Daily returns on the sorted common dates of two {date:close} maps, last `window` used.
function pairCorr(mapA, mapB, window) {
  const common = Object.keys(mapA).filter(d => mapB[d] != null).sort();
  if (common.length < 4) return null;
  const retA = [], retB = [];
  for (let i = 1; i < common.length; i++) {
    const d = common[i], p = common[i - 1];
    retA.push((mapA[d] - mapA[p]) / mapA[p]);
    retB.push((mapB[d] - mapB[p]) / mapB[p]);
  }
  const a = retA.slice(-window), b = retB.slice(-window);
  return { corr: pearson(a, b), n: a.length };
}

export const CORR_CFG = Object.freeze({ window: 20, collapsed: 0.7, elevated: 0.4, hotPair: 0.85 });

// names: [{ name, sym, map:{date:close} }]  (2–3 entries). Returns avg pairwise correlation +
// each pair, with a reading.
export function correlationCollapse(names = [], cfg = CORR_CFG) {
  const have = names.filter(n => n && n.map && Object.keys(n.map).length > 4);
  if (have.length < 2) return { available: false, note: 'Need at least two priced legs for a correlation.' };

  const pairs = [];
  for (let i = 0; i < have.length; i++) for (let j = i + 1; j < have.length; j++) {
    const pc = pairCorr(have[i].map, have[j].map, cfg.window);
    if (pc && pc.corr != null) pairs.push({ a: have[i].name, b: have[j].name, corr: +pc.corr.toFixed(2), n: pc.n });
  }
  if (!pairs.length) return { available: false, note: 'No overlapping trading dates to correlate.' };

  const avg = +(pairs.reduce((s, p) => s + p.corr, 0) / pairs.length).toFixed(2);

  // P2.1 — EFFECTIVE positions. The aggregate ρ understates concentration: a 0.96 pair buried in
  // an average with two ~0.3 pairs still reads "elevated 0.55" while two of the names ARE one
  // position. Merge any pair over `hotPair` into a single block (union-find over the legs) and
  // count the resulting blocks — that is how many independent bets the sleeve actually holds.
  const names2 = have.map(h => h.name);
  const parent = Object.fromEntries(names2.map(n => [n, n]));
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const hotPairs = pairs.filter(p => p.corr >= cfg.hotPair);
  for (const p of hotPairs) parent[find(p.a)] = find(p.b);
  const blocks = {};
  for (const n of names2) (blocks[find(n)] ||= []).push(n);
  const blockList = Object.values(blocks).sort((a, b) => b.length - a.length);
  const effectivePositions = blockList.length;

  let reading, tone;
  if (avg >= cfg.collapsed)      { reading = `collapsed into ONE position — the ${have.length} names are behaving as a single bet, not ${have.length} independent ones`; tone = 'red'; }
  else if (hotPairs.length)      { reading = `a ${hotPairs[0].corr} pair is one position — the aggregate ρ ${avg} understates it`; tone = 'red'; }
  else if (avg >= cfg.elevated)  { reading = 'elevated co-movement — diversification is thinning'; tone = 'amber'; }
  else                           { reading = 'moving independently — genuine diversification'; tone = 'green'; }
  return {
    available: true, avg, pairs, window: cfg.window, tone, reading, legs: names2,
    hotPairs, effectivePositions,
    blocks: blockList.map(b => b.join(' + ')),   // e.g. ["SK Hynix + Samsung", "SMIC"]
  };
}
