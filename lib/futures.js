// lib/futures.js — what one futures contract is worth per point of price.
//
// WHY THIS EXISTS. The archive posted MGC at −$242.00 on a two-lot that moved 121 points. The real
// figure is −$2,420.00: MGC is ten troy ounces, and the row carried no multiplier, so everything
// money-valued was computed at ×1. The percentage beside it (−2.69%) was correct, because a
// percentage is multiplier-free — it cancels top and bottom — which is exactly why nothing looked
// wrong. One row, ten times out, sitting next to a figure that agreed with it.
//
// The knowledge was already in the project, in prose: sizing.js says "a single MGC is ten ounces of
// gold and a single MNQ is two index points", positions.js works a roll basis "at ×10". Comments
// cannot set a field. So the contracts are named here, once, and read by both the console and the
// broker sync.
//
// THE TABLE IS ALLOWED TO BE INCOMPLETE. IT IS NOT ALLOWED TO BE WRONG.
// A missing entry returns null and the caller must say so — it must never fall back to 1, because
// on a margined instrument 1 is not a neutral default, it is a specific and confidently wrong
// answer. Everything below is a standard listed contract size; a contract not listed here is
// reported as unknown so it gets set by hand rather than guessed at.
//
// Units are "money per one point of the quoted price", which is what derivePosition multiplies by.

export const FUTURES_MULTIPLIER = Object.freeze({
  // CME equity index — dollars per index point
  ES: 50, MES: 5,        // E-mini / Micro E-mini S&P 500
  NQ: 20, MNQ: 2,        // E-mini / Micro E-mini Nasdaq-100
  YM: 5,  MYM: 0.5,      // E-mini / Micro E-mini Dow
  RTY: 50, M2K: 5,       // E-mini / Micro E-mini Russell 2000

  // COMEX metals — the unit is the contract size, and price is quoted per unit
  GC: 100, MGC: 10,      // Gold: 100 oz / 10 oz
  SI: 5000, SIL: 1000,   // Silver: 5,000 oz / 1,000 oz
  HG: 25000, MHG: 2500,  // Copper: 25,000 lb / 2,500 lb
  PL: 50,                // Platinum: 50 oz

  // NYMEX energy
  CL: 1000, MCL: 100,    // WTI crude: 1,000 bbl / 100 bbl
  NG: 10000, MNG: 1000,  // Natural gas: 10,000 MMBtu / 1,000 MMBtu
  RB: 42000, HO: 42000,  // Gasoline / heating oil: 42,000 gal

  // CBOT rates — dollars per point of a price quoted in points of face
  ZT: 2000,              // 2-year note, $200,000 face
  ZF: 1000, ZN: 1000, TN: 1000, ZB: 1000, UB: 1000,

  // CME crypto
  BTC: 5, MBT: 0.1,      // Bitcoin: 5 BTC / 0.1 BTC
  ETH: 50, MET: 0.1,     // Ether: 50 ETH / 0.1 ETH

  // ── CME FX — READ THE NOTE BELOW BEFORE ADDING TO THIS BLOCK ──────────────
  // The multiplier IS the contract size, because these are quoted as US dollars per unit of the
  // foreign currency. That is the whole hazard: MJY prints 0.00641, not 156.
  '6J': 12500000, MJY: 1250000,   // Japanese yen: 12.5m / 1.25m
  '6E': 125000,   M6E: 12500,     // Euro: 125,000 / 12,500
  '6B': 62500,    M6B: 6250,      // Sterling: 62,500 / 6,250
  '6A': 100000,   M6A: 10000,     // Australian dollar: 100,000 / 10,000
});

// ── THE FX QUOTATION TRAP ────────────────────────────────────────────────────
// A yen future is quoted in US DOLLARS PER YEN and prints 0.00641. USD/JPY — the number anyone
// would say out loud — is 156.115. They are the same market, reciprocal, roughly 24,000x apart,
// and a fill entered in the wrong one is wrong by that factor AND in the wrong direction, because
// one rises exactly when the other falls.
//
// This is why FX sat outside the table until it was needed. It is in now, and the convention is
// carried with it so a row can SAY which number it wants rather than leaving the reader to notice
// that the live price has four leading zeros.
const FX_QUOTE = Object.freeze({
  '6J': 'JPY', MJY: 'JPY', '6E': 'EUR', M6E: 'EUR',
  '6B': 'GBP', M6B: 'GBP', '6A': 'AUD', M6A: 'AUD',
});

