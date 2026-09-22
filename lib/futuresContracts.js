// lib/futuresContracts.js — a future is a contract, not a share.
//
// 2026-09-22: the sizer, asked for CL=F as a Stock, answered "229 shares". That is 229 BARRELS.
// One CL contract is 1,000 of them ($92,200 of crude, 43.5% of NLV); one MCL is 100. A reader who
// enters 229 of either is wrong by a hundred or a thousand times. The correct answer for that
// input is two MCL, and "CL: below one contract." Everything a future needs that a share does not
// lives here: the multiplier and its unit, the micro sibling to fall back to, the month cycle, the
// exchange's rule for the last trading day, whether delivery is physical (IBKR closes you out
// before it), and the three information lines — term structure, gap test, roll — that a share
// has no equivalent of. Pure: no I/O, every date rule tested against a known contract.

import { FUTURES_MULTIPLIER } from './futures.js';

// ── THE FAMILIES ─────────────────────────────────────────────────────────────
// `micro` is the smaller sibling to re-run on when the big contract sizes to zero; `parent` is the
// aggregation root (CL and MCL are one underlying for the single-name cap). `cycle` is the listed
// month cycle sized against. `physical` is delivery: IBKR force-closes before it, so the roll line
// carries a date. `exchange` is the feed's suffix for a dated month (CLZ26.NYM). `index` marks the
// families that ARE the market and follow the QQQ/SPY exemption from the single-name cap.
const M = 'FGHJKMNQUVXZ';
export const FAMILIES = Object.freeze({
  CL:  { label: 'WTI crude',            unit: 'bbl',     micro: 'MCL', physical: true,  exchange: 'NYM', cycle: M,       rule: 'cl' },
  MCL: { label: 'Micro WTI crude',      unit: 'bbl',     parent: 'CL', physical: true,  exchange: 'NYM', cycle: M,       rule: 'cl' },
  BZ:  { label: 'Brent crude (last-day financial)', unit: 'bbl', physical: false, exchange: 'NYM', cycle: M, rule: 'bz' },
  COIL:{ label: 'ICE Brent crude',      unit: 'bbl',     physical: false, exchange: null,  cycle: M,       rule: 'bz', alias: 'BZ',
         note: 'the feed has no ICE Brent; NYMEX BZ (cash-settled to the same benchmark) is the proxy' },
  NG:  { label: 'Henry Hub natural gas', unit: 'MMBtu',  micro: 'MNG', physical: true,  exchange: 'NYM', cycle: M,       rule: 'ng' },
  MNG: { label: 'Micro natural gas',    unit: 'MMBtu',   parent: 'NG', physical: false, exchange: 'NYM', cycle: M,       rule: 'ng',
         note: 'MNG is financially settled against NG; sized here as NG\'s micro' },
  GC:  { label: 'Gold',                 unit: 'oz',      micro: 'MGC', physical: true,  exchange: 'CMX', cycle: 'GJMQVZ', rule: 'gc' },
  MGC: { label: 'Micro gold',           unit: 'oz',      parent: 'GC', physical: true,  exchange: 'CMX', cycle: 'GJMQVZ', rule: 'gc' },
  ES:  { label: 'E-mini S&P 500',       unit: 'index pt', micro: 'MES', physical: false, exchange: 'CME', cycle: 'HMUZ', rule: 'thirdFriday', index: true },
  MES: { label: 'Micro E-mini S&P 500', unit: 'index pt', parent: 'ES', physical: false, exchange: 'CME', cycle: 'HMUZ', rule: 'thirdFriday', index: true },
  NQ:  { label: 'E-mini Nasdaq-100',    unit: 'index pt', micro: 'MNQ', physical: false, exchange: 'CME', cycle: 'HMUZ', rule: 'thirdFriday', index: true },
  MNQ: { label: 'Micro E-mini Nasdaq-100', unit: 'index pt', parent: 'NQ', physical: false, exchange: 'CME', cycle: 'HMUZ', rule: 'thirdFriday', index: true },
  NKD: { label: 'Nikkei 225 (USD)',     unit: 'index pt', physical: false, exchange: 'CME', cycle: 'HMUZ', rule: 'nikkei', index: true },
  '6J':{ label: 'Japanese yen',         unit: 'JPY',     micro: 'MJY', physical: false, exchange: 'CME', cycle: 'HMUZ', rule: 'fx' },
  MJY: { label: 'Micro yen',            unit: 'JPY',     parent: '6J', physical: false, exchange: 'CME', cycle: 'HMUZ', rule: 'fx' },
  ZN:  { label: '10-year T-note',       unit: '$ per pt', physical: false, exchange: 'CBT', cycle: 'HMUZ', rule: 'zn' },
});
export const MULTIPLIER = Object.freeze({ ...FUTURES_MULTIPLIER, BZ: 1000, COIL: 1000, NKD: 5 });

