// lib/gexImage.js — the ladder as a picture, because the ladder as text wrapped.
//
// The fenced ladder was right on a desktop and wrong on a phone: Discord wraps a code block at
// the screen's width, so "above  745 (Oct-02) · 748 (Sep-25) · 750 (Oct-16)" became four lines
// with the label on the first and the strikes falling off the end, and eight such lines per
// instrument was harder to read than the prose it replaced. A price ladder is a picture; it is
// drawn as one.
//
// ONE IMAGE PER INSTRUMENT, portrait, large type. Discord scales an attachment to the screen, so
// a 1200px-wide landscape at 13px type is unreadable on a phone. 820px wide with 18–26px type
// lands at roughly ten to twelve pixels on a phone, and a tap opens it full size.
//
// WHAT IS DRAWN. The strikes inside the ladder's window as a vertical price axis; net gamma per
// strike as horizontal bars, green positive (hedging leans against price) and purple negative
// (leans with it); spot as a blue line; the flip zone as an amber band; the pivot after today's
// expiry as a dashed line; and, beside the bars, the ladder's own nodes with their size, owning
// expiry and kind — ceiling, magnet, cushion, trapdoor. The stack is bracketed on the left. The
// four text lines the brief keeps (stack, pin, book, after) are repeated under the plot so the
// image stands alone when it is saved.
//
// RASTERISED IN PROCESS. resvg compiled to WebAssembly (no native binary, no system fonts), with
// Manrope bundled under data/render — a geometric sans with open, even numerals, chosen over
// Inter on a side-by-side of eight faces (Sep 2026); it carries every sign the image draws
// (± − – → ≥ ½ ·) and tabular figures, and its OFL licence sits beside the files.
// Nothing leaves the function: no chart service, no third party sees the book.
import { readFileSync } from 'node:fs';
import { ladderNodes, negativeStack, shortExpiry, fmtM } from './gexLevels.js';
import { regimeWords, bookWords, nextBox, expectedRange } from './gexBrief.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const kf = (k) => k == null ? '—' : (Number.isInteger(k) ? String(k) : (+k).toFixed(2));
const f2 = (v) => v == null ? '—' : (+v).toFixed(2);

// The palette is the dashboard's, on Discord's dark ground.
export const INK = Object.freeze({
  bg: '#0d1117', panel: '#161b22', grid: '#21262d', text: '#e6edf3', muted: '#8b949e', dim: '#6e7681',
  pos: '#2ea043', neg: '#8957e5', spot: '#58a6ff', flip: '#d29922', pivot: '#c9d1d9',
});
export const IMAGE_W = 820;
export const IMAGE_H = 700;
export const FONT = 'Manrope';
export const FOOT_WRAP = 96;   // characters per footer line before it wraps (the full width at 15px)

// Word-wrap for the footer: the proportional face is narrower than the mono was, but a stack
// sentence can still outrun the width, and a line that runs off the edge is a line nobody reads.
export function wrap(text, max = FOOT_WRAP) {
  const words = String(text || '').split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > max) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}
// The window either side of spot the axis spans, at least. It was 3.2%, which left an empty band
// above the top node on most boards; the nodes now set the range and this is only the floor.
export const LADDER_PCT = 1.2;

