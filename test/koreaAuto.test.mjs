// test/koreaAuto.test.mjs — the Korea inputs read from KOFIA and KRX instead of pasted.
//
// Fixtures are the real shapes of the two pages as of 1 Oct 2026: the KOFIA front page's <dl>
// blocks and the KRX front-page widget's JSON. What matters most is that a reading from either
// passes the same guards a hand paste does, and that an intraday partial is never stored as a day.
import { kofiaPasteFromHtml, kofiaFromHtml, krxFlowsFromJson, flowIsFinal, seoulClock } from '../lib/koreaAuto.js';
import { normaliseStore, unitProblems, applyKofia, applyFlows, appendSnapshot, storeChanged, KOSDAQ_FLOW_KEYS } from '../lib/koreaStore.js';
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const DL = (label, unit, date, n1, n2, n3, rise = true) => `
  <li><dl>
    <dt class="chart-name"><a href="#" onclick="clickJisuMenu('OS0026')">${label}</a></dt>
    <dd class="etc"><span class="dan">${unit}</span> | <span class="date">${date}</span></dd>
    <dd class="chart-num">
      <span class="num1">${n1}</span>
      <span class="${rise ? 'num2a' : 'num2b'}">${n2}</span>
      <span class="num3">${n3}</span>
    </dd>
  </dl></li>`;
const PAGE = `<html><body><ul>
  ${DL('KOSPI지수', 'P', '10/01', '6,971.35', '133.31', '1.95%')}
  ${DL('투자자예탁금', '백만원', '09/30', '104,664,400', '-3,061,270', '-2.84%', false)}
  ${DL('신용융자', '백만원', '09/30', '33,390,129', '470,124', '1.43%')}
  ${DL('CMA잔고', '백만원', '09/30', '106,605,022', '31,333', '0.03%')}
  ${DL('국고채(3년)', '%', '10/01', '4.01', '-0.001', '-0.02%', false)}
  ${DL('회사채(3년, AA-)', '%', '10/01', '4.701', '-0.002', '-0.04%', false)}
  ${DL('주식형펀드 순자산', '억원', '09/30', '1,234', '5', '0.4%')}
</ul></body></html>`;
const NOW = new Date('2026-10-01T11:15:00Z');   // 20:15 Seoul

// ── KOFIA ──
{
  const paste = kofiaPasteFromHtml(PAGE);
  ok('the page becomes the paste format', paste.includes('* [신용융자](#)\n백만원 | 09/30\n33,390,129 470,124 1.43%'));
  ok('an unmapped row is left out', !paste.includes('주식형펀드'));
  const k = kofiaFromHtml(PAGE, NOW);
  eq('all six mapped rows parse', k.list.map(f => f.key).sort(), ['cma', 'deposits', 'kospi', 'kr3yCorp', 'kr3yGovt', 'marginLoans']);
  eq('nothing missing', k.missing, []);
  eq('margin loans: level, change, %, its own date', (({ balance, delta, pct, asOf, unit }) => ({ balance, delta, pct, asOf, unit }))(k.list.find(f => f.key === 'marginLoans')),
    { balance: 33390129, delta: 470124, pct: 1.43, asOf: '2026-09-30', unit: '백만원' });
  eq('a fall keeps its sign', k.list.find(f => f.key === 'deposits').delta, -3061270);
  eq('the recompute-% guard passes on the real page', k.anyMismatch, false);
  const bad = kofiaFromHtml(PAGE.replace('470,124', '970,124'), NOW);
  eq('a page whose % no longer matches is caught, as a bad paste is', bad.anyMismatch, true);
  eq('a page with no rows reports every key missing', kofiaFromHtml('<html></html>', NOW).missing.length, 6);
}

// ── KRX ──
const KRX = { output: [
  { TRD_DD: '20261001', INVST_TP: '기관(십억원)', ACC_BID_TRDVAL: '5,389', ACC_ASK_TRDVAL: '5,064', NETBID_TRDVAL: '325' },
  { TRD_DD: '20261001', INVST_TP: '외국인(십억원)', ACC_BID_TRDVAL: '5,716', ACC_ASK_TRDVAL: '5,597', NETBID_TRDVAL: '119' },
  { TRD_DD: '20261001', INVST_TP: '개인(십억원)', ACC_BID_TRDVAL: '5,304', ACC_ASK_TRDVAL: '6,714', NETBID_TRDVAL: '-1,410' },
] };
{
  eq('the widget → net by actor, its trade date, 십억원', krxFlowsFromJson(KRX), { date: '2026-10-01', unit: '십억원', instNet: 325, foreignNet: 119, retailNet: -1410 });
  eq('a missing actor is no reading, not a zero', krxFlowsFromJson({ output: KRX.output.slice(0, 2) }), null);
  eq('a different unit in the label is refused', krxFlowsFromJson({ output: KRX.output.map(r => ({ ...r, INVST_TP: r.INVST_TP.replace('십억원', '억원') })) }), null);
  eq('an empty answer is no reading', krxFlowsFromJson({ output: [] }), null);
}

