// lib/rssHeadlines.js — the weekend edition's FALLBACK headlines (Stu, 24 Nov 2026).
//
// WHY. The weekend headlines normally come from a Sunday Claude task through the door in
// lib/weekendHeadlines.js. That task is tied to one chat session, so if the session ends the
// headlines would quietly stop. When no picked set is stored for the Friday, the edition reads
// public RSS feeds here instead, server-side, with no model involved.
//
// WHAT IT PRINTS. Each outlet's own headline, verbatim, with the outlet named, as RSS is published
// to be shown. Only stories published after Friday's 16:00 ET close and before now; obvious filler
// (personal finance, lifestyle, opinion, advice columns) is dropped; one line per story (near-identical
// reissued titles count once); the feeds are taken
// in turn, newest first; at most MAX_ITEMS. No ranking by importance: the edition labels the section
// so the reader knows these are the feeds' latest, not a picked set.
//
// FEEDS. The Fed's press releases (policy items only), then Dow Jones' public feeds (MarketWatch
// bulletins and top stories, WSJ Markets). CNBC's feeds
// refused automated reads when this was built (24 Nov 2026), so they are not used. A feed that fails
// or times out is skipped; the section is omitted when none answers.
export const RSS_FEEDS = Object.freeze([
  // The Fed's press releases, policy items only (statements, minutes, rates, facilities, stress
  // tests, capital rules, the Chair's and Governors' remarks); enforcement actions, contest
  // winners, comment periods and service pricing are dropped. Listed first so a weekend Fed
  // release leads the section.
  { url: 'https://www.federalreserve.gov/feeds/press_all.xml', provider: 'Federal Reserve',
    keep: /\b(FOMC|Federal Open Market Committee|monetary policy|statement|minutes|interest rates?|discount rate|balance sheet|facility|facilities|liquidity|swap lines?|stress tests?|capital (requirements?|rules?)|emergency|Chair|Vice Chair|Governor)\b/i,
    drop: /\b(enforcement action|College Fed Challenge|comment period|pricing|winners|appoint|community|termination|application)\b/i },
  { url: 'https://feeds.content.dowjones.io/public/rss/mw_bulletins', provider: 'MarketWatch' },
  { url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain', provider: 'WSJ' },
  { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', provider: 'MarketWatch' },
]);
export const MAX_ITEMS = 4, MAX_LINE = 160;

// Filler: personal finance, advice columns, opinion, lifestyle and daily live-blog shells.
const FILLER = [
  /\b(I|I'm|I've|I’m|I’ve|my|we|we're|we’re)\b.*\?$/i,
  /\b(retire|retirement|retiree|annuit|long-term-care|insurance|inheritance|estate plan|social security|401\(k\)|IRA\b|mortgage|credit score|credit[- ]cards?|budget|paycheck|tax refund)/i,
  /\b(married|wife|husband|divorce|my (mother|father|mom|dad|son|daughter|sister|brother)|girlfriend|boyfriend)\b/i,
  /\b(recipe|travel|vacation|horoscope|wedding|fortune|wealth|net worth|lifestyle|how to|should I)\b/i,
  /^(opinion\b|review\b|commentary\b|stock market news|the morning risk report|live:|watch:|podcast|quiz)/i,
  /\b(boomers?|old age|gen z|millennials?|luxury|watch(es)? industry|fashion|celebrity|dating)\b/i,
];
export const isFiller = (title) => FILLER.some(re => re.test(title));

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decode(s = '') {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ').trim();
}

// RSS 2.0 → [{ title, at (ms) }]. Items without a title or a readable date are dropped.
export function parseRss(xml = '') {
  const out = [];
  for (const m of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const tag = (n) => { const t = m[1].match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`, 'i')); return t ? decode(t[1]) : ''; };
    const title = tag('title'), at = Date.parse(tag('pubDate'));
    if (title && Number.isFinite(at)) out.push({ title, at });
  }
  return out;
}

// Friday 16:00 New York as a UTC instant (EST or EDT, whichever applies that day).
export function fridayCloseMs(session) {
  const noon = Date.parse(`${session}T12:00:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(noon)).map(x => [x.type, x.value]));
  const offsetH = 12 - Number(p.hour); // 5 in EST, 4 in EDT
  return Date.parse(`${session}T16:00:00Z`) + offsetH * 3600e3;
}

const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Near-duplicates: an outlet often reissues a story with one word changed ("sinking" / "wavering").
const words = (t) => new Set(norm(t).split(' ').filter(w => w.length > 2));
export function sameStory(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  let both = 0; for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both) >= 0.6;
}
const clip = (t) => (t.length <= MAX_LINE ? t : `${t.slice(0, MAX_LINE - 1).replace(/\s+\S*$/, '')}…`);

// [{ provider, items }] → printed lines, or null when nothing qualifies.
export function pickRss(feeds = [], session, { now = Date.now(), max = MAX_ITEMS } = {}) {
  const since = fridayCloseMs(session), seen = [];
  const queues = feeds.map(f => ({ provider: f.provider, items: (f.items || [])
    .filter(it => it.at >= since && it.at <= now && !isFiller(it.title)
      && (!f.keep || f.keep.test(it.title)) && !(f.drop && f.drop.test(it.title)))
    .sort((a, b) => b.at - a.at) }));
  const lines = [];
  for (let round = 0; lines.length < max && queues.some(q => q.items.length); round++) {
    for (const q of queues) {
      while (q.items.length) {
        const it = q.items.shift();
        if (seen.some(t => sameStory(t, it.title))) continue;
        seen.push(it.title);
        lines.push(`${clip(it.title).replace(/https?:\/\/\S+|@(everyone|here)/gi, '').trim()} _(${q.provider})_`);
        break;
      }
      if (lines.length >= max) break;
    }
  }
  return lines.length ? lines : null;
}

export async function fetchRssHeadlines(session, { fetchImpl = fetch, now = Date.now(), feeds = RSS_FEEDS } = {}) {
  const got = await Promise.all(feeds.map(async (f) => {
    try {
      const r = await fetchImpl(f.url, { headers: { 'User-Agent': 'rss-reader/1.0', Accept: 'application/rss+xml, application/xml' }, signal: AbortSignal.timeout(6000) });
      return r.ok ? { provider: f.provider, keep: f.keep, drop: f.drop, items: parseRss(await r.text()) } : null;
    } catch { return null; }
  }));
  return pickRss(got.filter(Boolean), session, { now });
}
