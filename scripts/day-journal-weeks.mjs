#!/usr/bin/env node
// scripts/day-journal-weeks.mjs — the day-trading record's weekly documents, from the IBKR feed.
//
//   node scripts/day-journal-weeks.mjs <trades.json> <positions.json> <out.json> [--since=YYYY-MM-DD] [--existing=<weeks.json>] [--flex=<orders.json>] [--copy=<ids.json>]
//
// <trades.json>    the IBKR connector's get_account_trades result ({ trades: [...] } or the list)
// <positions.json> its get_account_positions result, taken at the same time
// <out.json>       receives [{ week, trades, pnlUsd, count, source }] for each week this run touched
// --flex           the statement's option orders for the same window (api/flex-sync.js ?journal=1),
//                  so option round trips are cut per contract. Without it they are grouped by
//                  underlying, and the run says so.
//
// The weekly routine writes each as weeks/<week> in the private day-trading artifact's database.
// Its output holds the user's trades: never print it, never commit it, never post it anywhere public.
// Only counts are printed here.
import fs from 'node:fs';
import { roundTripsFromIbkr, mergeWeeks, settleReviews, FEED_FROM, REVIEW_REASON, REVIEW_DAYS } from '../lib/dayTradeJournal.js';

const args = process.argv.slice(2);
const flag = (name) => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const [tradesPath, positionsPath, outPath] = args.filter(a => !a.startsWith('--'));
if (!tradesPath || !positionsPath || !outPath) {
  console.error('usage: day-journal-weeks.mjs <trades.json> <positions.json> <out.json> [--since=YYYY-MM-DD] [--existing=<weeks.json>] [--flex=<orders.json>] [--copy=<ids.json>]');
  process.exit(2);
}
const list = (path, key) => { const j = JSON.parse(fs.readFileSync(path, 'utf8')); return Array.isArray(j) ? j : j[key] || []; };
const since = [flag('since'), FEED_FROM].filter(Boolean).sort().at(-1);   // never before the feed began
const contracts = flag('flex') ? list(flag('flex'), 'orders') : null;
const report = {};
const rows = roundTripsFromIbkr({ trades: list(tradesPath, 'trades'), positions: list(positionsPath, 'positions'), since, contracts, report });
// Merge into what the database already holds (--existing: the weeks collection as read back), by
// trade id: a run adds and corrects, and never shortens a week its window only partly covers.
// --copy: the ids Stu ticked as copy trades (the marks collection). Held-back overnight options
// (lib/dayTradeJournal.js REVIEW_REASON) that he ticked stay as copy trades; ones left unticked past
// REVIEW_DAYS leave. A week that changes that way is written too.
const copyIds = new Set(flag('copy') ? JSON.parse(fs.readFileSync(flag('copy'), 'utf8')) : []);
const settled = settleReviews(flag('existing') ? list(flag('existing'), 'weeks') : [], { copyIds });
const existing = settled.weeks;
const weeks = mergeWeeks(existing, rows).filter(w => settled.changed.includes(w.week) || w.trades.some(t => rows.some(r => r.id === t.id)));
fs.writeFileSync(outPath, JSON.stringify(weeks));
console.log(`held back for a tick (overnight single-leg options): ${rows.filter(r => r.reason === REVIEW_REASON).length} new · ${weeks.flatMap(w => w.trades).filter(t => t.reason === REVIEW_REASON).length} waiting in the weeks written · ${settled.kept} ticked and kept · ${settled.expired} unticked past ${REVIEW_DAYS} days, removed`);
console.log(`${rows.length} round trips; week(s) to write: ${weeks.map(w => `${w.week} (${w.count})`).join(', ') || 'none'}`);
console.log(contracts
  ? `options split by contract: ${report.resolvedFills} fill(s) placed; ${report.unresolvedRoots.length} underlying(s) left grouped (a fill with no contract)`
  : 'options grouped by underlying: no --flex orders given');
