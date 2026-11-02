// lib/optionLedger.js — every option card IBKR disagrees with, explained from IBKR's own record.
//
// WHY ONE ENGINE (2 Nov 2026). Options reached the console's reconciliation as a run of special
// cases, each added after a card went wrong: expired worthless (optionExpiry), closed before expiry
// but only when fully flat (optionExits), a journaled day trade (dayTradeCards). Everything else —
// a partial close, an add, an exercise or assignment, an entry typed by hand — came out as "console
// N, statement M" or "check IBKR", and the MSFT strangle took four fixes in one week.
//
// THE RULE. IBKR is the record. For each open option card whose contracts the statement holds in a
// different size, read what IBKR did to those contracts after the card's last recorded fill: its
// orders (Trades) and its exercises, assignments and expirations (OptionEAE). The SHORTEST recent
// run of those events that takes the console's position to IBKR's is the explanation, and becomes
// the fills to record. Shortest, because the card's own entry — when it was typed by hand and so
// carries no IBKR order id — sits just before that run and must not be read as a second trade.
// A hand-typed fill that IS one of the orders (same day, direction and size) is recognised as the
// card's own and stamped with IBKR's id, so the next sync knows it by id.
//
// WHAT IT NEVER DOES. Edit a row. It returns plans; the sync offers them ("Record it") and applies
// on its own only a plan that is nothing but expirations at 0 (what optionExpiry did). A card that
// shares a contract with another open card, legs that moved by different amounts, or a history
// that does not add up comes back as `unexplained` with the reason, never as a guess.
import { derivePosition } from './positions.js';
import { isDerivativeRow, legsOf, underlyingOf } from './instruments.js';
import { productRoot } from './journalInbox.js';
import { roundQuote } from './price.js';

const EPS = 1e-9;
const keyOf = (root, right, strike, expiry) => `${productRoot(root)}|${expiry}|${right}|${+strike}`;
const legKey = (root, l) => keyOf(root, l.right, l.strike, l.expiry);
const idsOfFill = (f) => f?.tradeId ? [String(f.tradeId), ...String(f.tradeId).split(':')[0].split('+')] : [];
const atMin = (e) => (e.minute != null ? e.minute : Date.parse(`${e.date}T00:00:00Z`) / 60000 + (e.eae ? 1439 : 0));
const cents = (v) => (Number.isFinite(+v) ? (+v).toFixed(2) : String(v));
const fillsTo = (r, asOf) => (r.fills || []).filter(f => !asOf || !f.date || f.date <= asOf);

// The statement's option positions → Map(contract key → signed quantity). `contractOf` is
// lib/flex.js optionContractOf (passed in, so this module needs nothing from the statement reader).
export function positionsByContract(lines = [], contractOf) {
  const m = new Map();
  for (const p of lines || []) {
    const c = contractOf(p);
    if (!c) continue;
    const k = keyOf(c.root, c.type === 'put' ? 'P' : 'C', c.strike, c.expiry);
    m.set(k, (m.get(k) || 0) + (Number(p.qty) || 0));
  }
  return m;
}

// The card as held on the statement's day: { qty, dir, legs: [{ leg, key, sign, held }] }.
function heldOf(r, asOf) {
  const pos = derivePosition(fillsTo(r, asOf), { multiplier: r.multiplier, side: r.side });
  const dir = String(r.side || '').toLowerCase() === 'short' ? -1 : 1;
  const root = underlyingOf(r);
  const qty = pos.status === 'open' ? Number(pos.qty) || 0 : 0;
  const legs = legsOf(r).map(l => {
    const sign = (String(l.side || 'long').toLowerCase() === 'short' ? -1 : 1) * dir * (l.ratio || 1);
    return { leg: l, key: legKey(root, l), sign, held: qty * sign };
  });
  return { qty, dir, root, legs };
}

