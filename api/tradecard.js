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
import { derivePosition, positionPnl, levelHits } from '../lib/positions.js';
import { buildCard, buildAlert, diffRows, isCashLeg } from '../lib/tradecard.js';
import { upsertCard, post, remove, webhookFromEnv, mentionFromEnv, alertTtlMin, CARD_KEY, ALERTS_KEY } from '../lib/discord.js';

// Quotes come from the same passthrough the tab uses, so the card and the tab cannot disagree
// about a price. A missing quote leaves a row's percentage null rather than stale.
async function quotesFor(symbols, origin) {
  if (!symbols.length) return {};
  try {
    const r = await fetch(`${origin}/api/prices?symbols=${encodeURIComponent(symbols.join(','))}`, { signal: AbortSignal.timeout(8000) });
    return r.ok ? (await r.json())?.prices ?? {} : {};
  } catch { return {}; }
}

// Console rows → the shape lib/tradecard.js expects. Note `levelHits`: a level's alert lives in the
// console as a level plus a price, and the card needs it as a stable STRING so the same hit is not
// announced twice on every refresh.
export async function snapshot(origin) {
  const stored = await kvGetJson(CONSOLE_KEY);
  const rows = Array.isArray(stored?.rows) ? stored.rows : [];
  const live = rows.filter(r => derivePosition(r.fills || [], { multiplier: r.multiplier }).status !== 'closed');
  const prices = await quotesFor([...new Set(live.map(r => r.symbol).filter(Boolean))], origin);
  return rows.map(r => {
    const derived = derivePosition(r.fills || [], { multiplier: r.multiplier });
    const price = prices?.[r.symbol]?.price ?? null;
    const hits = levelHits([{ ...r, derived }], () => price)
      .map(h => `${h.level.kind} ${h.level.at}${h.level.to ? `–${h.level.to}` : ''} reached`);
    return { ...r, derived, price, pnl: positionPnl(derived, price), levelHits: hits };
  });
}

export async function refresh(origin, { now = Date.now() } = {}) {
  const webhook = webhookFromEnv();
  if (!webhook) return { skipped: 'DISCORD_TRADES_WEBHOOK is unset or not a Discord webhook URL' };
  if (!kvConfigured()) return { skipped: 'Redis is not configured — there is nowhere to keep the card id' };

  const rows = await snapshot(origin);
  // Cash parked in a bill fund is not a position the channel has anything to say about.
  const live = rows.filter(r => r.derived.status !== 'closed' && !isCashLeg(r));
  const state = (await kvGetJson(CARD_KEY)) || {};

  // Announce first, so an event is not lost if the card edit fails.
  const events = diffRows(state.rows || [], rows.map(r => ({ id: r.id, derived: { status: r.derived.status }, levelHits: r.levelHits })));
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

  await kvSetJson(CARD_KEY, {
    messageId: id ?? state.messageId ?? null,
    alerts: kept,
    // Only what diffRows needs, so the stored snapshot cannot become a second copy of the book.
    rows: rows.map(r => ({ id: r.id, derived: { status: r.derived.status }, levelHits: r.levelHits })),
    updatedAt: new Date(now).toISOString(),
  });

  return { posted: events.length, cardCreated: created, cardFailed: !!failed, open: live.length, sweptAlerts: pending.length - kept.length };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${req.headers.host}`;
  try {
    res.status(200).json(await refresh(origin));
  } catch (e) {
    console.error('tradecard', e);
    res.status(200).json({ error: String(e?.message || e) });   // never fail the cron
  }
}
