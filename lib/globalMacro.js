// lib/globalMacro.js — the DAILY GLOBAL MACRO OVERVIEW (Stu, 19 Nov 2026).
//
// WHY. About twenty lines of each regional pre-read were the same in all three: rates, credit, oil,
// inflation, the yuan, the trend-fund model and the global tripwires — read three times a day and
// identical each time. They move here, into one post after the US close, joined by what the briefs
// never carried: the ratios panel, FX legs and the cross-asset tape, each read over SEVERAL sessions
// so a trend forming is visible rather than one day's print. The regional briefs keep one 🌐 line
// that says what has moved since this was posted (globalDeltaLine).
//
// WHEN. 17:20 New York, after the close settles every input (ratios and the trend-fund model read
// daily closes; FX and futures settle at 17:00 NY) and before the Asia brief, which is the first
// to compare against it.
//
// SOURCES. Public market data only: Yahoo daily closes for the ratio legs, FX and cross-asset; the
// rates, credit, oil and inflation lines are the briefs' own (lib/briefSections.js) over the same
// assembled feeds. No model writes a figure here. No account data, no Unusual Whales data — this
// posts to the pre-read channel.
import { CARDS, LEGS, buildCard, summaryRead, turning, cardStats } from './ratios.js';
import { stageProse, isActive } from './ratioBreaks.js';

// Where the posted Overview is kept: the regional briefs read its snapshot (via the pre-read log),
// the gamma connector's get_global_macro tool reads this for the Daily Read.
export const GLOBAL_OVERVIEW_KEY = 'dvcap:global:overview:v1';

// ── WHAT IS READ ─────────────────────────────────────────────────────────────
// FX in the DOLLAR's frame: `usdBase` pairs are quoted foreign-per-dollar (a rise is a stronger
// dollar); the others are quoted dollars-per-foreign and are inverted for the read, the same trap
// lib/quotes.js usdLeg documents. The quoted level is printed as everyone quotes it.
export const GLOBAL_FX = Object.freeze([
  { sym: 'DX-Y.NYB', name: 'Dollar index (DXY)', short: 'DXY', usd: 'index', means: { up: 'tighter dollar conditions for everyone who borrows in it', down: 'easier dollar conditions — a tailwind for EM and commodities' } },
  { sym: 'EURUSD=X', name: 'EUR/USD', short: 'EUR', usd: 'quote', means: { up: 'dollar firmer against the euro', down: 'dollar softer against the euro' } },
  { sym: 'JPY=X', name: 'USD/JPY', short: 'JPY', usd: 'base', means: { up: 'yen weaker — carry trades comfortable', down: 'yen firmer — the carry-unwind risk rises' } },
  { sym: 'GBPUSD=X', name: 'GBP/USD', short: 'GBP', usd: 'quote', means: { up: 'dollar firmer against sterling', down: 'dollar softer against sterling' } },
  // Onshore CNY, not offshore CNH: the feed keeps no daily history for CNH (measured 19 Nov 2026,
  // CNH=X answers no-data), and a 20-session trend needs one. The regional briefs' live yuan print
  // stays CNH.
  { sym: 'CNY=X', name: 'USD/CNY', short: 'CNY', usd: 'base', means: { up: 'yuan weaker — pressure on China and its suppliers', down: 'yuan firmer — China easing its own pressure' } },
  { sym: 'KRW=X', name: 'USD/KRW', short: 'KRW', usd: 'base', means: { up: 'won weaker — money leaving Korea', down: 'won firmer — money coming back to Korea' } },
  { sym: 'AUDUSD=X', name: 'AUD/USD', short: 'AUD', usd: 'quote', means: { up: 'dollar firmer against the Aussie — risk appetite and China demand cooling', down: 'dollar softer against the Aussie — risk appetite and China demand firm' } },
]);
// `up`/`down` are the INSTRUMENT's direction (for the derived copper ÷ gold, the ratio's).
export const GLOBAL_CROSS = Object.freeze([
  { sym: 'GC=F', name: 'Gold', short: 'Gold', means: { up: 'haven and real-rate hedge in demand', down: 'haven demand fading' } },
  { sym: 'HG=F', name: 'Copper', short: 'Copper', means: { up: 'industrial demand firming', down: 'industrial demand softening' } },
  { id: 'cu-au', name: 'Copper ÷ gold', short: 'Cu÷Au', num: 'HG=F', den: 'GC=F', means: { up: 'growth winning over fear', down: 'fear winning over growth' } },
  { sym: 'CL=F', name: 'WTI crude', short: 'WTI', means: { up: 'energy costs rising', down: 'energy costs easing' } },
  { sym: 'BTC-USD', name: 'Bitcoin', short: 'BTC', means: { up: 'speculative liquidity flowing', down: 'speculative liquidity draining' } },
  { sym: 'TLT', name: 'Long Treasuries (TLT)', short: 'TLT', means: { up: 'long yields falling', down: 'long yields rising' } },
  { sym: '^VIX', name: 'VIX', short: 'VIX', vol: true, means: { up: 'equity fear rising', down: 'equity fear easing' } },
  { sym: '^MOVE', name: 'MOVE (bond vol)', short: 'MOVE', vol: true, means: { up: 'bond-market stress rising', down: 'bond-market stress easing' } },
  { sym: '^OVX', name: 'OVX (oil vol)', short: 'OVX', vol: true, means: { up: 'oil uncertainty rising', down: 'oil uncertainty easing' } },
]);
export const GLOBAL_SYMBOLS = Object.freeze([...new Set([
  ...GLOBAL_FX.map(r => r.sym), ...GLOBAL_CROSS.flatMap(r => (r.sym ? [r.sym] : [r.num, r.den])),
])]);
export const RATIO_SYMBOLS = Object.freeze([...new Set([...LEGS, 'SPY'])]);

