// lib/fxrates.js — multi-currency support for the trade console.
//
// ONE CONVENTION, ENFORCED. Every rate here is `XXX=X` from Yahoo, which means UNITS OF XXX PER 1
// USD (HKD 7.84, AED 3.67, KRW 1382, EUR 0.856). So converting to USD is always `amount / rate` and
// never the inverse. The tempting alternative — Yahoo's `EURUSD=X`, quoted USD-per-EUR — inverts for
// that one currency, and a mixed convention is precisely the bug class lib/smicah.js already had to
// guard against in the A/H premium (it prefers a direct cross specifically to avoid convention
// ambiguity). One direction for every currency, no exceptions.
//
// PEGS MATTER. Two of the currencies in this book do not float against the dollar: AED is hard-
// pegged at 3.6725 and HKD runs a 7.75–7.85 band. Treating those as FX risk alongside EUR and KRW
// would overstate the risk in the book. Each currency carries its peg status so the console can say
// which exposure is real.
//
// Rates are fetched through the EXISTING /api/prices passthrough (a generic Yahoo proxy), so
// multi-currency adds no serverless function — the Hobby cap stays at 8/12.

export const CURRENCIES = Object.freeze({
  USD: { symbol: null,    label: 'US Dollar',        peg: null,   sign: '$'   },
  HKD: { symbol: 'HKD=X', label: 'Hong Kong Dollar', peg: 'band', sign: 'HK$', pegNote: 'HKMA band 7.75–7.85 vs USD — effectively no FX risk against a USD base' },
  AED: { symbol: 'AED=X', label: 'UAE Dirham',       peg: 'hard', sign: 'AED', pegRate: 3.6725, pegNote: 'hard-pegged at 3.6725 vs USD — no FX risk against a USD base' },
  EUR: { symbol: 'EUR=X', label: 'Euro',             peg: null,   sign: '€'   },
  KRW: { symbol: 'KRW=X', label: 'Korean Won',       peg: null,   sign: '₩'   },
  CNY: { symbol: 'CNY=X', label: 'Chinese Yuan',     peg: 'managed', sign: 'CN¥', pegNote: 'managed float — PBOC sets a daily fix; less volatile than a free float, not pegged' },
  JPY: { symbol: 'JPY=X', label: 'Japanese Yen',     peg: null,   sign: '¥'   },
  GBP: { symbol: 'GBP=X', label: 'Pound Sterling',   peg: null,   sign: '£'   },
});

export const CURRENCY_CODES = Object.keys(CURRENCIES);

// The Yahoo symbols /api/prices must fetch to price a set of currencies. USD needs none.
export function fxSymbolsFor(codes = CURRENCY_CODES) {
  return [...new Set(codes)].map(c => CURRENCIES[c]?.symbol).filter(Boolean);
}

// Build a rate table (units per USD) from an /api/prices response. USD is always exactly 1.
// A currency whose quote is missing is OMITTED rather than defaulted — except a hard peg, which
// falls back to its published parity because that is a real published rate, not a guess.
export function ratesFrom(prices = {}) {
  const rates = { USD: 1 }, sources = { USD: 'base' };
  for (const [code, meta] of Object.entries(CURRENCIES)) {
    if (code === 'USD') continue;
    const q = prices?.[meta.symbol];
    const v = q?.price;
    if (v != null && Number.isFinite(+v) && +v > 0) {
      rates[code] = +v;
      sources[code] = meta.symbol;
    } else if (meta.peg === 'hard' && meta.pegRate) {
      rates[code] = meta.pegRate;
      sources[code] = 'published peg';
    }
  }
  return { rates, sources };
}

// Convert between any two currencies through USD. Returns null when either leg is unavailable —
// a missing rate must read as missing, never as an unconverted number that looks converted.
export function convert(amount, from, to, rates = {}) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return null;
  if (from === to) return a;
  const rf = rates[from], rt = rates[to];
  if (!Number.isFinite(rf) || !Number.isFinite(rt) || rf <= 0 || rt <= 0) return null;
  return (a / rf) * rt;   // → USD, → target
}

export const toUsd = (amount, from, rates) => convert(amount, from, 'USD', rates);

// Does this currency carry real FX risk against the given base? A pegged pair does not.
export function fxRisk(code, base = 'USD') {
  if (code === base) return { real: false, note: 'same currency' };
  const meta = CURRENCIES[code];
  if (!meta) return { real: true, note: 'unknown currency — treat as floating' };
  if (base === 'USD' && (meta.peg === 'hard' || meta.peg === 'band')) {
    return { real: false, peg: meta.peg, note: meta.pegNote };
  }
  if (base === 'USD' && meta.peg === 'managed') {
    return { real: true, peg: 'managed', note: meta.pegNote };
  }
  return { real: true, note: `${code}/${base} floats — position value moves with the cross` };
}

// Format an amount in its own currency. Deliberately not locale-aware beyond grouping: the point
// is legibility next to a base-currency figure, not accounting presentation.
export function fmtCcy(amount, code) {
  if (amount == null || !Number.isFinite(+amount)) return '—';
  const meta = CURRENCIES[code] || { sign: '' };
  const abs = Math.abs(+amount);
  const dp = abs >= 1000 ? 0 : 2;
  const body = (+amount).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return `${meta.sign || code + ' '}${body}`;
}
