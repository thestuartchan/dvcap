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

// ── TRIGGER ORDERS: THE STOP AND THE TARGET ──────────────────────────────────
// A perp position on its own says what is held, not what the trade IS. The invalidation level and
// the objective are the idea, and they live in resting trigger orders rather than in the position.
//
// WHY THE CLASSIFIER DOES NOT TRUST orderType FIRST-AND-ONLY. The venue labels these "Stop Market",
// "Take Profit Limit" and so on, but I could not observe a live trigger order to confirm the exact
// strings — ten of the largest HYPE position holders were carrying none between them, because size
// like that is managed by hand. Getting the string wrong would not fail loudly: it would file a
// stop as a target, and R would come out inverted and plausible. So the string is only a HINT, and
// GEOMETRY decides whenever the string is not recognised:
//
//   long   trigger below entry → stop        trigger above entry → target
//   short  trigger above entry → stop        trigger below entry → target
//
// Geometry alone cannot see one case — a stop moved PAST entry to lock a gain in, which sits on the
// target's side. That is exactly the case the label does describe unambiguously, which is why the
// label is consulted first rather than dropped.
export function classifyTrigger(order, position) {
  const t = String(order?.orderType || '').toLowerCase();
  if (/take\s*profit|\btp\b/.test(t)) return 'target';
  if (/stop|\bsl\b/.test(t)) return 'stop';
  const px = num(order?.triggerPx), e = num(position?.entry);
  if (px == null || e == null || px === e) return null;
  const sign = position?.side === 'short' ? -1 : 1;
  return ((px - e) * sign < 0) ? 'stop' : 'target';
}

// coin -> { stops: number[], targets: number[] }, each ascending. Selecting WHICH one is operative
// needs the mark and so belongs to the caller — this only reads.
export function parseTriggerOrders(payload, positions = []) {
  const byCoin = new Map((positions || []).map(p => [p.coin, p]));
  const out = new Map();
  for (const o of (Array.isArray(payload) ? payload : [])) {
    if (!o?.isTrigger) continue;
    const coin = String(o?.coin || '').trim();
    const px = num(o?.triggerPx);
    // A resting order with no trigger price is not a level. Hyperliquid writes "0.0" on ordinary
    // limit orders, so zero has to be rejected rather than read as a stop at zero.
    if (!coin || px == null || !(px > 0)) continue;
    const kind = classifyTrigger(o, byCoin.get(coin));
    if (!kind) continue;
    if (!out.has(coin)) out.set(coin, { stops: [], targets: [] });
    out.get(coin)[kind === 'stop' ? 'stops' : 'targets'].push(px);
  }
  for (const v of out.values()) { v.stops.sort((a, b) => a - b); v.targets.sort((a, b) => a - b); }
  return out;
}

// Same boundary as everything else in this file: the address comes from the environment, the only
// URL is /info, nothing is ever signed. This reads; it cannot trade.
export async function fetchHlOrders({ address = process.env[HL_ADDRESS_ENV], positions = [], timeoutMs = 8000 } = {}) {
  if (!address) return { ok: false, configured: false, error: `${HL_ADDRESS_ENV} is not set`, levels: new Map() };
  if (!isAddress(address)) return { ok: false, configured: true, error: `${HL_ADDRESS_ENV} is not a 0x address`, levels: new Map() };
  try {
    const r = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'frontendOpenOrders', user: address }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, configured: true, error: `HTTP ${r.status}`, levels: new Map() };
    return { ok: true, configured: true, error: null, levels: parseTriggerOrders(await r.json(), positions) };
  } catch (e) {
    // No levels must read as "not known", never as "no stop" — a position wrongly shown without an
    // invalidation level reads as an unmanaged one.
    return { ok: false, configured: true, error: String(e?.message || e), levels: new Map() };
  }
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

