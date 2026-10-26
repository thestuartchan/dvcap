// lib/mls.js — "Momentum Leaders Snapback", run as a PAPER portfolio (Stu, 27 Oct 2026).
//
// The rules, as backtested on the point-in-time S&P 500 2008–2026 (scratch replication, 27 Oct):
//   universe   S&P 500 members, above their 200-day SMA, top 20% by 6-1 month momentum
//              (close 21 sessions ago ÷ close 126 sessions ago − 1, ranked among the day's members)
//   buy        RSI(2) < 15 and IBS (close − low) ÷ (high − low) < 0.25 on the close; filled at the
//              NEXT open; at most 2 new a day, ranked by momentum; at most 10 positions
//   sell       first close above the prior session's high, or the 20th session held; filled at the
//              next open
//   size       15% of equity per position, so at most 1.5× gross — margin only when 7+ are open
//   breadth    no new buys while half or fewer of the members are above their 200-day: in the
//              backtest it took the worst drawdown from −31% to −22% at the same return (15% slots)
//   pause      no new buys while equity is more than 25% below its peak; exits still run
//   costs      10 bp a side on every fill; cash earns, and borrowing pays, the rates below
// The backtest's realistic version (next-open fills, 10 bp, margin interest) made 17.2% a year with
// a −22% worst drawdown against SPY's 11.2% and −52%. This file is the paper trial of that version:
// it records what the rules would have done at the real opening prints, so the live fills can be
// compared with the model before any money goes in.
//
// Pure: the bars come in, the next ledger goes out. api/atr.js ?mls=1 fetches and stores.

export const MLS = Object.freeze({
  slots: 10, slotWeight: 0.15, newPerDay: 2, maxHold: 20,
  rsiMax: 15, ibsMax: 0.25, momTop: 0.8, sma: 200, momFar: 126, momNear: 21,
  breadthMin: 0.5, pauseDrawdown: 0.25, costBps: 10,
  cashRate: 0.035, marginRate: 0.055,     // a year — IBKR-like: cash below the bill rate, margin above it
  capital: 50000,
});

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// Per-bar indicators for one symbol. bars: [{date, open, high, low, close}], oldest first.
export function indicators(bars = []) {
  const n = bars.length, c = bars.map(b => b.close);
  const sma = new Array(n).fill(null), mom = new Array(n).fill(null), rsi = new Array(n).fill(null), ibs = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += c[i];
    if (i >= MLS.sma) sum -= c[i - MLS.sma];
    if (i >= MLS.sma - 1) sma[i] = sum / MLS.sma;
    if (i >= MLS.momFar) mom[i] = c[i - MLS.momNear] / c[i - MLS.momFar] - 1;
    const rng = bars[i].high - bars[i].low;
    ibs[i] = rng > 0 ? (c[i] - bars[i].low) / rng : 0.5;
  }
  // RSI(2), Wilder smoothing (an exponential average with alpha ½), seeded on the first change.
  let up = null, dn = null;
  for (let i = 1; i < n; i++) {
    const d = c[i] - c[i - 1], u = Math.max(d, 0), v = Math.max(-d, 0);
    up = up == null ? u : 0.5 * u + 0.5 * up;
    dn = dn == null ? v : 0.5 * v + 0.5 * dn;
    rsi[i] = dn === 0 ? (up === 0 ? 50 : 100) : 100 - 100 / (1 + up / dn);
  }
  return { sma, mom, rsi, ibs };
}

