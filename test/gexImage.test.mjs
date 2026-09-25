// test/gexImage.test.mjs — the ladder as a picture: what is drawn, and that it rasterises here,
// with the bundled engine and fonts, into a real PNG.
import { ladderSvg, renderPng, ladderImages, wrap, IMAGE_W, IMAGE_H, INK, FONT } from '../lib/gexImage.js';
import { levelsOf } from '../lib/gexLevels.js';
import { imagePayload, cardsPayload, EMBEDS_MAX } from '../lib/discord.js';
import { renderGexParts, mapCards } from '../lib/gexBrief.js';
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
  ok('spot is drawn, its number on the axis in the line\'s blue', new RegExp(`stroke="${INK.spot}"`).test(svg) && new RegExp(`fill="${INK.spot}">746\\.06<`).test(svg));
  ok('the title is the heaviest weight', /font-size="28" font-weight="800"/.test(svg));
  ok('set in Manrope', new RegExp(`font-family="${FONT}"`).test(svg) && FONT === 'Manrope');
  ok('the flip zone is a band', /flip zone 712\.76–740\.80/.test(svg));
  ok('the pivot after today is dashed', /stroke-dasharray/.test(svg) && /pivot after today 733\.96/.test(svg));
  ok('positive bars are green, negative purple', new RegExp(`fill="${INK.pos}"`).test(svg) && new RegExp(`fill="${INK.neg}"`).test(svg));
  ok('the ceiling is labelled with its peak count', /\+494M · ceiling · 2 of 5/.test(svg));
  ok('the cushion is labelled', /\+60M Oct-16 · cushion · peaks 1 of 5/.test(svg));
  ok('the trapdoor is labelled', /−340M Oct-02 · trapdoor/.test(svg));
  ok('today\'s negatives say today', /−110M today/.test(svg));
  ok('the stack is bracketed beside the bars, clear of the labels', new RegExp(`<rect x="84" y="[\\d.]+" width="5" height="[\\d.]+" rx="2" fill="${INK.neg}"/>`).test(svg));
  ok('the four text lines repeat under the plot, label in bold capitals', /<tspan font-weight="700" letter-spacing="0.6">STACK<\/tspan> negative 730–745 under spot/.test(svg) && /<tspan font-weight="700" letter-spacing="0.6">PIN<\/tspan> none today/.test(svg) && /<tspan font-weight="700" letter-spacing="0.6">BOOK<\/tspan> /.test(svg) && /<tspan font-weight="700" letter-spacing="0.6">AFTER<\/tspan> pivot 740\.80 to 733\.96 after today · Sep-25 box 748–755/.test(svg));
  eq('a long footer line wraps', wrap('one two three four five six', 10), ['one two', 'three four', 'five six']);
  eq('a short one does not', wrap('short', 10), ['short']);
  ok('the caption says which colour means what', /green = positive gamma, hedging leans against price/.test(svg));
  ok('and the vintage', /OCC settled open interest at the live spot/.test(svg));
  ok('text is escaped', !/[<>&]"/.test(svg.replace(/<[^>]+>/g, '')));
  // A dense board: dollar strikes right under spot, which overprinted on the axis before every
  // label went through the one spacing pass.
  {
    const d = board([cell('2026-09-23', 740, -534), cell('2026-09-23', 739, -401), cell('2026-09-23', 738, -138), cell('2026-09-23', 745, 336), cell('2026-09-23', 748, 131), cell('2026-10-02', 730, -375), cell('2026-10-16', 755, 293)]);
    const dl = levelsOf({ ...d, spot: 740.71, atr: 8, callWall: 740 });
    const dense = ladderSvg({ name: 'QQQ', spot: 740.71, callWall: 740, levels: dl, byStrike: d.byStrike, grid: d.grid, flipLevel: 740.59, flipZoneLo: 711.51, flipZoneHi: 740.59, pin: { pinned: false, share: 43.9 }, decay: { expiringToday: true, front: '2026-09-23', after: { flip: 732.74 } } }, { today: '2026-09-23' });
    const axisYs = [...dense.matchAll(/<text x="424" y="([\d.]+)" font-size="17" font-weight="700"/g)].map(m => +m[1]).sort((a, b) => a - b);
    ok('callout strikes, spot included, never overprint', axisYs.length >= 5 && axisYs.every((v, i) => i === 0 || v - axisYs[i - 1] >= 19.9));
    const leaders = [...dense.matchAll(/<path d="M[\d.]+ ([\d.]+) L[\d.]+ [\d.]+ L[\d.]+ ([\d.]+)" fill="none"/g)];
    ok("every row has a leader to its bar, and a displaced row's leader bends", leaders.length >= 6 && leaders.some(m => Math.abs(+m[1] - +m[2]) > 2));
    // The pivot and the flip zone are laid out with the rest, in the annotation column.
    const auxYs = [...dense.matchAll(/<text x="\d+" y="([\d.]+)" font-size="1[35]"[^>]*>(?:pivot after today|flip zone|[−+])/g)].map(m => +m[1]).sort((a, b) => a - b);
    ok('the pivot and flip-zone labels never overprint an annotation', auxYs.length >= 6 && auxYs.every((v, i) => i === 0 || v - auxYs[i - 1] >= 18.9));
    ok('the pivot label is in the callout column', /<text x="424" y="[\d.]+" font-size="13" fill="#c9d1d9">pivot after today 732\.74</.test(dense));
    // Nothing crosses the callout column, which is why its labels need no backing.
    ok('no line or band is drawn across the callout column', [...dense.matchAll(/<line x1="[\d.]+" y1="[\d.]+" x2="([\d.]+)"/g)].every(m => +m[1] < 424)
       && [...dense.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"[^>]*fill-opacity="0.13"/g)].every(m => +m[1] + +m[2] < 424));
    ok('no arrow glyph the face cannot draw', !/→/.test(dense));
    // A stack that runs below the window, and a footer line that wraps: the bracket stops at the
    // plot's foot and the plot gives the footer its extra line.
    const deep = board([cell('2026-09-23', 768, -954), cell('2026-09-23', 767, -784), cell('2026-09-25', 760, -588), cell('2026-10-16', 750, -554), cell('2026-10-16', 740, -300), cell('2026-10-16', 730, -200), cell('2026-10-16', 725, -100), cell('2026-10-09', 785, 1070), cell('2026-09-23', 772, 971)]);
    const dlv = levelsOf({ ...deep, spot: 768.12, atr: 6, callWall: 772 });
    const deepSvg = ladderSvg({ name: 'SPY', spot: 768.12, callWall: 772, levels: dlv, byStrike: deep.byStrike, grid: deep.grid, flipLevel: 771.61, flipZoneLo: 759.38, flipZoneHi: 771.61, iv: 0.12, pin: { pinned: false, share: 43.2 }, decay: { expiringToday: true, front: '2026-09-23', after: { flip: 769 } } }, { today: '2026-09-23' });
    const bracket = /<rect x="84" y="([\d.]+)" width="5" height="([\d.]+)" rx="2"/.exec(deepSvg);
    const plot = /<rect x="24" y="84" width="\d+" height="([\d.]+)" rx="8"/.exec(deepSvg);
    ok('the bracket stops at the plot\'s foot', bracket && plot && (+bracket[1] + +bracket[2]) <= 84 + +plot[1] + 0.1);
    const footYs = [...deepSvg.matchAll(/<text x="24" y="(\d+)" font-size="15"/g)].map(m => +m[1]);
    ok('the footer lines all sit above the caption', footYs.length >= 4 && Math.max(...footYs) < IMAGE_H - 44);
    ok('the magnet is one word beside the bars', /−534M today · magnet</.test(dense));
    ok('no annotation is wider than the column', [...dense.matchAll(/font-size="15" fill="(?:#2ea043|#8957e5)">([^<]*)</g)].every(m => m[1].length <= 38));
  }
  // Labels never overprint: consecutive annotation y's are at least the minimum gap apart.
  const ys = [...svg.matchAll(/<text x="\d+" y="([\d.]+)" font-size="15" font-weight="600" fill=/g)].map(m => +m[1]).sort((a, b) => a - b);
  ok('annotations are spaced apart', ys.length >= 6 && ys.every((v, i) => i === 0 || v - ys[i - 1] >= 19.9));
  // ── THE REDESIGN (2026-09-25) ──────────────────────────────────────────────
  // Bars diverge around a zero line: negative left, positive right, so direction reads from
  // position and not colour alone.
  const zero = /<line x1="([\d.]+)" y1="[\d.]+" x2="\1" y2="[\d.]+" stroke="#8b949e"/.exec(svg);
  const barsAt = (fill) => [...svg.matchAll(new RegExp(`<rect x="([\\d.]+)" y="[\\d.]+" width="([\\d.]+)" height="[\\d.]+" rx="2" fill="${fill}"`, 'g'))];
  ok('there is a zero line', !!zero);
  ok('negative bars end at it, on the left', barsAt(INK.neg).filter(m => +m[1] >= 84 + 5).every(m => Math.abs(+m[1] + +m[2] - +zero[1]) < 0.2));
  ok('positive bars start at it, on the right', barsAt(INK.pos).every(m => Math.abs(+m[1] - +zero[1]) < 0.2));
  ok('each side says what it means, in words', /negative · leans with price</.test(svg) && /positive · leans against</.test(svg));
  ok("the ladder's nodes are drawn full, the rest faded to context", /fill-opacity="0.95"/.test(svg) && /fill-opacity="0.3"/.test(svg));
  ok('a price scale runs down the left', [...svg.matchAll(/font-size="12" text-anchor="end" fill="#6e7681">\d/g)].length >= 4);
  ok('spot names itself in the column', /fill="#58a6ff">spot</.test(svg));
  eq('no spot, no picture', ladderSvg({ name: 'X' }), null);
  // A legacy row without the per-strike table still gets a heading, spot and zone.
  const legacy = ladderSvg({ name: 'SPY', spot: 762.4, callWall: 770, flipLevel: 769.6, flipZoneLo: 765, flipZoneHi: 772 }, {});
  ok('a legacy row draws without bars', /SPY 762\.40/.test(legacy) && !/rx="2" fill="#(?:2ea043|8957e5)" fill-opacity="0\.85"/.test(legacy));
}

// ── THE RASTER ───────────────────────────────────────────────────────────────
{
  ok('the engine is bundled', existsSync(new URL('../data/render/resvg.wasm', import.meta.url)));
  ok('and the fonts, with their licence', ['400Regular', '600SemiBold', '700Bold', '800ExtraBold'].every(w => existsSync(new URL(`../data/render/Manrope_${w}.ttf`, import.meta.url))) && /SIL Open Font License/.test(readFileSync(new URL('../data/render/OFL.txt', import.meta.url), 'utf8')) && /Manrope/.test(readFileSync(new URL('../data/render/OFL.txt', import.meta.url), 'utf8')));
  const png = await renderPng(ladderSvg(row, { today: '2026-09-23' }));
  ok('a PNG comes back', png && png.length > 10000 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47);
  // Width and height from the IHDR chunk: 820 wide, portrait.
  const w = png.readUInt32BE ? png.readUInt32BE(16) : new DataView(png.buffer, png.byteOffset).getUint32(16);
  const h = png.readUInt32BE ? png.readUInt32BE(20) : new DataView(png.buffer, png.byteOffset).getUint32(20);
  eq('at the size asked for', [w, h], [IMAGE_W, IMAGE_H]);
  eq('no svg, no png', await renderPng(null), null);
  const files = await ladderImages([row, { ...row, name: 'SPY' }, { name: 'X' }], { today: '2026-09-23' });
  eq('one file per drawable instrument, named for it', files.map(f => f.filename), ['QQQ-ladder.png', 'SPY-ladder.png']);
  // The webhook payload: the text card first, then one picture card per file, each pointing at
  // its attachment, and the attachments named by index.
  eq('the multipart payload puts the pictures inside the card', imagePayload(files, { description: 'the map' }),
     { embeds: [{ description: 'the map' }, { image: { url: 'attachment://QQQ-ladder.png' } }, { image: { url: 'attachment://SPY-ladder.png' } }],
       attachments: [{ id: 0, filename: 'QQQ-ladder.png' }, { id: 1, filename: 'SPY-ladder.png' }] });
  // ── EACH PICTURE ABOVE ITS READ ──
  // Discord draws an embed's picture under its text, so the order "QQQ map, QQQ read, SPY map,
  // SPY read" is three cards: heading + QQQ picture, QQQ read + SPY picture, SPY read + footer.
  {
    const parts = renderGexParts([row, { ...row, name: 'SPY' }], { rung: 'occ', asOf: '2026-09-23T12:00:00Z', today: '2026-09-23' });
    eq('the section comes apart into caveat, one text per instrument, footer', [!!parts.caveat, parts.instruments.map(i => i.name), /settled open interest/.test(parts.footer)], [true, ['QQQ', 'SPY'], true]);
    // A picture ends a card, so the order is read-then-picture, one card per instrument.
    const cards = mapCards(parts, files, { head: '⚡ **TODAY\'S MAP**' });
    eq('two cards', cards.length, 2);
    ok('card 1: the heading, caveat and QQQ\'s read, with QQQ\'s picture under it', cards[0].description.startsWith('⚡ **TODAY\'S MAP**\n_±band') && /### QQQ/.test(cards[0].description) && /• \*\*stack\*\*/.test(cards[0].description) && !/### SPY/.test(cards[0].description) && cards[0].filename === 'QQQ-ladder.png');
    ok('card 2: SPY\'s read and the footer, with SPY\'s picture under it', cards[1].description.startsWith('### SPY') && /settled open interest/.test(cards[1].description) && cards[1].filename === 'SPY-ladder.png');
    // An instrument without a picture keeps its read in the running text of the next card.
    const one = mapCards(parts, [files[1]], { head: 'H' });
    eq('QQQ without a picture: one card carrying both reads, SPY\'s picture under it', [one.length, /### QQQ[^]*### SPY/.test(one[0].description), one[0].filename], [1, true, 'SPY-ladder.png']);
    const none = mapCards(parts, [], { head: 'H' });
    eq('no pictures: one text card', [none.length, none[0].filename], [1, undefined]);
    const cp = cardsPayload(cards, files);
    eq('the payload: two embeds, a picture on each, two attachments in order',
       [cp.embeds.length, cp.embeds[0].image?.url, cp.embeds[1].image?.url, cp.attachments],
       [2, 'attachment://QQQ-ladder.png', 'attachment://SPY-ladder.png', [{ id: 0, filename: 'QQQ-ladder.png' }, { id: 1, filename: 'SPY-ladder.png' }]]);
    ok('the cards fit Discord\'s limits', cp.embeds.length <= EMBEDS_MAX && cp.embeds.reduce((a, e) => a + (e.description?.length || 0), 0) <= 6000);
    eq('a card naming a file that is not attached shows no picture', cardsPayload([{ description: 'x', filename: 'nope.png' }], files).embeds[0].image, undefined);
  }
  // The pre-read hands the files to the part that carries the map, and the dry run can hand the
  // picture back.
  const src = readFileSync('api/preread.js', 'utf8');
  ok('the pictures ride on the map part, as cards', /filesFor: files\.length \? \{ marker: MAP_HEAD, files, cards \} : null/.test(src) && /mapCards\(blocks\.gexParts, files, \{ head: MAP_HEAD \}\)/.test(src));
  ok('a failed picture never blocks the brief', /image = \{ ok: false, error: String\(e\?\.message \|\| e\) \}/.test(src));
  const dsc = readFileSync('lib/discord.js', 'utf8');
  ok('the brief\'s title line, which precedes the marker in the chunk, leads the first card', /const before = chunks\[i\]\.slice\(0, chunks\[i\]\.indexOf\(filesFor\.marker\)\);/.test(dsc) && /description: `\$\{head\}\$\{before\}\$\{c\.description\}`/.test(dsc));
  ok('and a part whose pictures fail to attach still posts its words', /if \(id == null\) id = await post\(webhook, \{ embeds: \[\{ description: body\.slice\(0, limit\) \}\] \}\);/.test(dsc));
  ok('?image=1 answers with the PNG', /req\.query\.image === '1'/.test(src) && /'image\/png'/.test(src));
  const vc = JSON.parse(readFileSync('vercel.json', 'utf8'));
  eq('the render assets ride with the function', vc.functions?.['api/preread.js']?.includeFiles, 'data/render/**');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
