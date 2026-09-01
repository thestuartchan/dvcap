// lib/exposure.js — three numbers about the book, in the same units, never summed.
//
// WHY NOT A SINGLE HEAT FIGURE. A portfolio-heat number sums risk-to-stop across the book and
// reports one percentage. On this account that number would be small and it would be a lie by
// omission: two of nine non-cash rows carry a stop, so it describes a fifth of the exposure and
// names itself after all of it. The three figures here are deliberately kept apart because they
// answer different questions and adding them would answer none:
//
//   DEFINED RISK        what you lose if every stop you have set is hit. Real, and small.
//   UNDEFINED EXPOSURE  what is riding with no stop at all. This is the number the heat figure hid.
//   GROSS NOTIONAL      everything at full contract value, futures included. Leverage, not capital.
//
// Gross notional is the only one that counts futures at face. Everywhere else in this console a
// margined row is excluded from weights, cash and the donut on purpose — the notional is not
// capital you have committed. That exclusion is right for "how is the book allocated" and exactly
// wrong for "how much is this trade controlling", which is what a pre-trade panel is asking.

import { convert } from './fxrates.js';
import { riskAtStop } from './sizing.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// The stop level on a row, if it has one. A stop with no price is not a stop.
export function stopOf(row) {
  const lv = (row?.levels || []).find(l => l?.kind === 'stop' && num(l?.at) != null);
  return lv ? num(lv.at) : null;
}

// What one row controls, at full contract value, in the base currency. `qty` and `price` may be
// overridden to ask the question about a fill that has not happened yet.
export function rowExposure(row, { rates = {}, base = 'USD', qty = null, price = null } = {}) {
  const m = num(row?.multiplier) || 1;
  const q = num(qty) ?? num(row?.derived?.qty) ?? 0;
  const p = num(price) ?? num(row?.livePrice) ?? num(row?.derived?.avgCost);
  const ccy = row?.currency || 'USD';
  const notional = (p == null || !(q > 0)) ? null : +(q * p * m).toFixed(2);
  // A row can PIN its rate so a finished trade stops drifting with spot; honour it here too.
  const pinned = num(row?.fxRate);
  const toBase = (v) => {
    if (v == null) return null;
    if (ccy === base) return v;
    if (pinned != null && pinned > 0) return +(v / pinned).toFixed(2);
    const c = convert(v, ccy, base, rates);
    return c == null ? null : +c.toFixed(2);
  };
  const stopAt = stopOf(row);
  const risk = riskAtStop({ qty: q, price: p, stop: stopAt, multiplier: m });
  return {
    symbol: row?.symbol ?? null,
    qty: q, price: p, multiplier: m, currency: ccy,
    margined: !!row?.margined,
    hasStop: stopAt != null,
    stopAt,
    notional, notionalBase: toBase(notional),
    riskBase: toBase(risk),
  };
}

// The header. Every figure is in the base currency, and each carries its own row count so a
// small number and a small SAMPLE are never confused.
export function riskCoverage(rows = [], { equityBase = null, rates = {}, base = 'USD' } = {}) {
  const open = (Array.isArray(rows) ? rows : []).filter(r => num(r?.derived?.qty) > 0);
  const ex = open.map(r => rowExposure(r, { rates, base }));
  const eq = num(equityBase);
  const pct = (v) => (v == null || eq == null || eq <= 0) ? null : +((v / eq) * 100).toFixed(1);
  const sum = (xs, k) => {
    const vals = xs.map(x => x[k]).filter(v => v != null);
    return vals.length ? +vals.reduce((a, b) => a + b, 0).toFixed(2) : (xs.length ? null : 0);
  };

  const stopped = ex.filter(x => x.hasStop);
  const unstopped = ex.filter(x => !x.hasStop);
  const futures = ex.filter(x => x.margined);

  const definedAmt = sum(stopped, 'riskBase');
  const undefinedAmt = sum(unstopped, 'notionalBase');
  const grossAmt = sum(ex, 'notionalBase');
  const futAmt = sum(futures, 'notionalBase');

  // Rows the feed could not price drop out of the sums, so they are counted separately rather
  // than silently understating every figure above.
  const unpriced = ex.filter(x => x.notionalBase == null).length;

  return {
    defined:   { amount: definedAmt,   rows: stopped.length,   pctOfEquity: pct(definedAmt) },
    undefined: { amount: undefinedAmt, rows: unstopped.length, pctOfEquity: pct(undefinedAmt) },
    gross:     { amount: grossAmt,     rows: ex.length,        pctOfEquity: pct(grossAmt) },
    futures:   { amount: futAmt,       rows: futures.length,   pctOfEquity: pct(futAmt) },
    unpriced,
    equityBase: eq,
    // Stated so a reader is never left to infer it from three numbers that do not add up.
    note: 'Three separate measures, deliberately not summed: what a stop-out costs, what is riding without one, and what the book controls at contract value.',
  };
}
