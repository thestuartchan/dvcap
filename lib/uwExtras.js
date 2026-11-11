// lib/uwExtras.js — three Unusual Whales reads after the main build (11 Nov 2026):
//   1. SHORTS   short interest, days to cover, borrow fee, short-volume ratio and failures to deliver
//               for the Desk and Trading Ideas names: squeeze context, once a New York day
//   2. DARK POOL big off-exchange prints near the Desk's rule levels, after the close (private card)
//   3. SECTORS  options flow on the 11 sector ETFs: where money leaned today. Shown, never voted
// LICENSED FOR PERSONAL USE: the dashboard session and the private channel only. Job answers carry
// counts and states, never a UW number. `get` is uwGet (tests pass a fake).
import { usdShort, usTickerOf, dayLabel } from './uw.js';

const num = (v) => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
const rowsOf = (a, key = 'data') => (Array.isArray(a) ? a : Array.isArray(a?.[key]) ? a[key] : Array.isArray(a?.data) ? a.data : null);
const byDateDesc = (k) => (a, b) => String(b?.[k] || '').localeCompare(String(a?.[k] || ''));
const avg = (xs) => { const v = xs.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

// ── 1. SHORTS ────────────────────────────────────────────────────────────────
// Display bands, not signals: crowded = short ≥ 20% of float, or ≥ 5 days to cover, or borrow ≥ 10%/yr;
// elevated = ≥ 10% of float, or ≥ 3 days, or borrow ≥ 3%/yr. FINRA short interest lags 2–4 weeks.
export const SHORT_BANDS = Object.freeze({ crowded: { si: 0.20, dtc: 5, fee: 10 }, elevated: { si: 0.10, dtc: 3, fee: 3 } });
export function squeezeWord(r, b = SHORT_BANDS) {
  if (!r || (r.siFloat == null && r.daysToCover == null && r.fee == null)) return null;
  const over = (t) => (r.siFloat ?? -1) >= t.si || (r.daysToCover ?? -1) >= t.dtc || (r.fee ?? -1) >= t.fee;
  return over(b.crowded) ? 'crowded' : over(b.elevated) ? 'elevated' : 'normal';
}
export function shortInterestOf(answer) {
  const r = (rowsOf(answer) || []).slice().sort(byDateDesc('market_date'))[0];
  return r ? { date: r.market_date || null, siFloat: num(r.si_float), daysToCover: num(r.days_to_cover), float: num(r.total_float), shares: num(r.short_interest) } : null;
}
export function shortVolumeOf(answer, days = 20) {
  const rows = (rowsOf(answer, 'si') || []).slice().sort(byDateDesc('market_date'));
  if (!rows.length) return null;
  return { date: rows[0].market_date || null, ratio: num(rows[0].short_volume_ratio), avg: avg(rows.slice(0, days).map(r => num(r.short_volume_ratio))) };
}
export function ftdOf(answer, days = 20) {
  const rows = (rowsOf(answer) || []).slice().sort(byDateDesc('date'));
  if (!rows.length) return null;
  return { date: rows[0].date || null, qty: num(rows[0].quantity), avg: avg(rows.slice(0, days).map(r => num(r.quantity))) };
}
export function borrowOf(answer) {
  const r = (rowsOf(answer) || []).slice().sort(byDateDesc('timestamp'))[0];
  return r ? { at: r.timestamp || null, fee: num(r.fee_rate), available: num(r.short_shares_available) } : null;
}
export async function shortRow({ ticker, get }) {
  const T = encodeURIComponent(ticker);
  const parts = {};
  const run = async (name, fn) => { try { const v = await fn(); parts[name] = v == null ? 'empty' : 'ok'; return v; } catch (e) { parts[name] = String(e?.message || e).slice(0, 40); return null; } };
  const si = await run('interest', async () => shortInterestOf(await get(`/api/shorts/${T}/interest-float/v2`)));
  const sv = await run('volume', async () => shortVolumeOf(await get(`/api/shorts/${T}/volume-and-ratio`)));
  const ftd = await run('ftds', async () => ftdOf(await get(`/api/shorts/${T}/ftds`)));
  const bw = await run('borrow', async () => borrowOf(await get(`/api/shorts/${T}/data`)));
  const row = { ticker, parts, siDate: si?.date ?? null, siFloat: si?.siFloat ?? null, daysToCover: si?.daysToCover ?? null,
    svRatio: sv?.ratio ?? null, svAvg: sv?.avg ?? null, ftdDate: ftd?.date ?? null, ftd: ftd?.qty ?? null, ftdAvg: ftd?.avg ?? null,
    fee: bw?.fee ?? null, available: bw?.available ?? null };
  row.read = squeezeWord(row);
  return row;
}
export async function shortsBoard({ tickers, get, now = new Date(), concurrency = 4 }) {
  const rows = [];
  const queue = [...tickers];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) { const t = queue.shift(); rows.push(await shortRow({ ticker: t, get })); }
  }));
  const rank = { crowded: 0, elevated: 1, normal: 2 };
  rows.sort((a, b) => (rank[a.read] ?? 3) - (rank[b.read] ?? 3) || (b.siFloat ?? -1) - (a.siFloat ?? -1));
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now instanceof Date ? now : new Date(now));
  return { at: (now instanceof Date ? now : new Date(now)).toISOString(), day, rows };
}