// The day's read across the universe: breadth, the momentum ranks, and the buy candidates.
// series: { SYM: { bars, ind } }; date: the session to read.
export function scan(series = {}, date) {
  const rows = [];
  for (const [sym, s] of Object.entries(series)) {
    const i = s.index?.get(date);
    if (i == null) continue;
    const b = s.bars[i];
    rows.push({ sym, close: b.close, sma: s.ind.sma[i], mom: s.ind.mom[i], rsi: s.ind.rsi[i], ibs: s.ind.ibs[i] });
  }
  const withSma = rows.filter(r => isNum(r.sma));
  const breadth = withSma.length ? withSma.filter(r => r.close > r.sma).length / withSma.length : null;
  // Percentile rank of momentum, ties averaged — the backtest's pandas rank(pct=True).
  const ranked = rows.filter(r => isNum(r.mom)).sort((a, b) => a.mom - b.mom);
  for (let k = 0; k < ranked.length;) {
    let j = k; while (j + 1 < ranked.length && ranked[j + 1].mom === ranked[k].mom) j++;
    const pct = ((k + j) / 2 + 1) / ranked.length;
    for (let m = k; m <= j; m++) ranked[m].pct = pct;
    k = j + 1;
  }
  const candidates = rows.filter(r => isNum(r.sma) && r.close > r.sma && isNum(r.pct) && r.pct >= MLS.momTop
    && isNum(r.rsi) && r.rsi < MLS.rsiMax && isNum(r.ibs) && r.ibs < MLS.ibsMax)
    .sort((a, b) => b.mom - a.mom);
  return { breadth, members: rows.length, candidates };
}

export const newLedger = (capital = MLS.capital, start = null, spy = null) => ({
  v: 1, capital, start, cash: capital, peak: capital, positions: {}, pending: { buy: [], sell: [] },
  lastDate: null, spyStart: spy, history: [], trades: [], days: 0,
});

const markOf = (pos, px) => Object.entries(pos).reduce((a, [s, p]) => a + p.shares * (isNum(px[s]) ? px[s] : p.last), 0);