// A sentence for the row, or null when the symbol is not an FX contract.
export function quoteConvention(symbol) {
  const root = futuresRoot(symbol);
  const cur = FX_QUOTE[root];
  if (!cur) return null;
  const inverse = cur === 'JPY' ? 'USD/JPY (~156)' : `${cur}/USD inverted`;
  return {
    root, currency: cur,
    unit: `USD per ${cur}`,
    note: cur === 'JPY'
      ? `Quoted in US dollars per yen — the price is ~0.0064, NOT ${inverse}. They are reciprocals about 24,000x apart, so a fill entered the other way round is wrong by that factor and in the wrong direction.`
      : `Quoted in US dollars per ${cur} — enter fills in the same units the price above is showing, not as ${inverse}.`,
  };
}

// Does a fill price plausibly belong to the same quotation as the live one? Not a precision check
// — a factor-of-ten gap is not a market move in any currency pair, it is the wrong convention.
export const FX_MISQUOTE_RATIO = 10;
export function looksMisquoted(symbol, fillPrice, livePrice) {
  const f = Number(fillPrice), l = Number(livePrice);
  if (!quoteConvention(symbol)) return null;                  // not an FX contract
  if (!Number.isFinite(f) || !Number.isFinite(l) || f <= 0 || l <= 0) return null;
  const ratio = f > l ? f / l : l / f;
  return ratio >= FX_MISQUOTE_RATIO ? +ratio.toFixed(0) : null;
}

// DELIBERATELY ABSENT: grains and FX. Grains are quoted in cents per bushel, so whether the
// multiplier is 50 or 5,000 depends on the units the price was entered in — a table cannot know
// that, and a wrong answer here is worse than no answer. FX contracts carry their own quoting
// conventions per pair. Both fall through to `unknown`, which is the honest result.

// The console holds a root ("MGC"); IBKR sends a dated contract ("MGCZ6", "MNQU26"); Yahoo sends
// "MGCZ26=F". Reduce all three to the root. Only a MONTH CODE + year tail is stripped, so a ticker
// that merely ends in a letter and digits is left alone.
const MONTH = 'FGHJKMNQUVXZ';
export function futuresRoot(symbol) {
  let s = String(symbol || '').toUpperCase().trim();
  if (!s) return '';
  s = s.replace(/=F$/, '');
  const m = new RegExp(`^([A-Z0-9]{1,5}?)([${MONTH}])(\\d{1,2})$`).exec(s);
  // Only treat the tail as a contract code when what remains is itself a known root — otherwise
  // "SIL" would strip to "SI" on nothing but the shape of its letters.
  if (m && Object.prototype.hasOwnProperty.call(FUTURES_MULTIPLIER, m[1])) return m[1];
  return s;
}

// The answer, and where it came from. `source` matters: a caller has to be able to tell a figure
// the broker stated from one this table supplied from one nobody knows.
//
//   'statement' — the broker sent it; authoritative, and used even where the table disagrees
//   'table'     — a standard contract size from the list above
//   'shares'    — not a derivative; 1 is correct rather than assumed
//   'unknown'   — a margined instrument this file does not know: null, and the caller must say so
export function multiplierFor(symbol, { stated = null, margined = false, assetCategory = null } = {}) {
  const root = futuresRoot(symbol);
  const isFuture = !!margined || /^(FUT|CFD|FOP)$/i.test(String(assetCategory || ''));
  const said = Number(stated);
  if (Number.isFinite(said) && said > 0) {
    const known = FUTURES_MULTIPLIER[root];
    return {
      multiplier: said, source: 'statement', root,
      // NOT an error, and not silently resolved either. The broker wins — it is reporting the
      // contract it actually holds — but a disagreement means either this table is wrong or the
      // listing changed, and both are worth a human seeing once.
      ...(known != null && Math.abs(known - said) > 1e-9 ? { disagrees: { table: known, stated: said } } : {}),
    };
  }
  if (!isFuture) return { multiplier: 1, source: 'shares', root };
  const known = FUTURES_MULTIPLIER[root];
  if (known != null) return { multiplier: known, source: 'table', root };
  return { multiplier: null, source: 'unknown', root };
}

