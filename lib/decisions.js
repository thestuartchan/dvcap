// lib/decisions.js — what was suggested, what was done, and the state of the book at that moment.
//
// WHY A LOG AND NOT A METRIC. Every other thing proposed for this console measures a POSITION —
// heat, ATR, correlation. The record says the money went somewhere else: into decisions. 27 trades
// that added to a losing position lost $18,377 while the other 79 made $1,977; size after a win
// runs 2.31× size after a loss, and performance after a win is worse. Neither pattern is visible in
// P&L until it is over, and neither is measurable from a position snapshot.
//
// ZERO TYPING. A required free-text reason would be friction at exactly the worst moment — the one
// where you are about to do the thing the record says costs you — so it gets skipped, or filled
// with "conviction", and the log ends up complete and worthless. Everything here is already on
// screen when the fill is recorded: the suggestion, the fill, the row, the regime. Free text is
// optional and captured when offered.
//
// THE FIELD THAT MATTERS MOST IS `stopSet`. The cross-tab driving all of this splits on whether a
// trade exited via a STOP order, which is knowable only at exit — the broker file carries no
// stop_price at all. Whether a stop EXISTED when the order was placed has never been recorded
// anywhere, and it is the one dimension that would turn that cross-tab from a description of how
// trades ended into a rule about how they were entered. It is a boolean the console already knows.
//
// `intent` is the other field nothing else can see. The edge is not demonstrated in either bucket
// — swing is n=16, +$77.03 a trip, t=0.85 — so intent DRIFT, entering as a swing and closing the
// same session, is the most likely mechanism by which a process becomes a different process. One
// click, recorded against the fill, comparable later against what actually happened.

export const DECISIONS_KEY = 'dvcap:decisions:v1';
// A single JSON value in Redis, so it cannot grow without bound. At a few hundred bytes an entry
// this is comfortably inside any value limit and holds well over a year of this account's activity.
export const MAX_DECISIONS = 1000;

// WHAT HAPPENED, not just what executed. A record containing only fills is biased toward action —
// it can measure how often a guard was ignored but never how often one worked, because the trade
// that was reconsidered leaves no trace anywhere else in this system. `declined` is that trace.
export const ACTIONS = Object.freeze(['opened', 'added', 'closed', 'trimmed', 'declined']);

import { openSideFor, sideOf } from './side.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const str = (v, n = 120) => v == null ? null : String(v).slice(0, n);

