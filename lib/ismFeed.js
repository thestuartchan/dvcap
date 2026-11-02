// lib/ismFeed.js — the ISM PMIs, read from ISM's own release on PR Newswire (2 Nov 2026).
//
// ISM's report page sits behind a member login, so the growth axis's ISM leg was keyed by hand
// each month, and a missed month dropped the leg (September services was never entered). ISM
// distributes the same release through PR Newswire, public and plain HTML, on release day:
//   newsroom   prnewswire.com/news/institute-for-supply-management/ lists each release, its slug
//              naming the figure and month: manufacturing-pmi-at-54-5-september-2026-ism-...
//   release    the release's own table: "Manufacturing PMI® 54.5 54.6" (this month, last month)
//              and "New Orders 55.3 53.7"; the text says "PMI® registered 54.5 percent"
// A release is used only when the table's headline and the text's agree, so a reworded page or a
// table that moved reads as nothing rather than as a wrong number. The hand entry still wins for
// its own month (mergeIsm), the way a typed Fed-path settle outranks the futures strip.
// Pure: parsing and merging only, so the app can import it. lib/ismFetch.js fetches and caches.

export const ISM_NEWSROOM_URL = 'https://www.prnewswire.com/news/institute-for-supply-management/';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export const ISM_MONTHS_BACK = 3;   // releases read per survey: enough to fill a missed month and give the change

// Newsroom page → [{ kind: 'manufacturing'|'services', period: 'YYYY-MM', url }], newest period first.
export function ismLinksFromNewsroom(html, base = 'https://www.prnewswire.com') {
  const out = new Map();
  const re = /\/news-releases\/(manufacturing|services)-pmi-at-[\d-]+?-(january|february|march|april|may|june|july|august|september|october|november|december)-(\d{4})-ism-(?:manufacturing|services)-pmi-report-\d+\.html/g;
  for (const m of String(html || '').matchAll(re)) {
    const period = `${m[3]}-${String(MONTHS.indexOf(m[2]) + 1).padStart(2, '0')}`;
    const key = `${m[1]}|${period}`;
    if (!out.has(key)) out.set(key, { kind: m[1], period, url: new URL(m[0], base).toString() });
  }
  return [...out.values()].sort((a, b) => b.period.localeCompare(a.period) || a.kind.localeCompare(b.kind));
}

const plain = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&reg;/g, '®').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');

// One release → { kind, pmi, prior, newOrders, newOrdersPrior, published } or null.
export function ismFromRelease(html, kind) {
  const s = plain(html);
  const label = kind === 'services' ? 'Services' : 'Manufacturing';
  const table = new RegExp(`${label} PMI\\s*®\\s+([\\d.]+)\\s+([\\d.]+)`).exec(s);
  const text = /PMI\s*®\s+registered\s+([\d.]+)\s+percent/.exec(s);
  if (!table || !text || Number(table[1]) !== Number(text[1])) return null;
  const no = /New Orders\s+([\d.]+)\s+([\d.]+)/.exec(s);
  const pub = /<meta name="date" content="(\d{4}-\d{2}-\d{2})/.exec(String(html || ''));
  return {
    kind, pmi: Number(table[1]), prior: Number(table[2]),
    newOrders: no ? Number(no[1]) : null, newOrdersPrior: no ? Number(no[2]) : null,
    published: pub ? pub[1] : null,
  };
}

// Releases → the store's shape: series rows { period, manufacturing, newOrders, services, asOf, source }.
// asOf is the manufacturing release date (the date the growth leg ages from).
export function ismSeries(releases = []) {
  const by = new Map();
  for (const r of releases) {
    if (!r?.period) continue;
    const row = by.get(r.period) || { period: r.period, manufacturing: null, newOrders: null, services: null, asOf: null, source: 'prnewswire' };
    if (r.kind === 'manufacturing') Object.assign(row, { manufacturing: r.pmi, newOrders: r.newOrders, asOf: r.published || row.asOf });
    else row.services = r.pmi;
    by.set(r.period, row);
  }
  return [...by.values()].filter(r => r.manufacturing != null || r.services != null).sort((a, b) => a.period.localeCompare(b.period));
}

// The hand entry over the feed: for each month the typed values win field by field, so a typed
// figure outranks the feed for its own month and the feed fills what was never typed.
export function mergeIsm(feed = null, hand = null) {
  const by = new Map();
  for (const r of feed?.series || []) by.set(r.period, { ...r });
  // A hand entry may carry only `latest` (or a latest newer than its series): it counts as a month too.
  const handRows = [...(hand?.series || [])];
  if (hand?.latest && !handRows.some(r => r.period && r.period === hand.latest.period)) handRows.push(hand.latest);
  for (const r of handRows) {
    const cur = by.get(r.period) || {};
    const typed = Object.fromEntries(Object.entries(r).filter(([, v]) => v != null));
    by.set(r.period, { ...cur, ...typed, source: cur.source ? 'hand+prnewswire' : 'hand' });
  }
  const series = [...by.values()].filter(r => r.period).sort((a, b) => a.period.localeCompare(b.period));
  const withMfg = series.filter(r => r.manufacturing != null);
  // An undated hand reading (no month) still stands when nothing dated does.
  const bare = hand?.latest && !hand.latest.period && hand.latest.manufacturing != null ? { ...hand.latest, source: 'hand' } : null;
  return { latest: withMfg.at(-1) || bare, series };
}
