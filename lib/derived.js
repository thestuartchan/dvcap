// lib/derived.js — a value computed from more than one observation is only as good as the WORST
// alignment among its inputs.
//
// The board carries several: 2s10s from DGS10 and DGS2, 5s30s from DGS30 and DGS5, Brent−WTI from
// two quotes, and the Fisher identity across a nominal, a real yield and a breakeven. Every one of
// them subtracted first and asked questions never, and every one of them displayed a single date
// borrowed from whichever input the author happened to reach for. That is fine right up until the
// legs stop printing on the same day — which they do: on 2026-08-27 the DGS series carried the
// 26th while T10YIE and T5YIFR carried the 27th.
//
// The failure is silent by construction. A spread built from a stale leg and a live one is a real
// number of the right magnitude with a plausible date attached; nothing about it looks wrong. So
// the rule is not "check the important ones" — it is that a derived value CANNOT be produced
// without its inputs agreeing, and the only way to enforce that is to make the aligned path the
// only path.
//
// A MISALIGNMENT IS REPORTED, NEVER SWALLOWED. Returning null on a date mismatch would replace a
// wrong number with an invisible absence, and a card that quietly stops computing is worse than one
// that never computed at all: you stop looking at it while believing something is still checking.
// So every result carries `checked` and, when false, the reason and the dates that disagreed — for
// the caller to render, not to discard.

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// inputs: [{ name, value, date }] — `compute` receives the values in the same order.
export function aligned(inputs = [], compute) {
  const rows = (Array.isArray(inputs) ? inputs : []).map(i => ({
    name: String(i?.name || '?'), value: num(i?.value), date: i?.date || null,
  }));
  const dates = Object.fromEntries(rows.map(r => [r.name, r.date]));
  const fail = (reason) => ({ ok: false, checked: false, value: null, date: null, reason, dates });

  if (!rows.length) return fail('nothing to derive from');
  const missing = rows.filter(r => r.value == null).map(r => r.name);
  if (missing.length) return fail(`no print for ${missing.join(', ')}`);
  const undated = rows.filter(r => !r.date).map(r => r.name);
  if (undated.length) return fail(`no observation date for ${undated.join(', ')}`);

  const distinct = [...new Set(rows.map(r => r.date))];
  if (distinct.length > 1) {
    // Named individually, because "dates disagree" tells you nothing about which leg to distrust.
    return fail(`observation dates disagree — ${rows.map(r => `${r.name} ${r.date}`).join(', ')}`);
  }
  return { ok: true, checked: true, value: compute(...rows.map(r => r.value)), date: distinct[0], reason: null, dates };
}

// The same rule for intraday quotes, whose stamp is an epoch second rather than a dated print. Two
// live ticks are comparable; a live one against a stale one is not, and the UTC day is the coarsest
// honest test available without inventing a staleness policy here.
// `+null` is 0 and 0 is finite, so a null stamp read as the epoch and came back 1970-01-01 — a
// date-shaped answer to "when did this print", which would then align against nothing and look
// like a legitimate mismatch rather than a missing value.
export const dayOf = (ts) => (ts == null || ts === '' || !Number.isFinite(+ts)) ? null
  : new Date(+ts * 1000).toISOString().slice(0, 10);

// Convenience for the commonest shape: a spread in basis points between two rate series.
export const spreadBps = (a, b) => aligned([a, b], (x, y) => Math.round((x - y) * 100));
