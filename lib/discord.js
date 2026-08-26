// lib/discord.js — Discord over an incoming WEBHOOK, no bot.
//
// WHY A WEBHOOK. The card in the reference channel is one message that gets rewritten as trades
// move, plus short-lived alerts. A webhook can do all three — post, edit its own message, delete
// its own message — so there is no bot token to store, no gateway connection to keep alive, and
// nothing to host. A bot would buy nothing here and cost a permanent credential.
//
//   POST   /webhooks/{id}/{token}?wait=true      → the created message, so its id can be kept
//   PATCH  /webhooks/{id}/{token}/messages/{id}  → rewrite in place
//   DELETE /webhooks/{id}/{token}/messages/{id}  → remove an expired alert
//
// Env: DISCORD_TRADES_WEBHOOK (the full URL — a CREDENTIAL, anyone holding it can post to the
// channel), DISCORD_USER_ID (optional, for the mention on an alert).
//
// Every call returns null/false rather than throwing. A Discord outage must never take down a
// console save; the card is a notification, and the console is the record.

const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/;

// Only a real Discord webhook URL is accepted. Posting a book to whatever URL happened to be in an
// env var is the one failure this module must not have.
export const isWebhookUrl = (u) => typeof u === 'string' && WEBHOOK_RE.test(u.trim());

export function webhookFromEnv(env = process.env) {
  const url = (env.DISCORD_TRADES_WEBHOOK || '').trim();
  return isWebhookUrl(url) ? url : null;
}
export const mentionFromEnv = (env = process.env) =>
  /^\d{5,32}$/.test(String(env.DISCORD_USER_ID || '').trim()) ? String(env.DISCORD_USER_ID).trim() : null;

// Alerts default to PERMANENT. The reference channel keeps them, and a notice that deletes itself
// is worse than useless if it vanishes before it is read. Set TRADE_ALERT_TTL_MIN to a positive
// number of minutes to have the sweep remove them.
export function alertTtlMin(env = process.env) {
  const v = Number(env.TRADE_ALERT_TTL_MIN);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

async function call(url, method, body) {
  try {
    const r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 429) { console.error('discord rate limited'); return { ok: false, status: 429 }; }
    if (!r.ok) { console.error('discord', method, r.status); return { ok: false, status: r.status }; }
    const text = await r.text();
    return { ok: true, status: r.status, json: text ? JSON.parse(text) : null };
  } catch (e) {
    console.error('discord', method, e?.message || e);
    return { ok: false, status: 0 };
  }
}

// Post and return the new message id, which is what makes later edits possible.
export async function post(webhook, payload) {
  if (!isWebhookUrl(webhook)) return null;
  const res = await call(`${webhook}?wait=true`, 'POST', payload);
  return res.ok ? (res.json?.id ?? null) : null;
}

// Rewrite in place. A 404 means the message is gone — deleted by hand, or from another channel —
// which the caller must handle by posting afresh rather than by retrying forever.
export async function edit(webhook, messageId, payload) {
  if (!isWebhookUrl(webhook) || !messageId) return { ok: false, gone: false };
  const res = await call(`${webhook}/messages/${messageId}`, 'PATCH', payload);
  return { ok: res.ok, gone: res.status === 404 };
}

export async function remove(webhook, messageId) {
  if (!isWebhookUrl(webhook) || !messageId) return false;
  const res = await call(`${webhook}/messages/${messageId}`, 'DELETE');
  return res.ok || res.status === 404;   // already gone is success
}

// Keep the card where it is if it exists, and re-post it if it does not.
export async function upsertCard(webhook, messageId, payload) {
  if (messageId) {
    const { ok, gone } = await edit(webhook, messageId, payload);
    if (ok) return { id: messageId, created: false };
    if (!gone) return { id: messageId, created: false, failed: true };
  }
  const id = await post(webhook, payload);
  return { id, created: !!id, failed: !id };
}

export const CARD_KEY = 'dvcap:discord:card:v1';
export const ALERTS_KEY = 'dvcap:discord:alerts:v1';
