// lib/archive.js — the closed-trade archive, at a length that does not grow without bound.
//
// THE PROBLEM IS NOT PIXELS. A flat chronological list of every trade ever closed answers exactly
// one question — "what did I close most recently" — and answers it worse the longer it gets. The
// three other questions the archive is actually asked are not list-shaped at all:
//
//   "how did I do overall"      aggregate; needs no rows, and already sits above the table
//   "what did I do with SATS"   a lookup; scrolling is the wrong instrument
//   "how was August"            a subtotal, which a flat list cannot produce at any length
//
// So the structure here is PERIODS, each carrying its own subtotal, and every period is listed
// whether or not its rows are shown. Five years is sixty header lines, each one informative — the
// shape of the whole history is visible without rendering a single trade. The most recent few open
// by default; the rest expand on click.
//
// The other ceiling is the payload: api/manual-entry returns the whole console object, closed rows
// included, on every load, and every save writes it back. That one is not fixed here — see the
// note at the bottom — but periods are what make fixing it possible without losing the summary.

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// How many of the most recent periods are rendered expanded. Three months is roughly a quarter,
// which is the window a swing book is actually reviewed over.
export const OPEN_PERIODS = 3;

export const GRAINS = Object.freeze(['month', 'quarter', 'year']);

// The sort key AND the identity of a period. ISO-ish and lexicographically ordered on purpose, so
// sorting the keys sorts the periods and no date arithmetic is needed anywhere else.
export function periodKey(iso, grain = 'month') {
  const s = String(iso || '');
  const m = /^(\d{4})-(\d{2})/.exec(s);
  if (!m) return null;                       // a row with no close date is not in any period
  const [, y, mo] = m;
  if (grain === 'year') return y;
  if (grain === 'quarter') return `${y}-Q${Math.floor((+mo - 1) / 3) + 1}`;
  return `${y}-${mo}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

export function periodLabel(key, grain = 'month') {
  const s = String(key || '');
  if (grain === 'year') return s;
  if (grain === 'quarter') return s.replace('-', ' ');          // 2026-Q3 -> "2026 Q3"
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m) return s;
  return `${MONTHS[+m[2] - 1] || m[2]} ${m[1]}`;
}

// ── SUBTOTALS ───────────────────────────────────────────────────────────────
// NOT NAMED `valueOf`. It was, and the default never applied: every object inherits valueOf from
// Object.prototype, so destructuring it out of `{}` yields that inherited function rather than
// undefined, and the archive silently summed Object.prototype.valueOf over its rows. `toString`
// and `constructor` are the same trap. Caught on the first call, which is the argument for making
// one.
//
// `realisedOf` returns the row's realised P&L IN THE BASE CURRENCY, or null when no FX rate is
// available to convert it. A row that cannot be converted is COUNTED SEPARATELY rather than added
// at face value in the wrong unit — the same rule the archive's own totals follow, because a HKD
// figure summed into a USD total is not a small error, it is a different number.
export function summarise(rows = [], realisedOf = (r) => num(r?.derived?.realized)) {
  const conv = rows.map(r => realisedOf(r));
  const ok = conv.filter(v => v != null);
  const pcts = rows.map(r => num(r?.derived?.realizedPct)).filter(v => v != null);
  const wins = ok.filter(v => v > 0).length;
  return {
    count: rows.length,
    counted: ok.length,
    unconverted: conv.length - ok.length,
    realised: +ok.reduce((a, v) => a + v, 0).toFixed(2),
    wins,
    losses: ok.filter(v => v < 0).length,
    // A flat trade is neither a win nor a loss, so the two never have to sum to the count.
    winRate: ok.length ? Math.round((wins / ok.length) * 100) : null,
    avgPct: pcts.length ? +(pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(2) : null,
  };
}

// ── THE PERIODS ─────────────────────────────────────────────────────────────
// Newest first, because that is the order the archive is read in. Rows with no close date land in
// one trailing group rather than being dropped: a trade that happened is in the history whether or
// not it is dated, and silently omitting it would make the subtotals disagree with the total.
export function archivePeriods(rows = [], {
  grain = 'month',
  dateOf = (r) => r?.derived?.lastDate,
  realisedOf = (r) => num(r?.derived?.realized),
  open = OPEN_PERIODS,
} = {}) {
  const by = new Map();
  for (const r of rows) {
    const k = periodKey(dateOf(r), grain);
    const key = k ?? '';
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  const keys = [...by.keys()].filter(k => k !== '').sort().reverse();
  if (by.has('')) keys.push('');                                  // undated, always last

  return keys.map((key, i) => ({
    key: key || 'undated',
    label: key ? periodLabel(key, grain) : 'No close date',
    rows: by.get(key).slice(),
    // Whether this period renders its rows. The count is a NUMBER OF PERIODS rather than of trades
    // so a group is never cut in half: a month showing four of its nine trades is a subtotal that
    // disagrees with the rows under it, which is worse than showing none of them.
    open: i < Math.max(0, open),
    stats: summarise(by.get(key), realisedOf),
  }));
}

// What the collapsed remainder amounts to, for the one line that offers to expand it.
export function hiddenSummary(periods = [], realisedOf) {
  const shut = periods.filter(p => !p.open);
  return { periods: shut.length, ...summarise(shut.flatMap(p => p.rows), realisedOf) };
}

// ── WHY THERE IS NO `limit` HERE ────────────────────────────────────────────
// The obvious version of this took a trade count — "show the last 20". It fights the grouping:
// twenty trades lands mid-month, and a period header reading "August · 9 trades · +$1,240" above
// four rows is a subtotal that contradicts what is under it. Periods are whole or absent.
//
// STILL OUTSTANDING, and not solvable in this file: api/manual-entry serves every closed row on
// every page load, and each save rewrites the lot into Redis. The precedent for the fix is already
// in that route — `decisions` serves overrideStats() by default and the full log only on
// ?decisions=full. The archive wants the same shape: these summaries always, rows on request.
// It starts to matter in the high hundreds, not before.
