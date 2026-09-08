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

import { kvGetJson, kvSetJson, kvConfigured, CONSOLE_KEY, WALLET_SNAPSHOT_KEY, WALLET_PENDING_KEY } from '../lib/kv.js';
import { derivePosition, positionPnl, levelHits, applyRolls } from '../lib/positions.js';
import { buildCard, buildClosedCard, buildAlert, diffRows, showsOnCard } from '../lib/tradecard.js';
import { upsertCard, post, remove, webhookFromEnv, walletWebhookFromEnv, mentionFromEnv, alertTtlMin, CARD_KEY } from '../lib/discord.js';
import { authorised as gate, refusalReason } from '../lib/apiauth.js';
import { fetchWallets } from '../lib/wallet.js';
import { fetchSpotContext, fetchHyperliquid, fetchHlAccount, fetchHlSpot, fetchHlOrders } from '../lib/hyperliquid.js';
import { diffHoldings, walletPublicView, buildWalletCard, mergePending, perpPublicView } from '../lib/walletcard.js';

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
// FAILS CLOSED. This read `if (!want) return true` — no secret configured, everyone welcome —
// and TRADECARD_SECRET was not set in production, so the endpoint was open to anyone. It does not
// merely read: it rebuilds the Discord card and POSTS it. A dashboard session is accepted so the
// browser path keeps working; the cron must present the key.
const authorised = (req) => gate(req);   // async — the caller must await it

// ── THE WALLET CARD, IN A DIFFERENT CHANNEL ──────────────────────────────────
// Lives in this route rather than its own because the deployment is at 12 of 12 serverless
// functions; scripts/check-function-count.mjs says so in those words, and merging beats deleting
// something else. Reached as ?card=wallet.
//
// RE-SENT, NEVER EDITED. The trades card edits one message in place because a swing book that
// re-posts all day is noise. This one fires only when the composition actually changed, so a fresh
// message is both simpler and the better behaviour — it surfaces in the channel exactly when
// something happened and never otherwise.
//
// The channel is PUBLIC. lib/walletcard.js publishes prices and composition and no size of any
// kind; the snapshot below keeps quantities, which is why it lives in Redis and not in a card.
// `post` false  — the half-hourly DETECTION run. Diffs, buffers whatever changed, stays silent.
// `post` true   — the once-a-day run. Detects first (so a swap minutes before the hour is not held
//                 over), then publishes the day and drains the buffer.
//
// WHY DETECTION AND PUBLICATION ARE SPLIT. Posting within half an hour of a trade puts the trade in
// a half-hour window, and on a quiet chain the swaps of one obscure token in half an hour may number
// in the single digits — the post time is itself the filter. Batching to a fixed hour widens that
// window to a day. Detection still runs every half hour because a position opened and closed between
// two daily posts would otherwise never have existed: the snapshot either side of it is identical.
//
// AND WHY IT POSTS EVEN ON A QUIET DAY. A card that appears only when something happened makes its
// own presence the signal. A card every day at the same hour says nothing by existing.
// PUBLISHING IS OPPORTUNISTIC, NOT BOUND TO ONE CRON FIRING.
//
// It used to publish only when GitHub reported the schedule as '0 22 * * *'. GitHub's scheduler
// does not honour that reliably: on 2026-09-08 the workflow was scheduled for ~36 detect runs and
// one publish, and got five runs — 00:37, 11:00, 15:15, 18:55, 21:45 — all of them detect. The 22:00
// entry was dropped outright, and the card has never published on its own schedule. Every post so
// far was a manual dispatch.
//
// So the hour decides, not which cron woke us: at or after PUBLISH_HOUR_UTC, if today's card has
// not gone out, this run sends it. Any surviving run in the evening carries the day, and the
// once-a-day guarantee comes from a recorded date rather than from a timer nobody controls.
export const PUBLISH_HOUR_UTC = 22;
export const utcDate = (d = new Date()) => d.toISOString().slice(0, 10);

// Exported so the rule is testable without a network or a Redis. Forced posts always go; otherwise
// the hour must have come and today's card must not already have gone out.
export function shouldPublish({ forced = false, clock = new Date(), lastPosted = null,
                                hour = PUBLISH_HOUR_UTC } = {}) {
  if (forced) return true;
  return clock.getUTCHours() >= hour && lastPosted !== utcDate(clock);
}