// Build one entry. Everything is derived from state the caller already has on screen; nothing here
// fetches, and nothing is inferred that could instead be left null.
export function decisionEntry({
  row, derived, pnl, fill, suggestion, regime = {}, intent = null,
  prevClosedWasWin = null, at = new Date().toISOString(), reason = null,
  guards = null, guardWorst = null, guardBreached = null, action = null,
} = {}) {
  const act = ACTIONS.includes(action) ? action : (fill?.side === 'sell' ? 'closed' : 'opened');
  const declined = act === 'declined';
  const q = num(fill?.qty);
  // A DECLINED TRADE IS NOT AN OVERRIDE OF ITS OWN SIZE. Recording the quantity you were about to
  // take as `takenQty` would put it straight into the override statistics as though it had been
  // executed, which would make the one action that PROVES a guard worked look identical to
  // ignoring one. It goes in its own field and leaves overrideRatio null.
  const taken = declined ? null : q;
  const rec = num(suggestion?.roomQty ?? suggestion?.fullQty);
  // Which fill OPENS this position — a buy on a long, a sell on a short. Every "is this an add"
  // question below is asked against that, not against the word "buy".
  const opensOn = openSideFor(derived?.side ?? row?.side);
  const buys = (derived?.fills || []).filter(f => f.side === opensOn).length;
  return {
    at,
    id: str(row?.id, 48),
    symbol: str(row?.symbol, 24),
    side: fill?.side === 'sell' ? 'sell' : 'buy',
    // The POSITION's direction, distinct from the fill's. Both matter to a replayed decision and
    // one cannot be recovered from the other: a sell is an open on a short and an exit on a long.
    positionSide: sideOf(derived?.side ?? row?.side) ?? 'long',
    // WHAT WAS SUGGESTED vs WHAT WAS DONE. `recommended` is the ROOM remaining, which is the number
    // the card actually puts in front of you, not the full-size figure it is derived from.
    takenQty: taken,
    consideredQty: declined ? q : null,
    recommendedQty: rec,
    // Null rather than a ratio when there is nothing to compare — a suggestion the model declined
    // to make is not an override of zero.
    overrideRatio: (taken != null && rec != null && rec > 0) ? +(taken / rec).toFixed(3) : null,
    sizeMode: str(suggestion?.mode, 16),
    effPct: num(suggestion?.effPct),
    riskAtSize: num(suggestion?.riskAtSize),
    multiplier: num(row?.multiplier) || 1,
    // The one that turns the cross-tab into a rule. Recorded, never assumed.
    stopSet: Array.isArray(row?.levels) && row.levels.some(l => l?.kind === 'stop' && num(l.at) != null),
    stopAt: num((row?.levels || []).find(l => l?.kind === 'stop')?.at),
    // Declared, not inferred — the console cannot know from a fill whether you meant to hold it.
    intent: (intent === 'intraday' || intent === 'swing') ? intent : null,
    // The pattern the interceptor fires on, recorded whether or not it fired.
    // Counted against the fill that OPENS this position's direction, not against the word "buy".
    addNumber: fill?.side === opensOn ? buys + 1 : null,
    fillPrice: num(fill?.price),
    priorBuys: buys,
    unrealisedPctBefore: num(pnl?.unrealizedPct),
    addToLoser: fill?.side === opensOn && (derived?.qty > 0) && num(pnl?.unrealizedPct) != null && pnl.unrealizedPct < 0,
    // Book state, so a decision can be read against the conditions it was made in.
    regimeId: str(regime?.regimeId, 16),
    regimeMult: num(suggestion?.mult),
    warnings: Array.isArray(suggestion?.warnings) ? suggestion.warnings.map(w => str(w, 160)).slice(0, 6) : [],
    // Sizing up after a win is the second documented pattern. The console knows how the last closed
    // trade went; it has never been recorded next to the next decision.
    prevClosedWasWin: typeof prevClosedWasWin === 'boolean' ? prevClosedWasWin : null,
    // ── P1's panel, as it stood when the button was pressed ──────────────────
    // STATES ONLY, not values. The values are re-derivable from the row and the fill, and a
    // thousand entries carrying eight objects each would be a different kind of store. What cannot
    // be reconstructed later is which guards were LIT, because the book has moved since.
    guards: guards && typeof guards === 'object' ? { ...guards } : null,
    guardWorst: str(guardWorst, 8),
    guardBreached: Array.isArray(guardBreached) ? guardBreached.map(x => str(x, 24)).slice(0, 8) : null,
    // What was actually done. A log of executions only is biased toward action: the trade you
    // talked yourself out of is evidence too, and it is the only evidence that a guard worked.
    action: act,
    reason: str(reason, 400),
  };
}

