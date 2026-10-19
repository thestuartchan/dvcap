// test/dartEarnings.test.mjs — Korea earnings dates from DART (lib/dartEarnings.js).
// Built from OpenDART's documented response shapes; a fake company (XYZ Corp, corp 99999999, KRX
// 999999), made-up receipt numbers and dates. DART itself is never reached and no key is real.
import { deflateRawSync } from 'node:zlib';
import { parseDartList, isIrNotice, isPrelim, unzipEntries, decodeText, irDateFromText, dartRows, fetchDartEarnings, DART_WATCH } from '../lib/dartEarnings.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// A ZIP with deflated members, local headers and a central directory, as DART's document.xml serves.
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBuf = Buffer.from(name, 'utf8'), raw = Buffer.from(text, 'utf8'), data = deflateRawSync(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data); centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ── the list ──
const W = { corp: '99999999', code: '999999', name: 'XYZ Corp', aliases: ['XYZ'], region: 'ASIA', tier: 1 };
const LIST = { status: '000', message: '정상', list: [
  { corp_code: '99999999', corp_name: 'XYZ', report_nm: '기업설명회(IR)개최(안내공시)', rcept_no: '20261020000111', rcept_dt: '20261020' },
  { corp_code: '99999999', corp_name: 'XYZ', report_nm: '연결재무제표기준영업(잠정)실적(공정공시)', rcept_no: '20261008000222', rcept_dt: '20261008' },
  { corp_code: '99999999', corp_name: 'XYZ', report_nm: '임원ㆍ주요주주특정증권등소유상황보고서', rcept_no: '20261005000333', rcept_dt: '20261005' },
] };
const parsed = parseDartList(LIST);
eq('a list reads to filings with ISO dates', [parsed.ok, parsed.filings.length, parsed.filings[0].date], [true, 3, '2026-10-20']);
eq('status 013 is "nothing filed", not a failure', parseDartList({ status: '013', message: '조회된 데이타가 없습니다.' }), { ok: true, filings: [] });
eq('any other status is a failure that names it', parseDartList({ status: '020', message: '요청 제한을 초과하였습니다.' }).ok, false);
eq('the IR notice and the preliminary results are told apart', parsed.filings.map(f => [isIrNotice(f.name), isPrelim(f.name)]), [[true, false], [false, true], [false, false]]);

// ── the filing ──
const DOC = `<?xml version="1.0" encoding="utf-8"?><DOCUMENT><BODY><TABLE><TR><TD>1. 일시</TD><TD>2026년 10월 29일 오전 10시</TD></TR>
<TR><TD>2. 장소</TD><TD>컨퍼런스콜</TD></TR><TR><TD>3. 대상자</TD><TD>국내외 투자자</TD></TR></TABLE></BODY></DOCUMENT>`;
const z = zip([['20261020000111.xml', DOC]]);
const files = unzipEntries(z);
eq('the ZIP is read through its central directory', [files.length, files[0].name, decodeText(files[0].data).includes('일시')], [1, '20261020000111.xml', true]);
eq('a non-ZIP is refused, not guessed at', (() => { try { unzipEntries(Buffer.from('<result><status>014</status></result>')); return 'read'; } catch { return 'refused'; } })(), 'refused');

const today = '2026-10-20';
eq('the meeting date and time, Korean form', irDateFromText(DOC, { today }), { date: '2026-10-29', time: '10:00' });
eq('ISO form with a 24-hour time', irDateFromText('<p>개최일시: 2026-10-28 16:00 (한국시간)</p>', { today }), { date: '2026-10-28', time: '16:00' });
eq('afternoon in Korean is PM', irDateFromText('<p>일시 : 2026.10.30 오후 4시</p>', { today }), { date: '2026-10-30', time: '16:00' });
eq('two different dates is no date', irDateFromText('<p>일시: 2026-10-28</p><p>일시: 2026-11-04</p>', { today }), null);
eq('a date in the past or past 60 days is no date', [irDateFromText('<p>일시: 2026-10-01</p>', { today }), irDateFromText('<p>일시: 2027-03-01</p>', { today })], [null, null]);
eq('a date with no label before it is not read', irDateFromText('<p>2026-10-29 공시</p>', { today }), null);

// ── rows ──
{
  const r = dartRows(W, parsed.filings, { '20261020000111': DOC }, { today });
  eq('the IR call row, in Seoul time, with its receipt', r.rows.find(x => x.kind === 'earn:999999'),
    { date: '2026-10-29', title: 'XYZ Corp earnings (IR call)', region: 'ASIA', tier: 1, time: '10:00', tz: 'Asia/Seoul', kind: 'earn:999999', auto: true, source: 'DART (opendart.fss.or.kr)', rcept: '20261020000111' });
  eq('preliminary results mark the quarter reported, on the filing date', r.rows.find(x => x.kind === 'earnprelim:999999')?.date, '2026-10-08');
  const unread = dartRows(W, parsed.filings, { '20261020000111': '<p>장소: 서울</p>' }, { today });
  eq('a notice whose date cannot be read gives no row and says so', [unread.rows.some(x => x.kind === 'earn:999999'), unread.notes], [false, ['XYZ Corp: IR notice found, date not read (rcept 20261020000111)']]);
}

// ── fetch ──
{
  let calls = 0;
  const none = await fetchDartEarnings({ key: '', fetchImpl: async () => { calls++; return { ok: true }; }, watch: [W] });
  eq('without a key nothing is requested and it says so', [calls, none.source], [0, { ok: false, error: 'DART_API_KEY not set' }]);

  const KEY = 'fake-key-0000';
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes('list.json')) return { ok: true, status: 200, json: async () => LIST };
    if (url.includes('document.xml')) return { ok: true, status: 200, arrayBuffer: async () => z.buffer.slice(z.byteOffset, z.byteOffset + z.length) };
    return { ok: false, status: 404 };
  };
  const got = await fetchDartEarnings({ key: KEY, fetchImpl, now: new Date('2026-10-20T03:00:00Z'), watch: [W] });
  eq('one list read and one document read per company', [seen.length, seen[0].includes('corp_code=99999999'), seen[1].includes('rcept_no=20261020000111')], [2, true, true]);
  eq('and the rows come back with the source', [got.events.map(e => e.kind).sort(), got.source], [['earn:999999', 'earnprelim:999999'], { ok: true, count: 2 }]);

  const boom = await fetchDartEarnings({ key: KEY, fetchImpl: async () => { throw new Error(`request to ...crtfc_key=${KEY} failed`); }, watch: [W] });
  eq('a failure is reported without the key in it', [boom.source.ok, boom.source.error.includes(KEY), boom.source.error.includes('***')], [false, false, true]);
}
eq('the watch list names Samsung Electronics and SK hynix by DART corp code', DART_WATCH.map(w => [w.corp, w.code]), [['00126380', '005930'], ['00164779', '000660']]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
