// lib/dayTradeRegimeData.js — the market data lib/dayTradeRegime.js labels each day with, read raw at
// runtime: Yahoo daily / hourly / 5-minute bars (QQQ, SPY, ES=F, NQ=F), Cboe's VIX and VXN history,
// SqueezeMetrics' DIX.csv. Market data only — the fills are the caller's, from IBKR Flex.

import { nyIso } from './dayTradeRegime.js';

const UA = { headers: { 'User-Agent': 'Mozilla/5.0' } };
const yahoo = (sym, q) => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?${q}`;
const nyParts = (sec) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(sec * 1000)).reduce((a, x) => ({ ...a, [x.type]: x.value }), {});
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
};

async function chart(fetchImpl, sym, q) {
  try {
    const r = await fetchImpl(yahoo(sym, q), { ...UA, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const res = (await r.json())?.chart?.result?.[0];
    if (!res?.timestamp) return null;
    const qq = res.indicators?.quote?.[0] || {};
    return res.timestamp.map((t, i) => ({ t, o: qq.open?.[i], h: qq.high?.[i], l: qq.low?.[i], c: qq.close?.[i] })).filter(b => [b.o, b.h, b.l, b.c].every(Number.isFinite));
  } catch { return null; }
}
async function text(fetchImpl, url) {
  try { const r = await fetchImpl(url, { ...UA, signal: AbortSignal.timeout(15000) }); return r.ok ? await r.text() : null; } catch { return null; }
}
// Cboe history CSV (DATE,OPEN,HIGH,LOW,CLOSE or DATE,VALUE) → { 'YYYY-MM-DD': close }
export function parseCboeCsv(csv) {
  const out = {};
  const lines = String(csv || '').trim().split(/\r?\n/);
  const head = (lines.shift() || '').split(',').map(s => s.trim().toUpperCase());
  const ci = head.includes('CLOSE') ? head.indexOf('CLOSE') : head.length - 1;
  for (const l of lines) {
    const c = l.split(','); const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(c[0]?.trim());
    if (m && Number.isFinite(+c[ci])) out[`${m[3]}-${m[1]}-${m[2]}`] = +c[ci];
  }
  return out;
}
export function parseDix(csv) {
  const out = {};
  const lines = String(csv || '').trim().split(/\r?\n/);
  const head = (lines.shift() || '').split(',');
  const gi = head.indexOf('gex'), di = head.indexOf('date');
  for (const l of lines) { const c = l.split(','); if (c[di] && Number.isFinite(+c[gi])) out[c[di]] = +c[gi]; }
  return out;
}
// The value of a {date: v} series at the close BEFORE `date`.
export function prevOf(series, dates) {
  const keys = Object.keys(series).sort(), out = {};
  let j = 0;
  for (const d of [...dates].sort()) { while (j < keys.length && keys[j] < d) j++; if (j > 0) out[d] = series[keys[j - 1]]; }
  return out;
}

export async function fetchMarket({ from, dates = [], fetchImpl = fetch, captures = {}, calendar = [] } = {}) {
  const p1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000) - 20 * 86400, p2 = Math.floor(Date.now() / 1000);
  const [dQ, dS, hQ, hS, fQ, fS, mQ, mS, vix, vxn, dix] = await Promise.all([
    chart(fetchImpl, 'QQQ', `interval=1d&period1=${p1}&period2=${p2}`), chart(fetchImpl, 'SPY', `interval=1d&period1=${p1}&period2=${p2}`),
    chart(fetchImpl, 'QQQ', `interval=60m&period1=${Math.max(p1, p2 - 729 * 86400)}&period2=${p2}`), chart(fetchImpl, 'SPY', `interval=60m&period1=${Math.max(p1, p2 - 729 * 86400)}&period2=${p2}`),
    chart(fetchImpl, 'NQ=F', `interval=60m&period1=${Math.max(p1, p2 - 729 * 86400)}&period2=${p2}`), chart(fetchImpl, 'ES=F', `interval=60m&period1=${Math.max(p1, p2 - 729 * 86400)}&period2=${p2}`),
    chart(fetchImpl, 'QQQ', 'interval=5m&range=60d'), chart(fetchImpl, 'SPY', 'interval=5m&range=60d'),
    text(fetchImpl, 'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv'),
    text(fetchImpl, 'https://cdn.cboe.com/api/global/us_indices/daily_prices/VXN_History.csv'),
    text(fetchImpl, 'https://squeezemetrics.com/monitor/static/DIX.csv'),
  ]);
  const sources = { QQQd: !!dQ, SPYd: !!dS, QQQh: !!hQ, SPYh: !!hS, NQh: !!fQ, ESh: !!fS, QQQ5m: !!mQ, SPY5m: !!mS, VIX: !!vix, VXN: !!vxn, DIX: !!dix };
  const bars = {}, under = {}, fut = {};
  for (const [tk, daily, hourly, five, fbars] of [['QQQ', dQ, hQ, mQ, fQ], ['SPY', dS, hS, mS, fS]]) {
    bars[tk] = {}; under[tk] = {}; fut[tk] = {};
    const days = (daily || []).map(b => ({ ...b, date: nyParts(b.t).date }));
    days.forEach((b, i) => { bars[tk][b.date] = { o: b.o, h: b.h, l: b.l, c: b.c, prevClose: i ? days[i - 1].c : null }; });
    for (const b of hourly || []) {
      const { date, min } = nyParts(b.t);
      if (min < 570 || min >= 960) continue;
      if (bars[tk][date] && min === 570) bars[tk][date].firstHour = { h: b.h, l: b.l };
      (under[tk][date] ||= {})[min] = b.o;
    }
    for (const b of five || []) {
      const { date, min } = nyParts(b.t);
      if (min < 570 || min >= 960) continue;
      (under[tk][date] ||= {})[min] = b.o;
    }
    // Futures: the price at 04:00 UTC on the day, and the 16:00 New York close of the session before.
    const fb = (fbars || []).map(b => ({ ...b, iso: new Date(b.t * 1000).toISOString() }));
    const tradingDates = days.map(b => b.date);
    for (const d of dates) {
      const at = `${d}T04:00:00Z`;
      const a = fb.filter(b => b.iso <= at).pop();
      const prevDay = tradingDates.filter(x => x < d).pop();
      if (!a || !prevDay) continue;
      const closeIso = nyIso(prevDay, 16 * 60);
      const c = fb.filter(b => b.iso < closeIso).pop();
      if (c && (Date.parse(at) - Date.parse(a.iso)) < 2 * 3600e3) fut[tk][d] = { at04: a.c, prevClose: c.c };
    }
  }
  const vol = { SPY: prevOf(parseCboeCsv(vix), dates), QQQ: prevOf(parseCboeCsv(vxn), dates) };
  const gex = prevOf(parseDix(dix), dates);
  const calendarFrom = calendar.map(e => e.date).sort()[0] || null;
  return { m: { bars, fut, vol, gex, captures, calendar, calendarFrom }, under, sources };
}
