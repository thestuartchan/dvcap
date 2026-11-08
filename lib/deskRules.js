// lib/deskRules.js — the Position Desk's rules, checked by dvcap at the US close.
//
// WHY (6 Nov 2026). The Desk's rules (stop, take-profit, add, exit, review; a level, a TradingView
// symbol and a condition) were checked once a night by a Claude task reading TradingView. That is a
// model doing arithmetic on a schedule it does not control. Code can do it on the close, every
// day, the same way every day, and say so the moment a rule is hit.
//
// HOW IT FLOWS. The Desk stays where rules are written. Whenever Stu saves one, the Desk page sends
// its rule list to dvcap through the book connector's put_desk_rules (the nightly Desk task sends it
// too, so a missed save heals the same day). dvcap keeps that MIRROR in Redis and, at 16:20 New York
// (the scheduler: after TradingView's 15-minute delay on US closes), prices every rule, records a
// state per rule, and posts newly hit rules to the private Discord channel. The Desk page and the
// nightly task read the states back through get_positions.
//
// WHAT IT DOES NOT DO. It never trades and never edits the Desk. A rule it cannot price (no level,
// no symbol and no dvcap mark, or a condition it does not know) is "unchecked" and left to the
// nightly task, which still runs.
//
// Pure: no I/O and no clock. The route (api/tradecard.js ?deskrules=1) fetches and stores.

export const DESK_RULES_KEY = 'dvcap:desk:rules:v1';      // the mirror the Desk sends
export const DESK_CHECKS_KEY = 'dvcap:desk:checks:v1';    // the last close's states
export const RULE_KINDS = Object.freeze(['add', 'tp', 'stop', 'exit', 'review']);
export const CONDS = Object.freeze(['cross_up', 'cross_down', 'close_above', 'close_below',
  'weekly_close_above', 'weekly_close_below', 'monthly_close_above', 'monthly_close_below']);
export const NEAR_ATR = 0.5;           // the Desk's own definition of "near a level"
export const NEAR_VALUE_PCT = 10;      // a rule on the position's own value (a spread's take-profit)
export const NEAR_NO_ATR_PCT = 1;      // a symbol whose ATR did not come back
const MAX_POSITIONS = 200, MAX_RULES = 20;

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const str = (v, n) => (v == null ? null : String(v).slice(0, n));
const sig = (v) => (num(v) == null ? null : +(+v).toPrecision(6));
// A TradingView ticker as the Desk writes it: EXCHANGE:SYMBOL, a continuous future's "1!", digits
// for Hong Kong. Anything else is not a symbol dvcap will send to a quote service.
const TV_SYMBOL = /^[A-Z0-9_]{1,20}:[A-Z0-9._!&-]{1,24}$/;

// ── THE MIRROR ───────────────────────────────────────────────────────────────
// What put_desk_rules accepts, field by field, so nothing else the Desk holds (thesis, history,
// alert ids, P&L) is stored here. Returns { mirror } or { error }.
export function normalizeMirror(input, { now = new Date().toISOString() } = {}) {
  const list = input?.positions;
  if (!Array.isArray(list)) return { error: 'positions must be an array' };
  if (list.length > MAX_POSITIONS) return { error: `at most ${MAX_POSITIONS} positions` };
  const positions = [];
  for (const p of list) {
    const deskId = str(p?.deskId, 64);
    if (!deskId) return { error: 'every position needs a deskId' };
    const rules = (Array.isArray(p?.rules) ? p.rules : []).slice(0, MAX_RULES).map(r => {
      const cond = typeof r?.cond === 'string' ? r.cond.trim() : '';
      const symbol = typeof r?.symbol === 'string' ? r.symbol.trim().toUpperCase() : '';
      return {
        id: str(r?.id, 40) || '',
        kind: RULE_KINDS.includes(r?.kind) ? r.kind : 'review',
        text: str(r?.text, 140) || '',
        level: num(r?.level),
        symbol: TV_SYMBOL.test(symbol) ? symbol : null,
        cond: CONDS.includes(cond) || /^date \d{4}-\d{2}-\d{2}$/.test(cond) ? cond : null,
        cadence: ['daily', 'weekly', 'monthly', 'quarterly'].includes(r?.cadence) ? r.cadence : 'daily',
        source: r?.source === 'draft' ? 'draft' : 'stu',
      };
    }).filter(r => r.id);
    positions.push({
      deskId, dvcapId: str(p?.dvcapId, 80), name: str(p?.name, 80) || deskId,
      group: str(p?.group, 16), side: p?.side === 'short' ? 'short' : p?.side === 'long' ? 'long' : null, rules,
    });
  }
  // Closed positions carry no live rules.
  return { mirror: { at: now, positions: positions.filter(p => p.group !== 'closed') } };
}

