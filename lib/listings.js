// lib/listings.js — which listing a position trades on, in the quote feed's terms.
//
// THE FAILURE (16 Oct 2026). A London-listed UCITS ETF shares its ticker with a US ETF on NYSE Arca.
// The console row carried the bare ticker, so it was priced off the US fund — a different
// instrument about 28% away. Both trade in dollars, so nothing looked wrong. IBKR names the listing
// on every Open Positions line (LSEETF here), and lib/flex.js parsed it and then used it only to
// tell a cash fund apart from a US ticker.
//
// This maps IBKR's listing code to the suffix the quote feed (Yahoo) expects, so a statement can
// say what a row SHOULD be quoted as. Deliberately a short list of exchanges we can name with
// confidence — an exchange not here returns null and nothing is suggested, which is the same
// behaviour as before rather than a guess.

// IBKR listing exchange → Yahoo suffix. US venues map to '' (no suffix: the bare ticker is right).
export const LISTING_SUFFIX = Object.freeze({
  // United States — the bare symbol.
  NASDAQ: '', NYSE: '', ARCA: '', AMEX: '', BATS: '', BYX: '', IEX: '', PINK: '', NYSENAT: '',
  // London: main market, ETF segment, international order book.
  LSE: 'L', LSEETF: 'L', LSEIOB1: 'L',
  SEHK: 'HK',                         // Hong Kong (numeric codes, padded to four digits)
  AEB: 'AS',                          // Euronext Amsterdam
  SBF: 'PA',                          // Euronext Paris
  ENEXT_BE: 'BR', 'ENEXT.BE': 'BR',   // Euronext Brussels
  IBIS: 'DE', IBIS2: 'DE',            // Xetra
  FWB: 'F', FWB2: 'F',                // Frankfurt floor
  BVME: 'MI', 'BVME.ETF': 'MI',       // Borsa Italiana
  BM: 'MC',                           // Madrid
  EBS: 'SW', SWX: 'SW',               // SIX Swiss
  TSE: 'TO',                          // Toronto (IBKR's TSE is Toronto; Tokyo is TSEJ)
  VENTURE: 'V',                       // TSX Venture
  TSEJ: 'T',                          // Tokyo
  ASX: 'AX',                          // Australia
  SGX: 'SI',                          // Singapore
});

// What the feed should call a position: `XYZ` on LSEETF → `XYZ.L`, `981` on SEHK → `0981.HK`.
// '' for a US listing (the bare ticker), null when the listing is unknown or absent.
export function quoteSymbolFor({ root, symbol, listingExchange } = {}) {
  const ex = String(listingExchange || '').toUpperCase();
  if (!ex || !(ex in LISTING_SUFFIX)) return null;
  const sfx = LISTING_SUFFIX[ex];
  const base = String(root || symbol || '').toUpperCase().trim();
  if (!base) return null;
  if (!sfx) return '';
  const code = sfx === 'HK' && /^\d{1,5}$/.test(base) ? base.padStart(4, '0') : base;
  return `${code}.${sfx}`;
}

// The symbol a row is quoted off today, by the same rule as the console's quoteSym for a plain
// share row: the row's `quoteSymbol` when set, otherwise its own symbol.
const effective = (row) => String(row?.quoteSymbol || '').trim().toUpperCase() || String(row?.symbol || '').trim().toUpperCase();

// Does a console row quote the listing the broker holds? Returns null when it does (or when the
// listing cannot be named), otherwise { quoteAs, listing, current, explicit }:
//   quoteAs  — what it should be quoted as
//   current  — what it is quoted as now
//   explicit — true when the row's `quoteSymbol` was set by hand to something else. That is
//              reported, never overwritten: a person chose it, and only a person can unchoose it.
export function listingCheck(row, position) {
  const want = quoteSymbolFor({ root: position?.root, symbol: position?.symbol, listingExchange: position?.listingExchange });
  if (want == null) return null;
  const current = effective(row);
  // A US listing: right when the row quotes the bare ticker, i.e. no exchange suffix.
  if (want === '') return null;
  if (current === want) return null;
  return { quoteAs: want, listing: String(position.listingExchange).toUpperCase(), current, explicit: !!String(row?.quoteSymbol || '').trim() };
}

// ── THE SECOND NET: A PRICE THAT IS NOT THE BROKER'S ─────────────────────────
// The listing check needs IBKR to name an exchange this file knows. The price check needs
// nothing but two numbers: the statement's close mark for the line and the console's live price.
// Same listing, the two are a day's move apart at most; a different instrument is usually far
// further. 15% is wide enough that an ordinary day on a volatile name does not trip it and narrow
// enough that the 28% that started this does.
export const MARK_GAP_PCT = 15;
export function markGap(livePrice, mark, { pct = MARK_GAP_PCT } = {}) {
  const a = Number(livePrice), b = Number(mark);
  if (!(a > 0) || !(b > 0)) return null;
  const gap = (a / b - 1) * 100;
  return Math.abs(gap) > pct ? +gap.toFixed(1) : null;
}
