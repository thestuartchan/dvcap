// lib/dayTradeCards.js — a console card whose round trip turned out to be a day trade.
//
// META and IGV, 21–22 Oct. Both were bought one afternoon and confirmed onto console cards, which was
// right at the time: nobody knew yet how long they would be held. Both were sold the next morning,
// inside 24 hours. Under the 24h rule (lib/journalInbox.js dayTradeOrders) the sales were day-trade
// orders, so the inbox kept them out of the console — and the cards were left open for ever. Two
// days later the options expired and the statement banner said "expired and gone from the
// statement, but its exercises/expirations section does not mention it — check IBKR before closing
// it by hand", which sent the reader to IBKR for an expiry that never happened. Closing them at 0
// would have booked the wrong P&L and counted the trade twice, once here and once in the journal.
//
// This reads the statement's own fills for the card's contracts. Where the order that opened the
// card and the orders that took it flat at IBKR all fall within 24 hours (one date where a fill has
// no time), and the closing orders are not on the card, the card is a journaled day trade: it is
// named as one, with the day it was closed and how long it was held, and offered for removal.
// Nothing here edits a row.
import { DAY_TRADE_MAX_HOURS } from './flexTrades.js';
import { derivePosition } from './positions.js';
import { isDerivativeRow, legsOf, underlyingOf } from './instruments.js';
import { sameRoot } from './journalInbox.js';

const legKey = (l) => `${l.right}|${+l.strike}|${l.expiry}`;
// The order ids a console fill stands for: an option fill carries its IBKR order id, a combo IBKR
// reported leg by leg carries `A+B`, and a statement-adopted fill carries its trade id.
const idsOfFill = (f) => f?.tradeId ? [String(f.tradeId), ...String(f.tradeId).split(':')[0].split('+')] : [];
const atMin = (e) => (e.minute != null ? e.minute : Date.parse(`${e.date}T00:00:00Z`) / 60000);

// rows: the console's rows. units: lib/journalInbox.js orderUnits(parseTrades(xml)).
// Returns [{ rowId, root, contract, opened, closed, heldMin }] — one per open card whose every leg
// was opened and taken flat at IBKR inside the day-trade window.
export function journaledDayTrades(rows = [], units = [], { maxHours = DAY_TRADE_MAX_HOURS } = {}) {
  const out = [];
  for (const r of rows || []) {
    if (!isDerivativeRow(r)) continue;
    const pos = r.derived || derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side });
    if (pos.status === 'closed' || !(pos.qty > 0)) continue;
    const legs = legsOf(r);
    if (!legs.length) continue;
    const root = underlyingOf(r);
    const onRow = new Set((r.fills || []).flatMap(idsOfFill));
    if (!onRow.size) continue;
    const onCard = (u) => onRow.has(String(u.orderId)) || (u.tradeIds || []).some(t => onRow.has(String(t)));

    // Every fill on each of the card's contracts, signed by direction, in time order.
    const byLeg = new Map(legs.map(l => [legKey(l), []]));
    for (const u of units || []) {
      if (!(u.type === 'OPT' || u.type === 'COMBO') || !sameRoot(u.root, root)) continue;
      for (const l of u.legs || []) {
        const list = byLeg.get(legKey(l));
        if (list) list.push({ orderId: u.orderId, card: onCard(u), signed: (l.side === 'SELL' ? -1 : 1) * Number(l.qty), minute: u.minute, date: u.date });
      }
    }

    // Per leg: the run from flat back to flat that holds the card's own opening order.
    let ok = true, opened = null, closed = null, heldMin = 0, timed = true;
    for (const list of byLeg.values()) {
      const sorted = list.sort((a, b) => atMin(a) - atMin(b) || String(a.orderId).localeCompare(String(b.orderId)));
      let run = 0, seg = [], hit = null;
      for (const e of sorted) {
        seg.push(e);
        run += e.signed;
        if (Math.abs(run) > 1e-9) continue;
        if (seg[0].card) { hit = seg; break; }
        seg = [];
      }
      // Still open at IBKR, or the card's order is not where a run starts: not this case.
      if (!hit || !hit.some(e => !e.card)) { ok = false; break; }
      const span = Math.max(...hit.map(atMin)) - Math.min(...hit.map(atMin));
      const legTimed = hit.every(e => e.minute != null);
      const short = legTimed ? span < maxHours * 60 : new Set(hit.map(e => e.date)).size === 1;
      if (!short) { ok = false; break; }
      timed = timed && legTimed;
      heldMin = Math.max(heldMin, span);
      const first = hit.map(e => e.date).sort()[0], last = hit.map(e => e.date).sort().at(-1);
      if (!opened || first < opened) opened = first;
      if (!closed || last > closed) closed = last;
    }
    if (!ok) continue;
    out.push({ rowId: r.id, root, contract: legs.map(l => `${l.expiry} ${l.right} ${+l.strike}`).join(' / '),
      opened, closed, heldMin: timed ? heldMin : null });
  }
  return out;
}

export const heldText = (min) => min == null ? 'the same day' : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`;

// The banner's line for one card.
export function dayTradeLine(d) {
  return `${d.contract}: closed at IBKR on ${d.closed}, ${heldText(d.heldMin)} after it was opened — a day trade under the 24h rule, so it belongs in the day-trading journal, not here. Remove this card; don't close it at 0`;
}
