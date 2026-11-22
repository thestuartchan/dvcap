// lib/noiseBand.js — the noise-band intraday momentum PAPER TRIAL on QQQ (Stu, 22 Nov 2026): the exact
// rule of scripts/noise-band-backtest.py, one decision per session, scored after the close. Pure: bars
// in, a ledger row out. lib/noiseBandFeed.js fetches and stores.
//
// THE RULE (the backtest's best robust version — chosen on 2022–24, held on 2025–26)
//   Opening range   high / low of the 09:30–09:44 bars
//   Noise band      sigma[m] = mean over the previous 20 full sessions of |close(m) ÷ that day's 09:30
//                   open − 1|; band = today's open × (1 ± 1.25 × sigma[m])
//   Checks          the bars closing 10:00, 10:10 … 14:00
//   Entry           short when close < OR low × (1 − 0.05%), < lower band and < VWAP; long the mirror;
//                   the first check that fires, one trade a session
//   Fill            the next bar's open, 2bp worse; exit at the 15:44 bar's close (15:45); 0.4bp
//                   round-trip cost
//   Size            1% daily-vol target ÷ the trailing 14-session realised vol, capped at 4×
// Half days (fewer than 300 regular-session bars) are not traded and do not enter sigma or the vol,
// as in the backtest.
//
// WHAT THE TRIAL CAN TELL (pre-registered 22 Nov 2026, from the backtest: QQQ Jul 2022 – Nov 2026,
// 706 trades, mean +0.09% a trade with these fills, sd 0.93%, fired on 66% of sessions):
//   after 40+ trades the paper mean should sit above the backtest's lower 90% band (−0.15% at 40,
//   −0.10% at 60). Even if the edge is real, a 40–60-trade paper mean is below zero about 1 time in 4,
//   so the trial catches a broken rule or a regime that breaks it — it cannot prove the edge.
export const RULES = Object.freeze({
  ticker: 'QQQ', lookback: 20, mult: 1.25, room: 0.0005, orBars: 15, checks: Object.freeze(Array.from({ length: 25 }, (_, i) => 29 + i * 10)),
  exitIdx: 374, slip: 0.0002, cost: 0.00004, volTarget: 0.01, volLookback: 14, maxLev: 4, minBars: 300, startDate: '2026-11-23',
});
export const EXPECT = Object.freeze({ mean: 0.0009, sd: 0.0093, hit: 0.564, fireRate: 0.66, n: 706, minTrades: 40,
  source: 'scripts/noise-band-backtest.py, QQQ 11 Jul 2022 – 20 Nov 2026, next-bar fill + 2bp, 0.4bp cost' });
export const N_MIN = 390;

const nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// Minute of the session (0 = 09:30 ET) for an ISO time.
export function sessionMinute(iso) {
  const p = Object.fromEntries(nyFmt.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute) - 570;
}

// UW 1-minute rows → a 390 × [o, h, l, c, v] array (gaps forward- then back-filled), or null for a half
// day / no session.
export function dayArray(rows = []) {
  const reg = rows.filter(r => r && r.market_time === 'r');
  if (reg.length < RULES.minBars) return null;
  const a = new Array(N_MIN).fill(null);
  for (const r of reg) {
    const m = sessionMinute(r.start_time);
    if (m >= 0 && m < N_MIN) a[m] = [+r.open, +r.high, +r.low, +r.close, +(r.volume || 0)];
  }
  let last = null;
  for (let i = 0; i < N_MIN; i++) { if (a[i]) last = a[i]; else if (last) a[i] = last; }
  const first = a.find(Boolean);
  if (!first) return null;
  for (let i = 0; i < N_MIN && !a[i]; i++) a[i] = first;
  return a;
}

export const movesOf = (a) => a.map(b => Math.abs(b[3] / a[0][0] - 1));
export function sigmaFrom(prevMoves) {
  if (prevMoves.length < RULES.lookback) return null;
  const use = prevMoves.slice(-RULES.lookback);
  return Array.from({ length: N_MIN }, (_, m) => use.reduce((s, mv) => s + mv[m], 0) / use.length);
}
export function vwap(a) {
  let pv = 0, vv = 0;
  return a.map(([, h, l, c, v]) => { const w = v > 0 ? v : 1; pv += (h + l + c) / 3 * w; vv += w; return pv / vv; });
}
// Sample standard deviation of the last `n` close-to-close returns (pandas' default, as the backtest).
export function realisedVol(closes, n = RULES.volLookback) {
  if (closes.length < n + 1) return null;
  const c = closes.slice(-(n + 1)), r = c.slice(1).map((x, i) => x / c[i] - 1);
  const mu = r.reduce((s, x) => s + x, 0) / r.length;
  return Math.sqrt(r.reduce((s, x) => s + (x - mu) ** 2, 0) / (r.length - 1));
}