// ── SPOT: WHAT THE WALLET ACTUALLY HOLDS ─────────────────────────────────────
// The perp side above is a POSITION — leverage, funding, a liquidation price. Spot is a BALANCE:
// tokens sitting in the wallet, some of them locked in resting orders. They are different animals
// and reading them in one list invites the comparison that this codebase keeps splitting apart.
//
// Same boundary as everything else here: the address comes from the environment, the only URL is
// /info, and nothing is ever signed. This reads; it cannot trade.
//
// SCOPE. "DeFi holdings" in general — other chains, LP positions, staked or lent balances — needs
// a portfolio provider (Zerion, DeBank, Zapper) and an API key. This is the Hyperliquid spot
// ledger specifically, which the address already in the environment covers with no new
// configuration and no new dependency.
export const HL_SPOT_QUOTE = 'USDC';

// The balances, as the venue states them. `hold` is the amount locked in resting orders, so `free`
// is what could actually be moved — a number that is not in the payload and is the one you want
// before deciding you have any of something.
export function parseSpotBalances(payload) {
  const out = [];
  for (const b of (payload?.balances || [])) {
    const coin = String(b?.coin || '').trim();
    const total = num(b?.total);
    if (!coin || total == null) continue;
    const hold = num(b?.hold) ?? 0;
    out.push({ coin, total, hold, free: +(total - hold).toFixed(12), entryNtl: num(b?.entryNtl) ?? 0 });
  }
  return out;
}

// ── THE INDEX TRAP ───────────────────────────────────────────────────────────
// `spotMetaAndAssetCtxs` answers [meta, ctxs] and the two are NOT positionally aligned: measured
// 2026-09-07, universe had 326 entries and ctxs had 720. Worse, a universe entry's own `index`
// is not its array position either — universe[105] carries index 107 and is named "@107".
//
// Indexing ctxs by the universe's array position therefore prices the WRONG PAIR, silently and
// plausibly: HYPE came back at 0.0827 against a true 87.80, three orders of magnitude out, with
// nothing about the number looking wrong. The same class of error as pricing a Hyperliquid perp
// off a Yahoo <TICKER>-USD lookup, which is why that is banned a hundred lines above this.
//
// The join that actually holds is by NAME: token -> its USDC pair in `universe` -> the ctx whose
// `coin` equals that pair's name.
export function spotPrices(payload) {
  const meta = Array.isArray(payload) ? payload[0] : payload?.meta;
  const ctxs = Array.isArray(payload) ? payload[1] : payload?.ctxs;
  const byCoin = new Map((ctxs || []).map(c => [String(c?.coin || ''), c]));
  const tokens = meta?.tokens || [];
  const universe = meta?.universe || [];
  const quote = tokens.find(t => t?.name === HL_SPOT_QUOTE);
  const out = new Map();
  for (const t of tokens) {
    const name = String(t?.name || '');
    if (!name) continue;
    // The quote asset prices itself. There is no USDC/USDC pair and there should not be one.
    if (name === HL_SPOT_QUOTE) { out.set(name, { pair: null, price: 1, changePercent: null, volume: Infinity }); continue; }
    const pair = universe.find(u => u?.tokens?.[0] === t?.index && u?.tokens?.[1] === (quote?.index ?? 0));
    const ctx = pair ? byCoin.get(String(pair.name)) : null;
    const price = num(ctx?.midPx) ?? num(ctx?.markPx);
    const prev = num(ctx?.prevDayPx);
    out.set(name, {
      pair: pair ? String(pair.name) : null,
      price,
      changePercent: (price != null && prev) ? +(((price - prev) / prev) * 100).toFixed(2) : null,
      // 24-hour notional volume, which is what says whether the price above is a price. See below.
      volume: num(ctx?.dayNtlVlm),
    });
  }
  return out;
}

// A balance is dust when it is worth less than this. Airdrops arrive unbidden and in quantity, and
// a wallet view that lists every one of them is the flat-archive problem in a different card.
export const SPOT_DUST_USD = 1;

