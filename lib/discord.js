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
// ── A SECOND CHANNEL, AND A PUBLIC ONE ───────────────────────────────────────
// The wallet card goes somewhere else entirely. A Discord webhook is bound to ONE channel, so the
// separation is structural rather than a flag someone can get wrong: two URLs, two channels, and
// no way for a wallet card to land in the trades channel or the reverse.
//
// This channel is PUBLIC by the owner's decision, which is why lib/walletcard.js publishes prices
// and never sizes. Unset means the wallet card simply does not post.
export function walletWebhookFromEnv(env = process.env) {
  const url = (env.DISCORD_WALLET_WEBHOOK || '').trim();
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
// ── NOTHING IS SILENTLY TRUNCATED ────────────────────────────────────────────
// The US pre-read went out at 12:59Z on 2026-09-11 at 6,122 characters against Discord's 4,096
// embed-description cap, and `message.slice(0, 4096)` cut it without a word. What the reader lost
// was BACKDROP, WHAT WOULD CHANGE IT, SINCE YOUR LAST BRIEF and the footer — the whole macro half
// of the brief — and the message ended mid-heading with a dangling rule, which is the only reason
// anyone noticed.
//
// It was not a one-off and it will not stay fixed by trimming: every section added this week made
// the brief longer, and a cap reached silently is a cap that will be reached again quietly.
//
// So a long message is SPLIT at its own section boundaries and posted as several messages, in
// order. Not several embeds — Discord caps the TOTAL characters across all embeds in one message
// at 6,000, which today's brief already exceeds, so the split has to be across messages.
export const EMBED_LIMIT = 4096;
// The rule api/preread.js puts between sections. Splitting here keeps a section whole.
export const SECTION_RULE = '───────────────';

// ── A BREAK SOMEONE CHOSE, NOT ONE THE CAP IMPOSED ───────────────────────────
// Greedy fill puts the break wherever the 4,096th character happens to land, which for the US
// brief was in the middle of the backdrop. `breakAfter` names sections that must END a message:
// TODAY'S MAP is the surface a trade is placed against and the rest of the brief is context, so
// they are read at different moments and belong in different messages.
//
// It is a MINIMUM number of parts, not a maximum — a forced part that is still over the cap is
// split again underneath, so this can never reintroduce a silent truncation. And because the break
// is taken at a section boundary, rejoining on the rule still reproduces the brief exactly.
export function splitForDiscord(message, { limit = EMBED_LIMIT, rule = SECTION_RULE, breakAfter = [] } = {}) {
  const text = String(message ?? '');
  if (!text) return [];
  const marks = (Array.isArray(breakAfter) ? breakAfter : [breakAfter]).filter(Boolean);
  const forced = marks.some(m => text.includes(m));
  if (text.length <= limit && !forced) return [text];

  const sep = `\n\n${rule}\n\n`;
  const parts = text.split(sep);
  const out = [];
  let cur = '';
  const flush = () => { if (cur) { out.push(cur); cur = ''; } };
  for (const part of parts) {
    const ends = marks.some(m => part.includes(m));
    const joined = cur ? `${cur}${sep}${part}` : part;
    if (joined.length <= limit) { cur = joined; if (ends) flush(); continue; }
    flush();
    // A SINGLE SECTION OVER THE CAP still has to go somewhere. Split it at line boundaries rather
    // than mid-sentence — a brief that breaks in the middle of a number is worse than one that
    // breaks between two bullets.
    if (part.length <= limit) { cur = part; if (ends) flush(); continue; }
    let buf = '';
    for (const line of part.split('\n')) {
      const next = buf ? `${buf}\n${line}` : line;
      if (next.length <= limit) { buf = next; continue; }
      if (buf) out.push(buf);
      // A LINE LONGER THAN THE CAP ON ITS OWN is the one case that has to break mid-line. It is
      // HARD-SPLIT into as many chunks as it needs rather than shaved to the first `limit`
      // characters — the first cut of this did the shave, and dropped the tail of the line in
      // silence, which is the same defect as the one being fixed, one level down. The forced
      // break is still reported by overlongLines() so a caller knows it happened.
      if (line.length <= limit) { buf = line; continue; }
      for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
      buf = '';
    }
    cur = buf;
    if (ends) flush();
  }
  flush();
  return out;
}

// What could not be split. Non-empty means a single LINE exceeded the cap and was cut — the only
// remaining way to lose characters, and it is surfaced rather than swallowed.
export function overlongLines(message, { limit = EMBED_LIMIT } = {}) {
  return String(message ?? '').split('\n').filter(l => l.length > limit).map(l => l.slice(0, 80));
}

// Posts a long message as N ordered messages, each inside the cap. Returns what happened —
// including the part count, so a caller can say "3 parts" rather than "ok".
export async function postLong(webhook, message, { limit = EMBED_LIMIT, rule = SECTION_RULE, label = null, breakAfter = [] } = {}) {
  const chunks = splitForDiscord(message, { limit, rule, breakAfter });
  if (!chunks.length) return { ok: false, parts: 0, error: 'nothing to post' };
  const overlong = overlongLines(message, { limit });
  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    // The continuation marker only appears when there IS a continuation — a single-part brief must
    // not grow a "1/1" it never needed.
    const head = chunks.length > 1 ? `_${label ? `${label} · ` : ''}part ${i + 1} of ${chunks.length}_\n` : '';
    const body = `${head}${chunks[i]}`;
    try {
      // `post` answers with the message id on success and null on failure — not a response object.
      // Reading it as one would have made every failure look like a success with an undefined
      // status, which is the shape of the bug this whole function exists to stop.
      const id = await post(webhook, { embeds: [{ description: body.slice(0, limit) }] });
      results.push({ part: i + 1, ok: id != null, id });
      if (id == null) return { ok: false, parts: chunks.length, posted: i, results, chars: message.length, overlong };
    } catch (e) {
      results.push({ part: i + 1, ok: false, error: String(e?.message || e) });
      return { ok: false, parts: chunks.length, posted: i, results, chars: message.length, overlong };
    }
  }
  return { ok: true, parts: chunks.length, posted: chunks.length, results, chars: message.length, overlong };
}

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