// Every IBKR event on one contract, signed (+ bought, − sold), after `from`, up to `asOf`.
function eventsFor(key, { units, eae, from, asOf, heldSign }) {
  const out = [];
  for (const u of units || []) {
    if (!(u.type === 'OPT' || u.type === 'COMBO')) continue;
    if (from && u.date && u.date < from) continue;
    if (asOf && u.date && u.date > asOf) continue;
    for (const x of u.legs || []) {
      if (keyOf(u.root, x.right, x.strike, x.expiry) !== key) continue;
      const q = Math.abs(Number(x.qty));
      out.push({ orderId: String(u.orderId), tradeIds: u.tradeIds || [], signed: (x.side === 'SELL' ? -1 : 1) * q, qty: q,
        price: Number(x.price), date: u.date, minute: u.minute, kind: 'trade', legsInOrder: (u.legs || []).length });
    }
  }
  for (const e of eae || []) {
    if (keyOf(e.root, e.right, e.strike, e.expiry) !== key) continue;
    if (from && e.date && e.date < from) continue;
    if (asOf && e.date && e.date > asOf) continue;
    // The event closes whatever was held; its sign is the closing direction.
    const q = Math.abs(Number(e.qty)) || null;
    out.push({ orderId: `eae-${e.type}-${e.date}`, tradeIds: [], signed: q == null ? null : -Math.sign(heldSign || 1) * q, qty: q,
      price: 0, date: e.date || e.expiry, minute: null, eae: true, kind: e.type });
  }
  return out.sort((a, b) => atMin(a) - atMin(b) || a.orderId.localeCompare(b.orderId));
}

// The shortest run of events, counted back from the latest, whose net is `delta`. An event with no
// size (an EAE row without a quantity) closes what is held at that point, so it is sized from the
// position it closed. null when no run adds up.
function suffixFor(events, delta, heldBefore) {
  // Fill in unsized EAE closes by replaying forward from the console's position.
  let pos = heldBefore;
  const sized = events.map(e => {
    if (e.signed != null) { pos += e.signed; return e; }
    const s = { ...e, signed: -pos, qty: Math.abs(pos) };
    pos = 0;
    return s;
  });
  let run = 0;
  for (let i = sized.length - 1; i >= 0; i--) {
    run += sized[i].signed;
    if (Math.abs(run - delta) < EPS) return sized.slice(i);
  }
  return Math.abs(delta) < EPS ? [] : null;
}

