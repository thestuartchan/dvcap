// lib/discipline.js — the one pattern in this account's record that is knowable BEFORE the order,
// surfaced at the moment the order is recorded.
//
// WHY THIS EXISTS, and why it is the only intervention rather than another measurement. Segmenting
// 709 broker fills into round trips gives 106 same-session trades worth −$16,399.79. Split them by
// whether the trade added to a position already underwater:
//
//                        exited via a stop      exited some other way
//   added to a loser        +$5,319.25 (7)          −$18,377.11 (27)
//   did not                 +$3,988.70 (29)          −$7,330.63 (43)
//
// Twenty-seven trades lost $18,377. The other seventy-nine made $1,977 — +$25.03 a trip, which is
// indistinguishable from zero before screen time. One behaviour accounts for more than the whole
// loss.
//
// THE HONEST LIMIT OF THAT TABLE. The broker file records `order_type`, so the columns mean "the
// exit executed as a STOP order" — not "a stop was set". No trade in the file carries a stop_price
// at all. So the column split describes how trades ENDED, which is not knowable when the order is
// placed, and cannot justify a rule on its own. Only the ROW split — did this order add to a
// position already down — is knowable at entry, and that is therefore the only thing this fires on.
// Whether a stop was set is recorded rather than assumed (see lib/decisions.js), because it is the
// field that would let the column split be re-derived honestly later.
//
// It never blocks. A warning that prevents an action gets worked around; one that names what you
// are about to do, with what it has cost before, is information at the moment it is usable.

// Point-in-time, from the segmentation above. Restated rather than recomputed because the console's
// archive holds curated swing rows, not the 106 intraday round trips these came from — so it CANNOT
// reproduce this and a live figure would be quietly wrong. Re-derive from the broker file and
// update the date when it is refreshed.
export const ADD_TO_LOSER_EVIDENCE = Object.freeze({
  asOf: '2026-08-27',
  window: '706 fills, 106 same-session round trips',
  cohortTrades: 27,
  cohortPnl: -18377.11,
  restTrades: 79,
  restPnl: 1977.32,
  line: '27 same-session trades that added to a losing position lost $18,377. The other 79 made $1,977.',
});

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// Is this order an add to a position already underwater? `derived` is a derivePosition result and
// `pct` the position's current unrealised percentage (positionPnl.unrealizedPct).
//
// The check is on the POSITION being down, not on the fill price being below the average. Those
// differ, and the position one is what the record measured: a buy above your average in a position
// that is still underwater is the same behaviour — committing more capital to a losing idea.
export function addToLoser({ derived, pct, side = 'buy', fillPrice = null } = {}) {
  const qty = num(derived?.qty);
  const p = num(pct);
  if (side !== 'buy' || !(qty > 0) || p == null || p >= 0) return null;
  const buys = (derived?.fills || []).filter(f => f.side === 'buy').length;
  const avg = num(derived?.avgCost);
  const fp = num(fillPrice);
  return {
    addNumber: buys + 1,          // the order about to be recorded
    priorBuys: buys,
    drawdownPct: +p.toFixed(2),
    avgCost: avg,
    // Below the average is the classic case and worth naming separately, but it is not the
    // condition — the position being down is.
    belowAverage: (fp != null && avg != null) ? fp < avg : null,
    evidence: ADD_TO_LOSER_EVIDENCE,
  };
}
