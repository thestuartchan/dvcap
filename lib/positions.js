// lib/positions.js — fill-based position accounting for spot / swing trades.
//
// WHY FILLS. The console previously modelled a position as a single `entry` price, which cannot
// represent how these trades are actually run: you scale IN across several buys and scale OUT
// across several sells, so a position is frequently OPEN and REALISING P&L AT THE SAME TIME. A
// single entry field forces a false choice between "open" and "closed" and silently loses every
// partial exit. A position is therefore a list of FILLS, and every figure below is derived.
//
// AVERAGE COST, not FIFO. Realised P&L on a sell is (sellPrice − averageCost) × qty, and selling
// does NOT change the average cost of what remains. This matches how a scaled position is normally
// reasoned about ("I'm out of a third at +20%, the rest rides at my average"), and it is the
// default IBKR reports for most accounts, so the console and the broker agree. FIFO would produce
// different realised figures per lot and is deliberately not used — mixing the two would make the
// archive's totals unreconcilable against the broker.
//
// LIFECYCLE is derived, never stored: no fills → a SETUP (pre-trade idea with levels); net
// quantity > 0 → OPEN; back to zero after having traded → CLOSED (archived).
//
// CONTRACT MULTIPLIER. Quantity and price are quoted in different units for a derivative: an option
// is 1 contract at a $3.00 premium but costs $300, and a futures contract multiplies harder still.
// Everything money-valued below is therefore qty × price × MULTIPLIER, while the price fields stay
// in quoted terms so the archive reads back the premium you actually paid rather than a per-contract
// dollar figure nobody quotes. Defaulting to 1 leaves every equity position exactly as it was.

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? NaN : +v;

export const FILL_SIDES = ['buy', 'sell'];