// rows: console rows. positions: positionsByContract(statement option lines). units: lib/journalInbox.js
// orderUnits(parseTrades(xml)) — the widest window read. eae: lib/optionExpiry.js parseOptionEae(xml).
// flagged: ids of the cards the reconciliation found disagreeing (lib/flex.js option findings) —
// the reconciliation owns what is left out (day trades, journal-only roots). skip: ids another
// check already named (a journaled day trade).
// → [{ rowId, root, contract, state: 'plan', fills, adopt, kinds } | { rowId, root, contract, state: 'unexplained', why }]
export function optionPlans(rows = [], { positions = new Map(), units = [], eae = [], asOf = null, flagged = null, skip = new Set(), eaePresent = true } = {}) {
  const live = (rows || []).filter(r => isDerivativeRow(r) && heldOf(r, asOf).qty > 0);
  // Contract → the open cards holding it. A contract on two cards cannot say which one moved.
  const holders = new Map();
  for (const r of live) for (const l of heldOf(r, asOf).legs) holders.set(l.key, [...(holders.get(l.key) || []), r.id]);
  const out = [];
  for (const r of live) {
    if (skip.has(r.id) || (flagged && !flagged.has(r.id))) continue;
    const h = heldOf(r, asOf);
    if (!h.legs.length) continue;
    const contract = h.legs.map(({ leg: l }) => `${l.expiry} ${l.right} ${+l.strike}`).join(' / ');
    const base = { rowId: r.id, root: h.root, contract };
    const shared = h.legs.find(l => (holders.get(l.key) || []).length > 1);
    if (shared) {
      const sum = (holders.get(shared.key) || []).reduce((a, id) => a + heldOf(live.find(x => x.id === id), asOf).legs.filter(l => l.key === shared.key).reduce((b, l) => b + l.held, 0), 0);
      if (Math.abs(sum - (positions.get(shared.key) || 0)) < EPS) continue;
      out.push({ ...base, state: 'unexplained', why: 'the same contract is on another open card, so IBKR cannot say which card moved' });
      continue;
    }
    // The change in CARD units each leg asks for; every leg must ask for the same change.
    const deltas = h.legs.map(l => ((positions.get(l.key) || 0) - l.held) / l.sign);
    if (deltas.every(d => Math.abs(d) < EPS)) continue;   // agrees
    if (deltas.some(d => Math.abs(d - deltas[0]) > EPS)) {
      out.push({ ...base, state: 'unexplained', why: 'its legs changed by different amounts at IBKR (a leg closed or rolled on its own)' });
      continue;
    }
    const k = deltas[0];
    // From the card's last recorded fill. Its own fills — by IBKR id, or a hand-typed fill matched to
    // the order it stands for — are not events.
    const fills = fillsTo(r, asOf);
    const from = fills.map(f => f.date).filter(Boolean).sort().at(-1) || null;
    const onRow = new Set(fills.flatMap(idsOfFill));
    const handTyped = fills.filter(f => !f.tradeId);
    const adopt = [];
    const perLeg = [];
    let why = null;
    for (const l of h.legs) {
      let ev = eventsFor(l.key, { units, eae, from, asOf, heldSign: l.held }).filter(e => !onRow.has(e.orderId) && !e.tradeIds.some(t => onRow.has(String(t))));
      // ADOPTION: a hand-typed fill and an order on its own day, same direction, same size.
      for (const f of handTyped) {
        // A card fill moves the card by ±qty units (a buy grows a long card, a sell grows a short one);
        // on this leg that is l.sign per unit.
        const fSign = (String(f.side).toLowerCase() === 'buy' ? 1 : -1) * h.dir * Math.sign(l.sign);
        const want = Math.abs(Number(f.qty) * (l.leg.ratio || 1));
        const hit = ev.find(e => e.kind === 'trade' && e.date === f.date && Math.sign(e.signed) === fSign && Math.abs(e.qty - want) < EPS);
        if (hit) { ev = ev.filter(e => e !== hit); if (!adopt.some(a => a.fillId === f.id)) adopt.push({ fillId: f.id, tradeId: hit.orderId }); }
      }
      const run = suffixFor(ev, k * l.sign, l.held);
      if (!run) { why = `${l.leg.expiry} ${l.leg.right} ${+l.leg.strike}: IBKR's orders since the card's last fill do not add up to the difference`; break; }
      if (!run.length) { why = 'IBKR holds a different size, and nothing it did since the card\'s last fill explains it'; break; }
      if (!run.every(e => Number.isFinite(e.price))) { why = 'an order has no price'; break; }
      perLeg.push({ l, run });
    }
    // An expired contract with no exercises/expirations section to read: say which section to add.
    if (why && !eaePresent && h.legs.some(l => asOf && l.leg.expiry && l.leg.expiry <= asOf)) {
      why = 'it has expired, and the Flex query has no Option Exercises, Assignments and Expirations section to say how — add that section to the saved query and the next run explains it';
    }
    if (why) { out.push({ ...base, state: 'unexplained', why }); continue; }
    const plan = toFills(r, h, perLeg, k);
    if (!plan.fills) { out.push({ ...base, state: 'unexplained', why: plan.why }); continue; }
    out.push({ ...base, state: 'plan', fills: plan.fills, adopt, kinds: [...new Set(plan.fills.map(f => f.kind))] });
  }
  return out;
}

