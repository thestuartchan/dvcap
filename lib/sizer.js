// lib/sizer.js — the size, before the trade.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// The trade record names position sizing as the primary weakness, ahead of thesis quality and
// ahead of timing, and nothing anywhere in this stack produced a size before a trade was placed.
//
// The worked example is the live book. QQQ Oct16 730C went on at 20 contracts. At entry — QQQ
// ~718, ATR(20) ~8.50, delta 0.42, mark 11.90 — the ATR test returns $2,000 / ($8.50 x 0.42 x 100)
// = 5 contracts, and the premium cap returns $6,000 / $1,190 = 5. Both tests said five. The
// position was twenty. Same thesis, same outcome, four times the consequence.
//
// This module exists to put that number in front of the decision.
//
// ── ONE RULE ─────────────────────────────────────────────────────────────────
// Size so that one ATR of adverse movement costs 1% of NLV. ATR is already a volatility measure,
// so a jumpy instrument receives a smaller position with no separate vol adjustment bolted on
// top. Then apply the concentration caps and take the SMALLEST result.
//
// ── WHERE THE INPUTS COME FROM ───────────────────────────────────────────────
// The spec says IBKR for all three. Same constraint as the exposure tile and the same resolution:
// this deployment reads IBKR through Flex, an end-of-day statement with no greeks and no bars, so
// ATR comes from the daily bars this board already fetches and delta and mark come from CBOE's
// published per-contract feed. Neither is modelled here — no Black-Scholes, which is what the
// instruction was protecting.
//
// ── AND THE JOURNAL ALREADY EXISTS ───────────────────────────────────────────
// The spec asks for a new journal reconciling intended against actual. lib/decisions.js already
// does exactly that: it records `recommendedQty` against `takenQty`, computes an override ratio,
// and overrideStats() reports the mean, the counts either side, and the size-up-after-a-win
// pattern. A second journal of the same thing would drift from it within a week. So this returns
// a suggestion SHAPED for that log — `fullQty`, `roomQty`, `mode`, `effPct`, `warnings` — and the
// existing reconciliation picks it up unchanged.
import { localDateIn } from './sessions.js';
import { FAMILIES, MULTIPLIER, familyOf, parentFamily, isIndexFamily, termStructure, gapTest, rollLine, looksLikeSpread } from './futuresContracts.js';
import { looksLeveraged, SWING, swingRoom } from './leverage.js';