// ── WHICH ROOTS A TICKER COULD ALSO BE ──────────────────────────────────────
// The backfill below refuses to key off the symbol alone for these, because each is ALSO a real
// listed equity or fund ticker and repricing a share position at a contract multiplier would be a
// far worse bug than the one being fixed:
//
//   MET MetLife · PL Planet Labs · CL Colgate · ES Eversource · NG NovaGold · SI Silvergate
//   HG Hamilton Insurance · GC Gyrodyne · RB Ryman · HO HomeStreet
//   SIL Global X Silver Miners ETF · MBT (a long-listed ADR)
//
// Everything NOT on this list is unambiguous: nothing trades as "MGC" or "MNQ" except the
// contract. Those can be identified from the symbol, which is what the first version of the
// backfill was too blunt to do — it required `margined` on every root and so left the MGC row that
// started all this sitting in a review list instead of fixing it.
export const EQUITY_AMBIGUOUS = Object.freeze(new Set(
  ['MET', 'PL', 'CL', 'ES', 'NG', 'SI', 'HG', 'GC', 'RB', 'HO', 'SIL', 'MBT']));

export const isUnambiguousFuture = (symbol) => {
  const root = futuresRoot(symbol);
  return Object.prototype.hasOwnProperty.call(FUTURES_MULTIPLIER, root) && !EQUITY_AMBIGUOUS.has(root);
};

// ── FIXING WHAT IS ALREADY STORED ────────────────────────────────────────────
// Setting the size at creation fixes every future row and none of the existing ones, and MGC ran a
// month at x1 before anyone noticed. A hand edit would do for the row that was spotted; it would
// not touch the ones that were not, and the rows live in storage rather than in the repo, so there
// is no way to look.
//
// WHY THIS KEYS OFF `margined` AND NOT THE SYMBOL. Ten roots in the table above are also real
// equity tickers — MET is MetLife, PL is Planet Labs, CL is Colgate, ES is Eversource, and NG, SI,
// HG, GC, RB, HO all trade as shares too. Backfilling by symbol would silently reprice a MetLife
// holding at x0.1 and a Colgate one at x1000, which is a far worse bug than the one being fixed.
// `margined` is an explicit statement that the row IS a contract, so a collision cannot occur.
//
// Rows whose symbol looks like a contract but are not marked margined are REPORTED, never touched.
// That list is exactly where a human eye is needed and a table is no help.
export function backfillMultipliers(rows = []) {
  const out = [], fixed = [], review = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const m = Number(r?.multiplier);
    const has = Number.isFinite(m) && m > 1;
    const root = futuresRoot(r?.symbol);
    const known = FUTURES_MULTIPLIER[root];
    if (known == null || has) { out.push(r); continue; }

    // Two ways to be sure this row is a contract: the row says so, or the symbol can only be one.
    const sure = !!r?.margined || isUnambiguousFuture(r?.symbol);
    if (sure) {
      fixed.push({
        id: r.id, symbol: r.symbol, root,
        from: Number.isFinite(m) ? m : null, to: known,
        by: r?.margined ? 'margined' : 'symbol',
        // A futures contract is held on margin whether or not the row remembered to say so, and
        // the exposure figures read that flag. Fixing the multiplier and leaving the row counted
        // as capital committed would trade one wrong number for another.
        alsoMargined: !r?.margined,
      });
      out.push({ ...r, multiplier: known, margined: true });
      continue;
    }
    // Named like a contract, and also a real share ticker. Only the holder knows which.
    review.push({ id: r.id, symbol: r.symbol, root, wouldBe: known });
    out.push(r);
  }
  return { rows: out, fixed, review, changed: fixed.length > 0 };
}
