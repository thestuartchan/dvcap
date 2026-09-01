// lib/guards.js — the pre-trade panel, as data.
//
// WHY NOTIONAL AND BEHAVIOUR, NOT RISK-TO-STOP. Risk-to-stop is not the binding constraint on this
// account. Two of nine non-cash rows carry a stop at all, so a number summed across "rows with a
// stop" describes a fifth of the book and calls it the risk. What the record actually indicts is
// size and sequence: 27 same-session trades that added to a losing position lost $18,377 while the
// other 79 made $1,977, and size after a win runs 2.31x size after a loss. Those are notional and
// behavioural facts, and none of them appear in a risk-to-stop figure.
//
// ADVISORY, ALWAYS. Nothing here blocks, and there is no confirm-twice. A guard that stops you is
// a guard you learn to click through without reading; a guard that is merely PRESENT at the moment
// of the decision, and recorded afterwards whether you heeded it or not, is the one that can be
// measured later. Every evaluation is written to the decision log with the action taken beside it,
// which is what eventually answers whether any of these are worth anything.
//
// UNIFORM SHAPE. Every guard is {id, label, state, value, note}. state is one of
// green | amber | red | unknown, and UNKNOWN IS NEVER GREEN — a guard that could not be computed
// says so, because the failure mode being designed against is a panel that looks clear when it is
// merely blind.

export const GUARD_STATES = Object.freeze(['green', 'amber', 'red', 'unknown']);

// Thresholds are defaults, meant to be argued with. They are stated here rather than buried in
// branches so they can be tuned against the log once it has entries to tune against.
export const GUARD_CFG = Object.freeze({
  // Taking more than the suggestion is the override the log measures. 1.25x is a decision;
  // 1.5x is a different trade from the one that was sized.
  sizeAmber: 1.25, sizeRed: 1.5,
  // One instrument's notional as a share of equity. Default allocation is 5%, so 10% is already
  // a double-weight position and 15% is a concentration.
  posAmber: 10, posRed: 15,
  // Gross notional of the whole book, futures at full contract value. Above 100% the account is
  // levered whatever the cash line says.
  bookAmber: 100, bookRed: 150,
  // Futures alone. Margined notional is the part that is invisible in every other view, because
  // it is deliberately excluded from weights, cash and the donut.
  futAmber: 50, futRed: 100,
  // Below one ATR the stop is inside the instrument's ordinary daily range — not an invalidation
  // level, a coin flip. 1.5 is the shade where it is worth a second look.
  atrRed: 1.0, atrAmber: 1.5,
  // Re-entering something closed in the same session is the shape of a revenge trade.
  reentryHours: 24,
});

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const pctOf = (part, whole) => {
  const a = num(part), b = num(whole);
  return (a == null || b == null || b <= 0) ? null : +((a / b) * 100).toFixed(1);
};
const g = (id, label, state, value, note) => ({ id, label, state, value, note });

// ── the seven ────────────────────────────────────────────────────────────────

// 1. What was suggested against what is being taken.
export function sizeGuard({ takenQty, suggestedQty } = {}, cfg = GUARD_CFG) {
  const t = num(takenQty), s = num(suggestedQty);
  if (t == null || s == null || s <= 0) {
    return g('size', 'Size vs suggested', 'unknown', null,
      s == null || s <= 0 ? 'no suggestion to compare against' : 'no quantity entered yet');
  }
  const ratio = +(t / s).toFixed(3);
  const delta = +(((t - s) / s) * 100).toFixed(1);
  const state = ratio >= cfg.sizeRed ? 'red' : ratio >= cfg.sizeAmber ? 'amber' : 'green';
  return g('size', 'Size vs suggested', state, { takenQty: t, suggestedQty: s, ratio, deltaPct: delta },
    `${t} against a suggested ${s} — ${delta >= 0 ? '+' : ''}${delta}%`);
}

// 2. This instrument's notional as a share of equity. Notional, not capital: the multiplier is
//    already in it, so an options or futures row reads at what it actually controls.
export function positionNotionalGuard({ notionalBase, equityBase } = {}, cfg = GUARD_CFG) {
  const pct = pctOf(notionalBase, equityBase);
  if (pct == null) return g('notional', 'Position notional', 'unknown', null, 'no equity or no price');
  const state = pct >= cfg.posRed ? 'red' : pct >= cfg.posAmber ? 'amber' : 'green';
  return g('notional', 'Position notional', state, { pct, notionalBase: num(notionalBase) },
    `${pct}% of equity after this fill`);
}

// 3. The whole book, gross, futures at full contract value.
export function bookNotionalGuard({ bookNotionalBase, equityBase } = {}, cfg = GUARD_CFG) {
  const pct = pctOf(bookNotionalBase, equityBase);
  if (pct == null) return g('bookNotional', 'Book gross notional', 'unknown', null, 'no equity or no prices');
  const state = pct >= cfg.bookRed ? 'red' : pct >= cfg.bookAmber ? 'amber' : 'green';
  return g('bookNotional', 'Book gross notional', state, { pct, notionalBase: num(bookNotionalBase) },
    `${pct}% of equity across every row, futures at contract value`);
}