// The family a symbol belongs to: CL=F, CLZ26, CLZ26.NYM, MCL, "CL Dec-26" all resolve. Null when
// it is not a known family — the caller then asks for a multiplier and never assumes one.
export function familyOf(symbol) {
  let s = String(symbol || '').toUpperCase().trim().split(/[\s|]/)[0] || '';
  s = s.replace(/=F$/, '').replace(/\.(NYM|CMX|CME|CBT|NYB)$/, '');
  if (FAMILIES[s]) return s;
  const m = new RegExp(`^([A-Z0-9]{1,4}?)([${M}])(\\d{1,2})$`).exec(s);
  if (m && FAMILIES[m[1]]) return m[1];
  return null;
}
// The aggregation root: MCL → CL, MGC → GC, an alias → its target.
export function parentFamily(fam) {
  const f = FAMILIES[fam];
  if (!f) return fam ?? null;
  return f.parent || f.alias || fam;
}
export const isIndexFamily = (fam) => !!FAMILIES[parentFamily(fam)]?.index;

// ── DATES ────────────────────────────────────────────────────────────────────
const iso = (d) => d.toISOString().slice(0, 10);
const utc = (s) => new Date(s + 'T00:00:00Z');
const isBiz = (d, H) => { const w = d.getUTCDay(); return w !== 0 && w !== 6 && !H.has(iso(d)); };
const step = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
// n business days before (n>0) or after (n<0) a date, holidays out. n=0 returns the date itself
// stepped back to a business day.
export function bizDaysFrom(dateIso, n, holidays = []) {
  const H = new Set(holidays);
  let d = utc(dateIso);
  if (n === 0) { while (!isBiz(d, H)) d = step(d, -1); return iso(d); }
  const dir = n > 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) { d = step(d, dir); if (isBiz(d, H)) left--; }
  return iso(d);
}
export const lastBizDayOfMonth = (y, m, holidays = []) => bizDaysFrom(iso(new Date(Date.UTC(y, m, 0))), 0, holidays);
const nthWeekday = (y, m, weekday, n) => { const first = new Date(Date.UTC(y, m - 1, 1)); const off = (weekday - first.getUTCDay() + 7) % 7; return iso(new Date(Date.UTC(y, m - 1, 1 + off + 7 * (n - 1)))); };

// The exchange's last-trading-day rule, per family. `y`/`m` are the CONTRACT month.
//   cl   — three business days before the 25th of the month prior (if the 25th is not a business
//          day, before the business day preceding it). Nov-26 → 20 Oct 2026. Dec-26 → 20 Nov 2026.
//   bz   — last business day of the second month prior. Dec-26 → 30 Oct 2026.
//   ng   — three business days before the first day of the contract month. Nov-26 → 28 Oct 2026.
//   gc   — third-last business day of the contract month. Dec-26 → 29 Dec 2026.
//   thirdFriday — third Friday of the contract month (ES, NQ). Dec-26 → 18 Dec 2026.
//   nikkei — the business day before the second Friday of the contract month.
//   fx   — two business days before the third Wednesday (6J, MJY). Dec-26 → 14 Dec 2026.
//   zn   — seven business days before the last business day of the contract month.
export function lastTradeDate(fam, y, m, holidays = []) {
  const rule = FAMILIES[fam]?.rule;
  const prev = (k) => { const d = new Date(Date.UTC(y, m - 1 - k, 1)); return [d.getUTCFullYear(), d.getUTCMonth() + 1]; };
  if (rule === 'cl') { const [py, pm] = prev(1); const d25 = bizDaysFrom(`${py}-${String(pm).padStart(2, '0')}-25`, 0, holidays); return bizDaysFrom(d25, 3, holidays); }
  if (rule === 'bz') { const [py, pm] = prev(2); return lastBizDayOfMonth(py, pm, holidays); }
  if (rule === 'ng') return bizDaysFrom(`${y}-${String(m).padStart(2, '0')}-01`, 3, holidays);
  if (rule === 'gc') { const last = lastBizDayOfMonth(y, m, holidays); return bizDaysFrom(last, 2, holidays); }
  if (rule === 'thirdFriday') return bizDaysFrom(nthWeekday(y, m, 5, 3), 0, holidays);
  if (rule === 'nikkei') return bizDaysFrom(nthWeekday(y, m, 5, 2), 1, holidays);
  if (rule === 'fx') return bizDaysFrom(nthWeekday(y, m, 3, 3), 2, holidays);
  if (rule === 'zn') return bizDaysFrom(lastBizDayOfMonth(y, m, holidays), 7, holidays);
  return null;
}
// IBKR closes a physically-delivered position before delivery; the line says when to roll by.
export const rollBy = (lastTrade, holidays = []) => lastTrade ? bizDaysFrom(lastTrade, 3, holidays) : null;

