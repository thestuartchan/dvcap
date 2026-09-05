// api/tradecard.js — keep one Discord message in sync with the trade console.
//
// The channel holds ONE card that is rewritten as trades move, plus alerts when something actually
// happens. That shape is why this is a webhook and not a bot (see lib/discord.js) and why the
// card's message id lives in Redis: without it there is nothing to edit and every refresh would
// post a new message, which is precisely the noise the design is avoiding.
//
// TWO CALLERS, one path:
//   • a console save (api/manual-entry) → refresh(), so the card is current the moment you record
//   • a scheduled GET → refresh(), for P&L that moves while you do nothing, plus the alert sweep
//
// PRIVACY. Nothing in this file formats a number. Everything the channel sees is built by
// lib/tradecard.js from a whitelisted projection of a row, so a size or a dollar figure cannot
// reach Discord even by accident. See the header of that file.

import { kvGetJson, kvSetJson, kvConfigured, CONSOLE_KEY } from '../lib/kv.js';
import { derivePosition, positionPnl, levelHits, applyRolls } from '../lib/positions.js';
import { buildCard, buildClosedCard, buildAlert, diffRows, showsOnCard } from '../lib/tradecard.js';
import { upsertCard, post, remove, webhookFromEnv, mentionFromEnv, alertTtlMin, CARD_KEY, ALERTS_KEY } from '../lib/discord.js';

// A row's symbol is what you call it; the quote feed may call it something else. Mirrors the tab's
// own resolution — Yahoo has no MNQ, and its MGC is an unrelated stock.
const FUTURES_ROOTS = new Set(['MGC', 'MNQ', 'MES', 'MYM', 'M2K', 'MCL', 'SIL', 'GC', 'NQ', 'ES', 'CL', 'SI', 'HG', 'ZN', 'ZB']);
const quoteSym = (r) => {
  const explicit = String(r?.quoteSymbol || '').trim();
  if (explicit) return explicit;
  const sym = String(r?.symbol || '').trim();
  return (r?.margined || FUTURES_ROOTS.has(sym.toUpperCase())) && !sym.includes('=') && !sym.includes('.')
    ? `${sym.toUpperCase()}=F` : sym;
};

// Quotes come from the same passthrough the tab uses, so the card and the tab cannot disagree
// about a price. A missing quote leaves a row's percentage null rather than stale.
// /api/prices takes `tickers`, not `symbols`, and answers with the quote map at the TOP level
// rather than under a `prices` key. Getting either wrong fails the way it did on the first live
// run: a 400, an empty map, every price "—" and every return 0.00%, with nothing saying so. The
// timeout is generous because that endpoint deliberately paces its upstream calls 120ms apart.
async function quotesFor(symbols, origin) {
  if (!symbols.length) return {};
  try {
    const r = await fetch(`${origin}/api/prices?tickers=${encodeURIComponent(symbols.join(','))}`,
      { signal: AbortSignal.timeout(20000) });
    if (!r.ok) { console.error('tradecard: /api/prices returned', r.status); return {}; }
    const j = await r.json();
    return (j && typeof j === 'object' && !j.error) ? j : {};
  } catch (e) { console.error('tradecard: price fetch failed', e?.message || e); return {}; }
}

// Console rows → the shape lib/tradecard.js expects. Note `levelHits`: a level's alert lives in the
// console as a level plus a price, and the card needs it as a stable STRING so the same hit is not
// announced twice on every refresh.
export async function snapshot(origin) {
  const stored = await kvGetJson(CONSOLE_KEY);
  const rows = Array.isArray(stored?.rows) ? stored.rows : [];
  const live = rows.filter(r => derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side }).status !== 'closed');
  const prices = await quotesFor([...new Set(live.map(quoteSym).filter(Boolean))], origin);
  // applyRolls BEFORE the P&L: a rolled contract's entry is back-adjusted through the legs behind
  // it, so a percentage computed first would be the contract's rather than the trade's.
  return applyRolls(rows.map(r => ({ ...r, derived: derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side }) })))
    .map(r => {
      const price = prices?.[quoteSym(r)]?.price ?? null;
      const hits = levelHits([r], () => price)
        .map(h => `${h.level.kind} ${h.level.at}${h.level.to ? `–${h.level.to}` : ''} reached`);
      return { ...r, price, pnl: positionPnl(r.derived, price), levelHits: hits };
    });
}