// 0DTE is "expires on today's date IN NEW YORK", not in UTC. Between 20:00 and 24:00 UTC the two
// disagree, and that window is inside the US session — so a UTC comparison would call a same-day
// expiry a next-day one for the last four hours of every trading day.
export function isZeroDteExpiry(expiry, now = new Date()) {
  if (!expiry) return false;
  return String(expiry).slice(0, 10) === localDateIn('America/New_York', now);
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const floorTo = (v) => (v == null || !Number.isFinite(v)) ? null : Math.floor(v + 1e-9);

// ── CONSTANTS ────────────────────────────────────────────────────────────────
// All configurable, all recomputed from live NLV. Note the deliberate reuse of the 1% figure
// across 0DTE and everything else: one number to remember across the whole book.
export const SIZER_LIMITS = Object.freeze({
  riskPct: 1.0,                 // one ATR against you costs this much of NLV
  singleNamePct: 10,            // stocks — concentration
  optionPremiumPct: 3,          // per option position
  zeroDtePremiumPct: 1,         // ALL concurrent 0DTE combined, not per position
  zeroDteContractCap: 20,       // absolute, whatever the price
  zeroDteDeltaLo: 0.35, zeroDteDeltaHi: 0.45,
  optionDeltaFloor: 0.35,       // below this an option's delta is noted as under the entry floor — info, never a block
  zeroDteFlatBy: '15:30 ET',
  portfolioDeltaTarget: 1.0,    // x NLV — ties to the exposure tile
  portfolioDeltaCeiling: 1.5,   // x NLV — blocks, does not warn
  contractMultiplier: 100,
});

export const RULE_SETS = Object.freeze({ STOCK: 'stock', OPTION: 'option', ZERO_DTE: '0dte', FUTURE: 'future' });

// ── BROAD INDEX ETFs ARE NOT SINGLE NAMES ────────────────────────────────────
// QQQ Oct16 730C ×3 at 718.66 carries $86,240 of delta-notional — 41.8% of NLV on $2,268 of
// premium. Under a 10% single-name cap that flags amber on every index trade, and a warning that
// always fires gets ignored. An exempt underlying has its delta-notional computed and shown and is
// never flagged: its exposure is governed by the portfolio delta target of 1.0× NLV. Sector,
// thematic and single-country ETFs (XLE, SMH, IGV, 7709) keep the cap — that is real
// concentration. Editable from the console's Sizing card; this is the seed.
export const SINGLE_NAME_EXEMPT = Object.freeze(['QQQ', 'SPY']);
export const rootOf = (symbol) => String(symbol || '').trim().toUpperCase().split(/[\s|]/)[0] || null;
export const isExempt = (symbol, list = SINGLE_NAME_EXEMPT) => {
  const r = rootOf(symbol);
  if (!r) return false;
  // ES, MES, NQ, MNQ, NKD are the market too: the same exemption as QQQ and SPY. Crude, gold, FX
  // and rates keep the cap.
  if (isIndexFamily(familyOf(r))) return true;
  return (Array.isArray(list) ? list : SINGLE_NAME_EXEMPT).map(x => String(x || '').trim().toUpperCase()).includes(r);
};

// ── THE TESTS ────────────────────────────────────────────────────────────────
// Both are always returned, and which one BINDS is part of the answer. For volatile single names
// the concentration cap usually wins; for options the two often agree. Hiding the losing test
// behind the final number removes the only part of this that teaches anything.
// A LEVERAGED ETF'S CAP IS ON ITS DELTA-NOTIONAL, NOT ITS COST. TQQQ at 3× is sized against
// price × 3; the ATR test is unchanged in form because the ETF's own ATR already embeds the
// factor (a derived ATR — the underlying's × |factor| — is labelled by the caller).
function stockTests({ price, atr, nlv, L, leverage = 1, atrSource = 'own' }) {
  const out = [];
  const budget = nlv * (L.riskPct / 100);
  const absLev = Math.abs(leverage || 1);
  out.push(atr > 0
    ? { name: 'ATR test', size: floorTo(budget / atr), detail: `$${Math.round(budget).toLocaleString('en-US')} ÷ $${atr.toFixed(2)} per share${atrSource === 'derived' ? ' (derived: underlying ATR × |factor|)' : ''}` }
    : { name: 'ATR test', size: null, detail: 'no ATR — a size cannot be set against a range that is not known' });
  const cap = nlv * (L.singleNamePct / 100);
  out.push(price > 0
    ? { name: `Concentration cap (${L.singleNamePct}%)`, size: floorTo(cap / (price * absLev)),
        detail: absLev !== 1 ? `$${Math.round(cap).toLocaleString('en-US')} ÷ ($${price.toFixed(2)} × ${absLev})` : `$${Math.round(cap).toLocaleString('en-US')} ÷ $${price.toFixed(2)}` }
    : { name: `Concentration cap (${L.singleNamePct}%)`, size: null, detail: 'no price' });
  return out;
}

// A FUTURE IS A CONTRACT. The same two tests as a share, per contract: one ATR against you is
// ATR × multiplier, and the notional is price × multiplier. ALWAYS FLOORED — 0.79 CL is 0 CL.
// An INDEX family (ES, NQ, NKD and their micros) is the market: the concentration cap is shown
// and does not govern, the same exemption QQQ and SPY have on the exposure line. Crude, gold, FX
// and rates keep it.
function futureTests({ price, atr, multiplier, nlv, L, exempt = false }) {
  const out = [];
  const budget = nlv * (L.riskPct / 100);
  const perAtr = (atr > 0 && multiplier > 0) ? atr * multiplier : null;
  out.push(perAtr
    ? { name: 'ATR test', size: floorTo(budget / perAtr), detail: `$${Math.round(budget).toLocaleString('en-US')} ÷ $${Math.round(perAtr).toLocaleString('en-US')} per contract` }
    : { name: 'ATR test', size: null, detail: atr > 0 ? 'no multiplier' : 'no ATR — a size cannot be set against a range that is not known' });
  const cap = nlv * (L.singleNamePct / 100);
  const perContract = (price > 0 && multiplier > 0) ? price * multiplier : null;
  out.push(perContract
    ? { name: `Concentration cap (${L.singleNamePct}%)`, size: floorTo(cap / perContract), exempt,
        detail: `$${Math.round(cap).toLocaleString('en-US')} ÷ $${Math.round(perContract).toLocaleString('en-US')} per contract${exempt ? ' — index, exempt: shown, does not govern' : ''}` }
    : { name: `Concentration cap (${L.singleNamePct}%)`, size: null, exempt, detail: price > 0 ? 'no multiplier' : 'no price' });
  return out;
}

// ── THE CAP GOVERNS THE COUNT, NOT ONLY THE FLAG ──
// SOFI Nov20 18C on 24 Sep: delta 0.42, mark 0.97, NLV $211k. The ATR test said 100, the premium
// cap 65, and the suggestion was 65 — carrying $45,600 of delta-notional, more than twice the 10%
// single-name cap, which was computed afterwards and printed amber under a number that ignored
// it. The cap is the third test now: floor(cap ÷ |delta| × spot × 100), and the suggestion is
// the minimum of the three. For an exempt index ETF it is shown and does not govern.
function optionTests({ atr, delta, mark, price, nlv, L, exempt = false }) {
  const out = [];
  const budget = nlv * (L.riskPct / 100);
  const perAtr = (atr > 0 && delta != null && Math.abs(delta) > 0) ? Math.abs(atr * delta * L.contractMultiplier) : null;
  out.push(perAtr
    ? { name: 'ATR test', size: floorTo(budget / perAtr), detail: `$${Math.round(budget).toLocaleString('en-US')} ÷ ($${atr.toFixed(2)} × ${Math.abs(delta).toFixed(2)} × ${L.contractMultiplier})` }
    : { name: 'ATR test', size: null, detail: atr > 0 ? 'no delta — the option\'s move per ATR is unknown' : 'no ATR on the underlying' });
  const cap = nlv * (L.optionPremiumPct / 100);
  out.push(mark > 0
    ? { name: `Premium cap (${L.optionPremiumPct}%)`, size: floorTo(cap / (mark * L.contractMultiplier)), detail: `$${Math.round(cap).toLocaleString('en-US')} ÷ $${(mark * L.contractMultiplier).toFixed(0)}` }
    : { name: `Premium cap (${L.optionPremiumPct}%)`, size: null, detail: 'no mark' });
  const nameCap = nlv * (L.singleNamePct / 100);
  const perContract = (price > 0 && delta != null && Math.abs(delta) > 0) ? Math.abs(delta) * price * L.contractMultiplier : null;
  out.push(perContract
    ? { name: `Delta-notional cap (${L.singleNamePct}%)`, size: floorTo(nameCap / perContract), exempt,
        detail: `$${Math.round(nameCap).toLocaleString('en-US')} ÷ $${Math.round(perContract).toLocaleString('en-US')} per contract${exempt ? ' — index, exempt: shown, does not govern' : ''}` }
    : { name: `Delta-notional cap (${L.singleNamePct}%)`, size: null, exempt, detail: price > 0 ? 'no delta' : 'no price' });
  return out;
}

// ── 0DTE IS A DIFFERENT REGIME ───────────────────────────────────────────────
// Gamma makes delta unstable within the session, so the ratio the ATR test is built on is obsolete
// before it can be acted on. Premium governs instead, and the CONTRACT CEILING matters more than
// it looks: at $2,000 of premium a $2.50 contract buys 8 lots and a $0.60 one buys 33 — the same
// money, four times the delta-notional, and a commission load reaching 3-5% of the trade.
function zeroDteTests({ mark, nlv, openZeroDtePremium, L }) {
  const out = [];
  const budget = nlv * (L.zeroDtePremiumPct / 100);
  // CONCURRENT ACROSS ALL OPEN 0DTE, not per position — so what is already on comes off the budget.
  const remaining = Math.max(0, budget - (num(openZeroDtePremium) || 0));
  out.push(mark > 0
    ? { name: `Premium cap (${L.zeroDtePremiumPct}% concurrent)`, size: floorTo(remaining / (mark * L.contractMultiplier)),
        detail: `$${Math.round(remaining).toLocaleString('en-US')} left of $${Math.round(budget).toLocaleString('en-US')} ÷ $${(mark * L.contractMultiplier).toFixed(0)}` }
    : { name: `Premium cap (${L.zeroDtePremiumPct}% concurrent)`, size: null, detail: 'no mark' });
  out.push({ name: 'Contract ceiling', size: L.zeroDteContractCap,
             detail: `${L.zeroDteContractCap} contracts, whatever the price — a cheap contract buys four times the delta on the same money` });
  return out;
}

// ── THE SIZE ─────────────────────────────────────────────────────────────────
export function sizeTrade({
  kind = 'stock', symbol = null, price = null, atr = null, atrPct = null,
  delta = null, mark = null, expiry = null,
  nlv = null, bookDeltaNotional = 0, openZeroDtePremium = 0,
  catalysts = null, indicative = false, asOf = null,
  limits = SIZER_LIMITS, now = new Date(),
  // The quantity the operator intends, when they have typed one. Optional in every sense: absent,
  // everything below is computed exactly as before.
  entered = null,
  // ── THE SINGLE-NAME CAP, ON EXPOSURE ──────────────────────────────────────
  // What the book already carries in THIS underlying, in delta-notional, AS TWO LEGS: the shares
  // and the options (lib/bookExposure.js byUnderlying). They are held for different reasons and
  // answer a drawdown in opposite ways — a long-term holding treats weakness as a place to add, an
  // option moves further from its strike with a clock on it — so each is tested on its own and a
  // combined figure is display only. Null means unknown, which is reported as unknown, never as
  // zero. `underlyingUnpriced` is how many of the root's lines the book could not price.
  underlyingShares = null, underlyingOptions = null, underlyingUnpriced = 0,
  // Roots the cap does not apply to. See SINGLE_NAME_EXEMPT.
  exempt = SINGLE_NAME_EXEMPT,
  // Where the delta came from: 'exchange' (published) or 'modelled' (Black-Scholes from the mark).
  deltaSource = null,
  // ── A FUTURE ──────────────────────────────────────────────────────────────
  // kind 'future' sizes in CONTRACTS: price × multiplier is the notional, ATR × multiplier the
  // move. An unknown family is never sized at a multiplier of 1 — it refuses and asks for one.
  multiplier = null,
  // ── A LEVERAGED OR INVERSE ETF ────────────────────────────────────────────
  // `leverage` is the signed daily factor (lib/leverage.js; 1 when unknown). Exposure is cost ×
  // factor; an inverse product's is negative and takes book delta DOWN. `underlyingPrice` turns
  // the exposure into shares of what it tracks; `atrSource` says whether the ATR is the ETF's own
  // or derived from the underlying's. `name` is the feed's name, for the "looks leveraged" prompt.
  leverage = null, underlyingPrice = null, atrSource = 'own', name = null, reset = null, underlying = null,
  // ── THE BUCKET ────────────────────────────────────────────────────────────
  // 'swing' or 'position'. Null lets the default decide: leveraged ETFs and index futures are
  // swing trades unless `holdBeyond` says the intent is longer. `positionBookUsd` and
  // `swingUsedUsd` are what the book already carries in each (lib/bookExposure.js buckets).
  bucket = null, holdBeyond = false, positionBookUsd = null, swingUsedUsd = null,
} = {}) {
  const L = { ...SIZER_LIMITS, ...(limits || {}) };
  const eq = num(nlv), p = num(price), a = num(atr), d = num(delta), m = num(mark);
  if (!(eq > 0)) return { ok: false, why: 'set the account value to get a size', limits: L };

  const isOption = kind === 'option';
  const isFuture = kind === 'future';
  const mult = isFuture ? num(multiplier) : null;
  if (isFuture && looksLikeSpread(symbol)) return { ok: false, why: 'spreads not supported yet — a calendar spread is one instrument, and sizing one leg of it is not sizing it', limits: L };
  if (isFuture && !(mult > 0)) return { ok: false, why: `set the contract multiplier for ${rootOf(symbol) || 'this future'} — an unknown family is never sized as if one contract were one unit`, limits: L };
  const lev = (!isOption && !isFuture) ? (num(leverage) ?? 1) : 1;
  const absLev = Math.abs(lev) || 1;
  // The per-unit price the single-name arithmetic divides by: a share, one contract, or one
  // share's worth of leveraged exposure.
  const perUnitPx = isFuture ? (p != null ? p * mult : null) : (p != null ? p * absLev : null);
  const zeroDte = isOption && expiry ? isZeroDteExpiry(expiry, now) : false;
  const ruleSet = zeroDte ? RULE_SETS.ZERO_DTE : isOption ? RULE_SETS.OPTION : isFuture ? RULE_SETS.FUTURE : RULE_SETS.STOCK;

  const tests = zeroDte ? zeroDteTests({ mark: m, nlv: eq, openZeroDtePremium, L })
    : isOption ? optionTests({ atr: a, delta: d, mark: m, price: p, nlv: eq, L, exempt: isExempt(symbol, exempt) })
    : isFuture ? futureTests({ price: p, atr: a, multiplier: mult, nlv: eq, L, exempt: isExempt(symbol, exempt) })
    : stockTests({ price: p, atr: a, nlv: eq, L, leverage: lev, atrSource });

  // An exempt test is reported with its number and does not take part in the minimum.
  const scored = tests.filter(t => t.size != null && !t.exempt);
  let size = scored.length ? Math.min(...scored.map(t => t.size)) : null;

  // ── THE BUCKET, AND ITS ROOM ──────────────────────────────────────────────
  // A leveraged ETF or an index future held overnight is a swing trade unless the intent is
  // longer; a swing trade is sized into the swing bucket's ROOM, which the position book can have
  // used up. Reported as a third test when it binds — and reported as zero, with the reason, when
  // the room is negative. Never a block: the numbers stand and the size is what the rule says.
  const leveraged = !isOption && !isFuture && lev !== 1;
  const swingByDefault = leveraged || (isFuture && isIndexFamily(familyOf(symbol)));
  const bucketUsed = bucket === 'swing' || bucket === 'position' ? bucket : (swingByDefault && !holdBeyond) ? 'swing' : 'position';
  const roomInfo = (positionBookUsd != null || swingUsedUsd != null) ? swingRoom({ nlv: eq, positionUsd: positionBookUsd ?? 0, swingUsd: swingUsedUsd ?? 0 }) : null;
  const perUnitAbs = isOption ? ((d != null && p != null) ? Math.abs(d) * L.contractMultiplier * p : null) : perUnitPx;
  let swingFit = null;
  if (bucketUsed === 'swing' && roomInfo && perUnitAbs > 0) {
    swingFit = floorTo(Math.max(0, roomInfo.roomUsd) / perUnitAbs);
    tests.push({ name: `Swing room (${SWING.swingMax}× reserved)`, size: swingFit, bucket: true,
                 detail: roomInfo.negative ? roomInfo.note : `$${Math.round(roomInfo.roomUsd).toLocaleString('en-US')} ÷ $${Math.round(perUnitAbs).toLocaleString('en-US')}` });
    if (size != null && swingFit < size) size = swingFit;
  }
  for (const t of tests) t.binds = !t.exempt && t.size != null && size != null && t.size === size;
  const binding = tests.find(t => t.binds)?.name ?? null;
  const unscored = tests.filter(t => t.size == null);
  // The three option counts by name, and which governs — the log's fields, so the monthly line
  // can say how often each test set the number.
  const countOf = (re) => tests.find(t => re.test(t.name))?.size ?? null;
  const optionCounts = isOption && !zeroDte ? {
    atr: countOf(/^ATR test/), premium: countOf(/^Premium cap/), cap: countOf(/^Delta-notional cap/),
    governing: binding == null ? null : /^ATR/.test(binding) ? 'atr' : /^Premium/.test(binding) ? 'premium' : /^Delta-notional/.test(binding) ? 'cap' : /^Swing/.test(binding) ? 'swing' : null,
    capExempt: isExempt(symbol, exempt),
  } : null;

  // What the position would BE, at that size. A future's unit is one contract's notional, and its
  // delta is 1.0 — one contract moves the book by price × multiplier per point.
  // `unit` is what one costs; `perUnitDelta` is what one moves the book by — the same number for a
  // share, price × multiplier for a contract, and price × SIGNED factor for a leveraged ETF.
  const unit = isOption ? (m != null ? m * L.contractMultiplier : null) : isFuture ? perUnitPx : p;
  const premium = (size != null && unit != null) ? +(size * unit).toFixed(2) : null;
  const perUnitDelta = isOption ? ((d != null && p != null) ? d * L.contractMultiplier * p : null) : isFuture ? perUnitPx : (p != null ? p * lev : null);
  const deltaAdded = (size != null && perUnitDelta != null) ? +(size * perUnitDelta).toFixed(2) : null;

  // ── THE BOOK CHECK, WHICH IS WHY THIS BELONGS ON THE PANEL ────────────────
  // A spreadsheet can do the two tests. It cannot answer "does this fit alongside what I already
  // hold", which is the check that catches exposure creep — and it is the one that blocks.
  const before = num(bookDeltaNotional) ?? 0;
  const beforeX = +(before / eq).toFixed(2);
  const ceilingUsd = eq * L.portfolioDeltaCeiling;

  // ── WHAT YOU TYPED, AGAINST WHAT THE RULE SAID ────────────────────────────
  // The single most useful line on the card, and the one the log is built around: it names the gap
  // without arguing about it. Null when nothing was typed, which is NOT the same as agreeing with
  // the suggestion — a blank field is a question that was never asked.
  const ent = (() => { const v = num(entered); return v != null && v > 0 ? Math.round(v) : null; })();
  const enteredMultiple = (ent != null && size > 0) ? +(ent / size).toFixed(2) : null;
  const enteredDelta = (ent != null && perUnitDelta != null) ? +(ent * perUnitDelta).toFixed(2) : null;
  const enteredPremium = (ent != null && unit != null) ? +(ent * unit).toFixed(2) : null;

  // THE BOOK PROJECTION FOLLOWS THE ENTERED SIZE WHERE THERE IS ONE. "What will I be holding if I
  // do what I just typed" is the question; projecting the suggestion instead answers a question
  // nobody asked at the moment they are about to override it.
  const addedForBook = ent != null ? enteredDelta : deltaAdded;
  const afterUsd = addedForBook == null ? null : before + addedForBook;
  const afterX = afterUsd == null ? null : +(afterUsd / eq).toFixed(2);
  const atSuggestedUsd = deltaAdded == null ? null : before + deltaAdded;
  const room = Math.max(0, ceilingUsd - before);
  // What would sit inside the ceiling, computed and REPORTED — never substituted. It used to
  // replace the answer; it is now one more number on the card.
  const fitSize = (perUnitDelta != null && Math.abs(perUnitDelta) > 0) ? floorTo(room / Math.abs(perUnitDelta)) : null;
  // ── THE TOOL INFORMS. IT NEVER RESTRICTS. ─────────────────────────────────
  // This refused. Past 1.5× NLV it struck the computed size through, printed ⛔ EXCEEDS CEILING,
  // and offered the size that would fit instead — so the one question asked of it ("how big should
  // this be?") went unanswered exactly when the answer was most worth arguing with.
  //
  // That was wrong, and not because the ceiling is wrong. Frameworks exist to build best practice,
  // and the room to act on instinct in an exceptional situation is the thing that makes an operator
  // good at this; a tool that decides has removed it. Overrides should be rare, and they must never
  // be foreclosed.
  //
  // So every constraint renders as a fact with its numbers attached and takes no action. There is
  // no state in which this declines to produce a number, hides a field, or requires an input first.
  // The discipline lives in the log — see reconcileRuns: a number on screen does not stop a
  // decision taken with conviction, but seeing a month later that actual exceeded suggested on 6 of
  // 19 trades is legible in a way the moment never is.
  const pastCeiling = afterUsd != null && Math.abs(afterUsd) > ceilingUsd;
  const pastTarget = afterX != null && Math.abs(afterX) > L.portfolioDeltaTarget;

  // ── ONE UNDERLYING, SHARES AND OPTIONS TOGETHER ───────────────────────────
  // The sizer ran four tests and the single-name cap was only ever applied to stocks. The premium
  // cap sees what an option COSTS, not what it controls: XLE Jan15'27 55C ×5 passed every test at
  // $5,207 of premium and carried $28,980 of exposure — 14% of NLV against a 10% cap. An
  // out-of-the-money contract stretches it furthest: $6,191 of 0.30-delta premium on a $200
  // underlying controls over $45,000. The aggregate delta target did not catch it either — the
  // book sat at 1.06× while one name ran at 14%.
  //
  // So the exposure is summed per underlying (what is held, plus what this trade adds at the size
  // being followed) and tested against the same 10%. Reported with the share-equivalent, which is
  // the line that translates premium into what is actually being carried. Amber is the ceiling.
  const capUsd = eq * (L.singleNamePct / 100);
  // A future's root is its FAMILY's parent: CL and MCL are one underlying, as are ES and MES.
  const root = isFuture ? (parentFamily(familyOf(symbol) || rootOf(symbol)) || rootOf(symbol)) : rootOf(symbol);
  const exemptHere = isExempt(symbol, exempt);
  const heldShares = num(underlyingShares), heldOptions = num(underlyingOptions);
  const known = heldShares != null || heldOptions != null;
  const addedSingle = addedForBook;
  const leg = isOption ? 'options' : 'shares';
  // Each leg: what is held, what this trade adds (to its own leg only), the total, and the test.
  const legOf = (held, adds) => {
    const total = (held == null && adds == null) ? null : (held ?? 0) + (adds ?? 0);
    return {
      held: held == null ? null : +held.toFixed(2),
      added: adds == null ? null : +adds.toFixed(2),
      total: total == null ? null : +total.toFixed(2),
      pct: total == null ? null : +((total / eq) * 100).toFixed(1),
      // Over the cap on its own — the fact. Whether it FLAGS is `past` below, which the exempt
      // list can switch off; the number itself is never hidden.
      over: total != null && Math.abs(total) > capUsd,
      past: !exemptHere && total != null && Math.abs(total) > capUsd,
      shareEquivalent: (total != null && perUnitPx > 0) ? Math.round(total / perUnitPx) : null,
    };
  };
  const sharesLeg = legOf(heldShares, isOption ? null : addedSingle);
  const optionsLeg = legOf(heldOptions, isOption ? addedSingle : null);
  const traded = isOption ? optionsLeg : sharesLeg;
  const combined = (sharesLeg.total == null && optionsLeg.total == null) ? null : (sharesLeg.total ?? 0) + (optionsLeg.total ?? 0);
  const singleName = {
    root, cap: +capUsd.toFixed(2), capPct: L.singleNamePct, exempt: exemptHere,
    known, unpriced: num(underlyingUnpriced) ?? 0,
    leg, shares: sharesLeg, options: optionsLeg,
    // The leg this trade is on — what the flag, the log's pct and the warning are about.
    added: addedSingle == null ? null : +addedSingle.toFixed(2),
    total: traded.total, pct: traded.pct, over: traded.over, past: traded.past,
    // Display only, no threshold: shares and options together. Kept because "what does the
    // whole name add up to" is a fair question, dropped from every test because the two legs do
    // not answer a drawdown the same way.
    combined: combined == null ? null : +combined.toFixed(2),
    combinedPct: combined == null ? null : +((combined / eq) * 100).toFixed(1),
    // In shares of the underlying, at its price: 5 × 0.90 delta ≈ 450 shares.
    shareEquivalent: traded.shareEquivalent,
    addedShareEquivalent: (addedSingle != null && perUnitPx > 0) ? Math.round(addedSingle / perUnitPx) : null,
    follows: ent != null ? 'entered' : 'suggested',
    deltaSource: isOption ? (deltaSource || (d != null ? 'exchange' : null)) : isFuture ? 'futures' : 'shares',
  };

  // ── THE LEVERAGE READ ─────────────────────────────────────────────────────
  const nAt = ent ?? size ?? 0;
  const levInfo = (!isOption && !isFuture) ? {
    factor: lev, underlying: underlying ?? null, reset: reset ?? (lev !== 1 ? 'daily' : 'none'), leveraged,
    cost: (p != null) ? +(nAt * p).toFixed(2) : null,
    deltaNotional: (p != null) ? +(nAt * p * lev).toFixed(2) : null,
    underlyingShares: (p != null && num(underlyingPrice) > 0) ? Math.round((nAt * p * lev) / num(underlyingPrice)) : null,
    atrSource,
    // A hedge is for bringing the book somewhere: the inverse line says what size gets it to target.
    hedgeToTarget: (lev < 0 && p > 0) ? (() => {
      const excess = Math.max(0, before - eq * L.portfolioDeltaTarget);
      return { fromX: beforeX, toX: L.portfolioDeltaTarget, usd: +excess.toFixed(2), shares: Math.floor(excess / (p * absLev)) };
    })() : null,
    looksLeveraged: lev === 1 && looksLeveraged(name),
  } : null;

  const warnings = [];
  const notes = [];
  if (levInfo?.looksLeveraged) notes.push(`${rootOf(symbol) || 'this name'} looks leveraged ("${String(name).slice(0, 40)}") and is sized at a factor of 1 — set the factor if it is`);
  if (levInfo?.leveraged && lev > 0) notes.push('daily reset — path-dependent beyond a few sessions; sized as a trade, not a position');
  if (levInfo?.leveraged && lev < 0) notes.push(`daily reset — volatility drag works against a multi-day hedge; consider ${levInfo.underlying || 'index'} puts or trimming longs if the horizon is more than ${SWING.maxSessions} sessions`);
  if (bucketUsed === 'swing' && roomInfo?.negative) {
    warnings.push(`${roomInfo.note} — this trade cannot be sized into swing until the position book is ≤ ${SWING.positionMax}×`);
  }
  if (size === 0) {
    warnings.push(isFuture
      ? `${rootOf(symbol) || 'this contract'}: below one contract — one is $${Math.round(unit ?? 0).toLocaleString('en-US')} of notional and moves $${Math.round((a ?? 0) * mult).toLocaleString('en-US')} per ATR`
      : 'the size is below one contract — correct, and it means the instrument is too volatile or the account too small for a position here');
  }
  // STATED, NOT ENFORCED. The ceiling is named with the number that passes it, and the size stands.
  if (pastCeiling) {
    warnings.push(`this takes the book to ${afterX}× NLV, past the ${L.portfolioDeltaCeiling}× ceiling`
      + (fitSize != null ? ` — ${fitSize} would sit inside it` : ''));
  } else if (pastTarget) {
    notes.push(`past the ${L.portfolioDeltaTarget}× target and inside the ${L.portfolioDeltaCeiling}× ceiling`);
  }
  if (singleName.past) {
    warnings.push(`${symbol || 'this name'} ${leg} would carry $${Math.round(Math.abs(traded.total)).toLocaleString('en-US')} of delta-notional (${traded.pct}% of NLV), above the ${L.singleNamePct}% single-name cap`
      + (traded.held ? ` — $${Math.round(Math.abs(traded.held)).toLocaleString('en-US')} of it already held in ${leg}` : ''));
  }
  // The OTHER leg, tested on its own. Not this trade's doing, so a note rather than a warning —
  // but a held leg already over the cap is worth seeing beside the one being sized.
  const other = isOption ? sharesLeg : optionsLeg;
  if (!exemptHere && other.past) {
    notes.push(`${root || 'this name'} ${isOption ? 'shares' : 'options'} already held carry $${Math.round(Math.abs(other.total)).toLocaleString('en-US')} (${other.pct}% of NLV), above the ${L.singleNamePct}% single-name cap on their own`);
  }
  if (exemptHere && traded.over) {
    notes.push(`${root} is on the index-ETF exempt list — ${traded.pct}% of NLV in ${leg} is shown, not flagged; the ${L.portfolioDeltaTarget}× portfolio delta target governs`);
  }
  if (isOption && singleName.deltaSource === 'modelled') {
    notes.push('delta is modelled — Black-Scholes from the mark, not the exchange\'s published reading; the exposure line is only as good as that');
  }
  // An entry floor on delta, as information: a 0.25-delta contract needs the underlying to move
  // further before the option moves with it. Said, never enforced.
  if (isOption && !zeroDte && d != null && Math.abs(d) < L.optionDeltaFloor) {
    notes.push(`delta ${Math.abs(d).toFixed(2)} is below the ${L.optionDeltaFloor} entry floor — info`);
  }
  if (!singleName.known && singleName.unpriced > 0) {
    notes.push(`${singleName.unpriced} line${singleName.unpriced === 1 ? '' : 's'} in this name could not be priced — the exposure held is understated`);
  }
  if (zeroDte) {
    notes.push(`0DTE rule set — the ATR test is not used: gamma makes delta unstable within the session, so the ratio is obsolete before it can be acted on. Flat by ${L.zeroDteFlatBy}.`);
    if (d != null) {
      const ad = Math.abs(d);
      if (ad < L.zeroDteDeltaLo || ad > L.zeroDteDeltaHi) {
        warnings.push(`delta ${ad.toFixed(2)} is outside the ${L.zeroDteDeltaLo}–${L.zeroDteDeltaHi} band 0DTE entries are held to`);
      }
    }
  }
  // A MULTI-MONTH THESIS WRAPPED IN A 40-DAY OPTION is the documented failure mode. Joined against
  // the event calendar rather than judged by days.
  // OPTIONAL, AND A FLAG RATHER THAN A STOP. Nothing here requires the calendar to be supplied or
  // the expiry to contain an event; an expiry with nothing scheduled in it is reported as exactly
  // that and the size is computed either way.
  const cat = catalystCheck(expiry, catalysts, now);
  if (cat && cat.none) notes.push(cat.note);
  if (indicative) notes.push(`indicative — greeks are the prior close${asOf ? ` (${asOf})` : ''}, not a live quote`);

  const dte = expiry ? Math.round((Date.parse(`${expiry}T21:00:00Z`) - now.getTime()) / 86400000) : null;

  return {
    ok: true, symbol, kind, ruleSet, zeroDte,
    tests, size, binding, unscored: unscored.map(t => t.name),
    optionCounts,
    belowOne: size === 0,
    premium, deltaAdded, perUnitDelta,
    dte, catalysts: cat,
    entered: ent, enteredMultiple, enteredDelta, enteredPremium,
    book: { beforeUsd: +before.toFixed(2), before: beforeX, afterUsd, after: afterX,
            // Both projections, always, so "what the rule would have put on" stays visible beside
            // "what I am about to put on" rather than being replaced by it.
            atSuggested: atSuggestedUsd == null ? null : +(atSuggestedUsd / eq).toFixed(2),
            follows: ent != null ? 'entered' : 'suggested',
            target: L.portfolioDeltaTarget, ceiling: L.portfolioDeltaCeiling,
            // What is left AFTER this trade — the number a reader is deciding against. The
            // pre-trade room is kept beside it because that is what `fitSize` is computed from,
            // and reporting one as the other is how a budget looks larger than it is.
            remaining: afterX == null ? +(L.portfolioDeltaCeiling - beforeX).toFixed(2)
                                      : +(L.portfolioDeltaCeiling - afterX).toFixed(2),
            remainingBefore: +(L.portfolioDeltaCeiling - beforeX).toFixed(2),
            roomUsd: +room.toFixed(2) },
    // Reported, never substituted. `pastCeiling` says the book would pass 1.5× at this size;
    // `fitSize` says what would not. Neither changes `size`.
    pastCeiling, pastTarget, fitSize,
    singleName,
    leverage: levInfo,
    bucket: { used: bucketUsed, byDefault: swingByDefault ? 'swing' : 'position', holdBeyond: !!holdBeyond, room: roomInfo, fit: swingFit },
    indicative, asOf, warnings, notes, limits: L,
    // ── SHAPED FOR lib/decisions.js ───────────────────────────────────────────
    // So a sizer run reconciles against the actual fill through the log that already does it, and
    // overrideStats() reports the gap with no second implementation.
    // ONE SIZE, AND IT IS THE RULE'S. `roomQty` used to become `fitSize` on a blocked run, which
    // meant the reconciliation measured the override against a number the ceiling had substituted
    // rather than against what the rule actually said.
    fullQty: size, roomQty: size,
    mode: ruleSet, effPct: L.riskPct, riskAtSize: (size != null && a != null && d != null && isOption)
      ? +(size * Math.abs(a * d * L.contractMultiplier)).toFixed(2)
      : (size != null && a != null && isFuture) ? +(size * a * mult).toFixed(2)
      : (size != null && a != null && !isOption) ? +(size * a).toFixed(2) : null,
    atr: a, atrPct: num(atrPct), price: p, delta: d, mark: m,
    multiplier: isFuture ? mult : null,
  };
}

// ── A FUTURE, SIZED AS ITSELF AND AS ITS MICRO ───────────────────────────────
// The main contract first. If it floors to zero and the family has a micro sibling, the micro is
// sized too and both are shown: "CL: below one contract · 2 MCL". No sibling: "below one contract
// — no micro exists". Then the three lines a share has no equivalent of — term structure against
// the front month, the gap test at the size, and the roll — none of which has a threshold.
export function sizeFuture({ family, month = null, front = null, price = null, atr = null, atrPct = null, nlv = null, entered = null,
                             multiplier = null, ...rest } = {}) {
  const fam = familyOf(family) || String(family || '').toUpperCase().trim() || null;
  const info = FAMILIES[fam] || null;
  const mult = num(multiplier) ?? MULTIPLIER[fam] ?? null;
  const label = month?.label ? `${fam} ${month.label}` : fam;
  const main = sizeTrade({ ...rest, kind: 'future', symbol: looksLikeSpread(family) ? family : label, price, atr, atrPct, nlv, entered, multiplier: mult });
  if (!main.ok) return { ok: false, why: main.why, family: fam, limits: main.limits };
  const microFam = info?.micro || null;
  const microMult = microFam ? MULTIPLIER[microFam] ?? null : null;
  const belowOne = main.size === 0;
  const micro = (belowOne && microFam && microMult)
    ? sizeTrade({ ...rest, kind: 'future', symbol: month?.label ? `${microFam} ${month.label}` : microFam, price, atr, atrPct, nlv, entered, multiplier: microMult })
    : null;
  const chosen = micro?.ok ? micro : main;
  const contracts = chosen.entered ?? chosen.size ?? 0;
  const term = (front && month) ? termStructure(front, { ...month, price: month.price ?? price }) : null;
  const gap = gapTest({ contracts, price, multiplier: chosen.multiplier, nlv });
  const roll = rollLine(month, fam);
  const notes = [];
  if (belowOne && !micro) notes.push(`${fam}: below one contract — no micro exists`);
  if (belowOne && micro?.ok) notes.push(`${fam} sizes below one contract; the micro ${microFam} (${MULTIPLIER[microFam].toLocaleString('en-US')} ${info?.unit || ''}) is shown instead`);
  if (info?.note) notes.push(info.note);
  return {
    ok: true, family: fam, parent: parentFamily(fam), unit: info?.unit ?? null, physical: !!info?.physical, index: isIndexFamily(fam),
    month, front, multiplier: mult,
    main, micro, chosen, microUsed: !!micro?.ok, belowOne, noMicro: belowOne && !micro,
    contracts, notional: +(contracts * (num(price) ?? 0) * (chosen.multiplier ?? 0)).toFixed(2),
    term, gap, roll, atrSource: 'realised', notes,
  };
}

// ── THE CATALYST JOIN ────────────────────────────────────────────────────────
// "Any expiry containing no scheduled catalyst" — asked against the calendar the P7 auction feed
// and the hand-maintained events both write into, not against a rule of thumb about days.
export function catalystCheck(expiry, events, now = new Date()) {
  if (!expiry) return null;
  if (!Array.isArray(events)) return { checked: false, note: 'no calendar supplied — the expiry has not been checked for a catalyst' };
  const today = now.toISOString().slice(0, 10);
  const inside = events.filter(e => e?.date && e.date >= today && e.date <= expiry)
    // Tier 1 only: a weekly claims print is not what "does this expiry contain a catalyst" means.
    .filter(e => (e.tier ?? 2) <= 1);
  return inside.length
    ? { checked: true, none: false, n: inside.length,
        first: inside[0].title || inside[0].label || null,
        note: `${inside.length} scheduled catalyst${inside.length === 1 ? '' : 's'} before expiry — first is ${inside[0].title || inside[0].label}` }
    : { checked: true, none: true, n: 0,
        note: `no scheduled catalyst between now and ${expiry} — a multi-month thesis wrapped in a dated option is the documented failure mode` };
}

// ── THE JOURNAL, AND THE ONLY THING THAT PROVES ANY OF THIS WORKS ────────────
// The rules only work if they are followed, and the only way to know whether they are is to
// measure the gap. A month of "actual exceeded intended on 6 of 19 trades" is worth more than any
// single sizing calculation.
//
// This is a DIFFERENT record from lib/decisions.js and both are wanted. That log begins at a FILL:
// a trade you sized and then did not take leaves no trace in it, and a trade you took without
// consulting the sizer looks identical to one you consulted and obeyed. This one begins at the
// QUESTION, so the denominator is every time a size was asked for.
export const SIZER_RUNS_KEY = 'dvcap:sizer:runs:v1';
export const MAX_RUNS = 500;
// How long after a run a fill is taken to be the trade that run was for. Beyond a session it is a
// different decision wearing the same ticker.
export const MATCH_WINDOW_H = 24;

export function sizerRun(result, { at = new Date().toISOString(), window = null, future = null } = {}) {
  if (!result?.ok) return null;
  // A future's run is keyed by its FAMILY so the reconciliation can find the console's fill,
  // which is recorded against the family (MCL) and not the dated month.
  const fut = future && typeof future === 'object' ? future : null;
  return {
    at,
    symbol: fut ? (fut.chosen?.symbol ? rootOf(fut.chosen.symbol) : fut.family) : (result.symbol || null),
    // ── THE FUTURE'S RECORD ──
    future: fut ? {
      instrument_type: 'future', family: fut.chosen?.symbol ? rootOf(fut.chosen.symbol) : fut.family, parent: fut.parent ?? null,
      contract_month: fut.month?.label ?? null, contract_code: fut.month?.code ?? null, last_trade_date: fut.month?.lastTrade ?? null,
      multiplier: fut.chosen?.multiplier ?? fut.multiplier ?? null,
      contracts_suggested: fut.chosen?.size ?? null, contracts_entered: fut.chosen?.entered ?? null,
      micro_used: !!fut.microUsed, below_one: !!fut.belowOne,
      term_spread_usd: fut.term?.spread ?? null, term_spread_pct_per_month: fut.term?.pctPerMonth ?? null, term_shape: fut.term?.shape ?? null,
      atr_source: fut.atrSource ?? 'realised', gap_10pct_usd: fut.gap?.ten?.usd ?? null, physical: !!fut.physical } : null,
    kind: result.kind, ruleSet: result.ruleSet,
    size: result.size,
    binding: result.binding,
    // WHAT WAS SHOWN, AND WHAT WAS TYPED. The suggested size alone cannot tell you later whether a
    // rule was followed — the entered quantity is the other half, and it is the half the log exists
    // for. Null when the user never typed one, which is not the same as agreeing with the
    // suggestion and must not read as it.
    entered: result.entered ?? null,
    enteredMultiple: result.enteredMultiple ?? null,
    pastCeiling: !!result.pastCeiling, fitSize: result.fitSize ?? null,
    premium: result.premium, deltaAdded: result.deltaAdded,
    bookBefore: result.book?.before ?? null,
    bookAfter: result.book?.after ?? null,
    // Recorded whether or not it was supplied — "not checked" and "nothing scheduled" are
    // different facts about a trade and collapse into each other if only one is stored.
    catalyst: result.catalysts ? { checked: !!result.catalysts.checked, none: !!result.catalysts.none,
                                   first: result.catalysts.first ?? null } : null,
    // The catalyst window's compact form (lib/catalyst.js `log`): class, own earnings date and
    // status, gap, the events inside, and where the date came from and when. Null when the
    // lookup was not made — which is a different fact from "nothing found" and is kept distinct.
    catalystWindow: window && typeof window === 'object' ? {
      catalyst_class: window.catalyst_class ?? null, own_earnings_date: window.own_earnings_date ?? null,
      earnings_status: window.earnings_status ?? null, gap_days: window.gap_days ?? null,
      inside_events: Array.isArray(window.inside_events) ? window.inside_events.slice(0, 20) : [],
      feed_source: window.feed_source ?? null, fetched_at: window.fetched_at ?? null } : null,
    indicative: !!result.indicative,
    // The leverage read, and the bucket the trade was sized into.
    leverage: result.leverage ? {
      leverage_factor: result.leverage.factor, delta_notional_signed: result.leverage.deltaNotional,
      underlying_equiv_shares: result.leverage.underlyingShares, reset: result.leverage.reset, underlying: result.leverage.underlying,
      atr_source: result.leverage.atrSource } : null,
    bucket: result.bucket?.used ?? null,
    // The option's three counts, which governed, where the delta came from, and whether the cap
    // was exempt — flat, so the monthly review can count them.
    atr_contracts: result.optionCounts?.atr ?? null,
    premium_contracts: result.optionCounts?.premium ?? null,
    cap_contracts: result.optionCounts?.cap ?? null,
    governing_test: result.optionCounts?.governing ?? null,
    delta_source: result.singleName?.deltaSource ?? null,
    etf_exempt: result.singleName ? !!result.singleName.exempt : null,
    // The single-name exposure at entry: what the underlying carried with this trade on, as a
    // share of NLV, and where the delta came from. `past_cap` is the monthly line's count.
    // `underlying_exposure` and `single_name_pct` are the TRADED LEG's (shares or options, each
    // tested on its own); the two legs and the display-only combined figure sit beside them.
    singleName: result.singleName ? {
      underlying_exposure: result.singleName.total ?? null,
      single_name_pct: result.singleName.pct ?? null,
      leg: result.singleName.leg ?? null,
      shares_exposure: result.singleName.shares?.total ?? null,
      options_exposure: result.singleName.options?.total ?? null,
      combined_exposure: result.singleName.combined ?? null,
      delta_source: result.singleName.deltaSource ?? null,
      past_cap: !!result.singleName.past,
      over_cap: !!result.singleName.over,
      etf_exempt: !!result.singleName.exempt,
      existing_known: !!result.singleName.known } : null,
    // The inputs, so a run can be re-read against the conditions it was computed in rather than
    // re-derived from a book that has since moved.
    price: result.price ?? null, atr: result.atr ?? null, delta: result.delta ?? null, mark: result.mark ?? null,
    dte: result.dte ?? null,
  };
}

export function appendRun(log = [], run, max = MAX_RUNS) {
  if (!run) return Array.isArray(log) ? log : [];
  const rows = Array.isArray(log) ? log : [];
  return [...rows, run].slice(-max);
}

// ── INTENDED vs ACTUAL ───────────────────────────────────────────────────────
// `fills` are opening fills: { symbol, qty, at }. A run with no fill inside the window is NOT
// counted as a violation — it is a trade that was sized and not taken, which is the tool working.
// It is counted separately, because "sized and declined" is the outcome this whole exercise is
// trying to produce more of.
export function reconcileRuns(runs = [], fills = [], { windowH = MATCH_WINDOW_H } = {}) {
  const rows = (Array.isArray(runs) ? runs : []).filter(r => r?.at && r.symbol != null && r.size != null);
  if (!rows.length) return { n: 0, note: 'no sizer runs recorded yet' };
  const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const ms = windowH * 3600000;
  const matched = [], notTaken = [];
  for (const r of rows) {
    const t0 = Date.parse(r.at);
    const hit = (Array.isArray(fills) ? fills : [])
      .filter(f => f?.at && norm(f.symbol) === norm(r.symbol) && Number(f.qty) > 0)
      .filter(f => { const t = Date.parse(f.at); return Number.isFinite(t) && t >= t0 && t - t0 <= ms; })
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    if (!hit) { notTaken.push(r); continue; }
    // The size the sizer put in front of the user. RUNS RECORDED BEFORE THE CEILING STOPPED
    // BLOCKING carry `blocked: true` and were shown `fitSize` instead of `size`, so they are
    // measured against what was actually on screen at the time — the log is a record of what was
    // shown, and rewriting its meaning retrospectively would make the old rows say something that
    // never happened. Nothing writes `blocked` any more.
    const intended = r.blocked ? (r.fitSize ?? 0) : r.size;
    matched.push({ ...r, actual: Number(hit.qty), intended,
                   ratio: intended > 0 ? +(Number(hit.qty) / intended).toFixed(2) : null, filledAt: hit.at });
  }
  const withRatio = matched.filter(m => m.ratio != null);
  const exceeded = withRatio.filter(m => m.ratio > 1.05);
  // ── A ROLLING MONTHLY STAT, WHICH IS WHERE THE DISCIPLINE ACTUALLY LIVES ──
  // An all-time mean flattens exactly the thing worth seeing. A number on screen at the moment of
  // entry does not stop a decision taken with conviction — the operator knew the position was
  // large. What catches drift is reading, a month later, that actual exceeded suggested on 6 of 19
  // trades: legible after the fact in a way the moment never is, and it works BECAUSE it did not
  // intervene. An occasional override is the system working. A pattern of them is what this is for.
  const byMonth = [...withRatio.reduce((mm, r) => {
    const k = String(r.at).slice(0, 7);
    const g = mm.get(k) || { month: k, taken: 0, exceeded: 0, under: 0, sum: 0 };
    g.taken++; g.sum += r.ratio;
    if (r.ratio > 1.05) g.exceeded++; else if (r.ratio < 0.95) g.under++;
    return mm.set(k, g);
  }, new Map()).values()]
    .map(g => ({ month: g.month, taken: g.taken, exceeded: g.exceeded, under: g.under,
                 followed: g.taken - g.exceeded - g.under, meanRatio: +(g.sum / g.taken).toFixed(2),
                 note: `actual exceeded suggested on ${g.exceeded} of ${g.taken} trades taken` }))
    .sort((a, b) => b.month.localeCompare(a.month));
  const under = withRatio.filter(m => m.ratio < 0.95);
  const mean = withRatio.length ? +(withRatio.reduce((a, m) => a + m.ratio, 0) / withRatio.length).toFixed(2) : null;
  const worst = [...withRatio].sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))[0] || null;
  return {
    n: rows.length, taken: matched.length, notTaken: notTaken.length,
    exceeded: exceeded.length, under: under.length, followed: withRatio.length - exceeded.length - under.length,
    meanRatio: mean, worst: worst ? { symbol: worst.symbol, intended: worst.intended, actual: worst.actual, ratio: worst.ratio, at: worst.at } : null,
    byMonth, thisMonth: byMonth[0] ?? null,
    matched,
    note: withRatio.length
      ? `actual exceeded suggested on ${exceeded.length} of ${withRatio.length} trades taken`
      : `${rows.length} run${rows.length === 1 ? '' : 's'} recorded, none matched to a fill yet`,
  };
}