// The legs' runs → card-level fills.
//   one leg: each event is a card fill, in order.
//   several legs, every event moving the card the same way: one fill for the whole change, at the
//     legs' combined price, dated the last event (a strangle sold leg by leg is one exit).
//   several legs, each order a combo across all of them in the card's ratio: one fill per order.
function toFills(r, h, perLeg, k) {
  const rowSign = h.dir;
  const sideFor = (cardUnits) => ((cardUnits > 0) === (rowSign > 0) ? 'buy' : 'sell');
  const label = (kind) => (kind === 'expiration' ? 'expired worthless — IBKR booked the expiry'
    : kind === 'assignment' ? 'assigned at expiry — the option closes at 0; the shares arrive as their own trade'
    : kind === 'exercise' ? 'exercised — the option closes at 0; the shares arrive as their own trade' : null);
  const fillId = (orders, i) => `ox-${orders.join('').replace(/[^A-Za-z0-9]/g, '').slice(-16)}-${i}`;
  if (perLeg.length === 1) {
    const { l, run } = perLeg[0];
    return { fills: run.map((e, i) => {
      const units = e.signed / l.sign;
      return { id: fillId([e.orderId], i), side: sideFor(units), opens: units > 0, qty: roundQuote(Math.abs(units)), price: roundQuote(Math.abs(e.price)), date: e.date,
        tradeId: e.kind === 'trade' ? e.orderId : null, orders: [e.orderId], kind: e.kind,
        note: label(e.kind) || `IBKR order ${e.orderId}, from the statement — commission included` };
    }) };
  }
  const oneWay = perLeg.every(({ l, run }) => run.every(e => Math.sign(e.signed / l.sign) === Math.sign(k)));
  if (oneWay) {
    const kinds = new Set(perLeg.flatMap(p => p.run.map(e => e.kind)));
    const need = Math.abs(k);
    // Per card unit: each leg's average price, signed by how the leg is held.
    const net = perLeg.reduce((a, { l, run }) => {
      const q = run.reduce((b, e) => b + e.qty, 0);
      const avg = q ? run.reduce((b, e) => b + e.qty * e.price, 0) / q : 0;
      return a + Math.sign(l.sign) * (l.leg.ratio || 1) * avg;
    }, 0) * rowSign;
    const all = perLeg.flatMap(p => p.run).sort((a, b) => atMin(a) - atMin(b) || a.orderId.localeCompare(b.orderId));
    const orders = [...new Set(all.map(e => e.orderId))];
    const kind = kinds.size === 1 ? [...kinds][0] : 'trade';
    return { fills: [{ id: fillId(orders, 0), side: sideFor(k), opens: k > 0, qty: roundQuote(need), price: roundQuote(Math.abs(net)), date: all.at(-1)?.date || null,
      tradeId: orders.filter(o => !o.startsWith('eae-')).join('+').slice(0, 24) || null, orders, kind,
      note: label(kind) || `IBKR ${orders.length === 1 ? 'order' : 'orders'} ${orders.join(', ')}, from the statement — commission included` }] };
  }
  // Mixed directions across several legs: only whole combo orders can be read card by card.
  const byOrder = new Map();
  for (const { l, run } of perLeg) for (const e of run) byOrder.set(e.orderId, [...(byOrder.get(e.orderId) || []), { l, e }]);
  const fills = [];
  let i = 0;
  for (const [orderId, parts] of [...byOrder].sort((a, b) => atMin(a[1][0].e) - atMin(b[1][0].e))) {
    if (parts.length !== perLeg.length) return { why: 'its legs were traded separately in both directions — record those orders by hand' };
    const units = parts.map(({ l, e }) => e.signed / l.sign);
    if (units.some(u => Math.abs(u - units[0]) > EPS)) return { why: 'a combo order traded its legs out of the card\'s ratio' };
    const net = parts.reduce((a, { l, e }) => a + Math.sign(l.sign) * (l.leg.ratio || 1) * e.price, 0) * rowSign;
    fills.push({ id: fillId([orderId], i++), side: sideFor(units[0]), opens: units[0] > 0, qty: roundQuote(Math.abs(units[0])), price: roundQuote(Math.abs(net)), date: parts[0].e.date,
      tradeId: orderId.startsWith('eae-') ? null : orderId, orders: [orderId], kind: parts[0].e.kind,
      note: label(parts[0].e.kind) || `IBKR order ${orderId}, from the statement — commission included` });
  }
  return { fills };
}

