// lib/rowRepairs.js — the console's rows, made consistent the same way wherever they are read
// (the console on load, the IBKR sync, the Discord card), so all three see the same book.
//
//   uniqueRowIds   one card, one id (lib/rowIds.js)
//   creditCombos   a combo taken for a credit that was stored as a LONG card at a NEGATIVE price
//                  (lib/flex.js optionAdds before 2 Nov 2026 — the GOOGL condor's white dot): turned
//                  into what it is, a short card at the credit. Side, legs and every fill flip and
//                  every price changes sign, so each fill means exactly what it did: the entry
//                  "bought at −1.20" becomes "sold at 1.20", an expiry "sold at 0" becomes "bought at 0".
import { uniqueRowIds } from './rowIds.js';

const isCreditStoredLong = (r) => Array.isArray(r?.legs) && r.legs.length > 1
  && String(r.side || 'long').toLowerCase() === 'long'
  && (r.fills || []).length > 0 && Number(r.fills[0]?.price) < 0;

export function creditCombos(rows = []) {
  if (!Array.isArray(rows)) return { rows, fixed: [] };
  const fixed = [];
  const out = rows.map(r => {
    if (!isCreditStoredLong(r)) return r;
    fixed.push(r.id);
    return {
      ...r, side: 'short',
      legs: r.legs.map(l => ({ ...l, side: String(l.side || 'long').toLowerCase() === 'short' ? 'long' : 'short' })),
      fills: r.fills.map(f => ({ ...f, side: String(f.side).toLowerCase() === 'buy' ? 'sell' : 'buy', price: f.price == null ? f.price : -Number(f.price) })),
    };
  });
  return { rows: fixed.length ? out : rows, fixed };
}

// → { rows, renamed, fixed }. Rows that need nothing come back as the same array.
export function normalizeRows(rows = []) {
  const a = creditCombos(rows);
  const b = uniqueRowIds(a.rows);
  return { rows: b.rows, renamed: b.renamed, fixed: a.fixed };
}
