// lib/interventionAuto.js — the yen intervention flag, set from price and confirmed from Japan's MoF.
//
// WHY THIS CAN BE AUTOMATED AFTER ALL. lib/fx.js kept the flag manual because "no keyless feed
// reports intervention in real time" — true, and still true. But intervention leaves a signature a
// price feed CAN see, and the Ministry of Finance publishes what it did, with a lag:
//
//   SUSPECTED  read off price, the same session. USD/JPY falls hard and fast (≥1.0% inside an hour,
//              or ≥1.5% inside three), the yen moves at least twice as far as DXY (so it is the yen,
//              not the dollar), and the fall starts within 3% of USD/JPY's 60-day high — the MoF
//              sells dollars to defend a weak yen, not into a strong one.
//   CONFIRMED  the MoF's own data: the daily CSV (published quarterly) names the date, or the
//              monthly total for the period containing it is above zero.
//   DENIED     the published data covers the date and shows nothing: the move was the market.
//
// CALIBRATED on six months of hourly USD/JPY and DXY (Mar–Sep 2026). The rule fires on 30 Apr,
// 6 May and 30–31 Jul and on nothing else; the MoF confirms 30 Apr and 6 May by date and 30 Jul
// inside a ¥15.4tn month. It misses 4 May (a Japanese holiday, a smaller operation) — which is what
// the confirmation step is for, and why the manual toggle stays.
//
// PURE. The fetchers are injected; everything here is a function of its arguments.

export const AUTO_CFG = Object.freeze({
  fastPct: 1.0, fastMin: 60,     // USD/JPY down ≥1.0% within an hour…
  slowPct: 1.5, slowMin: 180,    // …or ≥1.5% within three
  yenOverDxy: 2,                 // the yen move at least twice DXY's over the same span
  nearHighPct: 3,                // starting within 3% of the 60-day high
  mergeHours: 12,                // hits within 12 hours are one operation
  liveSessions: 2,               // an unconfirmed event is live for two sessions (lib/intervention.js)
  regimeSessions: 10,            // a confirmed one holds the leg flagged for ten quiet sessions
});

const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const MONTH_LONG = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
const pad = (n) => String(n).padStart(2, '0');
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
// The MoF dates an operation in Tokyo time; an NY-afternoon move is already the next day there.
export const tokyoDate = (epochS) => new Date((epochS + 9 * 3600) * 1000).toISOString().slice(0, 10);

// Weekdays strictly after `from` up to and including `to` (holidays ignored, as lib/intervention.js).
export function sessionsBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  let n = 0;
  for (let t = a + 864e5; t <= b; t += 864e5) { const d = new Date(t).getUTCDay(); if (d !== 0 && d !== 6) n++; }
  return n;
}

// ── THE PRICE SCAN ───────────────────────────────────────────────────────────
// `jpy` and `dxy` are ascending [{ t (epoch seconds), c }] intraday bars; `high60` the highest
// USD/JPY print of the last 60 days. For every bar, the drop from the highest close inside each
// window to this close is measured, and DXY over the same span. Each criterion is reported, met or
// not; an unknown (no DXY bar, no 60-day high) never counts as met.
const lastAtOrBefore = (s, t) => { let hit = null; for (const x of s) { if (x.t <= t) hit = x; else break; } return hit; };
export function scanYen({ jpy = [], dxy = [], high60 = null } = {}, cfg = AUTO_CFG) {
  const hits = [];
  for (let i = 1; i < jpy.length; i++) {
    const b = jpy[i];
    if (!(b.c > 0)) continue;
    for (const [pct, min] of [[cfg.fastPct, cfg.fastMin], [cfg.slowPct, cfg.slowMin]]) {
      let peak = null;
      for (let j = i - 1; j >= 0 && jpy[j].t >= b.t - min * 60; j--) if (jpy[j].c > 0 && (!peak || jpy[j].c > peak.c)) peak = jpy[j];
      if (!peak) continue;
      const move = (b.c / peak.c - 1) * 100;
      if (move > -pct) continue;
      const d0 = lastAtOrBefore(dxy, peak.t), d1 = lastAtOrBefore(dxy, b.t);
      const dxyMove = d0 && d1 && d1.t > d0.t - 1 && b.t - d1.t <= 3600 ? (d1.c / d0.c - 1) * 100 : null;
      const ratio = dxyMove == null ? null : Math.abs(dxyMove) < 0.01 ? Infinity : Math.abs(move) / Math.abs(dxyMove);
      const fromHigh = high60 > 0 ? (peak.c / high60 - 1) * 100 : null;
      const criteria = [
        { id: 'size', label: `USD/JPY −${pct}% within ${min} min`, met: true, display: `${r2(move)}% in ${Math.round((b.t - peak.t) / 60)} min` },
        { id: 'yen', label: `yen move ≥ ${cfg.yenOverDxy}× DXY`, met: ratio == null ? null : ratio >= cfg.yenOverDxy,
          display: dxyMove == null ? 'no DXY bar' : `DXY ${r2(dxyMove)}% (${ratio === Infinity ? '∞' : ratio.toFixed(1)}×)` },
        { id: 'zone', label: `within ${cfg.nearHighPct}% of the 60-day high`, met: fromHigh == null ? null : fromHigh >= -cfg.nearHighPct,
          display: fromHigh == null ? 'no 60-day high' : `${r2(fromHigh)}% from ${r2(high60)}` },
      ];
      if (criteria.every(c => c.met === true)) {
        hits.push({ t: b.t, peakT: peak.t, from: r2(peak.c), to: r2(b.c), movePct: r2(move), windowMin: Math.round((b.t - peak.t) / 60),
          dxyPct: r2(dxyMove), yenOverDxy: ratio === Infinity ? null : r2(ratio), fromHighPct: r2(fromHigh),
          // The yen leg's arithmetic share of the DXY move (lib/fx.js DXY_JPY_WEIGHT): below 100% the
          // dollar fell against more than the yen — a joint operation looks like this.
          sharePct: dxyMove ? Math.round((0.136 * move / dxyMove) * 100) : null, criteria });
      }
    }
  }
  // One operation, one event: hits within mergeHours of each other collapse to the largest move.
  const events = [];
  for (const h of hits.sort((a, b) => a.t - b.t)) {
    const last = events[events.length - 1];
    if (last && h.t - last.lastT <= cfg.mergeHours * 3600) {
      last.lastT = h.t;
      if (h.movePct < last.movePct) Object.assign(last, { ...h, firstT: last.firstT, lastT: h.t });
    } else events.push({ ...h, firstT: h.t, lastT: h.t });
  }
  return events.map(e => ({ currency: 'JPY', firedOn: tokyoDate(e.t), at: new Date(e.t * 1000).toISOString(), ...e }));
}

