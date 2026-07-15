// regime.js — deterministic regime tagging. NO model here. Pure arithmetic on the spine's output.
// The model only writes prose later, and only from THIS output.

const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// structure tag vs MAs
export function structure(q) {
  if (q.price == null || q.ma50 == null || q.ma200 == null) return null;
  if (q.price > q.ma50 && q.price > q.ma200) return 'above both';
  if (q.price < q.ma50 && q.price < q.ma200) return 'below both';
  if (q.price < q.ma200) return 'below 200d';
  if (q.price < q.ma50)  return 'below 50d';
  return 'mixed';
}

// Memory vs Foundry split — the live axis. Returns a labeled read + the spread.
export function memoryVsFoundry(quotes, names) {
  const byRole = role => quotes
    .map((q, i) => ({ q, meta: names[i] }))
    .filter(x => x.meta?.role === role && x.q.changePct != null)
    .map(x => x.q.changePct);

  const mem = avg(byRole('memory'));
  const fnd = avg(byRole('foundry'));
  if (mem == null || fnd == null) return { label: 'n/a', mem, fnd, spread: null };

  const spread = fnd - mem;               // + = foundry outperforming
  let label;
  if (Math.abs(spread) < 1.5)      label = 'moving together';
  else if (spread > 0)             label = 'memory-specific weakness (foundry holding)';
  else                             label = 'foundry-specific weakness (memory holding)';
  return { label, mem: +mem.toFixed(2), fnd: +fnd.toFixed(2), spread: +spread.toFixed(2) };
}

// Credit anchor state from OAS level.
export function creditState(oasValue) {
  if (oasValue == null) return { state: 'unknown', note: 'no OAS print' };
  if (oasValue < 2.8)  return { state: 'calm',      note: 'correction regime, not a break' };
  if (oasValue < 3.0)  return { state: 'watch',     note: 'approaching stress line' };
  if (oasValue < 3.5)  return { state: 'defending', note: 'start defending the book' };
  return { state: 'stress', note: 'Path-2 territory' };
}

// Oil vs pivot + the inflation-transmission flag.
export function oilRead(wti, pivot = 73.08) {
  if (wti?.price == null) return { label: 'no print', above: null };
  const above = wti.price > pivot;
  return {
    price: wti.price,
    above,
    label: above ? 'holding above pivot — inflation impulse building'
                 : "won't hold the pivot — no inflation breakout yet",
  };
}

// Direction arrow helper for formatting.
export const arrow = pct => pct == null ? '·' : pct > 0.15 ? '▲' : pct < -0.15 ? '▼' : '·';

// ── Korea-local stress gate ──────────────────────────────────────────────────
// A SEPARATE regime input from the global OAS gate. OAS answers "is this a world
// credit event?"; the Korea cluster answers "is the leveraged-memory forced-
// deleveraging spiral exhausting?" Never fold these into each other.

// USD/KRW — the won. RISING USDKRW = won weakening = foreign outflows (bad).
// FALLING/flat = outflows easing (stabilization). Day-over-day is the fast tell.
export function usdkrwRead(q) {
  if (!q || q.changePct == null) return { level: q?.price ?? null, dir: 'n/a', flag: 'no print' };
  const d = q.changePct;
  const dir = d > 0.15 ? 'rising' : d < -0.15 ? 'falling' : 'flat';
  const flag = dir === 'rising' ? 'outflows accelerating'
             : dir === 'falling' ? 'stabilizing'
             : 'holding';
  return {
    level: q.price,
    changePct: +d.toFixed(2),
    dir,
    flag,
    weakeningWon: dir === 'rising',
    vs50d: (q.price != null && q.ma50 != null) ? (q.price > q.ma50 ? 'above 50d' : 'below 50d') : null,
  };
}

// VKOSPI — KOSPI-200 implied vol, read off the tradeable FUTURES (VKI1!). Bands: calm
// ~15-20, elevated 30-40, panic 80+ (futures run a touch below spot in backwardation,
// so it tops out lower). A PEAK-AND-ROLL from extreme highs (elevated AND now falling)
// = fear exhausting. yrHigh is absent from the futures feed → nearYrHigh just stays false.
export function vkospiRead(v) {
  if (!v || v.last == null) return { level: null, band: 'n/a', rolling: null, flag: 'no print' };
  const x = v.last;
  const band = x < 20 ? 'calm'
             : x < 30 ? 'normal'
             : x < 45 ? 'elevated'
             : x < 60 ? 'high'
             : x < 80 ? 'severe'
             : 'panic';
  const elevated = x >= 45;
  const rollingOver = v.changePct != null && v.changePct < 0;
  const rolling = elevated && rollingOver;
  const nearYrHigh = v.yrHigh != null && x >= v.yrHigh * 0.9;
  let flag;
  if (rolling)                             flag = 'peaking & rolling — fear exhausting';
  else if (elevated && v.changePct > 0)    flag = nearYrHigh ? 'panic building (near 1y high)' : 'fear building';
  else if (x < 20)                         flag = 'calm';
  else                                     flag = 'stable';
  return {
    level: +x.toFixed(2),
    band,
    changePct: v.changePct != null ? +v.changePct.toFixed(2) : null,
    rolling, nearYrHigh, flag,
  };
}

