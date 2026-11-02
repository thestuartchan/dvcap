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
import { fitId } from './rowIds.js';

const EPS = 1e-9;
const keyOf = (root, right, strike, expiry) => `${productRoot(root)}|${expiry}|${right}|${+strike}`;
const legKey = (root, l) => keyOf(root, l.right, l.strike, l.expiry);
const idsOfFill = (f) => f?.tradeId ? [String(f.tradeId), ...String(f.tradeId).split(':')[0].split('+')] : [];
const atMin = (e) => (e.minute != null ? e.minute : Date.parse(`${e.date}T00:00:00Z`) / 60000 + (e.eae ? 1439 : 0));
// FILL IDS FIT THE STORE'S 16 CHARACTERS (api/manual-entry.js): longer ones were cut on save, and two
// fills from one order could end up with one id. The tail of the order id, then a short suffix.
const fid = (orders, suffix = '') => { const sfx = String(suffix); const core = [].concat(orders).join('').replace(/[^A-Za-z0-9]/g, ''); return `o${core.slice(-(15 - sfx.length))}${sfx}`; };
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
        price: Number(x.price), date: u.date, minute: u.minute, kind: 'trade', legsInOrder: (u.legs || []).length, unit: u });
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
export function optionPlans(rows = [], { positions = new Map(), costs = new Map(), units = [], eae = [], asOf = null, flagged = null, skip = new Set(), eaePresent = true } = {}) {
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
    // What IBKR holds against what the card holds, per leg, in contracts.
    const legDelta = h.legs.map(l => (positions.get(l.key) || 0) - l.held);
    if (legDelta.every(d => Math.abs(d) < EPS)) continue;   // agrees
    // From the card's last recorded fill. Its own fills — by IBKR id, or a hand-typed fill matched to
    // the order it stands for — are not events.
    const fills = fillsTo(r, asOf);
    const from = fills.map(f => f.date).filter(Boolean).sort().at(-1) || null;
    const onRow = new Set(fills.flatMap(idsOfFill));
    const handTyped = fills.filter(f => !f.tradeId);
    const adopt = [];
    const perLeg = [];
    let why = null;
    h.legs.forEach((l, i) => {
      if (why) return;
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
      const run = suffixFor(ev, legDelta[i], l.held);
      if (!run) { why = `${l.leg.expiry} ${l.leg.right} ${+l.leg.strike}: IBKR's orders since the card's last fill do not add up to the difference`; return; }
      if (!run.every(e => Number.isFinite(e.price))) { why = 'an order has no price'; return; }
      perLeg.push({ l, run });
    });
    // An expired contract with no exercises/expirations section to read: say which section to add.
    if (why && !eaePresent && h.legs.some(l => asOf && l.leg.expiry && l.leg.expiry <= asOf)) {
      why = 'it has expired, and the Flex query has no Option Exercises, Assignments and Expirations section to say how — add that section to the saved query and the next run explains it';
    }
    if (why) { out.push({ ...base, state: 'unexplained', why }); continue; }
    // Every leg moved by the same number of card units: fills on this card. Otherwise the legs were
    // traded on their own — a LEG-OUT — and the card splits into one card per leg.
    const deltas = legDelta.map((d, i) => d / h.legs[i].sign);
    const even = deltas.every(d => Math.abs(d - deltas[0]) < EPS);
    if (!even) {
      const sp = splitPlan(r, h, perLeg, { units, costs, asOf, ids: (rows || []).map(x => x.id) });
      out.push(sp.why ? { ...base, state: 'unexplained', why: sp.why } : { ...base, state: 'plan', ...sp, adopt, kinds: ['split', ...new Set(sp.newRows.flatMap(n => n.fills.filter(f => !f.transfer).map(f => f.kind)))] });
      continue;
    }
    const k = deltas[0];
    const plan = toFills(r, h, perLeg, k);
    if (!plan.fills) { out.push({ ...base, state: 'unexplained', why: plan.why }); continue; }
    // A ROLL: the card closed at IBKR by an order that also opened another contract on the same
    // underlying (or, the same day, an order that opened the same shape), now held and on no card.
    const flat = h.legs.every(l => Math.abs(positions.get(l.key) || 0) < EPS);
    const roll = flat ? rollOf(r, h, plan.fills, { units, positions, live, holders, ids: (rows || []).map(x => x.id) }) : null;
    out.push({ ...base, state: 'plan', fills: plan.fills, adopt, ...(roll ? { roll: roll.roll, newRows: roll.newRows || [], link: roll.link || null } : {}),
      kinds: [...new Set([...plan.fills.map(f => f.kind), ...(roll ? ['roll'] : [])])] });
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
  const fillId = (orders, i) => fid(orders, String(i));
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

// The statement's cost basis per contract (IBKR's own per-leg average, positive), for dividing a
// card's cost between its legs when no order priced them all on one day.
export function costsByContract(lines = [], contractOf) {
  const m = new Map();
  for (const p of lines || []) {
    const c = contractOf(p);
    const v = Number(p.costBasisPrice);
    if (!c || !Number.isFinite(v)) continue;
    m.set(keyOf(c.root, c.type === 'put' ? 'P' : 'C', c.strike, c.expiry), Math.abs(v));
  }
  return m;
}

const legSgn = (side) => (String(side || 'long').toLowerCase() === 'short' ? -1 : 1);
const uniqueId = (taken, base, suffix) => { let id = fitId(base, suffix); for (let n = 2; taken.has(id); n++) id = fitId(base, `${suffix}${n}`); taken.add(id); return id; };
const kindNote = (kind, orderId) => (kind === 'expiration' ? 'expired worthless — IBKR booked the expiry'
  : kind === 'assignment' ? 'assigned at expiry — the option closes at 0; the shares arrive as their own trade'
  : kind === 'exercise' ? 'exercised — the option closes at 0; the shares arrive as their own trade'
  : `IBKR order ${orderId}, from the statement — commission included`);

// ── A LEG-OUT ──
// The legs were traded on their own, so the card cannot carry them: it is split the way a leg-out
// confirmed from the journal is (lib/journalInbox.js legOutApply). The card hands its units over at
// its average cost (a transfer, no profit or loss) to one card per leg; the cost is divided in
// proportion to a price for every leg on one day — the last IBKR order that traded all of them (the
// entry, usually), else IBKR's own cost basis per leg — and each leg card then records what IBKR did
// to its leg. The leg cards name the card they came from, so the closed card posts one trade.
function splitPlan(r, h, perLeg, { units, costs, asOf, ids }) {
  const pos = derivePosition(fillsTo(r, asOf), { multiplier: r.multiplier, side: r.side });
  const U = h.qty, B = Number(pos.avgCost);
  const date = perLeg.flatMap(p => p.run.map(e => e.date)).filter(Boolean).sort()[0] || asOf;
  const keys = h.legs.map(l => l.key);
  const priceOn = (u, k) => (u.legs || []).find(x => keyOf(u.root, x.right, x.strike, x.expiry) === k)?.price;
  const cover = (units || []).filter(u => (u.type === 'COMBO' || u.type === 'OPT') && (!u.date || u.date <= date)
    && keys.every(k => Number.isFinite(Number(priceOn(u, k)))))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.minute ?? 0) - (b.minute ?? 0)).at(-1);
  let ref = null, refFrom = null;
  if (cover) { ref = keys.map(k => Number(priceOn(cover, k))); refFrom = `IBKR order ${cover.orderId} on ${cover.date}`; }
  else if (keys.every(k => Number.isFinite(costs?.get?.(k)))) { ref = keys.map(k => costs.get(k)); refFrom = 'IBKR\'s cost basis per leg'; }
  else return { why: 'its legs were traded on their own at IBKR, and no order priced every leg on one day to divide its cost — split it by hand' };
  const net = h.legs.reduce((a, l, i) => a + legSgn(l.leg.side) * (l.leg.ratio || 1) * ref[i], 0);
  if (!(net > 0) || !(B > 0) || !(U > 0)) return { why: 'its cost cannot be divided by its legs\' prices — split it by hand' };
  const scale = B / net;
  const taken = new Set(ids || []);
  const rowSign = h.dir;
  const { id: _id, legs: _l, fills: _f, levels: _lv, derived: _d, instrument: _in, rolledFrom: _rf, ...rest } = r;
  const newRows = h.legs.map((l, i) => {
    const heldC = l.held, cdir = heldC > 0 ? 1 : -1;
    const basis = +(ref[i] * scale).toFixed(6);
    const label = `${+l.leg.strike}${l.leg.right}`;
    const id = uniqueId(taken, r.id, label);
    const split = `split from ${r.id} on ${date} when its legs were traded on their own at IBKR — ${U} unit${U === 1 ? '' : 's'} at its average ${roundQuote(B)}, divided by ${refFrom}`;
    const tIn = { id: `tx${i}-${String(date).replace(/-/g, '')}`, side: cdir > 0 ? 'buy' : 'sell', qty: Math.abs(heldC), price: basis, date, transfer: true,
      kind: 'transfer', note: `transfer in: ${split} — ${label} at ${roundQuote(basis)}, no profit or loss` };
    const own = perLeg[i].run.map((e, j) => ({ id: fid(e.orderId, `${i}${j}`), side: e.signed > 0 ? 'buy' : 'sell',
      opens: Math.sign(e.signed) === cdir, qty: roundQuote(e.qty), price: roundQuote(Math.abs(e.price)), date: e.date,
      tradeId: e.kind === 'trade' ? e.orderId : null, orders: [e.orderId], kind: e.kind, note: kindNote(e.kind, e.orderId) }));
    return { ...rest, id, splitFrom: r.id, instrument: 'option', underlying: h.root,
      legs: [{ right: l.leg.right, strike: l.leg.strike, expiry: l.leg.expiry, side: 'long', ratio: 1 }],
      side: cdir > 0 ? 'long' : 'short', levels: [], tags: [...new Set([...(r.tags || []), 'split'])],
      thesis: `${String(r.thesis || '').trim()}\n— ${date}: ${split}.`.trim().slice(0, 600), fills: [tIn, ...own] };
  });
  const out = { id: `txo${String(date).replace(/-/g, '')}`, side: rowSign > 0 ? 'sell' : 'buy', opens: false, qty: U, price: roundQuote(B), date, transfer: true,
    kind: 'transfer', orders: [], tradeId: null, note: `transfer out: ${U} unit${U === 1 ? '' : 's'} moved to ${newRows.map(n => n.id).join(' and ')} at the average cost — no profit or loss` };
  return { kind: 'split', fills: [out], newRows, refFrom };
}

