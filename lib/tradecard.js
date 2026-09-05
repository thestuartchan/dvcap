// lib/tradecard.js — turning console rows into a Discord card.
//
// ── THE PRIVACY BOUNDARY ─────────────────────────────────────────────────────
// This file exists mostly to be the ONE place a position can become public, so the rule can be
// enforced by construction rather than by remembering it. Nothing downstream ever sees a row.
//
// A card may never carry: account balance or equity, position SIZE (shares, contracts, notional),
// absolute P&L in any currency, or a position's share of the book. That last one is the
// non-obvious member of the list: % of book is size divided by balance, so publishing it beside a
// % return leaks relative sizing across the book, and back-solves the balance the moment any
// absolute figure leaks anywhere else.
//
// A card MAY carry: ticker, direction, PERCENTAGE return, R multiple (a ratio, so it leaks
// nothing), days held, entry date, status, and level events.
//
// `publicView` is the only way to get from a row to card data. It builds a fresh object from a
// fixed whitelist rather than deleting fields from a copy, because a delete-list silently fails
// open the day a new field is added to a row — and the failure is a private number posted to a
// server, which cannot be taken back.

// WHAT IS AND IS NOT PUBLIC, restated after the first draft was both too shy and too noisy.
//
// PUBLIC: ticker, current price, average entry, percentage return, the stop and target LEVELS with
// their distance from price, the percentage each scale-out was taken at, and days held. Prices and
// levels are what a trade-idea channel is FOR — they are the idea. R is not printed because avg and
// SL are both here, which is the same information in a form that can be checked.
//
// NEVER: account balance or equity, position SIZE in any form (shares, contracts, notional, dollars
// committed), absolute P&L in any currency, or a position's share of the book. Those four are the
// ones that describe the size of the account rather than the merit of a trade. % of book is the
// non-obvious member — it is size over balance, so beside a % return it leaks relative sizing and
// back-solves the balance from any absolute figure that leaks anywhere else.
//
// Also dropped: a direction marker. The console models long spot and swing holds only, so "L" on
// every line was a column that never varied.
export const PUBLIC_FIELDS = Object.freeze(['symbol', 'label', 'side', 'price', 'avg', 'pct', 'r', 'exit', 'closedOn', 'realisedPct', 'stop', 'targets', 'trims', 'days', 'since', 'status', 'flags', 'tags']);

import { sideOf, dirSign, isShort, DEFAULT_SIDE } from './side.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// Whole days between two ISO dates.
export function daysHeld(from, to) {
  if (!from || !to) return null;
  const a = Date.parse(from), b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 86400000));
}

// How far a level sits from the last price, as a percentage. Negative is below.
export const distTo = (level, price) => {
  const l = num(level), p = num(price);
  return (l == null || p == null || p === 0) ? null : +(((l - p) / p) * 100).toFixed(1);
};

// ── A STOP ABOVE ENTRY IS NOT A RISK, IT IS A FLOOR ──────────────────────────
// ASTX on the 2026-08-27 card: average 9.20, price 10.62, stop 10.50. The line rendered
// "SL 10.50 (−1%)", which reads as one percent at risk. It is the opposite — the stop sits 14%
// ABOVE the average, so triggering it books a 14% gain. The one fact that changes how the position
// should be treated was the one fact the line did not carry.
//
// The condition was already detected and then silently dropped: rOf returns null for a stop at or
// above entry, because there is no risk unit to divide by, so the target quietly falls back to a
// percentage where every other line shows R. Detecting it and saying nothing is worse than not
// detecting it — the reader sees a missing R and has no way to know it means something good.
//
// THE GEOMETRY IS MIRRORED, NOT SHARED. This used to say it handled longs only and would be
// "actively wrong" for a short — but its guard was `s <= e`, which is the LONG test, and the
// function had no side to check. So on a short it did precisely what the comment warned against:
// a short's ordinary protective stop sits ABOVE entry, so `s > e` held, and the risk case was
// printed as "locked in +14%". The warning was correct and unenforceable at the same time.
//
// Now it takes the side. A long locks in when the stop rises above entry; a short locks in when the
// stop falls below it. One sign covers both, and the ordinary case still returns null in each.
export function lockedPct(stopAt, entry, side = DEFAULT_SIDE) {
  const s = num(stopAt), e = num(entry), sign = dirSign(side);
  if (s == null || e == null || e <= 0) return null;
  const above = (s - e) * sign;
  if (above <= 0) return null;               // an ordinary stop — R already describes it
  return +((above / e) * 100).toFixed(1);
}

