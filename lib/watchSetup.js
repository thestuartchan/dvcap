// lib/watchSetup.js — "where is a move set up but not made", from public market data only.
//
// ── WHY THE MOVERS LIST HAD TO GO ────────────────────────────────────────────
// The watchlist ranked the region's universe by yesterday's close-to-close move and kept the five
// biggest. At 08:49 ET that is a list of things that already happened; a day trader reading it is
// looking for a move that is already done. The names it surfaced were exactly the ones with the
// least left in them.
//
// So the list is built from four MEASUREMENTS, each of which is a checkable fact about the name
// this morning rather than a rating of the setup — the same rule lib/watchlist.js keeps, because
// a quality score shades into advice and the pre-read is a public channel:
//
//   GAPPING     the pre-market print against the prior close, when the session has not opened
//   COILED      the 14-day ATR at a low percentile of its own 250-day history, or yesterday's
//               range the narrowest of the last seven
//   AT A LEVEL  within half an ATR of yesterday's high or low, the 52-week high or low, or the
//               50/200-day average
//   CATALYST    earnings today or tomorrow, from the same cached feed the sizer uses
//
// Ranked by how many of the four a name carries, then by the size of the gap, then by how tight
// the coil is. Yesterday's movers survive as ONE line marked "extended", with the move in ATRs, so
// the reader knows the thing is stretched rather than set up.
//
// NOTHING FROM THE BOOK. Candidates are the region's configured universe; no argument reaches
// this file through which a holding could.
import { atrSeries } from './atr.js';
import { percentileOf } from './benchmarks.js';
import { watchName, watchLevels } from '../data/watchMeta.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

export const SETUP_MAX = 5;
export const GAP_MIN_PCT = 0.75;        // below this a pre-market print is drift, not a gap
export const COIL_PCTILE_MAX = 25;      // ATR at or under this percentile of its year is coiled
export const LEVEL_MAX_ATR = 0.5;       // within this many ATRs of a level counts as "at" it
export const EXTENDED_MIN_ATR = 2.0;    // yesterday's move in ATRs past which a name is extended
export const CANDIDATE_MAX = 10;        // how many names the earnings feed is asked about

// ── THE STATS, FROM THE BARS ONE QUOTE FETCH ALREADY CARRIES ─────────────────
// `bars` are daily {date, high, low, close}, oldest first, as lib/yahoo.js hands them over. A bar
// DATED TODAY is the session in progress and is dropped; everything else is complete. Measured on
// SOFI at 14:00 ET on 2026-09-23: Yahoo's daily chart ended at 09-22 with no partial bar for the
// day, so "the market is open, drop the last bar" threw away the last COMPLETE session and made
// yesterday the 21st. The bar's own date is the only reliable test.
export function setupStats(bars = [], { today = null } = {}) {
  const rows = (Array.isArray(bars) ? bars : [])
    .filter(b => num(b?.high) != null && num(b?.low) != null && num(b?.close) != null);
  if (rows.length < 15) return null;
  const complete = (today && rows[rows.length - 1]?.date === today) ? rows.slice(0, -1) : rows;
  if (complete.length < 15) return null;
  const y = complete[complete.length - 1];          // yesterday: the last complete session
  const series = atrSeries(complete, 14);
  const last = series[series.length - 1];
  const atr = num(last?.atr);
  if (atr == null || !(atr > 0)) return null;
  const atrs = series.map(s => s.atr).slice(-250);
  const ranges = complete.slice(-7).map(b => b.high - b.low);
  const yRange = y.high - y.low;
  const hi52 = Math.max(...complete.slice(-252).map(b => b.high));
  const lo52 = Math.min(...complete.slice(-252).map(b => b.low));
  const prev = complete[complete.length - 2];
  const closes = complete.map(b => b.close);
  const sma = (n) => closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : null;
  return {
    atr: +atr.toFixed(4),
    atrPct: +((atr / y.close) * 100).toFixed(2),
    // Where today's ATR sits in its own year. percentileOf wants at least 30 readings.
    atrPctile: percentileOf(atr, atrs, 30),
    // STRICTLY the narrowest: a flat tape where every day is the same width is not coiling, and a
    // tie would tag every quiet name on every quiet day.
    nr7: ranges.length === 7 && yRange < Math.min(...ranges.slice(0, 6)),
    yHigh: +y.high.toFixed(4), yLow: +y.low.toFixed(4), yClose: +y.close.toFixed(4), yDate: y.date ?? null,
    yRangeAtr: +(yRange / atr).toFixed(2),
    // Yesterday's close-to-close move in ATRs: the "extended" measure.
    yMoveAtr: prev?.close ? +((y.close - prev.close) / atr).toFixed(2) : null,
    hi52: +hi52.toFixed(4), lo52: +lo52.toFixed(4),
    ma50: sma(50) == null ? null : +sma(50).toFixed(4),
    ma200: sma(200) == null ? null : +sma(200).toFixed(4),
    bars: complete.length,
  };
}

// ── THE TAGS ─────────────────────────────────────────────────────────────────
// Each is a sentence the reader can check against a chart. `row` is a quote row with `setup`
// (above) and, before a US open, `ext` from the pre-market overlay.
const pct = (v) => `${v > 0 ? '+' : ''}${(+v).toFixed(1)}%`;
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

