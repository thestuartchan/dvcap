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
export const PUBLIC_FIELDS = Object.freeze(['symbol', 'label', 'price', 'avg', 'pct', 'r', 'exit', 'realisedPct', 'stop', 'targets', 'trims', 'days', 'since', 'status', 'flags', 'tags']);

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

// ── R ─────────────────────────────────────────────────────────────────────────
// The move measured in units of the risk that was taken. Entry 18.06 against a stop at 16.50 risks
// 1.56 a share; at 20.05 the trade is up 1.99, so +1.3R. A target at 25.25 is worth +4.6R, which is
// the reward-to-risk of the idea in one number.
//
// R EXISTS ONLY IF A STOP DOES. It is null without one, and that is the honest answer rather than a
// gap to paper over: a position with no invalidation level has no risk unit to measure against, so
// there is nothing for R to be a multiple OF.
export function rOf(price, entry, stop) {
  const p = num(price), e = num(entry), s = num(stop);
  if (p == null || e == null || s == null) return null;
  const risk = e - s;
  if (!(risk > 0)) return null;              // a stop at or above entry is not a risk unit
  return +((p - e) / risk).toFixed(1);
}

const lvl = (l, price, entry, stop) => ({ at: num(l.at), to: num(l.to), dist: distTo(l.at, price), r: rOf(l.at, entry, stop) });

