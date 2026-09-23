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
// IBM Plex Mono bundled under data/render — the OFL licence sits beside the files. Nothing leaves
// the function: no chart service, no third party sees the book.
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
export const IMAGE_H = 680;
export const LADDER_PCT = 3.2;   // the window either side of spot the axis spans, at least

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

  // Layout.
  const padL = 96, padR = 24, padT = 84, footH = 150;
  const plotX = padL, plotW = width - padL - padR, plotY = padT, plotH = height - padT - footH;
  const axisX = plotX + 70;                // strike labels sit left of this
  const barX0 = axisX + 12;                // bars grow right from here
  const barMax = 250;                      // longest bar, px
  const labelX = barX0 + barMax + 18;      // node annotations

  // Domain: the window, widened to hold every node.
  const ks = [...nodes.above.map(n => n.strike), ...nodes.below.map(n => n.strike), s];
  let hi = Math.max(s * (1 + LADDER_PCT / 100), ...ks), lo = Math.min(s * (1 - LADDER_PCT / 100), ...ks);
  const padY = (hi - lo) * 0.04; hi += padY; lo -= padY;
  const y = (k) => plotY + ((hi - k) / (hi - lo)) * plotH;

  const rows = (Array.isArray(r.byStrike) ? r.byStrike : [])
    .map(x => ({ strike: num(x?.strike), net: num(x?.netGexUsd) }))
    .filter(x => x.strike != null && x.net != null && x.strike >= lo && x.strike <= hi)
    .sort((a, b) => a.strike - b.strike);
  const maxAbs = rows.reduce((a, x) => Math.max(a, Math.abs(x.net)), 0) || 1;
  // Bar height from the strike spacing actually present, capped so a sparse book is not a wall of
  // colour and floored so a dense one is still visible.
  const gaps = rows.slice(1).map((x, i) => Math.abs(y(x.strike) - y(rows[i].strike))).filter(g => g > 0);
  const barH = Math.max(4, Math.min(14, gaps.length ? Math.min(...gaps) - 2 : 12));

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="IBM Plex Mono">`);
  out.push(`<rect width="${width}" height="${height}" fill="${INK.bg}"/>`);
  // Header.
  out.push(`<text x="24" y="40" font-size="28" font-weight="700" fill="${INK.text}">${esc(r.name)} ${esc(f2(s))}</text>`);
  out.push(`<text x="24" y="66" font-size="16" fill="${INK.muted}">${esc(regimeWords(r))}</text>`);
  // Plot ground and grid.
  out.push(`<rect x="${plotX}" y="${plotY}" width="${plotW}" height="${plotH}" rx="8" fill="${INK.panel}"/>`);
  // Flip zone.
  const zlo = num(r.flipZoneLo), zhi = num(r.flipZoneHi);
  if (zlo != null && zhi != null && zhi > lo && zlo < hi) {
    const yTop = y(Math.min(hi, zhi)), yBot = y(Math.max(lo, zlo));
    out.push(`<rect x="${plotX}" y="${yTop.toFixed(1)}" width="${plotW}" height="${Math.max(2, yBot - yTop).toFixed(1)}" fill="${INK.flip}" fill-opacity="0.13"/>`);
    // Labelled at the band's foot, left of the annotations, where nothing else is drawn.
    out.push(`<text x="${axisX + 18}" y="${(yBot - 6).toFixed(1)}" font-size="13" fill="${INK.flip}">flip zone ${esc(f2(zlo))}–${esc(f2(zhi))}</text>`);
  }
  // Zero line for the bars.
  out.push(`<line x1="${barX0}" y1="${plotY}" x2="${barX0}" y2="${plotY + plotH}" stroke="${INK.grid}" stroke-width="1"/>`);
  // Bars.
  for (const x of rows) {
    const w = Math.max(1, (Math.abs(x.net) / maxAbs) * barMax);
    out.push(`<rect x="${barX0}" y="${(y(x.strike) - barH / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${barH}" rx="2" fill="${x.net >= 0 ? INK.pos : INK.neg}" fill-opacity="0.85"/>`);
  }
  // The stack bracket, in the margin left of the plot — inside it, it sat under the spot label.
  if (st?.touching && st.lo != null) {
    const yT = y(st.hi) - barH / 2, yB = y(st.lo) + barH / 2;
    out.push(`<rect x="${plotX - 14}" y="${yT.toFixed(1)}" width="5" height="${(yB - yT).toFixed(1)}" rx="2" fill="${INK.neg}"/>`);
  }
  // Pivot after today.
  const pv = num(r.decay?.after?.flip);
  if (pv != null && pv > lo && pv < hi) {
    out.push(`<line x1="${axisX - 60}" y1="${y(pv).toFixed(1)}" x2="${plotX + plotW - 8}" y2="${y(pv).toFixed(1)}" stroke="${INK.pivot}" stroke-width="1.5" stroke-dasharray="6 5" stroke-opacity="0.7"/>`);
    out.push(`<text x="${axisX + 18}" y="${(y(pv) + 15).toFixed(1)}" font-size="13" fill="${INK.pivot}">pivot after today ${esc(f2(pv))}</text>`);
  }
  // Spot.
  out.push(`<line x1="${plotX}" y1="${y(s).toFixed(1)}" x2="${plotX + plotW}" y2="${y(s).toFixed(1)}" stroke="${INK.spot}" stroke-width="2"/>`);

  // Node labels: the strike on the axis, the annotation beside the bars. EVERY label — spot
  // included — goes through one spacing pass, top-down, pushed apart to a minimum gap; a label
  // that had to move gets a leader line back to its bar. Measured on the 23 Sep board: 740, 739
  // and 738 are a dollar apart, nine pixels at this scale, and overprinted on the axis; the spot
  // label at the right edge landed on 740's annotation.
  const own = (e) => e ? (e === front ? 'today' : shortExpiry(e)) : null;
  const labels = [{ k: s, text: null, tone: INK.spot, spot: true }];
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
  // What fits beside the bars: the column is about thirty-eight characters wide at this size.
  const MAX_ANNOT = 38;
  for (const l of labels) if (l.text && l.text.length > MAX_ANNOT) l.text = l.text.slice(0, MAX_ANNOT - 1) + '…';
  labels.sort((a, b) => b.k - a.k);
  const minGap = 20;
  let lastY = -Infinity;
  for (const l of labels) {
    let ly = y(l.k);
    if (ly - lastY < minGap) ly = lastY + minGap;
    l.y = ly; lastY = ly;
  }
  // If the pass ran off the bottom of the plot, slide the whole column up by the overflow.
  const over = lastY - (plotY + plotH - 8);
  if (over > 0) for (const l of labels) l.y -= over;
  for (const l of labels) {
    const moved = Math.abs(l.y - y(l.k)) > 2;
    if (moved) out.push(`<line x1="${axisX + 3}" y1="${l.y.toFixed(1)}" x2="${barX0}" y2="${y(l.k).toFixed(1)}" stroke="${INK.dim}" stroke-width="1"/>`);
    if (l.spot) {
      out.push(`<text x="${axisX}" y="${(l.y + 6).toFixed(1)}" font-size="16" font-weight="700" text-anchor="end" fill="${INK.spot}">spot ${esc(f2(s))}</text>`);
      continue;
    }
    out.push(`<text x="${axisX}" y="${(l.y + 6).toFixed(1)}" font-size="17" font-weight="700" text-anchor="end" fill="${INK.text}">${esc(kf(l.k))}</text>`);
    out.push(`<text x="${labelX}" y="${(l.y + 6).toFixed(1)}" font-size="15" fill="${l.tone}">${esc(l.text)}</text>`);
  }

  // Footer: the four lines the brief keeps.
  const foot = [];
  if (st) {
    if (st.touching) foot.push(`stack  negative ${kf(st.lo)}–${kf(st.hi)} under spot: through ${kf(st.hi)} hedging accelerates${st.nextPositive ? `, ${st.airPct}% of air to ${kf(st.nextPositive.strike)}` : st.truncated ? ', nothing positive inside 5%' : ''}`);
    else if (st.strikes.length) foot.push(`stack  nearest negative run ${kf(st.lo)}–${kf(st.hi)}, ${(((s - st.hi) / s) * 100).toFixed(1)}% below spot`);
    else foot.push(`stack  no negative stack under spot${lv?.support?.strike ? `; cushion at ${kf(lv.support.strike)}` : ''}`);
  }
  const e = expectedRange(s, r.iv);
  const pin = r.pin?.pinned ? `${r.pin.band || f2(s)} (${r.pin.share}% expires today)` : r.pin?.share != null ? `none today (${r.pin.share}% expires)` : 'none today';
  foot.push(`pin    ${pin}${e ? ` · priced for ±${e.pts} (±${e.pct}%)` : ''}`);
  const bw = bookWords(lv, r.callWall);
  if (bw) foot.push(`book   ${bw}`);
  const after = [];
  if (pv != null && r.flipLevel > 0) after.push(`pivot ${f2(r.flipLevel)} → ${f2(pv)} after today`);
  const nb = r.grid ? nextBox(r.grid, { spot: s, today: front }) : null;
  if (nb?.lo != null) after.push(`${shortExpiry(nb.expiry)} box ${nb.lo === nb.hi ? `at ${kf(nb.lo)}` : `${kf(nb.lo)}–${kf(nb.hi)}`}`);
  if (after.length) foot.push(`after  ${after.join(' · ')}`);
  let fy = plotY + plotH + 30;
  for (const line of foot) {
    out.push(`<text x="24" y="${fy}" font-size="15" fill="${INK.text}">${esc(line)}</text>`);
    fy += 24;
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
    fontsCache = ['IBMPlexMono-Regular.ttf', 'IBMPlexMono-Bold.ttf']
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
    font: { fontBuffers: fonts(), defaultFontFamily: 'IBM Plex Mono', loadSystemFonts: false },
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