// ── R ─────────────────────────────────────────────────────────────────────────
// The move measured in units of the risk that was taken. Entry 18.06 against a stop at 16.50 risks
// 1.56 a share; at 20.05 the trade is up 1.99, so +1.3R. A target at 25.25 is worth +4.6R, which is
// the reward-to-risk of the idea in one number.
//
// R EXISTS ONLY IF A STOP DOES. It is null without one, and that is the honest answer rather than a
// gap to paper over: a position with no invalidation level has no risk unit to measure against, so
// there is nothing for R to be a multiple OF.
// R is signed by direction too: a short entered at 100 with a stop at 110 risks 10 a unit, and at
// 90 it is +1R. Keyed off `e - s` alone, every short returned null — and a missing R already MEANS
// something specific on this card ("the stop is a floor, not a risk"), so a short read as a
// locked-in gain rather than as an unsupported case.
export function rOf(price, entry, stop, side = DEFAULT_SIDE) {
  const p = num(price), e = num(entry), s = num(stop), sign = dirSign(side);
  if (p == null || e == null || s == null) return null;
  const risk = (e - s) * sign;
  if (!(risk > 0)) return null;              // a stop the safe side of entry is not a risk unit
  return +(((p - e) * sign) / risk).toFixed(1);
}

const lvl = (l, price, entry, stop, side) => ({ at: num(l.at), to: num(l.to), dist: distTo(l.at, price), r: rOf(l.at, entry, stop, side) });

// The ONLY row → card-data conversion. A fresh object from a fixed whitelist, never a copy with
// fields deleted: a delete-list fails OPEN the day a new field is added to a row, and that failure
// posts a private number to a server it cannot be withdrawn from.
export function publicView(row, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const d = row?.derived || {};
  const price = num(row?.price);
  const levels = (row?.levels || []).filter(l => num(l.at) != null);
  const stop = levels.find(l => l.kind === 'stop')?.at ?? null;
  const entry = num(d.avgCost ?? d.avgEntry);
  // Read from the derived position, which normalised it once — never re-inferred here from where
  // the stop sits relative to entry, which is the mistake that started all of this.
  const side = sideOf(d.side ?? row?.side);
  const closed = d.status === 'closed';
  // A closed trade's "price" is where it actually got out, not a live quote.
  const mark = closed ? num(d.avgExit) : price;
  return {
    symbol: String(row?.symbol || '').slice(0, 16),
    label: String(row?.trade || '').slice(0, 24),
    // Direction is explicitly PUBLIC (see the header): it is a fact about the idea, not about the
    // size of the account. It was dropped originally because it never varied. It varies now.
    side: side ?? DEFAULT_SIDE,
    price,
    avg: num(d.avgCost ?? d.avgEntry),
    // THE MOVE FROM AVERAGE COST, not the return on everything ever deployed. The line already
    // shows the price and the average, so a reader computes (price − avg) / avg without being asked
    // — and a percentage that disagrees with the two numbers printed beside it makes the line
    // contradict itself. On ARM those differ by twelve points: −24.28% from an average of 331.56 at
    // 251.06, against −12.33% once the earlier trim is counted in. Both are true; only one can sit
    // between those two figures. The trim is reported separately, which is where it belongs.
    pct: num(row?.pnl?.unrealizedPct),
    stop: levels.filter(l => l.kind === 'stop')
      .map(l => ({ ...lvl(l, price, entry, stop, side), locked: lockedPct(l.at, entry, side) }))[0] || null,
    targets: levels.filter(l => l.kind === 'sell').map(l => lvl(l, price, entry, stop, side)).slice(0, 3),
    // Where the trade stands in risk units, and where it got out if it is done.
    r: rOf(mark, entry, stop, side),
    exit: closed ? num(d.avgExit) : null,
    closedOn: closed ? (d.lastDate || null) : null,
    realisedPct: closed ? num(d.realizedPct) : null,
    // PERCENTAGES only — the quantity sold is a size and never leaves the console.
    trims: (d.scaleOuts || []).map(t => num(t.pct)).filter(v => v != null).slice(0, 6),
    days: daysHeld(d.firstDate, d.status === 'closed' ? d.lastDate : today),
    since: d.firstDate || null,
    status: d.status || 'setup',
    flags: (row?.levelHits || []).map(h => String(h).slice(0, 28)),
    tags: (row?.tags || []).map(t => String(t).slice(0, 16)),
  };
}

