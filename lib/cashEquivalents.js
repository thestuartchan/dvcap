// lib/cashEquivalents.js — what counts as cash parked, not a position taken. ONE LIST.
//
// It was hand-written in three places (lib/bookExposure.js CASH_LIKE_ETF, lib/flex.js and
// lib/tradecard.js CASH_EQUIVALENTS) and the copies had drifted: SHY only in one, JPST and MINT
// only in two, IB01 in none. Everything that asks "is this cash?" now asks here:
//   lib/bookExposure.js  delta 0; out of delta-notional, the bucket sums and the 1.2× ceiling
//   lib/flex.js          classOf() → 'cash': reported, never auto-added as a row
//   lib/tradecard.js     off the Discord card and out of its announcements
//   lib/catalyst.js      no earnings lookup
//
// WHAT IS IN, AND WHAT WAS LEFT OUT (6 Oct brief):
//   US T-bill / floating-rate Treasury funds, matched on the bare US ticker as before.
//   IB01 — iShares $ Treasury Bond 0-1yr UCITS, LSE (IBKR exchange LSEETF, conid 354802220). IBKR
//     reports it as plain "IB01", as it reports the BRNT line as "BRNT" (checked against the IBKR
//     contract search and the account's own LSE line on 6 Oct). It is matched on the symbol WITH its
//     exchange, its .L suffix, or its conid — never on the bare root alone, because non-US tickers
//     collide: "TBIL" is five different funds on NASDAQ, EBS, TSE, ASX and B3.
//   IB01N, the Mexican line (MEXI), is left out: this account trades the LSE line, and Flex reports
//     what is held, so IB01N could only appear if it were bought there on purpose.
//   Directly held Treasury bills: Flex assetCategory BILL. Valued at market (IBKR's position
//     value), never at face.
//   SHY is OUT. It is 1-3 year Treasuries, duration ~1.9: it moves with rates, so treating it as
//     zero delta understated the book. It is an ordinary ETF again (delta 1) — conservative for
//     the ceiling — until a short-duration class with its own rate delta exists.
//   JPST and MINT are OUT. They are ultra-short CREDIT funds (corporate paper), not Treasuries: a
//     credit event marks them down. Neither is held; if bought, they show as positions, which is
//     the honest default for something that can lose money in a credit scare.

// US-listed: the bare ticker is enough (a non-US exchange or suffix on the same ticker is NOT it).
export const US_CASH_EQUIVALENTS = Object.freeze(['USFR', 'SGOV', 'BIL', 'SHV', 'TFLO', 'CLIP', 'BOXX', 'GBIL', 'TBIL', 'XBIL', 'ICSH']);

// Non-US listings: symbol + exchange, symbol + suffix, or the IBKR conid.
export const NON_US_CASH_EQUIVALENTS = Object.freeze([
  Object.freeze({ root: 'IB01', exchanges: Object.freeze(['LSEETF', 'LSE']), suffixes: Object.freeze(['L']), conid: '354802220',
                  name: 'iShares $ Treasury Bond 0-1yr UCITS (accumulating)', accumulating: true }),
]);

// Flex asset categories that are cash by nature.
export const CASH_CATEGORIES = Object.freeze(['BILL']);

// Exchanges a bare US ticker may arrive with. Anything else on a US ticker is a different fund.
const US_EXCHANGES = new Set(['', 'NASDAQ', 'NYSE', 'ARCA', 'NYSEARCA', 'AMEX', 'BATS', 'BATSUS', 'BZX', 'CBOE', 'ISLAND', 'SMART', 'IEX', 'NMS', 'PSE', 'PINK']);

const up = (v) => String(v ?? '').toUpperCase().trim();

// "IB01.L" → { root: 'IB01', suffix: 'L' }; "IB01 LSEETF" → { root: 'IB01', exchange: 'LSEETF' }.
export function parseCashSymbol(symbol) {
  const s = up(symbol);
  const [head, exch] = s.split(/\s+/);
  const [root, suffix = ''] = (head || '').split('.');
  return { root, suffix, exchange: exch || '' };
}

// A string (a ticker as typed or stored) or a row / Flex position:
//   { symbol, assetCategory, listingExchange | exchange, conid }
export function isCashEquivalent(symbolOrRow) {
  const row = symbolOrRow && typeof symbolOrRow === 'object' ? symbolOrRow : { symbol: symbolOrRow };
  if (CASH_CATEGORIES.includes(up(row.assetCategory))) return true;
  const conid = row.conid != null ? String(row.conid).trim() : '';
  if (conid && NON_US_CASH_EQUIVALENTS.some(e => e.conid === conid)) return true;
  const { root, suffix, exchange: inSymbol } = parseCashSymbol(row.symbol);
  if (!root) return false;
  const exchange = up(row.listingExchange || row.exchange) || inSymbol;
  const nonUs = NON_US_CASH_EQUIVALENTS.find(e => e.root === root);
  if (nonUs) return nonUs.exchanges.includes(exchange) || nonUs.suffixes.includes(suffix);
  // A US ticker as typed, or with the .US suffix some feeds write — never with another market's.
  if (US_CASH_EQUIVALENTS.includes(root)) return (!suffix || suffix === 'US') && US_EXCHANGES.has(exchange);
  return false;
}

// Which kind, for the "Cash & equivalents" breakdown.
export function cashKind(symbolOrRow) {
  const row = symbolOrRow && typeof symbolOrRow === 'object' ? symbolOrRow : { symbol: symbolOrRow };
  if (CASH_CATEGORIES.includes(up(row.assetCategory))) return 'bill';
  return isCashEquivalent(row) ? 'fund' : null;
}

// An accumulating fund's price drift is its yield, not a trade's P&L.
export const isAccumulating = (symbolOrRow) => {
  const row = symbolOrRow && typeof symbolOrRow === 'object' ? symbolOrRow : { symbol: symbolOrRow };
  const { root } = parseCashSymbol(row.symbol);
  return isCashEquivalent(row) && NON_US_CASH_EQUIVALENTS.some(e => e.root === root && e.accumulating);
};