// ── WHAT THE BANNER SAYS ──
const verb = (f) => (f.kind === 'expiration' ? 'expired worthless' : f.kind === 'assignment' ? 'assigned' : f.kind === 'exercise' ? 'exercised'
  : f.side === 'buy' ? 'bought' : 'sold');
export function planLine(p) {
  if (p.state !== 'plan') return `${p.contract}: IBKR differs and it could not be explained (${p.why}) — check IBKR and record it by hand`;
  const parts = p.fills.map(f => (f.kind === 'trade' ? `${verb(f)} ${f.qty} at ${cents(f.price)} on ${f.date}` : `${verb(f)} on ${f.date}`));
  const shares = p.fills.some(f => f.kind === 'assignment' || f.kind === 'exercise') ? ' — the shares arrive as their own trade' : '';
  return `${p.contract}: at IBKR, ${parts.join('; ')}${shares} — not yet on the card`;
}
// What "Record it" carries: the fills, and the hand-typed fills to stamp with IBKR's order id.
export function planFix(p) {
  const f = p.fills[0];
  // add/reduce is the CARD's direction: a buy on a short card is a reduce.
  return { side: f.opens ? 'add' : 'reduce', qty: f.qty, price: f.price, date: f.date, fromStatement: true, covers: true,
    fills: p.fills.map(x => ({ id: x.id, side: x.side, opens: x.opens, qty: x.qty, price: x.price, date: x.date, tradeId: x.tradeId, note: x.note })),
    adopt: p.adopt || [],
    text: p.fills.length === 1 ? `record it: ${verb(f)} ${f.qty}${f.kind === 'trade' ? ` at ${cents(f.price)}` : ' at 0'} on ${f.date}, from the statement`
      : `record all ${p.fills.length}, from the statement` };
}
// Only a plan that is nothing but expirations is written without asking (worthless, at 0).
export const autoApplies = (p) => p.state === 'plan' && p.fills.every(f => f.kind === 'expiration');
export function applyPlans(rows = [], plans = []) {
  const by = new Map(plans.filter(autoApplies).map(p => [p.rowId, p]));
  return rows.map(r => {
    const p = by.get(r.id);
    if (!p) return r;
    const have = new Set((r.fills || []).map(f => f.id));
    const add = p.fills.filter(f => !have.has(f.id)).map(f => ({ id: f.id, side: f.side, qty: f.qty, price: f.price, date: f.date, note: f.note }));
    return add.length ? { ...r, fills: [...(r.fills || []), ...add] } : r;
  });
}

// HOW FAR BACK TO READ. The day's statement holds one session; a card that drifted earlier needs the
// days since its last recorded fill. Asked for only when that reaches before the statement in hand,
// and never more than IBKR's 92 days for a date-ranged request.
export const LEDGER_LOOKBACK_DAYS = 92;
export function ledgerWindow(rows = [], flagged = new Set(), { skip = new Set(), statementFrom = null, asOf = null } = {}) {
  if (!asOf) return null;
  const starts = (rows || []).filter(r => isDerivativeRow(r) && flagged.has(r.id) && !skip.has(r.id) && heldOf(r, asOf).qty > 0)
    .map(r => fillsTo(r, asOf).map(f => f.date).filter(Boolean).sort().at(-1)).filter(Boolean).sort();
  if (!starts.length) return null;
  const floor = new Date(Date.parse(`${asOf}T00:00:00Z`) - LEDGER_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const from = starts[0] < floor ? floor : starts[0];
  if (from > asOf || (statementFrom && from >= statementFrom)) return null;
  return { from, to: asOf };
}