// ── THE MONTHLY CATALYST LINE ─────────────────────────────────────────────────
// "4 of 11 option entries were MISMATCH" — the review the window exists for. Counted over the
// recorded option runs that carried a window in the last `days`. WHAT IT CANNOT SAY YET: how those
// closed. Option fills are not in the console (it tracks shares and futures), so no run is matched
// to an outcome; the line reports the count and names the gap rather than inventing a P&L.
export function mismatchReview(runs = [], { now = new Date(), days = 30 } = {}) {
  const since = now.getTime() - days * 86400000;
  const rows = (Array.isArray(runs) ? runs : [])
    .filter(r => r?.at && r.kind === 'option' && r.catalystWindow?.catalyst_class && Date.parse(r.at) >= since);
  const mismatch = rows.filter(r => r.catalystWindow.catalyst_class === 'MISMATCH');
  const tight = rows.filter(r => r.catalystWindow.catalyst_class === 'TIGHT');
  return {
    n: rows.length, mismatch: mismatch.length, tight: tight.length, days,
    note: rows.length
      ? `${mismatch.length} of ${rows.length} option entr${rows.length === 1 ? 'y' : 'ies'} in ${days}d ${rows.length === 1 ? 'was' : 'were'} MISMATCH${tight.length ? `, ${tight.length} TIGHT` : ''}`
      : null,
    outcome: 'outcome not tracked — option fills are not in the console, so how these closed is not measured yet',
  };
}

