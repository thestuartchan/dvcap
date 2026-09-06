// lib/hyperliquid.js — the venue's own numbers for a perpetual, and what carrying one costs.
//
// A crypto row prices off a Yahoo SPOT quote. If the position is actually a Hyperliquid perp, that
// quote is a proxy for the mark, and two things it cannot express change the P&L materially:
//
//   FUNDING. A perp has no expiry, so it is held to spot by a payment between the two sides, hourly
//   on Hyperliquid. Measured 2026-09-06: BTC funding 0.00125%/hr — 11.0% ANNUALISED, paid by the
//   long. A perp long held a month showing +3% is really +2.1%, and over a quarter the carry stops
//   being a correction and becomes the trade. Nothing in realised/unrealised P&L can see it.
//
//   BASIS. Mark 79,604 against a Yahoo spot of 79,629.91 is 0.033% apart, which is nothing — until
//   it is not. The basis widens exactly when it matters, and a row priced off spot would report a
//   perp's P&L wrong by the gap without anything looking unusual.
//
// This module reads PUBLIC MARKET DATA only: no key, no address, no account. It says what the
// venue's price and carry ARE; it never claims a position exists or reprices a row behind the
// user's back — a row could equally be spot held somewhere else, and inferring which from the
// symbol is the mistake this codebase keeps paying for.

export const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

// ── A PERP IS NAMED BY ITS VENUE, NOT BY ITS TICKER ──────────────────────────────────────────
// Pricing a Hyperliquid perp off a Yahoo <TICKER>-USD lookup is not an approximation, it is a
// different asset. Crypto has no central ticker registry, so the same three letters name different
// things on different venues, and the lookup succeeds either way. Measured 2026-09-06:
//
//   HYPE   HL mark 87.264     Yahoo HYPE-USD 0.0000054038   — a million times apart
//   PURR   HL mark 0.11914    Yahoo PURR-USD 126.50161      — a thousand times, the other way
//   JUP    HL mark 0.26668    Yahoo JUP-USD  0.000328901    — eight hundred times
//
// HYPE is Hyperliquid's own token and one of its three largest markets by open interest. A row
// typed HYPE-USD would have priced a position at a millionth of its value, with a real daily
// change, and every level and size derived from it.
//
// So a perp is written HL:COIN and priced by the venue that lists it. The prefix is not decoration
// — it is the statement that this instrument's price, funding and size step come from Hyperliquid
// and are not interchangeable with anyone else's.
export const HL_PREFIX = 'HL:';

// 'HL:BTC' -> 'BTC'. Anything else -> null, so a Yahoo symbol can never be read as a perp.
export function hlPerpCoin(sym) {
  const s = String(sym || '').trim().toUpperCase();
  if (!s.startsWith(HL_PREFIX)) return null;
  const coin = s.slice(HL_PREFIX.length);
  return /^[A-Z0-9]{1,20}$/.test(coin) ? coin : null;
}
export const isHlPerp = (sym) => hlPerpCoin(sym) != null;
export const FUNDING_PER_YEAR = 24 * 365;   // funding is settled hourly
// Above this the carry is a position-level fact rather than a detail: 20% a year is most of an
// equity risk premium, paid out of a directional bet that has to cover it before it earns anything.
export const FUNDING_LOUD_APR = 20;

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// A Yahoo pair maps to a Hyperliquid coin by its BASE leg: BTC-USD -> BTC. Returns null for
// anything that is not a spot pair, so an equity can never be looked up as a perp.
export function hlCoin(sym) {
  const m = /^([A-Z0-9]{2,10})-(USD|USDT|USDC|EUR|GBP|JPY)$/.exec(String(sym || '').toUpperCase());
  return m ? m[1] : null;
}

