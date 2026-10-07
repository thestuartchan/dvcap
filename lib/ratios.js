// lib/ratios.js — the Ratios panel: one price divided by another, read for its DIRECTION.
//
// The level of NVDA ÷ META is not interesting; whether it is rising (the first is winning) or
// falling (the second is) is. Every card is computed the same way from daily CLOSES (settled
// sessions only — lib/yahoo.js yahooDailyCloses) and reads cold, for someone new to ratios:
//   level · 5- and 20-session change · where today sits in its 1-year range · the band of the
//   PRIOR 60 sessions and whether today closed outside it · whether the 20-session move is
//   unusually fast for this ratio (beyond ±2σ of a year of 20-session moves) · one sentence.
// Public market data only. The card copy (CARDS) is static and ships with the page; nothing here
// is served by an API route, and nothing reads a position.
import HOLIDAYS from '../data/holidays.json' with { type: 'json' };

export const BAND_SESSIONS = 60;       // the "60-day range": the 60 sessions BEFORE today
export const YEAR_SESSIONS = 252;
export const CHART_SESSIONS = 126;     // six months on the card's chart
export const FAST_SIGMA = 2;
export const NEAR_EDGE = 0.10;         // inside the top or bottom 10% of the 1-year range → said so
export const STALE_SESSIONS = 1;       // a leg more than one trading day behind greys the card

// ── THE CARDS ────────────────────────────────────────────────────────────────
// Copy from the brief of 7 Oct 2026, verbatim. `group` decides colour: the AI-cycle cards (ai) are
// blue/amber — which side leads, neither good nor bad — and the risk-appetite cards (risk) are
// green/red, healthier/less healthy. `a`/`b` name the two sides in the NOW sentence (`plural`: "are").
export const CARDS = Object.freeze([
  { id: 'nvda-meta', n: 1, group: 'ai', title: 'AI chip seller vs AI chip buyer', formula: 'NVDA ÷ META', short: 'NVDA ÷ META',
    num: ['NVDA'], den: ['META'], a: 'NVDA', b: 'META',
    up: 'Market pays the *supplier*: AI spending is still accelerating',
    down: 'Market pays the *spender*: either AI is paying off for buyers, or doubts about how long the spending lasts',
    why: 'Quickest read on the AI capex cycle. Single-stock noise: confirm with card 2' },
  { id: 'smh-spenders', n: 2, group: 'ai', title: 'Chip makers vs the big AI spenders', formula: 'SMH ÷ equal-weight basket (MSFT, GOOGL, AMZN, META)', short: 'SMH ÷ AI spenders',
    num: ['SMH'], den: ['MSFT', 'GOOGL', 'AMZN', 'META'], a: 'Chip makers (SMH)', b: 'the big AI spenders', plural: true,
    up: 'Suppliers lead: the capex boom is intact',
    down: 'Spenders lead: the market is rotating toward ROI, or away from the build-out',
    why: 'Basket version of card 1, with less noise' },
  { id: 'mu-smh', n: 3, group: 'ai', title: 'Memory chips vs all chips', formula: 'MU ÷ SMH', short: 'MU ÷ SMH',
    num: ['MU'], den: ['SMH'], a: 'Memory (MU)', b: 'all chips (SMH)',
    up: 'Memory is leading the chip trade',
    down: 'Memory is lagging: a memory-cycle top would show here first',
    why: 'Memory is one of Stu\'s "bubble pockets"; he holds 7709 (2× SK hynix)' },
  { id: 'crwv-nvda', n: 4, group: 'ai', title: 'Debt-funded AI clouds vs the chip seller', formula: 'CRWV ÷ NVDA', short: 'CRWV ÷ NVDA',
    num: ['CRWV'], den: ['NVDA'], a: 'The AI clouds (CRWV)', b: 'NVDA', plural: true,
    up: 'Financing for the GPU-rental clouds is easy; the market believes in them',
    down: 'GPU clouds are cracking before the chip seller, often the first sign of funding stress',
    why: '"Debt-financed AI" bubble pocket. This breaks before the rest' },
  { id: 'rsp-spy', n: 5, group: 'risk', title: 'Average stock vs giant stocks', formula: 'RSP ÷ SPY (equal-weight S&P ÷ normal S&P)', short: 'RSP ÷ SPY',
    num: ['RSP'], den: ['SPY'], a: 'The average stock (RSP)', b: 'the giant stocks (SPY)',
    up: 'Rally is **broad**: most stocks are joining in',
    down: 'Rally is **narrow**: a handful of mega-caps carry the index, which is fragile',
    why: "Shows whether SPY's highs are healthy or concentrated" },
  { id: 'iwm-spy', n: 6, group: 'risk', title: 'Small caps vs large caps', formula: 'IWM ÷ SPY', short: 'IWM ÷ SPY',
    num: ['IWM'], den: ['SPY'], a: 'Small caps (IWM)', b: 'large caps (SPY)', plural: true,
    up: 'Small caps lead: usually means rates are falling or a short squeeze is running',
    down: 'Large caps lead: higher rates are hurting smaller, more indebted companies',
    why: 'Most rate-sensitive ratio; pair it with the US 2-year yield' },
  { id: 'xly-xlp', n: 7, group: 'risk', title: 'Spending vs necessities', formula: 'XLY ÷ XLP (consumer discretionary ÷ staples)', short: 'XLY ÷ XLP',
    num: ['XLY'], den: ['XLP'], a: 'Spending (XLY)', b: 'necessities (XLP)',
    up: 'People and investors are confident: risk appetite is up',
    down: 'Defensive mood: investors are hiding in toothpaste and groceries',
    why: 'Plain-English risk-appetite gauge' },
]);
export const LEGS = Object.freeze([...new Set(CARDS.flatMap(c => [...c.num, ...c.den]))]);