// Reduce a fill list to position state. Fills are applied in DATE order, not array order, so a
// backfilled fill lands in the right place in the average-cost sequence.
export function derivePosition(fills = [], { multiplier = 1 } = {}) {
  const m = Number.isFinite(+multiplier) && +multiplier > 0 ? +multiplier : 1;
  const all = (Array.isArray(fills) ? fills : [])
    .map(f => ({ ...f, qty: num(f?.qty), price: num(f?.price), date: f?.date || '' }))
    .filter(f => f.side === 'buy' || f.side === 'sell');

  // A fill with a PRICE but no QUANTITY is INCOMPLETE, not invalid — it usually means an imported
  // or half-remembered position where the price is known and the size still has to be filled in.
  // Dropping it silently reclassified a position the user actually holds as an untaken "setup",
  // which is the kind of quiet data loss this project refuses elsewhere. Such fills are retained
  // and surfaced so the gap is visible and fixable; only genuinely unusable rows are discarded.
  const incomplete = all.filter(f => Number.isFinite(f.price) && f.price >= 0 && !(Number.isFinite(f.qty) && f.qty > 0));
  const clean = all
    .filter(f => Number.isFinite(f.qty) && f.qty > 0 && Number.isFinite(f.price) && f.price >= 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  let qty = 0, avgCost = 0, realized = 0, bought = 0, sold = 0, costOut = 0, proceeds = 0, spent = 0;
  const warnings = [];
  // Every sell, as the PERCENTAGE it was taken at against the average cost at that moment. This is
  // the "TP'ed at 11%, 14%, 21%" read: what each scale-out actually got, which a single realised
  // total cannot express and which is unrecoverable once the fills are collapsed.
  const scaleOuts = [];

  for (const f of clean) {
    if (f.side === 'buy') {
      const newQty = qty + f.qty;
      avgCost = newQty > 0 ? ((avgCost * qty) + (f.price * f.qty)) / newQty : 0;
      qty = newQty;
      bought += f.qty;
      spent += f.price * f.qty;
    } else {
      // Selling more than held is a data error, not a short. Clamp and say so rather than
      // silently producing a negative position and nonsense average cost.
      const sellQty = Math.min(f.qty, qty);
      if (f.qty > qty) warnings.push(`sell of ${f.qty} on ${f.date || 'unknown date'} exceeds the ${qty} held — counted as ${sellQty}`);
      if (sellQty > 0) {
        realized += sellQty * (f.price - avgCost) * m;
        costOut += sellQty * avgCost * m;
        proceeds += sellQty * f.price * m;
        if (avgCost > 0) scaleOuts.push({ date: f.date || null, pct: +(((f.price - avgCost) / avgCost) * 100).toFixed(2) });
        qty -= sellQty;
        sold += sellQty;
      }
      if (qty === 0) avgCost = 0;
    }
  }

  // An incomplete BUY still means the position is held — it is open, pending a quantity. Only a
  // row with no fills at all is a setup.
  const needsQty = incomplete.length > 0;
  const status = (clean.length === 0 && !needsQty) ? 'setup'
    : (qty > 0 || needsQty) ? 'open' : 'closed';
  return {
    fills: clean, nFills: clean.length,
    incomplete, needsQty,
    qty: +qty.toFixed(6), avgCost: qty > 0 ? +avgCost.toFixed(6) : null,
    realized: +realized.toFixed(2),
    // Return on the capital actually taken out, which is the honest denominator for a scale-out:
    // measuring realised P&L against the whole position would understate a partial exit.
    realizedPct: costOut > 0 ? +((realized / costOut) * 100).toFixed(2) : null,
    bought, sold, multiplier: m,
    // `spent` and `proceeds` are MONEY (multiplier applied); `avgEntry`/`avgExit` divide it back
    // out so they read in quoted terms — a $3.00 premium, not $300 a contract.
    proceeds: +proceeds.toFixed(2), spent: +(spent * m).toFixed(2),
    // Lifetime averages, which OUTLIVE the position. `avgCost` is the running book cost and is
    // deliberately null once the position is flat — but a CLOSED trade still has to report what it
    // was bought and sold at, which is the whole point of an archive row. These two are computed
    // over every fill and therefore survive the exit.
    avgEntry: bought > 0 ? +(spent / bought).toFixed(6) : null,
    avgExit: sold > 0 ? +(proceeds / (sold * m)).toFixed(6) : null,
    status, warnings, scaleOuts,
    firstDate: clean[0]?.date || null,
    lastDate: clean.length ? clean[clean.length - 1].date : null,
    // A position that is open AND has already realised something — the case the old model could
    // not express at all.
    partiallyRealised: qty > 0 && sold > 0,
  };
}

// ── Splitting one symbol into separate TRADES ────────────────────────────────
// A row holds one trade, but a symbol can hold several: buy 200, sell all 200, then buy 600 again
// three weeks later is TWO trades that happen to share a ticker, not one position that scaled. The
// broker reports them as a single undifferentiated fill stream, so the boundary has to be found
// rather than read: a trade OPENS from flat and CLOSES the moment net quantity returns to flat.
//
// A leading SELL (the closing leg of a position opened before the records begin) is kept as its own
// group rather than driving quantity negative, because that is a real trade whose entry is simply
// missing — not a short.
export function splitIntoTrades(fills = []) {
  const clean = (Array.isArray(fills) ? fills : [])
    .filter(f => (f?.side === 'buy' || f?.side === 'sell') && Number.isFinite(num(f.qty)) && num(f.qty) > 0)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const trips = [];
  let qty = 0, cur = null;
  for (const f of clean) {
    if (!cur) cur = [];
    cur.push(f);
    qty += f.side === 'buy' ? num(f.qty) : -num(f.qty);
    if (qty <= 0) { trips.push(cur); cur = null; qty = 0; }
  }
  if (cur) trips.push(cur);
  return trips;
}

// ── Collapsing a trade's fills to one bulk average each way ──────────────────
// Six partial fills from one order are the broker's execution detail, not six decisions. Collapsing
// them to a single size-weighted buy and sell is what makes a trade readable.
//
// For a CLOSED trade it is always exact, and provably so: everything bought is eventually sold, so
// realised P&L is total proceeds minus total cost, and neither depends on the order the fills
// arrived in. Interleaving a sell between two buys does not change it.
//
// For an OPEN trade that has already sold part, it CAN drift. There, realised P&L is measured
// against the running average at the moment of the sell, and a later buy that is folded into one
// bulk average retroactively changes what that sell was measured against. (Buy 100@10, sell 50@20,
// buy 100@30 realises +500; collapsed to buy 200@20 / sell 50@20 it realises nothing.)
//
// So the collapse is computed, then CHECKED against the original realised figure, and the result
// reports whether it was exact along with the drift. A caller must not silently rewrite a trade
// whose P&L would change.
export function collapseFills(fills = [], { multiplier = 1 } = {}) {
  const before = derivePosition(fills, { multiplier });
  const clean = before.fills;
  if (!clean.length) return { fills: [], exact: true, delta: 0, from: 0, to: 0 };
  const side = (k) => clean.filter(f => f.side === k);
  const bulk = (k, id) => {
    const l = side(k);
    if (!l.length) return null;
    const q = l.reduce((a, f) => a + f.qty, 0);
    const notional = l.reduce((a, f) => a + f.qty * f.price, 0);
    return {
      id, side: k, qty: +q.toFixed(6), price: +(notional / q).toFixed(6),
      date: k === 'buy' ? l[0].date : l[l.length - 1].date,
      note: l.length > 1 ? `bulk average of ${l.length} fills` : (l[0].note || ''),
    };
  };
  const out = [bulk('buy', 'b0'), bulk('sell', 's0')].filter(Boolean);
  const after = derivePosition(out, { multiplier });
  const delta = +(after.realized - before.realized).toFixed(2);
  return { fills: out, exact: delta === 0, delta, from: clean.length, to: out.length };
}

// Live P&L for a derived position. `price` is the live quote in the position's own currency.
export function positionPnl(derived, price) {
  const p = num(price);
  const m = derived?.multiplier > 0 ? derived.multiplier : 1;
  // A price of ZERO is not a price, it is a missing one. Nothing this console tracks can trade at
  // zero while the position is still open, and treating it as real turned a futures position whose
  // ticker simply did not resolve into a 100% loss on the card and −$59k in the portfolio total.
  const hasLive = Number.isFinite(p) && p > 0 && derived.qty > 0;
  const unrealized = hasLive && derived.avgCost != null
    ? +((p - derived.avgCost) * derived.qty * m).toFixed(2) : null;
  // A PERCENTAGE is multiplier-free by construction — it cancels top and bottom — so it stays the
  // move in the premium, which is the number that matters on a derivative.
  const unrealizedPct = hasLive && derived.avgCost > 0
    ? +(((p - derived.avgCost) / derived.avgCost) * 100).toFixed(2) : null;
  const marketValue = hasLive ? +(p * derived.qty * m).toFixed(2) : null;
  const total = unrealized == null ? derived.realized : +(derived.realized + unrealized).toFixed(2);
  // The percentage that MATCHES `total`. `unrealizedPct` is the move in the price from the average
  // cost, which is the wrong denominator once part of a position has been sold — the realised gain
  // was earned on capital that is no longer in the trade. Measuring the whole P&L against
  // everything ever put in gives one figure the money number can be read against, and it collapses
  // to `unrealizedPct` exactly when nothing has been sold.
  const totalPct = derived.spent > 0 ? +((total / derived.spent) * 100).toFixed(2) : null;
  return { unrealized, unrealizedPct, marketValue, realized: derived.realized, total, totalPct };
}

// ── Levels ───────────────────────────────────────────────────────────────────
// A spot/swing setup is watched as ZONES, not single prices: "accumulate 92–96" is the real
// instruction, so a level carries an optional `to`. A bare `at` is treated as a point with a small
// tolerance so a near-miss still flags rather than being silently skipped.
export const LEVEL_KINDS = ['buy', 'sell', 'stop'];
export const POINT_TOLERANCE_PCT = 0.25;

export function levelHit(level, price) {
  const p = num(price), a = num(level?.at), b = num(level?.to);
  if (!Number.isFinite(p) || !Number.isFinite(a)) return false;
  if (Number.isFinite(b)) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return p >= lo && p <= hi;
  }
  if (level?.kind === 'stop') return p <= a;          // stop: breached on the way down
  if (level?.kind === 'sell') return p >= a;          // target: reached on the way up
  if (level?.kind === 'buy') return p <= a;           // bid: reached on the way down
  return Math.abs((p - a) / a) * 100 <= POINT_TOLERANCE_PCT;
}

