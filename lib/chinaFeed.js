// lib/chinaFeed.js — the China read's inputs, fetched together (2 Nov 2026). lib/chinaRead.js reads
// them; api/indicators.js ?china=1 serves the result. Each source is settled on its own, so one
// failing leaves its row "no data" and the others standing.
import { yahooDailyCloses } from './yahoo.js';
import { fetchSouthbound } from './hkexSouthbound.js';
import { fetchSmicAHPremium } from './smicah.js';
import { fetchChinaPmi } from './chinaPmi.js';
import { chinaRead } from './chinaRead.js';
import CALENDAR from '../data/calendar.json' with { type: 'json' };

// Settled daily closes. Ranges cover each row's longest window (HSTECH's 200-day needs a year).
// THE ETFS, NOT THE INDEXES (2 Nov 2026): Yahoo answered 000300.SS, HSTECH.HK and CNH=X with a
// single bar for any range, while the funds that track them came back whole. 510300.SS is the
// Huatai-PineBridge CSI 300 ETF and 3033.HK CSOP's Hang Seng TECH ETF; trends and averages read the
// same on either. The yuan is the onshore USD/CNY: the offshore CNH had no history either.
export const CHINA_SYMBOLS = {
  csi300: ['510300.SS', '6mo'],
  cnh: ['CNY=X', '3mo'],
  hstech: ['3033.HK', '1y'],
  kweb: ['KWEB', '5d'],
  copper: ['HG=F', '3mo'],
};

export async function chinaPayload({ now = new Date() } = {}) {
  const keys = Object.keys(CHINA_SYMBOLS);
  const settled = await Promise.allSettled([
    fetchSouthbound(), fetchSmicAHPremium(), fetchChinaPmi(),
    ...keys.map(k => yahooDailyCloses(CHINA_SYMBOLS[k][0], CHINA_SYMBOLS[k][1])),
  ]);
  const val = (i) => (settled[i].status === 'fulfilled' ? settled[i].value : null);
  const sb = val(0), ah = val(1), pmi = val(2);
  const closes = {}, sources = {};
  keys.forEach((k, i) => {
    const r = val(3 + i);
    closes[k] = r?.ok ? r.closes : null;
    sources[k] = r?.ok ? 'ok' : (r?.status || 'failed');
  });
  sources.southbound = sb?.ok ? 'ok' : (sb?.error || 'failed');
  sources.ahPremium = ah?.premium != null ? 'ok' : (ah?.reason || 'failed');
  sources.pmi = pmi?.ok ? 'ok' : (pmi?.error || 'failed');
  const read = chinaRead({ southbound: sb?.series || [], ah, closes, pmi, calendar: Array.isArray(CALENDAR) ? CALENDAR : [], now });
  return { ok: read.verdict !== 'unknown', at: now.toISOString(), ...read, sources, pmiSource: pmi?.ok ? pmi.source : null };
}
