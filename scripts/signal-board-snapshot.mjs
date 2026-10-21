#!/usr/bin/env node
// scripts/signal-board-snapshot.mjs — the Signal Board's daily record, and its score.
//
// Run by .github/workflows/signal-board.yml before the US open (12:50 UTC, weekdays): reads the board the
// deployment serves (/api/indicators?board=1 — public, market data only, so no secret is needed), stores
// one row per date in data/signal_board_history.json (lib/signalBoard.js snapshotRow), then re-scores every
// row from Yahoo daily bars: QQQ and SOXX returns 1/3/5 sessions from each row's as-of close, and the
// realised R (high − low ÷ open ÷ prior-close VXN or VIX implied) of the session each trade-day call was for.
// The deployment reads the file back for the scorecard on its next build — the same commit-back store
// the Korea fetch uses (data/korea_kofia.json).
//
// Before the open, so the snapshot never reads a partial session's bar.
//   node scripts/signal-board-snapshot.mjs            fetch, append, score, write
//   node scripts/signal-board-snapshot.mjs --score    re-score only (no fetch of the board)
// The log prints counts and states only — public market statistics.
import { readFileSync, writeFileSync } from 'node:fs';
import { snapshotRow, scoreRows, scorecard } from '../lib/signalBoard.js';
import { yahooDailyOHLC } from '../lib/yahoo.js';

const PATH = 'data/signal_board_history.json';
const BOARD_URL = process.env.SIGNAL_BOARD_URL || 'https://dvcap.vercel.app/api/indicators?board=1';
const MAX_ROWS = 800;

const store = JSON.parse(readFileSync(PATH, 'utf8'));
store.rows ||= [];

if (!process.argv.includes('--score')) {
  const r = await fetch(BOARD_URL, { headers: { 'User-Agent': 'dvcap-signal-board' }, signal: AbortSignal.timeout(90000) });
  const p = await r.json();
  if (!p?.ok || !p.board) { console.error(`board not served: HTTP ${r.status}, ok=${p?.ok}`); process.exit(1); }
  // IN SESSION: NO ROW, BUT NOT A FAILURE (20 Oct). GitHub ran the 12:50 UTC schedule at 17:33 UTC,
  // mid-session; a snapshot then would read a partial bar, so none is taken. That is the guard doing
  // its job, so it is a warning, not a red run — and the scoring below still runs, which is
  // time-insensitive. The on-time trigger is the Vercel pre-read cron (lib/preOpenDispatch.js).
  if (p.trade_day?.phase === 'in session') {
    console.log('::warning::the US session is open — a snapshot now would read a partial bar, so no row today from this run; scoring only');
  } else {
    const row = snapshotRow(p.board, p.trade_day, p.today);
    store.rows = [...store.rows.filter(x => x.date !== row.date), row].sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_ROWS);
    console.log(`snapshot ${row.date}: as of ${row.as_of}, call for ${row.target}, lean ${row.lean}, clusters ${JSON.stringify(row.clusters)}`);
  }
}

// ── SCORE ── closes and each session's R, from a year of daily bars.
const bars = {};
for (const s of ['QQQ', 'SPY', 'SOXX', '^VXN', '^VIX']) {
  bars[s] = await yahooDailyOHLC(s, '1y').catch(() => []);
  await new Promise(res => setTimeout(res, 150));
}
const closes = Object.fromEntries(['QQQ', 'SOXX'].map(s => [s, Object.fromEntries(bars[s].map(b => [b.date, b.close]))]));
const sessionR = (px, iv) => {
  const ivc = new Map(iv.map(b => [b.date, b.close]));
  const out = {};
  for (const b of px) {
    const prev = iv.filter(x => x.date < b.date).pop();
    const v = prev ? ivc.get(prev.date) : null;
    if (v && b.open > 0 && Number.isFinite(b.high) && Number.isFinite(b.low)) out[b.date] = (b.high - b.low) / b.open / (v / 100 / Math.sqrt(252));
  }
  return out;
};
const sessions = { QQQ: sessionR(bars.QQQ, bars['^VXN']), SPY: sessionR(bars.SPY, bars['^VIX']) };
store.rows = scoreRows(store.rows, { closes, sessions });
writeFileSync(PATH, JSON.stringify(store, null, 2) + '\n');
const sc = scorecard(store.rows);
console.log(`rows ${store.rows.length}, scored ${sc.scored_days}; trade-day last 20: QQQ ${JSON.stringify(sc.calls.QQQ.last20)} SPY ${JSON.stringify(sc.calls.SPY.last20)}`);