// Every triggered level across a set of positions, for the alert strip.
export function levelHits(positions = [], priceOf = () => null) {
  const out = [];
  for (const pos of positions) {
    const price = num(priceOf(pos));
    if (!Number.isFinite(price)) continue;
    for (const lv of (pos.levels || [])) {
      if (levelHit(lv, price)) out.push({ position: pos, level: lv, price });
    }
  }
  return out;
}

// Distance from live price to a level, in percent. Negative = price is below the level.
export function distancePct(level, price) {
  const p = num(price), a = num(level?.at);
  if (!Number.isFinite(p) || !Number.isFinite(a) || a === 0) return null;
  return +(((a - p) / p) * 100).toFixed(2);
}

// ── Portfolio roll-up ────────────────────────────────────────────────────────
// `toBase` converts an amount from a position's currency into the reporting currency; it returns
// null when a rate is unavailable, and any position that cannot be converted is EXCLUDED from the
// totals and counted in `unconverted` rather than being added at face value in the wrong currency.
// ── ROLLED CONTRACTS ──────────────────────────────────────────────────────────
// A ROLL IS ONE TRADE, NOT TWO. Selling the Aug micro gold at 4613.80 and buying the Dec in the
// same order is not an exit and a fresh idea — the position never stopped existing. The broker has
// no choice but to book it as two contracts, and the console followed, which is why MGC posted as
// "+0.00%, held 1d" on a position that had actually been long since 17 August and was well up. Both
// halves of that line were true about the CONTRACT and false about the TRADE.
//
// The fix is the futures industry's own: BACK-ADJUSTMENT. The new contract does not trade at the
// old one's price — the gap between them is the calendar spread, and paying it is a real cost of
// staying in — so the continuous entry is the new contract's average cost less whatever the legs
// behind it realised, per unit. On MGC: 4649.70 less 1,708.99 over one contract at ×10, i.e.
// 4649.70 − 170.90 = 4478.81. Marked at 4649.80 that is +3.82%, which is the return the position
// has actually produced, and it is the same number as (realised + unrealised) over what went in.
//
// WHAT THIS MOVES, deliberately: the leg's realised P&L stops being an archive row and becomes part
// of the open position's unrealised, because that is where it economically lives. The leg is marked
// `rolledInto` so nothing counts it twice — it is not a completed trade, it is a contract that was
// replaced. The card and the archive both read that mark.
//
// WHAT IT DOES NOT MOVE: `spent`, `proceeds` and `marketValue` stay as they actually happened. A
// back-adjusted entry is a measuring convention, not a claim about cash, and weights and capital
// must keep answering to the real numbers.
//
// The link is declared, never inferred. "Sold one contract and bought another the same day" is also
// what closing one trade and opening a different one looks like, and only the account owner knows
// which it was.
export const MAX_ROLL_CHAIN = 12;

