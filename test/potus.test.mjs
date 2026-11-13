// test/potus.test.mjs — Trump's posts and schedule to the private channel (lib/potus.js,
// lib/routes/flow.js potusPostsOut / potusScheduleOut). Made-up posts and fake tickers only.
import { marketWhy, newPosts, postsCard, postsCards, scheduleOf, scheduleCard, DISCORD_EMBED_CHARS } from '../lib/potus.js';
import { potusPostsOut, potusScheduleOut, POTUS_LAST_KEY, POTUS_SCHEDULE_POSTED_KEY, POTUS_BACKFILL_KEY } from '../lib/routes/flow.js';
import { DESK_RULES_KEY } from '../lib/deskRules.js';
import { channelOf } from '../lib/alerts.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const memKv = () => { const m = new Map(); return { m, configured: () => true, get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); return true; } }; };

// ── what counts as market-relevant ──
eq('tariffs and a country', marketWhy('Tariffs on Mexico will be IMMEDIATELY DOUBLED'), ['tariffs', 'mexico']);
eq('a company by name, with its ticker', marketWhy('A Legend replaces a Legend at Nvidia'), ['nvidia (NVDA)']);
eq('a Desk ticker as a word or $ticker', marketWhy('Big news for $ZZQ and ZZR today', { tickers: ['ZZQ', 'ZZR', 'ZZS'] }), ['$ZZQ', '$ZZR']);
eq('purely political: nothing', marketWhy('Will they ever be prosecuted? What they did was a great violation!'), []);
eq('whole words only (no "oil" in "turmoil")', marketWhy('Political turmoil in the capital'), []);
eq('a ticker must be a whole word', marketWhy('ZZQX is not ZZQ-less', { tickers: ['ZZQX'] }), ['$ZZQX']);

// ── new posts since the mark ──
const answer = { data: [
  { timestamp: 3000, post: 'Oil prices are coming down, fast!' },
  { timestamp: 1000, post: 'old one about tariffs' },
  { timestamp: 2000, post: 'A great rally tonight!' },
] };
const np = newPosts(answer, { since: 1500 });
eq('only newer than the mark, oldest first', np.map(p => p.at), [2000, 3000]);
eq('each with its reasons', np.map(p => p.why), [[], ['oil']]);
const card = postsCard(np);
eq('the card carries only relevant posts', card.embeds.length, 1);
eq('post text in full, reasons in a field', [card.embeds[0].description, card.embeds[0].fields[0].value], ['Oil prices are coming down, fast!', 'oil']);
eq('private footer, no mentions', [/private channel only/.test(card.embeds[0].footer.text), card.allowed_mentions], [true, { parse: [] }]);
eq('nothing relevant: no card', postsCard([{ at: 1, text: 'rally', why: [] }]), null);
eq('the source goes to the Trump channel', channelOf('potus'), 'trump');

// Discord's 6,000-character cap per message: long posts are packed into several messages.
{
  const long = Array.from({ length: 6 }, (_, i) => ({ at: 1000 + i, text: `Tariffs ${'x'.repeat(2500)} ${i}`, why: ['tariffs'] }));
  const cards = postsCards(long);
  const chars = (c) => c.embeds.reduce((a, e) => a + e.title.length + e.description.length + e.footer.text.length + e.fields.reduce((b, f) => b + f.name.length + f.value.length, 0), 0);
  eq('long posts: split so no message passes the cap', [cards.length > 1, cards.every(c => chars(c) <= DISCORD_EMBED_CHARS)], [true, true]);
  eq('long posts: none lost, order kept', cards.flatMap(c => c.embeds.map(e => e.description.slice(-1))), ['0', '1', '2', '3', '4', '5']);
  eq('short posts: ten to a message at most', postsCards(Array.from({ length: 12 }, (_, i) => ({ at: i, text: 'oil', why: ['oil'] }))).map(c => c.embeds.length), [10, 2]);
}

// ── the schedule ──
const sched = scheduleOf({ data: [
  { type: 'President Schedule', date: '2030-01-03', time: '2030-01-03T14:00:00Z', details: 'In-Town Pool Call Time' },
  { type: 'President Schedule', date: '2030-01-03', time: '2030-01-03T18:30:00Z', location: 'Roosevelt Room', details: 'The President participates in an interview', coverage: 'Closed Press', url: 'https://example.invalid/t' },
  { type: 'President Schedule', date: '2030-01-03', time: '2030-01-03T16:00:00Z', details: 'The President receives his Intelligence Briefing' },
  { type: 'Pool Report Schedule', date: '2030-01-03', time: '2030-01-03T23:00:00Z', details: 'Travel/Photo lid called' },
  { type: 'President Schedule', date: '2030-01-02', time: '2030-01-02T16:00:00Z', details: 'Yesterday' },
] });
eq('the latest day, routine entries left out, in time order', [sched.day, sched.items.map(i => i.time.slice(11, 16))], ['2030-01-03', ['16:00', '18:30']]);
const sc = scheduleCard(sched);
eq('a field per entry, Dubai time first', sc.embeds[0].fields[1].name, '22:30 Dubai (13:30 ET) · Roosevelt Room');
eq('the transcript link rides along', /\[Transcript\]\(https:\/\/example\.invalid\/t\)/.test(sc.embeds[0].fields[1].value), true);
eq('"The President" trimmed', sc.embeds[0].fields[1].value.startsWith('participates in an interview'), true);
eq('empty schedule: no card', scheduleCard({ day: null, items: [] }), null);

