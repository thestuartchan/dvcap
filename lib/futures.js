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
});

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