// One session's decision. → { status: 'trade', d, m, entry, exit, ret, lev } | { status: 'none' }
export function decide(a, sigma, vol) {
  const o = a[0][0];
  let orh = -Infinity, orl = Infinity;
  for (let i = 0; i < RULES.orBars; i++) { orh = Math.max(orh, a[i][1]); orl = Math.min(orl, a[i][2]); }
  const vw = vwap(a);
  for (const m of RULES.checks) {
    const c = a[m][3], up = o * (1 + RULES.mult * sigma[m]), lo = o * (1 - RULES.mult * sigma[m]);
    const d = (c < orl * (1 - RULES.room) && c < lo && c < vw[m]) ? -1 : (c > orh * (1 + RULES.room) && c > up && c > vw[m]) ? 1 : 0;
    if (!d) continue;
    const entry = a[m + 1][0] * (1 + d * RULES.slip), exit = a[RULES.exitIdx][3];
    const ret = d * (exit / entry - 1) - RULES.cost;
    const lev = vol ? Math.min(RULES.maxLev, RULES.volTarget / vol) : 1;
    return { status: 'trade', d, m, entry: +entry.toFixed(4), exit: +exit.toFixed(4), ret: +ret.toFixed(6), lev: +lev.toFixed(3) };
  }
  return { status: 'none' };
}

export const newLedger = () => ({ v: 1, rules: RULES, startDate: RULES.startDate, lastDate: null, equity: 100000, moves: [], closes: [], days: [] });
export const checkTime = (m) => { const t = 570 + m + 1; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

// Apply one session to the ledger (mutates and returns it). `regime` = { zone, band } or null.
export function step(L, date, a, regime = null) {
  if (!a) { L.days.push({ date, status: 'skipped', why: 'half day or no full session' }); L.lastDate = date; return L; }
  const sigma = sigmaFrom(L.moves), vol = realisedVol(L.closes.map(([, c]) => c));
  if (date >= L.startDate && sigma) {
    const r = decide(a, sigma, vol);
    const row = { date, ...r, vol: vol == null ? null : +vol.toFixed(5), zone: regime?.zone ?? null, band: regime?.band ?? null };
    if (r.status === 'trade') { L.equity = +(L.equity * (1 + r.lev * r.ret)).toFixed(2); row.at = checkTime(r.m); row.equity = L.equity; }
    L.days.push(row);
    L.lastDate = date;
  }
  L.moves = [...L.moves, movesOf(a).map(x => +x.toFixed(6))].slice(-RULES.lookback);
  L.closes = [...L.closes, [date, a[N_MIN - 1][3]]].slice(-(RULES.volLookback + 1));
  return L;
}

export function summary(L) {
  const days = (L?.days || []).filter(d => d.status !== 'skipped');
  const tr = days.filter(d => d.status === 'trade');
  const r = tr.map(d => d.ret);
  const n = r.length, mean = n ? r.reduce((s, x) => s + x, 0) / n : null;
  const sd = n > 1 ? Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : null;
  let peak = 100000, dd = 0;
  for (const d of tr) { peak = Math.max(peak, d.equity); dd = Math.min(dd, d.equity / peak - 1); }
  const band = n ? EXPECT.mean - 1.645 * EXPECT.sd / Math.sqrt(n) : null;
  const verdict = n < EXPECT.minTrades ? { state: 'collecting', text: `${n} of ${EXPECT.minTrades} trades — too few to judge` }
    : mean >= band ? { state: 'consistent', text: `mean ${(mean * 100).toFixed(2)}% is inside the backtest's range (above ${(band * 100).toFixed(2)}%)` }
    : { state: 'off', text: `mean ${(mean * 100).toFixed(2)}% is below the backtest's lower 90% band (${(band * 100).toFixed(2)}%) — the rule is not behaving as tested` };
  return {
    started: days.length > 0, sessions: days.length, trades: n, fireRate: days.length ? n / days.length : null,
    hit: n ? r.filter(x => x > 0).length / n : null, mean, median: n ? [...r].sort((a, b) => a - b)[Math.floor((n - 1) / 2)] : null, sd,
    shorts: tr.filter(d => d.d < 0).length, longs: tr.filter(d => d.d > 0).length,
    equity: L?.equity ?? 100000, totalReturn: (L?.equity ?? 100000) / 100000 - 1, maxDrawdown: dd,
    lowerBand: band, verdict, expect: EXPECT, lastDate: L?.lastDate ?? null, startDate: L?.startDate ?? RULES.startDate,
  };
}
