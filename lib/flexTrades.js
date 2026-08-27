// lib/flexTrades.js — turn the statement's Trades section into console fills.
//
// The positions reconciliation (lib/flex.js) answers "does the console hold what the broker holds".
// It cannot answer "did you record the exit", because an Open Positions snapshot has no history: a
// position sold yesterday is simply absent, which is indistinguishable from one the console never
// knew about. The Trades section is the history, and this turns it into fills.
//
// THE SAFETY PROPERTY, first, because everything else is subordinate to it. Nothing here writes.
// It produces a PLAN, the plan is applied to a copy, the copy is re-derived, and the result is
// checked against the Open Positions section of the SAME statement. Only if every touched symbol
// then agrees on quantity and average cost does the caller commit — otherwise the whole batch is
// discarded. The two sections would have to be wrong in the same direction for a bad write to get
// through, which is a far stronger guarantee than any amount of care inside this file.
//
// THE WATERMARK. `flexTradesFrom` is the date from which the broker is the record. Everything
// before it is left alone, and that is not laziness: the console's existing rows are bulk averages
// — one fill of 600 METU standing for three orders — and no individual order will ever match one.
// Trying to reconcile them would fail adoption on nearly every historical trade, fail the
// verification gate, and reject every batch for ever. So ingestion starts the day it is switched
// on and the past stays as it was recorded.
//
// ADOPTION. A trade you also entered by hand has no trade id, so it looks new, and applying it
// would double the position. Before adding anything, each trade looks for a hand-entered fill that
// is plainly the same event — same side, same quantity, same date, price within half a percent —
// and stamps the id onto that fill instead. One candidate adopts; two or more is ambiguous and is
// reported rather than guessed at.

import { rootOf, matchKey, classOf, isoDate, elements, COST_TOLERANCE_PCT } from './flex.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// ── The Trades section ────────────────────────────────────────────────────────
// A saved query can emit the same trade three times over: once per execution, once per order, and
// once per closed lot. Reading all three triples every position. ORDER is the level this wants —
// one row per order is how a trade is thought about — with EXECUTION as the fallback for a query
// saved without it. CLOSED_LOT is never a trade; it is an accounting view of one.
export const TRADE_LEVELS = ['ORDER', 'EXECUTION'];

// WHICH ELEMENTS THE SECTION ACTUALLY EMITS, AND WHAT THEY CALL THINGS. A saved query with only
// Orders ticked emits <Order> elements, not <Trade levelOfDetail="ORDER"> — and an <Order> row does
// not carry `tradeID` at all. It has `ibOrderID`. The first attempt read the elements and then
// dropped all 177 of them for having no id, which from outside looks identical to the section being
// missing: a working endpoint, an empty result, nothing saying anything is wrong. Twice now the
// failure has been a field name, so this reports WHY rows were dropped rather than only how many
// survived.
const normalise = (raw) => {
  const qty = num(raw.quantity);
  const price = num(raw.tradePrice);
  const mult = num(raw.multiplier) || 1;
  const side = String(raw.buySell || '').toUpperCase().startsWith('S') || (qty != null && qty < 0) ? 'sell' : 'buy';
  const units = qty == null ? null : Math.abs(qty);
  // COMMISSION FOLDED INTO THE PRICE, which is the convention every fill in this console already
  // follows: what the trade actually cost per unit, not the headline print. IBKR reports the
  // commission negative; a buy pays it and a sell nets it out.
  const comm = Math.abs(num(raw.ibCommission) ?? 0);
  const gross = units == null || price == null ? null : units * price * mult;
  const eff = gross == null ? null : (side === 'buy' ? gross + comm : gross - comm) / (units * mult);
  return {
    // Whichever id this shape carries, QUALIFIED BY THE CONTRACT. An order id is unique per order,
    // not per leg, and a futures roll placed as a combo is one order against two contracts — so the
    // bare id would make the Oct sell and the Dec buy the same trade, and deduplication would throw
    // one of them away. The contract id disambiguates and is just as stable, which matters because
    // this value is what stops a trade being recorded twice on the next run.
    tradeId: (() => {
      const base = String(raw.tradeID || raw.ibOrderID || raw.orderID || raw.transactionID || '').trim();
      if (!base) return null;
      const leg = String(raw.conid || raw.symbol || '').trim();
      return leg ? `${base}:${leg}` : base;
    })(),
    symbol: String(raw.symbol || '').toUpperCase(),
    root: rootOf(raw),
    assetCategory: String(raw.assetCategory || '').toUpperCase(),
    currency: String(raw.currency || '').toUpperCase() || null,
    multiplier: mult,
    side,
    qty: units,
    price: eff == null ? null : +eff.toFixed(6),
    rawPrice: price,
    commission: comm,
    date: isoDate(raw.tradeDate || raw.dateTime || raw.orderTime || raw.settleDateTarget),
    openClose: String(raw.openCloseIndicator || '').toUpperCase() || null,
    levelOfDetail: String(raw.levelOfDetail || '').toUpperCase() || null,
    transactionType: String(raw.transactionType || '').trim() || null,
  };
};

