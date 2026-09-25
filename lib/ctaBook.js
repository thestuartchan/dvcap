// lib/ctaBook.js — the CTA replica for every market, with the CFTC check, cached.
import { yahooDailyOHLCDetailed } from './yahoo.js';
import { kvGetJson, kvSetJsonEx, kvConfigured } from './kv.js';
import { marketState } from './sessions.js';
import { CTA_MARKETS, ctaMarket, ctaSummary, nearestCut, positionOn } from './cta.js';
import { fetchCot, cotRead, weekCheck, cotTrack, calibrationSummary, COT_MARKETS } from './cot.js';

// ── ?cta=1 — THE TREND-FUND REPLICA ──────────────────────────────────────────
// Shared by /api/atr?cta=1 (the Daily tab) and the pre-reads, so both read one cached model. Two
// years of daily closes for six markets, one after another with a small gap (Yahoo throttles a
// burst), then lib/cta.js. Cached for half an hour: the model moves with the tape, but a trend
// fund's position does not change minute to minute and six chart fetches are not free.
const CTA_KEY = 'dvcap:cta:v2';
// The CFTC report is weekly, so it is cached far longer than the replica and on its own key: a
// replica refresh every half hour should not re-ask the CFTC for three years of Tuesdays.
const COT_KEY = 'dvcap:cot:v1';
const COT_TTL_S = 6 * 60 * 60;
async function cachedCot() {
  if (kvConfigured()) {
    try { const c = await kvGetJson(COT_KEY); if (c?.at && Date.now() - Date.parse(c.at) < COT_TTL_S * 1000) return c; } catch { /* a miss */ }
  }
  const f = await fetchCot().catch(e => ({ ok: false, error: String(e?.message || e), series: {} }));
  const out = { ...f, at: new Date().toISOString() };
  if (f.ok && kvConfigured()) { try { await kvSetJsonEx(COT_KEY, out, COT_TTL_S); } catch { /* uncached is slower, not wrong */ } }
  return out;
}
const CTA_TTL_S = 30 * 60;
export async function buildCta() {
  if (kvConfigured()) {
    try {
      const c = await kvGetJson(CTA_KEY);
      if (c?.at && Date.now() - Date.parse(c.at) < CTA_TTL_S * 1000) {
        // THE CACHE HOLDS THE MARKET, NOT THE JUDGEMENT. The key level is re-derived on every read,
        // so a change to how it is chosen takes effect at once instead of half an hour later — on
        // 2026-09-25 the net-flat rule for neutral markets shipped and the brief still carried gold's
        // old three-month level until the cached book expired.
        const markets = (c.markets || []).map(m => (m?.ok ? { ...m, cut: nearestCut(m) } : m));
        return { ...c, markets, summary: ctaSummary(markets), cache: 'kv' };
      }
    } catch { /* a miss */ }
  }
  const markets = [];
  const cot = await cachedCot();
  for (const [i, m] of CTA_MARKETS.entries()) {
    if (i > 0) await new Promise(r => setTimeout(r, 150));
    // Five years, not two: the CFTC record below rebuilds the replica on each of the last 52
    // Tuesdays, and each rebuild needs its own year and a quarter of history behind it.
    const d = await yahooDailyOHLCDetailed(m.symbol, '5y').catch(() => null);
    const base = { key: m.key, symbol: m.symbol, label: m.label, group: m.group, roll: m.roll };
    if (!d?.ok) { markets.push({ ...base, ok: false, reason: d?.status || 'fetch failed' }); continue; }
    const live = marketState(m.sessionSymbol || m.symbol) === 'open';
    const r = ctaMarket(d.bars.map(b => b.close), { live });
    // The week the CFTC last reported, and whether it bears the replica out — Tuesday against
    // Tuesday, the replica rebuilt as it stood on each.
    const cm = COT_MARKETS.find(x => x.key === m.key);
    const read = cot.ok ? cotRead(cot.series?.[m.key] || []) : null;
    const posAt = (date) => positionOn(d.bars, date);
    const check = read ? weekCheck(read, posAt) : null;
    const track = read ? cotTrack(cot.series?.[m.key] || [], posAt) : null;
    markets.push({ ...base, date: d.bars.at(-1)?.date ?? null, ...r, cut: r.ok ? nearestCut(r) : null,
                   cot: read ? { trader: cm?.trader ?? null, ...read, ...check, track } : null });
  }
  const checks = markets.map(m => (m.cot ? { key: m.key, date: m.cot.date, week: m.cot.week, track: m.cot.track } : null));
  const out = { ok: markets.some(m => m.ok), markets, summary: ctaSummary(markets),
                calibration: cot.ok ? calibrationSummary(checks) : { error: cot.error || 'CFTC unavailable' },
                at: new Date().toISOString() };
  if (out.ok && kvConfigured()) { try { await kvSetJsonEx(CTA_KEY, out, CTA_TTL_S); } catch { /* uncached is slower, not wrong */ } }
  return out;
}
