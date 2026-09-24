// lib/pine.js — the day's gamma levels as a TradingView indicator.
//
// WHY A GENERATED SCRIPT. Pine cannot fetch: an indicator sees bars and its own inputs, nothing
// else, and the only feeds that reach a chart are the ones TradingView licenses. So the levels
// travel as SOURCE. The Gamma tab emits a small indicator with the board's numbers baked in as
// inputs, the reader pastes it into the Pine editor once, and on later days either pastes the new
// script or edits the inputs in the indicator's own settings dialog. A minute a day, and nothing
// in the chain can break silently — a stale script says its date in its title.
//
// WHAT IT DRAWS is exactly what the ladder picture on the pre-read draws, so the chart and the
// brief cannot disagree: the flip zone as a band, the pin box as a band, call wall, put support,
// the near and deep trapdoors, the ladder's ranked nodes above and below with a width that scales
// with size, and the spot at capture as a thin reference. Colours are the panel's: green is
// positive gamma, purple negative — never red, which would say "down" about a number that says
// nothing about direction.
//
// PUBLIC INPUTS ONLY. Spot, strikes and dollar gamma per strike — the same figures the public
// pre-read prints. No position, no size, no account value can reach this file.
import { ladderNodes } from './gexLevels.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const px = (v) => (v == null ? null : (+v).toFixed(2));
const fmtM = (v) => {
  const n = num(v);
  if (n == null) return '—';
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(0)}M` : `${(a / 1e3).toFixed(0)}K`;
  return `${n < 0 ? '−' : ''}$${s}`;
};

export const PINE_VERSION = 6;
export const PINE_COLORS = Object.freeze({ pos: '#2E7D5B', neg: '#7A4FB0', pin: '#B7791F', flip: '#2F4FB3', spot: '#8A93A0' });

// The numbers a script needs, from a board: the latest row (spot, flip zone, call wall), the
// three downside objects (lib/gexLevels.js levelsOf) and the ladder nodes. Returns null when
// there is no spot — a script with no reference price would draw nothing true.
export function pineLevels({ symbol, latest, levels = null, byStrike = [], grid = null, today = null } = {}) {
  const spot = num(latest?.spot);
  if (!symbol || spot == null) return null;
  const lv = levels || {};
  const nodes = ladderNodes(byStrike, grid, { spot, levels: lv, callWall: latest?.callWall, today });
  const node = (n, sign) => ({ strike: +n.strike, gex: num(n.netGexUsd), sign, expiry: n.expiry || null,
                               kind: n.kind || (sign > 0 ? 'positive' : 'negative'), wall: !!n.wall, magnet: !!n.magnet, deep: !!n.deep });
  return {
    symbol: String(symbol).toUpperCase(),
    date: latest?.date || null, asOf: latest?.asOf || null,
    spot,
    flipLo: num(latest?.flipZoneLo), flipHi: num(latest?.flipZoneHi),
    callWall: num(lv.callWall?.strike ?? latest?.callWall), callWallKind: lv.callWall?.kind || null,
    support: num(lv.support?.strike), trapNear: num(lv.trapdoor?.near?.strike), trapDeep: num(lv.trapdoor?.deep?.strike),
    pinLo: num(lv.pin?.pinned ? lv.pin.lo : null), pinHi: num(lv.pin?.pinned ? lv.pin.hi : null),
    above: (nodes.above || []).map(n => node(n, 1)),
    below: (nodes.below || []).filter(n => n.kind !== 'pivot' && n.strike != null).map(n => node(n, n.kind === 'support' || n.kind === 'positive' ? 1 : -1)),
  };
}

// The script. Pine v6, overlay, everything drawn once on the last bar and extended both ways.
export function pineIndicator(levelsIn) {
  const L = levelsIn;
  if (!L?.symbol || L.spot == null) return null;
  const title = `dvcap gamma levels · ${L.symbol} · ${L.date || 'undated'}`;
  const nodes = [...L.above, ...L.below].filter(n => n.strike != null);
  const maxGex = Math.max(1, ...nodes.map(n => Math.abs(n.gex ?? 0)));
  const arr = (vals, fmt) => (vals.length ? `array.from(${vals.map(fmt).join(', ')})` : null);
  const nodeK = arr(nodes.map(n => n.strike), px);
  const nodeG = arr(nodes.map(n => n.gex ?? 0), v => `${Math.round(v)}.0`);
  const nodeT = arr(nodes.map(n => `"${n.kind === 'support' ? 'support' : n.wall ? 'call wall' : n.magnet ? 'magnet' : n.deep ? 'deep trapdoor' : n.sign > 0 ? '+γ' : '−γ'}${n.expiry ? ' ' + n.expiry.slice(5) : ''} ${fmtM(n.gex)}"`), s => s);
  const headline = [
    `// ${title}`,
    `// Captured ${L.asOf || L.date || '?'} · spot ${px(L.spot)} · from the dvcap Gamma tab (delayed CBOE chain, our model).`,
    `// Paste into TradingView → Pine Editor → Add to chart. Tomorrow: paste the new script, or edit the`,
    `// inputs in the indicator's settings. The title carries the date so a stale board says so.`,
    `// Levels only — it draws nothing about what you hold, and it orders nothing.`,
  ].join('\n');
  const inp = (name, v, label, step) => (v == null
    ? `${name.padEnd(8)} = float(na)  // ${label}: none on this board`
    : `${name.padEnd(8)} = input.float(${px(v)}, "${label}", step=${step}, group="Board")`);
  const inputs = [
    inp('spotIn', L.spot, 'Spot at capture', '0.01'),
    inp('flipLo', L.flipLo, 'Flip zone low', '0.01'),
    inp('flipHi', L.flipHi, 'Flip zone high', '0.01'),
    inp('callWall', L.callWall, `Call wall${L.callWallKind ? ` (${L.callWallKind})` : ''}`, '0.5'),
    inp('support', L.support, 'Put support', '0.5'),
    inp('trapNear', L.trapNear, 'Trapdoor (near)', '0.5'),
    inp('trapDeep', L.trapDeep, 'Trapdoor (deep)', '0.5'),
    inp('pinLo', L.pinLo, 'Pin box low', '0.01'),
    inp('pinHi', L.pinHi, 'Pin box high', '0.01'),
    `showNodes = input.bool(true, "Draw the ladder nodes", group="Display")`,
    `showLabels = input.bool(true, "Label the levels", group="Display")`,
    `showSpot = input.bool(true, "Mark the spot at capture", group="Display")`,
  ].join('\n');
  const body = `//@version=${PINE_VERSION}
${headline}
indicator("${title}", shorttitle="γ ${L.symbol}", overlay=true, max_lines_count=60, max_labels_count=60, max_boxes_count=6)

${inputs}

// The board's ranked nodes, baked in. Width scales with size; green is positive gamma, purple negative.
var float[] nodeK = ${nodeK || 'array.new_float()'}
var float[] nodeG = ${nodeG || 'array.new_float()'}
var string[] nodeT = ${nodeT || 'array.new_string()'}
nodeMax = ${Math.round(maxGex)}.0

C_POS  = ${PINE_COLORS.pos}
C_NEG  = ${PINE_COLORS.neg}
C_PIN  = ${PINE_COLORS.pin}
C_FLIP = ${PINE_COLORS.flip}
C_SPOT = ${PINE_COLORS.spot}

var line[]  L = array.new_line()
var label[] T = array.new_label()
var box[]   B = array.new_box()

f_line(float y, color col, int w, string txt, string sty) =>
    if not na(y)
        array.push(L, line.new(bar_index - 1, y, bar_index, y, extend=extend.both, color=col, width=w, style=sty))
        if showLabels and txt != ""
            array.push(T, label.new(bar_index, y, txt, style=label.style_label_left, color=color.new(col, 15), textcolor=color.white, size=size.small))

f_band(float lo, float hi, color col, string txt) =>
    if not na(lo) and not na(hi)
        array.push(B, box.new(bar_index - 1, hi, bar_index, lo, border_color=color.new(col, 40), bgcolor=color.new(col, 85), extend=extend.both))
        if showLabels and txt != ""
            array.push(T, label.new(bar_index, hi, txt, style=label.style_label_left, color=color.new(col, 15), textcolor=color.white, size=size.small))

if barstate.islast
    for l in L
        line.delete(l)
    for t in T
        label.delete(t)
    for b in B
        box.delete(b)
    array.clear(L)
    array.clear(T)
    array.clear(B)
    // Bands first, so the lines sit on top of them.
    f_band(flipLo, flipHi, C_FLIP, "flip zone " + str.tostring(flipLo, "#.##") + "–" + str.tostring(flipHi, "#.##"))
    f_band(pinLo, pinHi, C_PIN, "pin box " + str.tostring(pinLo, "#.##") + "–" + str.tostring(pinHi, "#.##"))
    if showNodes and array.size(nodeK) > 0
        for i = 0 to array.size(nodeK) - 1
            g = array.get(nodeG, i)
            w = math.max(1, math.round(4 * math.abs(g) / nodeMax))
            f_line(array.get(nodeK, i), g >= 0 ? C_POS : C_NEG, w, array.get(nodeT, i), line.style_solid)
    f_line(callWall, C_POS, 3, "call wall${L.callWallKind ? ` · ${L.callWallKind}` : ''} " + str.tostring(callWall, "#.##"), line.style_solid)
    f_line(support, C_POS, 3, "put support " + str.tostring(support, "#.##"), line.style_solid)
    f_line(trapNear, C_NEG, 3, "trapdoor " + str.tostring(trapNear, "#.##"), line.style_dashed)
    f_line(trapDeep, C_NEG, 2, "deep trapdoor " + str.tostring(trapDeep, "#.##"), line.style_dotted)
    if showSpot
        f_line(spotIn, C_SPOT, 1, "spot at capture " + str.tostring(spotIn, "#.##"), line.style_dotted)
    // The script is for one instrument. On another chart it says so rather than drawing the wrong levels.
    if syminfo.ticker != "${L.symbol}"
        array.push(T, label.new(bar_index, close, "these gamma levels are for ${L.symbol}, not " + syminfo.ticker, style=label.style_label_left, color=color.new(C_PIN, 0), textcolor=color.white, size=size.normal))
`;
  return body;
}

// One call from the panel: levels from the board, then the script. Null when there is no board.
export function pineFor(args) {
  const L = pineLevels(args);
  return L ? { levels: L, source: pineIndicator(L) } : null;
}