// ── CASH IS NOT A POSITION ────────────────────────────────────────────────────
// A T-bill fund is where money waits, not a trade anyone took a view on. USFR sitting at +0.15%
// after 47 days is the yield doing its job, and putting it at the top of a portfolio card makes it
// read as the book's worst performer when it is not a performer at all.
//
// Two ways for a row to be cash: a known ticker, or the word "cash" in its trade label — the label
// is the escape hatch, since it is editable in the console and this list can never be complete.
export const CASH_EQUIVALENTS = Object.freeze(new Set([
  'USFR', 'SGOV', 'BIL', 'SHV', 'TFLO', 'GBIL', 'XBIL', 'TBIL', 'CLIP', 'JPST', 'MINT', 'ICSH', 'BOXX',
]));
// OPTIONS ARE TRADES, NOT HOLDS — the same rule the console applies to open positions, applied to
// closed ones so the two cards agree about what this channel is. A closed option trade stays in the
// archive, which is a record of everything; it just does not belong on a card about a swing book.
//
// Detected by tag first, since that is explicit. The ×100 multiplier is a fallback for a row that
// was never tagged, and is guarded on `margined` because a futures contract can carry 100 too.
export const isOptionTrade = (row) =>
  (row?.tags || []).some(t => String(t).toLowerCase() === 'option') ||
  (!row?.margined && Number(row?.multiplier) === 100);

// One rule, both cards. "If it does not make it onto the portfolio card it does not belong on the
// closed card" is only true if a single function decides.
export const showsOnCard = (row) => !isCashLeg(row) && !isOptionTrade(row);

export const isCashLeg = (row) =>
  CASH_EQUIVALENTS.has(String(row?.symbol || '').toUpperCase().split('.')[0]) ||
  /\bcash\b/i.test(String(row?.trade || '')) ||
  (row?.tags || []).some(t => String(t).toLowerCase() === 'cash');

// ── ORDER ─────────────────────────────────────────────────────────────────────
// A daily card is read top-down and rarely to the end, so the order decides what actually gets
// looked at.
//
// ONE ORDER, TOP TO BOTTOM: best percentage to worst. No tiers, no exceptions.
//
// This replaced a three-tier scheme — levels hit, then losers worst-first, then everything else —
// built on the account's own record: the leak is staying in losing positions, so put the worst one
// where the eye lands. It was right about the leak and wrong about the card. A reader who cannot
// predict where a position will appear has to scan the whole list to find one, and a list that
// reorders itself around a flag cannot be read as a ranking at all.
//
// A single monotonic sort can be read from either end, and it is the BOTTOM that carries the work:
// the run of red at the foot of the card is the management queue, in the order it needs managing.
// The top is the part you are allowed to leave alone. Nothing is buried, because nothing can be out
// of place.
//
// Level hits keep their ⚡ on the line and still fire as their own alert message, which is the thing
// that actually interrupts you. The card is a ranking; the alert is the interruption.
//
// A position with no price sorts LAST rather than to the top as a zero.
export function sortForCard(views = []) {
  return [...views].sort((a, b) => {
    const pa = a.pct, pb = b.pct;
    if (pa == null && pb == null) return String(a.symbol).localeCompare(String(b.symbol));
    if (pa == null) return 1;
    if (pb == null) return -1;
    if (pa !== pb) return pb - pa;
    return String(a.symbol).localeCompare(String(b.symbol));
  });
}

