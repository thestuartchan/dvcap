// test/gexImage.test.mjs — the ladder as a picture: what is drawn, and that it rasterises here,
// with the bundled engine and fonts, into a real PNG.
import { ladderSvg, renderPng, ladderImages, IMAGE_W, IMAGE_H, INK } from '../lib/gexImage.js';
import { levelsOf } from '../lib/gexLevels.js';
import { imagePayload } from '../lib/discord.js';
import { readFileSync, existsSync } from 'node:fs';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const M = 1e6;
const cell = (expiry, strike, m) => ({ expiry, strike, netGexUsd: m * M });
function board(cells) {
  const sum = new Map();
  for (const c of cells) sum.set(c.strike, (sum.get(c.strike) || 0) + c.netGexUsd);
  const byStrike = [...sum.entries()].sort((a, b) => a[0] - b[0]).map(([strike, net]) => ({ strike, netGexUsd: net }));
  const expiries = [...new Set(cells.map(c => c.expiry))].sort().map(expiry => ({ expiry }));
  return { byStrike, grid: { cells, expiries } };
}

// The 23 Sep board, as in gexLevels.test.mjs.
const spot = 746.06;
const b = board([
  cell('2026-09-23', 745, -110), cell('2026-09-23', 743, -175), cell('2026-09-23', 742, -98), cell('2026-09-23', 740, -50),
  cell('2026-09-23', 748, 205), cell('2026-09-23', 750, 244), cell('2026-09-23', 752, 118),
  cell('2026-09-25', 755, 241), cell('2026-09-25', 750, 250), cell('2026-09-25', 748, 111), cell('2026-09-25', 740, -109),
  cell('2026-10-02', 730, -340), cell('2026-10-02', 748, 145),
  cell('2026-10-16', 726, 60), cell('2026-10-16', 700, -165),
  cell('2026-11-20', 760, 492),
]);
b.grid.expiries = [{ expiry: '2026-09-23', shareOfAbs: 11.3 }, { expiry: '2026-09-25', shareOfAbs: 22.5 }, { expiry: '2026-10-02', shareOfAbs: 2.6 }, { expiry: '2026-10-16', shareOfAbs: 33.2 }, { expiry: '2026-11-20', shareOfAbs: 30.4 }];
const lv = levelsOf({ ...b, spot, atr: 8, callWall: 750 });
const row = { name: 'QQQ', spot, callWall: 750, putWall: lv.support.strike, flipLevel: 740.80, flipZoneLo: 712.76, flipZoneHi: 740.80,
              levels: lv, byStrike: b.byStrike, grid: b.grid, iv: 0.217, pin: { pinned: false, share: 11.3, near: false },
              decay: { expiringToday: true, front: '2026-09-23', after: { flip: 733.96 } } };