// A saved query can emit the same trade three times over: once per execution, once per order, and
// once per closed lot. Reading all three triples every position. ORDER is the level this wants —
// one row per order is how a trade is thought about — with EXECUTION as the fallback for a query
// saved without it. CLOSED_LOT is never a trade; it is an accounting view of one.
const wantedLevel = (rows) => {
  const levels = new Set(rows.map(t => t.levelOfDetail).filter(Boolean));
  return TRADE_LEVELS.find(l => levels.has(l)) || null;
};

// null means keep.
function dropReason(t, want) {
  const levelOk = want == null
    ? (!t.levelOfDetail || !['ORDER', 'EXECUTION', 'CLOSED_LOT'].includes(t.levelOfDetail))
    : t.levelOfDetail === want;
  if (!levelOk) return 'otherLevelOfDetail';
  if (!t.tradeId) return 'noId';
  if (!(t.qty > 0)) return 'noQuantity';
  if (t.price == null) return 'noPrice';
  if (!t.date) return 'noDate';
  // Corporate actions, FX conversions and transfers share the section and are not trades. Anything
  // that names its type must name a trade.
  if (t.transactionType && !/trade/i.test(t.transactionType)) return 'notATrade';
  return null;
}

const dedupe = (rows) => { const seen = new Set(); return rows.filter(t => seen.has(t.tradeId) ? false : (seen.add(t.tradeId), true)); };

// <Trade> is preferred whole: mixing the two shapes would put the same order in twice under two
// different ids, since they do not share an id field.
function shapes(xml) {
  return [
    elements(xml, 'Trade').map(normalise),
    elements(xml, 'Order').map(t => normalise({ ...t, levelOfDetail: t.levelOfDetail || 'ORDER' })),
  ];
}

export function parseTrades(xml) {
  for (const rows of shapes(xml)) {
    const want = wantedLevel(rows);
    const kept = dedupe(rows.filter(t => dropReason(t, want) == null));
    if (kept.length) return kept;
  }
  return [];
}

// What the document held and what happened to it. Only consulted when nothing survived, which is
// exactly when "no trades in the statement" needs to be more specific than it can be on its own.
export function tradeSections(xml) {
  const [tradeRows, orderRows] = shapes(xml);
  const out = { Trade: tradeRows.length, Order: orderRows.length, TradeConfirm: elements(xml, 'TradeConfirm').length, dropped: {} };
  for (const rows of [tradeRows, orderRows]) {
    const want = wantedLevel(rows);
    for (const t of rows) {
      const why = dropReason(t, want);
      if (why) out.dropped[why] = (out.dropped[why] || 0) + 1;
    }
  }
  return out;
}

// ── Planning ──────────────────────────────────────────────────────────────────
const PRICE_TOLERANCE_PCT = 0.5;
const sameish = (a, b) => a != null && b != null && Math.abs(a - b) <= Math.abs(b) * (PRICE_TOLERANCE_PCT / 100) + 1e-9;