// ── A SERIES READ OVER SEVERAL SESSIONS ──────────────────────────────────────
// The ratio panel's own statistics (lib/ratios.js cardStats) over any [date, close] series, so a
// currency and a ratio are judged by one rule: 1/5/20-session change, the band of the 60 sessions
// before today, and how unusual the 20-session move is against a year of them.
export const TREND = Object.freeze({ zBuilding: 1, turnMin: 0.005, flatPct: 0.0005 });

export function seriesStats(closes = []) {
  const pts = (closes || []).filter(([, v]) => Number.isFinite(v) && v > 0).map(([d, v]) => ({ d, v }));
  const st = cardStats(pts);
  if (!st) return null;
  const n = pts.length;
  return { ...st, ch1: n > 1 ? pts[n - 1].v / pts[n - 2].v - 1 : null, chart: undefined };
}

// One word for the shape, then the reason. Order matters: a break of the 60-session band is the
// strongest statement, a 5-session move against the 20 is the earliest, and a 20-session move a
// standard deviation out with the last week agreeing is a trend building.
export const FLAT_20D = 0.0005;
export function trendRead(st, { turnMin = TREND.turnMin } = {}) {
  if (!st || st.ch20 == null) return null;
  // Under 0.05% over 20 sessions prints as 0.0% and is flat: no arrow, no meaning claimed.
  const dir = Math.abs(st.ch20) < FLAT_20D ? 'flat' : st.ch20 > 0 ? 'up' : 'down';
  if (st.broke) return { dir: st.broke === 'above' ? 'up' : 'down', shape: 'breakout', words: `broke ${st.broke} its 60-session range` };
  if (st.ch5 != null && Math.abs(st.ch5) >= turnMin && Math.sign(st.ch5) !== Math.sign(st.ch20) && dir !== 'flat')
    return { dir, shape: 'turning', words: 'reversing' };
  if (st.z != null && Math.abs(st.z) >= TREND.zBuilding && st.ch5 != null && Math.sign(st.ch5) === Math.sign(st.ch20))
    return { dir, shape: 'trend', words: st.fast ? 'trend building, unusually fast' : 'trend building' };
  return { dir, shape: 'range', words: 'inside its range' };
}