// ── A ROLL ──
// The card closed at IBKR by an order that also opened other contracts on the same underlying — one
// combo order, IBKR's own record that the two belong together — or, failing that, on the same day by
// a single order opening the same shape (as many legs, the same rights). The new contracts must be
// held at IBKR now, in exactly that size, and on no other card. Then the new position is the card
// rolled: a new card that names this one (rolledFrom), so its P&L carries forward (lib/positions.js
// applyRolls). Already on a card the statement added: that card is linked instead of a new one made.
function rollOf(r, h, planFills, { units, positions, live, holders, ids }) {
  const last = planFills.at(-1);
  if (!last || last.kind !== 'trade') return null;
  const mine = new Set(h.legs.map(l => l.key));
  const fresh = (u) => {
    const extra = (u.legs || []).filter(x => productRoot(u.root) === productRoot(h.root) && !mine.has(keyOf(u.root, x.right, x.strike, x.expiry)));
    if (!extra.length) return null;
    const ok = extra.every(x => {
      const k = keyOf(u.root, x.right, x.strike, x.expiry);
      const held = positions.get(k) || 0, signed = (x.side === 'SELL' ? -1 : 1) * Math.abs(Number(x.qty));
      return Math.abs(held - signed) < EPS && (holders.get(k) || []).filter(id => id !== r.id).length <= 1;
    });
    return ok ? extra : null;
  };
  const byId = new Map((units || []).map(u => [String(u.orderId), u]));
  let order = null, extra = null;
  for (const o of last.orders || []) { const u = byId.get(String(o)); const x = u && fresh(u); if (x) { order = u; extra = x; break; } }
  if (!extra) {
    const rights = h.legs.map(l => l.leg.right).sort().join('');
    const cands = (units || []).filter(u => u.date === last.date && !(last.orders || []).includes(String(u.orderId)) && (u.type === 'OPT' || u.type === 'COMBO'))
      .map(u => ({ u, x: fresh(u) })).filter(c => c.x && c.x.length === h.legs.length && c.x.map(x => x.right).sort().join('') === rights);
    if (cands.length !== 1) return null;
    order = cands[0].u; extra = cands[0].x;
  }
  const keys = extra.map(x => keyOf(order.root, x.right, x.strike, x.expiry));
  const label = extra.map(x => `${+x.strike}${x.right}`).join('/');
  // Already a card for exactly these contracts (the statement added it): link it.
  const others = [...new Set(keys.flatMap(k => (holders.get(k) || []).filter(id => id !== r.id)))];
  const existing = others.length === 1 ? live.find(c => c.id === others[0] && !c.rolledFrom && legsOf(c).length === keys.length
    && legsOf(c).every(l => keys.includes(legKey(underlyingOf(c), l)))) : null;
  if (others.length && !existing) return null;   // the new contracts sit on a card that is not just them
  if (existing) return { roll: { into: label, orders: [String(order.orderId)], date: order.date, linked: existing.id }, link: { rowId: existing.id, rolledFrom: r.id } };
  const q = extra.map(x => Math.abs(Number(x.qty)));
  const gcd2 = (a, b) => (b ? gcd2(b, a % b) : a);
  const n = q.reduce((a, b) => gcd2(a, b));
  const single = extra.length === 1;
  const netDebit = extra.reduce((a, x) => a + (x.side === 'SELL' ? -1 : 1) * (Math.abs(Number(x.qty)) / n) * Number(x.price), 0);
  // A single contract points the way it was traded; a combo keeps the card's direction, and a short
  // card's legs are written as the spread bought.
  const side = single ? (extra[0].side === 'SELL' ? 'short' : 'long') : h.dir > 0 ? 'long' : 'short';
  const price = single ? Number(extra[0].price) : (side === 'long' ? netDebit : -netDebit);
  if (!(price >= 0) || !(n > 0)) return null;
  const legs = extra.map(x => ({ right: x.right, strike: x.strike, expiry: x.expiry, ratio: single ? 1 : Math.abs(Number(x.qty)) / n,
    side: single ? 'long' : ((x.side === 'SELL' ? -1 : 1) * (side === 'long' ? 1 : -1) > 0 ? 'long' : 'short') }));
  const taken = new Set(ids || []);
  const id = uniqueId(taken, r.id, `roll${String(order.date || '').replace(/-/g, '').slice(4)}`);
  const { id: _id, legs: _l, fills: _f, levels: _lv, derived: _d, splitFrom: _sf, hardDate: _hd, hardDateSet: _hs, ...rest } = r;
  const newRow = { ...rest, id, underlying: h.root, instrument: single ? 'option' : 'spread', legs, side, rolledFrom: r.id, levels: [],
    tags: [...new Set([...(r.tags || []).filter(t => t !== 'new'), 'rolled'])],
    fills: [{ id: fid(order.orderId, 'r'), side: side === 'long' ? 'buy' : 'sell', opens: true, qty: n,
      price: roundQuote(price), date: order.date, tradeId: String(order.orderId), kind: 'trade', note: `rolled from ${r.id} — IBKR order ${order.orderId}, commission included` }] };
  return { roll: { into: label, orders: [String(order.orderId)], date: order.date }, newRows: [newRow] };
}