// ── THE MINISTRY OF FINANCE ──────────────────────────────────────────────────
// The daily CSV (foreign_exchange_intervention_operations.csv): one row per operation day, the year
// only on the first row of each year, amounts in ¥100m, and a quarter-total row after each quarter
// that says how far the published data reaches. Shift-JIS; the English columns are ASCII, so the
// text may be decoded as Latin-1 without harm.
function csvRow(line) {
  const out = []; let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
export function parseMofCsv(text) {
  const days = [];
  let year = null, coveredThrough = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const c = csvRow(line);
    if (c.length < 7) continue;
    const quarter = /(January|April|July|October)\s*-\s*(March|June|September|December)\s+(\d{4})/.exec(c[3] || '');
    if (quarter) {
      const endM = MONTH_LONG[quarter[2]], y = +quarter[3];
      const end = new Date(Date.UTC(y, endM, 0)).toISOString().slice(0, 10);
      if (!coveredThrough || end > coveredThrough) coveredThrough = end;
      continue;
    }
    if (/^\d{4}$/.test((c[3] || '').trim())) year = +c[3].trim();
    const m = MON[(c[4] || '').trim()], d = +(c[5] || '').trim();
    const amt = +String(c[6] || '').replace(/[",\s]/g, '');
    if (!year || !m || !(d >= 1 && d <= 31) || !Number.isFinite(amt)) continue;
    days.push({ date: `${year}-${pad(m)}-${pad(d)}`, amount100mYen: amt, pair: (c[8] || '').trim() || null });
  }
  return { days, coveredThrough };
}

// A monthly release page: "…for the period from July 30, 2026 through August 26, 2026" and a total
// of "¥ 15,399.3 billion" or "¥ 0".
const longDate = (s) => {
  const m = /([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(s || '');
  return m && MONTH_LONG[m[1]] ? `${m[3]}-${pad(MONTH_LONG[m[1]])}-${pad(+m[2])}` : null;
};
export function parseMofMonthly(html) {
  const text = String(html || '').replace(/<[^>]*>/g, ' ').replace(/&yen;|\uFFE5/g, '¥').replace(/&nbsp;|\u3000/g, ' ').replace(/\s+/g, ' ');
  const per = /period from ([A-Z][a-z]+ \d{1,2}, \d{4}) through ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(text);
  const tot = /¥\s*([\d,]+(?:\.\d+)?)\s*(billion)?/.exec(text.slice(per ? per.index : 0));
  if (!per || !tot) return null;
  const n = +tot[1].replace(/,/g, '');
  return { from: longDate(per[1]), to: longDate(per[2]), totalBillionYen: tot[2] ? n : n / 1e9 };
}
// The monthly index lists the releases as YYYYMMDDe.html, newest first.
export function parseMofMonthlyIndex(html) {
  return [...new Set([...String(html || '').matchAll(/(\d{8})e\.html/g)].map(m => m[1]))].sort().reverse();
}

// ── CONFIRMATION ─────────────────────────────────────────────────────────────
// The daily data is the strong test (the MoF names the day, ±1 for the Tokyo/NY boundary); the
// monthly total is the weaker one (the operation happened in that window); data that covers the
// date and shows nothing denies it.
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export function confirmEvent(event, mof = {}) {
  const d = event?.firedOn;
  if (!d) return { status: 'pending', why: 'no date' };
  const days = mof.csv?.days || [];
  const hit = days.find(x => x.date === d || x.date === addDays(d, -1) || x.date === addDays(d, 1));
  if (hit) return { status: 'confirmed', how: 'daily', date: hit.date, amountTrnYen: r2(hit.amount100mYen / 1e4),
    why: `MoF daily data: ¥${(hit.amount100mYen / 1e4).toFixed(2)}tn on ${hit.date}` };
  if (mof.csv?.coveredThrough && d <= mof.csv.coveredThrough) {
    return { status: 'denied', how: 'daily', why: `MoF daily data through ${mof.csv.coveredThrough} lists no operation on ${d}` };
  }
  const month = (mof.monthly || []).find(p => p && p.from && p.to && p.from <= d && d <= p.to);
  if (month) {
    return month.totalBillionYen > 0
      ? { status: 'confirmed', how: 'monthly', period: [month.from, month.to], amountTrnYen: r2(month.totalBillionYen / 1000),
          why: `MoF monthly total ¥${(month.totalBillionYen / 1000).toFixed(1)}tn for ${month.from} – ${month.to}` }
      : { status: 'denied', how: 'monthly', period: [month.from, month.to], why: `MoF reports ¥0 for ${month.from} – ${month.to}` };
  }
  return { status: 'pending', why: 'not yet covered by an MoF release (monthly totals publish at month-end)' };
}

// ── THE STATE lib/intervention.js contamination() READS ─────────────────────
// A live event (not denied, inside liveSessions) sets events.JPY; a confirmed event inside
// regimeSessions sets regimes.JPY as CONFIRMED, with the quiet-session count as its clearing context.
// `manual` is the operator's stored state; anything it sets wins over the automatic flag.
export function autoState(events = [], mof = {}, today, cfg = AUTO_CFG) {
  const graded = events.map(e => ({ ...e, confirmation: confirmEvent(e, mof) }));
  const alive = graded.filter(e => e.confirmation.status !== 'denied');
  const latest = alive[alive.length - 1] || null;
  const quiet = latest ? sessionsBetween(latest.firedOn, today) : null;
  const state = { events: {}, regimes: {}, context: {} };
  if (latest && quiet != null && quiet <= cfg.liveSessions) {
    state.events.JPY = { firedOn: latest.firedOn, grade: latest.confirmation.status === 'confirmed' ? 'CONFIRMED' : 'SUSPECTED', auto: true };
  }
  const conf = alive.filter(e => e.confirmation.status === 'confirmed');
  const lastConf = conf[conf.length - 1] || null;
  const quietConf = lastConf ? sessionsBetween(lastConf.firedOn, today) : null;
  if (lastConf && quietConf != null && quietConf <= cfg.regimeSessions) {
    state.regimes.JPY = { grade: 'CONFIRMED', since: conf.find(e => sessionsBetween(e.firedOn, lastConf.firedOn) <= cfg.regimeSessions)?.firedOn ?? lastConf.firedOn,
      currency: 'JPY', note: lastConf.confirmation.why, auto: true };
    state.context.JPY = { sessionsSinceEvent: quietConf };
  }
  const active = !!(state.events.JPY || state.regimes.JPY);
  return {
    state, events: graded, active, latest,
    headline: !latest ? 'no intervention signature in the scan window'
      : `${latest.confirmation.status === 'confirmed' ? 'CONFIRMED' : latest.confirmation.status === 'denied' ? 'DENIED' : 'SUSPECTED'} yen intervention ${latest.firedOn}: USD/JPY ${latest.movePct}% in ${latest.windowMin} min from ${latest.from}`
        + `${latest.dxyPct != null ? `, DXY ${latest.dxyPct}%` : ''} — ${latest.confirmation.why}`,
  };
}

// The stored manual flags laid over the automatic ones, per leg: an operator's regime or event for a
// currency replaces the automatic one for that currency and leaves the others alone.
export function mergeInterventionState(manual = {}, auto = { events: {}, regimes: {}, context: {} }) {
  const m = manual || {};
  return {
    ...m,
    events: { ...(auto.events || {}), ...(m.events || {}) },
    regimes: { ...(auto.regimes || {}), ...(m.regimes || {}) },
    context: { ...(auto.context || {}), ...(m.context || {}) },
  };
}
