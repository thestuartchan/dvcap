// lib/ideacard.js — one Discord card per selected trade idea, kept in step with the idea book.
//
// ── THE PRIVACY BOUNDARY ─────────────────────────────────────────────────────
// The same rule as lib/tradecard.js, enforced the same way: by construction. An idea doc arrives
// carrying private bookkeeping beside the idea itself — whether it was taken, the ladder it was
// sized into, the planned R, a free-text note, the outcome, the order. None of that is the idea,
// and some of it is SIZE.
//
// `publicIdea` is the only way from a doc to card data. It builds a fresh object from a fixed
// WHITELIST rather than deleting fields from a copy, because a delete-list silently fails open the
// day a new field is added to a doc — and the failure is a private number posted to a server,
// which cannot be taken back. `buildIdeaCard` reads the projection and never the doc.
//
// The card MAY carry: ticker, structure, thesis, play, side, sector, rank, catalyst and its time,
// entry / invalidation / exit, expiry, the alternatives compared, and PER-CONTRACT economics (cost,
// max gain, R:R, odds, breakeven, EV). Per contract is a property of the structure at a price —
// the same for one lot as for fifty — so it describes the idea and not the account.
//
// The card may NEVER carry: whether or when the idea was taken, a ladder, planned R, the note, the
// outcome, a contract count, or any size. Those are not on the whitelist, so they cannot be read.

import { createHash } from 'node:crypto';

export const IDEA_FIELDS = Object.freeze(['id', 'ticker', 'structure', 'thesis', 'thesisTag', 'play', 'sector', 'side', 'rank',
  'catalyst', 'catalystAt', 'entry', 'invalidation', 'exit', 'expiry', 'alts', 'priceNote', 'status']);
export const METRIC_FIELDS = Object.freeze(['kind', 'cost', 'maxGain', 'rr', 'oddsProfit', 'oddsNeeded', 'oddsEst', 'breakeven', 'ev']);

// Discord's embed limits. Enforced here rather than discovered by a 400 from the API.
export const LIMITS = Object.freeze({ title: 256, description: 4096, fieldName: 256, fieldValue: 1024, fields: 25, footer: 2048, total: 6000 });
// ── NOTHING IS SILENTLY TRUNCATED ────────────────────────────────────────────
// The rule lib/discord.js was written around: a cut that the reader cannot see is a cut that
// misleads. Anything shortened to fit ends with this marker.
export const TRIM_MARK = '… (trimmed)';
export const MAX_IDEAS = 25;
export const ALTS_MAX = 4;

export const COLORS = Object.freeze({ bull: 0x2E9E6A, bear: 0xC8463A, vol: 0xD9A94A, neutral: 0x8A93A1 });

const str = (v) => (v == null ? '' : typeof v === 'string' ? v.trim() : (typeof v === 'number' && Number.isFinite(v)) ? String(v) : '');
const numOrStr = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.trim() || null;
  return null;
};

// The projection. Fresh object, whitelisted keys, scalar values only — an object smuggled into a
// whitelisted key (say `entry: { contracts: 40 }`) becomes an empty string, not a JSON dump.
export function publicIdea(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const out = {};
  for (const k of IDEA_FIELDS) {
    if (k === 'alts') out.alts = Array.isArray(d.alts) ? d.alts.map(str).filter(Boolean) : [];
    else if (k === 'rank') out.rank = numOrStr(d.rank);
    else out[k] = str(d[k]);
  }
  const m = d.metrics && typeof d.metrics === 'object' ? d.metrics : null;
  if (m) {
    const pm = {};
    for (const k of METRIC_FIELDS) pm[k] = k === 'kind' ? str(m.kind).toLowerCase() : numOrStr(m[k]);
    out.metrics = pm;
  } else out.metrics = null;
  return out;
}

// Shorten to `max` with the visible marker. Under the cap it is returned as is.
export function clip(s, max) {
  const t = String(s ?? '');
  if (t.length <= max) return t;
  if (max <= TRIM_MARK.length) return TRIM_MARK.slice(0, max);
  return t.slice(0, max - TRIM_MARK.length).trimEnd() + TRIM_MARK;
}

// Long → green, short → red, a volatility play → amber, anything else grey. Volatility is tested
// FIRST: "Long vol" is a straddle, not a bullish call, and painting it green would say otherwise.
export function colorFor(side) {
  const s = str(side).toLowerCase();
  if (/\bvol/.test(s)) return COLORS.vol;
  if (/\b(bull|long)/.test(s)) return COLORS.bull;
  if (/\b(bear|short)/.test(s)) return COLORS.bear;
  return COLORS.neutral;
}

