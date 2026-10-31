// test/ideacard.test.mjs — one Discord card per selected trade idea (lib/ideacard.js) and its
// door (/api/ideas-card → api/tradecard.js ?card=ideas).
//
// The assertion that matters most is the first block: an idea doc arrives carrying private
// bookkeeping — taken, ladder, planned R, a note, the outcome — and none of it may reach Discord.
// Sentinels are distinctive so a leak cannot hide inside an ordinary-looking number.
import { buildIdeaCard, publicIdea, colorFor, discordTimestamps, clip, economics, cardHash, reconcileIdeas, ideaPayload,
         COLORS, LIMITS, TRIM_MARK, MAX_IDEAS, IDEA_FIELDS, parseAlerts, alertPayload, MAX_ALERTS } from '../lib/ideacard.js';
import { hasIdeasToken, hasServiceKey, IDEAS_TOKEN_ENV, IDEAS_TOKEN_HEADER, SERVICE_KEY_ENVS, JOURNAL_READ_ENV } from '../lib/apiauth.js';
import { ideasCard } from '../api/tradecard.js';
import { ideasMentionFromEnv } from '../lib/discord.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const NOW = new Date('2026-10-22T08:00:00Z');
const base = {
  id: 'idea-1', ticker: 'NVDA', structure: '27 Nov 190/210 call spread', thesisTag: 'AI capex re-rate',
  thesis: 'Hyperscaler guides keep rising into the print.', play: 'Event', sector: 'Semis', side: 'Bullish', rank: 1,
  catalyst: 'Q3 earnings', catalystAt: '2026-11-19T21:20:00Z', entry: 'Below 182 on a flush', invalidation: 'Close under 170',
  exit: 'Half at 2R, rest into the print', expiry: '2026-11-27', alts: ['Long call', 'Put spread', 'Calendar', 'Diagonal', 'Stock'],
  priceNote: 'Priced 21 Oct close', status: 'selected',
  metrics: { kind: 'debit', cost: 6.4, maxGain: 13.6, rr: 2.13, oddsProfit: 38, breakeven: 196.4, ev: 0.85 },
};

// ── THE WHITELIST ────────────────────────────────────────────────────────────
{
  const stuffed = { ...base,
    taken: 'SENTINEL_TAKEN_ZQX', takenAt: '1999-01-02T03:04:05Z', ladder: [{ contracts: 987654, price: 31337.77 }],
    plannedR: 424242.5, note: 'SENTINEL_NOTE_PRIVATE', outcome: { pnl: 8675309, text: 'SENTINEL_OUTCOME' },
    discord: 'SENTINEL_DISCORD', created: 'SENTINEL_CREATED', updated: 'SENTINEL_UPDATED', order: { qty: 55501 },
    size: 77123, contracts: 66231, metrics: { ...base.metrics, contracts: 44312, size: 99887766 } };
  const s = JSON.stringify(buildIdeaCard(stuffed, { now: NOW }));
  const sentinels = ['SENTINEL_TAKEN_ZQX', '1999-01-02', '987654', '31337', '424242', 'SENTINEL_NOTE_PRIVATE', '8675309',
    'SENTINEL_OUTCOME', 'SENTINEL_DISCORD', 'SENTINEL_CREATED', 'SENTINEL_UPDATED', '55501', '77123', '66231', '44312', '99887766'];
  eq('a doc stuffed with private fields leaks none of them', sentinels.filter(t => s.includes(t)), []);
  eq('the projection carries only whitelisted keys', Object.keys(publicIdea(stuffed)).sort(), [...IDEA_FIELDS, 'metrics', 'card'].sort());
  ok('and none of the private names', !['taken', 'takenAt', 'ladder', 'plannedR', 'note', 'outcome', 'order'].some(k => k in publicIdea(stuffed)));
  // An object smuggled into a whitelisted key is not dumped.
  const smuggled = JSON.stringify(buildIdeaCard({ ...base, entry: { contracts: 13579 } }, { now: NOW }));
  ok('an object in a whitelisted key is not rendered', !smuggled.includes('13579'));
}

