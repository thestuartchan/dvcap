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
  zeroDteFlatBy: '15:30 ET',
  portfolioDeltaTarget: 1.0,    // x NLV — ties to the exposure tile
  portfolioDeltaCeiling: 1.5,   // x NLV — blocks, does not warn
  contractMultiplier: 100,
});

export const RULE_SETS = Object.freeze({ STOCK: 'stock', OPTION: 'option', ZERO_DTE: '0dte' });

// ── THE TESTS ────────────────────────────────────────────────────────────────
// Both are always returned, and which one BINDS is part of the answer. For volatile single names
// the concentration cap usually wins; for options the two often agree. Hiding the losing test
// behind the final number removes the only part of this that teaches anything.
function stockTests({ price, atr, nlv, L }) {
  const out = [];
  const budget = nlv * (L.riskPct / 100);
  out.push(atr > 0
    ? { name: 'ATR test', size: floorTo(budget / atr), detail: `$${Math.round(budget).toLocaleString('en-US')} ÷ $${atr.toFixed(2)} per share` }
    : { name: 'ATR test', size: null, detail: 'no ATR — a size cannot be set against a range that is not known' });
  const cap = nlv * (L.singleNamePct / 100);
  out.push(price > 0
    ? { name: `Concentration cap (${L.singleNamePct}%)`, size: floorTo(cap / price), detail: `$${Math.round(cap).toLocaleString('en-US')} ÷ $${price.toFixed(2)}` }
    : { name: `Concentration cap (${L.singleNamePct}%)`, size: null, detail: 'no price' });
  return out;
}

function optionTests({ atr, delta, mark, nlv, L }) {
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
} = {}) {
  const L = { ...SIZER_LIMITS, ...(limits || {}) };
  const eq = num(nlv), p = num(price), a = num(atr), d = num(delta), m = num(mark);
  if (!(eq > 0)) return { ok: false, why: 'set the account value to get a size', limits: L };

  const isOption = kind === 'option';
  const zeroDte = isOption && expiry ? isZeroDteExpiry(expiry, now) : false;
  const ruleSet = zeroDte ? RULE_SETS.ZERO_DTE : isOption ? RULE_SETS.OPTION : RULE_SETS.STOCK;

  const tests = zeroDte ? zeroDteTests({ mark: m, nlv: eq, openZeroDtePremium, L })
    : isOption ? optionTests({ atr: a, delta: d, mark: m, nlv: eq, L })
    : stockTests({ price: p, atr: a, nlv: eq, L });

  const scored = tests.filter(t => t.size != null);
  const size = scored.length ? Math.min(...scored.map(t => t.size)) : null;
  for (const t of tests) t.binds = t.size != null && size != null && t.size === size;
  const binding = tests.find(t => t.binds)?.name ?? null;
  const unscored = tests.filter(t => t.size == null);

  // What the position would BE, at that size.
  const unit = isOption ? (m != null ? m * L.contractMultiplier : null) : p;
  const premium = (size != null && unit != null) ? +(size * unit).toFixed(2) : null;
  const perUnitDelta = isOption ? ((d != null && p != null) ? d * L.contractMultiplier * p : null) : p;
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

  const warnings = [];
  const notes = [];
  if (size === 0) {
    warnings.push('the size is below one contract — correct, and it means the instrument is too volatile or the account too small for a position here');
  }
  // STATED, NOT ENFORCED. The ceiling is named with the number that passes it, and the size stands.
  if (pastCeiling) {
    warnings.push(`this takes the book to ${afterX}× NLV, past the ${L.portfolioDeltaCeiling}× ceiling`
      + (fitSize != null ? ` — ${fitSize} would sit inside it` : ''));
  } else if (pastTarget) {
    notes.push(`past the ${L.portfolioDeltaTarget}× target and inside the ${L.portfolioDeltaCeiling}× ceiling`);
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
      : (size != null && a != null && !isOption) ? +(size * a).toFixed(2) : null,
    atr: a, atrPct: num(atrPct), price: p, delta: d, mark: m,
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

export function sizerRun(result, { at = new Date().toISOString() } = {}) {
  if (!result?.ok) return null;
  return {
    at,
    symbol: result.symbol || null,
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
    indicative: !!result.indicative,
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