// ── THE DRAWING ──────────────────────────────────────────────────────────────
{
  const svg = ladderSvg(row, { today: '2026-09-23', vintage: 'OCC settled open interest at the live spot' });
  ok('an svg comes back', /^<svg /.test(svg) && /<\/svg>$/.test(svg));
  ok('sized for a phone, portrait', new RegExp(`width="${IMAGE_W}" height="${IMAGE_H}"`).test(svg) && IMAGE_H > IMAGE_W * 0.75);
  ok('the heading names the instrument and spot', /QQQ 746\.06/.test(svg));
  ok('and the regime', /positive gamma, moves damp/.test(svg));
  ok('spot is drawn, labelled at the right edge clear of the strikes', new RegExp(`stroke="${INK.spot}"`).test(svg) && />spot 746\.06</.test(svg));
  ok('the flip zone is a band', /flip zone 712\.76–740\.80/.test(svg));
  ok('the pivot after today is dashed', /stroke-dasharray/.test(svg) && /pivot after today 733\.96/.test(svg));
  ok('positive bars are green, negative purple', new RegExp(`fill="${INK.pos}"`).test(svg) && new RegExp(`fill="${INK.neg}"`).test(svg));
  ok('the ceiling is labelled with its peak count', /\+494M · ceiling · 2 of 5/.test(svg));
  ok('the cushion is labelled', /\+60M Oct-16 · cushion · peaks 1 of 5/.test(svg));
  ok('the trapdoor is labelled', /−340M Oct-02 · trapdoor/.test(svg));
  ok('today\'s negatives say today', /−110M today/.test(svg));
  ok('the stack is bracketed', new RegExp(`<rect x="\\d+" y="[\\d.]+" width="5" height="[\\d.]+" rx="2" fill="${INK.neg}"/>`).test(svg));
  ok('the four text lines repeat under the plot', /stack {2}negative 730–745 under spot/.test(svg) && /pin {4}none today/.test(svg) && /book {3}/.test(svg) && /after {2}pivot 740\.80 → 733\.96 after today · Sep-25 box 748–755/.test(svg));
  ok('the caption says which colour means what', /green = positive gamma, hedging leans against price/.test(svg));
  ok('and the vintage', /OCC settled open interest at the live spot/.test(svg));
  ok('text is escaped', !/[<>&]"/.test(svg.replace(/<[^>]+>/g, '')));
  // A dense board: dollar strikes right under spot, which overprinted on the axis before every
  // label went through the one spacing pass.
  {
    const d = board([cell('2026-09-23', 740, -534), cell('2026-09-23', 739, -401), cell('2026-09-23', 738, -138), cell('2026-09-23', 745, 336), cell('2026-09-23', 748, 131), cell('2026-10-02', 730, -375), cell('2026-10-16', 755, 293)]);
    const dl = levelsOf({ ...d, spot: 740.71, atr: 8, callWall: 740 });
    const dense = ladderSvg({ name: 'QQQ', spot: 740.71, callWall: 740, levels: dl, byStrike: d.byStrike, grid: d.grid, flipLevel: 740.59, flipZoneLo: 711.51, flipZoneHi: 740.59, pin: { pinned: false, share: 43.9 }, decay: { expiringToday: true, front: '2026-09-23', after: { flip: 732.74 } } }, { today: '2026-09-23' });
    const axisYs = [...dense.matchAll(/<text x="\d+" y="([\d.]+)" font-size="1[67]" font-weight="700" text-anchor="end"/g)].map(m => +m[1]).sort((a, b) => a - b);
    ok('axis labels, spot included, never overprint', axisYs.length >= 5 && axisYs.every((v, i) => i === 0 || v - axisYs[i - 1] >= 19.9));
    ok('a displaced label gets a leader line to its bar', /<line x1="\d+" y1="[\d.]+" x2="\d+" y2="[\d.]+" stroke="#6e7681" stroke-width="1"\/>/.test(dense));
    ok('the magnet is one word beside the bars', /−534M today · magnet</.test(dense));
    ok('no annotation is wider than the column', [...dense.matchAll(/font-size="15" fill="(?:#2ea043|#8957e5)">([^<]*)</g)].every(m => m[1].length <= 38));
  }
  // Labels never overprint: consecutive annotation y's are at least the minimum gap apart.
  const ys = [...svg.matchAll(/<text x="\d+" y="([\d.]+)" font-size="15" fill=/g)].map(m => +m[1]).sort((a, b) => a - b);
  ok('annotations are spaced apart', ys.length >= 6 && ys.every((v, i) => i === 0 || v - ys[i - 1] >= 19.9));
  eq('no spot, no picture', ladderSvg({ name: 'X' }), null);
  // A legacy row without the per-strike table still gets a heading, spot and zone.
  const legacy = ladderSvg({ name: 'SPY', spot: 762.4, callWall: 770, flipLevel: 769.6, flipZoneLo: 765, flipZoneHi: 772 }, {});
  ok('a legacy row draws without bars', /SPY 762\.40/.test(legacy) && !/fill-opacity="0\.85"/.test(legacy));
}

// ── THE RASTER ───────────────────────────────────────────────────────────────
{
  ok('the engine is bundled', existsSync(new URL('../data/render/resvg.wasm', import.meta.url)));
  ok('and the fonts, with their licence', existsSync(new URL('../data/render/IBMPlexMono-Regular.ttf', import.meta.url)) && /SIL Open Font License/.test(readFileSync(new URL('../data/render/OFL.txt', import.meta.url), 'utf8')));
  const png = await renderPng(ladderSvg(row, { today: '2026-09-23' }));
  ok('a PNG comes back', png && png.length > 10000 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47);
  // Width and height from the IHDR chunk: 820 wide, portrait.
  const w = png.readUInt32BE ? png.readUInt32BE(16) : new DataView(png.buffer, png.byteOffset).getUint32(16);
  const h = png.readUInt32BE ? png.readUInt32BE(20) : new DataView(png.buffer, png.byteOffset).getUint32(20);
  eq('at the size asked for', [w, h], [IMAGE_W, IMAGE_H]);
  eq('no svg, no png', await renderPng(null), null);
  const files = await ladderImages([row, { ...row, name: 'SPY' }, { name: 'X' }], { today: '2026-09-23' });
  eq('one file per drawable instrument, named for it', files.map(f => f.filename), ['QQQ-ladder.png', 'SPY-ladder.png']);
  // The webhook payload names each attachment by index.
  eq('the multipart payload', imagePayload(files, { content: '⚡ TODAY\'S MAP · QQQ · SPY' }),
     { content: '⚡ TODAY\'S MAP · QQQ · SPY', attachments: [{ id: 0, filename: 'QQQ-ladder.png' }, { id: 1, filename: 'SPY-ladder.png' }] });
  // The pre-read posts the picture ahead of the words, and the dry run can hand it back.
  const src = readFileSync('api/preread.js', 'utf8');
  ok('the picture is posted before the brief', src.indexOf('await postImages(') < src.indexOf('await postLong('));
  ok('a failed picture never blocks the brief', /image = \{ ok: false, error: String\(e\?\.message \|\| e\) \}/.test(src));
  ok('?image=1 answers with the PNG', /req\.query\.image === '1'/.test(src) && /'image\/png'/.test(src));
  const vc = JSON.parse(readFileSync('vercel.json', 'utf8'));
  eq('the render assets ride with the function', vc.functions?.['api/preread.js']?.includeFiles, 'data/render/**');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
