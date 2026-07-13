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

// Roll everything into one regime object the generator consumes.
export function computeRegime({ quotes, names, macro }) {
  return {
    split:  memoryVsFoundry(quotes, names),
    credit: creditState(macro?.oas?.value),
    oil:    oilRead(macro?.wti),
    us2y:   macro?.us2y?.value ?? null,
  };
}
