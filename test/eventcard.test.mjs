// test/eventcard.test.mjs — macro event cards (lib/eventcard.js) and their door
// (/api/event-card → api/tradecard.js ?card=event): post once, edit in place, never a second message.
import { parseUpsert, eventPayload, cardHash, roleFromEnv } from '../lib/eventcard.js';
import { eventCard } from '../api/tradecard.js';
import { IDEAS_TOKEN_ENV, IDEAS_TOKEN_HEADER } from '../lib/apiauth.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const good = { action: 'upsert', id: 'fomc-2026-10-28', heading: 'FOMC — Wednesday 28 October 2026', text: 'Decision 2:00pm ET.', image_b64: PNG.toString('base64') };

// ── VALIDATION ───────────────────────────────────────────────────────────────
eq('a good body parses', parseUpsert(good).ok, true);
eq('bad id refused', parseUpsert({ ...good, id: 'FOMC 28 Oct' }).ok, false);
eq('missing heading refused', parseUpsert({ ...good, heading: '' }).ok, false);
eq('non-PNG refused', parseUpsert({ ...good, image_b64: Buffer.from('GIF89a----').toString('base64') }).error, 'image is not a PNG');
eq('text is capped', parseUpsert({ ...good, text: 'x'.repeat(5000) }).card.text.length, 600);

// ── PAYLOAD ──────────────────────────────────────────────────────────────────
const c = parseUpsert(good).card;
eq('heading, role ping, text in that order', eventPayload(c, { roleId: '123456789' }).content, '## FOMC — Wednesday 28 October 2026\n<@&123456789>\nDecision 2:00pm ET.');
eq('only the role may be pinged', eventPayload(c, { roleId: '123456789' }).allowed_mentions, { parse: [], roles: ['123456789'] });
eq('no role → no ping line', eventPayload(c).content, '## FOMC — Wednesday 28 October 2026\nDecision 2:00pm ET.');
eq('role id must be numeric', roleFromEnv({ DISCORD_EVENTS_ROLE_ID: '@Gayros' }), null);
eq('hash changes with the picture', cardHash(c) === cardHash({ ...c, bytes: Buffer.concat([c.bytes, Buffer.from([9])]) }), false);

// ── THE DOOR: post, unchanged, edit in place, re-post when gone, delete ──────
process.env[IDEAS_TOKEN_ENV] = 'tok-events-test-0123456789';
const mkReq = (body, token = 'tok-events-test-0123456789') => ({ method: 'POST', body, headers: { [IDEAS_TOKEN_HEADER]: token }, query: { card: 'event' } });
const mkRes = () => { const r = { code: 0, json: null, headers: {} }; r.status = (c) => { r.code = c; return r; }; r.json = (j) => { r.body = j; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; };
const store = {};
const kv = { configured: () => true, get: async (k) => store[k] ?? null, set: async (k, v) => { store[k] = v; return true; }, lock: async () => true, unlock: async () => true };
const calls = [];
let gone = false;
const deps = {
  webhook: 'https://discord.com/api/webhooks/1/abc', roleId: '42424242', kv,
  poster: async (_w, p) => { calls.push(['post', p.content]); return `m${calls.length}`; },
  editor: async (_w, id) => { calls.push(['edit', id]); return gone ? { ok: false, gone: true } : { ok: true, gone: false }; },
  remover: async (_w, id) => { calls.push(['delete', id]); return true; },
};
const run = async (body, token) => { const res = mkRes(); await eventCard(mkReq(body, token), res, deps); return res.body; };

eq('wrong token refused', (await run(good, 'nope')).ok ?? false, false);
eq('first upload posts', (await run(good)).result, 'posted');
eq('same upload is unchanged', (await run(good)).result, 'unchanged');
const img2 = Buffer.concat([PNG, Buffer.from([7])]).toString('base64');
eq('new picture edits the same message', (await run({ ...good, image_b64: img2 })).result, 'edited');
eq('…and it edited m1', calls.at(-1), ['edit', 'm1']);
gone = true;
eq('a deleted message is re-posted', (await run({ ...good, text: 'Refreshed.' })).result, 'posted');
gone = false;
eq('list shows the card, no content', (await run({ action: 'list' })).cards.map(x => x.id), ['fomc-2026-10-28']);
eq('delete removes it', (await run({ action: 'delete', id: 'fomc-2026-10-28' })).deleted, true);
eq('list is empty after', (await run({ action: 'list' })).cards, []);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