export function applyRolls(rows = []) {
  const byId = new Map(rows.map(r => [r?.id, r]).filter(([k]) => k != null));
  // A leg may only be rolled forward once, and only if it is actually finished. Pointing at an open
  // row would fold a live position's P&L into another live position's entry.
  const childOf = new Map();
  for (const r of rows) {
    const p = r?.rolledFrom;
    if (!p || p === r.id || !byId.has(p)) continue;
    if (byId.get(p)?.derived?.status !== 'closed') continue;
    if (!childOf.has(p)) childOf.set(p, r.id);
  }
  const valid = (r) => {
    const p = r?.rolledFrom;
    return p && byId.has(p) && childOf.get(p) === r.id;
  };

  return rows.map(r => {
    const d = r?.derived;
    if (!d) return r;
    const rolledInto = childOf.get(r.id) || null;
    // A leg is not a completed trade. Marking it is the whole of what a leg needs — its own numbers
    // stay exactly as they were, so the console can still show what that contract did.
    if (rolledInto) return { ...r, derived: { ...d, rolledInto } };
    if (!valid(r)) return r;

    // Walk back through however many contracts this has been. A cycle or a runaway chain stops at
    // MAX_ROLL_CHAIN rather than hanging.
    const legs = [];
    const seen = new Set([r.id]);
    let cur = r.rolledFrom;
    while (cur && byId.has(cur) && !seen.has(cur) && legs.length < MAX_ROLL_CHAIN) {
      seen.add(cur);
      const leg = byId.get(cur);
      legs.push(leg);
      cur = valid(leg) ? leg.rolledFrom : null;
    }
    if (!legs.length) return r;

    const chainRealized = +legs.reduce((a, l) => a + (l.derived?.realized || 0), 0).toFixed(2);
    const m = d.multiplier || 1;
    const first = legs[legs.length - 1]?.derived?.firstDate || d.firstDate;
    const base = { ...d, rollLegs: legs.map(l => l.id), chainRealized, rollAdjusted: false, firstDate: first };

    if (d.status === 'closed') {
      // The chain has ended. Everything it ever made is this row's realised, and the entry it is
      // measured from moves by the same amount per unit so the percentage still agrees with it.
      const units = d.bought * m;
      if (!(units > 0) || d.avgEntry == null) return { ...r, derived: base };
      const avgEntry = +(d.avgEntry - chainRealized / units).toFixed(6);
      const realized = +(d.realized + chainRealized).toFixed(2);
      const costOut = avgEntry * d.sold * m;
      return { ...r, derived: { ...base, rollAdjusted: true, avgEntry,
        unadjustedAvgEntry: d.avgEntry, unadjustedRealized: d.realized, realized,
        realizedPct: costOut > 0 ? +((realized / costOut) * 100).toFixed(2) : d.realizedPct } };
    }

    const units = d.qty * m;
    if (!(units > 0) || d.avgCost == null) return { ...r, derived: base };
    return { ...r, derived: { ...base, rollAdjusted: true,
      avgCost: +(d.avgCost - chainRealized / units).toFixed(6),
      unadjustedAvgCost: d.avgCost } };
  });
}