// Discord renders <t:UNIX:F> / <t:UNIX:R> in the READER'S timezone, so a catalyst time is posted
// once and read correctly in Dubai, London and New York. Null when the time does not parse.
export function discordTimestamps(iso) {
  const ms = Date.parse(str(iso));
  if (!Number.isFinite(ms)) return null;
  const u = Math.floor(ms / 1000);
  return `<t:${u}:F> (<t:${u}:R>)`;
}

const fmt = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return String(Math.round(v * 100) / 100);
  return String(v);
};
const pct = (v) => { const f = fmt(v); return f == null ? null : `${f.replace(/%$/, '')}%`; };
const seg = (label, v) => (v == null ? null : `${label} ${v}`);

export function economics(m) {
  if (!m) return '';
  let parts;
  if (m.kind === 'debit') {
    parts = [seg('Cost', fmt(m.cost)), seg('Max gain', fmt(m.maxGain)), seg('R:R', fmt(m.rr)),
             seg('Odds of profit', pct(m.oddsProfit)), seg('Breakeven', fmt(m.breakeven))];
  } else if (m.kind === 'credit') {
    const needs = pct(m.oddsNeeded), est = pct(m.oddsEst);
    parts = [seg('Risk/credit', fmt(m.cost)), seg('R:R', fmt(m.rr)),
             needs != null || est != null ? [needs != null ? `Needs ${needs}` : null, est != null ? `est. ${est}` : null].filter(Boolean).join(' vs ') : null];
  } else return '';
  const line = parts.filter(Boolean).join(' · ');
  const ev = fmt(m.ev);
  return [line, ev != null ? `EV: ${ev}` : null].filter(Boolean).join('\n');
}

const embedChars = (e) => (e.title || '').length + (e.description || '').length + (e.footer?.text || '').length
  + (e.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);

// The card. Reads the projection ONLY. `now` is the embed timestamp, injected so a test is stable.
export function buildIdeaCard(doc, { now = new Date() } = {}) {
  const v = publicIdea(doc);
  const head = v.rank != null ? `#${v.rank} · ` : '';
  const title = clip(`${head}${v.ticker || '—'}${v.structure ? ` — ${v.structure}` : ''}`, LIMITS.title);
  const description = clip([v.thesisTag ? `*${v.thesisTag}*` : '', v.thesis].filter(Boolean).join('\n'), LIMITS.description);

  const cat = [v.catalyst, discordTimestamps(v.catalystAt)].filter(Boolean).join(' · ');
  const alts = v.alts.slice(0, ALTS_MAX).map(a => `• ${a}`).join('\n');
  const altsMore = v.alts.length > ALTS_MAX ? `\n• +${v.alts.length - ALTS_MAX} more not shown` : '';
  const raw = [
    { name: 'Play', value: [v.play, v.side].filter(Boolean).join(' · '), inline: true },
    { name: 'Sector', value: v.sector, inline: true },
    { name: 'Expiry', value: v.expiry, inline: true },
    { name: 'Catalyst', value: cat },
    { name: 'Economics (per contract)', value: economics(v.metrics) },
    { name: 'Entry / trigger', value: v.entry },
    { name: 'Wrong if', value: v.invalidation },
    { name: 'Exit plan', value: v.exit },
    { name: 'Alternatives compared', value: alts ? alts + altsMore : '' },
  ];
  let fields = raw.filter(f => f.value).map(f => ({ name: clip(f.name, LIMITS.fieldName), value: clip(f.value, LIMITS.fieldValue), ...(f.inline ? { inline: true } : {}) }));
  if (fields.length > LIMITS.fields) {
    fields = fields.slice(0, LIMITS.fields);
    const last = fields[fields.length - 1];
    last.value = clip(`${last.value}\n${TRIM_MARK}`, LIMITS.fieldValue);
  }
  const footer = { text: clip([v.priceNote, 'Idea card, not a position'].filter(Boolean).join(' · '), LIMITS.footer) };

  const embed = { title, ...(description ? { description } : {}), color: colorFor(v.side), fields, footer,
                  timestamp: new Date(now).toISOString() };

  // THE 6,000 TOTAL. Cut the description first — it is the longest prose and the fields are the
  // decision — then fields from the last up, each to what still fits, each with the marker.
  let over = embedChars(embed) - LIMITS.total;
  if (over > 0 && embed.description) {
    const keep = Math.max(TRIM_MARK.length, embed.description.length - over);
    embed.description = clip(embed.description.endsWith(TRIM_MARK) ? embed.description.slice(0, -TRIM_MARK.length) : embed.description, keep);
    over = embedChars(embed) - LIMITS.total;
  }
  for (let i = embed.fields.length - 1; over > 0 && i >= 0; i--) {
    const f = embed.fields[i];
    const keep = Math.max(TRIM_MARK.length, f.value.length - over);
    if (keep < f.value.length) f.value = clip(f.value.endsWith(TRIM_MARK) ? f.value.slice(0, -TRIM_MARK.length) : f.value, keep);
    over = embedChars(embed) - LIMITS.total;
  }
  return embed;
}