// The ONLY row → card-data conversion. A fresh object from a fixed whitelist, never a copy with
// fields deleted: a delete-list fails OPEN the day a new field is added to a row, and that failure
// posts a private number to a server it cannot be withdrawn from.
export function publicView(row, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const d = row?.derived || {};
  const price = num(row?.price);
  const levels = (row?.levels || []).filter(l => num(l.at) != null);
  const stop = levels.find(l => l.kind === 'stop')?.at ?? null;
  const entry = num(d.avgCost ?? d.avgEntry);
  const closed = d.status === 'closed';
  // A closed trade's "price" is where it actually got out, not a live quote.
  const mark = closed ? num(d.avgExit) : price;
  return {
    symbol: String(row?.symbol || '').slice(0, 16),
    label: String(row?.trade || '').slice(0, 24),
    price,
    avg: num(d.avgCost ?? d.avgEntry),
    // THE MOVE FROM AVERAGE COST, not the return on everything ever deployed. The line already
    // shows the price and the average, so a reader computes (price − avg) / avg without being asked
    // — and a percentage that disagrees with the two numbers printed beside it makes the line
    // contradict itself. On ARM those differ by twelve points: −24.28% from an average of 331.56 at
    // 251.06, against −12.33% once the earlier trim is counted in. Both are true; only one can sit
    // between those two figures. The trim is reported separately, which is where it belongs.
    pct: num(row?.pnl?.unrealizedPct),
    stop: levels.filter(l => l.kind === 'stop').map(l => lvl(l, price, entry, stop))[0] || null,
    targets: levels.filter(l => l.kind === 'sell').map(l => lvl(l, price, entry, stop)).slice(0, 3),
    // Where the trade stands in risk units, and where it got out if it is done.
    r: rOf(mark, entry, stop),
    exit: closed ? num(d.avgExit) : null,
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
export const isCashLeg = (row) =>
  CASH_EQUIVALENTS.has(String(row?.symbol || '').toUpperCase().split('.')[0]) ||
  /\bcash\b/i.test(String(row?.trade || '')) ||
  (row?.tags || []).some(t => String(t).toLowerCase() === 'cash');

// ── FITTING THE BOOK INTO AN EMBED ────────────────────────────────────────────
// Discord caps a description at 4096 characters and a whole embed at 6000. A line carrying trims,
// a stop, three targets and a level flag runs to about 170, so a book of forty — which is what a
// channel like this looks like once it is real — would not fit at full detail.
//
// So detail DEGRADES rather than the list truncating. Full first; if that overflows, drop the level
// distances and cap the trims; if that still overflows, fall back to price, return and age. Only if
// the minimal form still will not fit does the list get cut, and then it says how many are missing
// rather than quietly ending early.
// A LONG HOLD IS NOT A SWING GOING WRONG. INTC down 10% is the thesis working as intended if the
// plan is to accumulate into weakness — there is no stop, and "it is red" is not a decision that
// needs making today. Sorting it beside a swing that has broken puts a standing prompt next to a
// position that does not want one, and dilutes the prompt for the ones that do.
//
// A hold declares itself the same way cash does: the label, or a tag. Both are editable in the
// console, which matters because this is a judgement about intent that only the account owner can
// make — nothing in the fills distinguishes a long hold from a swing that has been held a while.
export const isLongHold = (v) =>
  /\blong hold\b/i.test(String(v?.label || '')) || (v?.tags || []).some(t => String(t).toLowerCase() === 'hold');

// ── ORDER ─────────────────────────────────────────────────────────────────────
// A daily card is read top-down and rarely to the end, so the order decides what actually gets
// looked at. Three tiers:
//
//   1. LEVELS HIT. The only thing on the card that asks for a decision today.
//   2. SWINGS IN THE RED, worst first. This is the deliberate part. The account's own record says
//      the leak is staying in losing positions — trades that ended badly were held roughly twice as
//      long as the ones that worked — so the swing furthest underwater sits at the top every
//      morning rather than buried under the winners.
//   3. EVERYTHING ELSE, best first: winners, and long holds whatever they are doing.
//
// A position with no price sorts last in its tier rather than to the top as a zero.
export function sortForCard(views = []) {
  const tier = (v) => v.flags?.length ? 0 : (v.pct != null && v.pct < 0 && !isLongHold(v)) ? 1 : 2;
  return [...views].sort((a, b) => {
    const ta = tier(a), tb = tier(b);
    if (ta !== tb) return ta - tb;
    const pa = a.pct, pb = b.pct;
    if (pa == null && pb == null) return String(a.symbol).localeCompare(String(b.symbol));
    if (pa == null) return 1;
    if (pb == null) return -1;
    return ta === 2 ? pb - pa : pa - pb;   // winners best-first, everything else worst-first
  });
}

export const DESC_BUDGET = 3800;   // 4096 less headroom for the title and a Watching field

const dot = (v) => v == null ? '⚪' : v > 0 ? '🟢' : v < 0 ? '🔴' : '⚪';
const pc = (v, dp = 2) => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(dp)}%`;
const px = (v) => v == null ? '—' : (Math.abs(v) >= 100 ? v.toFixed(2) : v.toFixed(v < 1 ? 4 : 2));

// One position, in the order the eye wants it: what it is, where it is, what it has done, where it
// gets out. Trims sit next to the return because "up 13% and already took 8% and 14% off" is a
// different position from "up 13% and holding all of it".
export function tradeLine(v, detail = 'full') {
  const bits = [`${dot(v.pct)} **${v.symbol}** ${px(v.price)}`];
  if (v.avg != null && detail !== 'minimal') bits.push(`avg ${px(v.avg)}`);
  bits.push(`**${pc(v.pct)}**${v.r != null ? ` (${v.r > 0 ? '+' : ''}${v.r}R)` : ''}`);
  const maxTrims = detail === 'full' ? 6 : detail === 'compact' ? 2 : 0;
  if (v.trims.length && maxTrims) {
    const shown = v.trims.slice(0, maxTrims).map(t => pc(t, 0)).join(', ');
    bits.push(`trimmed ${shown}${v.trims.length > maxTrims ? '…' : ''}`);
  }
  const dist = (d) => (detail === 'full' && d != null) ? ` (${pc(d, 0)})` : '';
  if (v.stop && detail !== 'minimal') bits.push(`SL ${px(v.stop.at)}${dist(v.stop.dist)}`);
  if (v.targets.length && detail !== 'minimal') {
    const t = detail === 'full' ? v.targets : v.targets.slice(0, 1);
    // The target in absolute terms AND in R — the price you are aiming at, and what that aim is
    // worth against the risk. R replaces the distance when a stop makes it computable.
    bits.push(`TP ${t.map(x => `${px(x.at)}${x.r != null ? ` (+${x.r}R)` : dist(x.dist)}`).join(', ')}`);
  }
  if (v.days != null) bits.push(`${v.days}d`);
  if (v.flags.length) bits.push(`⚡ ${v.flags[0]}`);
  return bits.join(' · ');
}

// Render at the most detail that fits, and if nothing fits, cut the list and SAY so.
export function fitLines(views, budget = DESC_BUDGET) {
  for (const detail of ['full', 'compact', 'minimal']) {
    const lines = views.map(v => tradeLine(v, detail));
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
  if (setups.length) fields.push({ name: `Watching · ${setups.length}`, value: setups.map(v => `⚪ **${v.symbol}** ${v.label || 'levels set'}`).join('\n').slice(0, 1024) });

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
  const move = v.r != null ? `**${v.r > 0 ? '+' : ''}${v.r}R**` : `**${pc(v.realisedPct)}**`;
  const bits = [`${dot(v.realisedPct)} **${v.symbol}**`];
  if (v.exit != null) bits.push(`out ${px(v.exit)}`);
  bits.push(move);
  if (v.r != null && v.realisedPct != null) bits.push(pc(v.realisedPct));
  if (v.days != null) bits.push(`${v.days}d`);
  return bits.join(' · ');
}

export function buildClosedCard(rows = [], { updatedAt = null, limit = 25 } = {}) {
  const views = rows.map(r => publicView(r)).filter(v => v.status === 'closed');
  // Most recent first — the last thing you did is the thing you are still thinking about.
  const recent = [...views].sort((a, b) => String(b.since || '').localeCompare(String(a.since || ''))).slice(0, limit);
  const withR = recent.filter(v => v.r != null).length;
  const body = recent.length ? recent.map(closedLine).join('\n').slice(0, DESC_BUDGET) : '_Nothing closed yet._';
  const more = views.length > recent.length ? `\n_…${views.length - recent.length} older not shown._` : '';
  return {
    embeds: [{
      title: `📕 Closed · ${views.length} trade${views.length === 1 ? '' : 's'}`,
      color: 0x475569,
      description: body + more,
      ...(recent.length && withR < recent.length
        ? { footer: { text: `${recent.length - withR} of these closed without a recorded stop, so they show % instead of R` } }
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