// ── THE CARD ─────────────────────────────────────────────────────────────────
{
  const e = buildIdeaCard(base, { now: NOW });
  eq('title: no rank', e.title, '🟢 NVDA · 27 Nov 190/210 call spread');
  eq('description: play · side · sector in bold, tag in italics, then the thesis', e.description, '**⚡ Event · Bullish · Semis**\n*AI capex re-rate*\nHyperscaler guides keep rising into the print.');
  eq('fields in order', e.fields.map(f => f.name), ['📅 Catalyst', '⏳ Expiry', '📊 Numbers (per contract)', '🎯 Trigger', '❌ Wrong if', '🏁 Exit', '🔀 Alternatives compared']);
  eq('inline on the first two only', e.fields.map(f => !!f.inline), [true, true, false, false, false, false, false]);
  eq('debit economics on one line', e.fields[2].value, 'Cost 6.4 · Max gain 13.6 · R:R 2.13 · Odds of profit 38% · Breakeven 196.4 · EV 0.85');
  eq('up to four alternatives, the rest counted', e.fields[6].value, '• Long call\n• Put spread\n• Calendar\n• Diagonal\n• +1 more not shown');
  eq('footer', e.footer.text, 'Priced 21 Oct close · Idea card, not a position');
  eq('timestamp is now', e.timestamp, NOW.toISOString());
  const sparse = buildIdeaCard({ id: 'x', ticker: 'SPY', structure: 'Put', side: 'Bearish' }, { now: NOW });
  eq('empty fields are skipped', [sparse.title, sparse.description, sparse.fields.map(f => f.name)], ['🔴 SPY · Put', '**Bearish**', []]);
  eq('credit economics', economics({ kind: 'credit', cost: 3.1, rr: 0.48, oddsNeeded: 68, oddsEst: 74, ev: 0.22 }),
     'Risk/credit 3.1 · R:R 0.48 · Needs 68% vs est. 74% · EV 0.22');
  eq('unknown kind → no economics', economics({ kind: 'mystery', cost: 1 }), '');
  ok('mentions are never parsed', JSON.stringify(ideaPayload(e).allowed_mentions) === '{"parse":[]}');
}


// ── THE SHORT CARD (`card`) ──────────────────────────────────────────────────
{
  const withCard = { ...base, card: { thesis: 'Short thesis.', trigger: 'Short trigger.', wrong: 'Short wrong.', exit: 'Short exit.',
    alts: ['Alt one', 'Alt two', 'Alt three'], plannedR: 'SENTINEL_CARD_R' }, rank: 7 };
  const e = buildIdeaCard(withCard, { now: NOW });
  ok('card thesis replaces the long one', e.description.endsWith('Short thesis.') && !e.description.includes('Hyperscaler'));
  eq('card fields win', ['🎯 Trigger', '❌ Wrong if', '🏁 Exit'].map(n => e.fields.find(f => f.name === n).value), ['Short trigger.', 'Short wrong.', 'Short exit.']);
  eq('at most two alternatives, no counter', e.fields.find(f => f.name === '🔀 Also considered').value, '• Alt one\n• Alt two');
  ok('rank never reaches the card', !JSON.stringify(e).includes('#7'));
  ok('unknown keys inside card are dropped', !JSON.stringify(e).includes('SENTINEL_CARD_R') && !('plannedR' in publicIdea(withCard).card));
  const smug = buildIdeaCard({ ...base, card: { trigger: { contracts: 24680 } } }, { now: NOW });
  ok('an object inside card is not rendered; falls back to entry', !JSON.stringify(smug).includes('24680') && smug.fields.find(f => f.name === '🎯 Trigger').value === base.entry);
  eq('card: an array is ignored', publicIdea({ ...base, card: ['x'] }).card, null);
}