const consoleRoot = (r) => matchKey(rootOf({ symbol: r.symbol, assetCategory: r.margined ? 'FUT' : 'STK' }));

// `rows` are console rows with `derived`. Returns a PLAN — nothing is mutated.
export function planTrades(rows = [], trades = [], { from = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const adopt = [], apply = [], creates = [], report = [];
  const skipped = { beforeWatermark: 0, alreadyRecorded: 0, outOfScope: 0, dayTrades: 0 };

  // Every trade id the console already holds, so a 30-day window can be re-read for ever.
  const known = new Set();
  for (const r of rows) for (const f of (r.fills || [])) if (f.tradeId) known.add(String(f.tradeId));

  const byRoot = new Map();
  for (const r of rows) {
    const k = consoleRoot(r);
    byRoot.set(k, [...(byRoot.get(k) || []), r]);
  }

  const usable = [];
  for (const t of [...trades].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    if (from && t.date < from) { skipped.beforeWatermark++; continue; }
    if (known.has(t.tradeId)) { skipped.alreadyRecorded++; continue; }
    const kind = classOf(t);
    if (kind === 'option' || kind === 'cash' || kind === 'other') { skipped.outOfScope++; continue; }
    usable.push(t);
  }

  // DAY TRADES STAY IN THE BROKER. The console's scope is spot, swings and long holds; the channel
  // says so on its own front page. A statement window holds every scalp as well, and left alone
  // this would open a row for each one, fill it, close it in the same breath and file it in the
  // archive — burying the swing record under exactly the trades that were deliberately kept out.
  //
  // A round trip in a symbol the console holds nothing in, opened and closed on ONE DAY, is a day
  // trade by definition and is skipped. The same round trip spanning more than one day is a swing
  // that never got recorded, which is worth knowing about, so it is reported rather than dropped —
  // and not applied either, because a completed trade the console never saw is a judgement call.
  //
  // Trades in a symbol that DOES have a console row are always applied, scalp or not: they moved a
  // position the console is tracking, and leaving them out would put its average cost at odds with
  // the broker's.
  const unheld = new Map();
  for (const t of usable) {
    const key = matchKey(t.root);
    if ((byRoot.get(key) || []).length) continue;
    unheld.set(key, [...(unheld.get(key) || []), t]);
  }
  const skipRoots = new Set();
  for (const [key, ts] of unheld) {
    const net = ts.reduce((a, t) => a + (t.side === 'buy' ? t.qty : -t.qty), 0);
    if (Math.abs(net) > 1e-9) continue;
    const days = [...new Set(ts.map(t => t.date))].sort();
    skipRoots.add(key);
    if (days.length === 1) { skipped.dayTrades += ts.length; continue; }
    report.push({ kind: 'round-trip-not-recorded', root: ts[0].root, dates: days, trades: ts.length,
      note: 'opened and closed across more than one day in a symbol the console never held — a swing that was not recorded, so it is left for you rather than filed automatically' });
  }

  // Rows created within this plan, so two buys in one unseen symbol land on one row.
  const made = new Map();

  for (const t of usable) {
    const key = matchKey(t.root);
    if (skipRoots.has(key)) continue;
    const candidates = byRoot.get(key) || [];

    // ADOPT — the same event, entered by hand, before the statement caught up with it.
    const matches = [];
    for (const r of candidates) {
      for (const f of (r.fills || [])) {
        if (f.tradeId || f.side !== t.side || f.date !== t.date) continue;
        if (Math.abs(Number(f.qty) - t.qty) > 1e-9) continue;
        if (!sameish(Number(f.price), t.price)) continue;
        matches.push({ rowId: r.id, fillId: f.id });
      }
    }
    if (matches.length === 1) { adopt.push({ ...matches[0], tradeId: t.tradeId, root: t.root }); known.add(t.tradeId); continue; }
    if (matches.length > 1) {
      report.push({ kind: 'ambiguous-adoption', tradeId: t.tradeId, root: t.root, date: t.date,
        note: 'more than one recorded fill looks like this trade — left alone rather than guessed at' });
      continue;
    }

    // APPLY — onto the one row that is open in this symbol.
    const open = candidates.filter(r => r.derived?.status !== 'closed');
    if (open.length > 1) {
      report.push({ kind: 'ambiguous-row', root: t.root, tradeId: t.tradeId, rowIds: open.map(r => r.id),
        note: 'two open console rows share this symbol — the statement cannot say which this belongs to' });
      continue;
    }
    if (open.length === 1) { apply.push({ rowId: open[0].id, root: t.root, fill: fillFrom(t) }); known.add(t.tradeId); continue; }

    const pending = made.get(key);
    if (pending) { apply.push({ rowId: pending, root: t.root, fill: fillFrom(t) }); known.add(t.tradeId); continue; }

    // A SELL with nothing open is never guessed at: it is either a position the console never had,
    // or a sale of something it thinks is already flat, and both need a human.
    if (t.side === 'sell') {
      report.push({ kind: 'sell-with-no-position', root: t.root, tradeId: t.tradeId, date: t.date,
        note: 'a sale in a symbol the console holds nothing open in — recorded nowhere, add the position by hand' });
      continue;
    }
    const row = rowFromTrade(t, today);
    creates.push(row); made.set(key, row.id); known.add(t.tradeId);
    apply.push({ rowId: row.id, root: t.root, fill: fillFrom(t) });
  }
  return { adopt, apply, creates, report, skipped };
}

export const fillFrom = (t) => ({
  id: `fx${String(t.tradeId).slice(-10)}`,
  side: t.side, qty: t.qty, price: t.price, date: t.date,
  note: `IBKR trade ${t.tradeId}, commission included`,
  tradeId: t.tradeId,
});

export function rowFromTrade(t, today) {
  const futures = classOf(t) === 'futures';
  const hk = /^\d{1,5}$/.test(t.root) && t.currency === 'HKD';
  const code = hk ? t.root.padStart(4, '0') : t.root;
  return {
    id: `${code}-flex-${String(t.tradeId).slice(-8)}`,
    symbol: hk ? `${code}.HK` : code,
    currency: t.currency || 'USD',
    multiplier: t.multiplier || 1,
    margined: futures,
    trade: '',
    thesis: `Opened from the IBKR statement — first seen as trade ${t.tradeId} on ${t.date}. Nothing here is a view; add one, and a stop, if you want the card to show R.`,
    levels: [], tags: ['new', 'flex'], fills: [],
  };
}

// ── Applying, to a copy ───────────────────────────────────────────────────────
export function applyPlan(rows = [], plan) {
  const adoptions = new Map();
  for (const a of plan.adopt) adoptions.set(`${a.rowId}::${a.fillId}`, a.tradeId);
  const added = new Map();
  for (const a of plan.apply) added.set(a.rowId, [...(added.get(a.rowId) || []), a.fill]);

  const out = rows.map(r => {
    const extra = added.get(r.id) || [];
    const fills = (r.fills || []).map(f => {
      const id = adoptions.get(`${r.id}::${f.id}`);
      return id ? { ...f, tradeId: id } : f;
    });
    return (extra.length || fills !== r.fills) ? { ...r, fills: [...fills, ...extra] } : r;
  });
  for (const c of plan.creates) out.push({ ...c, fills: added.get(c.id) || [] });
  return out;
}

// ── The gate ──────────────────────────────────────────────────────────────────
// Re-derive what the plan produced and hold it against the Open Positions section of the SAME
// statement. A symbol the statement no longer lists must come out flat; one it lists must agree on
// quantity, and on cost basis unless the row has already acknowledged a divergence.
//
// This is the check that makes ingestion safe to run unattended. It is deliberately whole-batch:
// a plan that cannot be verified is discarded entirely rather than partly applied, because a
// half-written batch is the one state nothing downstream knows how to reason about.
export function verify(after = [], positions = [], { derive, roots = null } = {}) {
  const problems = [];
  const byRoot = new Map();
  for (const p of positions) byRoot.set(matchKey(p.root), p);
  const touched = roots ? new Set([...roots].map(matchKey)) : null;

  // GROUPED BY ROOT, because the statement has ONE line per lot and the console can have several
  // rows for it — a rolled-out contract and the one that replaced it are two rows and one position.
  // Checking each row against that single line failed the closed leg for holding nothing, which is
  // precisely what a closed leg is supposed to hold, and rejected an otherwise correct batch.
  const rowsByRoot = new Map();
  for (const r of after) {
    const key = consoleRoot(r);
    if (touched && !touched.has(key)) continue;
    rowsByRoot.set(key, [...(rowsByRoot.get(key) || []), r]);
  }

  for (const key of new Set([...rowsByRoot.keys(), ...(touched || [])])) {
    if (touched && !touched.has(key)) continue;
    const rows = (rowsByRoot.get(key) || []).map(r => ({ r, d: derive(r) }));
    const open = rows.filter(x => x.d.status !== 'closed');
    const qty = open.reduce((a, x) => a + (x.d.qty || 0), 0);
    const p = byRoot.get(key);
    if (!p) {
      if (qty > 0) problems.push({ root: key, ids: open.map(x => x.r.id), why: 'the statement does not list this position, but the fills leave it open', console: qty });
      continue;
    }
    if (!rows.length) { problems.push({ root: key, why: 'the statement lists this position but nothing in the console holds it after applying' }); continue; }
    if (Math.abs(qty - Math.abs(p.qty)) > 1e-6) {
      problems.push({ root: key, ids: open.map(x => x.r.id), why: 'quantity does not match the statement after applying', console: qty, ibkr: Math.abs(p.qty) });
      continue;
    }
    // Cost basis is only comparable when ONE row holds the position. Two open rows in a symbol are
    // two trades with two averages, and the statement's single blended figure is not either of them.
    if (open.length !== 1) continue;
    const { r, d } = open[0];
    const acked = Number(r.costBasisAck);
    const avg = d.avgCost;
    const ok = avg != null && p.costBasisPrice != null &&
      (Math.abs(avg - p.costBasisPrice) <= Math.abs(p.costBasisPrice) * (COST_TOLERANCE_PCT / 100) + 1e-9 ||
       (Number.isFinite(acked) && Math.abs(acked - p.costBasisPrice) <= Math.abs(p.costBasisPrice) * 0.0001));
    if (!ok) problems.push({ root: key, id: r.id, why: 'cost basis does not match the statement after applying', console: avg, ibkr: p.costBasisPrice });
  }
  return { ok: problems.length === 0, problems };
}

export const planTouches = (plan) => [...new Set([
  ...plan.adopt.map(a => a.root), ...plan.apply.map(a => a.root), ...plan.creates.map(c => c.symbol),
].filter(Boolean))];

// `forChannel` drops the adoption count. A fill the statement matched to one you had already
// entered changed nothing you did not already know, and a daily "matched 2 already entered by hand"
// is a notification about the absence of news.
export function summariseTrades(plan, { forChannel = false } = {}) {
  const bits = [];
  const roots = (xs) => [...new Set(xs)].join(', ');
  if (plan.creates.length) bits.push(`opened ${roots(plan.creates.map(c => c.symbol))}`);
  if (plan.apply.length) bits.push(`recorded ${plan.apply.length} fill${plan.apply.length === 1 ? '' : 's'} (${roots(plan.apply.map(a => a.root))})`);
  if (plan.adopt.length && !forChannel) bits.push(`matched ${plan.adopt.length} already entered by hand`);
  if (plan.report.length) bits.push(`${plan.report.length} left for you (${roots(plan.report.map(r => r.root))})`);
  // Day trades are not news — they are the thing the console deliberately does not hold, and saying
  // "skipped 14 scalps" every morning is a daily reminder of a decision already made.
  return bits.join(' · ');
}