const pct = (v, dp = 1) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(dp)}%`);
const arrow = (d) => (d === 'up' ? '▲' : d === 'down' ? '▼' : '▶');
const lvl = (v) => (v == null ? '—' : v >= 1000 ? Math.round(v).toLocaleString('en-US') : v >= 10 ? v.toFixed(2) : v.toFixed(4));

// The 20-session direction in the reader's frame: for FX, the dollar's; for everything else, the
// instrument's own. `means` keys on the instrument's direction.
function fxUsdDir(def, dir) {
  if (def.usd === 'quote') return dir === 'up' ? 'down' : dir === 'down' ? 'up' : dir;
  return dir;
}

// The words after a row's numbers. A reversal leads with what the 20 days mean and then says the
// last 5 days are undoing it, so the meaning never reads as the current direction by accident.
function rowWords(t, words, meaning, ch5) {
  if (t.shape === 'turning') return `${meaning ? `over 20 days, ${meaning}` : '20-day move'} · **reversing:** ${pct(ch5)} in the last 5 days`;
  return `${words}${meaning ? `: ${meaning}` : ''}`;
}

export function fxRow(def, closes) {
  const st = seriesStats(closes);
  if (!st) return null;
  const t = trendRead(st);
  const flip = (v) => (v == null ? null : def.usd === 'quote' ? -v : v);
  const usd = fxUsdDir(def, t.dir);
  // `means` for EUR/GBP/AUD is written in the dollar's direction already (dollar firmer / softer),
  // for the base pairs and the index in the instrument's.
  const meaning = def.usd === 'quote' ? def.means[usd === 'up' ? 'up' : 'down'] : def.means[t.dir === 'up' ? 'up' : 'down'];
  // A break is said in the DOLLAR's frame too: EUR/USD breaking below its range is the dollar
  // breaking above it, and the row's arrow is the dollar's.
  const words = t.shape === 'breakout' ? `${def.usd === 'index' ? 'broke' : 'USD broke'} ${usd === 'up' ? 'above' : 'below'} its 60-session range` : t.words;
  return { sym: def.sym, short: def.short, name: def.name, last: st.last, date: st.date,
           usd1: flip(st.ch1), usd5: flip(st.ch5), usd20: flip(st.ch20), trend: t, usdDir: usd,
           line: `**${def.short}** ${lvl(st.last)} · USD ${pct(flip(st.ch1), 2)} 1d · ${pct(flip(st.ch5))} 5d · ${pct(flip(st.ch20))} 20d ${arrow(usd)} — ${rowWords(t, words, t.dir !== 'flat' ? meaning : null, flip(st.ch5))}` };
}

export function crossRow(def, closesBySym) {
  let closes = closesBySym[def.sym];
  if (def.num) {
    const den = new Map(closesBySym[def.den] || []);
    closes = (closesBySym[def.num] || []).filter(([d]) => den.has(d)).map(([d, v]) => [d, v / den.get(d)]);
  }
  const st = seriesStats(closes);
  if (!st) return null;
  const t = trendRead(st);
  const meaning = t.dir === 'flat' ? null : def.means[t.dir];
  const level = def.num ? (st.last * 1000).toFixed(2) + '‰' : lvl(st.last);
  const chg = def.vol ? `${st.ch1 == null ? '—' : pct(st.ch1)} 1d · ${pct(st.ch5)} 5d · ${pct(st.ch20)} 20d`
    : `${pct(st.ch1)} 1d · ${pct(st.ch5)} 5d · ${pct(st.ch20)} 20d`;
  return { id: def.id || def.sym, short: def.short, name: def.name, last: st.last, date: st.date, trend: t, yearPos: st.yearPos,
           line: `**${def.name}** ${level} · ${chg} ${arrow(t.dir)} — ${rowWords(t, t.words, meaning, st.ch5)}` };
}

// Dollar breadth: how many legs agree with the index over 20 sessions. The index is 58% euro, so a
// dollar firm on the index and soft on half the legs is a euro story, not a dollar one.
export function dollarBreadth(rows) {
  const legs = rows.filter(r => r.sym !== 'DX-Y.NYB' && r.usd20 != null);
  if (!legs.length) return null;
  const up = legs.filter(r => r.usd20 > 0).length;
  const n = legs.length;
  const word = up === n ? 'firmer against every leg' : up === 0 ? 'softer against every leg'
    : up * 2 > n ? `firmer against ${up} of ${n} legs` : `softer against ${n - up} of ${n} legs`;
  return `👉 Over 20 sessions the dollar is ${word}${up !== 0 && up !== n ? ' — read the legs, not the index' : ''}.`;
}

// ── THE RATIOS ───────────────────────────────────────────────────────────────
export function ratioRows(closes, { now = Date.now() } = {}) {
  const built = CARDS.map(c => buildCard(c, closes, { now }));
  const lines = built.map(b => {
    if (!b.stats) return `**${b.card.short}** — waiting on data`;
    const st = b.stats;
    const dir = Math.abs(st.ch20) < FLAT_20D ? 'flat' : st.ch20 > 0 ? 'up' : 'down';
    const means = b.card.means?.[dir] || null;
    // PLAIN WORDS, IN ORDER (24 Nov 2026): the 20-day move and what it means, then — only when
    // the last 5 days run against it — that it is reversing and by how much, then where the
    // ratio sits against its 60-day range. No bare "↩ failed" or "the other way".
    const rev = turning(st) ? ` · **reversing:** ${pct(st.ch5)} in the last 5 days` : '';
    const prose = stageProse(b.track);
    const brk = prose ? ` · ${prose}` : '';
    const edge = st.yearPos > 0.9 ? ' · near its 1-year high' : st.yearPos < 0.1 ? ' · near its 1-year low' : '';
    return `**${b.card.short}** ${arrow(dir)} ${pct(st.ch20)} 20d${rev ? '' : ` · ${pct(st.ch5)} 5d`}${means ? ` — ${means}` : ''}${rev}${brk}${edge}`;
  });
  const sum = summaryRead(built);
  return { built, lines, headline: sum.headline, rows: sum.rows, live: built.filter(b => isActive(b.track)).length };
}

// ── THE SNAPSHOT THE REGIONAL BRIEFS COMPARE AGAINST ─────────────────────────
// Live-quote figures and the global tripwire states, at post time. Ratios and the trend-fund model
// move only on a daily close, which no regional brief sees before the next Overview, so they are
// not part of the delta.
export const GLOBAL_DELTA_MIN = Object.freeze({
  vix: 1.0,       // VIX points
  oas: 0.05,      // percentage points
  us10y: 0.05, us30y: 0.05,   // percentage points
  wti: 2.0,       // per cent
  gold: 1.0,      // per cent
  dxy: 0.4,       // per cent
  usdjpy: 0.6,    // per cent
  cnh: 0.3,       // per cent
});

export function globalDeltaLine(now = {}, snap = null, { at = null, ref = new Date() } = {}) {
  if (!snap) return null;
  // The time alone when the Overview is the last one (under a day old); the date too when a holiday
  // or a missed post makes it older, so a stale baseline is never read as last night's.
  const ageH = at ? ((ref instanceof Date ? ref : new Date(ref)) - new Date(at)) / 3600000 : null;
  const when = !at ? '' : ageH != null && ageH > 26 ? ` (${String(at).slice(5, 10)} ${String(at).slice(11, 16)}Z)` : ` (${String(at).slice(11, 16)}Z)`;
  const out = [];
  const a = snap.wires || {}, b = now.wires || {};
  for (const name of Object.keys(b)) {
    if (!(name in a) || a[name] == null || b[name] == null || a[name] === b[name]) continue;
    out.push(b[name] ? `🔴 ${name}` : `🟢 ${name} no longer true`);
  }
  const pts = (key, label, unit, fmt = (v) => v) => {
    const x = snap[key], y = now[key];
    if (!Number.isFinite(+x) || !Number.isFinite(+y) || Math.abs(+y - +x) < GLOBAL_DELTA_MIN[key]) return;
    out.push(`${label} ${fmt(+x)} → **${fmt(+y)}**${unit}`);
  };
  const pc = (key, label, fmt = (v) => v) => {
    const x = +snap[key], y = +now[key];
    if (!(x > 0) || !(y > 0)) return;
    const d = (y / x - 1) * 100;
    if (Math.abs(d) < GLOBAL_DELTA_MIN[key]) return;
    out.push(`${label} **${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}%** (${fmt(x)} → ${fmt(y)})`);
  };
  pts('vix', 'VIX', '', v => v.toFixed(1));
  pts('oas', 'credit', 'pp', v => v.toFixed(2));
  pts('us10y', '10yr', '%', v => v.toFixed(2));
  pts('us30y', '30yr', '%', v => v.toFixed(2));
  pc('wti', 'oil', v => v.toFixed(2));
  pc('gold', 'gold', v => Math.round(v).toLocaleString('en-US'));
  pc('dxy', 'dollar', v => v.toFixed(2));
  pc('usdjpy', 'USD/JPY', v => v.toFixed(2));
  pc('cnh', 'USD/CNH', v => v.toFixed(4));
  return out.length
    ? `🌐 **GLOBAL** · since the Overview${when}: ${out.join(' · ')}`
    : `🌐 **GLOBAL** · nothing material has moved since the Overview${when}`;
}

// ── THE WEEK, GLOBALLY ───────────────────────────────────────────────────────
// What moves every market: central banks, the US releases that set rates, and the tier-1 events
// the calendar already marks as global. Upcoming only, the next seven days.
export const GLOBAL_EVENT_RE = /FOMC|\bFed\b|Beige Book|ECB|\bBoJ\b|\bBoE\b|PBoC|RBA|SNB|\bCPI\b|\bPCE\b|payrolls|nonfarm|\bGDP\b/i;
export function globalCalendar(events = [], { today, days = 7 } = {}) {
  if (!today) return [];
  const end = new Date(Date.parse(`${today}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const dow = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
  return (events || [])
    .filter(e => e?.date && !e.reported && e.date > today && e.date <= end)
    .filter(e => e.scope === 'global' || e.tier === 1 || GLOBAL_EVENT_RE.test(e.title || ''))
    .map(e => `**${dow(e.date)}** ${String(e.title).split(' — ')[0]}${e.time ? ` · ${e.time}${e.tz === 'America/New_York' ? ' ET' : e.tz ? ` ${e.tz.split('/').pop().replace('_', ' ')}` : ''}` : ''}`);
}

