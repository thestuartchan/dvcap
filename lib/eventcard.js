// lib/eventcard.js — macro event cards for the Discord events channel (/api/event-card).
//
// Stu and Claude build a card together (a rendered PNG plus a short post). Claude uploads it here
// and dvcap posts it through DISCORD_EVENTS_WEBHOOK. Each card has a stable id, so the same card
// can be posted early (lead time to position) and REFRESHED IN PLACE on the day — the message is
// edited, not re-posted, so the channel keeps one message per event.
//
// The post text is fixed in shape, per the Discord rules for this server: a "## " heading line,
// the role ping on its own line, then one or two sentences. Research only — the card carries no
// positions; that is enforced upstream by how the cards are built, and here by refusing anything
// that is not a PNG with a bounded caption.
//
// Pure functions only; the network and Redis live in api/tradecard.js.

export const EVENTS_CARD_KEY = 'dvcap:discord:events:v1';
export const MAX_PNG_BYTES = 3_000_000;          // the request body is base64, ~4/3 of this, under Vercel's 4.5MB
export const MAX_TEXT = 600;
export const MAX_HEADING = 120;
const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function roleFromEnv(env = process.env) {
  const v = String(env.DISCORD_EVENTS_ROLE_ID || '').trim();
  return /^\d{5,32}$/.test(v) ? v : null;
}

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, n);

// Validate an upsert body. Returns { ok, error } or { ok, card } with the decoded bytes.
export function parseUpsert(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'expected a JSON object' };
  const id = String(body.id || '');
  if (!ID_RE.test(id)) return { ok: false, error: 'id must be 3–64 chars of a-z, 0-9 and dashes (e.g. fomc-2026-10-28)' };
  const heading = clean(body.heading, MAX_HEADING);
  const text = clean(body.text, MAX_TEXT);
  if (!heading) return { ok: false, error: 'heading is required' };
  if (!text) return { ok: false, error: 'text is required' };
  if (typeof body.image_b64 !== 'string' || !body.image_b64) return { ok: false, error: 'image_b64 (a PNG, base64) is required' };
  let bytes;
  try { bytes = Buffer.from(body.image_b64, 'base64'); } catch { return { ok: false, error: 'image_b64 is not base64' }; }
  if (!bytes.length || bytes.length > MAX_PNG_BYTES) return { ok: false, error: `image must be 1 byte to ${MAX_PNG_BYTES} bytes` };
  if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) return { ok: false, error: 'image is not a PNG' };
  return { ok: true, card: { id, heading, text, filename: `${id}.png`, bytes } };
}

// The message: heading, ping, text, and the picture as an attachment (no embed — Discord shows a
// lone PNG attachment full width, which is how the cards were posted by hand).
export function eventPayload({ heading, text, filename }, { roleId = null } = {}) {
  const ping = roleId ? `<@&${roleId}>` : '';
  const content = [`## ${heading}`, ping, text].filter(Boolean).join('\n');
  return {
    content,
    allowed_mentions: { parse: [], roles: roleId ? [roleId] : [] },
    attachments: [{ id: 0, filename }],
  };
}

// A short fingerprint so a re-upload of the same card is reported as unchanged.
export function cardHash({ heading, text, bytes }) {
  let h = 2166136261 >>> 0;
  const feed = (buf) => { for (let i = 0; i < buf.length; i++) { h ^= buf[i]; h = Math.imul(h, 16777619) >>> 0; } };
  feed(Buffer.from(`${heading}\n${text}\n`));
  feed(bytes);
  return h.toString(16);
}
