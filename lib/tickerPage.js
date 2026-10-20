// lib/tickerPage.js — the ticker page's own reads (src/TickerPanel.jsx), from data the app already has.
//
// Pure: the page hands in what it loaded and gets back what to show. Nothing here fetches, and the
// one private input — the Console's rows — arrives from the logged-in browser and goes nowhere.
import { CARDS } from './ratios.js';
import { LADDER_ORDER } from './regimeState.js';
import { underlyingOf } from './instruments.js';
import EARNINGS_WATCH from '../data/earnings_watch.json' with { type: 'json' };
import { EARNINGS_NAMES } from './universeAdded.js';

export { TICKER_RE } from './goCommands.js';
export const cleanSymbol = (s) => String(s || '').trim().toUpperCase();

// "Your line": the Console's open and watched rows on this underlying, options and spreads
// included. Closed rows are history, not a line.
export function linesFor(rows = [], symbol) {
  const sym = cleanSymbol(symbol);
  if (!sym || !Array.isArray(rows)) return [];
  return rows.filter(r => r && (r.status === 'open' || r.status === 'watching') && underlyingOf(r) === sym)
    .map(r => ({ id: r.id ?? null, status: r.status, side: r.side || null, symbol: r.symbol || sym, legs: Array.isArray(r.legs) ? r.legs.length : 0, thesis: r.thesis || null }));
}

// Where the symbol already appears on the dashboard's market reads: the Ratios cards, the breadth
// ladder, and the SMH/SOXX concentration tell.
export function ratioContext(symbol) {
  const sym = cleanSymbol(symbol);
  const cards = CARDS.filter(c => [...c.num, ...c.den].includes(sym)).map(c => ({ id: c.id, n: c.n, title: c.title, formula: c.short || c.formula, side: c.num.includes(sym) ? 'numerator' : 'denominator' }));
  const ladder = LADDER_ORDER.includes(sym) ? { rung: LADDER_ORDER.indexOf(sym) + 1, of: LADDER_ORDER.length, order: LADDER_ORDER } : null;
  const concentration = sym === 'SMH' || sym === 'SOXX';
  return { cards, ladder, concentration };
}

// The next earnings date for the symbol among the calendar rows the app already loads (hand-kept
// and automatic). A row is the company's if it names the symbol, or its name, in an earnings title.
const shortName = (name) => {
  const w = String(name || '').replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
  const first = w[0] && !/^(the|a)$/i.test(w[0]) ? w[0] : w[1];
  return first && first.length >= 3 ? first : null;
};
// The names the earnings watch knows a symbol by ("TSMC" for TSM, "Samsung" for 005930.KS), so a
// row matches even when SEC hasn't given the page a name to look for.
export function watchAliases(symbol) {
  const sym = cleanSymbol(symbol);
  const w = EARNINGS_NAMES.find(n => n.sym === sym);
  const k = (EARNINGS_WATCH.dart || []).find(n => `${n.code}.KS` === sym || n.code === sym);
  return [...new Set([...(w ? [w.name, ...(w.aliases || [])] : []), ...(k ? [k.name, ...(k.aliases || [])] : [])])];
}
export function nextEarnings(events = [], symbol, { name = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const sym = cleanSymbol(symbol);
  const nm = shortName(name);
  const aliases = watchAliases(sym);
  const word = (s) => new RegExp(`(^|[^A-Za-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i');
  const mine = (e) => {
    if (!e?.date || e.date < today) return false;
    if (cleanSymbol(e.symbol) === sym || cleanSymbol(e.ticker) === sym) return true;
    // Automatic rows carry the company in `kind`: earn:AAPL (Nasdaq), earn:005930 (DART, a KRX code).
    const k = /^earn(?:prelim)?:(.+)$/.exec(String(e.kind || ''))?.[1];
    if (k && (k === sym || `${k}.KS` === sym)) return true;
    const t = String(e.title || '');
    if (!/earnings|results/i.test(t)) return false;
    return word(sym).test(t) || (nm ? word(nm).test(t) : false) || aliases.some(a => word(a).test(t));
  };
  const hit = [...events].filter(mine).sort((a, b) => a.date.localeCompare(b.date))[0];
  return hit ? { date: hit.date, time: hit.time || null, tz: hit.tz || null, title: hit.title, estimated: !!(hit.estimated || hit.est), source: hit.source || (hit.auto ? 'automatic' : 'hand-kept') } : null;
}

// [date, close] pairs → the chart's points in a w×h box, and the figures printed beside it.
export function chartOf(closes = [], { w = 320, h = 120, pad = 4 } = {}) {
  const pts = (closes || []).filter(p => Array.isArray(p) && Number.isFinite(+p[1]));
  if (pts.length < 2) return null;
  const vals = pts.map(p => +p[1]);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const x = (i) => pad + (i * (w - 2 * pad)) / (pts.length - 1);
  const y = (v) => pad + (h - 2 * pad) * (1 - (v - lo) / span);
  const last = vals.at(-1), first = vals[0];
  const back = (n) => (vals.length > n ? vals.at(-1 - n) : null);
  const pct = (a, b) => (a == null || b == null || b === 0 ? null : +(((a - b) / b) * 100).toFixed(2));
  return {
    d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(+p[1]).toFixed(1)}`).join(' '),
    w, h, lo, hi, last, lastDate: pts.at(-1)[0], firstDate: pts[0][0],
    ch1d: pct(last, back(1)), ch1m: pct(last, back(21)), ch1y: pct(last, first),
    hiDate: pts[vals.indexOf(hi)][0], loDate: pts[vals.indexOf(lo)][0],
  };
}

// A big number the way the page prints it: $82.9B, $412.0M, 4.27.
export function money(v, { perShare = false } = {}) {
  if (v == null || !Number.isFinite(+v)) return '—';
  const n = +v;
  if (perShare) return n.toFixed(2);
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  if (a >= 1e12) return `${s}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  return `${s}$${a.toLocaleString('en-US')}`;
}
