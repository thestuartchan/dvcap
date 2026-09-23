// lib/commandBar.js — one line to add a trade (panel brief, console rework, Step 4a).
//
// Add-a-Setup took a ticker and long/short; the trade then sat in Setups until a "confirm bought"
// click moved it to Open. Two screens and a click for one action. The command bar is one row:
//
//     TICKER · direction · instrument · [qty @ price] · Add
//
// typed as one line — "SOFI long shares 500 @ 16.675" — or filled from the pills beside it. With
// no fill the card is created WATCHING; with a fill it is created OPEN, in one action. Every word
// is optional but the ticker: direction defaults to long, instrument to shares (or future, when
// the ticker is an unambiguous futures root).
//
// THE TICKER IS RESOLVED THE WAY THE SIZER RESOLVES IT — through the quote feed, which reports the
// name it settled on — with one addition the sizer never needed: a bare exchange code. 7709 is a
// Hong Kong listing and 005930 a Korean one, and the feed prices neither as typed. The candidates
// the console tries, in order, are stated here so the answer is checkable rather than guessed.
import { parseOptionSymbol } from './bookExposure.js';
import { isUnambiguousFuture, multiplierFor, FUTURES_MULTIPLIER } from './futures.js';
import { familyOf } from './futuresContracts.js';
import { sideOf } from './side.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// A futures root the console can size: the unambiguous ones in the base table, plus the families
// lib/futuresContracts.js adds beyond it (COIL, BZ, NKD) — never a root that is also a stock (CL
// is Colgate as typed; lib/tickerHints.js says so on screen).
export const isFuturesRoot = (s) => {
  const u = String(s || '').trim().toUpperCase();
  return isUnambiguousFuture(u) || (!!familyOf(u) && !Object.prototype.hasOwnProperty.call(FUTURES_MULTIPLIER, u));
};

export const DIRECTIONS = Object.freeze({ long: 'long', l: 'long', buy: 'long', short: 'short', s: 'short', sell: 'short' });
export const INSTRUMENT_WORDS = Object.freeze({
  shares: 'shares', share: 'shares', stock: 'shares', stk: 'shares', equity: 'shares', etf: 'shares',
  option: 'option', opt: 'option', call: 'option', put: 'option',
  spread: 'spread', vertical: 'spread', calendar: 'spread', diagonal: 'spread',
  future: 'future', fut: 'future', futures: 'future',
});

// "SOFI long shares 500 @ 16.675" → { symbol, side, instrument, qty, price }. Words may come in
// any order after the ticker; "500 @ 16.675", "500@16.675" and "500 at 16.675" all read as a fill.
export function parseCommand(text = '') {
  const raw = String(text || '').trim().replace(/\s+/g, ' ');
  if (!raw) return { symbol: null, side: 'long', instrument: null, qty: null, price: null, error: 'a ticker to start' };
  // The fill first, so its numbers are not mistaken for anything else.
  let qty = null, price = null, rest = raw;
  const fill = /(\d+(?:\.\d+)?)\s*(?:@|\bat\b)\s*(-?\d+(?:\.\d+)?)/i.exec(raw);
  if (fill) { qty = num(fill[1]); price = num(fill[2]); rest = (raw.slice(0, fill.index) + ' ' + raw.slice(fill.index + fill[0].length)).trim(); }
  const words = rest.split(' ').filter(Boolean);
  const symbol = words.shift();
  if (!symbol || !/^[A-Za-z0-9.^=:-]{1,16}$/.test(symbol)) return { symbol: null, side: 'long', instrument: null, qty, price, error: `"${symbol || ''}" is not a ticker` };
  let side = null, instrument = null;
  const unknown = [];
  for (const w of words) {
    const k = w.toLowerCase();
    if (DIRECTIONS[k] && side == null) side = DIRECTIONS[k];
    else if (INSTRUMENT_WORDS[k] && instrument == null) instrument = INSTRUMENT_WORDS[k];
    else if (/^\d+(?:\.\d+)?$/.test(k) && qty == null) qty = num(k);    // a bare quantity, no price yet
    else unknown.push(w);
  }
  const sym = symbol.toUpperCase();
  // A contract typed whole ("QQQ Oct16'26 730C") is an option row on its root.
  const contract = parseOptionSymbol(raw) || null;
  if (instrument == null) instrument = contract ? 'option' : isFuturesRoot(sym) ? 'future' : 'shares';
  const error = unknown.length ? `did not understand "${unknown.join(' ')}"`
    : (qty != null && price == null) ? 'a first fill needs a price: qty @ price'
    : (qty != null && !(qty > 0)) ? 'quantity must be above zero'
    : null;
  return { symbol: contract ? contract.root : sym, side: side || 'long', instrument, qty, price, contract, error, raw };
}

