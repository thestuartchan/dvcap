// lib/journal.js — closing a position, and reading performance back by regime.
//
// The journal originally accepted only a completed round trip typed by hand, and stamped
// "regime at entry" with WHATEVER THE REGIME WAS AT LOGGING TIME. For a position opened weeks
// earlier that stamp is a fabrication — the same class of error the rest of this project refuses
// everywhere else (an observation date is never the fetch date). Two fixes live here:
//
//   1. Regime at entry is LOOKED UP from the regime history by the trade's own entry date, and
//      returns `exact: false` with a null regime when the date predates the log. An honest
//      "unknown" beats a confident wrong answer.
//   2. A closed trade reports which MEASURE it used. Realized R requires a stop — without one
//      there is no R to compute, only a percentage return, and quietly mixing the two would make
//      the by-regime averages meaningless.

// ── Regime at a date ─────────────────────────────────────────────────────────
// history: [{ date, live_regime, stagflation_p, reflationary_p, deflationary_p, inflationary_p }]
// Returns the row for that date, or the most recent row BEFORE it (markets close; a Saturday entry
// belongs to Friday's regime). Null when the date predates the log entirely.
export function regimeOnDate(history = [], isoDate) {
  if (!isoDate || !Array.isArray(history) || !history.length) {
    return { regime: null, exact: false, note: 'no regime history available' };
  }
  const rows = history
    .filter(r => r && r.date && r.live_regime)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) return { regime: null, exact: false, note: 'no regime history available' };

  const exact = rows.find(r => r.date === isoDate);
  if (exact) {
    return { regime: exact.live_regime, exact: true, date: exact.date, probs: probsOf(exact), note: null };
  }
  if (isoDate < rows[0].date) {
    // The honest case: the trade predates the log. Never substitute today's regime.
    return {
      regime: null, exact: false, date: null,
      note: `entered ${isoDate}, before the regime log begins (${rows[0].date}) — regime at entry is unknown`,
    };
  }
  const prior = [...rows].reverse().find(r => r.date <= isoDate);
  if (!prior) return { regime: null, exact: false, note: 'no regime row on or before that date' };
  return {
    regime: prior.live_regime, exact: false, date: prior.date, probs: probsOf(prior),
    note: `no log row for ${isoDate}; using the prior session (${prior.date})`,
  };
}

const probsOf = (r) => ({
  stag: r.stagflation_p ?? null, ref: r.reflationary_p ?? null,
  def: r.deflationary_p ?? null, inf: r.inflationary_p ?? null,
});

// ── Closing a trade ──────────────────────────────────────────────────────────
// Returns pnl + pctReturn always, and realizedR ONLY when a stop makes R definable.
// `measure` names which one downstream stats may aggregate.
export function closeTrade({ entry, stop, exit, shares, side = 'long', currency = 'USD' } = {}) {
  const e = num(entry), x = num(exit), s = num(stop), q = num(shares);
  if (!Number.isFinite(e) || !Number.isFinite(x) || e <= 0) {
    return { ok: false, error: 'entry and exit prices are required' };
  }
  const dir = side === 'short' ? -1 : 1;
  const perShare = (x - e) * dir;
  const pctReturn = +((perShare / e) * 100).toFixed(2);
  const pnl = Number.isFinite(q) ? +(perShare * q).toFixed(2) : null;

  let realizedR = null, measure = 'pct';
  if (Number.isFinite(s) && Math.abs(e - s) > 0) {
    realizedR = +(perShare / Math.abs(e - s)).toFixed(2);
    measure = 'R';
  }
  return {
    ok: true, side, currency,
    perShare: +perShare.toFixed(4), pctReturn, pnl, realizedR, measure,
    win: perShare > 0,
    note: measure === 'pct'
      ? 'no stop was recorded, so there is no R to compute — this trade is measured in % return only'
      : null,
  };
}

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? NaN : +v;

// ── Performance by regime ────────────────────────────────────────────────────
// Groups CLOSED entries by the regime at entry. Trades whose regime is unknown are kept in their
// own bucket rather than dropped or lumped in — how much of the record is unattributable is itself
// something the reader needs to see.
export function performanceByRegime(journal = []) {
  const closed = journal.filter(j => j && j.exitPrice != null && j.entryPrice != null);
  const buckets = {};
  for (const j of closed) {
    const key = j.regimeAtEntryId || 'unknown';
    (buckets[key] ||= []).push(j);
  }
  const rows = Object.entries(buckets).map(([regime, list]) => {
    const withR = list.filter(j => j.realizedR != null);
    const wins = list.filter(j => (j.realizedR ?? j.pctReturn ?? 0) > 0).length;
    const sumR = withR.reduce((a, j) => a + j.realizedR, 0);
    const sumPct = list.reduce((a, j) => a + (j.pctReturn ?? 0), 0);
    return {
      regime, n: list.length,
      wins, winRate: list.length ? +((wins / list.length) * 100).toFixed(0) : null,
      nWithR: withR.length,
      avgR: withR.length ? +(sumR / withR.length).toFixed(2) : null,
      totalR: withR.length ? +sumR.toFixed(2) : null,
      avgPct: list.length ? +(sumPct / list.length).toFixed(2) : null,
    };
  }).sort((a, b) => b.n - a.n);

  const distinct = rows.filter(r => r.regime !== 'unknown').length;
  return {
    rows, totalClosed: closed.length, distinctRegimes: distinct,
    // The by-regime comparison only means something once trades span MORE THAN ONE regime.
    // Saying so is the difference between an honest empty state and an implied insight.
    comparable: distinct >= 2,
    note: closed.length === 0
      ? 'No closed trades yet — close a position from the watchlist to start the record.'
      : distinct < 2
        ? `All ${closed.length} closed trade${closed.length === 1 ? '' : 's'} sit in a single regime, so there is nothing to compare yet. This becomes useful once the regime turns and you have traded through both.`
        : null,
  };
}
