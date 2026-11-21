// lib/privatePost.js — post a finished piece (the market recap, the weekly Market Intel and its
// earnings card) to Stu's PRIVATE Discord channel from a scheduled task.
//
// WHY IT EXISTS (21 Nov 2026). The recap is written by a scheduled Claude task with Stu's connectors
// (Unusual Whales, TradingView), and it carries Unusual Whales figures, which are licensed for Stu's
// personal use and so go to his private channel only (lib/discord.js privateWebhookFromEnv). The task
// has no webhook URL of its own: it hands the text (and one PNG) to this door, which posts to the
// private webhook and nowhere else.
//
// THE DOOR. POST /api/flex-sync?post=private with the journal read key (x-journal-key), the key the
// scheduled tasks' environment already sends to that path. It opens this one action: post to the
// private channel. It cannot choose a channel, read anything back, edit or delete. Bounds: text up
// to MAX_CHARS, at most one PNG up to MAX_IMAGE_BYTES, MAX_POSTS_PER_HOUR posts an hour. Worst case
// if the key leaked: noise in a channel only Stu can see.
//
// FORMAT. Plain message content (not embeds), as Gayros's recap reads in Discord: headings, bold,
// bullets. A webhook message holds 2,000 characters, so the text is split at section boundaries
// (a line starting "### "), then at blank lines, then at line ends. The picture rides on the first
// message. "@Gayros" in the text becomes the role mention (DISCORD_EVENTS_ROLE_ID) and only that
// role may be pinged; without the variable the text stays as written and pings nobody.
import { privateWebhookFromEnv, isWebhookUrl } from './discord.js';
import { roleFromEnv } from './eventcard.js';
import { hasJournalReadKey } from './apiauth.js';
import { kvIncrEx, kvConfigured } from './kv.js';

export const MSG_LIMIT = 2000;
export const MAX_CHARS = 12000;
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_POSTS_PER_HOUR = 12;
const ROLE_TOKEN = '@Gayros';

// Split into messages of at most `limit` characters, preferring section boundaries.
export function splitMessages(text, limit = MSG_LIMIT) {
  const out = [];
  const pushPiece = (s) => { const t = s.replace(/^\n+|\n+$/g, ''); if (t) out.push(t); };
  // Sections: a "### " heading starts a new one.
  const sections = String(text).split(/\n(?=### )/);
  let cur = '';
  const flush = () => { pushPiece(cur); cur = ''; };
  const add = (block, sep) => {
    if (!cur) { cur = block; return; }
    if ((cur + sep + block).length <= limit) cur += sep + block; else { flush(); cur = block; }
  };
  for (const sec of sections) {
    if (sec.length <= limit) { add(sec, '\n\n'); continue; }
    // An oversized section: by paragraphs, then by lines, then hard cuts.
    for (const para of sec.split(/\n\n+/)) {
      if (para.length <= limit) { add(para, '\n\n'); continue; }
      for (const line of para.split('\n')) {
        if (line.length <= limit) { add(line, '\n'); continue; }
        for (let i = 0; i < line.length; i += limit) add(line.slice(i, i + limit), '\n');
      }
    }
  }
  flush();
  return out;
}

export function withRoleMention(text, roleId) {
  if (!roleId) return { content: text, allowed: { parse: [] } };
  return { content: String(text).split(ROLE_TOKEN).join(`<@&${roleId}>`), allowed: { parse: [], roles: [roleId] } };
}

// → { ok: true, content, image } | { ok: false, status, error }
export function validatePost(body = {}) {
  const content = typeof body.content === 'string' ? body.content.replace(/\r\n/g, '\n').trim() : '';
  if (!content) return { ok: false, status: 400, error: 'content is required' };
  if (content.length > MAX_CHARS) return { ok: false, status: 413, error: `content is ${content.length} characters; at most ${MAX_CHARS}` };
  let image = null;
  if (body.image_b64 != null) {
    const b64 = String(body.image_b64).replace(/^data:image\/png;base64,/, '');
    let bytes;
    try { bytes = Buffer.from(b64, 'base64'); } catch { return { ok: false, status: 400, error: 'image_b64 is not base64' }; }
    if (!bytes.length) return { ok: false, status: 400, error: 'image_b64 is empty' };
    if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, status: 413, error: `image is ${bytes.length} bytes; at most ${MAX_IMAGE_BYTES}` };
    const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    if (!png) return { ok: false, status: 415, error: 'image must be a PNG' };
    const filename = /^[A-Za-z0-9._-]{1,64}\.png$/.test(String(body.filename || '')) ? String(body.filename) : 'image.png';
    image = { bytes, filename };
  }
  return { ok: true, content, image };
}

async function sendOne(webhook, payload, image, fetchImpl) {
  const url = `${webhook}?wait=true`;
  let r;
  if (image) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ ...payload, attachments: [{ id: 0, filename: image.filename }] }));
    form.append('files[0]', new Blob([image.bytes], { type: 'image/png' }), image.filename);
    r = await fetchImpl(url, { method: 'POST', body: form, signal: AbortSignal.timeout(15000) });
  } else {
    r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
  }
  if (!r.ok) return { ok: false, status: r.status };
  const j = await r.json().catch(() => null);
  return { ok: true, id: j?.id ?? null };
}