// ── THE MONTHLY SINGLE-NAME LINE ─────────────────────────────────────────────
// "3 of 11 option entries exceeded the single-name cap on delta-notional" — same form as
// intended-vs-actual, same reason: a number on screen does not stop a decision, a pattern read a
// month later does.
export function capReview(runs = [], { now = new Date(), days = 30 } = {}) {
  const since = now.getTime() - days * 86400000;
  const rows = (Array.isArray(runs) ? runs : [])
    .filter(r => r?.at && r.kind === 'option' && r.singleName && r.singleName.single_name_pct != null && Date.parse(r.at) >= since);
  // Exempt index lines are counted apart, so the month says how many were FLAGGED and how many
  // were over the number but on the exempt list.
  const exempt = rows.filter(r => r.singleName.etf_exempt);
  const counted = rows.filter(r => !r.singleName.etf_exempt);
  const past = counted.filter(r => r.singleName.past_cap);
  const modelled = rows.filter(r => r.singleName.delta_source === 'modelled');
  // ── WHICH TEST SET THE NUMBER, AND HOW OFTEN THE COUNT ENTERED WENT PAST THE CAP'S ──
  // From the runs that carry the three counts (runs before they were logged are simply not in
  // the distribution). "Entered above the cap count" is the monthly line the cap exists for.
  const withCounts = rows.filter(r => r.governing_test != null);
  const governing = {};
  for (const r of withCounts) governing[r.governing_test] = (governing[r.governing_test] || 0) + 1;
  const enteredOverCap = counted.filter(r => r.entered != null && r.cap_contracts != null && r.entered > r.cap_contracts);
  const dist = Object.keys(governing).length ? Object.entries(governing).map(([k, v]) => `${k} ${v}`).join(' / ') : null;
  return {
    n: rows.length, counted: counted.length, past: past.length, exempt: exempt.length, modelled: modelled.length, days,
    governing, enteredOverCap: enteredOverCap.length,
    note: rows.length
      ? `${past.length} of ${counted.length} option entr${counted.length === 1 ? 'y' : 'ies'} in ${days}d exceeded the single-name cap on delta-notional`
        + (withCounts.length ? ` · ${enteredOverCap.length} entered above the cap's count` : '')
        + (dist ? ` · governing test: ${dist}` : '')
        + (exempt.length ? ` · ${exempt.length} on exempt index ETFs, not counted` : '')
        + (modelled.length ? ` · ${modelled.length} on a modelled delta` : '')
      : null,
  };
}

