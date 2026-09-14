// quadrant.js — the measured regime: growth × inflation, from the two axes.
//
// The four regimes in lib/regimes.js are the classic growth-by-inflation quadrant. The consensus
// engine reaches one of them through a lookup on strategist recession odds; the axes reach one by
// measurement. This is where the two are put side by side — the watching period the plan calls
// for is a comparison of this quadrant against the consensus regime, day by day, in the regime
// log. Nothing here drives anything yet.
import { growthPulse, marketPulse, monthlyPulse, growthAxis } from './growth.js';
import { marketInflation, nowcastInflation, printedInflation, inflationAxis } from './inflationAxis.js';

// The sign of the sum of the present legs' leans, or null when none reads.
export function axisLean(pulses = []) {
  const leans = pulses.map(p => p?.lean).filter(l => l != null);
  if (!leans.length) return null;
  return Math.sign(leans.reduce((s, l) => s + l, 0));
}

export const QUADRANT = Object.freeze({
  'up|down': { id: 'ref',  label: 'Reflationary Growth',    read: 'growth firm, inflation cool' },
  'up|up':   { id: 'inf',  label: 'Inflationary Boom',      read: 'growth firm, inflation hot' },
  'down|up': { id: 'stag', label: 'Stagflation',            read: 'growth weakening, inflation hot' },
  'down|down': { id: 'def', label: 'Deflationary Recession', read: 'growth weakening, inflation cool' },
});
const side = l => l > 0 ? 'up' : l < 0 ? 'down' : 'flat';

export function measuredQuadrant({ growthLean = null, inflationLean = null } = {}) {
  if (growthLean == null || inflationLean == null) {
    return { id: null, label: null, read: `no quadrant — ${growthLean == null ? 'growth' : 'inflation'} axis has no read`, growthLean, inflationLean };
  }
  const q = QUADRANT[`${side(growthLean)}|${side(inflationLean)}`];
  if (!q) {
    const flat = growthLean === 0 ? 'growth' : 'inflation';
    return { id: null, label: null, read: `between quadrants — the ${flat} axis is flat`, growthLean, inflationLean };
  }
  return { ...q, growthLean, inflationLean };
}

// Everything the axes say, from an indicators payload and the ISM entry. Used by the cron for the
// daily row and by the dashboard for the strip, so the two cannot disagree.
export function measuredAxes(ind = {}, { ism = null, now = new Date() } = {}) {
  const g = {
    market: marketPulse(ind.growthMarket || {}, { now }),
    weekly: growthPulse(ind.growth || {}, { now }),
    monthly: monthlyPulse(ind.growthMonthly || {}, { now, ism }),
  };
  const ia = ind.inflationAxis || {};
  const i = {
    market: marketInflation(ia, { now }),
    nowcast: nowcastInflation(ia.cleveland || {}, { now }),
    printed: printedInflation({
      coreCpiYoY: ind.cpiCoreCurrent != null ? { value: ind.cpiCoreCurrent, date: ind.asOf?.cpiCoreCurrent ?? null } : null,
      corePceYoY: ind.pceCoreCurrent != null ? { value: ind.pceCoreCurrent, date: ind.asOf?.pceCoreCurrent ?? null } : null,
      coreCpiIdx: ia.coreCpiIdx || null,
    }, { now }),
  };
  const growth = growthAxis(g), inflation = inflationAxis(i);
  const growthLean = axisLean([g.market, g.weekly, g.monthly]);
  const inflationLean = inflation.lean ?? axisLean([i.market, i.nowcast, i.printed]);
  const quadrant = measuredQuadrant({ growthLean, inflationLean });
  return { growth: { ...growth, lean: growthLean, pulses: g }, inflation: { ...inflation, pulses: i }, quadrant };
}

// The compact form the regime log stores — verdicts and leans, never the legs.
export function axesLogRow(ax) {
  const v = p => p ? { verdict: p.verdict, lean: p.lean, usable: p.usable, of: p.of } : null;
  return {
    growth: { state: ax.growth.state, lean: ax.growth.lean, market: v(ax.growth.pulses.market), weekly: v(ax.growth.pulses.weekly), monthly: v(ax.growth.pulses.monthly) },
    inflation: { state: ax.inflation.state, lean: ax.inflation.lean, market: v(ax.inflation.pulses.market), nowcast: v(ax.inflation.pulses.nowcast), printed: v(ax.inflation.pulses.printed) },
    quadrant: ax.quadrant.id, quadrantRead: ax.quadrant.read,
  };
}