export async function refreshWallet({ post = false, clock = new Date() } = {}) {
  const hook = walletWebhookFromEnv();
  if (!hook) return { ok: false, skipped: 'DISCORD_WALLET_WEBHOOK is not set' };
  if (!kvConfigured()) return { ok: false, skipped: 'no Redis — nothing to compare against' };

  const [spotCtx, hlMarkets] = await Promise.all([fetchSpotContext(), fetchHyperliquid()]);
  const [w, hlSpot, hlAcct] = await Promise.all([
    fetchWallets({ spotMeta: spotCtx.meta, spotPrices: spotCtx.prices, markets: hlMarkets.markets }),
    fetchHlSpot({ context: spotCtx }),
    fetchHlAccount(),
  ]);
  if (!w.ok) return { ok: false, skipped: 'no chain answered' };

  // Flattened across chains, because the same token on two chains is two holdings. Hyperliquid's
  // SPOT ledger joins as one more chain: it is a balance like any other, and diffing it the same
  // way means a spot buy there is announced like a spot buy anywhere else. The EVM side is already
  // covered separately as HyperEVM — different venue, different balances, so both belong.
  const now = w.chains.filter(c => c.ok).flatMap(c =>
    // `thin` rides along: a price from a market with no volume in it is not the same fact as a
    // price from a real one, and the card was publishing both with identical authority.
    c.rows.map(r => ({ coin: r.coin, chain: c.chain, total: r.total, price: r.price, thin: !!r.thin })));
  if (hlSpot.ok) {
    for (const r of hlSpot.rows) now.push({ coin: r.coin, chain: 'Hyperliquid', total: r.total, price: r.price, thin: !!r.thin });
  }

  // PERPS ARE NOT DIFFED. A position is not a balance that went up or down — it has a direction, an
  // invalidation level and an objective, and it is reported as it stands rather than as a change.
  // Levels come from resting trigger orders, and they are read AFTER the positions because the
  // classifier needs each position's entry to tell a stop from a target.
  let perps = [];
  if (hlAcct.ok && hlAcct.positions.length) {
    const orders = await fetchHlOrders({ positions: hlAcct.positions });
    perps = hlAcct.positions
      .map(p => perpPublicView(p, orders.levels.get(p.coin) || null, hlMarkets.markets?.[p.coin]?.mark ?? null))
      .filter(Boolean);
  }

  const prevSnap = (await kvGetJson(WALLET_SNAPSHOT_KEY)) || null;
  // FIRST RUN POSTS NOTHING. With nothing to compare against, every holding looks newly bought and
  // the first card would be a fabricated buying spree. Record and stay quiet.
  if (!prevSnap?.rows) {
    await kvSetJson(WALLET_SNAPSHOT_KEY, { rows: now, at: new Date().toISOString() });
    return { ok: true, posted: false, seeded: now.length };
  }

  const fresh = diffHoldings(prevSnap.rows, now);
  const pendingRec = await kvGetJson(WALLET_PENDING_KEY);
  const buffered = pendingRec?.events || [];
  // Carried through every buffer write, or a detect run would erase the record of today's post
  // and the next run would send a second one.
  const lastPostedStamp = pendingRec?.postedOn ?? null;
  const pending = mergePending(buffered, fresh);

  // ORDER IS LOAD-BEARING. The buffer is written BEFORE the snapshot moves, so a failure between the
  // two re-detects the same events next run and mergePending folds them back into one entry. The
  // reverse order would advance the watermark past events that were never recorded anywhere.
  if (fresh.length) {
    if (!(await kvSetJson(WALLET_PENDING_KEY, { events: pending, at: new Date().toISOString(), postedOn: lastPostedStamp }))) {
      return { ok: false, posted: false, error: 'could not buffer events — snapshot left where it was' };
    }
  }
  await kvSetJson(WALLET_SNAPSHOT_KEY, { rows: now, at: new Date().toISOString() });

  // `post` forces it (the manual dispatch); otherwise the clock and the record decide.
  const today = utcDate(clock);
  const lastPosted = lastPostedStamp;
  if (!shouldPublish({ forced: post, clock, lastPosted })) {
    return { ok: true, posted: false, detected: fresh.length, pending: pending.length,
             due: `${PUBLISH_HOUR_UTC}:00Z`, lastPosted };
  }

  const holdings = now.filter(r => r.price != null).map(r => walletPublicView(r, r.chain));
  const card = buildWalletCard(pending, holdings, { perps });
  const r = await fetch(hook, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(card), signal: AbortSignal.timeout(10000),
  });
  // The buffer is drained ONLY on a confirmed post. A failed webhook that cleared it anyway would
  // swallow the day permanently — tomorrow's card would show a wallet that changed by itself.
  if (!r.ok) return { ok: false, posted: false, pending: pending.length, error: `discord HTTP ${r.status}` };
  // The date is what makes it once-a-day; the buffer clearing is what makes it not repeat itself.
  await kvSetJson(WALLET_PENDING_KEY, { events: [], at: clock.toISOString(), postedOn: today });
  return { ok: true, posted: true, events: pending.length };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!(await authorised(req))) { res.status(401).json({ error: 'unauthorised', why: refusalReason(req) }); return; }
  if (String(req.query?.card || '') === 'wallet') {
    const post = /^(1|true|yes)$/i.test(String(req.query?.post || ''));
    try { res.status(200).json(await refreshWallet({ post })); }
    catch (e) { console.error('walletcard', e); res.status(200).json({ error: String(e?.message || e) }); }
    return;
  }
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${req.headers.host}`;
  try {
    res.status(200).json(await refresh(origin));
  } catch (e) {
    console.error('tradecard', e);
    res.status(200).json({ error: String(e?.message || e) });   // never fail the cron
  }
}