// ── THE SVG ──────────────────────────────────────────────────────────────────
export function ladderSvg(r, { today = null, width = IMAGE_W, height = IMAGE_H, vintage = null } = {}) {
  const s = num(r?.spot);
  if (s == null || !(s > 0)) return null;
  const lv = r.levels || null;
  const front = r.decay?.expiringToday ? r.decay.front : today;
  const nodes = (r.byStrike?.length)
    ? ladderNodes(r.byStrike, r.grid, { spot: s, levels: lv, callWall: r.callWall, pivotAfter: r.decay?.after?.flip ?? null, today: front })
    : { above: [], below: [] };
  const st = r.byStrike?.length ? negativeStack(r.byStrike, { spot: s }) : null;

  // The footer first, because its height decides the plot's: a stack sentence that wraps takes a
  // line the plot has to give up, or the last line lands on the caption.
  const foot = [];
  if (st) {
    if (st.touching) foot.push(`stack negative ${kf(st.lo)}–${kf(st.hi)} under spot: through ${kf(st.hi)} hedging accelerates${st.nextPositive ? `, ${st.airPct}% of air to ${kf(st.nextPositive.strike)}` : st.truncated ? ', nothing positive inside 5%' : ''}`);
    else if (st.strikes.length) foot.push(`stack nearest negative run ${kf(st.lo)}–${kf(st.hi)}, ${(((s - st.hi) / s) * 100).toFixed(1)}% below spot`);
    else foot.push(`stack no negative stack under spot${lv?.support?.strike ? `; cushion at ${kf(lv.support.strike)}` : ''}`);
  }
  const e = expectedRange(s, r.iv);
  const pinText = r.pin?.pinned ? `${r.pin.band || f2(s)} (${r.pin.share}% expires today)` : r.pin?.share != null ? `none today (${r.pin.share}% expires)` : 'none today';
  foot.push(`pin ${pinText}${e ? ` · priced for ±${e.pts} (±${e.pct}%)` : ''}`);
  const bw = bookWords(lv, r.callWall);
  if (bw) foot.push(`book ${bw}`);
  const pv = num(r.decay?.after?.flip);
  const after = [];
  // "to", not an arrow: the bundled face has no glyph for → and drew a box.
  if (pv != null && r.flipLevel > 0) after.push(`pivot ${f2(r.flipLevel)} to ${f2(pv)} after today`);
  const nb = r.grid ? nextBox(r.grid, { spot: s, today: front }) : null;
  if (nb?.lo != null) after.push(`${shortExpiry(nb.expiry)} box ${nb.lo === nb.hi ? `at ${kf(nb.lo)}` : `${kf(nb.lo)}–${kf(nb.hi)}`}`);
  if (after.length) foot.push(`after ${after.join(' · ')}`);
  const footLines = foot.map(line => { const m = /^(\w+)\s+(.*)$/.exec(line); return { label: m ? m[1] : null, parts: wrap(m ? m[2] : line) }; });
  const footRows = footLines.reduce((a, f) => a + f.parts.length, 0);

  // ── LAYOUT (redesign, 2026-09-25) ─────────────────────────────────────────
  // Three columns: a price scale, the bars, and a callout column. The bars DIVERGE around a zero
  // line — negative gamma to the left, positive to the right — so direction reads from position,
  // not colour alone. Only the ladder's nodes carry labels, and their bars are drawn at full
  // strength with the rest faded, so a board of dollar-wide strikes is not a wall of unlabelled
  // bars. Each label is a ROW in the callout column — strike and annotation together — joined to
  // its bar by a short leader, so crowding near spot moves the row, never the price it names.
  const padT = 84, footH = 28 + footRows * 22 + 48;
  const plotX = 24, plotW = width - 48, plotY = padT, plotH = height - padT - footH;
  const scaleX = plotX + 56;               // price-scale labels end here (right-aligned)
  const barL = plotX + 68, barR = plotX + 380;
  const zeroX = (barL + barR) / 2, half = (barR - barL) / 2 - 4;
  const colX = barR + 20;                  // callout column
  const annX = colX + 58;

  // Domain: the ladder's nodes and spot, with a floor so a quiet board is not a blow-up of noise.
  const ks = [...nodes.above.map(n => n.strike), ...nodes.below.map(n => n.strike), s].filter(Number.isFinite);
  let hi = Math.max(s * (1 + LADDER_PCT / 100), ...ks), lo = Math.min(s * (1 - LADDER_PCT / 100), ...ks);
  const padY = (hi - lo) * 0.05; hi += padY; lo -= padY;
  const y = (k) => plotY + 26 + ((hi - k) / (hi - lo)) * (plotH - 38);

  const nodeKs = new Set([...nodes.above, ...nodes.below].filter(n => n.kind !== 'pivot').map(n => +n.strike));
  const rows = (Array.isArray(r.byStrike) ? r.byStrike : [])
    .map(x => ({ strike: num(x?.strike), net: num(x?.netGexUsd) }))
    .filter(x => x.strike != null && x.net != null && x.strike >= lo && x.strike <= hi)
    .sort((a, b) => a.strike - b.strike);
  const maxAbs = rows.reduce((a, x) => Math.max(a, Math.abs(x.net)), 0) || 1;
  const gaps = rows.slice(1).map((x, i) => Math.abs(y(x.strike) - y(rows[i].strike))).filter(g => g > 0);
  const barH = Math.max(3, Math.min(13, gaps.length ? Math.min(...gaps) - 2 : 12));

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">`);
  out.push(`<rect width="${width}" height="${height}" fill="${INK.bg}"/>`);
  out.push(`<text x="24" y="40" font-size="28" font-weight="700" fill="${INK.text}">${esc(r.name)} ${esc(f2(s))}</text>`);
  out.push(`<text x="24" y="66" font-size="16" fill="${INK.muted}">${esc(regimeWords(r))}</text>`);
  out.push(`<rect x="${plotX}" y="${plotY}" width="${plotW}" height="${plotH}" rx="8" fill="${INK.panel}"/>`);

  // Price scale: round steps, six to ten of them, as faint gridlines across the bars.
  const span = hi - lo;
  const step = [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 250].find(st => span / st <= 10) || 500;
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
    const ty = y(t).toFixed(1);
    out.push(`<line x1="${barL}" y1="${ty}" x2="${barR}" y2="${ty}" stroke="${INK.grid}" stroke-width="1"/>`);
    out.push(`<text x="${scaleX}" y="${(+ty + 4).toFixed(1)}" font-size="12" text-anchor="end" fill="${INK.dim}">${esc(kf(+t.toFixed(2)))}</text>`);
  }
  // Which side is which, in words, over the bars.
  out.push(`<text x="${barL + 2}" y="${plotY + 15}" font-size="11" fill="${INK.neg}">negative · leans with price</text>`);
  out.push(`<text x="${barR - 2}" y="${plotY + 15}" font-size="11" text-anchor="end" fill="${INK.pos}">positive · leans against</text>`);

  // Flip zone, over the bars only — the callout column stays clean.
  const zlo = num(r.flipZoneLo), zhi = num(r.flipZoneHi);
  if (zlo != null && zhi != null && zhi > lo && zlo < hi) {
    const yTop = y(Math.min(hi, zhi)), yBot = y(Math.max(lo, zlo));
    out.push(`<rect x="${barL}" y="${yTop.toFixed(1)}" width="${barR - barL}" height="${Math.max(2, yBot - yTop).toFixed(1)}" fill="${INK.flip}" fill-opacity="0.13"/>`);
  }
  out.push(`<line x1="${zeroX}" y1="${plotY + 22}" x2="${zeroX}" y2="${plotY + plotH - 6}" stroke="${INK.muted}" stroke-width="1" stroke-opacity="0.5"/>`);
  // Bars: nodes at full strength, the rest faded to context.
  for (const x of rows) {
    const w = Math.max(1, (Math.abs(x.net) / maxAbs) * half);
    const bx = x.net >= 0 ? zeroX : zeroX - w;
    out.push(`<rect x="${bx.toFixed(1)}" y="${(y(x.strike) - barH / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${barH}" rx="2" fill="${x.net >= 0 ? INK.pos : INK.neg}" fill-opacity="${nodeKs.has(x.strike) ? 0.95 : 0.3}"/>`);
  }
  // The stack bracket, between the scale and the bars.
  if (st?.touching && st.lo != null) {
    const yT = Math.max(plotY, y(st.hi) - barH / 2), yB = Math.min(plotY + plotH, y(st.lo) + barH / 2);
    out.push(`<rect x="${barL - 8}" y="${yT.toFixed(1)}" width="5" height="${(yB - yT).toFixed(1)}" rx="2" fill="${INK.neg}"/>`);
  }
  if (pv != null && pv > lo && pv < hi) {
    out.push(`<line x1="${barL}" y1="${y(pv).toFixed(1)}" x2="${barR}" y2="${y(pv).toFixed(1)}" stroke="${INK.pivot}" stroke-width="1.5" stroke-dasharray="6 5" stroke-opacity="0.7"/>`);
  }
  out.push(`<line x1="${barL}" y1="${y(s).toFixed(1)}" x2="${barR + 8}" y2="${y(s).toFixed(1)}" stroke="${INK.spot}" stroke-width="2"/>`);

  // ── THE CALLOUT COLUMN ──────────────────────────────────────────────────────
  // One spacing pass over every row — spot, pivot and flip zone included — top-down to a minimum
  // gap, then slid up if it ran off the foot. Each row keeps its strike beside its words and a
  // leader back to where its bar actually is.
  const own = (e) => e ? (e === front ? 'today' : shortExpiry(e)) : null;
  const labels = [{ k: s, text: 'spot', tone: INK.spot, spot: true }];
  if (pv != null && pv > lo && pv < hi) labels.push({ k: pv, text: `pivot after today ${f2(pv)}`, tone: INK.pivot, aux: true });
  if (zlo != null && zhi != null && zhi > lo && zlo < hi) labels.push({ k: Math.min(hi, zhi), text: `flip zone ${f2(zlo)}–${f2(zhi)}`, tone: INK.flip, aux: true });
  for (const n of nodes.above) {
    const kind = n.wall ? `${lv?.callWall?.kind || 'call wall'} · ${n.peaks?.agree ?? 0} of ${n.peaks?.total ?? 0}` : (own(n.expiry) || '');
    labels.push({ k: n.strike, text: `${fmtM(n.netGexUsd)}${kind ? ` · ${kind}` : ''}`, tone: INK.pos });
  }
  for (const n of nodes.below) {
    if (n.kind === 'pivot') continue;
    const kind = n.kind === 'support' ? `cushion · peaks ${n.peaks?.agree ?? 0} of ${n.peaks?.total ?? 0}`
      : n.magnet ? 'magnet'
      : (lv?.trapdoor?.near?.strike === n.strike || lv?.trapdoor?.deep?.strike === n.strike) ? 'trapdoor' : '';
    labels.push({ k: n.strike, text: `${fmtM(n.netGexUsd)}${own(n.expiry) ? ` ${own(n.expiry)}` : ''}${kind ? ` · ${kind}` : ''}`, tone: n.kind === 'support' || (n.netGexUsd ?? 0) >= 0 ? INK.pos : INK.neg });
  }
  const MAX_ANNOT = 38;
  for (const l of labels) if (l.text && l.text.length > MAX_ANNOT) l.text = l.text.slice(0, MAX_ANNOT - 1) + '…';
  labels.sort((a, b) => b.k - a.k);
  const minGap = 21;
  let lastY = -Infinity;
  for (const l of labels) {
    let ly = y(l.k);
    if (ly - lastY < minGap) ly = lastY + minGap;
    l.y = ly; lastY = ly;
  }
  const over = lastY - (plotY + plotH - 10);
  if (over > 0) for (const l of labels) l.y -= over;
  for (const l of labels) {
    const yb = y(l.k);
    // The leader: from the bars' edge at the true price to the row. Always drawn, so the row reads
    // as attached to a place on the scale even when nothing had to move.
    out.push(`<path d="M${barR + 2} ${yb.toFixed(1)} L${barR + 10} ${yb.toFixed(1)} L${colX - 4} ${l.y.toFixed(1)}" fill="none" stroke="${l.tone}" stroke-width="1" stroke-opacity="0.55"/>`);
    if (l.spot) {
      out.push(`<text x="${colX}" y="${(l.y + 6).toFixed(1)}" font-size="17" font-weight="700" fill="${INK.spot}">${esc(f2(s))}</text>`);
      // After the price's own width — a five-figure spot ran into a fixed column ("746.06spot").
      const spotW = f2(s).length * 10.4 + 10;
      out.push(`<text x="${Math.max(annX, colX + spotW).toFixed(0)}" y="${(l.y + 6).toFixed(1)}" font-size="15" font-weight="600" fill="${INK.spot}">spot</text>`);
      continue;
    }
    if (l.aux) { out.push(`<text x="${colX}" y="${(l.y + 5).toFixed(1)}" font-size="13" fill="${l.tone}">${esc(l.text)}</text>`); continue; }
    out.push(`<text x="${colX}" y="${(l.y + 6).toFixed(1)}" font-size="17" font-weight="700" fill="${INK.text}">${esc(kf(l.k))}</text>`);
    out.push(`<text x="${annX}" y="${(l.y + 6).toFixed(1)}" font-size="15" font-weight="600" fill="${l.tone}">${esc(l.text)}</text>`);
  }

  // Footer: the lines built above, label in bold, wrapped.
  let fy = plotY + plotH + 28;
  for (const f of footLines) {
    f.parts.forEach((p, i) => {
      out.push(`<text x="24" y="${fy}" font-size="15" fill="${INK.text}">${i === 0 && f.label ? `<tspan font-weight="700">${esc(f.label)}</tspan> ` : ''}${esc(p)}</text>`);
      fy += 22;
    });
  }
  out.push(`<text x="24" y="${height - 30}" font-size="12" fill="${INK.dim}">green = positive gamma, hedging leans against price · purple = negative, leans with it</text>`);
  out.push(`<text x="24" y="${height - 12}" font-size="12" fill="${INK.dim}">${esc(vintage || 'settled open interest at the live spot')}</text>`);
  out.push('</svg>');
  return out.join('\n');
}