// ONE MESSAGE (21 Nov 2026). Plain content stops at 2,000 characters, so a 3,400-character Market
// Intel arrived as two posts. Discord's components layout (IS_COMPONENTS_V2) holds up to 4,000
// characters of text in one message and shows the picture as a media gallery under it, which is
// how the recap is posted when it fits. Longer text, or a webhook that refuses components, falls
// back to the split plain messages below.
export const COMPONENTS_TEXT_LIMIT = 4000;
const IS_COMPONENTS_V2 = 1 << 15;
export function componentsPayload(text, allowed, image = null) {
  const components = [{ type: 10, content: text }];   // Text Display
  if (image) components.push({ type: 12, items: [{ media: { url: `attachment://${image.filename}` } }] });   // Media Gallery
  return { flags: IS_COMPONENTS_V2, components, allowed_mentions: allowed };
}
async function sendComponents(webhook, payload, image, fetchImpl) {
  const url = `${webhook}?wait=true&with_components=true`;
  let r;
  if (image) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ ...payload, attachments: [{ id: 0, filename: image.filename }] }));
    form.append('files[0]', new Blob([image.bytes], { type: 'image/png' }), image.filename);
    r = await fetchImpl(url, { method: 'POST', body: form, signal: AbortSignal.timeout(15000) });
  } else {
    r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
  }
  return { ok: r.ok, status: r.status };
}

export async function postPrivate({ content, image = null }, { webhook = privateWebhookFromEnv(), roleId = roleFromEnv(), fetchImpl = fetch } = {}) {
  if (!isWebhookUrl(webhook)) return { ok: false, status: 503, error: 'private channel webhook not set' };
  const { content: text, allowed } = withRoleMention(content, roleId);
  let fallback = null;
  if (text.length <= COMPONENTS_TEXT_LIMIT) {
    const one = await sendComponents(webhook, componentsPayload(text, allowed, image), image, fetchImpl);
    if (one.ok) return { ok: true, messages: 1, layout: 'components' };
    fallback = `components refused (${one.status})`;
  }
  const parts = splitMessages(text);
  const ids = [];
  for (let i = 0; i < parts.length; i++) {
    const res = await sendOne(webhook, { content: parts[i], allowed_mentions: allowed }, i === 0 ? image : null, fetchImpl);
    if (!res.ok) return { ok: false, status: 502, error: `Discord answered ${res.status} on message ${i + 1} of ${parts.length}`, posted: ids.length };
    ids.push(res.id);
  }
  return { ok: true, messages: ids.length, layout: 'split', ...(fallback ? { fallback } : {}) };
}

export async function privatePostRoute(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!hasJournalReadKey(req)) return res.status(401).json({ error: 'not authorised to post' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'the body is not JSON' }); } }
  const v = validatePost(body || {});
  if (!v.ok) return res.status(v.status).json({ error: v.error });
  if (kvConfigured()) {
    const n = await kvIncrEx('dvcap:privatepost:hour', 3600).catch(() => null);
    if (n != null && n > MAX_POSTS_PER_HOUR) return res.status(429).json({ error: `more than ${MAX_POSTS_PER_HOUR} posts this hour` });
  }
  const r = await postPrivate({ content: v.content, image: v.image });
  return res.status(r.ok ? 200 : r.status).json(r);
}