// The message payload. No mentions are ever parsed: a thesis containing "@everyone" is text.
export const ideaPayload = (embed) => ({ embeds: [embed], allowed_mentions: { parse: [] } });

// What decides whether a card needs a PATCH: the rendered card without its timestamp, which is
// "now" on every build and would otherwise make every card look changed on every call.
export function cardHash(embed) {
  const { timestamp: _t, ...rest } = embed || {};
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 32);
}

// ── RECONCILE ────────────────────────────────────────────────────────────────
// `ideas` is the WHOLE desired set. `state` is the stored map idea id → { messageId, hash }.
// New ideas are posted (?wait=true, so the id comes back and can be kept), changed ones PATCHed,
// unchanged ones left alone, and cards whose idea left the set are DELETEd. A PATCH answered 404 —
// the message was deleted by hand — is re-posted rather than retried forever.
//
// Sequential on purpose, with a back-off on 429: 25 cards at once is how a webhook gets throttled.
// Never throws. A Discord failure is an entry in `errors` and the stored map keeps what it had, so
// the next call retries exactly that card.
//
// `send` is lib/discord.js `send` — injected so the test drives it without a network.
export async function reconcileIdeas(ideas, { webhook, state = {}, send, now = new Date(), sleep = (ms) => new Promise(r => setTimeout(r, ms)), retries = 2 } = {}) {
  const out = { posted: [], edited: [], deleted: [], unchanged: [], errors: [] };
  const map = {};
  for (const [k, v] of Object.entries(state && typeof state === 'object' ? state : {})) {
    if (v && typeof v === 'object' && v.messageId) map[k] = { messageId: String(v.messageId), hash: String(v.hash || '') };
  }

  const call = async (url, method, body) => {
    for (let a = 0; ; a++) {
      let r;
      try { r = await send(url, method, body); } catch { r = { ok: false, status: 0 }; }
      if (r?.status !== 429 || a >= retries) return r || { ok: false, status: 0 };
      await sleep(1000 * (a + 1));
    }
  };
  const create = async (payload) => {
    const r = await call(`${webhook}?wait=true`, 'POST', payload);
    return r.ok && r.json?.id ? String(r.json.id) : { status: r.status };
  };

  // Validate and dedupe. An idea without an id cannot be tracked, and a repeated id would be two
  // cards fighting over one slot — both are refused BY NAME, never dropped quietly.
  const list = Array.isArray(ideas) ? ideas : [];
  const seen = new Set();
  const valid = [];
  list.forEach((doc, i) => {
    const id = str(doc?.id).slice(0, 100);
    if (!id) { out.errors.push({ index: i, error: 'idea has no id' }); return; }
    if (seen.has(id)) { out.errors.push({ id, error: 'duplicate id in the set' }); return; }
    seen.add(id);
    valid.push({ id, doc });
  });
  // THE CAP. Ideas past the 25th are not processed this call — and are NOT treated as removed:
  // their cards stay, and each is named in errors.
  const work = valid.slice(0, MAX_IDEAS);
  for (const { id } of valid.slice(MAX_IDEAS)) out.errors.push({ id, error: `over the ${MAX_IDEAS}-idea cap — not processed this call` });

  for (const { id, doc } of work) {
    const embed = buildIdeaCard(doc, { now });
    const hash = cardHash(embed);
    const payload = ideaPayload(embed);
    const prev = map[id];
    if (prev && prev.hash === hash) { out.unchanged.push(id); continue; }
    if (prev) {
      const r = await call(`${webhook}/messages/${prev.messageId}`, 'PATCH', payload);
      if (r.ok) { map[id] = { messageId: prev.messageId, hash }; out.edited.push(id); continue; }
      if (r.status !== 404) { out.errors.push({ id, error: `edit failed (${r.status || 'network'})` }); continue; }
      // Gone by hand: post afresh below.
    }
    const created = await create(payload);
    if (typeof created === 'string') { map[id] = { messageId: created, hash }; out.posted.push(id); }
    else {
      if (prev) delete map[id];   // the old message is gone; nothing to keep pointing at
      out.errors.push({ id, error: `post failed (${created.status || 'network'})` });
    }
  }

  // Cards whose idea is no longer in the set. Ids refused above (over the cap) are still in `seen`
  // and so are kept.
  for (const id of Object.keys(map)) {
    if (seen.has(id)) continue;
    const r = await call(`${webhook}/messages/${map[id].messageId}`, 'DELETE');
    if (r.ok || r.status === 404) { delete map[id]; out.deleted.push(id); }
    else out.errors.push({ id, error: `delete failed (${r.status || 'network'})` });
  }

  return { ...out, state: map };
}
