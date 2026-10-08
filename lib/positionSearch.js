// lib/positionSearch.js — find a position in the book from one box, across Watching, Open,
// Closed and the Archive. Crypto is left out: it has its own tab, read from the venue and the
// chain rather than from rows, and a coin typed into a row (BTC-USD, HL:SOL) belongs to that book.
//
// What a query matches, best first: the ticker or its underlying exactly, then their start, then
// the company name, the tag, an option's contract label, and last the thesis. Every word of the
// query has to land somewhere on the row, so "nvda put" finds the NVDA puts and not every put.
import { isCryptoAsset } from './crypto.js';
import { underlyingOf, legLabel } from './instruments.js';
import { companyName } from './companyNames.js';

// The order the results are read in: what is live first, then what is waiting, then the record.
export const SEARCH_STATES = Object.freeze(['OPEN', 'WATCHING', 'CLOSED', 'ARCHIVED']);
export const SEARCH_LABEL = Object.freeze({ OPEN: 'Open', WATCHING: 'Watching', CLOSED: 'Closed in the last 24h', ARCHIVED: 'Archive' });

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// How well one row answers the query: 0 = not at all, higher = better.
export function matchScore(row, query) {
  const words = norm(query).split(' ').filter(Boolean);
  if (!words.length || !row) return 0;
  const sym = norm(row.symbol), root = norm(underlyingOf(row));
  const name = norm(companyName(underlyingOf(row)) || companyName(row.symbol));
  const tag = norm(row.tag), legs = norm(legLabel(row.legs || []));
  const thesis = norm(row.thesis);
  let score = 0;
  for (const w of words) {
    const s = w === sym || w === root ? 100
      : sym.startsWith(w) || root.startsWith(w) ? 60
      : name.split(/[^a-z0-9]+/).some(x => x.startsWith(w)) ? 40
      : sym.includes(w) || name.includes(w) ? 30
      : tag.startsWith(w) ? 25
      : legs.includes(w) ? 20
      : thesis.includes(w) ? 10
      : 0;
    if (!s) return 0;
    score += s;
  }
  return score;
}

// THE RESULTS, grouped by state in SEARCH_STATES order and best match first within each.
//   tabs     byState() output: { WATCHING, OPEN, CLOSED, ARCHIVED }
//   returns  { groups: [{ state, label, rows }], total, cryptoSkipped }
// A row rolled into a later contract is not listed — the archive hides it too, since its P&L sits
// in the row that replaced it. cryptoSkipped counts crypto rows that would have matched, so the
// screen can say where they are instead of looking empty.
export function searchBook(tabs = {}, query = '') {
  const groups = [];
  let total = 0, cryptoSkipped = 0;
  if (!norm(query)) return { groups, total, cryptoSkipped };
  for (const state of SEARCH_STATES) {
    const hits = [];
    for (const r of tabs[state] || []) {
      if (r?.derived?.rolledInto) continue;
      const s = matchScore(r, query);
      if (!s) continue;
      if (isCryptoAsset(r.symbol)) { cryptoSkipped++; continue; }
      hits.push([s, r]);
    }
    if (!hits.length) continue;
    hits.sort((a, b) => b[0] - a[0]);
    groups.push({ state, label: SEARCH_LABEL[state], rows: hits.map(([, r]) => r) });
    total += hits.length;
  }
  return { groups, total, cryptoSkipped };
}
