// lib/futuresQuote.js — futures Yahoo does not carry, quoted from TradingView instead (24 Nov 2026).
//
// WHY. Rows on a margined contract are quoted as `<ROOT>=F` on Yahoo. Yahoo has no OSE listings,
// so the OSE Micro Nikkei (IBKR root N225MC) came back empty: the tracker card and the console
// showed "—" for its price and P&L, and its stop level could never be judged — an alert that
// cannot fire. TradingView's public quote endpoint (the one lib/tradingview.js tvDaily already
// reads) carries the exact contract, 15 minutes delayed.
//
// THE CONTRACT, NOT THE ROOT. A row that carries its expiry is quoted on that month
// (OSE:NK225MCH2027 for March 2027); without one, on the front month (OSE:NK225MC1!), which
// differs from a later month by the calendar spread (about 140 points on 24 Nov 2026).
//
// ALLOW-LISTED. /api/prices only sends a TradingView symbol upstream when its prefix is in this
// table, so the route cannot be used to query arbitrary symbols.
const MONTHS = 'FGHJKMNQUVXZ';

export const TV_FUTURES = Object.freeze({
  // IBKR root → TradingView root, the quote currency, and the delay of the public feed.
  N225MC: { tv: 'OSE:NK225MC', currency: 'JPY', delayMin: 15, label: 'OSE Micro Nikkei 225' },
});

const rootOf = (sym) => String(sym || '').trim().toUpperCase().replace(/=F$/, '');

// 'YYYY-MM-DD' | 'YYYYMMDD' | 'YYYY-MM' → 'H2027'; anything else → null.
export function monthCode(expiry) {
  const m = /^(\d{4})-?(\d{2})/.exec(String(expiry || ''));
  if (!m) return null;
  const mm = Number(m[2]);
  return mm >= 1 && mm <= 12 ? `${MONTHS[mm - 1]}${m[1]}` : null;
}

// The TradingView symbol for a futures row (its symbol and, when known, its expiry), or null when
// the root is not one Yahoo lacks.
export function tvFutureSymbol(symbol, expiry = null) {
  const spec = TV_FUTURES[rootOf(symbol)];
  if (!spec) return null;
  const code = monthCode(expiry);
  return code ? `${spec.tv}${code}` : `${spec.tv}1!`;
}

// The table entry a requested TradingView symbol belongs to, or null (the allow-list check).
export function tvSpecFor(tvSymbol) {
  const s = String(tvSymbol || '').trim().toUpperCase();
  return Object.values(TV_FUTURES).find(x => s === `${x.tv}1!` || new RegExp(`^${x.tv.replace(':', '\\:')}[${MONTHS}]\\d{4}$`).test(s)) || null;
}