eq('side emoji per class', ['Long', 'Short', 'Short vol', 'Neutral'].map(x => buildIdeaCard({ ticker: 'X', side: x }, { now: NOW }).title.split(' ')[0]), ['🟢', '🔴', '🟡', '⚪']);
ok('thesis play gets the compass', buildIdeaCard({ ticker: 'X', play: 'Thesis' }, { now: NOW }).description.startsWith('**🧭 Thesis'));

// ── COLOUR ───────────────────────────────────────────────────────────────────
eq('Bullish → green', colorFor('Bullish'), COLORS.bull);
eq('Long → green', colorFor('Long'), COLORS.bull);
eq('Bearish → red', colorFor('Bearish'), COLORS.bear);
eq('Short → red', colorFor('short'), COLORS.bear);
eq('vol → amber', colorFor('Short vol'), COLORS.vol);
eq('Long vol is a vol play, not a bull one', colorFor('Long vol'), COLORS.vol);
eq('anything else → grey', colorFor('Neutral'), COLORS.neutral);
eq('missing → grey', colorFor(undefined), COLORS.neutral);
eq('the hex values', [COLORS.bull, COLORS.bear, COLORS.vol, COLORS.neutral], [0x2E9E6A, 0xC8463A, 0xD9A94A, 0x8A93A1]);

// ── DISCORD TIMESTAMPS ───────────────────────────────────────────────────────
eq('<t:UNIX:F> and <t:UNIX:R>', discordTimestamps('2026-11-19T21:20:00Z'), '<t:1795123200:F> (<t:1795123200:R>)');
eq('an unparseable time renders nothing', discordTimestamps('next week'), null);
eq('catalyst field carries text and stamps', buildIdeaCard(base, { now: NOW }).fields[0].value, 'Q3 earnings · <t:1795123200:F> (<t:1795123200:R>)');

// ── NOTHING IS SILENTLY TRUNCATED ────────────────────────────────────────────
{
  eq('clip under the cap is untouched', clip('abc', 10), 'abc');
  const c = clip('x'.repeat(50), 20);
  ok('clip ends with the visible marker', c.endsWith(TRIM_MARK) && c.length === 20);
  const big = buildIdeaCard({ ...base, structure: 'S'.repeat(400), thesis: 'T'.repeat(5000), entry: 'E'.repeat(2000),
    invalidation: 'I'.repeat(2000), exit: 'X'.repeat(2000) }, { now: NOW });
  ok('title capped at 256 with marker', big.title.length <= LIMITS.title && big.title.endsWith(TRIM_MARK));
  ok('description within 4096 with marker', big.description.length <= LIMITS.description && big.description.endsWith(TRIM_MARK));
  ok('every field value within 1024', big.fields.every(f => f.value.length <= LIMITS.fieldValue));
  ok('a cut field shows the marker', big.fields.find(f => f.name === '🎯 Trigger').value.endsWith(TRIM_MARK));
  const total = big.title.length + big.description.length + big.footer.text.length + big.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  ok(`total within 6000 (${total})`, total <= LIMITS.total);
  ok('fields within 25', big.fields.length <= LIMITS.fields);
  const fine = buildIdeaCard(base, { now: NOW });
  ok('an ordinary card carries no marker', !JSON.stringify(fine).includes(TRIM_MARK));
}

// ── RECONCILE ────────────────────────────────────────────────────────────────
// A mocked Discord: records every call, hands out message ids, answers what the script says.
const WEBHOOK = 'https://discord.com/api/webhooks/123456789/test-token-not-real';
function mockDiscord(script = {}, start = 1000) {
  const calls = [];
  let n = start;
  const send = async (url, method, body) => {
    const path = url.replace(WEBHOOK, '');
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    if (script[key]?.length) return script[key].shift();
    if (method === 'POST') return { ok: true, status: 200, json: { id: String(++n) } };
    return { ok: true, status: method === 'DELETE' ? 204 : 200, json: null };
  };
  return { send, calls };
}
const sleeps = [];
const sleep = async (ms) => { sleeps.push(ms); };