export const LEGEND = Object.freeze({
  ai: 'Blue/amber show which side leads; neither is good or bad on its own.',
  risk: 'Green = healthier, broader risk appetite.',
});

// ── THE US TRADING CALENDAR ─────────────────────────────────────────────────
const US_CLOSED = new Set(HOLIDAYS?.US?.closed || []);
const isSession = (iso) => { const dow = new Date(`${iso}T12:00:00Z`).getUTCDay(); return dow !== 0 && dow !== 6 && !US_CLOSED.has(iso); };
const shift = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const nyParts = (now) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(now)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
};
// The last session whose close is settled: today after 16:00 New York, else the session before.
export function lastSettledSession(now = Date.now()) {
  const { date, min } = nyParts(now);
  let d = (isSession(date) && min >= 16 * 60) ? date : shift(date, -1);
  for (let i = 0; i < 12 && !isSession(d); i++) d = shift(d, -1);
  return d;
}
// Trading sessions after `from` up to and including `to`.
export function sessionsBetween(from, to) {
  if (!from || !to || from >= to) return 0;
  let n = 0;
  for (let d = shift(from, 1); d <= to && n < 400; d = shift(d, 1)) if (isSession(d)) n++;
  return n;
}

// ── THE SERIES ───────────────────────────────────────────────────────────────
// `closes`: { SYM: [[date, close], …] }. Dates where every leg closed. A single leg each side is a
// plain price ratio (NVDA ÷ META ≈ 0.32). A basket is equal-weighted the way the brief sets it:
// each member indexed to 100 at the start of the lookback, averaged, and the other side indexed to
// 100 on the same day — so card 2 reads around 1.0, and its footnote says from when.
export function ratioSeries(card, closes = {}) {
  const legs = [...card.num, ...card.den];
  const maps = legs.map(s => new Map((closes[s] || []).filter(([, c]) => c > 0)));
  if (maps.some(m => !m.size)) return { points: [], base: null };
  const dates = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort();
  if (!dates.length) return { points: [], base: null };
  const basket = card.num.length > 1 || card.den.length > 1;
  const base = dates[0];
  const side = (syms) => (d) => {
    if (!basket) return closes && maps[legs.indexOf(syms[0])].get(d);
    return syms.reduce((a, s) => { const m = maps[legs.indexOf(s)]; return a + 100 * m.get(d) / m.get(base); }, 0) / syms.length;
  };
  const N = side(card.num), D = side(card.den);
  return { points: dates.map(d => ({ d, v: N(d) / D(d) })), base: basket ? base : null };
}

// Which legs are behind, and since when. A card with one is greyed and computes nothing.
export function staleness(card, closes = {}, { now = Date.now() } = {}) {
  const settled = lastSettledSession(now);
  const legs = [...card.num, ...card.den];
  const behind = legs.map(s => ({ sym: s, last: (closes[s] || []).at(-1)?.[0] || null }))
    .filter(l => !l.last || sessionsBetween(l.last, settled) > STALE_SESSIONS);
  if (!behind.length) return null;
  const dated = behind.filter(l => l.last).map(l => l.last).sort();
  return { since: dated[0] || null, legs: behind.map(l => l.sym), settled };
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };

// Everything a card shows, from its series. Percent figures are fractions (0.081 = 8.1%).
export function cardStats(points = []) {
  const v = points.map(p => p.v), n = v.length;
  if (n < BAND_SESSIONS + 21) return null;
  const last = v[n - 1];
  const ch = (k) => (n > k ? last / v[n - 1 - k] - 1 : null);
  const year = v.slice(-YEAR_SESSIONS);
  const lo = Math.min(...year), hi = Math.max(...year);
  const yearPos = hi > lo ? (last - lo) / (hi - lo) : 0.5;
  const prior = v.slice(n - 1 - BAND_SESSIONS, n - 1);
  const bandHi = Math.max(...prior), bandLo = Math.min(...prior);
  const broke = last > bandHi ? 'above' : last < bandLo ? 'below' : null;
  // A year of 20-session moves ending YESTERDAY, so today is measured against what came before it.
  const moves = [];
  for (let i = Math.max(20, n - 1 - YEAR_SESSIONS); i < n - 1; i++) moves.push(v[i] / v[i - 20] - 1);
  const ch20 = ch(20);
  const s = moves.length > 30 ? sd(moves) : null;
  const z = s ? (ch20 - mean(moves)) / s : null;
  // The chart: six months, each day carrying the band of the 60 sessions before it.
  const from = Math.max(BAND_SESSIONS, n - CHART_SESSIONS);
  const chart = [];
  for (let i = from; i < n; i++) {
    const w = v.slice(i - BAND_SESSIONS, i);
    chart.push({ d: points[i].d, v: v[i], hi: Math.max(...w), lo: Math.min(...w) });
  }
  return {
    last, date: points[n - 1].d, ch5: ch(5), ch20,
    yearLo: lo, yearHi: hi, yearLoDate: points[n - year.length + year.indexOf(lo)].d, yearHiDate: points[n - year.length + year.indexOf(hi)].d,
    yearPos, bandHi, bandLo, broke, z, fast: z != null && Math.abs(z) > FAST_SIGMA, chart,
  };
}

// "Rising" and "falling" are the 20-session move — the window the NOW sentence names.
export const direction = (st) => (st?.ch20 == null ? null : st.ch20 > 0 ? 'up' : st.ch20 < 0 ? 'down' : 'flat');
// The colour ROLE, not the colour: the panel maps roles to its theme.
export function toneOf(card, st) {
  const dir = direction(st);
  if (!dir || dir === 'flat') return 'neutral';
  if (card.group === 'ai') return dir === 'up' ? 'boom' : 'caution';
  return dir === 'up' ? 'healthy' : 'unhealthy';
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export function nowSentence(card, st) {
  if (!st) return null;
  const verb = st.ch20 > 0 ? 'beating' : st.ch20 < 0 ? 'lagging' : 'level with';
  const ctx = st.yearPos > 1 - NEAR_EDGE ? ', near its 1-year high' : st.yearPos < NEAR_EDGE ? ', near its 1-year low' : '';
  return `${cap(card.a)} ${card.plural ? 'are' : 'is'} ${verb} ${card.b} over 20 days${ctx}.`;
}

export function statusOf(st) {
  if (!st) return [];
  const out = [st.broke === 'above' ? { kind: 'above', text: '▲ Broke ABOVE its 60-day range' }
    : st.broke === 'below' ? { kind: 'below', text: '▼ Broke BELOW its 60-day range' }
    : { kind: 'inside', text: '● Inside its 60-day range' }];
  if (st.fast) out.push({ kind: 'fast', text: '⚡ Unusually fast move' });
  return out;
}

// One card, start to finish. `closes` is the history route's map of [date, close] pairs.
export function buildCard(card, closes = {}, { now = Date.now() } = {}) {
  const stale = staleness(card, closes, { now });
  if (stale) return { card, stale, stats: null };
  const { points, base } = ratioSeries(card, closes);
  const stats = cardStats(points);
  if (!stats) return { card, stale: { since: points.at(-1)?.d || null, legs: [], short: true }, stats: null };
  return { card, stale: null, stats, base, tone: toneOf(card, stats), now: nowSentence(card, stats), status: statusOf(stats) };
}

// The line across the top: the risk-appetite cards and the AI-cycle cards counted separately, and
// every range break on the latest close.
export function summaryLine(built = []) {
  const live = built.filter(b => b.stats);
  const risk = live.filter(b => b.card.group === 'risk'), ai = live.filter(b => b.card.group === 'ai');
  const parts = [];
  if (risk.length) parts.push(`Risk appetite: ${risk.filter(b => direction(b.stats) === 'up').length} of ${risk.length} rising`);
  if (ai.length) {
    const up = ai.filter(b => direction(b.stats) === 'up').length, down = ai.filter(b => direction(b.stats) === 'down').length;
    parts.push(down >= up ? `AI cycle: caution side leading on ${down} of ${ai.length}` : `AI cycle: boom side leading on ${up} of ${ai.length}`);
  }
  const breaks = live.filter(b => b.stats.broke);
  parts.push(breaks.length
    ? `${breaks.length} range break${breaks.length === 1 ? '' : 's'} today (${breaks.map(b => `${b.card.short} ${b.stats.broke === 'above' ? '▲' : '▼'}`).join(', ')})`
    : 'no range breaks today');
  const stale = built.filter(b => b.stale).length;
  if (stale) parts.push(`${stale} card${stale === 1 ? '' : 's'} waiting on data`);
  return parts.join(' · ');
}
