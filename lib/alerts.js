// lib/alerts.js — the one alert module (build step 5).
//
// BEFORE: five places in the code decided something was worth a message and each posted to Discord
// its own way: console levels and trade events (api/tradecard.js refresh), Desk rules (the 16:20
// close check), idea triggers (/api/ideas-card), job failures (the scheduler tick) and the IBKR
// statement note (api/flex-sync.js). Each picked its own webhook, and nothing kept a record of what
// was sent, so "did that alert go out, and why?" had no answer anywhere.
//
// NOW: every one of them sends through `sendAlert`. It
//   - picks the channel from ONE policy table (SOURCES → CHANNELS), not from the call site;
//   - posts once;
//   - writes ONE log (ALERT_LOG_KEY): each line names the rule it came from, so every alert
//     traces to one rule, and says whether Discord took it.
// Each source keeps its own dedupe (it knows what "new" means for it); this module does not
// second-guess that. The rule list the Rules & Alerts page shows is assembled here too (ruleList).
//
// What is NOT an alert, and stays where it is: content cards edited in place (the trade card, the
// pre-read briefs, the wallet, daytrade and event cards). They report; they do not fire on a rule.

import { isWebhookUrl } from './discord.js';

export const ALERT_LOG_KEY = 'dvcap:alerts:log:v1';
export const ALERT_LOG_MAX = 300;

// Where an alert can go. `env` is the variable holding the webhook (never its value). `who` is the
// audience, because that is the line that matters: private data only goes where only Stu reads.
export const CHANNELS = Object.freeze({
  private: { label: 'Private channel', env: 'DISCORD_PRIVATE_WEBHOOK', who: 'Stu only' },
  trades:  { label: 'Trades channel',  env: 'DISCORD_TRADES_WEBHOOK',  who: 'the server (symbols and levels, never sizes)' },
  ideas:   { label: 'Ideas channel',   env: 'DISCORD_IDEAS_WEBHOOK',   who: 'the server' },
});

// Every kind of rule that can fire, where it is checked, and the one channel it goes to.
export const SOURCES = Object.freeze({
  desk:      { label: 'Desk rules',      channel: 'private', checked: 'at the US close, 16:20 New York', rules: 'rules set on the Position Desk' },
  console:   { label: 'Console levels',  channel: 'trades',  checked: 'trade-card runs (4 a day) and every console save', rules: 'levels on each console card' },
  idea:      { label: 'Idea triggers',   channel: 'ideas',   checked: 'the Trading Ideas trigger watch (Claude)', rules: 'triggers on each idea card' },
  job:       { label: 'Job failures',    channel: 'private', checked: 'every scheduler run', rules: 'a job failing or timing out' },
  statement: { label: 'IBKR statement',  channel: 'trades',  checked: 'the 12:00 UTC statement sync', rules: 'trades recorded or items to act on' },
});

export function channelOf(source) { return SOURCES[source]?.channel ?? null; }

// The webhook for a channel, from the environment, validated as lib/discord.js validates.
export function webhookFor(channel, env = process.env) {
  const name = CHANNELS[channel]?.env;
  const v = name ? String(env?.[name] || '').trim() : '';
  return isWebhookUrl(v) ? v : null;
}

// One log line per rule an alert carries. A Desk card can carry several rules: one message, one line
// each, so each rule's own history reads straight down the log.
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));
export function logLines({ source, items = [], channel, ok, messageId = null, why = null }, now = new Date()) {
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  return items.map(it => ({
    at, source, channel, ok: !!ok,
    ruleId: clip(it.ruleId, 120), title: clip(it.title, 160), symbol: clip(it.symbol, 24),
    state: clip(it.state, 12), messageId: messageId ? String(messageId) : null, why: ok ? null : clip(why, 80),
  }));
}

// Append to the log, newest last, capped. A log that fails to write never fails the alert.
export async function appendLog(lines, kv) {
  if (!lines.length || !kv?.get || !kv?.set) return false;
  try {
    const log = (await kv.get(ALERT_LOG_KEY).catch(() => null)) || [];
    await kv.set(ALERT_LOG_KEY, [...(Array.isArray(log) ? log : []), ...lines].slice(-ALERT_LOG_MAX));
    return true;
  } catch { return false; }
}

