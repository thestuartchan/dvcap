// lib/coverage.js — which tickers each part of the dashboard takes, read from the lists the code
// itself uses, so the answer can't drift from what the screens do.
//
// Two kinds of coverage. OPEN sources take whatever is typed and answer if they have it: Yahoo for
// price and history, SEC EDGAR for filings, OCC + CBOE for a custom gamma read. FIXED lists are
// what a screen was built around: the stored gamma boards, the CTA markets, the Ratios legs, the
// earnings watch, the supply-chain filers, the regional names. `coverageFor` says, for one symbol,
// what each part will do with it and why; `COVERAGE_LISTS` is every fixed list, for the Coverage
// panel in Data health.
//
// Pure and browser-safe. Lists that live in server-only modules (lib/gexStore.js, lib/regionTape.js)
// are restated here, and test/coverage.test.mjs fails if a restatement and its source disagree.
import EARNINGS_WATCH from '../data/earnings_watch.json' with { type: 'json' };
import { UNIVERSE } from '../data/universe.js';
import { WATCH_UNIVERSE } from '../data/watchUniverse.js';
import { CARDS } from './ratios.js';
import { LADDER_ORDER } from './regimeState.js';
import { SC_UNIVERSE, COUNTERPARTIES } from './supplyChain.js';
import { CTA_MARKETS } from './cta.js';
import { TICKER_RE, GO_FUNCTIONS, GO_ACTIONS } from './goCommands.js';

// Restated from lib/gexStore.js (GEX_SYMBOLS, FEED_ONLY_SYMBOLS, CUSTOM_ROOT_RE) and
// lib/regionTape.js (REGION_TAPE), which import server code. Checked against them by the test.
export const GAMMA_STORED = Object.freeze(['QQQ', 'SPY']);
export const GAMMA_FEED_ONLY = Object.freeze(['SPX']);
export const GAMMA_CUSTOM_RE = /^[A-Z]{1,6}$/;
export const REGION_TAPE_SYMBOLS = Object.freeze({
  asia: ['^KS11', '^HSI', '^N225', 'KRW=X'], eu: ['^STOXX50E', '^GDAXI', '^FTSE', 'EURUSD=X'], us: ['QQQ', 'SPY', 'IWM', 'DX-Y.NYB'],
});

// ── SPELLING ────────────────────────────────────────────────────────────────
// What a typed word is, by its shape. Yahoo's spellings are the dashboard's: ^ for an index, =F
// for a future, =X for FX, -USD for crypto, an exchange suffix for a non-US listing.
const FOREIGN_SUFFIX = /\.(HK|KS|KQ|T|TW|TWO|L|AS|PA|DE|SI|TO|V|AX|SW|MI|MC|ST|CO|HE|OL|BR|LS|IR|SS|SZ|NS|BO|JK|BK|KL|SA|MX|AE)$/;
const SHARE_CLASS = /^([A-Z]{1,5})[.-]([A-C])$/;
// Bare index names nothing on Yahoo answers to, and the spelling that does.
export const INDEX_PRICE = Object.freeze({ SPX: '^GSPC', NDX: '^NDX', VIX: '^VIX', RUT: '^RUT', DJI: '^DJI', DXY: 'DX-Y.NYB' });

export function kindOf(sym) {
  const s = String(sym || '').trim().toUpperCase();
  if (!s) return null;
  if (s.startsWith('^') || INDEX_PRICE[s] || s === 'DX-Y.NYB') return 'index';
  if (/=F$/.test(s)) return 'future';
  if (/=X$/.test(s)) return 'fx';
  if (/-(USD|USDT|USDC|EUR|GBP|BTC)$/.test(s)) return 'crypto';
  if (/^HL:/.test(s)) return 'crypto';
  if (FOREIGN_SUFFIX.test(s) || /^\d+$/.test(s)) return 'foreign';
  if (SHARE_CLASS.test(s)) return 'class';
  if (/^[A-Z]{1,6}$/.test(s)) return 'us';
  return 'other';
}

// The spelling Yahoo answers to: BRK.B → BRK-B, SPX → ^GSPC. Everything else as typed.
export function priceSymbol(sym) {
  const s = String(sym || '').trim().toUpperCase();
  if (INDEX_PRICE[s]) return INDEX_PRICE[s];
  const m = SHARE_CLASS.exec(s);
  return m ? `${m[1]}-${m[2]}` : s;
}