export const DESC_BUDGET = 3800;   // 4096 less headroom for the title and a Watching field

// GREEN AND RED COME FROM THE DIRECTION, not from the rounded percentage. MGC ten cents up on a
// 4,649 contract is +0.002%, which rounds to 0.00 at two decimals — and a dot keyed off that value
// turns grey, so a position that is up reads as a position with no price. The percentage stays
// rounded, because two decimals is the honest precision for it; the colour falls back to the raw
// gap between the mark and the average, so the dot always agrees with the two prices beside it.
// Grey is kept for the one case that means it: nothing to compare.
// The `pct` handed in is already signed by direction, but the FALLBACK is not: `mark - avg` is a
// price move, and on a short a price move down is a gain. Without the sign, a short too small to
// print a percentage would take its colour from the raw price gap and show red while winning.
export const dirOf = (pct, mark, avg, side = DEFAULT_SIDE) => {
  if (pct != null && pct !== 0) return pct;
  if (mark != null && avg != null && mark !== avg) return (mark - avg) * dirSign(side);
  return pct == null ? null : 0;
};
// ── THE CARD'S COLOUR VOCABULARY, IN ONE PLACE ───────────────────────────────
// Green and red are the P&L axis: up and down. WATCHING IS NOT ON THAT AXIS AT ALL — a setup has
// no position and therefore no gain to be neutral about — so it had been sharing white with "there
// is nothing to compare", which is a genuinely different statement and the one case white should
// keep. Two unrelated meanings on one symbol made a whole section of the card look like a list of
// flat positions rather than a list of things not yet entered.
//
// Yellow rather than orange: orange sits next to red in hue and reads as a warning at a glance,
// where watching is a neutral pending state. Yellow is off the green/red axis entirely, which is
// exactly what it needs to say.
export const DOT = Object.freeze({
  up: '🟢', down: '🔴',
  flat: '⚪',        // a real position, genuinely unchanged, or nothing to compare it against
  watching: '🟡',    // a setup: levels are armed, no position has been taken
});
const dot = (v) => v == null ? DOT.flat : v > 0 ? DOT.up : v < 0 ? DOT.down : DOT.flat;
// The sign follows the same direction the dot does, so a move too small to print still reads as a
// move: "+0.00%" beside a green dot says "up, by less than half a basis point", where a bare
// "0.00%" beside a green dot just looks like one of the two is wrong.
const pc = (v, dp = 2, dir = null) => {
  if (v == null) return '—';
  if (v === 0 && dir != null && dir !== 0) return `${dir > 0 ? '+' : '-'}${(0).toFixed(dp)}%`;
  return `${v > 0 ? '+' : ''}${v.toFixed(dp)}%`;
};
const px = (v) => v == null ? '—' : (Math.abs(v) >= 100 ? v.toFixed(2) : v.toFixed(v < 1 ? 4 : 2));

// ── A DISTANCE THAT ROUNDS TO ZERO IS NOT ZERO ───────────────────────────────
// Level distances print at zero decimals, which is right for the common case and wrong for the one
// that matters. RKLB on the same card: price 62.58, stop 62.45 — 0.21% away, the most urgent line
// in the book, rendered "(−0%)" and reading like nothing at all. The precision degraded exactly
// where the number became important.
//
// So the rule is not a fixed width, it is: never render a non-zero distance as zero. Add decimals
// until the figure survives, capped at two — past that the level is close enough that the price
// beside it is the better guide anyway.
const pcNonZero = (v, dp = 0) => {
  if (v == null) return '—';
  for (let d = dp; d < 2; d++) if (Math.abs(+v.toFixed(d)) > 0) return pc(v, d);
  return pc(v, Math.abs(+v.toFixed(2)) > 0 ? 2 : dp);
};

