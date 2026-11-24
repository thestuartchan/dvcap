// lib/rssHeadlines.js — the weekend edition's RSS fallback.
import { parseRss, decode, isFiller, sameStory, fridayCloseMs, pickRss, fetchRssHeadlines } from '../lib/rssHeadlines.js';
import { assembleGlobal } from '../lib/globalMacro.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w); if (a === b) { pass++; console.log('✅', n); } else { fail++; console.log('❌', n, ' got', a, 'want', b); } };

const item = (title, date) => `<item><guid>x</guid><title>${title}</title><link>https://example.test/a</link><pubDate>${date}</pubDate></item>`;
const xml = `<?xml version="1.0"?><rss><channel><title>Feed</title>${[
  item('Acme Corp&#x2019;s shares jump on &amp; guidance', 'Sat, 21 Nov 2026 15:00:00 GMT'),
  item('<![CDATA[Futures edge higher at the reopen]]>', 'Sun, 22 Nov 2026 23:10:00 GMT'),
  item('No date here', ''),
].join('')}</channel></rss>`;
const parsed = parseRss(xml);
eq('parses titled, dated items only', parsed.length, 2);
eq('decodes entities', parsed[0].title, 'Acme Corp’s shares jump on & guidance');
eq('unwraps CDATA', parsed[1].title, 'Futures edge higher at the reopen');
eq('strips tags', decode('<b>Bold</b> move'), 'Bold move');

eq('advice column is filler', isFiller('I’ve paid for long-term-care insurance for 20 years. Is it still worth it?'), true);
eq('family money is filler', isFiller('I’ve been married for 58 years. It’s ‘our’ money'), true);
eq('live-blog shell is filler', isFiller('Stock Market News, Nov. 23, 2026: Futures rise'), true);
eq('opinion is filler', isFiller('Opinion | Give Thanks to Inverse Billionaires'), true);
eq('lifestyle is filler', isFiller('Boomers Are Rewriting the Playbook for Old Age'), true);
eq('a reissued title is the same story', sameStory('HPE just posted its strongest growth ever — but its stock is sinking', 'HPE just posted its strongest growth ever — but its stock is wavering'), true);
eq('different stories differ', sameStory('Oil slips as talks resume', 'Futures rise at the Sunday reopen'), false);
eq('a market story is kept', isFiller('U.S. stocks book best day since April 2025 as rally broadens'), false);

eq('Friday close in EST is 21:00Z', new Date(fridayCloseMs('2026-11-20')).toISOString(), '2026-11-20T21:00:00.000Z');
eq('Friday close in EDT is 20:00Z', new Date(fridayCloseMs('2026-06-19')).toISOString(), '2026-06-19T20:00:00.000Z');

const at = (s) => Date.parse(s);
const now = at('2026-11-22T23:20:00Z');
const feeds = [
  { provider: 'MarketWatch', items: [
    { title: 'Friday afternoon story', at: at('2026-11-20T20:30:00Z') },          // before the close
    { title: 'Oil slips as talks resume', at: at('2026-11-22T12:00:00Z') },
    { title: 'Should I retire early?', at: at('2026-11-22T13:00:00Z') },             // filler
    { title: 'Futures rise at the Sunday reopen', at: at('2026-11-22T23:05:00Z') },
    { title: 'A story from the future', at: at('2026-11-23T02:00:00Z') },          // after now
  ] },
  { provider: 'WSJ', items: [
    { title: 'Futures Rise at the Sunday Reopen', at: at('2026-11-22T23:06:00Z') },  // duplicate title
    { title: 'Chip stocks face a test this week', at: at('2026-11-21T10:00:00Z') },
  ] },
];
const lines = pickRss(feeds, '2026-11-20', { now });
eq('takes the feeds in turn, newest first, skipping old, future, filler and duplicates', lines, [
  'Futures rise at the Sunday reopen _(MarketWatch)_',
  'Chip stocks face a test this week _(WSJ)_',
  'Oil slips as talks resume _(MarketWatch)_',
]);
eq('at most four', pickRss([{ provider: 'P', items: Array.from({ length: 9 }, (_, i) => ({ title: ['Oil slips as talks resume','Gold hits a record high','Copper rallies on China data','Bonds sell off before PCE','Dollar firms against the yen','Bitcoin drops below support','Wheat jumps on drought fears','Silver tracks gold higher','Banks lead European futures'][i], at: at('2026-11-22T12:00:00Z') + i })) }], '2026-11-20', { now }).length, 4);
eq('nothing qualifying is null', pickRss([{ provider: 'P', items: [] }], '2026-11-20', { now }), null);
const long = pickRss([{ provider: 'P', items: [{ title: 'word '.repeat(60).trim(), at: at('2026-11-22T12:00:00Z') }] }], '2026-11-20', { now })[0];
eq('long titles are clipped to 160', long.replace(' _(P)_', '').length <= 160 && long.includes('…'), true);

const fake = (map) => async (url) => (map[url] ? { ok: true, text: async () => map[url] } : { ok: false, text: async () => '' });
const got = await fetchRssHeadlines('2026-11-20', { now: at('2026-11-23T00:00:00Z'), fetchImpl: fake({ 'https://a.test/rss': xml }),
  feeds: [{ url: 'https://a.test/rss', provider: 'Feed A' }, { url: 'https://b.test/rss', provider: 'Feed B' }] });
eq('a failing feed is skipped, the other is read', got, ['Futures edge higher at the reopen _(Feed A)_', 'Acme Corp’s shares jump on & guidance _(Feed A)_']);
const none = await fetchRssHeadlines('2026-11-20', { fetchImpl: async () => { throw new Error('down'); }, feeds: [{ url: 'https://b.test/rss', provider: 'B' }] });
eq('every feed down is null', none, null);

eq('the edition labels feed headlines', assembleGlobal({ weekend: ['a'], headlines: ['x _(WSJ)_'], headlinesFrom: 'rss' }).includes('WEEKEND HEADLINES** _(latest from the feeds, not ranked)_'), true);
eq('picked headlines carry no label', assembleGlobal({ weekend: ['a'], headlines: ['x _(WSJ)_'] }).includes('not ranked'), false);
console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exit(1);
