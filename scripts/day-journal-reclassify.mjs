// scripts/day-journal-reclassify.mjs — re-sort the day-trading record's stored weeks under the
// current rule (lib/dayTradeJournal.js journalReason, 14 Nov 2026: a decision made on the day, for
// that day). Each stored round trip gets its exchange session dates and its reason again; one that
// no longer qualifies is dropped, and the weeks are rebuilt (a Hong Kong morning can move a week).
//
//   node scripts/day-journal-reclassify.mjs <weeks.json> <out.json> [--keep=<ids.json>]
//
// --keep  a JSON array of trade ids kept whatever the rule says: the trades Stu ticked as copy
//         trades (the marks collection). Stu, 14 Nov: keep them "as they are still reflective of the
//         true nature of cash trade flow", separated by their mark as before. Their reason says so.
//
// <weeks.json> the weeks collection as read back (an array of { week, trades, ... } documents)
// <out.json>   receives { weeks: [...every week after], emptied: [weeks left with no trades] }
// Its output holds the user's trades: never print it, never commit it, never post it anywhere public.
// Only counts and totals are printed here.
import { readFileSync, writeFileSync } from 'node:fs';
import { journalReason, withSessionDates, mergeWeeks, COPY_REASON } from '../lib/dayTradeJournal.js';

const args = process.argv.slice(2);
const [inPath, outPath] = args.filter(a => !a.startsWith('--'));
const keepArg = args.find(a => a.startsWith('--keep='));
const keep = new Set(keepArg ? JSON.parse(readFileSync(keepArg.slice(7), 'utf8')) : []);
if (!inPath || !outPath) { console.error('usage: day-journal-reclassify.mjs <weeks.json> <out.json>'); process.exit(2); }
const before = JSON.parse(readFileSync(inPath, 'utf8'));
const kept = [], dropped = [];
for (const doc of before) for (const t of doc.trades || []) {
  const r = withSessionDates(t);
  r.reason = journalReason(r) || (keep.has(t.id) ? COPY_REASON : null);
  (r.reason ? kept : dropped).push(r);
}
const weeks = mergeWeeks([], kept);
const emptied = before.map(w => w.week).filter(w => !weeks.some(x => x.week === w));
writeFileSync(outPath, JSON.stringify({ weeks, emptied }));
const sum = (a) => Math.round(a.reduce((x, t) => x + (t.pnlUsd || 0), 0));
const all = before.flatMap(w => w.trades || []);
console.log(`round trips: ${all.length} → ${kept.length} kept, ${dropped.length} dropped`);
console.log(`P&L: $${sum(all)} → $${sum(kept)} (dropped trades $${sum(dropped)})`);
const by = {}; for (const t of kept) by[t.reason] = (by[t.reason] || 0) + 1;
console.log('kept by reason:', Object.entries(by).map(([k, v]) => `${k} ${v}`).join(' · '));
console.log(`weeks: ${before.length} → ${weeks.length}${emptied.length ? ` (emptied: ${emptied.join(', ')})` : ''}`);
const moved = kept.filter(t => { const old = all.find(o => o.id === t.id); return old && (old.date !== t.date || old.closeDate !== t.closeDate); });
console.log(`dates corrected to the exchange's session: ${moved.length}`);
