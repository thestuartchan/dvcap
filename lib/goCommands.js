// lib/goCommands.js — the Go bar: one line to reach any view, the way a terminal's command line does.
//
// Type a function code (ECO, GEX, PORT), a name (calendar, hedges), or a ticker with a function
// (QQQ GEX, "NVDA US Equity GEX"), and Enter goes there. The codes borrow the terminal's where one
// exists (ECO, OMON, PORT, WEI) so they are already in the hand, and each view keeps a plain-word
// alias so nothing has to be learned first. Pure: the screen (src/GoBar.jsx) asks this what a line
// means and what to suggest; it decides nothing itself. This is not the Console's trade line
// (lib/commandBar.js), which adds a trade; this only moves you around.

// Every view, in the nav's order. `tab` is the id App.jsx switches on; `ticker` marks a view that
// takes a symbol.
export const GO_FUNCTIONS = Object.freeze([
  { code: 'OV',     tab: 'global',    label: 'Daily Overview', group: 'Markets', aliases: ['OVERVIEW', 'DAILY', 'WEI', 'BRIEF'] },
  { code: 'STATE',  tab: 'state',     label: 'State',          group: 'Markets', aliases: ['REGIME', 'REGM', 'CONDITIONS'] },
  { code: 'DRV',    tab: 'drivers',   label: 'Drivers',        group: 'Markets', aliases: ['DRIVERS', 'BTMM', 'RATES', 'CREDIT', 'VOL'] },
  { code: 'RAT',    tab: 'ratios',    label: 'Ratios',         group: 'Markets', aliases: ['RATIOS', 'PAIRS', 'GP'] },
  { code: 'ECO',    tab: 'calendar',  label: 'Calendar',       group: 'Markets', aliases: ['CAL', 'CALENDAR', 'EVTS', 'EVENTS'] },
  { code: 'DES',    tab: 'ticker',    label: 'Ticker page',    group: 'Tickers', aliases: ['TICKER', 'QUOTE'], ticker: true },
  { code: 'GEX',    tab: 'gex',       label: 'Gamma',          group: 'Tickers', aliases: ['GAMMA', 'OMON'], ticker: true },
  { code: 'PORT',   tab: 'console',   label: 'Console',        group: 'Book',    aliases: ['CONSOLE', 'POSITIONS'] },
  { code: 'HEDGE',  tab: 'insurance', label: 'Hedges',         group: 'Book',    aliases: ['HEDGES', 'INSURANCE'] },
  { code: 'INC',    tab: 'income',    label: 'Income',         group: 'Book',    aliases: ['INCOME', 'YIELD'] },
  { code: 'PLAN',   tab: 'plan',      label: 'Plan',           group: 'Plan',    aliases: ['POSTURE', 'STAGE'] },
  { code: 'SM',     tab: 'street',    label: 'Smart Money',    group: 'Plan',    aliases: ['STREET', '13F', 'RES'] },
  { code: 'HEALTH', tab: 'health',    label: 'Data health',    group: 'Status',  aliases: ['DATA', 'STATUS'] },
  // The hand-entry list at the top of Data health: every hand-kept input, with its editor.
  { code: 'HAND',   tab: 'health',    label: 'Hand-kept inputs', group: 'Status', aliases: ['HANDKEPT', 'HAND-KEPT', 'INPUTS', 'ENTRY'], anchor: 'hand-entry' },
]);

// Things to do rather than places to go.
export const GO_ACTIONS = Object.freeze([
  { code: 'REFRESH', action: 'refresh',     label: 'Refresh prices and indicators', aliases: ['RELOAD'] },
  { code: 'LIGHT',   action: 'theme:light', label: 'Light theme',                   aliases: [] },
  { code: 'SOFT',    action: 'theme:soft',  label: 'Soft theme',                    aliases: [] },
  { code: 'DARK',    action: 'theme:dark',  label: 'Dark theme',                    aliases: [] },
]);