// The contracts a roll plan opens: kept out of the statement's automatic adds, so the new position
// is not made twice (once by the roll, once as a card of its own).
export function rolledContracts(plans = []) {
  const out = new Set();
  for (const p of plans || []) for (const n of p.newRows || []) if (n.rolledFrom) for (const l of legsOf(n)) out.add(legKey(underlyingOf(n), l));
  return out;
}
export const coveredBy = (set) => (row) => legsOf(row).length > 0 && legsOf(row).every(l => set.has(legKey(underlyingOf(row), l)));

// ── WHAT THE BANNER SAYS ──
const verb = (f) => (f.kind === 'expiration' ? 'expired worthless' : f.kind === 'assignment' ? 'assigned' : f.kind === 'exercise' ? 'exercised'
  : f.side === 'buy' ? 'bought' : 'sold');
export function planLine(p) {
  if (p.state !== 'plan') return `${p.contract}: IBKR differs and it could not be explained (${p.why}) — check IBKR and record it by hand`;
  if (p.kind === 'split') {
    const per = p.newRows.map(n => {
      const own = n.fills.filter(f => !f.transfer);
      const lbl = `${+n.legs[0].strike}${n.legs[0].right}`;
      return own.length ? `${lbl} ${own.map(f => (f.kind === 'trade' ? `${verb(f)} ${f.qty} at ${cents(f.price)} on ${f.date}` : `${verb(f)} on ${f.date}`)).join(', ')}` : `${lbl} still held`;
    });
    return `${p.contract}: legged out at IBKR — ${per.join('; ')} — splits into one card per leg, cost divided by ${p.refFrom}`;
  }
  const parts = p.fills.map(f => (f.kind === 'trade' ? `${verb(f)} ${f.qty} at ${cents(f.price)} on ${f.date}` : `${verb(f)} on ${f.date}`));
  const shares = p.fills.some(f => f.kind === 'assignment' || f.kind === 'exercise') ? ' — the shares arrive as their own trade' : '';
  const roll = p.roll ? ` — rolled into ${p.roll.into}${p.roll.linked ? ' (its card is linked)' : ' (a new card, P&L carried)'}` : '';
  return `${p.contract}: at IBKR, ${parts.join('; ')}${shares}${roll} — not yet on the card`;
}
// What "Record it" carries: the fills, the hand-typed fills to stamp with IBKR's order id, and for a
// leg-out or a roll the cards it makes (or the card it links).
export function planFix(p) {
  const f = p.fills[0];
  const complex = p.fills.length > 1 || (p.newRows || []).length > 0 || !!p.link;
  // add/reduce is the CARD's direction: a buy on a short card is a reduce.
  return { side: f.opens ? 'add' : 'reduce', qty: f.qty, price: f.price, date: f.date, fromStatement: true, covers: true,
    fills: p.fills.map(x => ({ id: x.id, side: x.side, opens: x.opens, qty: x.qty, price: x.price, date: x.date, tradeId: x.tradeId, note: x.note, ...(x.transfer ? { transfer: true } : {}) })),
    adopt: p.adopt || [], newRows: p.newRows || [], link: p.link || null,
    text: p.kind === 'split' ? `record the split: ${p.newRows.length} leg cards, from the statement`
      : p.roll ? `record the roll: close this card${p.link ? ' and link the new one' : ' and open the new one'}, from the statement`
      : !complex ? `record it: ${verb(f)} ${f.qty}${f.kind === 'trade' ? ` at ${cents(f.price)}` : ' at 0'} on ${f.date}, from the statement`
      : `record all ${p.fills.length}, from the statement` };
}
// Only a plan that is nothing but expirations is written without asking (worthless, at 0).
export const autoApplies = (p) => p.state === 'plan' && !p.kind && !p.roll && p.fills.every(f => f.kind === 'expiration');
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