// CSOP 7709 units outstanding — the deleveraging tell. series: [{date, units}] chrono.
// KEY metric is day-over-day change in UNITS (not price/AUM, which conflate "Hynix
// fell" with "money left"). Shrinking = redemptions/forced unwind; flattening after
// a flush = redemptions exhausting (leads price). Needs ≥2 maintained data points.
export function etfUnitsRead(series) {
  const pts = (series || [])
    .filter(p => p && typeof p.units === 'number' && p.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (pts.length < 2) {
    return { available: false, points: pts.length, flag: 'no units data — manual input pending' };
  }
  const latest = pts[pts.length - 1];
  const prev   = pts[pts.length - 2];
  const delta  = latest.units - prev.units;
  const pct    = prev.units ? (delta / prev.units) * 100 : null;

  // Look back over recent sessions to tell "flattening after a flush" from "steady".
  const recent = pts.slice(-6);
  const deltas = recent.slice(1).map((p, i) => p.units - recent[i].units);
  const wasShrinking = deltas.slice(0, -1).some(d => d < 0);

  const shrinking  = pct != null && pct < -0.5;
  const flattening = pct != null && Math.abs(pct) <= 0.5 && wasShrinking;

  let flag;
  if (shrinking)                        flag = 'flush active — forced deleveraging';
  else if (flattening)                  flag = 'redemptions flattening — stabilizing (leads price)';
  else if (pct != null && pct > 0.5)    flag = 'units growing — inflows';
  else                                  flag = 'units steady';

  return {
    available: true,
    units: latest.units,
    asOf: latest.date,
    deltaUnits: delta,
    deltaPct: pct != null ? +pct.toFixed(2) : null,
    shrinking, flattening, flag,
    series: pts.slice(-20).map(p => ({ date: p.date, units: p.units })),
  };
}

// The Korea washout-exhausting cluster: won stops weakening AND VKOSPI peaks & rolls
// AND 7709 units flatten. Distinct from creditState — this is the Korea-LOCAL gate.
export function koreaStress(korea) {
  const won = usdkrwRead(korea?.usdkrw);
  const vol = vkospiRead(korea?.vkospi);
  const etf = etfUnitsRead(korea?.etf?.units);

  const legs = {
    wonStabilizing:  won.dir === 'falling' || won.dir === 'flat',
    vkospiRolling:   vol.rolling === true,
    unitsFlattening: etf.flattening === true,
  };

  // Is any leg still actively stressed?
  const stillStressed = won.weakeningWon
    || vol.band === 'panic' || vol.band === 'severe'
    || etf.shrinking === true;

  let cluster, note;
  if (legs.wonStabilizing && legs.vkospiRolling && legs.unitsFlattening) {
    cluster = 'exhausting';
    note = 'Korea washout exhausting — won stabilizing, VKOSPI rolling, redemptions flattening';
  } else if (stillStressed) {
    cluster = 'active';
    note = 'Korea forced-deleveraging still active';
  } else {
    cluster = 'mixed';
    note = 'Korea stress mixed — no clean exhaustion cluster yet';
  }

  return { gate: 'korea-local', cluster, note, legs, won, vol, etf };
}

// Roll everything into one regime object the generator consumes. `korea` is the
// Asia-only local gate; null for EU/US. It sits ALONGSIDE credit (the global OAS
// gate), never merged into it.
export function computeRegime({ quotes, names, macro, korea }) {
  return {
    split:  memoryVsFoundry(quotes, names),
    credit: creditState(macro?.oas?.value),   // GLOBAL gate — world credit event?
    oil:    oilRead(macro?.wti),
    us2y:   macro?.us2y?.value ?? null,
    korea:  korea ? koreaStress(korea) : null, // KOREA-LOCAL gate — deleveraging exhausting?
  };
}