// Shape the venue's metaAndAssetCtxs reply into one record per coin. Pure, so the parsing is
// testable against a fixture rather than against the network.
export function parseMetaAndCtxs(payload) {
  const universe = payload?.[0]?.universe;
  const ctxs = payload?.[1];
  if (!Array.isArray(universe) || !Array.isArray(ctxs)) return {};
  const out = {};
  for (let i = 0; i < universe.length; i++) {
    const m = universe[i], c = ctxs[i];
    if (!m?.name || !c) continue;
    const funding = num(c.funding);
    const mark = num(c.markPx);
    out[m.name] = {
      coin: m.name,
      mark,
      oracle: num(c.oraclePx),
      mid: num(c.midPx),
      // Hourly. POSITIVE MEANS LONGS PAY SHORTS, which is the convention the venue publishes and
      // the one every sign below follows.
      funding,
      fundingApr: funding == null ? null : +(funding * FUNDING_PER_YEAR * 100).toFixed(2),
      openInterest: num(c.openInterest),
      prevDayPx: num(c.prevDayPx),
      // The venue's own size granularity. 133 of its 233 markets are szDecimals 0 — WHOLE UNITS
      // ONLY — so a single guessed step for "crypto" is wrong for most of them.
      szDecimals: Number.isFinite(+m.szDecimals) ? +m.szDecimals : null,
      sizeStep: Number.isFinite(+m.szDecimals) ? Number(`1e-${+m.szDecimals}`) : null,
      maxLeverage: num(m.maxLeverage),
    };
  }
  return out;
}

// What carrying one costs, and who pays. `side` is the position's direction.
export function fundingRead(rec, side = 'long') {
  const apr = rec?.fundingApr;
  if (apr == null) return null;
  const longPays = apr > 0;
  const isLong = String(side).toLowerCase() !== 'short';
  // You PAY when your side is the one funding is charged to.
  const paying = longPays === isLong && apr !== 0;
  const signed = +(isLong ? apr : -apr).toFixed(2);   // positive = a credit to this side
  return {
    apr, aprToSide: signed, paying,
    perDayPct: +(apr / 365).toFixed(4),
    perMonthPct: +(apr / 12).toFixed(2),
    loud: Math.abs(apr) >= FUNDING_LOUD_APR,
    note: apr === 0 ? 'funding is flat'
      : `${paying ? 'costs' : 'pays'} ${Math.abs(+(apr / 12).toFixed(2))}% a month `
        + `(${Math.abs(apr).toFixed(1)}% annualised) to hold this ${isLong ? 'long' : 'short'}`,
  };
}

// Spot against the venue's mark. Reported, never used to reprice — the row's own quote stays the
// row's own quote, and the gap is the thing worth seeing.
export function basisRead(spot, rec) {
  const s = num(spot), m = num(rec?.mark);
  if (s == null || m == null || m <= 0) return null;
  const pct = +(((s - m) / m) * 100).toFixed(3);
  return { spot: s, mark: m, diff: +(s - m).toFixed(6), pct, wide: Math.abs(pct) >= 0.5 };
}

// A quote for a perp row, shaped like the price feed's other entries so nothing downstream needs
// to know where it came from. `price` is the MARK — the number the venue marks the position at —
// not a spot proxy for it.
export function perpQuote(rec) {
  if (!rec || rec.mark == null) return null;
  const prev = num(rec.prevDayPx);
  return {
    price: rec.mark,
    changePercent: (prev != null && prev > 0) ? +(((rec.mark - prev) / prev) * 100).toFixed(2) : null,
    currency: 'USD',
    // Carried so the sizer can round to a size the venue will actually accept, rather than to a
    // step guessed from the fact that it is "crypto".
    sizeStep: rec.sizeStep ?? null,
    venue: 'hyperliquid',
  };
}

// Public market data. No key, no address, no account — see the header.
export async function fetchHyperliquid({ timeoutMs = 8000 } = {}) {
  try {
    const r = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, markets: {} };
    return { ok: true, error: null, markets: parseMetaAndCtxs(await r.json()) };
  } catch (e) {
    // A venue that does not answer must read as unknown, never as zero funding.
    return { ok: false, error: String(e?.message || e), markets: {} };
  }
}