// ── FINAL AFTER THE CLOSE ──
{
  eq('Seoul clock', seoulClock(new Date('2026-10-01T07:10:00Z')), { date: '2026-10-01', time: '16:10' });
  eq('16:10 KST: today\'s table is final', flowIsFinal('2026-10-01', new Date('2026-10-01T07:10:00Z')), true);
  eq('11:00 KST: today\'s table is a partial, not stored', flowIsFinal('2026-10-01', new Date('2026-10-01T02:00:00Z')), false);
  eq('yesterday\'s table is final whenever it is read', flowIsFinal('2026-09-30', new Date('2026-10-01T02:00:00Z')), true);
}

// ── THE STORE ──
{
  // A fixed starting store (the 29 Sep readings), never the live data file — which the scheduled
  // run keeps current, and which a test must not depend on.
  const prior = (v, unit, asOf, delta = null, pct = null) => ({ value: v, unit, asOf, delta, pct });
  const real = { latest: {
    marginLoans: prior(32920005, '백만원', '2026-09-29', 61835, 0.19), deposits: prior(107725670, '백만원', '2026-09-29', 3236436, 3.1),
    cma: prior(106573689, '백만원', '2026-09-29', -224686, -0.21), kospi: prior(6838.04, 'P', '2026-09-30', -32.77, -0.48),
    foreignNet: { value: -2065, unit: '십억원', asOf: '2026-09-30' }, units7709: { value: 833000000, asOf: '2026-09-29', delta: -3000000 },
  }, history: [], series: {} };
  const store = normaliseStore(real), before = JSON.parse(JSON.stringify(store)), snap = {};
  const k = kofiaFromHtml(PAGE, NOW);
  eq('the unit gate passes against the stored readings', unitProblems(k.list, store.latest), []);
  eq('a reading in the wrong unit is caught', unitProblems([{ ...k.list.find(f => f.key === 'marginLoans'), unit: '십억원' }], store.latest).length, 1);
  applyKofia(store, k.list, snap);
  applyFlows(store, krxFlowsFromJson(KRX), undefined, snap);
  applyFlows(store, { date: '2026-10-01', unit: '십억원', foreignNet: 229, instNet: 568, retailNet: -778 }, KOSDAQ_FLOW_KEYS, snap);
  eq('latest moves to the new readings', [store.latest.marginLoans.asOf, store.latest.foreignNet.value, store.latest.retailNetKq.value], ['2026-09-30', 119, -778]);
  ok('the series gains the dated row', store.series.foreignNet.some(r => r.date === '2026-10-01' && r.value === 119));
  ok('the store changed', storeChanged(before, store));
  appendSnapshot(store, snap, NOW.toISOString());
  const again = JSON.parse(JSON.stringify(store));
  applyKofia(again, k.list, {}); applyFlows(again, krxFlowsFromJson(KRX));
  eq('a second run on the same page changes nothing', storeChanged(store, again), false);
  // An older reading never replaces a newer `latest` — the series still takes it on its own date.
  const older = JSON.parse(JSON.stringify(store));
  applyFlows(older, { date: '2026-09-25', unit: '십억원', foreignNet: 1, instNet: 2, retailNet: 3 });
  eq('an older table does not overwrite latest', older.latest.foreignNet.asOf, '2026-10-01');
  ok('but lands in the series', older.series.foreignNet.some(r => r.date === '2026-09-25' && r.value === 1));
  eq('7709 units are untouched', store.latest.units7709, real.latest.units7709);
}

// ── WIRING ──
{
  const save = readFileSync('api/korea-save.js', 'utf8');
  ok('the hand paste merges through the same code', /from '\.\.\/lib\/koreaStore\.js'/.test(save) && /applyKofia\(store, parsed\.list, snapshot\)/.test(save));
  const wf = readFileSync('.github/workflows/korea-fetch.yml', 'utf8');
  ok('the workflow runs after the Seoul close on weekdays', /cron: '10 7 \* \* 1-5'/.test(wf) && /cron: '10 11 \* \* 1-5'/.test(wf));
  ok('and commits only data/korea_kofia.json', /git add data\/korea_kofia\.json/.test(wf) && !/git add -A|git add \./.test(wf));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