export function setupTags(row, { earnings = null, today = null, tomorrow = null } = {}) {
  const tags = [];
  const s = row?.setup;
  const ref = num(row?.ext?.price) ?? num(row?.price);
  // GAPPING. Only a pre-market print, only when live, only when it is a gap and not drift.
  const ext = row?.ext;
  if (ext && !ext.stale && ext.session === 'pre' && num(ext.changePct) != null && Math.abs(ext.changePct) >= GAP_MIN_PCT) {
    tags.push({ kind: 'gap', pct: +ext.changePct, text: `gapping ${pct(ext.changePct)} pre-market` });
  }
  if (s) {
    // COILED. Either measure earns the tag; both are said when both hold.
    const coil = [];
    if (s.atrPctile != null && s.atrPctile <= COIL_PCTILE_MAX) coil.push(s.atrPctile <= 1 ? '14-day range the lowest of its year' : `14-day range at the ${ordinal(s.atrPctile)} percentile of its year`);
    if (s.nr7) coil.push('narrowest day in 7');
    if (coil.length) tags.push({ kind: 'coil', pctile: s.atrPctile ?? 100, text: `coiled: ${coil.join(', ')}` });
    // AT A LEVEL. The nearest of the named levels, if it is inside half an ATR.
    if (ref != null && s.atr > 0) {
      const levels = [
        ['yesterday\'s high', s.yHigh], ['yesterday\'s low', s.yLow],
        ['the 52-week high', s.hi52], ['the 52-week low', s.lo52],
        ['the 50-day average', s.ma50], ['the 200-day average', s.ma200],
      ].filter(([, v]) => num(v) != null)
        .map(([name, v]) => ({ name, v, d: (ref - v) / s.atr }))
        .filter(l => Math.abs(l.d) <= LEVEL_MAX_ATR)
        .sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
      if (levels.length) {
        const l = levels[0];
        const side = Math.abs(l.d) < 0.05 ? 'at' : l.d > 0 ? `${Math.abs(l.d).toFixed(1)} ATR over` : `${Math.abs(l.d).toFixed(1)} ATR under`;
        tags.push({ kind: 'level', atr: +Math.abs(l.d).toFixed(2), text: `${side} ${l.name} (${fmtPx(l.v)})` });
      }
    }
  }
  // CATALYST. From the cached earnings feed, candidates only — the caller decides who to ask.
  const e = earnings;
  if (e?.ok && e.date && today) {
    if (e.date === today) tags.push({ kind: 'catalyst', text: `earnings today${e.time ? ` (${e.time})` : ''}${e.status === 'estimated' ? ', estimated' : ''}` });
    else if (tomorrow && e.date === tomorrow) tags.push({ kind: 'catalyst', text: `earnings tomorrow${e.time ? ` (${e.time})` : ''}${e.status === 'estimated' ? ', estimated' : ''}` });
  }
  return tags;
}

const fmtPx = (v) => v == null ? '—' : v >= 1000 ? Math.round(v).toLocaleString() : (+v).toFixed(2);

// Which names are worth asking the earnings feed about: anything already carrying a tag, capped.
export function setupCandidates(rows = [], opts = {}) {
  return rows
    .map(r => ({ row: r, tags: setupTags(r, opts) }))
    .filter(x => x.tags.length)
    .sort((a, b) => b.tags.length - a.tags.length)
    .slice(0, CANDIDATE_MAX)
    .map(x => x.row.sym);
}

// ── THE LIST ─────────────────────────────────────────────────────────────────
// `rows` are quote rows for the region's universe: { sym, price, changePct, ext?, setup? }.
// `earnings` maps sym → the cached feed answer, for the candidates the caller asked about.
export function setups(rows = [], { earnings = {}, today = null, tomorrow = null, max = SETUP_MAX } = {}) {
  const out = [];
  for (const r of rows) {
    if (!r?.sym || num(r.price) == null) continue;
    const tags = setupTags(r, { earnings: earnings[r.sym] || null, today, tomorrow });
    if (!tags.length) continue;
    const gap = tags.find(t => t.kind === 'gap')?.pct ?? 0;
    const coil = tags.find(t => t.kind === 'coil')?.pctile ?? 100;
    // The industry, narrowest level first — "semis" over "tech" — so the reader knows what kind
    // of name it is before reading why it is set up.
    out.push({ sym: r.sym, name: watchName(r.sym), industry: watchLevels(r.sym)[0] || null, price: num(r.ext?.price) ?? num(r.price), tags, gap, coil });
  }
  return out
    .sort((a, b) => b.tags.length - a.tags.length || Math.abs(b.gap) - Math.abs(a.gap) || a.coil - b.coil)
    .slice(0, max);
}

// Yesterday's movers, said as what they are: stretched. One line, in ATRs where the ATR is known.
export function extendedLine(movers = [], rowsBySym = new Map()) {
  const bits = [];
  for (const m of movers) {
    const s = rowsBySym.get(m.sym)?.setup;
    const inAtr = s?.atr > 0 && num(m.price) != null && num(m.changePct) != null
      ? Math.abs((m.price * (m.changePct / 100)) / (1 + m.changePct / 100)) / s.atr : null;
    const ext = inAtr != null && inAtr >= EXTENDED_MIN_ATR;
    if (!ext) continue;
    bits.push(`${m.name} ${pct(m.changePct)} (${inAtr.toFixed(1)} ATR)`);
  }
  return bits.length ? `_extended after yesterday, not a setup: ${bits.join(' · ')}_` : null;
}

export function renderSetups(list = [], { extended = null } = {}) {
  const lines = list.map(r => {
    const ident = r.sym !== r.name ? `**${r.name}** \`${r.sym}\`` : `**${r.name}**`;
    const ind = r.industry ? ` · _${r.industry}_` : '';
    return `• ${ident} · ${fmtPx(r.price)}${ind} — ${r.tags.map(t => t.text).join(' · ')}`;
  });
  if (extended) lines.push(extended);
  return lines.length ? lines.join('\n') : null;
}
