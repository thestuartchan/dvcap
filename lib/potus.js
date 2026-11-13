// lib/potus.js — the President's Truth Social posts and public schedule, to the PRIVATE channel only
// (Stu, 13 Nov 2026: "a private trump activity feed into my private discord channel").
//
// Source: Unusual Whales /api/potus/posts and /api/potus/schedule (licensed for personal use, so
// the locked channel only, never a shared one, never a job answer or a public route).
//   posts     checked every 5 minutes; only MARKET-RELEVANT posts are sent (Stu's choice): ones that
//             name a market topic, a large company, or a Desk / Trading Ideas ticker. The words that
//             matched are shown, so the filter can be judged. A display filter, not a signal.
//   schedule  one card each morning (Dubai) with the latest scheduled day; interviews and remarks
//             carry their transcript link. Routine entries (pool call time, executive time) are left out.

// Market topics, as whole words or phrases (case-insensitive).
export const POTUS_TOPICS = Object.freeze([
  'tariff', 'tariffs', 'duties', 'trade deal', 'trade war', 'import', 'imports', 'export controls', 'sanction', 'sanctions',
  'fed', 'federal reserve', 'powell', 'interest rate', 'interest rates', 'rate cut', 'rates', 'inflation', 'recession',
  'economy', 'jobs report', 'gdp', 'treasury', 'bond', 'bonds', 'dollar', 'debt ceiling', 'stock market',
  'dow', 'nasdaq', 's&p', 'markets', 'oil', 'opec', 'gas prices', 'gasoline', 'energy', 'drill',
  'china', 'xi', 'iran', 'strait', 'hormuz', 'mexico', 'canada', 'russia', 'ukraine', 'venezuela', 'israel', 'japan', 'india', 'eu', 'european union',
  'crypto', 'bitcoin', 'stablecoin', 'chips', 'semiconductor', 'semiconductors', 'ai', 'pharma', 'drug prices',
  'reconciliation bill', 'shutdown', 'stimulus', 'tax cut', 'tax cuts',
]);
// Companies by name (the ticker the card shows beside it).
export const POTUS_COMPANIES = Object.freeze({
  nvidia: 'NVDA', apple: 'AAPL', microsoft: 'MSFT', amazon: 'AMZN', google: 'GOOGL', alphabet: 'GOOGL', meta: 'META', facebook: 'META',
  tesla: 'TSLA', intel: 'INTC', amd: 'AMD', boeing: 'BA', lilly: 'LLY', pfizer: 'PFE', walmart: 'WMT', jpmorgan: 'JPM',
  exxon: 'XOM', chevron: 'CVX', oracle: 'ORCL', tiktok: null, netflix: 'NFLX', disney: 'DIS', ford: 'F', 'general motors': 'GM',
  'u.s. steel': 'X', 'us steel': 'X', micron: 'MU', tsmc: 'TSM', broadcom: 'AVGO', palantir: 'PLTR', coinbase: 'COIN', 'goldman sachs': 'GS',
});

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w) => new RegExp(`(^|[^A-Za-z0-9])${esc(w)}($|[^A-Za-z0-9])`, 'i');
const TOPIC_RES = POTUS_TOPICS.map(w => [w, wordRe(w)]);
const COMPANY_RES = Object.entries(POTUS_COMPANIES).map(([w, t]) => [w, t, wordRe(w)]);

// Why a post is market-relevant: the topics, companies and tickers it names. Empty → not sent.
// `tickers`: the Desk and Trading Ideas tickers (matched as whole UPPER-CASE words or $TICKER).
export function marketWhy(post, { tickers = [] } = {}) {
  const text = String(post || '');
  const why = [];
  for (const [w, re] of TOPIC_RES) if (re.test(text)) why.push(w);
  for (const [w, t, re] of COMPANY_RES) if (re.test(text)) why.push(t ? `${w} (${t})` : w);
  for (const t of tickers) {
    if (!t || t.length < 2) continue;
    if (new RegExp(`(^|[^A-Za-z0-9])\\$?${esc(t)}($|[^A-Za-z0-9])`).test(text)) why.push(`$${t}`);
  }
  return [...new Set(why)].slice(0, 8);
}

const rowsOf = (a) => (Array.isArray(a) ? a : Array.isArray(a?.data) ? a.data : []);
// Posts newer than `since` (ms), oldest first, each with its reasons.
export function newPosts(answer, { since = 0, tickers = [] } = {}) {
  return rowsOf(answer)
    .map(p => ({ at: Number(p?.timestamp), text: String(p?.post || '').trim() }))
    .filter(p => Number.isFinite(p.at) && p.at > since && p.text)
    .sort((a, b) => a.at - b.at)
    .map(p => ({ ...p, why: marketWhy(p.text, { tickers }) }));
}

const clock = (ms) => {
  const d = new Date(ms);
  const f = (tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  return `${day} ${f('Asia/Dubai')} Dubai (${f('America/New_York')} ET)`;
};

// One message, one embed per post (Discord allows 10; the rest wait for the next run).
export function postsCard(posts) {
  const list = (posts || []).filter(p => p.why?.length).slice(0, 10);
  if (!list.length) return null;
  return {
    allowed_mentions: { parse: [] },
    embeds: list.map(p => ({
      title: `🇺🇸 Trump post · ${clock(p.at)}`.slice(0, 256),
      description: p.text.slice(0, 3800),
      color: 0xB22234,
      fields: [{ name: 'Why it is here', value: p.why.join(' · ').slice(0, 1024), inline: false }],
      footer: { text: 'Truth Social via Unusual Whales · personal use · private channel only' },
      timestamp: new Date(p.at).toISOString(),
    })),
  };
}

// ── THE SCHEDULE ─────────────────────────────────────────────────────────────
const ROUTINE = /pool call time|executive time|lid called|lunch lid/i;
export function scheduleOf(answer) {
  const rows = rowsOf(answer).filter(r => r?.details && !ROUTINE.test(r.details) && r.type !== 'Pool Report Schedule');
  const day = rows.map(r => r.date).filter(Boolean).sort().at(-1) || null;
  return { day, items: rows.filter(r => r.date === day).sort((a, b) => String(a.time).localeCompare(String(b.time))) };
}
const etTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d); };
const dubaiTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d); };
const dayWord = (d) => { const t = new Date(`${d}T12:00:00Z`); return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); };

export function scheduleCard({ day, items } = {}) {
  if (!day || !items?.length) return null;
  const fields = items.slice(0, 20).map(r => ({
    name: `${dubaiTime(r.time)} Dubai (${etTime(r.time)} ET)${r.location ? ` · ${r.location}` : ''}`.slice(0, 256),
    value: [String(r.details).replace(/^The President /, ''), r.coverage ? `*${r.coverage}*` : '', r.url ? `[Transcript](${r.url})` : ''].filter(Boolean).join('\n').slice(0, 1024),
    inline: false,
  }));
  return {
    allowed_mentions: { parse: [] },
    embeds: [{ title: `🇺🇸 Trump's schedule · ${dayWord(day)}`, color: 0xB22234, fields,
      description: 'The public schedule (routine pool calls and executive time left out).',
      footer: { text: 'White House schedule via Unusual Whales · personal use · private channel only' } }],
  };
}
