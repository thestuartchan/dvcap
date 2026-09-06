// lib/crypto.js — which symbol actually gets you the coin.
//
// "Do I type BTC, or BTCUSD, or BTC-USD?" turns out to be the most dangerous question in the
// console, because the wrong answers do not fail — they succeed, quietly, on something else.
// Measured against the live feed on 2026-09-06:
//
//   BTC   → Grayscale Bitcoin Mini Trust ETF   $35.31    (spot bitcoin: $79,707.77)
//   ETH   → Grayscale Ethereum Mini Trust ETF  $23.43    (spot ether:    $2,480.88)
//   XRP   → Bitwise XRP ETF                    $15.65    (spot XRP:      $1.4111)
//   LINK  → Interlink Electronics, Inc.        $5.40     — not crypto in any sense
//   BTCUSD, BTCUSDT                            no quote at all
//
// A row typed as BTC therefore shows a real price, with a real daily change, for a security the
// person did not buy — and a 2,000x error in the level distances and the position size that follow
// from it. LINK is the sharpest case: an unrelated electronics manufacturer at a plausible number.
//
// The answer is that the quote feed wants the PAIR, hyphenated: BTC-USD. This module says so at
// the point the symbol is typed, and distinguishes the three ways of getting it wrong, because
// they do not deserve the same response — one is punctuation, one is a different quote currency,
// and one is a different instrument entirely.

// Base assets that are also live tickers for something else, or that people habitually type bare.
// Not exhaustive and does not need to be: an unrecognised base simply gets no hint, and the pair
// forms below are recognised structurally rather than from this list.
export const CRYPTO_BASES = Object.freeze(new Set([
  'BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'ADA', 'LINK', 'AVAX', 'DOT', 'MATIC', 'LTC', 'BCH',
  'SHIB', 'PEPE', 'BONK', 'TRX', 'TON', 'NEAR', 'ATOM', 'UNI', 'AAVE', 'ARB', 'OP', 'SUI',
]));

// What the quote feed actually accepts as the quote leg.
export const FIAT_QUOTES = Object.freeze(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF']);
// Stablecoins are how exchanges quote, and are NOT what the feed carries. They are close to the
// dollar and not the dollar, so substituting one is a statement worth making out loud.
export const STABLE_QUOTES = Object.freeze(['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD']);

const up = (s) => String(s || '').trim().toUpperCase();

// { ok, kind, symbol, suggestion, note }
//   ok:false means the symbol as typed will not price the coin.
//   kind: 'pair' | 'punctuation' | 'stablecoin' | 'bare' | null (not crypto-shaped at all)
export function cryptoSymbolCheck(sym) {
  const s = up(sym);
  if (!s) return { ok: true, kind: null, symbol: s, suggestion: null, note: null };

  // Already the form the feed wants.
  const fiat = new RegExp(`^([A-Z0-9]{2,10})-(${FIAT_QUOTES.join('|')})$`).exec(s);
  if (fiat) return { ok: true, kind: 'pair', symbol: s, suggestion: null, note: null };

  // Hyphenated but quoted in a stablecoin — the feed does not carry these.
  const stableHyph = new RegExp(`^([A-Z0-9]{2,10})-(${STABLE_QUOTES.join('|')})$`).exec(s);
  if (stableHyph) return stable(stableHyph[1], stableHyph[2], s);

  // Unhyphenated pair. BTCUSDT must be tested BEFORE BTCUSD or the longer suffix never matches.
  const stableRun = new RegExp(`^([A-Z0-9]{2,10}?)(${STABLE_QUOTES.join('|')})$`).exec(s);
  if (stableRun && CRYPTO_BASES.has(stableRun[1])) return stable(stableRun[1], stableRun[2], s);

  const fiatRun = new RegExp(`^([A-Z0-9]{2,10}?)(${FIAT_QUOTES.join('|')})$`).exec(s);
  if (fiatRun && CRYPTO_BASES.has(fiatRun[1])) {
    const want = `${fiatRun[1]}-${fiatRun[2]}`;
    return { ok: false, kind: 'punctuation', symbol: s, suggestion: want,
      note: `the quote feed writes this pair with a hyphen — ${s} returns nothing at all. Use ${want}.` };
  }

  // A bare base. The dangerous one: it often prices SOMETHING, just not this.
  if (CRYPTO_BASES.has(s)) {
    return { ok: false, kind: 'bare', symbol: s, suggestion: `${s}-USD`,
      note: `${s} on its own is a listed security, not the coin — BTC prices the Grayscale trust at ~$35 `
          + `while spot bitcoin is ~$80,000, and LINK prices an electronics manufacturer. It will show a `
          + `real price for the wrong thing. Use ${s}-USD for spot, or ${s}=F for the CME contract.` };
  }
  return { ok: true, kind: null, symbol: s, suggestion: null, note: null };
}

function stable(base, quote, typed) {
  const want = `${base}-USD`;
  return { ok: false, kind: 'stablecoin', symbol: typed, suggestion: want,
    note: `the quote feed carries fiat pairs, not ${quote} — ${typed} returns nothing. ${want} is the closest `
        + `it has, but ${quote} is a stablecoin and not the dollar, so the two can differ around a de-peg.` };
}

// The quote symbol to actually fetch. Punctuation and stablecoin forms are resolved, because both
// name the coin unambiguously and neither prices anything as typed. A BARE base is never resolved:
// it is a real ticker for a real security, and silently turning BTC into BTC-USD would be the same
// class of guess — inferring intent from a symbol — that this whole area keeps getting wrong.
export function cryptoQuoteSymbol(sym) {
  const c = cryptoSymbolCheck(sym);
  return (c.kind === 'punctuation' || c.kind === 'stablecoin') ? c.suggestion : up(sym);
}

// Is this row a spot coin — the thing you can own 0.25 of? True for the pair forms the feed
// carries and for the two that resolve to them; deliberately FALSE for a bare base, which prices a
// listed security, and false for futures, which trade in whole contracts.
export function isSpotCrypto(sym) {
  const c = cryptoSymbolCheck(sym);
  return c.kind === 'pair' || c.kind === 'punctuation' || c.kind === 'stablecoin';
}

// ── ONE BOOK OR TWO ───────────────────────────────────────────────────────────────────────────
// TradFi and crypto share no session, settlement, weekend or volatility regime, so a single list
// sorted by date invites a comparison between them that means nothing. Defined ONCE here because
// three places now need it — the Discord positions block, the Watching field, the closed card, and
// the console archive in both its wide and narrow forms — and any two of them disagreeing about
// what belongs where is a worse bug than not splitting at all.
//
// `mixed` is the whole point: split only when BOTH are present. A heading over an all-equity book
// is a label that never varies, which is exactly why the direction column was removed from the
// card in the first place.
export function splitByClass(items = [], symbolOf = (x) => x?.symbol) {
  const crypto = [], tradfi = [];
  for (const it of items) (isSpotCrypto(symbolOf(it)) ? crypto : tradfi).push(it);
  return { tradfi, crypto, mixed: tradfi.length > 0 && crypto.length > 0 };
}

// The two groups in reading order, or one unlabelled group when the book is all one thing.
export function assetClassGroups(items = [], { symbolOf, sort } = {}) {
  const s = splitByClass(items, symbolOf);
  const ord = (list) => (sort ? [...list].sort(sort) : list);
  return s.mixed
    ? [{ label: 'TradFi', rows: ord(s.tradfi) }, { label: 'Crypto', rows: ord(s.crypto) }]
    : [{ label: null, rows: ord(items) }];
}
