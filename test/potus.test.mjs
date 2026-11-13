// test/potus.test.mjs — Trump's posts and schedule to the private channel (lib/potus.js,
// lib/routes/flow.js potusPostsOut / potusScheduleOut). Made-up posts and fake tickers only.
import { marketWhy, newPosts, postsCard, scheduleOf, scheduleCard } from '../lib/potus.js';
import { potusPostsOut, potusScheduleOut, POTUS_LAST_KEY, POTUS_SCHEDULE_POSTED_KEY } from '../lib/routes/flow.js';
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
eq('the source goes to the private channel', channelOf('potus'), 'private');

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