// ── the jobs ──
const env = { DISCORD_PRIVATE_WEBHOOK: 'https://discord.com/api/webhooks/1/tok' };
const sent = []; const deliver = async (h, p) => { sent.push({ h, p }); return 'msg-1'; };
const kv = memKv(); kv.m.set(DESK_RULES_KEY, { positions: [], watch: ['ZZQ'] });
const get = async () => answer;
const first = await potusPostsOut({ kv, deliver, env, get });
eq('first run sets the mark and sends nothing', [first.first, sent.length, kv.m.get(POTUS_LAST_KEY).at], [true, 0, 3000]);
kv.m.set(POTUS_LAST_KEY, { at: 1500 });
const r = await potusPostsOut({ kv, deliver, env, get });
eq('then sends the relevant new post, privately', [r.sent, sent.length, sent[0]?.h], [1, 1, env.DISCORD_PRIVATE_WEBHOOK]);
eq('and moves the mark to the newest post seen', kv.m.get(POTUS_LAST_KEY).at, 3000);
eq('a quiet run sends nothing', (await potusPostsOut({ kv, deliver, env, get })).sent, 0);
const noHook = memKv(); noHook.m.set(POTUS_LAST_KEY, { at: 1500 });
eq('no private webhook: the mark holds, so nothing is lost', [(await potusPostsOut({ kv: noHook, deliver, env: {}, get })).ok, noHook.m.get(POTUS_LAST_KEY).at], [false, 1500]);

const sget = async () => ({ data: [{ type: 'President Schedule', date: '2030-01-03', time: '2030-01-03T18:30:00Z', details: 'The President participates in an interview' }] });
const s1 = await potusScheduleOut({ kv, deliver, env, get: sget });
eq('schedule: sent once', [s1.sent, kv.m.get(POTUS_SCHEDULE_POSTED_KEY)], [1, '2030-01-03']);
eq('schedule: never twice for the same day', (await potusScheduleOut({ kv, deliver, env, get: sget })).why, 'already sent');

// ── the Trump channel and its one-time backfill ──
{
  const tenv = { DISCORD_PRIVATE_WEBHOOK: 'https://discord.com/api/webhooks/1/priv', DISCORD_TRUMP_WEBHOOK: 'https://discord.com/api/webhooks/2/trump' };
  const now = new Date('2030-01-10T12:00:00Z');
  const day = 86400000;
  const week = { data: [
    ...Array.from({ length: 12 }, (_, i) => ({ timestamp: now.getTime() - (i + 1) * 3600000, post: `Tariffs update number ${i}` })),
    { timestamp: now.getTime() - 2 * day, post: 'A great rally tonight!' },
    { timestamp: now.getTime() - 9 * day, post: 'Old tariffs post, outside the week' },
  ] };
  const tsent = []; const tdeliver = async (h, p) => { tsent.push({ h, n: p.embeds.length }); return 'msg'; };
  const tkv = memKv(); tkv.m.set(POTUS_LAST_KEY, { at: 1 });
  const b = await potusPostsOut({ kv: tkv, deliver: tdeliver, env: tenv, now, get: async () => week });
  eq('backfill: the past week\'s relevant posts, packed into messages', [b.backfill, tsent.map(x => x.n)], [12, [10, 2]]);
  eq('backfill: to the Trump channel', tsent.every(x => x.h === tenv.DISCORD_TRUMP_WEBHOOK), true);
  eq('backfill: once, and the mark moves to the newest post', [!!tkv.m.get(POTUS_BACKFILL_KEY), tkv.m.get(POTUS_LAST_KEY).at], [true, now.getTime() - 3600000]);
  const again = await potusPostsOut({ kv: tkv, deliver: tdeliver, env: tenv, now, get: async () => week });
  eq('backfill: never twice', [again.backfill, again.sent, tsent.length], [undefined, 0, 2]);
  const sk = memKv();
  await potusScheduleOut({ kv: sk, deliver: tdeliver, env: tenv, get: async () => ({ data: [{ type: 'President Schedule', date: '2030-01-10', time: '2030-01-10T18:30:00Z', details: 'The President participates in an interview' }] }) });
  eq('the schedule goes to the Trump channel too', tsent.at(-1).h, tenv.DISCORD_TRUMP_WEBHOOK);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