// ── WHERE A BARE CODE LIVES ──────────────────────────────────────────────────
// The feed symbols to try for what was typed, first the likeliest. A four-digit code is Hong Kong
// (zero-padded), a six-digit one is Korea (KOSPI first, then KOSDAQ); a known futures root is the
// continuous contract; everything else is itself. The caller asks the feed in this order and
// keeps the first that answers with a name.
export function resolveCandidates(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  if (!s) return [];
  if (/[.=^-]/.test(s)) return [{ symbol: s, why: 'as typed' }];
  if (/^\d{1,5}$/.test(s)) return [{ symbol: `${s.padStart(4, '0')}.HK`, why: 'a Hong Kong code, zero-padded' }];
  if (/^\d{6}$/.test(s)) return [{ symbol: `${s}.KS`, why: 'a Korean code on the KOSPI' }, { symbol: `${s}.KQ`, why: 'a Korean code on the KOSDAQ' }];
  if (isFuturesRoot(s)) return [{ symbol: s, why: 'a futures root — the front contract', future: true }];
  return [{ symbol: s, why: 'as typed' }];
}

// The row for a share or futures command. Options and spreads go through lib/instruments.js
// optionRow, which the console calls with the leg table's legs.
export function commandRow(parsed, { resolved = null, date = new Date().toISOString().slice(0, 10), id = null } = {}) {
  if (!parsed || parsed.error) return { error: parsed?.error || 'nothing to add' };
  if (parsed.instrument === 'option' || parsed.instrument === 'spread') return { error: 'an option or spread takes its legs from the table' };
  const symbol = String(resolved?.symbol || parsed.symbol).toUpperCase();
  const known = multiplierFor(symbol.replace(/=F$/, ''), { margined: parsed.instrument === 'future' || isFuturesRoot(symbol.replace(/=F$/, '')) });
  const future = parsed.instrument === 'future' || known.source === 'table';
  const sd = sideOf(parsed.side) ?? 'long';
  const rid = id || `${symbol}-${Math.random().toString(36).slice(2, 8)}`;
  const fills = parsed.qty != null && parsed.price != null
    ? [{ id: Math.random().toString(36).slice(2, 8), date, side: sd === 'short' ? 'sell' : 'buy', qty: parsed.qty, price: parsed.price, note: 'from the command bar' }]
    : [];
  return { row: {
    id: rid, symbol, side: sd, currency: resolved?.currency || 'USD', thesis: '', levels: [], fills, tags: [],
    instrument: future ? 'future' : 'shares',
    ...(known.source === 'table' ? { multiplier: known.multiplier, margined: true } : future ? { margined: true } : {}),
    ...(resolved?.name ? { trade: '' } : {}),
  }, opensAs: fills.length ? 'OPEN' : 'WATCHING' };
}

// One line saying what Add will do, before it is pressed.
export function commandSummary(parsed) {
  if (!parsed || !parsed.symbol) return null;
  const bits = [parsed.symbol, parsed.side.toUpperCase(), parsed.instrument];
  if (parsed.qty != null && parsed.price != null) bits.push(`${parsed.qty} @ ${parsed.price}`);
  const opens = (parsed.qty != null && parsed.price != null) ? 'OPEN' : 'WATCHING';
  return `${bits.join(' · ')} → ${opens}`;
}