// One position, in the order the eye wants it: what it is, where it is, what it has done, where it
// gets out. Trims sit next to the return because "up 13% and already took 8% and 14% off" is a
// different position from "up 13% and holding all of it".
export function tradeLine(v, detail = 'full', { showSide = false } = {}) {
  const dir = dirOf(v.pct, v.price, v.avg, v.side);
  // SHOWN ONLY WHEN IT VARIES. The original card dropped the direction marker because "L" on every
  // line was a column that never changed, and that reasoning still holds for an all-long book. What
  // does not hold is leaving it off a MIXED book: unmarked then means "long" by a convention the
  // reader has to know, and the one line where it matters most is the one that looks like the rest.
  // So the card turns the column on for every row the moment any row is short.
  const bits = [`${dot(dir)}${showSide ? ` \`${isShort(v.side) ? 'S' : 'L'}\`` : ''} **${v.symbol}** ${px(v.price)}`];
  if (v.avg != null && detail !== 'minimal') bits.push(`avg ${px(v.avg)}`);
  bits.push(`**${pc(v.pct, 2, dir)}**${v.r != null ? ` (${v.r > 0 ? '+' : ''}${v.r}R)` : ''}`);
  const maxTrims = detail === 'full' ? 6 : detail === 'compact' ? 2 : 0;
  if (v.trims.length && maxTrims) {
    const shown = v.trims.slice(0, maxTrims).map(t => pc(t, 0)).join(', ');
    bits.push(`trimmed ${shown}${v.trims.length > maxTrims ? '…' : ''}`);
  }
  const dist = (d) => (detail === 'full' && d != null) ? ` (${pcNonZero(d)})` : '';
  if (v.stop && detail !== 'minimal') {
    // The floor rides WITH the distance rather than replacing it: "how much room is left" and
    // "what it books if it goes" are different questions and a stop above entry has both answers.
    // Kept at compact detail too — dropping it first would shed the line's most important clause
    // to save eight characters.
    const floor = v.stop.locked != null ? ` · ${pc(v.stop.locked, 0)} locked` : '';
    bits.push(`SL ${px(v.stop.at)}${dist(v.stop.dist)}${floor}`);
  }
  if (v.targets.length && detail !== 'minimal') {
    const t = detail === 'full' ? v.targets : v.targets.slice(0, 1);
    // The target in absolute terms AND in R — the price you are aiming at, and what that aim is
    // worth against the risk. R replaces the distance when a stop makes it computable.
    bits.push(`TP ${t.map(x => `${px(x.at)}${x.r != null ? ` (+${x.r}R)` : dist(x.dist)}`).join(', ')}`);
  }
  if (v.days != null) bits.push(`held ${v.days}d`);
  if (v.flags.length) bits.push(`⚡ ${v.flags[0]}`);
  return bits.join(' · ');
}

// ── FITTING THE BOOK INTO AN EMBED ────────────────────────────────────────────
// Discord caps a description at 4096 characters and a whole embed at 6000. A line carrying trims,
// a stop, three targets and a level flag runs to about 170, so a book of forty — which is what a
// channel like this looks like once it is real — would not fit at full detail.
//
// So detail DEGRADES rather than the list truncating. Full first; if that overflows, drop the level
// distances and cap the trims; if that still overflows, fall back to price, return and age. Only if
// the minimal form still will not fit does the list get cut, and then it says how many are missing
// rather than quietly ending early.
// Render at the most detail that fits, and if nothing fits, cut the list and SAY so.
export function fitLines(views, budget = DESC_BUDGET) {
  // Decided once for the whole card, not per line: a marker that appeared on some rows and not
  // others would read as a property of those rows rather than as a column.
  const showSide = views.some(v => isShort(v.side));
  for (const detail of ['full', 'compact', 'minimal']) {
    const lines = views.map(v => tradeLine(v, detail, { showSide }));
    const body = lines.join('\n');
    if (body.length <= budget) return { body, detail, dropped: 0 };
  }
  const lines = views.map(v => tradeLine(v, 'minimal'));
  const kept = [];
  let used = 0;
  for (const l of lines) {
    const note = `\n_…and ${views.length - kept.length} more not shown._`;
    if (used + l.length + 1 + note.length > budget) break;
    kept.push(l); used += l.length + 1;
  }
  return { body: `${kept.join('\n')}\n_…and ${views.length - kept.length} more not shown._`, detail: 'minimal', dropped: views.length - kept.length };
}

export const EMBED_COLOUR = 0x1e40af;

// The card. `rows` are already-derived console rows; nothing here reaches into them except through
// publicView. `stats` carries only ratios — win rate and average return — never a total.
export function buildCard(rows = [], { updatedAt = null, title = 'Portfolio' } = {}) {
  const views = rows.map(r => publicView(r));
  const open = views.filter(v => v.status === 'open');
  const setups = views.filter(v => v.status === 'setup');
  // Positions go in the DESCRIPTION, not a field. A field needs a name, and the only honest name
  // for it repeated the count already in the title — "Portfolio (9)" above "Open · 9". The
  // description also holds 4096 characters against a field's 1024, so the list stops truncating at
  // about eleven positions and starts truncating at about forty.
  const description = open.length ? fitLines(sortForCard(open)).body : '_Nothing open._';
  const fields = [];
  if (setups.length) fields.push({ name: `Watching · ${setups.length}`, value: setups.map(v => `${DOT.watching} **${v.symbol}** ${v.label || 'levels set'}`).join('\n').slice(0, 1024) });

  // NO FOOTER. It carried a win rate and an average return over the closed book, which is a summary
  // of the account rather than a statement about any trade on the card — the same reason the four
  // forbidden quantities are forbidden, one step further out. The card answers "what is on right
  // now"; how the record looks in aggregate is a different question and belongs in the console.
  return {
    embeds: [{
      title: `📊 ${title} · ${open.length} position${open.length === 1 ? '' : 's'}`,
      color: EMBED_COLOUR,
      description,
      ...(fields.length ? { fields } : {}),
      ...(updatedAt ? { timestamp: updatedAt } : {}),
    }],
  };
}

// ── THE CLOSED CARD ───────────────────────────────────────────────────────────
// A second message, deliberately thinner than the first: what it was, where it got out, and what
// that was worth. The open card answers "what do I hold"; this one answers "how did the last ones
// go", and mixing the two makes both harder to read.
//
// R IS ONLY THERE IF A STOP WAS. R is (exit − entry) / (entry − stop), so a trade closed without a
// recorded invalidation level has no risk unit to divide by. Every archive row imported from IBKR
// is in that position — a broker records what you did, never what you would have accepted losing —
// so those fall back to the percentage, which is true and simply less informative. Trades closed
// from here on with a stop set will carry R.
export function closedLine(v) {
  const bits = [`${dot(dirOf(v.realisedPct, v.exit, v.avg))} **${v.symbol}**`];
  if (v.exit != null) bits.push(px(v.exit));
  // R OR NOTHING. A percentage standing in for R is a different measurement wearing its slot: R
  // says how the trade did against the risk taken, a percentage says how the price moved, and a
  // column that silently switches between them cannot be read down. Where the stop was never
  // recorded the slot is simply empty.
  if (v.r != null) bits.push(`**${v.r > 0 ? '+' : ''}${v.r}R**`);
  if (v.days != null) bits.push(`held ${v.days}d`);
  return bits.join(' · ');
}

// A ROLLING WINDOW, not the whole record. A card is for what is still relevant; a trade closed in
// spring tells you nothing about how the book is running now, and left there it only makes the
// recent ones harder to find. The archive in the console keeps everything for ever — this is a view
// of it, and the title says which view so nothing appears to have been lost.
export const CLOSED_WINDOW_DAYS = 90;

export function buildClosedCard(rows = [], { updatedAt = null, limit = 25, today = new Date().toISOString().slice(0, 10), windowDays = CLOSED_WINDOW_DAYS } = {}) {
  const all = rows.map(r => publicView(r, { today })).filter(v => v.status === 'closed');
  // A trade with no recorded exit date is KEPT rather than dropped: the window is meant to retire
  // old trades, not to quietly discard ones whose dates were never captured.
  const inWindow = all.filter(v => { const d = daysHeld(v.closedOn, today); return d == null || d <= windowDays; });
  // Most recently CLOSED first — the last thing you finished is the thing you are still thinking
  // about. Sorting by entry date, as this did, put a long hold opened in June above a swing closed
  // yesterday.
  const recent = [...inWindow].sort((a, b) => String(b.closedOn || '').localeCompare(String(a.closedOn || ''))).slice(0, limit);
  const withR = recent.filter(v => v.r != null).length;
  const body = recent.length ? recent.map(closedLine).join('\n').slice(0, DESC_BUDGET) : '_Nothing closed in the last ' + windowDays + ' days._';
  const more = inWindow.length > recent.length ? `\n_…${inWindow.length - recent.length} older not shown._` : '';
  return {
    embeds: [{
      title: `📕 Closed (last ${windowDays} days) · ${inWindow.length} trade${inWindow.length === 1 ? '' : 's'}`,
      color: 0x475569,
      description: body + more,
      ...(recent.length && withR < recent.length
        ? { footer: { text: `${recent.length - withR} closed without a recorded stop, so there is no R to show for them` } }
        : {}),
      ...(updatedAt ? { timestamp: updatedAt } : {}),
    }],
  };
}

// ── Events ───────────────────────────────────────────────────────────────────
// What changed between two snapshots, and which of those changes is worth interrupting someone
// for. A scale-in is deliberately NOT an event: it happens often, it changes no decision for a
// reader, and a channel that pings for it stops being read.
export function diffRows(prev = [], next = []) {
  const before = new Map(prev.map(r => [r.id, r]));
  const events = [];
  for (const r of next) {
    const b = before.get(r.id);
    const nowS = r?.derived?.status, wasS = b?.derived?.status;
    if (!b && nowS === 'open') { events.push({ kind: 'opened', row: r }); continue; }
    if (b && wasS !== nowS) {
      if (nowS === 'open' && wasS === 'setup') events.push({ kind: 'opened', row: r });
      if (nowS === 'closed') events.push({ kind: 'closed', row: r });
    }
    const newHits = (r?.levelHits || []).filter(h => !(b?.levelHits || []).includes(h));
    for (const h of newHits) events.push({ kind: 'level', row: r, level: h });
  }
  return events;
}

export function buildAlert(ev, { mentionId = null } = {}) {
  const v = publicView(ev.row);
  const who = mentionId ? `<@${mentionId}> ` : '';
  const name = `**${v.symbol}**${v.label ? ` (${v.label})` : ''}`;
  if (ev.kind === 'opened') return { content: `${who}🔔 New trade — ${name}${v.avg == null ? '' : ` · avg ${px(v.avg)}`}${v.stop ? ` · SL ${px(v.stop.at)}` : ''}`, allowed_mentions: { users: mentionId ? [mentionId] : [] } };
  if (ev.kind === 'closed') {
    return { content: `${who}🏁 Closed — ${name} · ${pc(v.pct)}${v.days == null ? '' : ` after ${v.days}d`}`, allowed_mentions: { users: mentionId ? [mentionId] : [] } };
  }
  return { content: `${who}⚡ ${name} — ${ev.level}`, allowed_mentions: { users: mentionId ? [mentionId] : [] } };
}
