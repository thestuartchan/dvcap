// lib/noiseBandFeed.js — the noise-band paper trial's daily run (lib/noiseBand.js): read each settled
// session's QQQ 1-minute bars from Unusual Whales, decide, store.
//
// UW data is licensed for Stu's personal use: the ledger is read only behind the dashboard session or
// the scheduler's key (lib/routes/atr.js ?noiseband=1), never on a public route or in the repo.
//
// A missed run heals itself: every weekday after `lastDate` up to the last settled session is replayed
// in order (at most MAX_PER_RUN a run). A weekday UW has no bars for is a holiday and is passed over;
// a session that should be there but UW has not served yet stops the run, so the next run replays it.
// The first run also reads the RULES.lookback sessions before the start date to seed sigma and the vol.
import { RULES, newLedger, step, summary, dayArray } from './noiseBand.js';
import { uwGet, uwConfigured } from './uw.js';
import { fetchSqueezeGex, gexPercentile } from './squeeze.js';
import { cushionBand, bandLean } from './trendTells.js';
import { kvGetJson, kvSetJson, kvSetNxEx, kvDel, kvConfigured } from './kv.js';
import { lastSettledSession } from './ratios.js';

export const NOISEBAND_KEY = 'dvcap:noiseband:paper:v1';
const LOCK_KEY = 'dvcap:noiseband:lock:v1';
const MAX_PER_RUN = 12;
const shift = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekday = (iso) => { const g = new Date(`${iso}T12:00:00Z`).getUTCDay(); return g >= 1 && g <= 5; };

const rowsOf = (ans) => (Array.isArray(ans) ? ans : Array.isArray(ans?.data) ? ans.data : []);
async function barsFor(date, get) { return rowsOf(await get(`/api/stock/${RULES.ticker}/ohlc/1m`, { query: { date, limit: 2500 } })); }

// The regime at the prior close: SqueezeMetrics GEX percentile → cushion band → QQQ's lean.
export function regimeFor(date, gexRows) {
  const i = gexRows.findIndex(([d]) => d >= date);
  const prev = i > 0 ? gexRows[i - 1] : gexRows.at(-1);
  if (!prev) return null;
  const b = cushionBand(gexPercentile(gexRows, prev[0]), prev[1]);
  return b ? { band: b.label, zone: bandLean(b, RULES.ticker) } : null;
}

export async function runNoiseBand({ now = Date.now(), get = uwGet, gex = fetchSqueezeGex, kv = { get: kvGetJson, set: kvSetJson, lock: kvSetNxEx, del: kvDel, configured: kvConfigured } } = {}) {
  if (!kv.configured()) return { ok: false, reason: 'Redis not configured' };
  if (!uwConfigured()) return { ok: false, reason: 'UW_API_KEY unset' };
  if (!(await kv.lock(LOCK_KEY, '1', 300))) return { ok: false, reason: 'a run is already in progress' };
  try {
    const L = (await kv.get(NOISEBAND_KEY)) || newLedger();
    const settled = lastSettledSession(now);
    if (settled < L.startDate) return { ok: true, note: `starts ${L.startDate}`, summary: summary(L) };
    // Seed: the full sessions before the start date, oldest first.
    if (!L.lastDate && L.moves.length < RULES.lookback) {
      const seed = [];
      for (let d = shift(L.startDate, -1), tries = 0; seed.length < RULES.lookback && tries < 45; d = shift(d, -1), tries++) {
        if (!weekday(d)) continue;
        const a = dayArray(await barsFor(d, get));
        if (a) seed.unshift([d, a]);
      }
      if (seed.length < RULES.lookback) return { ok: false, reason: `only ${seed.length} of ${RULES.lookback} seed sessions loaded` };
      for (const [d, a] of seed) step(L, d, a);
      L.lastDate = null;
    }
    const sq = await gex().catch(() => ({ ok: false, rows: [] }));
    const done = [];
    let d = L.lastDate ? shift(L.lastDate, 1) : L.startDate;
    for (; d <= settled && done.length < MAX_PER_RUN; d = shift(d, 1)) {
      if (!weekday(d)) continue;
      const rows = await barsFor(d, get);
      const reg = rows.filter(r => r?.market_time === 'r');
      if (!reg.length) {
        // No bars at all: a holiday — unless it is the last settled session, which UW may not have
        // served yet. Then stop; the next run replays it.
        if (d === settled) break;
        continue;
      }
      step(L, d, dayArray(rows), sq.ok ? regimeFor(d, sq.rows) : null);
      done.push(d);
    }
    if (done.length) await kv.set(NOISEBAND_KEY, L);
    return { ok: true, replayed: done, summary: summary(L), at: new Date(now).toISOString() };
  } finally {
    await kv.del(LOCK_KEY).catch(() => {});
  }
}

export async function readNoiseBand({ kv = { get: kvGetJson, configured: kvConfigured } } = {}) {
  if (!kv.configured()) return { ok: false, reason: 'Redis not configured' };
  const L = (await kv.get(NOISEBAND_KEY)) || newLedger();
  return { ok: true, rules: RULES, summary: summary(L), days: L.days.slice(-120) };
}
