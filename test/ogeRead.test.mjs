// test/ogeRead.test.mjs — reading the OGE 278-T scans (lib/ogeRead.js) and the card that lists the
// biggest trades with their row numbers (lib/officials.js ogeCard / runOge). Made-up companies and
// fake tickers only; the OCR noise is the kind the real text layer carries.
import { linesOf, rowsOf, amountOf, isBond, nameKey, tickerIndex, guessTicker, tradesBlock, BRACKETS } from '../lib/ogeRead.js';
import { ogeCard, runOge, OGE_SEEN_KEY } from '../lib/officials.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

// ── amounts: OCR'd brackets matched by their digits ──
eq('spaced, bullet for a dash', amountOf('$1 000 001 • $5 000 000')?.label, '$1M–$5M');
eq('"$" read as S', amountOf('S1 000 001 - SS 000 000')?.label, '$1M–$5M');
eq('O and D for zeros', amountOf('S1 001 - $15 ODD')?.label, '$1K–$15K');
eq('stray comma and space', amountOf('$500,001 • $1 ,000,000')?.label, '$500K–$1M');
eq('the top bracket', amountOf('Over $50,000,000')?.label, 'Over $50M');
eq('noise: nothing', amountOf('-*-'), null);
eq('eleven brackets', BRACKETS.length, 11);

// ── bonds ──
eq('a muni with coupon and maturity is a bond', isBond('SAMPLE CNTY TX HOSP DIST BIE 5.00 % Duo Feb 15 2028'), true);
eq('a company is not', isBond('ZETA QUANTUM CORP'), false);

// ── lines: words grouped by baseline, the right-hand columns a few points low still join their row ──
const w = (str, x, y, width = str.length * 4) => ({ str, transform: [1, 0, 0, 1, x, y], width });
const items = [
  w('7', 60, 175), w('ZETA', 106, 175), w('QUANTUM', 126, 175), w('CORP', 160, 175), w('lourchaso', 487, 175), w('8/1017026', 568, 175),
  w('Yos', 630, 171.4), w('$1', 645, 171.4), w('000', 655, 171.4), w('001', 668, 171.4), w('•', 681, 171.4), w('$5', 686, 171.4), w('000', 696, 171.4), w('000', 709, 171.4),
  w('8', 60, 160), w('Zeta', 106, 160), w('Robotics', 124, 160), w('Hldgs', 158, 160), w('In', 182, 160), w('salo', 488, 160), w('8/21/2026', 568, 160), w('No', 630, 160), w('$15', 645, 160), w('001', 660, 160), w('-', 673, 160), w('$50', 678, 160), w('000', 693, 160),
  w('9', 60, 146), w('SAMPLE', 106, 146), w('CNTY', 134, 146), w('BIE', 156, 146), w('5.00', 172, 146), w('%', 190, 146), w('Duo', 196, 146), w('Jun', 212, 146), w('1', 226, 146), w('2027', 232, 146), w('1purehaso', 487, 146), w('8/4/2026', 568, 146), w('Yes', 630, 146), w('$250', 645, 146), w('001', 664, 146), w('-', 677, 146), w('$500', 682, 146), w('000', 700, 146),
  w('10', 60, 132), w('Zeta', 106, 132), w('Quantvm', 124, 132), w('Coro', 158, 132), w('sate', 488, 132), w('8/3/2026', 568, 132), w('No', 630, 132), w('$1', 645, 132), w('001', 653, 132), w('-', 666, 132), w('$15', 671, 132), w('000', 686, 132),
];
const lines = linesOf(items, 3);
eq('four row lines, the low amount merged into row 7', [lines.length, lines[0].cells.length, lines[0].cells.at(-1).t], [4, 5, 'Yos $1 000 001 • $5 000 000']);
const rows = rowsOf(lines);
eq('rows: number, side, date, amount, bond', rows.map(r => [r.row, r.side, r.date, r.amount?.label, r.bond]),
  [[7, 'Buy', '8/10', '$1M–$5M', false], [8, 'Sell', '8/21', '$15K–$50K', false], [9, 'Buy', '8/4', '$250K–$500K', true], [10, 'Sell', '8/3', '$1K–$15K', false]]);