// ── THE FIXED LISTS ─────────────────────────────────────────────────────────
const RATIO_LEGS = [...new Set(CARDS.flatMap(c => [...c.num, ...c.den]))];
const watchNames = EARNINGS_WATCH.names || [];
const dartNames = EARNINGS_WATCH.dart || [];
const REGION_NAMES = Object.fromEntries(Object.entries(UNIVERSE).map(([k, r]) => [k, (r.names || []).map(n => n.sym)]));
const codeKeys = [...GO_FUNCTIONS, ...GO_ACTIONS].flatMap(f => [f.code, ...f.aliases]);

export const COVERAGE_LISTS = Object.freeze([
  { id: 'gamma', title: 'Gamma — stored boards', where: 'lib/gexStore.js GEX_SYMBOLS', names: [...GAMMA_STORED, ...GAMMA_FEED_ONLY],
    note: 'QQQ and SPY are captured every session with history. SPX is read inside SPY\'s S&P map. Any other US options root (letters only, up to six) can be read once on the Gamma tab when signed in; nothing is stored.' },
  { id: 'earnings', title: 'Earnings dates — automatic', where: 'data/earnings_watch.json', names: [...watchNames.map(n => n.sym), ...dartNames.map(n => `${n.code}.KS`)],
    note: 'US names from Nasdaq\'s per-symbol earnings date; Samsung and SK hynix from Korea\'s DART. A name not here has no automatic date — add it to the file to get one.' },
  { id: 'supply', title: 'Suppliers and customers — filings read', where: 'lib/supplyChain.js SC_UNIVERSE', names: [...SC_UNIVERSE],
    note: `Each company's own annual report and latest 10-Q on EDGAR. ${COUNTERPARTIES.length} more names (Samsung, SK hynix, Tokyo Electron, Foxconn…) appear only where these filings name them.` },
  { id: 'cta', title: 'CTA replica', where: 'lib/cta.js CTA_MARKETS', names: CTA_MARKETS.map(m => `${m.key} (${m.symbol})`),
    note: 'Six futures markets. No other market can be added from the screen.' },
  { id: 'ratios', title: 'Ratios and breadth ladder', where: 'lib/ratios.js CARDS · lib/regimeState.js LADDER_ORDER', names: [...new Set([...RATIO_LEGS, ...LADDER_ORDER])],
    note: `${CARDS.length} fixed ratio cards and the ${LADDER_ORDER.length}-rung breadth ladder.` },
  { id: 'regions', title: 'Regional names', where: 'data/universe.js', names: Object.values(REGION_NAMES).flat(),
    note: 'The names each region\'s Overview and pre-read are built around.' },
  { id: 'watch', title: 'Pre-read watchlist', where: 'data/watchUniverse.js', names: Object.values(WATCH_UNIVERSE).flat(),
    note: 'Names the pre-reads may mention; a symbol outside this list never reaches the watchlist.' },
  { id: 'tape', title: 'Regional tape strip', where: 'lib/regionTape.js REGION_TAPE', names: Object.values(REGION_TAPE_SYMBOLS).flat(),
    note: 'Three indexes and one currency per region.' },
]);

// The open sources, for the panel's other half.
export const COVERAGE_OPEN = Object.freeze([
  { feature: 'Price and one-year chart', source: 'Yahoo', takes: 'Any symbol as Yahoo spells it: ^ for an index (^GSPC), =F for a future (CL=F), -USD for crypto (BTC-USD), an exchange suffix outside the US (005930.KS, 7203.T, 0700.HK). BRK.B and SPX are translated to BRK-B and ^GSPC.' },
  { feature: 'Fundamentals and filings', source: 'SEC EDGAR', takes: 'Companies that file with the SEC. Not ETFs or funds, not non-US listings that don\'t file. Foreign filers (TSM, ASML) list their filings; their IFRS figures aren\'t read.' },
  { feature: 'Custom gamma read', source: 'OCC + CBOE', takes: 'US-listed options roots, letters only, up to six, signed in. Not indexes other than SPX, not non-US listings.' },
  { feature: 'Sizer ATR and Console quotes', source: 'Yahoo', takes: 'Any Yahoo symbol. The Console also reads 1–5 digits as Hong Kong and 6 digits as Korea.' },
]);