// Words a terminal line carries that say nothing here: "NVDA US Equity GEX <GO>".
const FILLER = new Set(['US', 'EQUITY', 'EQUITIES', 'INDEX', 'GO', '<GO>', 'ETF']);
const TICKER_RE = /^[A-Z0-9][A-Z0-9.]{0,9}$/;
const ALL = [...GO_FUNCTIONS, ...GO_ACTIONS];
const keysOf = (f) => [f.code, ...f.aliases, f.label.toUpperCase()];
const DES = GO_FUNCTIONS.find(f => f.code === 'DES');

const tokens = (line) => String(line || '').toUpperCase().split(/\s+/).filter(Boolean).filter(t => !FILLER.has(t));
const exact = (t) => ALL.find(f => keysOf(f).includes(t)) || null;

const toFn = (f, symbol = null) => f.tab
  ? { id: `${f.code}${symbol ? `:${symbol}` : ''}`, code: f.code, title: symbol ? `${symbol} ${f.label}` : f.label, group: f.group, tab: f.tab, symbol, ...(f.anchor ? { anchor: f.anchor } : {}) }
  : { id: f.code, code: f.code, title: f.label, group: 'Action', action: f.action };

// What a whole line means, or null. "ECO" → Calendar; "QQQ GEX" or "GEX QQQ" → Gamma on QQQ;
// "DARK" → the dark theme; "NVDA" alone → its ticker page. A word that starts a code or a name
// ("HE", "PL") is not read as a ticker: Enter takes the highlighted suggestion instead.
export function parseGo(line) {
  const ts = tokens(line);
  if (!ts.length) return null;
  const words = ts.join(' ');
  const whole = exact(words);
  if (whole) return toFn(whole);
  if (ts.length === 2) {
    for (const [a, b] of [[ts[0], ts[1]], [ts[1], ts[0]]]) {
      const f = exact(b);
      if (f?.ticker && TICKER_RE.test(a) && !exact(a)) return toFn(f, a);
    }
  }
  if (ts.length === 1 && TICKER_RE.test(ts[0]) && !ALL.some(f => keysOf(f).some(k => k.startsWith(ts[0])))) return toFn(DES, ts[0]);
  return null;
}

// Ranked suggestions for what has been typed so far. An exact command first; then codes and
// aliases that start with it; then names that contain it. A bare ticker offers the views that
// take one, its ticker page first.
export function suggestGo(line, { recent = [], limit = 8 } = {}) {
  const ts = tokens(line);
  if (!ts.length) {
    const rec = recent.map(parseGo).filter(Boolean);
    const seen = new Set(rec.map(r => r.id));
    return [...rec.map(r => ({ ...r, recent: true })), ...ALL.map(f => toFn(f)).filter(r => !seen.has(r.id))].slice(0, Math.max(limit, 16));
  }
  const out = [];
  const add = (r) => { if (r && !out.some(o => o.id === r.id)) out.push(r); };
  add(parseGo(line));
  const words = ts.join(' ');
  const last = ts[ts.length - 1];
  // A ticker followed by a partial function: "QQQ G" → QQQ Gamma.
  if (ts.length === 2 && TICKER_RE.test(ts[0]) && !exact(ts[0])) {
    for (const f of GO_FUNCTIONS.filter(f => f.ticker && keysOf(f).some(k => k.startsWith(last)))) add(toFn(f, ts[0]));
  }
  for (const f of ALL) if (keysOf(f).some(k => k.startsWith(words))) add(toFn(f));
  // Inside a name only from three letters, so "he" finds Hedges without also finding "theme".
  if (words.length >= 3) for (const f of ALL) if (f.label.toUpperCase().includes(words)) add(toFn(f));
  if (ts.length === 1 && TICKER_RE.test(ts[0]) && !exact(ts[0])) {
    for (const f of GO_FUNCTIONS.filter(f => f.ticker)) add(toFn(f, ts[0]));
  }
  return out.slice(0, limit);
}

// The recent list a run leaves behind: newest first, no repeats, five kept.
export function pushRecent(recent = [], line) {
  const r = parseGo(line);
  if (!r) return recent;
  const canon = r.symbol ? `${r.symbol} ${r.code}` : r.code;
  return [canon, ...recent.filter(x => { const p = parseGo(x); return !p || p.id !== r.id; })].slice(0, 5);
}
