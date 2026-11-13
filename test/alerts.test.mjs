// test/alerts.test.mjs — the one alert module (lib/alerts.js): one channel policy, one send path, one
// log where every line names its rule, and the rule list the Rules & Alerts page shows. Fake tickers.
import { readFileSync } from 'node:fs';
import { SOURCES, CHANNELS, channelOf, webhookFor, sendAlert, logLines, appendLog, logView, deskRuleRows, consoleRuleRows, ruleList, channelView, ALERT_LOG_KEY, ALERT_LOG_MAX } from '../lib/alerts.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

const HOOK = (n) => `https://discord.com/api/webhooks/${n}/tok-${n}`;
const env = { DISCORD_PRIVATE_WEBHOOK: HOOK(1), DISCORD_TRADES_WEBHOOK: HOOK(2), DISCORD_IDEAS_WEBHOOK: HOOK(3) };
const memKv = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); return true; } }; };

// ── Policy ──
eq('book and ops alerts go to the private channel', ['desk', 'job'].map(channelOf), ['private', 'private']);
eq('Unusual Whales flow goes to the private channel only (personal-use licence)', channelOf('flow'), 'private');
eq('console levels and the statement note keep the trades channel', ['console', 'statement'].map(channelOf), ['trades', 'trades']);
eq('idea triggers keep the ideas channel', channelOf('idea'), 'ideas');
eq('every source names a channel that exists', Object.values(SOURCES).every(s => CHANNELS[s.channel]), true);
eq('a channel resolves to its own webhook', ['private', 'trades', 'ideas'].map(c => webhookFor(c, env)), [HOOK(1), HOOK(2), HOOK(3)]);
eq('a value that is not a Discord webhook is no webhook', webhookFor('private', { DISCORD_PRIVATE_WEBHOOK: 'https://example.com/x' }), null);
eq('the page sees whether a webhook is set, never its value', JSON.stringify(channelView(env)).includes('tok-'), false);
eq('and which sources each channel carries', channelView(env).find(c => c.id === 'private').sources, ['desk', 'job', 'flow', 'potus']);

// ── Send and log ──
{
  const kv = memKv(); let seen = null;
  const r = await sendAlert({ source: 'desk', payload: { embeds: [] }, items: [{ ruleId: 'desk:p1:r1', title: 'FAKE · stop', symbol: 'NYSE:FAKE', state: 'hit' }, { ruleId: 'desk:p2:r9', title: 'ZZZZ · review', state: 'due' }] },
    { deliver: async (h) => { seen = h; return 'm-1'; }, kv, env, now: new Date('2026-11-09T21:20:00Z') });
  eq('a send posts to the channel its source names', [r.ok, r.channel, seen], [true, 'private', HOOK(1)]);
  const log = kv.m.get(ALERT_LOG_KEY);
  eq('one log line per rule the message carries', log.map(l => l.ruleId), ['desk:p1:r1', 'desk:p2:r9']);
  eq('each line says it went out, where, and the message', [log[0].ok, log[0].channel, log[0].messageId, log[0].at], [true, 'private', 'm-1', '2026-11-09T21:20:00.000Z']);
}
{
  const kv = memKv();
  const r = await sendAlert({ source: 'job', payload: {}, items: [{ ruleId: 'job:x', title: 'X failed' }] }, { deliver: async () => 'never', kv, env: {} });
  eq('no webhook: not sent, and the log says why', [r.ok, kv.m.get(ALERT_LOG_KEY)[0].why], [false, 'DISCORD_PRIVATE_WEBHOOK unset']);
  const r2 = await sendAlert({ source: 'job', payload: {}, items: [{ ruleId: 'job:y' }] }, { deliver: async () => null, kv, env });
  eq('Discord refusing is logged as a failure', [r2.ok, kv.m.get(ALERT_LOG_KEY)[1].why], [false, 'Discord refused']);
  const r3 = await sendAlert({ source: 'job', payload: {}, items: [{ ruleId: 'job:z' }] }, { deliver: async () => { throw new Error('network down'); }, kv, env });
  eq('a network failure is a failure, never a throw', [r3.ok, kv.m.get(ALERT_LOG_KEY)[2].why], [false, 'network down']);
  const r4 = await sendAlert({ source: 'console', payload: {}, items: [{ ruleId: 'console:a:b' }] }, { deliver: async (h) => h, kv, env, webhook: HOOK(9) });
  eq('a caller-supplied webhook is used, the channel recorded stays the policy one', [r4.messageId, r4.channel], [HOOK(9), 'trades']);
}
{
  let threw = false; try { await sendAlert({ source: 'nope', items: [] }, { deliver: async () => 'x' }); } catch { threw = true; }
  eq('an unknown source is refused', threw, true);
  eq('a log that cannot be written does not fail the alert', (await sendAlert({ source: 'idea', payload: {}, items: [{ ruleId: 'idea:1' }] }, { deliver: async () => 'm', kv: { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); } }, env })).ok, true);
}
{
  const kv = memKv();
  await kv.set(ALERT_LOG_KEY, Array.from({ length: ALERT_LOG_MAX }, (_, i) => ({ ruleId: `old:${i}` })));
  await appendLog(logLines({ source: 'job', channel: 'private', ok: true, items: [{ ruleId: 'new:1' }] }), kv);
  const log = kv.m.get(ALERT_LOG_KEY);
  eq('the log is capped, the newest kept', [log.length, log.at(-1).ruleId, log[0].ruleId], [ALERT_LOG_MAX, 'new:1', 'old:1']);
  eq('the page reads it newest first', logView(log, { limit: 2 }).map(l => l.ruleId), ['new:1', `old:${ALERT_LOG_MAX - 1}`]);
  eq('long fields are clipped', logLines({ source: 'job', channel: 'private', ok: true, items: [{ ruleId: 'r', title: 'x'.repeat(500) }] })[0].title.length, 160);
}

