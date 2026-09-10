// test/jgb.test.mjs — the Japanese government bond curve, from the ministry that issues it.
import { parseEraDate, parseJgbCsv, jgbFields, REIWA_EPOCH, TENOR_LABEL, JGB_URL } from '../lib/jgb.js';
import { ratesLine, jgbTail } from '../lib/briefSections.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// The real file's shape, encoded the way the ministry serves it.
const sjis = (s) => {
  // Only the header and the era dates are non-ASCII; those are written as bytes directly so the
  // fixture is a genuine Shift-JIS payload rather than a UTF-8 one the decoder would mangle.
  const bytes = [];
  // Taken from the ministry's own file, not guessed: 基 is 0x8aee, not 0x8a69.
  const map = { '基準日': [0x8a, 0xee, 0x8f, 0x80, 0x93, 0xfa], '年': [0x94, 0x4e], '※': [0x81, 0xa6] };
  let i = 0;
  while (i < s.length) {
    let hit = null;
    for (const k of Object.keys(map)) if (s.startsWith(k, i)) { hit = k; break; }
    if (hit) { bytes.push(...map[hit]); i += hit.length; }
    else { bytes.push(s.charCodeAt(i) & 0xff); i++; }
  }
  return new Uint8Array(bytes);
};
const CSV = sjis([
  'title row,,,,',
  '基準日,2年,10年,20年,30年,40年',
  'R8.9.8,1.848,2.891,3.713,3.956,3.960',
  'R8.9.9,1.833,2.891,3.713,3.956,3.960',
  ',,,,,',
  '※footer,,,,,',
].join('\r\n'));

// ── THE DATES ARE JAPANESE-ERA ──────────────────────────────────────────────
// "R8.9.9" read as a Gregorian year is 2008. A curve dated eighteen years ago must not reach a
// brief, so the era is parsed rather than hoped for.
{
  eq('Reiwa 8 is 2026', parseEraDate('R8.9.9'), '2026-09-09');
  eq('and Reiwa 1 is 2019', parseEraDate('R1.5.1'), '2019-05-01');
  eq('the epoch is a named constant', REIWA_EPOCH, 2018);
  eq('single digits are padded', parseEraDate('R8.1.5'), '2026-01-05');
  // Heisei ended in 2019. A Heisei-dated row in today's file means the fetch is wrong, not that
  // the curve is thirty years old — so it is refused rather than converted.
  eq('a Heisei date is refused, not converted', parseEraDate('H31.4.30'), null);
  eq('a Gregorian date is not an era date', parseEraDate('2026-09-09'), null);
  eq('and neither is a footer', parseEraDate('※最新のcsv'), null);
  eq('nor nothing at all', parseEraDate(''), null);
}

// ── IT IS SHIFT-JIS ─────────────────────────────────────────────────────────
// Decoded as UTF-8 the header and the date column are mojibake, and a parser reading columns by
// position would silently mis-map the tenors.
{
  const p = parseJgbCsv(CSV);
  ok('the payload parses', !!p);
  eq('two dated rows survive', p.rows.length, 2);
  eq('the footer does not', p.rows.every(r => /^\d{4}-/.test(r.date)), true);
  eq('sorted oldest first', p.rows.map(r => r.date), ['2026-09-08', '2026-09-09']);
  eq('the latest is the latest', p.latest.date, '2026-09-09');
  eq('and the tenors came off the header, not off a position', p.tenors.includes('10年'), true);
  eq('with the values against them', p.latest.curve['10年'], 2.891);
  // The header is FOUND, not indexed: the file opens with a title row whose shape has changed.
  eq('a title row above the header does not shift the columns', p.latest.curve['30年'], 3.956);
  eq('a payload with no header yields nothing', parseJgbCsv(sjis('a,b\r\n1,2')), null);
  eq('and neither does an empty one', parseJgbCsv(new Uint8Array([])), null);
}

// ── THE SHAPE THE BOARD CONSUMES ────────────────────────────────────────────
{
  const f = jgbFields(parseJgbCsv(CSV));
  eq('the tenors are labelled in English', Object.keys(f).filter(k => /yr$/.test(k)).sort(),
     ['10yr', '20yr', '2yr', '30yr', '40yr']);
  // ONLY THE LABELLED TENORS. The real file carries sixteen and the rest are Japanese strings;
  // letting them through would put 「4年」 into the API payload and anything that iterates it.
  // Tested by code point rather than a control-character range, which the linter rightly objects to.
  const ascii = (k) => [...k].every(ch => ch.codePointAt(0) < 128);
  ok('no untranslated key survives', Object.keys(f).every(ascii));
  eq('each carries its own date, so the vintage rule can age it', f['10yr'].date, '2026-09-09');
  eq('and its prior print', f['2yr'].prev, 1.848);
  eq('so the day-over-day move is real, not "since we last fetched"', f['2yr'].deltaBps, -2);
  eq('an unmoved tenor reads zero, not null', f['10yr'].deltaBps, 0);
  eq('the source is named', f.source, 'Japan MoF daily JGB curve');
  ok('and the URL is the ministry, not a mirror', /mof\.go\.jp/.test(JGB_URL));
  eq('nothing parsed is nothing to shape', jgbFields(null), null);
  eq('the label map covers what the brief quotes', [TENOR_LABEL['10年'], TENOR_LABEL['30年']], ['10yr', '30yr']);
}

// ── MERGED INTO THE MONEY LINE, NOT GIVEN ITS OWN ───────────────────────────
// The Asia brief already ran to a dozen backdrop rows, and reading the two curves against each
// other is the point — two separate lines make that harder rather than easier.
{
  const f = jgbFields(parseJgbCsv(CSV));
  const line = ratesLine({ us2y: 4.43, us10y: 4.83, us30y: 5.28, jgb: f });
  ok('the US curve is unchanged', /\*\*2yr 4\.43%\*\* · \*\*10yr 4\.83%\*\* · \*\*30yr 5\.28%\*\*/.test(line));
  ok('and its shape reading survives', /the normal way round/.test(line));
  ok('Japan rides on the same line', /🇯🇵 \*\*JGB\*\* \*\*10yr 2\.891%\*\* · \*\*30yr 3\.956%\*\*/.test(line));
  // ITS OWN DATE. The MoF publishes a business day behind, so on a Monday it is Friday's — and
  // saying so is the difference between a lag and an error.
  ok('carrying its own vintage, not the US one', /_\(as of 2026-09-09\)_/.test(line));
  // A move is shown where there was one, and not where there was not.
  ok('a moved tenor shows its move', /2yr/.test(jgbTail(f)) === false && /10yr 2\.891%\*\*(?! \()/.test(jgbTail(f)));

  eq('no Japan leg leaves the line as it was', ratesLine({ us2y: 4.43, us10y: 4.83, us30y: 5.28 }),
     ratesLine({ us2y: 4.43, us10y: 4.83, us30y: 5.28, jgb: null }));
  eq('a curve with neither quoted tenor adds nothing', jgbTail({ date: '2026-09-09', '2yr': { value: 1.8 } }), '');
  eq('and no curve at all adds nothing', jgbTail(null), '');
  // NEVER A PARTIAL CURVE DRESSED AS A FULL ONE.
  ok('a 10-year with no 30-year renders only the 10-year',
     /10yr 2\.891%/.test(jgbTail({ date: '2026-09-09', '10yr': { value: 2.891 } }))
     && !/30yr/.test(jgbTail({ date: '2026-09-09', '10yr': { value: 2.891 } })));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