// ── A MID PRICE ON A DEAD PAIR IS NOT A PRICE ────────────────────────────────
// Found by running this against a burn address, which holds whatever the world sends it. It came
// back worth SIX POINT TWO TRILLION DOLLARS: an airdropped token called RUB quoted at 62,227 on a
// pair that had traded $40.90 in twenty-four hours. Nothing about the quote is malformed — it is a
// real mid, on a real pair, that no one has traded.
//
// The obvious total is therefore worse than useless: one unsellable airdrop dominates it, and a
// subtler one would not announce itself with a trillion. Twenty-four hour notional volume
// separates them without ambiguity. Measured 2026-09-07:
//
//   HYPE $81.3m   UBTC $19.1m   UETH $12.9m   USOL $10.2m   PURR $1.77m      real markets
//   JEFF $8.9k    PIP  $7.6k                                                 thin, but trading
//   RUB  $40.90   WWB/FRAC/SOVRN/STACK/HODL $0.00                            not markets
//
// Thin rows are LISTED, with the value marked unreliable, and kept out of the headline total. Not
// dropped: a holding you cannot value is still a holding, and hiding it would be its own lie.
export const SPOT_THIN_VOLUME_USD = 10_000;

// Merge the two into rows. An UNPRICED balance is reported as unpriced rather than as zero: 191 of
// the venue's 500 tokens have no USDC pair at all, and calling those holdings worthless is a claim
// the data does not support.
export function spotHoldings(balances = [], prices = new Map(),
                             { dustBelow = SPOT_DUST_USD, thinBelow = SPOT_THIN_VOLUME_USD } = {}) {
  const rows = balances.map(b => {
    const p = prices.get(b.coin) || {};
    const price = p.price ?? null;
    const value = price == null ? null : +(b.total * price).toFixed(2);
    // entryNtl is what was paid, in USDC. Zero means it was never bought — an airdrop, or the
    // quote asset itself — and a P&L against a cost of nothing is not a return, it is the value.
    const cost = b.entryNtl > 0 ? b.entryNtl : null;
    const pnl = (value != null && cost != null) ? +(value - cost).toFixed(2) : null;
    return {
      ...b, price, value, cost, pnl,
      pnlPct: (pnl != null && cost) ? +((pnl / cost) * 100).toFixed(2) : null,
      changePercent: p.changePercent ?? null,
      // Set when the price is an assumed dollar par rather than a quote — see lib/wallet.js.
      assumedPar: !!p.assumedPar,
      // Set when the price came from a liquidity pool rather than a venue's book. A pool ratio
      // that clears the depth and volume floors is a price; it is not a venue mid, and the row
      // says which one it is looking at.
      viaPool: p.viaPool ?? null,
      // A token whose address was verified into lib/chains.js. Anything the venue quotes is
      // verified by construction; only a pool price on an UNVOUCHED token is held out of the total.
      verified: p.verified !== false,
      priced: price != null,
      // Swapped for, per the chain's own transfer history — see lib/alchemy.js.
      acquired: !!b.acquired,
      volume: p.volume ?? null,
      // A price nobody has traded against is a number, not a valuation.
      thin: price != null && !(p.volume >= thinBelow),
      locked: b.hold > 0,
    };
  });
  // ── HELD OUT ONLY IF NOBODY VOUCHED FOR IT *AND* NOBODY CHOSE IT ──────────────────────────
  // A token the wallet swapped for is a position its owner took, whatever its contract looks like,
  // and excluding it from their own total is the dashboard second-guessing a decision that was
  // already made. What stays out is the unsolicited: arrived unbidden, priced only by a pool
  // nobody vouched for.
  const unsolicited = (r) => r.viaPool && !r.verified && !r.acquired;

  // FOUR TIERS, THEN VALUE. Sorting on value alone put the junk on top — and it did it twice.
  // First the fictional $6.2tn airdrop led the list while the real holdings sat below seventy rows
  // of untradeable tokens. Then, once pool prices arrived, five unvouched airdrops worth a nominal
  // $753, $422, $109, $102 and $81 sorted above an $11 ETH balance that was the only thing in the
  // wallet anyone had chosen to own.
  //
  // A nominal value is not a rank. What you own and can value comes first; what is priced but
  // unvouched next; what cannot be valued at all, last.
  const tier = (r) => (!r.priced ? 3 : r.thin ? 2 : unsolicited(r) ? 1 : 0);
  rows.sort((a, b) => tier(a) - tier(b) || (b.value ?? 0) - (a.value ?? 0) || a.coin.localeCompare(b.coin));

  // ── AND A THIRD CATEGORY: PRICED, DEEP, AND STILL NOT YOURS TO SPEND ──────────────────────
  // A pool's depth says a pool exists. It does not say you can sell into it. Airdropped tokens
  // arrive unbidden precisely to look valuable — checked on one: the contract is not open source
  // and 63% of its liquidity sits with a single unlocked holder, so the "$1.6m of liquidity" can
  // leave in one transaction. Counting that in a wallet total inflates it with something the
  // holder never bought and may not be able to sell.
  //
  // So a pool price is SHOWN and not COUNTED. Anything the venue itself quotes, or that was
  // verified by address into lib/chains.js, still counts — those are markets, not lures.
  const unverified = rows.filter(r => r.priced && !r.thin && unsolicited(r));
  // ORDER MATTERS. Thinness is judged first, because it is a statement about whether the value can
  // be trusted at all; dust is judged only among values that can be. Calling a $6.2tn quote "dust"
  // would be absurd and calling it real would be worse.
  const thin  = rows.filter(r => r.priced && r.thin);
  const solid = rows.filter(r => r.priced && !r.thin && !unsolicited(r));
  const dust  = solid.filter(r => (r.value ?? 0) < dustBelow);
  const held  = rows.filter(r => !r.priced || (r.priced && r.thin) || (r.value ?? 0) >= dustBelow);
  const bucket = (list) => ({ count: list.length, value: +list.reduce((a, r) => a + (r.value ?? 0), 0).toFixed(2), coins: list.map(r => r.coin) });
  return {
    rows: held,
    dust: bucket(dust),
    thin: bucket(thin),
    // Priced from a pool rather than a venue: shown on its row, kept out of the total, and
    // reported here so the card can say how much is being left out and why.
    unverified: bucket(unverified),
    // The headline. Priced, and on a pair that actually trades — dust included, because a small
    // real number is still real, and thin excluded, because a large fictional one is not.
    total: +solid.reduce((a, r) => a + (r.value ?? 0), 0).toFixed(2),
    unpriced: rows.filter(r => !r.priced).length,
  };
}