// 4. Futures alone — the exposure every other view in this console deliberately hides.
export function futuresNotionalGuard({ futuresNotionalBase, equityBase, rows = 0 } = {}, cfg = GUARD_CFG) {
  const pct = pctOf(futuresNotionalBase, equityBase);
  if (pct == null) return g('futuresNotional', 'Futures notional', 'unknown', null, 'no equity or no prices');
  const state = pct >= cfg.futRed ? 'red' : pct >= cfg.futAmber ? 'amber' : 'green';
  return g('futuresNotional', 'Futures notional', state, { pct, notionalBase: num(futuresNotionalBase), rows },
    rows ? `${pct}% of equity across ${rows} margined row${rows === 1 ? '' : 's'}` : 'no margined rows');
}

// 5. Stop distance in ATR. `width` is a lib/atr.js stopWidth() result.
export function stopAtrGuard({ width } = {}, cfg = GUARD_CFG) {
  if (!width || !width.known) {
    return g('stopAtr', 'Stop distance', 'unknown', null, width?.note || 'no stop or no ATR');
  }
  const a = width.atrs;
  const state = a < cfg.atrRed ? 'red' : a < cfg.atrAmber ? 'amber' : 'green';
  return g('stopAtr', 'Stop distance', state, { atrs: a, tight: a < cfg.atrRed }, width.note);
}

// 6. Was this instrument closed in the last day, and at what. Re-entering something just exited is
//    the shape of a revenge trade, and it is invisible once the row has moved to the archive.
export function reentryGuard({ lastClose, now = new Date() } = {}, cfg = GUARD_CFG) {
  const at = lastClose?.at ? Date.parse(lastClose.at) : null;
  if (!Number.isFinite(at)) return g('reentry', 'Recently closed', 'green', null, 'not closed recently');
  const hours = +((Date.parse(now instanceof Date ? now.toISOString() : now) - at) / 3600000).toFixed(1);
  if (!(hours >= 0) || hours > cfg.reentryHours) {
    return g('reentry', 'Recently closed', 'green', { hours }, 'not closed in the last day');
  }
  const px = num(lastClose.price);
  return g('reentry', 'Recently closed', 'red',
    { hours, price: px, realized: num(lastClose.realized) },
    `closed ${hours}h ago${px == null ? '' : ` at ${px}`}${lastClose.realized == null ? '' : ` for ${lastClose.realized > 0 ? '+' : ''}${lastClose.realized}`}`);
}

// 7a. Was the last closed trade a win, and how big was it. Size after a win runs 2.31x size after
//     a loss, and performance after a win is worse — so the win itself is the flag.
export function afterWinGuard({ prevClosed } = {}) {
  if (!prevClosed || prevClosed.win == null) {
    return g('afterWin', 'Previous closed trade', 'unknown', null, 'no closed trade on record');
  }
  const size = num(prevClosed.size);
  const rl = num(prevClosed.realized);
  return g('afterWin', 'Previous closed trade', prevClosed.win ? 'amber' : 'green',
    { win: !!prevClosed.win, size, realized: rl, symbol: prevClosed.symbol ?? null },
    `${prevClosed.symbol ? prevClosed.symbol + ' ' : ''}${prevClosed.win ? 'won' : 'lost'}`
      + `${rl == null ? '' : ` ${rl > 0 ? '+' : ''}${rl}`}${size == null ? '' : ` on ${size} units`}`
      + `${prevClosed.win ? ' — size after a win runs 2.31x size after a loss' : ''}`);
}

// 7b. The cohort that actually lost the money.
export function addToLoserGuard({ add } = {}) {
  if (!add) return g('addToLoser', 'Add to a loser', 'green', null, 'not adding to a losing position');
  return g('addToLoser', 'Add to a loser', 'red',
    { addNumber: add.addNumber, priorBuys: add.priorBuys, drawdownPct: add.drawdownPct,
      belowAverage: add.belowAverage ?? null },
    `add #${add.addNumber} to a position ${Math.abs(add.drawdownPct)}% underwater`
      + ` — ${add.evidence?.line || ''}`.trimEnd());
}

// ── the panel ────────────────────────────────────────────────────────────────
// One call, everything the form renders and everything the log records. Nothing here fetches and
// nothing blocks; a field that cannot be computed is `unknown` and the trade proceeds regardless.
export function preTradeGuards(input = {}, cfg = GUARD_CFG) {
  const guards = [
    sizeGuard(input, cfg),
    positionNotionalGuard(input, cfg),
    bookNotionalGuard(input, cfg),
    futuresNotionalGuard(input, cfg),
    stopAtrGuard(input, cfg),
    reentryGuard(input, cfg),
    afterWinGuard(input),
    addToLoserGuard(input),
  ];
  const by = (s) => guards.filter(x => x.state === s);
  return {
    guards,
    red: by('red').length, amber: by('amber').length, unknown: by('unknown').length,
    // The single field the log groups on later. `worst` is deliberately not a score — three ambers
    // are not a red, and pretending otherwise would invent a number the record cannot support.
    worst: by('red').length ? 'red' : by('amber').length ? 'amber' : by('unknown').length ? 'unknown' : 'green',
    breached: by('red').map(x => x.id),
  };
}

// The compact form written to the decision log: every guard's state by id, so realised P&L can
// later be grouped by whether a given guard was green or red at entry. States only — the values
// are re-derivable and would bloat a thousand-entry array.
export function guardStates(panel) {
  const out = {};
  for (const x of (panel?.guards || [])) out[x.id] = x.state;
  return out;
}
