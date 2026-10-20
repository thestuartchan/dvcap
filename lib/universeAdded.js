// lib/universeAdded.js — names added from the dashboard, on top of the lists kept in code.
//
// Three lists take a name from the "Add to" buttons (ticker page; Data health › Ticker coverage):
//   earnings   the automatic earnings dates (Nasdaq), alongside data/earnings_watch.json
//   supply     the supplier / customer map's filers, alongside lib/supplyChain.js SC_UNIVERSE
//   watch      the pre-read watchlist, alongside data/watchUniverse.js, by region
// The additions live in data/universe_added.json, written one commit at a time by
// api/manual-entry.js, so each list is the code's list plus the file's — and a name added by hand
// is never mixed into, or lost from, the lists the code keeps.
//
// The earnings watch also takes the pre-read watchlist's US single names on its own: the names the
// briefs already follow should not need adding twice.
//
// PUBLIC NAMES ONLY. These lists feed public routes (the calendar, the pre-read). A name is added
// because it was chosen, never because it is held; nothing here reads the Console.
import ADDED from '../data/universe_added.json' with { type: 'json' };
import EARNINGS_WATCH from '../data/earnings_watch.json' with { type: 'json' };
import { WATCH_UNIVERSE } from '../data/watchUniverse.js';
import { watchName } from '../data/watchMeta.js';
import { SC_UNIVERSE } from './supplyChain.js';
import { instrumentKind } from './catalyst.js';

export const ADD_LISTS = Object.freeze(['earnings', 'supply', 'watch']);
export const ADD_LABEL = Object.freeze({ earnings: 'Earnings watch', supply: 'Supplier map', watch: 'Pre-read watchlist' });
const REGIONS = ['us', 'eu', 'asia'];
const SYM_RE = /^[A-Z0-9][A-Z0-9.-]{0,11}$/;
const clean = (s) => String(s || '').trim().toUpperCase();

// The pre-read region a listing belongs to, by its exchange suffix; null when it has none.
const ASIA = /\.(HK|KS|KQ|T|TW|TWO|SI|SS|SZ)$/, EU = /\.(L|AS|PA|DE|MI|SW|MC|ST|CO|HE|OL|BR|LS|IR)$/;
export function regionOf(sym) {
  const s = clean(sym);
  if (!SYM_RE.test(s)) return null;
  if (ASIA.test(s) || /^\d+$/.test(s)) return 'asia';
  if (EU.test(s)) return 'eu';
  if (/^[A-Z]{1,5}(-[A-Z])?$/.test(s)) return 'us';
  return null;
}
// A US single name: what Nasdaq's earnings date answers for, and what files with the SEC.
export const isUsSingle = (sym) => regionOf(sym) === 'us' && instrumentKind(sym) === 'single-name';

// ── THE MERGED LISTS ─────────────────────────────────────────────────────────
const fileNames = EARNINGS_WATCH.names || [];
const addedEarnings = (ADDED.earnings || []).filter(e => e && e.sym);
const watchUs = (WATCH_UNIVERSE.us || []).filter(isUsSingle);
const bySym = new Map();
for (const n of fileNames) bySym.set(n.sym, { ...n, from: 'file' });
for (const n of addedEarnings) if (!bySym.has(n.sym)) bySym.set(n.sym, { region: 'US', tier: 2, aliases: [], ...n, from: 'added' });
for (const sym of watchUs) {
  if (bySym.has(sym)) continue;
  const name = watchName(sym);
  bySym.set(sym, { sym, name, aliases: [name], region: 'US', tier: 2, from: 'watchlist' });
}
// Every name whose earnings date is read from Nasdaq: the file's, then the added, then the watchlist's.
export const EARNINGS_NAMES = Object.freeze([...bySym.values()]);
export const DART_NAMES_WATCH = Object.freeze(EARNINGS_WATCH.dart || []);

// What was added by hand, per list, for the Remove button.
export function addedIn(sym) {
  const s = clean(sym);
  return {
    earnings: addedEarnings.some(e => e.sym === s),
    supply: (ADDED.supply || []).includes(s),
    watch: REGIONS.some(r => (ADDED.watch?.[r] || []).some(w => w.sym === s)),
  };
}
// Whether a symbol is already on each list, from any source.
export function onList(sym) {
  const s = clean(sym);
  const r = regionOf(s);
  return { earnings: bySym.has(s), supply: SC_UNIVERSE.includes(s), watch: !!(r && (WATCH_UNIVERSE[r] || []).includes(s)) };
}
// Which lists could take the symbol, by its shape. The server checks again against the source.
export function canAdd(sym) {
  const s = clean(sym);
  return { earnings: isUsSingle(s), supply: isUsSingle(s), watch: !!regionOf(s) };
}

// ── EDITING THE FILE (pure) ──────────────────────────────────────────────────
// file in, file out; the route reads it from GitHub, calls these, and writes it back.
const nameOk = (n, sym) => String(n || sym).replace(/[^\w .,&'()-]/g, '').trim().slice(0, 60) || sym;
export function addEntry(file, list, sym, { name = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const s = clean(sym);
  const f = { earnings: [], supply: [], watch: { us: [], eu: [], asia: [] }, ...(file || {}) };
  f.watch = { us: [], eu: [], asia: [], ...(f.watch || {}) };
  if (!ADD_LISTS.includes(list)) return { file: f, changed: false, error: `unknown list ${list}` };
  if (!SYM_RE.test(s)) return { file: f, changed: false, error: `${sym} is not a symbol` };
  const ok = canAdd(s)[list];
  if (!ok) return { file: f, changed: false, error: list === 'watch' ? `${s} has no pre-read region` : `${s} is not a US-listed single company` };
  if (list === 'earnings') {
    if (f.earnings.some(e => e.sym === s)) return { file: f, changed: false };
    const nm = nameOk(name, s);
    f.earnings = [...f.earnings, { sym: s, name: nm, aliases: [nm], region: 'US', tier: 2, added: today }];
  } else if (list === 'supply') {
    if (f.supply.includes(s)) return { file: f, changed: false };
    f.supply = [...f.supply, s];
  } else {
    const r = regionOf(s);
    if (f.watch[r].some(w => w.sym === s)) return { file: f, changed: false };
    f.watch = { ...f.watch, [r]: [...f.watch[r], { sym: s, name: nameOk(name, s), added: today }] };
  }
  return { file: f, changed: true };
}
export function removeEntry(file, list, sym) {
  const s = clean(sym);
  const f = { earnings: [], supply: [], watch: { us: [], eu: [], asia: [] }, ...(file || {}) };
  if (!ADD_LISTS.includes(list)) return { file: f, changed: false, error: `unknown list ${list}` };
  if (list === 'earnings') { const n = f.earnings.filter(e => e.sym !== s); return { file: { ...f, earnings: n }, changed: n.length !== f.earnings.length }; }
  if (list === 'supply') { const n = f.supply.filter(x => x !== s); return { file: { ...f, supply: n }, changed: n.length !== f.supply.length }; }
  const w = Object.fromEntries(REGIONS.map(r => [r, (f.watch?.[r] || []).filter(x => x.sym !== s)]));
  const changed = REGIONS.some(r => w[r].length !== (f.watch?.[r] || []).length);
  return { file: { ...f, watch: w }, changed };
}