{
  const d = mockDiscord();
  const a = { ...base, id: 'a' }, b = { ...base, id: 'b', ticker: 'AMD', rank: 2 };
  const r1 = await reconcileIdeas([a, b], { webhook: WEBHOOK, state: {}, send: d.send, now: NOW, sleep });
  eq('first run posts both', [r1.posted, r1.edited, r1.deleted, r1.unchanged, r1.errors], [['a', 'b'], [], [], [], []]);
  ok('posted with ?wait=true', d.calls.every(c => c.method === 'POST' && c.path === '?wait=true'));
  eq('message ids kept in state', Object.fromEntries(Object.entries(r1.state).map(([k, v]) => [k, v.messageId])), { a: '1001', b: '1002' });

  const d2 = mockDiscord();
  const r2 = await reconcileIdeas([a, { ...b, entry: 'Above 160 on volume' }], { webhook: WEBHOOK, state: r1.state, send: d2.send, now: new Date('2026-10-23T00:00:00Z'), sleep });
  eq('second run: a unchanged (a later timestamp alone is no change), b edited', [r2.posted, r2.edited, r2.unchanged], [[], ['b'], ['a']]);
  eq('the edit is a PATCH to the stored message', d2.calls.map(c => `${c.method} ${c.path}`), ['PATCH /messages/1002']);

  const d3 = mockDiscord();
  const r3 = await reconcileIdeas([a], { webhook: WEBHOOK, state: r2.state, send: d3.send, now: NOW, sleep });
  eq('an idea leaving the set is deleted', [r3.deleted, r3.unchanged, Object.keys(r3.state)], [['b'], ['a'], ['a']]);
  eq('by DELETE on its message', d3.calls.map(c => `${c.method} ${c.path}`), ['DELETE /messages/1002']);

  // Deleted by hand: the PATCH answers 404 and the card is re-posted.
  const d4 = mockDiscord({ 'PATCH /messages/1001': [{ ok: false, status: 404 }] }, 2000);
  const r4 = await reconcileIdeas([{ ...a, thesis: 'changed' }], { webhook: WEBHOOK, state: r3.state, send: d4.send, now: NOW, sleep });
  eq('a 404 on edit re-posts', [r4.posted, r4.edited, r4.errors], [['a'], [], []]);
  ok('and the new id replaces the old', r4.state.a.messageId !== '1001');

  // An outage: nothing throws, the error is named, the stored entry is kept for the next call.
  const d5 = mockDiscord({ 'PATCH /messages/1001': [{ ok: false, status: 500 }] });
  const r5 = await reconcileIdeas([{ ...a, thesis: 'changed again' }], { webhook: WEBHOOK, state: r3.state, send: d5.send, now: NOW, sleep });
  eq('a 500 on edit is an error, not a throw', r5.errors, [{ id: 'a', error: 'edit failed (500)' }]);
  eq('and the old entry is kept so the next call retries', r5.state.a, r3.state.a);
  const r5b = await reconcileIdeas([a], { webhook: WEBHOOK, state: {}, send: async () => { throw new Error('boom'); }, now: NOW, sleep });
  eq('a throwing transport is caught', r5b.errors, [{ id: 'a', error: 'post failed (network)' }]);

  // 429: back off and retry.
  sleeps.length = 0;
  const d6 = mockDiscord({ 'POST ?wait=true': [{ ok: false, status: 429 }] });
  const r6 = await reconcileIdeas([a], { webhook: WEBHOOK, state: {}, send: d6.send, now: NOW, sleep });
  eq('a 429 is retried after a delay', [r6.posted, d6.calls.length, sleeps.length > 0], [['a'], 2, true]);

  // The cap: past 25 not processed, NOT deleted, and named.
  const many = Array.from({ length: MAX_IDEAS + 2 }, (_, i) => ({ ...base, id: `i${i}` }));
  const prior = { i26: { messageId: '777', hash: 'old' } };
  const d7 = mockDiscord();
  const r7 = await reconcileIdeas(many, { webhook: WEBHOOK, state: prior, send: d7.send, now: NOW, sleep });
  eq('cap: 25 posted', r7.posted.length, MAX_IDEAS);
  eq('the rest named in errors', r7.errors.map(e => e.id), ['i25', 'i26']);
  ok('and their cards are not deleted', !r7.deleted.includes('i26') && r7.state.i26?.messageId === '777');

  const r8 = await reconcileIdeas([{ ...a }, { ...a }, { ticker: 'NOID' }], { webhook: WEBHOOK, state: {}, send: mockDiscord().send, now: NOW, sleep });
  eq('duplicates and missing ids are refused by name', r8.errors, [{ id: 'a', error: 'duplicate id in the set' }, { index: 2, error: 'idea has no id' }]);
  ok('the hash ignores the timestamp', cardHash(buildIdeaCard(a, { now: NOW })) === cardHash(buildIdeaCard(a, { now: new Date(0) })));
}