// Newest last, capped. Returns a NEW array — the caller decides whether to persist it.
export function appendDecision(log = [], entry, max = MAX_DECISIONS) {
  if (!entry || !entry.symbol) return Array.isArray(log) ? log : [];
  const next = [...(Array.isArray(log) ? log : []), entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

// Did the last closed trade make money? The second documented pattern — size runs 2.31x after a win
// — needs this recorded BESIDE the next decision, because by the time it is reviewed the sequence
// has been lost. Uses the most recent exit date, not array order.
export function lastClosedWasWin(rows = []) {
  const closed = rows
    .filter(r => r?.derived?.status === 'closed' && !r.derived.rolledInto && r.derived.lastDate)
    .sort((a, b) => String(a.derived.lastDate).localeCompare(String(b.derived.lastDate)));
  const last = closed[closed.length - 1];
  if (!last) return null;
  const v = num(last.derived.realized);
  return v == null || v === 0 ? null : v > 0;
}

// ── Reading it back ───────────────────────────────────────────────────────────
// The question the log exists to answer: does overriding cost money? It cannot be answered yet —
// an entry records a decision, and the outcome arrives later — so this reports what IS knowable
// now: how often the suggestion is exceeded, and under which conditions.
export function overrideStats(log = []) {
  const rows = (Array.isArray(log) ? log : [])
    // OPENING decisions only — sizing statistics are about how big you went, and an exit has no
    // suggested size to have overridden. Written as `side === 'buy'` that filter also silently
    // excluded every short, whose opening decision is a SELL: the discipline record would have
    // been kept for half the book while reporting itself as complete. Legacy entries carry no
    // positionSide and resolve to long, so the existing record is unchanged.
    .filter(d => d?.overrideRatio != null && d.side === openSideFor(d.positionSide) && d.action !== 'declined');
  if (!rows.length) return { n: 0 };
  const over = rows.filter(d => d.overrideRatio > 1.05);
  const under = rows.filter(d => d.overrideRatio < 0.95);
  const afterWin = rows.filter(d => d.prevClosedWasWin === true);
  const afterLoss = rows.filter(d => d.prevClosedWasWin === false);
  const mean = (xs) => xs.length ? +(xs.reduce((a, d) => a + d.overrideRatio, 0) / xs.length).toFixed(2) : null;
  return {
    n: rows.length,
    over: over.length, under: under.length,
    meanRatio: mean(rows),
    // The 2.31x-after-a-win pattern, measured prospectively instead of forensically.
    meanAfterWin: mean(afterWin), nAfterWin: afterWin.length,
    meanAfterLoss: mean(afterLoss), nAfterLoss: afterLoss.length,
    addsToLosers: rows.filter(d => d.addToLoser).length,
    withoutStop: rows.filter(d => d.stopSet === false).length,
    declaredSwing: rows.filter(d => d.intent === 'swing').length,
    declaredIntraday: rows.filter(d => d.intent === 'intraday').length,
  };
}

// ── Override frequency over time ─────────────────────────────────────────────
// One point per month: how many buys were logged, how many exceeded the suggestion, and the mean
// ratio. A single number over all history cannot show a habit changing, which is the only thing
// this log can eventually demonstrate about itself.
export function overrideTrend(log = [], { bucket = 'month' } = {}) {
  const rows = (Array.isArray(log) ? log : [])
    .filter(d => d?.overrideRatio != null && d.side === openSideFor(d.positionSide) && d.action !== 'declined' && d.at);
  const key = (at) => bucket === 'week'
    ? String(at).slice(0, 10)
    : String(at).slice(0, 7);
  const by = new Map();
  for (const d of rows) {
    const k = key(d.at);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(d);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([period, xs]) => ({
    period, n: xs.length,
    over: xs.filter(d => d.overrideRatio > 1.05).length,
    meanRatio: +(xs.reduce((a, d) => a + d.overrideRatio, 0) / xs.length).toFixed(2),
    overPct: Math.round((xs.filter(d => d.overrideRatio > 1.05).length / xs.length) * 100),
  }));
}

// ── Did the guards mean anything? ────────────────────────────────────────────
// Realised P&L grouped by whether each guard was green or red when the position was ENTERED.
//
// THE ATTRIBUTION PROBLEM, STATED. A row that was bought three times has three decision entries
// and one realised result. Crediting the whole result to each would triple-count it and make any
// guard look three times as consequential as it is. So a row's realised P&L is split across its
// own entry decisions PRO RATA by quantity: a decision that bought a fifth of the position carries
// a fifth of what the position made. That is an assumption, not a measurement — it treats every
// share as equally responsible — and it is the least-wrong one available without per-lot matching,
// which the average-cost book deliberately does not keep.
//
// `rows` are derived console rows; only CLOSED ones contribute, because an open position has no
// realised result to attribute.
export function guardOutcomes(log = [], rows = []) {
  const closed = new Map();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (r?.derived?.status === 'closed' && !r.derived.rolledInto) {
      closed.set(r.id, { realized: num(r.derived.realized), bought: num(r.derived.bought) });
    }
  }
  const entries = (Array.isArray(log) ? log : []).filter(
    d => d?.guards && d.action !== 'declined' && d.side === openSideFor(d.positionSide) && closed.has(d.id) && num(d.takenQty) != null);

  const acc = {};   // guardId -> state -> {n, pnl}
  let attributed = 0;
  for (const d of entries) {
    const c = closed.get(d.id);
    if (c.realized == null || !(c.bought > 0)) continue;
    const share = Math.min(1, num(d.takenQty) / c.bought);
    const pnl = +(c.realized * share).toFixed(2);
    attributed++;
    for (const [gid, state] of Object.entries(d.guards)) {
      acc[gid] ??= {};
      acc[gid][state] ??= { n: 0, pnl: 0 };
      acc[gid][state].n += 1;
      acc[gid][state].pnl = +(acc[gid][state].pnl + pnl).toFixed(2);
    }
  }

  const guards = Object.entries(acc).map(([id, states]) => {
    const out = { id };
    for (const [st, v] of Object.entries(states)) {
      out[st] = { n: v.n, pnl: v.pnl, avg: +(v.pnl / v.n).toFixed(2) };
    }
    // The comparison the whole log exists to make, and it is only worth printing when BOTH sides
    // have entries — a "red trades lost money" claim off zero green trades says nothing.
    const red = out.red, green = out.green;
    out.spread = (red && green) ? +(green.avg - red.avg).toFixed(2) : null;
    out.comparable = !!(red && green && red.n >= 3 && green.n >= 3);
    return out;
  }).sort((a, b) => a.id.localeCompare(b.id));

  return {
    guards,
    decisions: entries.length,
    attributed,
    // Said out loud, because a reader seeing per-guard P&L will otherwise assume these add up to
    // the account's realised total. They do not: one row's result appears under every guard.
    note: 'Each closed row\'s realised P&L is split across its entry decisions pro rata by quantity, then counted once under EVERY guard. Columns do not sum to account P&L.',
  };
}
