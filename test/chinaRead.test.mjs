// test/chinaRead.test.mjs — the China read (lib/chinaRead.js) and the official PMI reader
// (lib/chinaPmi.js). Made-up series; the PMI fixture copies the release's sentence shapes.
import { chinaRead, moneyRow, stocksRow, yuanRow, tapeRow, growthRow, chinaEvents, RULES } from '../lib/chinaRead.js';
import { pmiLinkFromList, pmiFromRelease } from '../lib/chinaPmi.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

// A series of `n` closes from `start`, moving `step` a session, dated from 2026-06-01.
const series = (n, start, step) => Array.from({ length: n }, (_, i) => [new Date(Date.UTC(2026, 5, 1) + i * 86400000).toISOString().slice(0, 10), start + i * step]);
const flows = (vals) => vals.map((v, i) => ({ date: new Date(Date.UTC(2026, 9, 1) + i * 86400000).toISOString().slice(0, 10), aggregateNet: v }));

// ── THE OFFICIAL PMI, FROM THE NBS CHINESE PAGE ──
{
  const list = `<li><a class="fl pc_1600" href="./202610/t20261031_1965718.html" target="_blank" title='2026年10月中国采购经理指数运行情况'>2026年10月中国采购经理指数运行情况</a></li>
    <li><a href="./202610/t20261030_1965711.html" title='其他'>其他</a></li>`;
  eq('the newest PMI release on the list', pmiLinkFromList(list), { url: 'https://www.stats.gov.cn/sj/zxfb/202610/t20261031_1965718.html', period: '2026-10' });
  eq('a list with no PMI release', pmiLinkFromList('<a href="x" title="其他">x</a>'), null);
  const page = `<meta name="PubDate" content="2026/10/31 09:30"><h1>2026年10月中国采购经理指数运行情况</h1>
    <p>10 月份，制造业采购经理指数（ PMI ）为 49.3% ，比上月下降 0.8 个百分点。</p>
    <p>新订单指数为 49.4% ，比上月下降 1.1 个百分点。</p>
    <p>10 月份，非制造业商务活动指数为 49.7% ，比上月下降 0.5 个百分点。</p>
    <p>10 月份，综合 PMI 产出指数为 49.7% ，比上月下降 1.0 个百分点。</p>`;
  eq('the release, read through its spacing', pmiFromRelease(page),
    { period: '2026-10', published: '2026-10-31', manufacturing: 49.3, mfgChange: -0.8, newOrders: 49.4, nonMfg: 49.7, nonMfgChange: -0.5, composite: 49.7 });
  eq('a rise is positive', pmiFromRelease(page.replace('比上月下降 0.8', '比上月上升 0.4')).mfgChange, 0.4);
  eq('unchanged is zero', pmiFromRelease(page.replace('比上月下降 0.8 个百分点', '与上月持平')).mfgChange, 0);
  eq('no manufacturing headline, no reading', pmiFromRelease(page.replace('制造业采购经理指数（ PMI ）为 49.3%', '')), null);
}

// ── EACH ROW, ON ITS STATED RULE ──
{
  eq('money: 5 and 20 days both buying', moneyRow(flows(Array(20).fill(1))).state, 'support');
  eq('money: both selling', moneyRow(flows(Array(20).fill(-1))).state, 'risk');
  eq('money: 20 days buying, the last 5 selling', moneyRow(flows([...Array(15).fill(2), ...Array(5).fill(-1)])).state, 'neutral');
  eq('money: no file is no data, not neutral', moneyRow([]).state, 'unknown');

  const up = series(70, 100, 0.2), down = series(70, 114, -0.2);
  eq('stocks: above the 50-day and up 2%+ in 20 days', stocksRow(up).state, 'support');
  eq('stocks: below it and down 2%+', stocksRow(down).state, 'risk');
  eq('stocks: flat', stocksRow(series(70, 100, 0)).state, 'neutral');

  const firm = series(30, 7.1, -0.004), weak = series(30, 7.0, 0.004);
  eq('yuan: USD/CNY down more than 0.5% is a firming yuan', yuanRow(firm).state, 'support');
  eq('yuan: up more than 0.75% is a weakening one', yuanRow(weak).state, 'risk');
  ok('yuan: the flip levels are prices', /below \d\.\d{4}, weakening above \d\.\d{4}/.test(yuanRow(firm).flips));

  eq('tape: above both averages', tapeRow(series(220, 100, 0.1)).state, 'support');
  eq('tape: below both', tapeRow(series(220, 122, -0.1)).state, 'risk');
  const between = [...series(200, 100, 0.1), ...series(20, 119, -0.4)];
  eq('tape: below the 50-day, above the 200-day', tapeRow(between).state, 'neutral');

  eq('growth: PMI under 50 and falling', growthRow({ ok: true, manufacturing: 49.3, mfgChange: -0.8, period: '2026-10' }).state, 'risk');
  eq('growth: over 50 and rising', growthRow({ ok: true, manufacturing: 50.6, mfgChange: 0.3, period: '2026-10' }).state, 'support');
  eq('growth: over 50 but falling is mixed', growthRow({ ok: true, manufacturing: 50.2, mfgChange: -0.4, period: '2026-10' }).state, 'neutral');
  eq('growth: no PMI and no copper is no data', growthRow(null, null).state, 'unknown');
  eq('the PMI line is 50', RULES.pmiLine, 50);
}

// ── THE VERDICT ──
{
  const risk = chinaRead({ southbound: flows(Array(20).fill(-1)), closes: { csi300: series(70, 114, -0.2), cnh: series(30, 7.0, 0.004), hstech: series(220, 122, -0.1) },
    pmi: { ok: true, manufacturing: 49.3, mfgChange: -0.8, period: '2026-10' } });
  eq('five down: risk-off', [risk.verdict, risk.score, risk.of], ['risk-off', -5, 5]);
  ok('…said plainly', /^Risk-off: .*mainland money is leaving Hong Kong.*HK tech is in a downtrend/.test(risk.headline));
  const mixed = chinaRead({ southbound: flows(Array(20).fill(1)), closes: { csi300: series(70, 114, -0.2), cnh: series(30, 7.0, 0), hstech: series(220, 100, 0.1) },
    pmi: { ok: true, manufacturing: 49.3, mfgChange: -0.8, period: '2026-10' } });
  eq('two up, two down, one flat: mixed', [mixed.verdict, mixed.score], ['mixed', 0]);
  ok('…naming both sides', /^Mixed: mainland money is flowing into Hong Kong and HK tech is in an uptrend, but /.test(mixed.headline));
  eq('fewer than three rows read: no verdict', chinaRead({ southbound: flows([1]) }).verdict, 'unknown');
}

// ── THE NEXT CHINA DATA, FROM THE CALENDAR ──
{
  const cal = [
    { date: '2026-11-09', time: '09:30', tz: 'Asia/Shanghai', title: 'China CPI + PPI (Oct)' },
    { date: '2026-11-10', title: 'US CPI (Oct)' },
    { date: '2026-11-20', title: 'PBoC Loan Prime Rate' },
    { date: '2026-12-31', title: 'China NBS PMI (Dec)' },
  ];
  eq('China and PBoC events in the next two weeks', chinaEvents(cal, { now: new Date('2026-11-08T00:00:00Z') }).map(e => e.title), ['China CPI + PPI (Oct)', 'PBoC Loan Prime Rate']);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