// ── THE POST ─────────────────────────────────────────────────────────────────
export const GLOBAL_HEAD = '🌐 **DAILY GLOBAL MACRO OVERVIEW**';
// ── THE WEEKEND EDITION (23 Nov 2026) ─────────────────────────────────────────────────────────────
// Friday's Overview is posted on Sunday evening (18:20 ET), after CME futures reopen and before Asia
// opens, with one extra section: what moved since Friday's 16:00 ET close. Raw Yahoo chart bars.
export const WEEKEND_LEGS = Object.freeze([
  ['ES=F', 'S&P 500 futures'], ['NQ=F', 'Nasdaq 100 futures'], ['ZN=F', '10-year note futures'],
  ['BTC-USD', 'Bitcoin'], ['ETH-USD', 'Ether'], ['JPY=X', 'USD/JPY'], ['EURUSD=X', 'EUR/USD'], ['DX-Y.NYB', 'Dollar index'],
]);
const nyParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const nyDateMin = (sec) => {
  const p = Object.fromEntries(nyParts.formatToParts(new Date(sec * 1000)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
};
// One leg's move: the last bar at or before Friday 16:00 ET (`session`, the Friday) against the latest bar.
export function weekendMove(ts = [], closes = [], session) {
  let ref = null, now = null;
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c !== 'number') continue;
    const t = nyDateMin(ts[i]);
    if (t.date < session || (t.date === session && t.min < 16 * 60)) ref = c;
    now = c;
  }
  return ref && now ? { ref, now, chg: now / ref - 1 } : null;
}
export async function fetchWeekendMoves(session, { fetchImpl = fetch } = {}) {
  const out = [];
  for (const [sym, label] of WEEKEND_LEGS) {
    try {
      const r = await fetchImpl(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=5d&includePrePost=true`,
        { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      const res = r.ok ? (await r.json())?.chart?.result?.[0] : null;
      const m = res ? weekendMove(res.timestamp || [], res.indicators?.quote?.[0]?.close || [], session) : null;
      out.push({ sym, label, ...(m || {}), ok: !!m });
    } catch { out.push({ sym, label, ok: false }); }
  }
  return out;
}
const fmtPx = (sym, x) => (sym.includes('=X') && !sym.startsWith('JPY') ? x.toFixed(4) : x >= 1000 ? Math.round(x).toLocaleString('en-US') : x.toFixed(2));
export function weekendLines(moves = []) {
  const ok = moves.filter(m => m.ok);
  if (!ok.length) return null;
  return ok.map(m => `${m.label} ${fmtPx(m.sym, m.now)} · **${m.chg >= 0 ? '+' : '−'}${Math.abs(m.chg * 100).toFixed(1)}%**`);
}

export function assembleGlobal(b = {}, { at = new Date() } = {}) {
  const RULE = '───────────────';
  const stamp = (at instanceof Date ? at : new Date(at)).toISOString().slice(0, 16).replace('T', ' ');
  const sec = (head, body) => (body ? [`${head}\n${body}`] : []);
  const bullets = (ls) => { const x = (ls || []).filter(Boolean); return x.length ? x.map(l => `• ${l}`).join('\n') : null; };
  const sections = [
    ...sec('🌙 **SINCE FRIDAY\'S CLOSE** (to the futures reopen)', bullets(b.weekend)),
    ...sec(b.headlinesFrom === 'rss' ? '📰 **WEEKEND HEADLINES** _(latest from the feeds, not ranked)_' : '📰 **WEEKEND HEADLINES**', bullets(b.headlines)),
    ...sec('⚖️ **RATIOS**', b.ratios ? [b.ratios.headline ? `👉 **Over 20 days:** ${b.ratios.headline}` : null, bullets(b.ratios.lines)].filter(Boolean).join('\n') : null),
    ...sec('💱 **FX**', b.fx ? [bullets(b.fx.lines), b.fx.breadth].filter(Boolean).join('\n') : null),
    ...sec('🧭 **CROSS-ASSET**', bullets(b.cross)),
    ...sec('💵 **RATES, CREDIT, INFLATION**', bullets(b.money)),
    ...sec('📐 **TREND FUNDS (CTA MODEL)**', b.ctaLines || null),
    ...sec('📆 **THIS WEEK**', bullets(b.calendar)),
    ...sec('🔀 **WHAT WOULD CHANGE IT**', b.changeLines || null),
  ];
  return [
    `${GLOBAL_HEAD}${b.weekend ? ' · WEEKEND EDITION' : ''} · ${stamp}Z`,
    b.weekend
      ? '_Friday\'s close, posted after the Sunday futures reopen. Ratios, FX and cross-asset are read over 1, 5 and 20 sessions to Friday; the first section is what moved since._'
      : '_After the US close. Ratios, FX and cross-asset are read over 1, 5 and 20 sessions; "60-session range" is the band of the 60 sessions before today._',
    ...sections.flatMap(s => [RULE, s]),
    RULE,
    '*👉 = what the arrangement is consistent with, never what to do · the regional pre-reads carry one 🌐 line for what moved since this post*',
  ].join('\n\n');
}

// Daily closes for every leg, a few at a time with a pause, as the ratio break log fetches them.
export async function fetchCloses(symbols, { fetchCloses: get, range = '2y', batch = 4, pauseMs = 120 } = {}) {
  const out = {};
  for (let i = 0; i < symbols.length; i += batch) {
    if (i > 0 && pauseMs) await new Promise(r => setTimeout(r, pauseMs));
    await Promise.all(symbols.slice(i, i + batch).map(async (s) => {
      const d = await get(s, range).catch(() => null);
      out[s] = d?.ok ? d.closes : [];
    }));
  }
  return out;
}
