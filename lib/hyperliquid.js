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

// ── LIQUIDATION, WHICH IS THE STOP THE VENUE ENFORCES ─────────────────────────────────────────
// At up to 40x the exchange closes the position before any stop of yours does. The console's risk
// model assumes the stop is the binding constraint, so if the liquidation price sits inside it the
// stop is fiction and every R on the row is wrong.
//
// The formula is Hyperliquid's own, not derived here:
//
//     liq_price = price - side * margin_available / position_size / (1 - l * side)
//
// with side = +1 long / -1 short, l = 1 / MAINTENANCE_LEVERAGE, and maintenance margin defined as
// HALF the initial margin at max leverage — so MAINTENANCE_LEVERAGE = 2 x maxLeverage, giving
// 1.25% on a 40x market and 16.7% on a 3x one.
//
// For an ISOLATED position of notional N at leverage L:
//     margin_available  = N/L - N*mmf          (isolated margin less maintenance)
//     position_size     = N/entry
//   so margin_available / position_size = entry * (1/L - mmf)
//
// CROSS MARGIN IS A DIFFERENT NUMBER and this does not attempt it: there, margin_available is the
// whole account value less maintenance across every position, so the liquidation price of one leg
// depends on all the others and cannot be computed from the row alone. An estimate that quietly
// assumed isolated would be most wrong exactly when the account is most loaded.
export const MAINTENANCE_LEVERAGE_MULTIPLE = 2;
export const maintenanceMarginFraction = (maxLeverage) =>
  (Number.isFinite(+maxLeverage) && +maxLeverage > 0) ? 1 / (MAINTENANCE_LEVERAGE_MULTIPLE * +maxLeverage) : null;

// Leverage available at a given position value. The venue publishes TIERS — BTC is 40x up to
// $150m notional and 20x above it — so "max leverage" is a function of size, not a constant.
export function leverageAt(tiers, maxLeverage, notional) {
  const n = num(notional);
  if (!Array.isArray(tiers) || !tiers.length) return num(maxLeverage);
  let best = num(maxLeverage);
  for (const t of tiers) {
    const lb = num(t?.lowerBound), lev = num(t?.maxLeverage);
    if (lb == null || lev == null) continue;
    if (n == null) { best = Math.max(best ?? 0, lev); continue; }
    if (n >= lb) best = lev;                       // tiers are ascending; the last one passed wins
  }
  return best;
}

// An ESTIMATE, for planning a position that does not exist yet. When a real position exists the
// exchange reports its own liquidationPx and that is used instead — this never overrides it.
export function estimateLiquidation({ entry, leverage, side = 'long', maxLeverage, tiers = null, notional = null } = {}) {
  const e = num(entry), L = num(leverage);
  const sgn = String(side).toLowerCase() === 'short' ? -1 : 1;
  const lev = leverageAt(tiers, maxLeverage, notional);
  const mmf = maintenanceMarginFraction(lev);
  if (e == null || e <= 0 || L == null || L <= 0 || mmf == null) return null;
  if (L > lev) {
    return { liq: null, over: true, tierMaxLeverage: lev,
      note: `the venue caps this market at ${lev}x${notional ? ' at this size' : ''}` };
  }
  // Unleveraged there is nothing to liquidate: 1/1 - mmf over 1 - mmf is exactly 1, so the price
  // has to reach zero. That identity is the test this formula has to pass.
  const move = e * ((1 / L) - mmf) / (1 - mmf * sgn);
  const liq = +(e - sgn * move).toFixed(8);
  return {
    liq: liq > 0 ? liq : 0,
    over: false,
    side: sgn > 0 ? 'long' : 'short',
    leverage: L,
    tierMaxLeverage: lev,
    maintenanceMarginPct: +(mmf * 100).toFixed(4),
    // How far the price has to move against you. The number worth reading.
    distancePct: +(((liq - e) / e) * 100).toFixed(2),
    isolated: true,
    note: 'isolated-margin estimate — cross margin depends on the whole account and is not modelled',
  };
}

// Is the exchange's stop inside yours? If so the stop is fiction and the R on the row is wrong.
export function liquidationVsStop({ liq, stop, side = 'long' } = {}) {
  const l = num(liq), s = num(stop);
  if (l == null || s == null) return null;
  const short = String(side).toLowerCase() === 'short';
  // A long is liquidated BELOW; its stop is also below. The liquidation binds first if it is the
  // NEARER of the two to the price — i.e. above the stop for a long, below it for a short.
  const liqFirst = short ? l < s : l > s;
  return { liqFirst, liq: l, stop: s,
    note: liqFirst
      ? 'the exchange liquidates before this stop is reached — the stop cannot protect the position and R is overstated'
      : 'the stop is reached first, so it binds' };
}

// ── A REAL POSITION, FROM THE ACCOUNT THAT HOLDS IT ───────────────────────────────────────────
// Read-only, by ADDRESS. There is no key and no signature: the venue answers this for any address
// anyone asks about, which is how public position-watching tools work. The address is not a
// credential — it is an IDENTIFIER, and the same one on every EVM chain, so it belongs in an
// environment variable and never in the repo, a log, or anything the card can reach.
//
// The exchange reports its OWN liquidation price here. That is authoritative and always preferred
// over the estimate above, which exists for positions that do not yet exist.
export function parsePositions(payload) {
  const rows = payload?.assetPositions;
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const ap of rows) {
    const p = ap?.position;
    if (!p?.coin) continue;
    const szi = num(p.szi);
    if (szi == null || szi === 0) continue;          // flat is not a position
    out.push({
      coin: p.coin,
      // Hyperliquid signs size: negative is short. Same convention lib/side.js normalises.
      side: szi < 0 ? 'short' : 'long',
      qty: Math.abs(szi),
      entry: num(p.entryPx),
      // THE EXCHANGE'S OWN NUMBER. Null when it does not give one — never estimated in its place,
      // because a computed figure sitting in a field labelled "liquidation" would be trusted as
      // the venue's.
      liquidationPx: num(p.liquidationPx),
      leverage: num(p.leverage?.value),
      leverageType: p.leverage?.type ?? null,        // 'isolated' or 'cross'
      notional: num(p.positionValue),
      unrealizedPnl: num(p.unrealizedPnl),
      marginUsed: num(p.marginUsed),
    });
  }
  return out;
}

export function accountSummary(payload) {
  const m = payload?.marginSummary;
  if (!m) return null;
  return {
    accountValue: num(m.accountValue),
    totalNotional: num(m.totalNtlPos),
    marginUsed: num(m.totalMarginUsed),
    withdrawable: num(payload?.withdrawable),
  };
}

// Configured by environment variable only — never a parameter a request can supply, or the
// endpoint becomes a way to read anyone's account through this deployment.
export const HL_ADDRESS_ENV = 'HYPERLIQUID_ADDRESS';
export const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || '').trim());

export async function fetchHlAccount({ address = process.env[HL_ADDRESS_ENV], timeoutMs = 8000 } = {}) {
  if (!address) return { ok: false, configured: false, error: `${HL_ADDRESS_ENV} is not set`, positions: [], account: null };
  if (!isAddress(address)) return { ok: false, configured: true, error: `${HL_ADDRESS_ENV} is not a 0x address`, positions: [], account: null };
  try {
    const r = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: address }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, configured: true, error: `HTTP ${r.status}`, positions: [], account: null };
    const j = await r.json();
    return { ok: true, configured: true, error: null, positions: parsePositions(j), account: accountSummary(j) };
  } catch (e) {
    return { ok: false, configured: true, error: String(e?.message || e), positions: [], account: null };
  }
}