// ── THE PNG ──────────────────────────────────────────────────────────────────
// The wasm and the fonts are read from the repository, never the system: a Vercel function has
// no fonts and would render every label as a box.
let wasmReady = null;
async function engine() {
  if (!wasmReady) {
    wasmReady = (async () => {
      const mod = await import('@resvg/resvg-wasm');
      try { await mod.initWasm(readFileSync(new URL('../data/render/resvg.wasm', import.meta.url))); }
      catch (e) { if (!/already/i.test(String(e?.message || e))) throw e; }
      return mod;
    })();
  }
  return wasmReady;
}
let fontsCache = null;
function fonts() {
  if (!fontsCache) {
    fontsCache = ['Manrope_400Regular.ttf', 'Manrope_600SemiBold.ttf', 'Manrope_700Bold.ttf']
      .map(f => new Uint8Array(readFileSync(new URL(`../data/render/${f}`, import.meta.url))));
  }
  return fontsCache;
}

export async function renderPng(svg, { width = IMAGE_W } = {}) {
  if (!svg) return null;
  const { Resvg } = await engine();
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: INK.bg,
    font: { fontBuffers: fonts(), defaultFontFamily: FONT, loadSystemFonts: false },
  });
  const img = r.render();
  const png = img.asPng();
  img.free?.(); r.free?.();
  return png;
}

// One file per instrument, ready for the webhook. A row that cannot be drawn is skipped, never
// faked; an empty list means the text goes out alone.
export async function ladderImages(rows = [], opts = {}) {
  const files = [];
  for (const r of rows) {
    const svg = ladderSvg(r, opts);
    if (!svg) continue;
    const bytes = await renderPng(svg);
    if (bytes?.length) files.push({ filename: `${String(r.name || 'ladder').replace(/[^A-Za-z0-9._-]/g, '')}-ladder.png`, bytes, name: r.name });
  }
  return files;
}