// ── The rule list ──
const mirror = { at: '2026-11-06T22:00:00Z', positions: [
  { deskId: 'p1', name: 'FAKE shares', rules: [{ id: 'r1', kind: 'stop', text: 'weekly close below 90', level: 90, symbol: 'NYSE:FAKE', cond: 'weekly_close_below', cadence: 'weekly', source: 'stu' },
                                               { id: 'r2', kind: 'tp', level: 120, symbol: 'NYSE:FAKE', source: 'draft' }] }] };
const checks = { at: '2026-11-06T21:20:00Z', positions: [{ deskId: 'p1', rules: [{ id: 'r1', state: 'near', note: 'close 92, 0.4 ATR above' }] }] };
{
  const d = deskRuleRows(mirror, checks);
  eq('a Desk rule carries the close check state and note', [d[0].id, d[0].state, d[0].note, d[0].kind], ['desk:p1:r1', 'near', 'close 92, 0.4 ATR above', 'stop']);
  eq('a rule the check has not seen is unchecked', d[1].state, 'unchecked');
  eq('only Stu\'s rules alert; drafts are shown, not sent', d.map(r => r.alerts), [true, false]);
}
const consoleRows = [
  { id: 'c1', symbol: 'ZZZZ', derived: { status: 'open' }, levelStates: [
    { ruleId: 'console:c1:L1', kind: 'stop', at: 40, price: 39.5, hit: true, distPct: 1.27, label: 'stop 40 reached' },
    { ruleId: 'console:c1:L2', kind: 'sell', at: 60, price: 39.5, hit: false, distPct: 51.9, label: 'sell 60 reached' }] },
  { id: 'c2', symbol: 'QQQQ', derived: { status: 'open' }, levelStates: [{ ruleId: 'console:c2:L1', kind: 'buy', at: 10, to: 12, price: null, hit: false, distPct: null, label: 'buy 10–12 reached' }] },
  { id: 'c3', symbol: 'GONE', derived: { status: 'closed' }, levelStates: [{ ruleId: 'console:c3:L1', kind: 'stop', at: 1, price: 2, hit: false, label: 'stop 1 reached' }] },
];
{
  const c = consoleRuleRows(consoleRows);
  eq('console levels: hit, ok with the distance, unchecked without a price', c.map(r => [r.id, r.state, r.note]), [
    ['console:c1:L1', 'hit', 'now 39.5'], ['console:c1:L2', 'ok', '+51.9% to go'], ['console:c2:L1', 'unchecked', 'no price']]);
  eq('a closed card\'s levels are not standing rules', c.some(r => r.id.startsWith('console:c3')), false);
  eq('the rule reads as the level, without "reached"', c[0].rule, 'stop 40');
  const all = ruleList({ mirror, checks, consoleRows });
  eq('one list, hits first, then near, ok, unchecked', all.rules.map(r => r.state), ['hit', 'near', 'ok', 'unchecked', 'unchecked']);
  eq('with counts', all.counts, { total: 5, hit: 1, due: 0, near: 1, ok: 1, unchecked: 2 });
  eq('nothing in: an empty list, not an error', ruleList().counts.total, 0);
}

// ── Every alert in the code goes through the module ──
const src = (p) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const tc = src('api/tradecard.js'), rl = src('api/regime-log.js'), fx = src('api/flex-sync.js');
for (const [file, text, source] of [['api/tradecard.js', tc, 'console'], ['api/tradecard.js', tc, 'desk'], ['api/tradecard.js', tc, 'idea'], ['api/regime-log.js', rl, 'job'], ['api/flex-sync.js', fx, 'statement']])
  eq(`${source} alerts send through sendAlert (${file})`, text.includes(`sendAlert({ source: '${source}'`), true);
eq('no console alert posts around the module', /post\(\s*webhook\s*,\s*buildAlert/.test(tc), false);
eq('no job failure posts around the module', /post\(\s*webhook\s*,\s*failureCard/.test(rl), false);
eq('no idea trigger posts around the module', /notifier\(\s*webhook\s*,\s*alertPayload/.test(tc), false);
eq('no Desk card is delivered around the module', /deliver\(\s*webhook\s*,\s*card/.test(tc), false);
eq('the statement note is not posted around the module', /post\(\s*hook\s*,\s*\{\s*content:\s*`🧾/.test(fx), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
