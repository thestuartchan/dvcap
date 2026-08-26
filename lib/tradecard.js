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

export const PUBLIC_FIELDS = Object.freeze(['symbol', 'label', 'dir', 'pct', 'r', 'days', 'since', 'status', 'flags']);

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// Whole days between two ISO dates.
export function daysHeld(from, to) {
  if (!from || !to) return null;
  const a = Date.parse(from), b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 86400000));
}

// R MULTIPLE — the move so far measured in units of the risk that was taken. Entry 18.06 with a
// stop at 16.50 risks 1.56 a share; at 20.41 the trade is up 2.35, so +1.5R. It needs a stop and
// is null without one, which is honest: a trade with no invalidation level has no R.
export function rMultiple({ entry, price, stop }) {
  const e = num(entry), p = num(price), s = num(stop);
  if (e == null || p == null || s == null) return null;
  const risk = e - s;
  if (!(risk > 0)) return null;              // a stop at or above entry is not a risk unit
  return +((p - e) / risk).toFixed(1);
}

// The ONLY row → card-data conversion. Everything past here is public.
export function publicView(row, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const d = row?.derived || {};
  const p = row?.pnl || {};
  const stop = (row?.levels || []).find(l => l.kind === 'stop' && num(l.at) != null);
  const hits = (row?.levelHits || []).map(h => String(h).slice(0, 24));
  return {
    symbol: String(row?.symbol || '').slice(0, 16),
    label: String(row?.trade || '').slice(0, 24),
    dir: 'L',                                   // the console models long spot/swing only
    pct: num(p.totalPct),
    r: rMultiple({ entry: d.avgCost ?? d.avgEntry, price: num(row?.price), stop: stop?.at }),
    days: daysHeld(d.firstDate, d.status === 'closed' ? d.lastDate : today),
    since: d.firstDate || null,
    status: d.status || 'setup',
    flags: hits,
  };
}

const dot = (v) => v == null ? '🟡' : v > 0 ? '🟢' : v < 0 ? '🔴' : '⚪';
const pct = (v) => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;

// One line per trade. R is preferred over % when the trade has a stop, because R is what the
// position was actually sized against; % is the fallback and the two never appear together.
export function tradeLine(v) {
  const move = v.r != null ? `${v.r > 0 ? '+' : ''}${v.r}R` : pct(v.pct);
  const age = v.days == null ? '' : ` · ${v.days}d`;
  const flag = v.flags?.length ? ` · ⚡ ${v.flags[0]}` : '';
  return `${dot(v.pct)} **${v.symbol}** ${v.dir} · ${move}${age}${flag}`;
}

export const EMBED_COLOUR = 0x1e40af;

// The card. `rows` are already-derived console rows; nothing here reaches into them except through
// publicView. `stats` carries only ratios — win rate and average return — never a total.
export function buildCard(rows = [], { stats = null, updatedAt = null, title = 'Open trades' } = {}) {
  const views = rows.map(r => publicView(r));
  const open = views.filter(v => v.status === 'open');
  const setups = views.filter(v => v.status === 'setup');
  const fields = [];
  if (open.length) fields.push({ name: `Open · ${open.length}`, value: open.map(tradeLine).join('\n').slice(0, 1024) });
  if (setups.length) fields.push({ name: `Watching · ${setups.length}`, value: setups.map(v => `⚪ **${v.symbol}** ${v.label || 'levels set'}`).join('\n').slice(0, 1024) });
  if (!fields.length) fields.push({ name: 'Nothing open', value: 'No positions and no setups being watched.' });
  const footParts = [];
  if (stats?.winRate != null) footParts.push(`${stats.winRate}% win over ${stats.counted} closed`);
  if (stats?.avgPct != null) footParts.push(`avg ${stats.avgPct > 0 ? '+' : ''}${stats.avgPct}%`);
  footParts.push('live · updates in place');
  return {
    embeds: [{
      title: `📊 ${title} (${open.length})`,
      color: EMBED_COLOUR,
      fields,
      footer: { text: footParts.join(' · ') },
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
  if (ev.kind === 'opened') return { content: `${who}🔔 New trade — ${name} ${v.dir}`, allowed_mentions: { users: mentionId ? [mentionId] : [] } };
  if (ev.kind === 'closed') {
    const move = v.r != null ? `${v.r > 0 ? '+' : ''}${v.r}R` : pct(v.pct);
    return { content: `${who}🏁 Closed — ${name} · ${move}${v.days == null ? '' : ` after ${v.days}d`}`, allowed_mentions: { users: mentionId ? [mentionId] : [] } };
  }
  return { content: `${who}⚡ ${name} — ${ev.level}`, allowed_mentions: { users: mentionId ? [mentionId] : [] } };
}