// ── ONE RULE ─────────────────────────────────────────────────────────────────
// Which way a rule trips. A condition says so; without one, a stop or exit on a long trips below and
// a take-profit above (both flip on a short); anything else is not guessed.
export function directionOf(rule, side = null) {
  const c = rule?.cond || '';
  if (/above|cross_up/.test(c)) return 'above';
  if (/below|cross_down/.test(c)) return 'below';
  if (!side) return null;
  if (rule?.kind === 'stop' || rule?.kind === 'exit') return side === 'short' ? 'above' : 'below';
  if (rule?.kind === 'tp') return side === 'short' ? 'below' : 'above';
  return null;
}
// Weekly and monthly rules are judged only on the last session of the week or month.
export function dueToday(rule, { isWeekEnd = false, isMonthEnd = false } = {}) {
  const c = rule?.cond || '';
  if (/^monthly_/.test(c) || rule?.cadence === 'monthly' || rule?.cadence === 'quarterly') return isMonthEnd;
  if (/^weekly_/.test(c) || rule?.cadence === 'weekly') return isWeekEnd;
  return true;
}

const fmt = (v) => { const s = sig(v); return s == null ? '—' : s.toLocaleString('en-US', { maximumFractionDigits: 6 }); };

// ctx: { today, quote: {close, atr} for rule.symbol, mark: the dvcap position's value, side,
//        isWeekEnd, isMonthEnd }. → { state, price, note } with state hit | near | ok | due | unchecked
// | skip (not judged today: the previous state stands).
export function evaluateRule(rule, ctx = {}) {
  const c = rule?.cond || '';
  if (c.startsWith('date ')) {
    const d = c.slice(5);
    if (!ctx.today) return { state: 'unchecked', price: null, note: 'no date to compare' };
    if (ctx.today >= d) return { state: 'due', price: null, note: `due ${dayWord(d)}` };
    const days = Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${ctx.today}T12:00:00Z`)) / 86400000);
    return { state: 'ok', price: null, note: `${days} day${days === 1 ? '' : 's'} to ${dayWord(d)}` };
  }
  if (!dueToday(rule, ctx)) return { state: 'skip', price: null, note: null };
  const level = num(rule?.level);
  if (level == null) return { state: 'unchecked', price: null, note: 'no level' };
  const dir = directionOf(rule, ctx.side);
  if (!dir) return { state: 'unchecked', price: null, note: 'no condition: left to the nightly check' };
  const onSymbol = !!rule?.symbol;
  const price = onSymbol ? num(ctx.quote?.close) : num(ctx.mark);
  if (price == null) return { state: 'unchecked', price: null, note: onSymbol ? `no close for ${rule.symbol}` : 'no symbol and no dvcap mark' };
  const hit = dir === 'above' ? price > level : price < level;
  const gap = Math.abs(price - level);
  const atr = num(ctx.quote?.atr);
  const nearBy = onSymbol ? (atr ? NEAR_ATR * atr : Math.abs(level) * NEAR_NO_ATR_PCT / 100) : Math.abs(level) * NEAR_VALUE_PCT / 100;
  const state = hit ? 'hit' : gap <= nearBy ? 'near' : 'ok';
  const what = onSymbol ? 'close' : 'value';
  return { state, price: sig(price), note: `${what} ${fmt(price)}, ${fmt(gap)} ${price >= level ? 'above' : 'below'} ${fmt(level)}` };
}

// ── THE CLOSE ────────────────────────────────────────────────────────────────
// Every rule in the mirror, judged. quotes: { [symbol]: {close, atr} }; marks: { [dvcapId]: {mark,
// side} }; prev: the last run's checks (a "skip" keeps its state).
export function runChecks(mirror, { quotes = {}, marks = {}, today, isWeekEnd = false, isMonthEnd = false, prev = null, now = new Date().toISOString() } = {}) {
  const before = new Map();
  for (const p of (prev?.positions || [])) for (const r of (p.rules || [])) before.set(`${p.deskId}/${r.id}`, r);
  const positions = (mirror?.positions || []).map(p => {
    const m = p.dvcapId ? marks[p.dvcapId] : null;
    const side = p.side || m?.side || null;
    const rules = p.rules.map(r => {
      const got = evaluateRule(r, { today, quote: r.symbol ? quotes[r.symbol] : null, mark: m?.mark, side, isWeekEnd, isMonthEnd });
      const was = before.get(`${p.deskId}/${r.id}`);
      if (got.state === 'skip') {
        return was ? { ...was, kind: r.kind, source: r.source, text: r.text } : { id: r.id, kind: r.kind, source: r.source, text: r.text, level: r.level, symbol: r.symbol, state: 'ok', price: null, note: 'judged on the period close', checkedAt: null };
      }
      return { id: r.id, kind: r.kind, source: r.source, text: r.text, level: r.level, symbol: r.symbol, ...got, checkedAt: now };
    });
    return { deskId: p.deskId, dvcapId: p.dvcapId, name: p.name, rules };
  });
  const all = positions.flatMap(p => p.rules);
  const count = (s) => all.filter(r => r.state === s).length;
  return { at: now, today, positions, counts: { hit: count('hit'), due: count('due'), near: count('near'), ok: count('ok'), unchecked: count('unchecked') } };
}

// What is worth a message: a rule of Stu's (not a draft) that is hit or due tonight and was not
// last time. Near rules ride along as context, never on their own.
export function newHits(prev, next) {
  const was = new Map();
  for (const p of (prev?.positions || [])) for (const r of (p.rules || [])) was.set(`${p.deskId}/${r.id}`, r.state);
  const fresh = [], near = [];
  for (const p of (next?.positions || [])) for (const r of (p.rules || [])) {
    if (r.source !== 'stu') continue;
    const k = `${p.deskId}/${r.id}`;
    if ((r.state === 'hit' || r.state === 'due') && was.get(k) !== r.state) fresh.push({ name: p.name, deskId: p.deskId, rule: r });
    else if (r.state === 'near') near.push({ name: p.name, deskId: p.deskId, rule: r });
  }
  return { fresh, near };
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayWord = (d) => { const t = new Date(`${d}T12:00:00Z`); return `${DOW.at(t.getUTCDay())} ${t.getUTCDate()} ${MON.at(t.getUTCMonth())}`; };
const KIND_WORD = { add: 'Add', tp: 'Take profit', stop: 'Stop', exit: 'Exit', review: 'Review' };
// The private channel's card (a Discord embed). Book data: this goes ONLY to DISCORD_PRIVATE_WEBHOOK.
// Red when a stop, exit or take-profit is hit; amber when only date rules are due. One field per
// newly hit rule (position as the field name, rule and the number underneath), near rules folded
// into one field at the end. Embed limits: 25 fields, 256-character names, 1,024-character values.
export const CARD_COLOUR = Object.freeze({ red: 0xe74c3c, amber: 0xf1c40f, green: 0x2ecc71 });
export function deskAlertCard({ fresh = [], near = [] }, { today, now = new Date().toISOString() } = {}) {
  if (!fresh.length) return null;
  const hit = fresh.filter(x => x.rule.state === 'hit').length, due = fresh.length - hit;
  const head = [hit ? `${hit} hit` : '', due ? `${due} due` : '', near.length ? `${near.length} near` : ''].filter(Boolean).join(' · ');
  const ruleLine = (r) => `${KIND_WORD[r.kind] || r.kind}${r.text ? ` · ${r.text}` : ''}`;
  const fields = fresh.slice(0, 20).map(x => ({
    name: `${x.rule.state === 'due' ? '⏰' : '🔴'} ${x.name}`.slice(0, 256),
    value: `${ruleLine(x.rule)}${x.rule.note ? `\n**${x.rule.note}**` : ''}`.slice(0, 1024),
    inline: false,
  }));
  if (fresh.length > 20) fields.push({ name: `+${fresh.length - 20} more`, value: 'See the Position Desk', inline: false });
  if (near.length) fields.push({ name: '🟡 Near a level', value: near.slice(0, 10).map(x => `${x.name} · ${ruleLine(x.rule)}${x.rule.note ? ` · ${x.rule.note}` : ''}`).join('\n').slice(0, 1024), inline: false });
  return {
    embeds: [{
      title: `Desk rules at the close${today ? ` · ${dayWord(today)}` : ''}`,
      description: head,
      color: hit ? CARD_COLOUR.red : CARD_COLOUR.amber,
      fields,
      footer: { text: 'dvcap · checked 16:20 New York · private channel' },
      timestamp: now,
    }],
    allowed_mentions: { parse: [] },
  };
}

// What get_positions carries per Desk position: the states, keyed by deskId and dvcapId.
export function checksView(checks) {
  if (!checks?.positions) return null;
  return {
    at: checks.at, today: checks.today, counts: checks.counts,
    positions: checks.positions.map(p => ({ deskId: p.deskId, dvcapId: p.dvcapId,
      rules: p.rules.map(r => ({ id: r.id, state: r.state, price: r.price, note: r.note, checkedAt: r.checkedAt })) })),
  };
}

// Last session of the week and of the month, on the New York calendar (holidays: YYYY-MM-DD).
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isSession = (d, holidays) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); return w !== 0 && w !== 6 && !holidays.includes(d); };
export function periodEnds(today, holidays = []) {
  let next = addDays(today, 1);
  for (let i = 0; i < 10 && !isSession(next, holidays); i++) next = addDays(next, 1);
  const weekOf = (d) => { const t = new Date(`${d}T12:00:00Z`); const w = (t.getUTCDay() + 6) % 7; return addDays(d, -w); };
  return { isWeekEnd: weekOf(next) !== weekOf(today), isMonthEnd: next.slice(0, 7) !== today.slice(0, 7) };
}