export function summarize(rows = [], toBase = (v) => v) {
  let realized = 0, unrealized = 0, marketValue = 0, unconverted = 0;
  let open = 0, closed = 0, setups = 0, wins = 0, losses = 0;

  for (const r of rows) {
    const d = r.derived, pnl = r.pnl;
    if (d.status === 'setup') { setups++; continue; }
    // A rolled-out contract is not a closed trade — its P&L has moved into the position that
    // replaced it (see applyRolls). Counting it here would book the same gain twice and add a
    // phantom win to the record.
    if (d.rolledInto) continue;
    if (d.status === 'open') open++; else closed++;

    const rl = toBase(d.realized, r);
    if (rl == null && d.realized !== 0) { unconverted++; continue; }
    realized += rl || 0;
    if (pnl?.unrealized != null) {
      const ur = toBase(pnl.unrealized, r);
      if (ur == null) unconverted++; else unrealized += ur;
    }
    if (pnl?.marketValue != null) {
      const mv = toBase(pnl.marketValue, r);
      if (mv != null) marketValue += mv;
    }
    // Win/loss is judged on CLOSED positions only — an open one has not resolved yet.
    if (d.status === 'closed') { if (d.realized > 0) wins++; else if (d.realized < 0) losses++; }
  }

  const decided = wins + losses;
  return {
    realized: +realized.toFixed(2), unrealized: +unrealized.toFixed(2),
    total: +(realized + unrealized).toFixed(2), marketValue: +marketValue.toFixed(2),
    open, closed, setups, wins, losses,
    winRate: decided ? +((wins / decided) * 100).toFixed(0) : null,
    unconverted,
  };
}

// Cumulative realised P&L over time, for the archive chart. One point per SELL fill, in base
// currency, so the curve reflects when profit was actually taken rather than when a trade opened.
export function realizedCurve(rows = [], toBase = (v) => v) {
  const events = [];
  for (const r of rows) {
    // The MULTIPLIER has to be applied here too. This function re-walks the fills rather than
    // reading derived.realized, because the curve needs a point per sell rather than one total —
    // and re-walking meant it silently missed the contract multiplier when that was added. On a
    // book with six option trades the curve ended at +997 while the archive totalled +1,571: every
    // option's realised P&L was landing at a hundredth of its size.
    // A rolled-out contract's sell is not a realised trade here either — applyRolls moved that gain
    // into the position that replaced it, and a curve that still counted it would climb past the
    // total the archive reports.
    if (r.derived?.rolledInto) continue;
    const m = r.derived?.multiplier > 0 ? r.derived.multiplier : 1;
    let qty = 0, avgCost = 0;
    for (const f of (r.derived?.fills || [])) {
      if (f.side === 'buy') {
        const nq = qty + f.qty;
        avgCost = nq > 0 ? ((avgCost * qty) + (f.price * f.qty)) / nq : 0;
        qty = nq;
      } else {
        const sellQty = Math.min(f.qty, qty);
        if (sellQty > 0) {
          const gain = toBase(sellQty * (f.price - avgCost) * m, r);
          if (gain != null) events.push({ date: f.date, symbol: r.symbol, gain: +gain.toFixed(2) });
          qty -= sellQty;
          if (qty === 0) avgCost = 0;
        }
      }
    }
  }
  events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let run = 0;
  return events.map(e => { run += e.gain; return { date: e.date, symbol: e.symbol, gain: e.gain, cumulative: +run.toFixed(2) }; });
}