export async function fetchHlSpot({ address = process.env[HL_ADDRESS_ENV], timeoutMs = 8000, context = null } = {}) {
  const nope = (error, configured) => ({ ok: false, configured, error, rows: [], dust: null, thin: null, total: null, unpriced: 0 });
  if (!address) return nope(`${HL_ADDRESS_ENV} is not set`, false);
  if (!isAddress(address)) return nope(`${HL_ADDRESS_ENV} is not a 0x address`, true);
  const ask = (body) => fetch(HL_INFO_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  try {
    const r = await ask({ type: 'spotClearinghouseState', user: address });
    if (!r.ok) return nope(`HTTP ${r.status}`, true);
    const balances = parseSpotBalances(await r.json());
    // THE METADATA IS 270KB, so it is fetched at most once per request and only when there is
    // something other than the quote asset to price. lib/wallet.js needs the same payload — the
    // token list and the prices — so the caller passes a shared `context` rather than each read
    // pulling its own copy.
    let prices = context?.prices;
    if (!prices && balances.some(b => b.coin !== HL_SPOT_QUOTE)) {
      const m = await ask({ type: 'spotMetaAndAssetCtxs' });
      if (m.ok) prices = spotPrices(await m.json());
    }
    return { ok: true, configured: true, error: null,
             ...spotHoldings(balances, prices || new Map([[HL_SPOT_QUOTE, { pair: null, price: 1, changePercent: null, volume: Infinity }]])) };
  } catch (e) {
    return nope(String(e?.message || e), true);
  }
}

// The spot universe and its prices, fetched once and shared. Both the exchange ledger and the
// on-chain wallet need it: the same token names, the same mids, the same thin-market guard.
export async function fetchSpotContext({ timeoutMs = 8000 } = {}) {
  try {
    const r = await fetch(HL_INFO_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotMetaAndAssetCtxs' }), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { meta: null, prices: null, error: `HTTP ${r.status}` };
    const j = await r.json();
    return { meta: j, prices: spotPrices(j), error: null };
  } catch (e) {
    return { meta: null, prices: null, error: String(e?.message || e) };
  }
}
