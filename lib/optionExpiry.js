// lib/optionExpiry.js — reading IBKR's Option Exercises, Assignments and Expirations section.
//
// (2 Nov 2026) What to DO with these events is lib/optionLedger.js's job now, alongside every other
// way an option card drifts from IBKR. This module only reads the section.
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