export const monthLabel = (y, m) => `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]}-${String(y).slice(2)}`;
export const monthCode = (fam, y, m) => `${fam}${M[m - 1]}${String(y).slice(2)}`;   // CLX26
export const monthSymbol = (fam, y, m) => { const f = FAMILIES[fam]; const ex = f?.exchange || FAMILIES[f?.alias]?.exchange; return ex ? `${f?.alias || fam}${M[m - 1]}${String(y).slice(2)}.${ex}` : null; };

// The listed months from `today`, in the family's cycle, that have not yet stopped trading.
export function contractMonths(fam, { today = new Date().toISOString().slice(0, 10), count = 6, holidays = [] } = {}) {
  const f = FAMILIES[fam];
  if (!f) return [];
  const out = [];
  let d = utc(today.slice(0, 7) + '-01');
  for (let i = 0; i < 30 && out.length < count; i++) {
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    if (f.cycle.includes(M[m - 1])) {
      const last = lastTradeDate(fam, y, m, holidays);
      if (last && last >= today) {
        const days = Math.round((utc(last) - utc(today)) / 864e5);
        out.push({ family: fam, y, m, label: monthLabel(y, m), code: monthCode(fam, y, m), symbol: monthSymbol(fam, y, m),
                   lastTrade: last, days, rollBy: f.physical ? rollBy(last, holidays) : null });
      }
    }
    d = new Date(Date.UTC(y, m, 1));
  }
  return out;
}
// The month to size by default: the first one with at least a day of trading left. A contract on
// its last trading day (CL Oct-26 on 22 Sep) is listed, and is not the default.
export const frontMonth = (months = []) => months.find(m => (m.days ?? 0) >= 1) || months[0] || null;

// ── THE THREE LINES ──────────────────────────────────────────────────────────
// Term structure: front against the month being sized. Backwardation (later month cheaper) means
// a long earns the convergence as its month becomes the front; contango means it pays it.
export function termStructure(front, chosen) {
  if (!front?.price || !chosen?.price || front.code === chosen.code) return null;
  const spread = +(chosen.price - front.price).toFixed(4);
  const months = Math.max(1, Math.round(((chosen.y - front.y) * 12 + (chosen.m - front.m))));
  const pctPerMonth = +((spread / front.price) * 100 / months).toFixed(2);
  const shape = spread < 0 ? 'backwardation' : spread > 0 ? 'contango' : 'flat';
  return { spread, pctPerMonth, months, shape,
           carry: shape === 'backwardation' ? 'long earns convergence, short pays it'
                : shape === 'contango' ? 'long pays convergence, short earns it' : 'no carry either way',
           text: `${front.label} ${front.price} · ${chosen.label} ${chosen.price} · ${spread > 0 ? '+' : spread < 0 ? '−' : ''}$${Math.abs(spread).toFixed(2)} (${pctPerMonth > 0 ? '+' : pctPerMonth < 0 ? '−' : ''}${Math.abs(pctPerMonth)}%/mo) ${shape}` };
}
// Gap test: what a 5% and a 10% day does at the size, in dollars and NLV. Commodities gap on
// headlines and the ATR test does not see that.
export function gapTest({ contracts, price, multiplier, nlv }) {
  const n = Number(contracts) || 0, p = Number(price) || 0, x = Number(multiplier) || 0, eq = Number(nlv) || 0;
  const notional = n * p * x;
  const at = (pct) => ({ pct, usd: +(notional * pct / 100).toFixed(2), pctNlv: eq > 0 ? +((notional * pct / 100) / eq * 100).toFixed(2) : null });
  return { notional: +notional.toFixed(2), five: at(5), ten: at(10) };
}
// Roll: last trading date, days, amber under a week, and the delivery warning where it applies.
export const ROLL_AMBER_DAYS = 7;
export function rollLine(month, fam) {
  if (!month?.lastTrade) return null;
  const physical = !!FAMILIES[fam]?.physical;
  return { lastTrade: month.lastTrade, days: month.days, amber: month.days != null && month.days < ROLL_AMBER_DAYS, physical, rollBy: month.rollBy,
           text: `${month.lastTrade} · ${month.days}d${physical ? ` · physical delivery — IBKR force-closes before it, roll by ${month.rollBy}` : ' · cash-settled'}` };
}
// A calendar spread typed as one symbol ("COIL Z6-Z7", "CLZ26/CLF27") is not sized one leg at a time.
export const looksLikeSpread = (symbol) => /[A-Z]\d{1,2}\s*[-/]\s*[A-Z]{0,4}\d{1,2}/i.test(String(symbol || '')) || /\b(spread|calendar)\b/i.test(String(symbol || ''));