// ── THE MONTHLY FUTURES LINE ─────────────────────────────────────────────────
// "2 of 4 futures entries exceeded the suggested contract count" — the same form as
// intended-vs-actual, from the same reconciliation, restricted to futures runs.
export function futuresReview(recon, { days = 30, now = new Date() } = {}) {
  const since = now.getTime() - days * 86400000;
  const rows = (recon?.matched || []).filter(r => r.kind === 'future' && r.ratio != null && Date.parse(r.at) >= since);
  const exceeded = rows.filter(r => r.ratio > 1.05);
  return { n: rows.length, exceeded: exceeded.length, days,
           note: rows.length ? `${exceeded.length} of ${rows.length} futures entr${rows.length === 1 ? 'y' : 'ies'} in ${days}d exceeded the suggested contract count` : null };
}

// ── THE MONTHLY LEVERAGED-ETF LINE ───────────────────────────────────────────
// "N leveraged-ETF entries; M exceeded the cap on delta-notional; average hold K sessions." The
// hold length is the number that matters for a daily-reset product. `holds` are the console's
// rows for those symbols — {symbol, firstDate, lastDate|null} — so a run is joined to how long
// the position it opened stayed open.
export function leveragedReview(runs = [], holds = [], { now = new Date(), days = 30, holidays = [] } = {}) {
  const since = now.getTime() - days * 86400000;
  const rows = (Array.isArray(runs) ? runs : []).filter(r => r?.at && r.leverage && r.leverage.leverage_factor !== 1 && Date.parse(r.at) >= since);
  const exceeded = rows.filter(r => r.singleName?.past_cap);
  const today = now.toISOString().slice(0, 10);
  const sessionsOf = (from, to) => {
    if (!from) return null;
    const H = new Set(holidays); let n = 0;
    for (const d = new Date(String(from).slice(0, 10) + 'T00:00:00Z'); ; ) {
      d.setUTCDate(d.getUTCDate() + 1); const s2 = d.toISOString().slice(0, 10); if (s2 > (to || today)) break;
      const w = d.getUTCDay(); if (w !== 0 && w !== 6 && !H.has(s2)) n++;
    }
    return n + 1;
  };
  const lens = rows.map(r => {
    const h = (Array.isArray(holds) ? holds : []).find(x => String(x.symbol).toUpperCase() === String(r.symbol).toUpperCase() && x.firstDate && x.firstDate <= String(r.at).slice(0, 10) && (!x.lastDate || x.lastDate >= String(r.at).slice(0, 10)));
    return h ? sessionsOf(h.firstDate, h.lastDate) : null;
  }).filter(v => v != null);
  const avg = lens.length ? +(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1) : null;
  return { n: rows.length, exceeded: exceeded.length, avgHold: avg, measured: lens.length, days,
           note: rows.length
             ? `${rows.length} leveraged-ETF entr${rows.length === 1 ? 'y' : 'ies'} in ${days}d; ${exceeded.length} exceeded the cap on delta-notional${avg != null ? `; average hold ${avg} session${avg === 1 ? '' : 's'}` : '; hold length not yet measured'}`
             : null };
}