// ── tickers from SEC's names ──
const idx = tickerIndex({ ZZQ: [1, 'Zeta Quantum Corp'], ZZR: [2, 'Zeta Robotics Holdings, Inc.'], ZZS: [3, 'Sample Technologies Inc'], ZZT: [4, 'Sample Technologies Group Ltd'] });
eq('suffixes dropped', [nameKey('ZETA QUANTUM CORP CL A'), nameKey('Zeta Robotics Holdings, Inc.')], ['ZETAQUANTUM', 'ZETAROBOTICS']);
eq('exact name', guessTicker('ZETA QUANTUM CORP', idx), 'ZZQ');
eq('cut-off name and abbreviation', guessTicker('Zeta Robotics Hldgs In', idx), 'ZZR');
eq('OCR slip in the name and the suffix', guessTicker('Zeta Quantvm Coro', idx), 'ZZQ');
eq('two companies share the name: no guess', guessTicker('SAMPLE TECHNOLOGIES', idx), null);
eq('unknown: no guess', guessTicker('NOTHING LIKE IT INC', idx), null);

// ── the block on the card ──
const b = tradesBlock(rows, { idx });
const text = b.text;
eq('counts', [b.rows, b.stocks, b.bonds], [4, 3, 1]);
eq('biggest buy first, row number and guessed ticker shown', text.split('\n').find(l => l.startsWith('`#7`')), '`#7` **ZZQ?** ZETA QUANTUM CORP · **$1M–$5M** · Aug 10');
eq('sells by size', text.indexOf('`#8`') < text.indexOf('`#10`'), true);
eq('bonds in one line', /\*\*Bonds\*\* \(1\): munis and notes · biggest \$250K–\$500K ×1 \(rows 9\)/.test(text), true);
eq('a date that does not fit the report is dropped', tradesBlock([{ row: 1, name: 'ZETA QUANTUM CORP', side: 'Buy', date: '3/11', amount: BRACKETS[0], bond: false }], { idx, through: '2030-09-17' }).text.includes('Mar 11'), false);
eq('says it is machine-read', /Machine-read from the scan/.test(text), true);

// ── the card and the run ──
const f = { id: 'X1', url: 'https://extapps2.oge.gov/x/%24FILE/x.pdf', label: 'President Trump', through: '2030-09-17', posted: '2030-10-08' };
const card = ogeCard(f, b);
eq('card: header, block, PDF link, no dvcap', [card.embeds[0].description.startsWith('**Report dated 2030-09-17** · posted by OGE 2030-10-08'),
  card.embeds[0].description.endsWith(`[Open the PDF](${f.url})`), /dvcap/i.test(JSON.stringify(card))], [true, true, false]);
eq('unreadable PDF: says so and links it', /could not be read automatically: \[open the PDF\]/.test(ogeCard(f, null).embeds[0].description), true);

const list = { data: [{ docDate: '2030-10-08T04:12:00Z', title: 'President', name: 'Trump, Donald J', amended: '', type: "<a href='/201/Presiden.nsf/PAS+Index/0BDCCCE7DE13AEFA85258E8A002DE2B5/$FILE/Donald-J-Trump.09.17.2030-278T.pdf'>278 Transaction</a>" }] };
const fetchImpl = async (url) => (url.endsWith('.pdf')
  ? { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }
  : { ok: true, json: async () => (url.includes('Trump') ? list : { data: [] }) });
const m = new Map([[OGE_SEEN_KEY, ['old']], ['dvcap:sec:tickers:v1', { m: { ZZQ: [1, 'Zeta Quantum Corp'] } }]]);
const kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); return true; } };
const sent = [];
const r = await runOge({ fetchImpl, kv, deliver: async (c) => { sent.push(c); return 'id'; }, backfillFrom: null, lines: async () => lines });
eq('a new filing is read and its trades listed', [r.posted, /`#7` \*\*ZZQ\?\*\*/.test(sent[0]?.embeds[0].description || '')], [1, true]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
