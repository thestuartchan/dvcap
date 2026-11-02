// lib/chinaRead.js — one China read: five rows and a verdict, in plain words (2 Nov 2026).
//
// Before this the dashboard's China inputs were scattered: Southbound flow and the SMIC A/H
// premium in one panel, HSI/HSTECH in the regional tape, USD/CNH as a quote, the data dates on the
// calendar with no values. Each row here answers one question, from data the dashboard reads daily:
//
//   Mainland money  — is mainland money flowing into Hong Kong?      Southbound net, 5 and 20 days
//   Mainland stocks — is the mainland market rising?                 CSI 300 (510300 ETF) vs 50-day, 20-day %
//   Yuan            — is the currency firming or weakening?          USD/CNY over 20 sessions
//   HK tech         — is Hong Kong tech trending?                    HSTECH (3033 ETF) vs 50/200-day; KWEB
//   Growth          — is the economy expanding?                      official PMI (NBS), copper 20-day
//
// Each row scores +1 (supportive), 0 (mixed) or −1 (risk-off) on a stated rule, and the verdict is
// their sum: +2 or more supportive, −2 or less risk-off, otherwise mixed. It is its OWN read: it does
// not vote on the Signal Board, whose lean and backtested calls are unchanged.
//
// Pure: takes the fetched inputs, returns the read. lib/chinaFeed.js does the fetching.
import { southboundTrend } from './southbound.js';