// ONE SESSION. ledger: the previous ledger; day: { date, open: {SYM: px}, close: {...}, high: {...},
// prevHigh: {...}, splits: {SYM: ratio}, dividends: {SYM: perShare}, spy }, scanned: scan() of `date`;
// sessions: sessions since the previous run (1 normally). Returns { ledger, actions }.
export function step(prev, day, scanned, { sessions = 1, cashRate = MLS.cashRate, marginRate = MLS.marginRate } = {}) {
  const L = structuredClone(prev);
  const actions = { filled: [], exits: [], queued: [], skipped: [] };
  if (L.lastDate && day.date <= L.lastDate) return { ledger: prev, actions: { ...actions, note: 'already run for this session' } };
  const cost = MLS.costBps / 1e4;
  if (!L.start) { L.start = day.date; L.spyStart = day.spy ?? null; }

  // Overnight: interest on cash, or on what is borrowed; splits and dividends on what is held.
  const r = L.cash >= 0 ? cashRate : marginRate;
  L.cash += L.cash * r * sessions / 252;
  for (const [s, p] of Object.entries(L.positions)) {
    const k = day.splits?.[s];
    if (isNum(k) && k > 0 && k !== 1) { p.shares *= k; p.entry /= k; p.last /= k; }
    const dv = day.dividends?.[s];
    if (isNum(dv) && dv > 0) L.cash += p.shares * dv;
  }

  // The queued orders fill at today's open — sells first, so their slots and cash are free.
  for (const s of L.pending.sell) {
    const p = L.positions[s], px = day.open?.[s];
    if (!p) continue;
    if (!isNum(px)) { actions.skipped.push({ sym: s, why: 'no opening print — sell carried to the next session' }); L.positions[s].carry = true; continue; }
    const proceeds = p.shares * px * (1 - cost);
    L.cash += proceeds;
    L.trades.push({ sym: s, entryDate: p.entryDate, entry: p.entry, exitDate: day.date, exit: px, ret: +(proceeds / p.cost - 1).toFixed(5), pnl: +(proceeds - p.cost).toFixed(2), why: p.why || null });
    actions.filled.push({ sym: s, side: 'sell', px });
    delete L.positions[s];
  }
  const carried = Object.entries(L.positions).filter(([, p]) => p.carry).map(([s]) => s);
  const eqOpen = L.cash + Object.entries(L.positions).reduce((a, [s, p]) => a + p.shares * (isNum(day.open?.[s]) ? day.open[s] : p.last), 0);
  for (const s of L.pending.buy) {
    const px = day.open?.[s];
    if (Object.keys(L.positions).length >= MLS.slots || L.positions[s]) continue;
    if (!isNum(px) || px <= 0) { actions.skipped.push({ sym: s, why: 'no opening print — buy dropped' }); continue; }
    const shares = Math.floor((eqOpen * MLS.slotWeight) / px);
    if (shares < 1) { actions.skipped.push({ sym: s, why: `one share (${px.toFixed(2)}) is more than a slot` }); continue; }
    const c = shares * px * (1 + cost);
    L.cash -= c;
    L.positions[s] = { shares, entry: px, entryDate: day.date, held: 0, cost: +c.toFixed(2), last: px };
    actions.filled.push({ sym: s, side: 'buy', px, shares });
  }
  L.pending = { buy: [], sell: carried };

  // Today's close: mark, count the session, and decide tomorrow's exits.
  for (const [s, p] of Object.entries(L.positions)) {
    if (isNum(day.close?.[s])) p.last = day.close[s];
    if (p.entryDate !== day.date) p.held += sessions;
    if (p.carry) continue;
    const up = isNum(day.close?.[s]) && isNum(day.prevHigh?.[s]) && day.close[s] > day.prevHigh[s];
    if (p.entryDate !== day.date && (up || p.held >= MLS.maxHold)) {
      p.why = up ? 'closed above the prior high' : `${MLS.maxHold} sessions held`;
      L.pending.sell.push(s);
      actions.exits.push({ sym: s, why: p.why });
    }
  }
  for (const p of Object.values(L.positions)) delete p.carry;
  const equity = L.cash + markOf(L.positions, day.close || {});
  L.peak = Math.max(L.peak, equity);

  // Tomorrow's buys — unless breadth is too thin or the account is in its drawdown pause.
  const dd = equity / L.peak - 1;
  const free = MLS.slots - Object.keys(L.positions).length + L.pending.sell.length;
  let gate = null;
  if (!(isNum(scanned.breadth) && scanned.breadth > MLS.breadthMin)) gate = `breadth ${isNum(scanned.breadth) ? Math.round(scanned.breadth * 100) + '%' : 'unknown'} — new buys wait until more than half the members are above their 200-day`;
  else if (dd < -MLS.pauseDrawdown) gate = `drawdown ${(dd * 100).toFixed(1)}% — new buys paused until it is back within ${MLS.pauseDrawdown * 100}% of the peak`;
  if (!gate && free > 0) {
    // A name still held — even one queued to sell at tomorrow's open — is not bought again.
    const pick = scanned.candidates.filter(c => !L.positions[c.sym]).slice(0, Math.min(MLS.newPerDay, free));
    for (const c of pick) { L.pending.buy.push(c.sym); actions.queued.push({ sym: c.sym, rsi: +c.rsi.toFixed(1), ibs: +c.ibs.toFixed(2), mom: +(c.mom * 100).toFixed(1) }); }
  }
  const gross = markOf(L.positions, day.close || {});
  L.history.push({ date: day.date, equity: +equity.toFixed(2), gross: +(gross / equity).toFixed(3), breadth: isNum(scanned.breadth) ? +scanned.breadth.toFixed(3) : null,
    candidates: scanned.candidates.length, spy: day.spy ?? null, gate: gate ? true : false });
  L.lastDate = day.date;
  L.days += 1;
  return { ledger: L, actions: { ...actions, gate, equity: +equity.toFixed(2), breadth: scanned.breadth, candidates: scanned.candidates.length } };
}

// The figures the console shows: return against SPY since the start, drawdown, exposure, trades.
export function summary(L) {
  if (!L || !L.history?.length) return { ok: true, started: false };
  const h = L.history, last = h[h.length - 1];
  const spyRet = isNum(L.spyStart) && isNum(last.spy) ? last.spy / L.spyStart - 1 : null;
  let peak = -Infinity, maxDd = 0;
  for (const x of h) { peak = Math.max(peak, x.equity); maxDd = Math.min(maxDd, x.equity / peak - 1); }
  const t = L.trades;
  return { ok: true, started: true, start: L.start, lastDate: L.lastDate, days: L.days, capital: L.capital,
    equity: last.equity, ret: last.equity / L.capital - 1, spyRet, maxDd, gross: last.gross, breadth: last.breadth,
    open: Object.keys(L.positions).length, trades: t.length, win: t.length ? t.filter(x => x.ret > 0).length / t.length : null };
}