// ── THE DOOR ─────────────────────────────────────────────────────────────────
// Save, set, assert, restore — the suite must give the same answer with the deployment's variables
// set or unset (scripts/check-env-independent.mjs).
const ENVS = [IDEAS_TOKEN_ENV, 'JOURNAL_INBOX_TOKEN', JOURNAL_READ_ENV, ...SERVICE_KEY_ENVS];
const saved = Object.fromEntries(ENVS.map(n => [n, process.env[n]]));
for (const n of ENVS) delete process.env[n];
const IDEAS = 'ideas-token-for-test-0123456789';
const JOURNAL = 'journal-token-for-test-9876543210';
const SERVICE = 'service-key-for-test-55555555555';

const mkRes = () => {
  const r = { code: null, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const memKv = (initial = null) => {
  const store = { v: initial, locked: false };
  return { store, kv: { get: async () => store.v, set: async (_k, v) => { store.v = v; return true; }, lock: async () => !store.locked && (store.locked = true),
    unlock: async () => { store.locked = false; return true; }, configured: () => true } };
};
const call = async (headers, body = { ideas: [] }, opts = {}) => {
  const res = mkRes();
  const { kv } = opts.kv || memKv();
  await ideasCard({ method: 'POST', headers, query: { card: 'ideas' }, body }, res, { webhook: WEBHOOK, kv, sender: mockDiscord().send, ...opts, ...(opts.kv ? { kv: opts.kv.kv } : {}) });
  return res;
};
try {
  eq('unset token: nobody gets in', (await call({ [IDEAS_TOKEN_HEADER]: 'anything' })).code, 401);
  process.env[IDEAS_TOKEN_ENV] = IDEAS;
  process.env.JOURNAL_INBOX_TOKEN = JOURNAL;
  process.env.TRADECARD_KEY = SERVICE;
  eq('missing token refused', (await call({})).code, 401);
  eq('wrong token refused', (await call({ [IDEAS_TOKEN_HEADER]: IDEAS.slice(0, -1) + 'X' })).code, 401);
  eq('the journal token refused', (await call({ [IDEAS_TOKEN_HEADER]: JOURNAL })).code, 401);
  eq('the service key refused, in any header', (await call({ [IDEAS_TOKEN_HEADER]: SERVICE, 'x-tradecard-key': SERVICE, 'x-api-key': SERVICE })).code, 401);
  eq('a session cookie is not consulted', (await call({ cookie: 'mwd_auth=v1.9999999999.deadbeef' })).code, 401);
  ok('the ideas token is not a service key', !hasServiceKey({ headers: { 'x-tradecard-key': IDEAS }, query: {} }));
  process.env.JOURNAL_INBOX_TOKEN = IDEAS;
  ok('an ideas token configured equal to another credential opens nothing', !hasIdeasToken({ headers: { [IDEAS_TOKEN_HEADER]: IDEAS } }));
  process.env.JOURNAL_INBOX_TOKEN = JOURNAL;
  ok('the right token passes', hasIdeasToken({ headers: { [IDEAS_TOKEN_HEADER]: IDEAS } }));

  const good = { [IDEAS_TOKEN_HEADER]: IDEAS };
  eq('no webhook: 200, ok false, nothing posted', (await call(good, { ideas: [base] }, { webhook: null })).body, { ok: false, reason: 'no webhook' });
  eq('a body without ideas is a 400', (await call(good, { nope: 1 })).code, 400);
  const res405 = mkRes();
  await ideasCard({ method: 'GET', headers: good, query: {} }, res405, { webhook: WEBHOOK, kv: memKv().kv, sender: mockDiscord().send });
  eq('GET is refused', res405.code, 405);

  const m = memKv();
  const r = await call(good, { ideas: [{ ...base, id: 'z', taken: true, ladder: [1, 2] }] }, { kv: m });
  eq('a sync answers the contract', [r.code, r.body], [200, { ok: true, posted: ['z'], edited: [], deleted: [], unchanged: [], errors: [] }]);
  eq('the stored map holds ids and hashes only', Object.keys(m.store.v.cards.z).sort(), ['hash', 'messageId']);
  const again = await call(good, { ideas: [{ ...base, id: 'z' }] }, { kv: m });
  eq('re-sent unchanged (private fields never affected the card)', again.body.unchanged, ['z']);
  const gone = await call(good, { ideas: [] }, { kv: m });
  eq('an empty set deletes', gone.body.deleted, ['z']);
  ok('the lock is released after a run', m.store.locked === false);
  m.store.locked = true;
  eq('an overlapping run is refused, not doubled', (await call(good, { ideas: [base] }, { kv: m })).body.reason, 'busy — another ideas sync is running');
  m.store.locked = false;

  // ── TRIGGER ALERTS ──
  const a = memKv({ cards: { xsw: { messageId: '1234567890', hash: 'h' } } });
  const posts = [];
  const notifier = async (_w, payload) => { posts.push(payload); return String(9000000 + posts.length); };
  const info = async () => ({ guildId: '111111', channelId: '222222' });
  const al = await call(good, { alerts: [{ id: 'xsw', text: 'XSW ÷ SOXX closed 0.4410, at or below 0.4415' }] }, { kv: a, notifier, info, mention: '333333' });
  eq('alerts-only call: posted, cards untouched', [al.body.alerted, al.body.deleted, al.body.ok], [['xsw'], [], true]);
  ok('alert pings the owner and links the card', /<@333333>/.test(posts[0].content) && /discord\.com\/channels\/111111\/222222\//.test(posts[0].content));
  eq('only the owner can be mentioned', posts[0].allowed_mentions, { parse: [], users: ['333333'] });
  ok('the card survives an alerts-only call', !!a.store.v.cards.xsw);
  const dup = await call(good, { alerts: [{ id: 'xsw', text: 'XSW ÷ SOXX closed 0.4410, at or below 0.4415' }] }, { kv: a, notifier, info, mention: '333333' });
  eq('the same alert twice pings once', [dup.body.alerted, dup.body.skipped, posts.length], [[], ['xsw'], 1]);
  const priv = await call(good, { alerts: [{ id: 'xsw', text: 'filled 3 contracts at 4.10' }, { id: 'q', text: 'sized 1.5R' }] }, { kv: a, notifier, info });
  eq('alerts that read like size or fills are refused by name', [priv.body.alerted, priv.body.errors.length, posts.length], [[], 2, 1]);
  eq('the cap', parseAlerts(Array.from({ length: MAX_ALERTS + 2 }, (_, i) => ({ id: 'i' + i, text: 'level hit ' + i }))).alerts.length, MAX_ALERTS);
  eq('no mention configured: no ping', alertPayload({ text: 't' }).allowed_mentions, { parse: [], users: [] });
  eq('idea alerts read their own mention, not the trade alerts\' one', [ideasMentionFromEnv({ DISCORD_USER_ID: '444444' }), ideasMentionFromEnv({ DISCORD_IDEAS_USER_ID: '555555' })], [null, '555555']);
  eq('a body with neither ideas nor alerts is a 400', (await call(good, { alerts: [] })).code, 400);
} finally {
  for (const n of ENVS) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