// ── ONE TRADE ON SEVERAL CARDS (2 Nov 2026) ──────────────────────────────────────
// MSFT's strangle reached the closed list three times — the strangle card and a card for each leg,
// all holding the same two contracts over the same days — so its loss was counted three times.
// Nothing linked them (a leg-out split names its parent, a roll names the card it replaced), so
// nothing could tell they were one trade. This finds option cards on one underlying that hold the
// same contract in the same direction over overlapping days, and are not linked by a split or a
// roll. It decides nothing: the banner names them and asks which card to keep.
export const SAME_TRADE_LOOKBACK_DAYS = 45;
const linkOf = (r) => r?.splitFrom || r?.rolledFrom || null;
export function sameTradeCards(rows = [], { asOf = null, lookbackDays = SAME_TRADE_LOOKBACK_DAYS } = {}) {
  const byId = new Map((rows || []).map(r => [r.id, r]));
  const chainRoot = (id) => { let cur = id; const seen = new Set([cur]); for (;;) { const p = linkOf(byId.get(cur)); if (!p || seen.has(p) || !byId.has(p)) return cur; seen.add(p); cur = p; } };
  const floor = asOf ? new Date(Date.parse(`${asOf}T00:00:00Z`) - lookbackDays * 86400000).toISOString().slice(0, 10) : null;
  const cards = [];
  for (const r of rows || []) {
    if (!isDerivativeRow(r)) continue;
    const d = derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side });
    if (d.status !== 'open' && d.status !== 'closed') continue;
    const end = d.status === 'closed' ? (d.lastDate || null) : '9999-12-31';
    if (!d.firstDate || !end || (floor && end < floor)) continue;
    const dir = String(r.side || '').toLowerCase() === 'short' ? -1 : 1;
    const root = underlyingOf(r);
    const keys = new Map(legsOf(r).map(l => [legKey(root, l), (String(l.side || 'long').toLowerCase() === 'short' ? -1 : 1) * dir]));
    cards.push({ r, root, first: d.firstDate, end, keys, chain: chainRoot(r.id), status: d.status });
  }
  const parent = new Map(cards.map(c => [c.r.id, c.r.id]));
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i], b = cards[j];
    if (productRoot(a.root) !== productRoot(b.root)) continue;
    if ((a.r.notSameTradeAs || []).includes(b.r.id) || (b.r.notSameTradeAs || []).includes(a.r.id)) continue;
    const shared = [...a.keys].some(([k, s]) => b.keys.get(k) === s);
    // Linked by a split or a roll, one card hands over to the next on the same day, so only a
    // STRICT overlap is a double count (a parent still holding after its legs were split off).
    // Unlinked, two cards opened the same day on the same contract are one trade as well.
    const linked = a.chain === b.chain;
    const overlap = (a.first < b.end && b.first < a.end) || (!linked && a.first === b.first);
    if (shared && overlap) parent.set(find(a.r.id), find(b.r.id));
  }
  const groups = new Map();
  for (const c of cards) { const g = find(c.r.id); groups.set(g, [...(groups.get(g) || []), c]); }
  return [...groups.values()].filter(g => g.length > 1).map(g => ({
    root: g[0].root,
    cards: g.map(c => ({ id: c.r.id, label: legsOf(c.r).map(l => `${+l.strike}${l.right}`).join('/'), status: c.status })),
  }));
}
export function sameTradeLine(g) {
  return `one trade on ${g.cards.length} cards — ${g.cards.map(c => `${c.label}${c.status === 'closed' ? ' (closed)' : ''}`).join(', ')} hold the same contracts over the same days, so it counts ${g.cards.length} times. Keep one`;
}

// ── A CARD WITH NO ENTRY (2 Nov 2026) ──
// The GOOGL condor: the statement built it long at a negative price (a credit), and the save — which
// refuses a negative price — dropped that entry, leaving a card with an exit and nothing it exited.
// Its P&L cannot be read, so it is named rather than posted: enter the entry from IBKR, or delete it.
const opensSide = (r) => (String(r.side || 'long').toLowerCase() === 'short' ? 'sell' : 'buy');
export function entrylessCards(rows = []) {
  return (rows || []).filter(r => isDerivativeRow(r) && (r.fills || []).length > 0 && !(r.fills || []).some(f => String(f.side).toLowerCase() === opensSide(r)))
    .map(r => ({ id: r.id, root: underlyingOf(r), label: legsOf(r).map(l => `${l.side === 'short' ? '−' : '+'}${+l.strike}${l.right}`).join(' ') }));
}
export const entrylessLine = (c) => `${c.label}: this card has no entry — only its exit (an entry at a negative price, a credit, was dropped when it was saved) — enter the entry from IBKR, or delete the card`;