// ── 2. DARK POOL AT THE DESK'S LEVELS ────────────────────────────────────────
// Prints of $1M+ within 0.5% of a rule's level, on the rule's own ticker, today. Context only.
export const DP_LEVELS = Object.freeze({ minPremium: 1e6, bandPct: 0.5 });
const KIND = { stop: 'Stop', tp: 'Take profit', add: 'Add', exit: 'Exit', review: 'Review' };
export function deskLevels(mirror) {
  const out = [];
  for (const p of mirror?.positions || []) for (const r of p.rules || []) {
    const t = usTickerOf(r.symbol), level = num(r.level);
    if (t && level != null && level > 0) out.push({ ticker: t, level, kind: r.kind, name: p.name || t });
  }
  return out;
}
export function printsNear(prints, level, { band = DP_LEVELS.bandPct, min = DP_LEVELS.minPremium } = {}) {
  const near = (prints || []).filter(x => !x.canceled && num(x.premium) >= min && num(x.price) != null && Math.abs(num(x.price) / level - 1) * 100 <= band);
  if (!near.length) return null;
  const big = near.reduce((a, b) => (num(b.premium) > num(a.premium) ? b : a));
  return { count: near.length, total: near.reduce((s, x) => s + num(x.premium), 0), biggest: { price: num(big.price), premium: num(big.premium) } };
}
export async function darkpoolAtLevels({ mirror, get, day }) {
  const levels = deskLevels(mirror);
  const tickers = [...new Set(levels.map(l => l.ticker))].slice(0, 40);
  const hits = [];
  let fetched = 0;
  for (const t of tickers) {
    let prints;
    try { prints = rowsOf(await get(`/api/darkpool/${encodeURIComponent(t)}`, { query: { date: day, min_premium: DP_LEVELS.minPremium, limit: 500 } })); fetched++; } catch { continue; }
    for (const l of levels.filter(x => x.ticker === t)) {
      const n = printsNear(prints, l.level);
      if (n) hits.push({ ...l, ...n });
    }
  }
  return { day, levels: levels.length, tickers: tickers.length, fetched, hits };
}
const lvl = (v) => (v == null ? '—' : v.toFixed(2));
export function darkpoolCard(res) {
  if (!res?.hits?.length) return null;
  const fields = res.hits.sort((a, b) => b.total - a.total).slice(0, 15).map(h => ({
    name: `${h.name}`.slice(0, 256),
    value: `${KIND[h.kind] || h.kind || 'Level'} ${lvl(h.level)}: **${usdShort(h.total).replace('+', '')}** across ${h.count} block${h.count === 1 ? '' : 's'} within ${DP_LEVELS.bandPct}% · biggest ${usdShort(h.biggest.premium).replace('+', '')} at ${lvl(h.biggest.price)}`,
    inline: false }));
  return {
    allowed_mentions: { parse: [] },
    embeds: [{ title: `🐋 Dark pool at your Desk levels · ${dayLabel(res.day)}`, color: 0x8E6CD8, fields,
      description: `Off-exchange prints of $1M+ within ${DP_LEVELS.bandPct}% of a rule level today. Big blocks show where size traded, not which way. Context, not a signal.`,
      footer: { text: 'Unusual Whales · personal use · private channel only' } }],
  };
}

// ── 3. SECTOR FLOW ───────────────────────────────────────────────────────────
// One call: UW's sector ETF board. Net = bullish minus bearish premium (UW's own split by trade side).
export function sectorFlow(answer) {
  const rows = (rowsOf(answer) || []).filter(r => r?.ticker && r.ticker !== 'SPY').map(r => {
    const bull = num(r.bullish_premium), bear = num(r.bearish_premium), last = num(r.last), prev = num(r.prev_close);
    return { ticker: r.ticker, name: r.full_name || r.ticker, net: bull != null && bear != null ? bull - bear : null,
      callPrem: num(r.call_premium), putPrem: num(r.put_premium), chg: last != null && prev ? last / prev - 1 : null };
  });
  if (!rows.length) return null;
  return rows.sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity));
}