// ── ONE SYMBOL ──────────────────────────────────────────────────────────────
// What each part does with this symbol: status 'yes' (it's covered), 'try' (an open source; it
// works if the source has it), 'no' (it won't), each with the reason in plain words.
export function coverageFor(symbol) {
  const sym = String(symbol || '').trim().toUpperCase();
  const kind = kindOf(sym);
  if (!kind) return [];
  const ps = priceSymbol(sym);
  const base = SHARE_CLASS.exec(sym)?.[1] || sym;
  const out = [];
  const row = (id, label, status, why) => out.push({ id, label, status, why });

  row('price', 'Price', 'try', ps !== sym ? `Yahoo, read as ${ps}` : 'Yahoo, as spelled');

  if (kind === 'us' || kind === 'class') row('sec', 'Filings', 'try', 'SEC EDGAR, if it files there (ETFs and funds don\'t)');
  else row('sec', 'Filings', 'no', kind === 'foreign' ? 'a non-US listing; SEC EDGAR has only US-registered filers' : `${kind === 'index' ? 'an index' : kind === 'future' ? 'a future' : kind === 'fx' ? 'a currency' : 'not a company'}; nothing to file`);

  if (GAMMA_STORED.includes(sym)) row('gamma', 'Gamma', 'yes', 'stored board, captured every session');
  else if (GAMMA_FEED_ONLY.includes(sym) || ps === '^GSPC' || sym === '^SPX') row('gamma', 'Gamma', 'yes', 'inside SPY\'s S&P map on the Gamma tab');
  else if (kind === 'us' && GAMMA_CUSTOM_RE.test(sym)) row('gamma', 'Gamma', 'try', 'custom read on the Gamma tab when signed in, if OCC lists its options');
  else row('gamma', 'Gamma', 'no', 'custom reads take US options roots only (letters, up to six)');

  const w = watchNames.find(n => n.sym === sym || n.sym === base);
  const dk = dartNames.find(n => `${n.code}.KS` === sym || n.code === sym);
  if (w) row('earnings', 'Earnings date', 'yes', 'automatic, from Nasdaq');
  else if (dk) row('earnings', 'Earnings date', 'yes', 'automatic, from Korea\'s DART');
  else row('earnings', 'Earnings date', 'no', kind === 'us' || kind === 'class' ? 'not on the earnings watch (data/earnings_watch.json)' : 'only the earnings watch gets dates');

  const cp = COUNTERPARTIES.find(c => c.ticker === sym);
  if (SC_UNIVERSE.includes(sym) || (sym === 'GOOG' && SC_UNIVERSE.includes('GOOGL'))) row('supply', 'Suppliers', 'yes', 'its own filings are read');
  else if (cp) row('supply', 'Suppliers', 'yes', 'named in the filings read; its own aren\'t');
  else row('supply', 'Suppliers', 'no', `not among the ${SC_UNIVERSE.length} filers read, and none of them names it`);

  const legs = RATIO_LEGS.includes(sym), rung = LADDER_ORDER.includes(sym);
  if (legs || rung || sym === 'SMH' || sym === 'SOXX') row('context', 'Ratios', 'yes', [legs && 'a Ratios leg', rung && 'a breadth-ladder rung', (sym === 'SMH' || sym === 'SOXX') && 'the concentration tell'].filter(Boolean).join(', '));

  const cta = CTA_MARKETS.find(m => m.symbol === sym || m.key === sym);
  if (cta) row('cta', 'CTA', 'yes', `${cta.label} is one of the six CTA markets`);

  const region = Object.entries(REGION_NAMES).find(([, names]) => names.includes(sym));
  if (region) row('region', 'Region', 'yes', `one of the names on the ${UNIVERSE[region[0]].label} Overview and pre-read`);

  if (!TICKER_RE.test(sym)) row('go', 'Go bar', 'no', 'not a shape the Go bar reads');
  else if (codeKeys.includes(sym)) row('go', 'Go bar', 'try', `"${sym}" is also a Go code; type ${sym} DES`);
  return out;
}
