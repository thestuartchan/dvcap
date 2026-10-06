#!/usr/bin/env node
// scripts/day-journal-weeks.mjs — the day-trading record's weekly documents, from the IBKR feed.
//
//   node scripts/day-journal-weeks.mjs <trades.json> <positions.json> <out.json> [--since=YYYY-MM-DD] [--existing=<weeks.json>]
//
// <trades.json>    the IBKR connector's get_account_trades result ({ trades: [...] } or the list)
// <positions.json> its get_account_positions result, taken at the same time
// <out.json>       receives [{ week, trades, pnlUsd, count, source }] for each week this run touched
//
// The weekly routine writes each as weeks/<week> in the private day-trading artifact's database.
// Its output holds the user's trades: never print it, never commit it, never post it anywhere public.
// Only counts are printed here.
import fs from 'node:fs';
import { roundTripsFromIbkr, mergeWeeks, FEED_FROM } from '../lib/dayTradeJournal.js';

const args = process.argv.slice(2);
const flag = (name) => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const [tradesPath, positionsPath, outPath] = args.filter(a => !a.startsWith('--'));
if (!tradesPath || !positionsPath || !outPath) {
  console.error('usage: day-journal-weeks.mjs <trades.json> <positions.json> <out.json> [--since=YYYY-MM-DD] [--existing=<weeks.json>]');
  process.exit(2);
}
const list = (path, key) => { const j = JSON.parse(fs.readFileSync(path, 'utf8')); return Array.isArray(j) ? j : j[key] || []; };
const since = [flag('since'), FEED_FROM].filter(Boolean).sort().at(-1);   // never before the feed began
const rows = roundTripsFromIbkr({ trades: list(tradesPath, 'trades'), positions: list(positionsPath, 'positions'), since });
// Merge into what the database already holds (--existing: the weeks collection as read back), by
// trade id: a run adds and corrects, and never shortens a week its window only partly covers.
const existing = flag('existing') ? list(flag('existing'), 'weeks') : [];
const weeks = mergeWeeks(existing, rows).filter(w => w.trades.some(t => rows.some(r => r.id === t.id)));
fs.writeFileSync(outPath, JSON.stringify(weeks));
console.log(`${rows.length} round trips; week(s) to write: ${weeks.map(w => `${w.week} (${w.count})`).join(', ') || 'none'}`);
