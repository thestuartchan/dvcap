// lib/optionExpiry.js — closing a console option that IBKR has booked as expired.
//
// An option held to expiry used to stay "open" in the console for ever. The statement simply stops
// listing it, and the reconciliation said "in the console, not at IBKR" without doing anything:
// the card showed "past expiry" with a P&L of $0, though the premium was gone.
//
// NOT EVERY EXPIRED OPTION IS WORTHLESS. One that finishes in the money is exercised or assigned
// into shares, and closing it at 0 would book the wrong P&L and lose the shares. So this does not
// infer anything from the date: it reads IBKR's own record, the Flex statement's "Option Exercises,
// Assignments and Expirations" section (<OptionEAE> rows, transactionType Expiration / Exercise /
// Assignment). Only an Expiration closes a row, at 0, on the date IBKR booked it. An exercise or an
// assignment is left for a person. Without that section in the saved Flex query nothing is closed,
// and the sync says which section to add.
import { elements } from './flex.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const isoDay = (v) => {
  const s = String(v || '').trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const contractKey = (c) => `${String(c.root).toUpperCase()}|${c.expiry}|${c.right}|${+c.strike}`;

// Whether the statement carries the section at all (an empty section is still the section).
export const eaeSectionPresent = (xml) => /<OptionEAE\b/.test(String(xml || ''));

// The section's rows, one per event. The section's own wrapper tag carries no transactionType and
// is skipped.
export function parseOptionEae(xml) {
  return elements(xml, 'OptionEAE').filter(r => r.transactionType).map(r => {
    const t = String(r.transactionType).toLowerCase();
    return {
      root: String(r.underlyingSymbol || r.symbol || '').trim().split(/\s+/)[0].toUpperCase(),
      right: /^[CP]$/i.test(String(r.putCall || '')) ? String(r.putCall).toUpperCase() : null,
      strike: num(r.strike), expiry: isoDay(r.expiry), date: isoDay(r.date || r.reportDate || r.expiry),
      type: /expir/.test(t) ? 'expiration' : /assign/.test(t) ? 'assignment' : /exerc/.test(t) ? 'exercise' : t,
      qty: num(r.quantity),
    };
  }).filter(e => e.root && e.right && e.strike != null && e.expiry);
}

// rows: the console's rows. missing: the reconciliation's 'option-missing-at-broker' findings (each
// with its contract and the row ids holding it). Returns the closing fills to append, by row, and
// what is left for a person.
export function expiryCloses(rows = [], missing = [], { eae = [], present = false, asOf = null } = {}) {
  const closes = [], waiting = [];
  const expired = missing.filter(m => m.c?.expiry && (!asOf || m.c.expiry <= asOf));
  if (!expired.length) return { closes, waiting };
  if (!present) {
    for (const m of expired) waiting.push({ kind: 'expiry-unrecorded', root: m.root, contract: m.contract, ids: m.ids,
      note: 'expired and gone from the statement, but the Flex query has no Option Exercises, Assignments and Expirations section to say whether it expired worthless or was exercised — add that section to the saved query and the next run closes it' });
    return { closes, waiting };
  }
  const byKey = new Map(eae.map(e => [contractKey(e), e]));
  const missingByKey = new Map(expired.map(m => [contractKey({ root: m.c.root, expiry: m.c.expiry, right: m.c.type === 'put' ? 'P' : 'C', strike: m.c.strike }), m]));
  const rowIds = [...new Set(expired.flatMap(m => m.ids || []))];
  for (const id of rowIds) {
    const r = rows.find(x => x.id === id);
    if (!r || r.derived?.status !== 'open') continue;
    const root = String(r.underlying || r.symbol || '').toUpperCase();
    const legs = (r.legs || []).map(l => ({ root, expiry: l.expiry, right: l.right, strike: +l.strike }));
    const keys = legs.map(contractKey);
    if (!keys.length || !keys.every(k => missingByKey.has(k))) continue;   // a leg still held: not this
    const events = keys.map(k => byKey.get(k));
    const label = keys.map(k => k.split('|').slice(1).join(' ')).join(' / ');
    if (events.some(e => !e)) {
      waiting.push({ kind: 'expiry-not-in-statement', root, id, contract: label,
        note: 'expired and gone from the statement, but its exercises/expirations section does not mention it — check IBKR before closing it by hand' });
      continue;
    }
    if (events.some(e => e.type !== 'expiration')) {
      waiting.push({ kind: 'option-exercised', root, id, contract: label, events: events.map(e => e.type),
        note: 'IBKR exercised or assigned it at expiry — that delivered shares, so it is not closed at 0; record the exercise by hand' });
      continue;
    }
    const qty = Number(r.derived?.qty);
    if (!(qty > 0)) continue;
    const date = events.map(e => e.date || e.expiry).sort().at(-1);
    const short = String(r.side || '').toLowerCase() === 'short';
    closes.push({ rowId: id, root, contract: label, fill: {
      id: `fx-exp-${label.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`,
      side: short ? 'buy' : 'sell', qty, price: 0, date,
      note: `expired worthless — IBKR booked the expiry on ${date} (Option Exercises, Assignments and Expirations)`,
    } });
  }
  return { closes, waiting };
}

// The closes written onto the rows. Append only, and never twice: a row that already carries the
// fill (same id) is left as it is.
export function applyExpiryCloses(rows = [], closes = []) {
  const by = new Map(closes.map(c => [c.rowId, c.fill]));
  return rows.map(r => {
    const f = by.get(r.id);
    if (!f || (r.fills || []).some(x => x.id === f.id)) return r;
    return { ...r, fills: [...(r.fills || []), f] };
  });
}
