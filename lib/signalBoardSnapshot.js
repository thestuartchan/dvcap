// lib/signalBoardSnapshot.js — the Signal Board's daily row and its scoring, kept in Redis.
//
// Was scripts/signal-board-snapshot.mjs, run by a GitHub workflow that committed
// data/signal_board_history.json every weekday. Build step 6 moved it onto the scheduler (lib/cronRouter.js
// signal-board, 07:50 New York) and into a Redis document (lib/docStore.js `signalBoard`): same row,
// same scoring, no commit. The committed file is the seed until the first run.
//
// One run: take today's board (pre-open: the call for today's session), add its row (one per date),
// then re-score every row against the closes and session ranges that have since happened.
import { snapshotRow, scoreRows, scorecard } from './signalBoard.js';
import { yahooDailyOHLC } from './yahoo.js';

export const SNAPSHOT_MAX_ROWS = 800;
const BAR_SYMBOLS = ['QQQ', 'SPY', 'SOXX', '^VXN', '^VIX'];

// A session's high-low range as a multiple of the 1-day move the previous close's implied vol priced.
export function sessionRanges(px, iv) {
  const ivc = new Map(iv.map(b => [b.date, b.close]));
  const out = {};
  for (const b of px) {
    const prev = iv.filter(x => x.date < b.date).pop();
    const v = prev ? ivc.get(prev.date) : null;
    if (v && b.open > 0 && Number.isFinite(b.high) && Number.isFinite(b.low)) out[b.date] = (b.high - b.low) / b.open / (v / 100 / Math.sqrt(252));
  }
  return out;
}

// `payload` is lib/signalBoardFeed.js signalBoardPayload's answer; `bars(symbol)` returns daily OHLC.
export async function runSnapshot(store, { payload, bars = (s) => yahooDailyOHLC(s, '1y'), pause = 150, scoreOnly = false } = {}) {
  const rows0 = Array.isArray(store?.rows) ? store.rows : [];
  let rows = rows0, row = null, note = null;
  if (!scoreOnly) {
    if (!payload?.ok || !payload.board) return { ok: false, why: 'the board was not served', store };
    // IN SESSION: NO ROW, BUT NOT A FAILURE. A snapshot mid-session would read a partial bar; the
    // scoring below still runs, which is time-insensitive.
    if (payload.trade_day?.phase === 'in session') note = 'the US session is open, so no row from this run; scoring only';
    else {
      row = snapshotRow(payload.board, payload.trade_day, payload.today);
      rows = [...rows.filter(x => x.date !== row.date), row].sort((a, b) => a.date.localeCompare(b.date)).slice(-SNAPSHOT_MAX_ROWS);
    }
  }
  const got = {};
  for (const s of BAR_SYMBOLS) {
    got[s] = await Promise.resolve().then(() => bars(s)).catch(() => []);
    if (pause) await new Promise(r => setTimeout(r, pause));
  }
  const closes = Object.fromEntries(['QQQ', 'SOXX'].map(s => [s, Object.fromEntries((got[s] || []).map(b => [b.date, b.close]))]));
  const sessions = { QQQ: sessionRanges(got.QQQ || [], got['^VXN'] || []), SPY: sessionRanges(got.SPY || [], got['^VIX'] || []) };
  rows = scoreRows(rows, { closes, sessions });
  const sc = scorecard(rows);
  return {
    ok: true, store: { ...(store || {}), rows }, note,
    summary: { row: row ? { date: row.date, target: row.target, lean: row.lean } : null, rows: rows.length, scored: sc.scored_days },
  };
}
