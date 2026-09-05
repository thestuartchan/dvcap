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
  // `minor: false` — the won and the yen have no sub-unit in circulation, so a decimal place on
  // them is not a formatting preference, it is a denomination that does not exist.
  KRW: { symbol: 'KRW=X', label: 'Korean Won',       peg: null,   sign: '₩', minor: false },
  CNY: { symbol: 'CNY=X', label: 'Chinese Yuan',     peg: 'managed', sign: 'CN¥', pegNote: 'managed float — PBOC sets a daily fix; less volatile than a free float, not pegged' },
  JPY: { symbol: 'JPY=X', label: 'Japanese Yen',     peg: null,   sign: '¥',   minor: false },
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
// ── ONE MONEY FORMAT, NOT TWO ────────────────────────────────────────────────────────────────
// The rule was `abs >= 1000 ? 0 : 2`, which put "$847.20" and "$1,203" in the same column and made
// the reader do a double-take at the boundary — the same quantity changed shape depending on how
// big it happened to be that day. Worse at the totals line, where a book crossing $1,000 silently
// changed its own precision.
//
// Money is now WHOLE UNITS. Cents on a five-figure P&L are noise pretending to be precision, and
// nothing here is an accounting ledger: these are position values, notional and risk budgets, all
// of which are decided to the nearest dollar or not at all.
//
// The one exception is the repo's standing rule that a non-zero figure must never render as zero
// (see pcNonZero in lib/tradecard.js, and the RKLB stop that printed "−0%" while 0.21% away).
// Per-unit risk is the case that bites: $0.42 a share is a real number and "$0" is not a rounder
// version of it, it is a different claim. So the format steps up to cents, and then to four
// places, only when whole units would erase the amount entirely — never for cosmetics.
export function fmtCcy(amount, code) {
  if (amount == null || !Number.isFinite(+amount)) return '—';
  const meta = CURRENCIES[code] || { sign: '' };
  const v = +amount;
  const abs = Math.abs(v);
  const at = (dp) => +abs.toFixed(dp) > 0;
  // A currency with no minor unit never gets one, even to avoid a zero — ¥0.42 is not a thing.
  // The ladder stops at four places and then gives up honestly: "$0.0000" claims to have measured
  // something to a hundredth of a cent and found nothing, where "$0" simply says it is nothing.
  const dp = (abs === 0 || at(0) || meta.minor === false) ? 0 : at(2) ? 2 : at(4) ? 4 : 0;
  const body = abs.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  // THE SIGN GOES OUTSIDE. "$-1,235" reads as a currency called "$-" before it reads as a loss,
  // and every negative on this dashboard is a loss. Formatted from the magnitude so the minus is
  // attached last — which also means a value that rounds to nothing prints "$0", never "-$0".
  const sign = (v < 0 && +abs.toFixed(dp) > 0) ? '-' : '';
  return `${sign}${meta.sign || code + ' '}${body}`;
}

// ─── QUOTE CURRENCY vs DECLARED CURRENCY ─────────────────────────────────────
// A row carries TWO different currencies and they are not interchangeable. The BASE currency is
// the reporting currency — what the book totals in. The ROW currency is the quote currency of the
// instrument, which belongs to the exchange, not to a preference. Seeding a new row from the base
// would be exactly wrong: with a USD base, 0981.HK still trades in HKD.
//
// Rows were seeded `currency: 'USD'` unconditionally, so any non-US listing was silently valued in
// the wrong unit until someone noticed and fixed it by hand — and a HKD position read as USD
// overstates the book by the FX rate, roughly 7.8x, without anything on screen looking broken.
// Yahoo reports the quote currency; this decides what to do with it.
//
// The distinction that matters is whether MONEY HAS BEEN RECORDED against the row yet:
//   - no fills, currency never touched → adopt. Nothing has been entered, so nothing is invalidated.
//   - fills exist, or the user set it deliberately → never overwrite. The fills were entered in
//     some currency and silently reinterpreting them would corrupt real numbers. Warn instead.
export function resolveRowCurrency({ rowCcy, quoteCcy, hasFills = false, userSet = false } = {}) {
  const row = typeof rowCcy === 'string' && rowCcy ? rowCcy.toUpperCase() : 'USD';
  const quote = typeof quoteCcy === 'string' && /^[A-Z]{3}$/i.test(quoteCcy) ? quoteCcy.toUpperCase() : null;
  // No quote yet (unknown ticker, futures with no Yahoo listing, prices not fetched) is not a
  // disagreement — it is silence, and silence never overrides a declared value.
  if (!quote || quote === row) return { action: 'ok', currency: row, quote, note: null };
  if (!hasFills && !userSet) {
    return { action: 'adopt', currency: quote, quote, note: `quoted in ${quote} — currency set from the exchange` };
  }
  return {
    action: 'warn', currency: row, quote,
    note: hasFills
      ? `this row is set to ${row} but ${quote} is the quote currency — the fills, cost basis and P&L are out by the ${quote}/${row} rate until one of them changes`
      : `this row is set to ${row} but ${quote} is the quote currency`,
  };
}