// THE send. `items` are the rules this message is about: [{ ruleId, title, symbol?, state? }].
// `deliver(webhook, payload)` posts and returns the message id (lib/discord.js post); it is passed
// in so every caller and test controls the network. `webhook` overrides the policy only where a
// caller has always taken one as an argument (the tests); it never changes the channel recorded.
export async function sendAlert({ source, payload, items = [] }, { deliver, kv = null, env = process.env, webhook = undefined, now = new Date() } = {}) {
  const channel = channelOf(source);
  if (!channel) throw new Error(`unknown alert source: ${source}`);
  const hook = webhook === undefined ? webhookFor(channel, env) : webhook;
  let messageId = null, why = null;
  if (!hook) why = `${CHANNELS[channel].env} unset`;
  else {
    try { messageId = await deliver(hook, payload); if (!messageId) why = 'Discord refused'; }
    catch (e) { why = String(e?.message || e).slice(0, 80); }
  }
  const ok = !!messageId;
  await appendLog(logLines({ source, items, channel, ok, messageId, why }, now), kv);
  return { ok, messageId, channel, why };
}

// The log, newest first, for the page.
export function logView(log, { limit = 100 } = {}) {
  return (Array.isArray(log) ? log : []).slice(-limit).reverse();
}

// ── THE RULE LIST ─────────────────────────────────────────────────────────────
// Every rule that can fire, as one list: Desk rules with the state the close check gave them, and
// console levels with their live state. Idea triggers and job failures are not standing rules
// dvcap holds (the trigger watch and the scheduler decide), so they appear in the log, not here.
const KIND_WORD = { add: 'add', tp: 'take profit', stop: 'stop', exit: 'exit', review: 'review', buy: 'entry', sell: 'target' };

export function deskRuleRows(mirror, checks) {
  const byRule = new Map();
  for (const p of checks?.positions || []) for (const r of p.rules || []) byRule.set(`${p.deskId}:${r.id}`, r);
  const out = [];
  for (const p of mirror?.positions || []) {
    for (const r of p.rules || []) {
      const c = byRule.get(`${p.deskId}:${r.id}`) || {};
      out.push({
        id: `desk:${p.deskId}:${r.id}`, source: 'desk', name: p.name || p.deskId, symbol: r.symbol || null,
        kind: KIND_WORD[r.kind] || r.kind, rule: r.text || null, level: r.level ?? null, cond: r.cond || null,
        cadence: r.cadence || null, ruleSource: r.source || null, alerts: r.source === 'stu',
        state: c.state || 'unchecked', note: c.note || null, checkedAt: checks?.at || null,
      });
    }
  }
  return out;
}

export function consoleRuleRows(rows) {
  const out = [];
  for (const r of rows || []) {
    if (r?.derived?.status === 'closed') continue;
    for (const s of r.levelStates || []) {
      out.push({
        id: s.ruleId, source: 'console', name: r.symbol, symbol: r.symbol,
        kind: KIND_WORD[s.kind] || s.kind, rule: s.label.replace(/ reached$/, ''), level: s.at, to: s.to ?? null,
        on: s.on || null, alerts: true, state: s.price == null ? 'unchecked' : s.hit ? 'hit' : 'ok',
        note: s.price == null ? 'no price' : s.hit ? `now ${s.price}` : s.distPct == null ? null : `${s.distPct > 0 ? '+' : ''}${s.distPct}% to go`,
        checkedAt: null,
      });
    }
  }
  return out;
}

const STATE_ORDER = { hit: 0, due: 1, near: 2, ok: 3, unchecked: 4, skip: 5 };
export function ruleList({ mirror = null, checks = null, consoleRows = [] } = {}) {
  const rules = [...deskRuleRows(mirror, checks), ...consoleRuleRows(consoleRows)]
    .sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || String(a.name).localeCompare(String(b.name)));
  const counts = { total: rules.length, hit: 0, due: 0, near: 0, ok: 0, unchecked: 0 };
  for (const r of rules) if (counts[r.state] != null) counts[r.state]++;
  return { rules, counts };
}

// What the page shows about each channel: whether its webhook is set (never the value).
export function channelView(env = process.env) {
  return Object.entries(CHANNELS).map(([id, c]) => ({ id, ...c, set: !!webhookFor(id, env),
    sources: Object.entries(SOURCES).filter(([, s]) => s.channel === id).map(([k]) => k) }));
}