const last = (c) => (c?.length ? c[c.length - 1] : null);
const sma = (c, n) => (c?.length >= n ? c.slice(-n).reduce((a, x) => a + x[1], 0) / n : null);
const pctBack = (c, n) => (c?.length > n ? (c[c.length - 1][1] / c[c.length - 1 - n][1] - 1) * 100 : null);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const sgn = (v, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`);
const fmt = (v, d = 0) => (v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
// A price at the precision its size needs: an ETF at 4.116 keeps three places, an index none.
const px = (v) => (v == null ? '—' : fmt(v, Math.abs(v) < 10 ? 3 : Math.abs(v) < 1000 ? 2 : 0));

export const RULES = {
  stocksPct: 2,          // CSI 300: ±2% over 20 sessions, on the matching side of its 50-day
  yuanFirm: -0.5,        // USD/CNY 20-session change at or below −0.5%: the yuan firming
  yuanWeak: 0.75,        // at or above +0.75%: the yuan weakening
  pmiLine: 50,           // the official line between expansion and contraction
};

const STATE = { 1: 'support', 0: 'neutral', [-1]: 'risk' };
const unknown = (key, label, why) => ({ key, label, state: 'unknown', score: null, plain: `${label}: no data`, line: why, flips: null, asOf: null });

export function moneyRow(series) {
  const t = southboundTrend(series || []);
  if (!t.latest) return unknown('money', 'Mainland money', 'HKEX Southbound file not read');
  const { w5, w20 } = t;
  const score = w5.dir === 'buy' && w20.dir === 'buy' ? 1 : w5.dir === 'sell' && w20.dir === 'sell' ? -1 : 0;
  return {
    key: 'money', label: 'Mainland money', state: STATE[score], score, asOf: t.latest.date,
    plain: score > 0 ? 'Mainland money is flowing into Hong Kong' : score < 0 ? 'Mainland money is leaving Hong Kong' : 'Mainland money is mixed',
    line: `Southbound net HK$${sgn(w5.sum)}bn over 5 days, HK$${sgn(w20.sum)}bn over 20`,
    flips: score === 0 ? 'Clears when the 5- and 20-day sums point the same way' : 'Turns when the 5-day sum crosses zero',
  };
}

export function stocksRow(csi, ah) {
  const c = last(csi), m50 = sma(csi, 50), p20 = pctBack(csi, 20);
  if (!c || m50 == null || p20 == null) return unknown('stocks', 'Mainland stocks', 'CSI 300 ETF closes not read');
  const above = c[1] >= m50;
  const score = above && p20 >= RULES.stocksPct ? 1 : !above && p20 <= -RULES.stocksPct ? -1 : 0;
  const ahS = ah?.series?.length > 20 ? r1(ah.series[ah.series.length - 1].premium - ah.series[ah.series.length - 21].premium) : null;
  const ahTxt = ah?.premium != null ? ` · SMIC A/H premium ${fmt(ah.premium, 0)}%${ahS != null ? ` (${sgn(ahS)} pts in 20 days: mainland ${ahS > 1 ? 'paying up' : ahS < -1 ? 'cooling' : 'steady'})` : ''}` : '';
  return {
    key: 'stocks', label: 'Mainland stocks', state: STATE[score], score, asOf: c[0],
    plain: score > 0 ? 'Mainland stocks are rising' : score < 0 ? 'Mainland stocks are falling' : 'Mainland stocks are flat',
    line: `CSI 300 (510300 ETF) ${px(c[1])}, ${sgn(r1(p20))}% in 20 days, ${above ? 'above' : 'below'} its 50-day ${px(m50)}${ahTxt}`,
    flips: `50-day at ${px(m50)}; ±${RULES.stocksPct}% over 20 days on the matching side scores`,
  };
}

export function yuanRow(cnh) {
  const c = last(cnh), p20 = pctBack(cnh, 20);
  if (!c || p20 == null) return unknown('yuan', 'Yuan', 'USD/CNY closes not read');
  const score = p20 <= RULES.yuanFirm ? 1 : p20 >= RULES.yuanWeak ? -1 : 0;
  const base = cnh[cnh.length - 21][1];
  return {
    key: 'yuan', label: 'Yuan', state: STATE[score], score, asOf: c[0],
    plain: score > 0 ? 'The yuan is firming' : score < 0 ? 'The yuan is weakening' : 'The yuan is steady',
    line: `USD/CNY ${c[1].toFixed(4)}, ${sgn(r2(p20), 2)}% in 20 days (up = a weaker yuan)`,
    flips: `Firming below ${(base * (1 + RULES.yuanFirm / 100)).toFixed(4)}, weakening above ${(base * (1 + RULES.yuanWeak / 100)).toFixed(4)}`,
  };
}

export function tapeRow(hstech, kweb) {
  const c = last(hstech), m50 = sma(hstech, 50), m200 = sma(hstech, 200);
  if (!c || m50 == null) return unknown('tape', 'HK tech', 'HSTECH ETF closes not read');
  const a50 = c[1] >= m50, a200 = m200 == null ? null : c[1] >= m200;
  const score = a50 && a200 !== false ? (a200 ? 1 : 0) : !a50 && a200 === false ? -1 : 0;
  const k = kweb?.length > 1 ? pctBack(kweb, 1) : null;
  return {
    key: 'tape', label: 'HK tech', state: STATE[score], score, asOf: c[0],
    plain: score > 0 ? 'HK tech is in an uptrend' : score < 0 ? 'HK tech is in a downtrend' : 'HK tech is between its averages',
    line: `HSTECH (3033 ETF) ${px(c[1])}: ${a50 ? 'above' : 'below'} its 50-day ${px(m50)}${m200 != null ? `, ${a200 ? 'above' : 'below'} its 200-day ${px(m200)}` : ''}${k != null ? ` · KWEB ${sgn(r1(k))}% in the last US session` : ''}`,
    flips: `50-day ${px(m50)}${m200 != null ? `, 200-day ${px(m200)}` : ''}`,
  };
}

export function growthRow(pmi, copper) {
  const cu = pctBack(copper, 20);
  const cuTxt = cu != null ? ` · copper ${sgn(r1(cu))}% in 20 days` : '';
  if (!pmi?.ok || pmi.manufacturing == null) {
    if (cu == null) return unknown('growth', 'Growth', 'NBS PMI and copper not read');
    return { key: 'growth', label: 'Growth', state: 'neutral', score: 0, asOf: last(copper)?.[0] ?? null,
      plain: 'Growth: the official PMI was not read', line: `PMI unavailable${cuTxt}`, flips: null };
  }
  const m = pmi.manufacturing, ch = pmi.mfgChange;
  const score = m >= RULES.pmiLine && (ch == null || ch >= 0) ? 1 : m < RULES.pmiLine && (ch == null || ch < 0) ? -1 : 0;
  const per = new Date(`${pmi.period}-15T00:00:00Z`).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return {
    key: 'growth', label: 'Growth', state: STATE[score], score, asOf: pmi.published || pmi.period,
    plain: score > 0 ? 'Factory activity is expanding' : score < 0 ? 'Factory activity is contracting' : 'Growth is mixed',
    line: `${per} PMI ${m.toFixed(1)}${ch != null ? ` (${sgn(ch)})` : ''}, new orders ${pmi.newOrders?.toFixed(1) ?? '—'}, services/construction ${pmi.nonMfg?.toFixed(1) ?? '—'}${cuTxt}`,
    flips: '50 is the line between expansion and contraction',
  };
}

// China events in the next `days` days from the hand calendar, soonest first.
export function chinaEvents(calendar = [], { now = new Date(), days = 14, max = 4 } = {}) {
  const from = now.toISOString().slice(0, 10);
  const to = new Date(now.getTime() + days * 86400000).toISOString().slice(0, 10);
  return calendar.filter(e => e?.date >= from && e.date <= to && /^(China|PBoC)\b/i.test(String(e.title || '')))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || '')))
    .slice(0, max).map(e => ({ date: e.date, time: e.time || null, tz: e.tz || null, title: e.title }));
}

const joinPlain = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export function chinaRead({ southbound = [], ah = null, closes = {}, pmi = null, calendar = [], now = new Date() } = {}) {
  const rows = [
    moneyRow(southbound),
    stocksRow(closes.csi300, ah),
    yuanRow(closes.cnh),
    tapeRow(closes.hstech, closes.kweb),
    growthRow(pmi, closes.copper),
  ];
  const known = rows.filter(r => r.score != null);
  const score = known.reduce((a, r) => a + r.score, 0);
  const verdict = known.length < 3 ? 'unknown' : score >= 2 ? 'supportive' : score <= -2 ? 'risk-off' : 'mixed';
  const lc = (s) => (/^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));   // 'HK tech' keeps its capitals
  const ups = known.filter(r => r.score > 0).map(r => lc(r.plain)), downs = known.filter(r => r.score < 0).map(r => lc(r.plain));
  const word = { supportive: 'Supportive', 'risk-off': 'Risk-off', mixed: 'Mixed', unknown: 'Not enough data' }[verdict];
  const headline = verdict === 'unknown' ? `Not enough data: ${known.length} of 5 rows read`
    : `${word}: ${[ups.length ? joinPlain(ups) : null, downs.length ? `${ups.length ? 'but ' : ''}${joinPlain(downs)}` : null].filter(Boolean).join(', ') || 'nothing is pulling either way'}`;
  return { verdict, score, of: known.length, headline, rows, events: chinaEvents(calendar, { now }), rules: RULES };
}
