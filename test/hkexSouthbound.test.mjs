// test/hkexSouthbound.test.mjs — the aggregate Southbound net from HKEX's daily file.
import { parseDailyStat, candidateDays, fetchSouthbound, mergeSouthbound } from '../lib/hkexSouthbound.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

// The shape of the real file (2026-09-24), trimmed to the two Southbound channels.
const leg = (market, date, buy, sell) => ({ id: 1, date, market, tradingDay: 1, content: [{ style: 1, table: { classname: 'tradingTable',
  schema: [['Total Turnover', 'Buy Turnover', 'Sell Turnover', 'Total Trade Count', 'Buy Trade Count', 'Sell Trade Count', 'ETF Turnover']],
  tr: [[''], [buy], [sell], [''], [''], [''], ['']].map((v, i) => ({ td: [[i === 1 ? buy : i === 2 ? sell : '1']] })) } }] });
const file = (date, sse, szse) => `tabData = ${JSON.stringify([
  { id: 0, date, market: 'SSE Northbound', tradingDay: 0, content: [] },
  leg('SSE Southbound', date, ...sse), leg('SZSE Southbound', date, ...szse)])};`;

const d24 = parseDailyStat(file('2026-09-24', ['22,121.38', '19,022.52'], ['10,828.73', '11,027.82']));
eq('HK$ mn buy − sell across both channels, in HK$ bn', [d24.date, d24.aggregateNet], ['2026-09-24', 2.9]);
eq('turnover alongside', d24.turnover, 63.0);
eq('an all-zero day is a closed day, never a flat one', parseDailyStat(file('2026-09-25', ['0.00', '0.00'], ['0.00', '0.00'])), { date: '2026-09-25', closed: true });
eq('garbage is null', parseDailyStat('tabData = nope'), null);
eq('weekdays only, newest first', candidateDays('2026-09-28', 5), ['2026-09-28', '2026-09-25', '2026-09-24']);

// The fetch: files by date, a closed day skipped, a missing future file ignored.
const files = {
  '20260924': file('2026-09-24', ['22,121.38', '19,022.52'], ['10,828.73', '11,027.82']),
  '20260923': file('2026-09-23', ['20,000', '21,000'], ['9,000', '8,500']),
  '20260925': file('2026-09-25', ['0.00', '0.00'], ['0.00', '0.00']),
};
const fakeFetch = async (url) => { const m = /daily_(\d{8})e/.exec(url); const t = files[m[1]]; return t ? { ok: true, status: 200, text: async () => t } : { ok: false, status: 404, text: async () => '' }; };
const got = await fetchSouthbound({ now: new Date('2026-09-27T12:00:00Z'), fetchImpl: fakeFetch, kv: false });
eq('the series, oldest first, closed day left out', got.series.map(r => [r.date, r.aggregateNet]), [['2026-09-23', -0.5], ['2026-09-24', 2.9]]);
eq('latest is the last session', got.latest.date, '2026-09-24');

// A hand-entered row still wins for its day; the SMIC holding rides along.
const merged = mergeSouthbound(got.series, [{ date: '2026-09-24', aggregateNet: 3.1, smicHolding: 22.4 }, { date: '2026-09-22', smicHolding: 22.1 }]);
eq('manual overrides the day it covers', merged.find(r => r.date === '2026-09-24').aggregateNet, 3.1);
eq('and says so', merged.find(r => r.date === '2026-09-24').source, 'manual');
eq('auto fills the rest', merged.find(r => r.date === '2026-09-23').source, 'hkex');
eq('a manual SMIC-only row keeps no invented net', merged.find(r => r.date === '2026-09-22').aggregateNet, undefined);

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