export async function refresh(origin, { now = Date.now() } = {}) {
  const webhook = webhookFromEnv();
  if (!webhook) return { skipped: 'DISCORD_TRADES_WEBHOOK is unset or not a Discord webhook URL' };
  if (!kvConfigured()) return { skipped: 'Redis is not configured — there is nowhere to keep the card id' };

  const rows = await snapshot(origin);
  // One rule for both cards: cash parked in a bill fund, and options, which this book treats as
  // trades rather than holds.
  const live = rows.filter(r => r.derived.status !== 'closed' && showsOnCard(r));
  const state = (await kvGetJson(CARD_KEY)) || {};

  // Announce first, so an event is not lost if the card edit fails.
  // The same exclusion the card uses. Filtering only the card meant USFR was kept off the list and
  // still announced itself as a new trade, which is the one place cash had nothing to say at all.
  // Legs are excluded here too: a roll would otherwise fire "🏁 Closed — MGC" on a position that
  // is still open, which is the exact misreading the chaining exists to remove.
  const announceable = rows.filter(r => !r.derived.rolledInto && showsOnCard(r));
  const shape = (r) => ({ id: r.id, derived: { status: r.derived.status }, levelHits: r.levelHits });

  // COLD START. With no stored snapshot every existing position looks new, so the first run
  // announced the entire book — nine notifications for trades that were weeks old. A first run
  // seeds the state silently; a channel's history should begin with the card, not with a backlog.
  const firstRun = !state.rows;
  const events = firstRun ? [] : diffRows(state.rows, announceable.map(shape));
  const mention = mentionFromEnv();
  const ttl = alertTtlMin();
  const pending = Array.isArray(state.alerts) ? [...state.alerts] : [];
  for (const ev of events) {
    const row = rows.find(r => r.id === ev.row.id);
    if (!row) continue;
    const id = await post(webhook, buildAlert({ ...ev, row }, { mentionId: mention }));
    if (id && ttl > 0) pending.push({ id, expires: now + ttl * 60000 });
  }

  // Sweep expired alerts. With no TTL configured this list stays empty and nothing is ever deleted.
  const kept = [];
  for (const a of pending) {
    if (a.expires > now) { kept.push(a); continue; }
    if (!(await remove(webhook, a.id))) kept.push(a);   // keep it and retry next time
  }

  const card = buildCard(live, { updatedAt: new Date(now).toISOString() });
  const { id, created, failed } = await upsertCard(webhook, state.messageId, card);

  // A SECOND message for the closed book, edited in place like the first. Two messages rather than
  // two sections because they answer different questions and are read at different times — and
  // because one embed carrying both would hit Discord's 6000-character ceiling far sooner.
  // A rolled-out contract is not a closed trade — it was replaced, and its P&L now lives inside the
  // position that replaced it. Left here it would post as a completed winner that no longer exists.
  const closedRows = rows.filter(r => r.derived.status === 'closed' && !r.derived.rolledInto && showsOnCard(r));
  const closed = buildClosedCard(closedRows, { updatedAt: new Date(now).toISOString() });
  const c = closedRows.length ? await upsertCard(webhook, state.closedMessageId, closed) : { id: state.closedMessageId };

  await kvSetJson(CARD_KEY, {
    messageId: id ?? state.messageId ?? null,
    closedMessageId: c.id ?? state.closedMessageId ?? null,
    alerts: kept,
    // Only what diffRows needs, so the stored snapshot cannot become a second copy of the book.
    rows: announceable.map(shape),
    updatedAt: new Date(now).toISOString(),
  });

  return { posted: events.length, seeded: firstRun, cardCreated: created, cardFailed: !!failed, closed: closedRows.length,
           open: live.length, priced: live.filter(r => r.price != null).length, sweptAlerts: pending.length - kept.length };
}

// OPTIONAL SHARED SECRET. Without one this endpoint is reachable by anyone who knows the URL, and
// while a repeated call posts nothing — alerts only fire on a diff, and the diff is stored — it can
// still be used to make the card churn. Set TRADECARD_SECRET and the scheduler must present it.
// Left unset it stays open, so the thing works before anyone has thought about hardening it.
function authorised(req) {
  const want = (process.env.TRADECARD_SECRET || '').trim();
  if (!want) return true;
  const got = String(req.query?.key ?? req.headers['x-tradecard-key'] ?? '').trim();
  // Length-independent compare is overkill for a cron key, but a plain === leaks nothing either;
  // the point is that the comparison happens at all.
  return got.length === want.length && got === want;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!authorised(req)) { res.status(401).json({ error: 'unauthorised' }); return; }
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${req.headers.host}`;
  try {
    res.status(200).json(await refresh(origin));
  } catch (e) {
    console.error('tradecard', e);
    res.status(200).json({ error: String(e?.message || e) });   // never fail the cron
  }
}
