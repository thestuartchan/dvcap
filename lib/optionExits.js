// lib/optionExits.js — an option card closed at IBKR whose exit never reached the console.
//
// MSFT, 31 Oct 2026. A strangle stayed open on the console after IBKR had taken it flat, and the
// banner said "in the console, not at IBKR" every morning. The sync records share and futures
// trades from the statement, but option trades are out of the planner's scope (lib/flexTrades.js:
// an option card's symbol is its underlying, and the statement's trades would land on the wrong
// row), so only two cases ever closed an option card by themselves: an expiry IBKR booked
// (lib/optionExpiry.js) and a round trip inside 24 hours (lib/dayTradeCards.js). A card held for
// days and closed before expiry was neither, so it waited for someone to type the exit — and once
// its expiry passed, the banner sent the reader to IBKR for an expiration that never happened.
//
// This reads the statement's own option orders for the card's contracts. Where every leg of an open
// card is gone from the statement, and the orders after the card's last fill take each leg flat in
// exactly the card's size, in the closing direction, those orders ARE the exit: one fill at the
// combo's net price, dated the last of them, carrying IBKR's order ids. It is OFFERED — the banner's
// "Record it" opens the fill form with it filled in. Nothing here edits a row, and anything that
// does not add up exactly (a part close, a leg rolled, a contract on two cards) is left as it was.
import { derivePosition } from './positions.js';
import { isDerivativeRow, legsOf, underlyingOf } from './instruments.js';
import { sameRoot } from './journalInbox.js';
import { roundQuote } from './price.js';

const legKey = (l) => `${l.right}|${+l.strike}|${l.expiry}`;
const idsOfFill = (f) => f?.tradeId ? [String(f.tradeId), ...String(f.tradeId).split(':')[0].split('+')] : [];
const atMin = (e) => (e.minute != null ? e.minute : Date.parse(`${e.date}T00:00:00Z`) / 60000);
const EPS = 1e-9;

// rows: the console's rows. units: lib/journalInbox.js orderUnits(parseTrades(xml)).
// missing: the reconciliation's 'option-missing-at-broker' findings (lib/flex.js optionFindings).
// Returns [{ rowId, root, contract, closed, fill: { side, qty, price, date, tradeId, orders } }].
export function statementExits(rows = [], units = [], missing = [], { skip = new Set() } = {}) {
  const gone = new Set((missing || []).map(m => `${String(m.root).toUpperCase()}|${m.c?.type === 'put' ? 'P' : 'C'}|${+m.c?.strike}|${m.c?.expiry}`));
  // A contract on more than one open card cannot say which card it closed.
  const holders = new Map();
  for (const r of rows || []) {
    if (!isDerivativeRow(r)) continue;
    const pos = r.derived || derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side });
    if (pos.status === 'closed' || !(pos.qty > 0)) continue;
    for (const l of legsOf(r)) {
      const k = `${String(underlyingOf(r)).toUpperCase()}|${legKey(l)}`;
      holders.set(k, (holders.get(k) || 0) + 1);
    }
  }
  const out = [];
  for (const r of rows || []) {
    if (!isDerivativeRow(r) || skip.has(r.id)) continue;
    const pos = r.derived || derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side });
    if (pos.status === 'closed' || !(pos.qty > 0)) continue;
    const root = underlyingOf(r);
    const legs = legsOf(r);
    if (!legs.length) continue;
    const keys = legs.map(l => `${String(root).toUpperCase()}|${legKey(l)}`);
    // Every leg gone from the statement, and no leg shared with another open card.
    if (!keys.every(k => gone.has(k)) || keys.some(k => holders.get(k) > 1)) continue;

    const onRow = new Set((r.fills || []).flatMap(idsOfFill));
    const lastDate = (r.fills || []).map(f => f.date).filter(Boolean).sort().at(-1) || null;
    const rowSign = String(r.side || '').toLowerCase() === 'short' ? -1 : 1;
    let ok = true;
    const perLeg = [];
    for (const l of legs) {
      // The leg as held: +1 long, −1 short (a credit card's legs are written as the spread sold).
      const held = (String(l.side || 'long').toLowerCase() === 'short' ? -1 : 1) * rowSign;
      const need = pos.qty * (l.ratio || 1);
      const events = [];
      for (const u of units || []) {
        if (!(u.type === 'OPT' || u.type === 'COMBO') || !sameRoot(u.root, root)) continue;
        if (lastDate && u.date && u.date < lastDate) continue;
        const own = onRow.has(String(u.orderId)) || (u.tradeIds || []).some(t => onRow.has(String(t)));
        if (own) continue;
        for (const x of u.legs || []) {
          if (legKey(x) !== legKey(l)) continue;
          events.push({ orderId: String(u.orderId), signed: (x.side === 'SELL' ? -1 : 1) * Number(x.qty), qty: Number(x.qty), price: Number(x.price), date: u.date, minute: u.minute });
        }
      }
      events.sort((a, b) => atMin(a) - atMin(b) || a.orderId.localeCompare(b.orderId));
      // The run that takes the leg from the card's size to flat: closing direction only, exactly.
      let left = need, used = [];
      for (const e of events) {
        if (Math.sign(e.signed) === Math.sign(held)) { ok = false; break; }   // added to before flat: not a clean exit
        if (e.qty > left + EPS) { ok = false; break; }                       // closed more than held: a reversal
        used.push(e); left -= e.qty;
        if (left < EPS) break;
      }
      if (!ok || left > EPS || !used.every(e => Number.isFinite(e.price))) { ok = false; break; }
      const avg = used.reduce((a, e) => a + e.qty * e.price, 0) / need;
      perLeg.push({ leg: l, held, avg, used });
    }
    if (!ok) continue;
    // Per unit of the card: what selling the position brought in (+) or buying it back cost (−).
    const net = perLeg.reduce((a, p) => a + p.held * (p.leg.ratio || 1) * p.avg, 0) * rowSign;
    // Orders in the time they filled, so the id is the same whichever leg the card lists first.
    const orders = [...new Set(perLeg.flatMap(p => p.used).sort((a, b) => atMin(a) - atMin(b) || a.orderId.localeCompare(b.orderId)).map(e => e.orderId))];
    const date = perLeg.flatMap(p => p.used.map(e => e.date)).filter(Boolean).sort().at(-1) || null;
    const side = rowSign > 0 ? 'sell' : 'buy';
    out.push({ rowId: r.id, root, contract: legs.map(l => `${l.expiry} ${l.right} ${+l.strike}`).join(' / '), closed: date,
      fill: { side, qty: pos.qty, price: roundQuote(Math.abs(net)), date, tradeId: orders.join('+').slice(0, 24), orders } });
  }
  return out;
}

// The banner's line, and the fix the "Record it" button opens the fill form with.
export function exitLine(x) {
  return `${x.contract}: closed at IBKR on ${x.closed} (${x.fill.orders.length === 1 ? 'order' : 'orders'} ${x.fill.orders.join(', ')}) — the exit never reached the console`;
}
export function exitFix(x) {
  const f = x.fill;
  return { side: 'reduce', qty: f.qty, price: f.price, date: f.date, fromStatement: true, covers: true,
    fills: [{ side: f.side, qty: f.qty, price: f.price, date: f.date, tradeId: f.tradeId }],
    text: `record the exit: ${f.side === 'sell' ? 'sold' : 'bought back'} ${f.qty} at ${f.price} on ${f.date}, from the statement — commission included` };
}
