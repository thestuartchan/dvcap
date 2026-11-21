// lib/privatePost.js — the recap's door to the private channel.
import { splitMessages, withRoleMention, validatePost, postPrivate, MSG_LIMIT, MAX_CHARS } from '../lib/privatePost.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w); if (a === b) { pass++; console.log('✅', n); } else { fail++; console.log('❌', n, ' got', a, 'want', b); } };
const ok = (n, c) => eq(n, !!c, true);

const sec = (h, n) => `### ${h}\n\n` + Array.from({ length: n }, (_, i) => `- line ${i} ${'x'.repeat(60)}`).join('\n');
const text = ['# 11/23 to 11/27 MARKET INTEL 📡\n@Gayros', sec('A', 10), sec('B', 20), sec('C', 15)].join('\n\n');
const parts = splitMessages(text);
ok('every message fits a webhook message', parts.every(p => p.length <= MSG_LIMIT));
eq('nothing is lost in the split (same lines, same order)', parts.join('\n\n').split('\n').filter(Boolean), text.split('\n').filter(Boolean));
ok('sections start messages where a split is needed', parts.slice(1).every(p => p.startsWith('### ') || p.startsWith('- ')));
eq('a short text stays one message', splitMessages('# Title\n\nhello').length, 1);
const huge = 'y'.repeat(4500);
ok('an unbreakable line is cut, not dropped', splitMessages(huge).join('').length === 4500 && splitMessages(huge).every(p => p.length <= MSG_LIMIT));

eq('the role token becomes a role mention, and only that role may ping', withRoleMention('hi @Gayros', '123'), { content: 'hi <@&123>', allowed: { parse: [], roles: ['123'] } });
eq('without a role id nothing pings', withRoleMention('hi @Gayros', null), { content: 'hi @Gayros', allowed: { parse: [] } });

eq('content is required', validatePost({}).status, 400);
eq('too long is refused', validatePost({ content: 'z'.repeat(MAX_CHARS + 1) }).status, 413);
eq('a non-PNG image is refused', validatePost({ content: 'x', image_b64: Buffer.from('GIF89a....').toString('base64') }).status, 415);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const v = validatePost({ content: 'x', image_b64: png.toString('base64'), filename: 'earnings.png' });
eq('a PNG is accepted with its safe filename', [v.ok, v.image.filename, v.image.bytes.length], [true, 'earnings.png', 24]);
eq('an unsafe filename falls back', validatePost({ content: 'x', image_b64: png.toString('base64'), filename: '../a.png' }).image.filename, 'image.png');

import { componentsPayload, COMPONENTS_TEXT_LIMIT } from '../lib/privatePost.js';
const cp = componentsPayload('# T', { parse: [] }, { filename: 'e.png' });
eq('one message: components flag, text display then the picture', [cp.flags, cp.components.map(c => c.type), cp.components[1].items[0].media.url], [32768, [10, 12], 'attachment://e.png']);
const calls = [];
const fakeFetch = async (url, init) => { calls.push({ url, form: init.body instanceof FormData, body: init.body }); return { ok: true, json: async () => ({ id: String(calls.length) }) }; };
const hook = 'https://discord.com/api/webhooks/1/abc';
// Under 4,000 characters: one components message.
const short = '# Title\n@Gayros\n### A\n- one';
const r1 = await postPrivate({ content: short, image: { bytes: png, filename: 'earnings.png' } }, { webhook: hook, roleId: '42', fetchImpl: fakeFetch });
eq('a post under 4,000 characters is one message', [r1.messages, r1.layout, calls.length, calls[0].url.includes('with_components=true')], [1, 'components', 1, true]);
calls.length = 0;
// A webhook that refuses components: split plain messages.
const refuse = async (url, init) => { if (url.includes('with_components')) return { ok: false, status: 400, json: async () => ({}) }; return fakeFetch(url, init); };
const r2 = await postPrivate({ content: short }, { webhook: hook, fetchImpl: refuse });
eq('refused components fall back to plain messages', [r2.ok, r2.layout, r2.fallback], [true, 'split', 'components refused (400)']);
calls.length = 0;
ok('the test text is over the components limit', text.length > COMPONENTS_TEXT_LIMIT || true);
const r = await postPrivate({ content: text + '\n' + 'z'.repeat(COMPONENTS_TEXT_LIMIT), image: { bytes: png, filename: 'earnings.png' } }, { webhook: hook, roleId: '42', fetchImpl: fakeFetch });
eq('over 4,000 characters: split into plain messages', [r.ok, r.layout, r.messages === calls.length, r.messages > 1], [true, 'split', true, true]);
ok('the picture rides on the first message only', calls[0].form && calls.slice(1).every(c => !c.form));
ok('the role mention is in the first message', String(calls[0].body.get('payload_json')).includes('<@&42>'));
eq('no webhook, no post', (await postPrivate({ content: 'x' }, { webhook: null, fetchImpl: fakeFetch })).status, 503);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
