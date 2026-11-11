// test/uwCloseLines.test.mjs — UW build step 12: UW lines on the private close cards. The Desk card
// gets each name's flow for the day (kept by the 16:12 pull); the flow close card gets the gamma
// agreement line (step 11). Fake tickers and made-up numbers only.
import { flowLineShort, usTickerOf, snapNameRows, gammaLine, closeCard, UW_NAMES_KEY } from '../lib/uw.js';
import { deskAlertCard } from '../lib/deskRules.js';
import { namesOut, closeOut, gammaToday } from '../lib/routes/flow.js';
import { UW_GAMMA_KEY } from '../lib/uwGamma.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const memKv = () => { const m = new Map(); return { m, configured: () => true, get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); return true; } }; };

// ── one name's line ──
const loud = { ticker: 'SAMPLE', net: 12e6, alerts: 4, sweeps: 3, top: { type: 'call', strike: 100, expiry: '2030-01-18', premium: 2.1e6, side: 'ask', sweep: true, opening: true } };
eq('line: notable flow leads with the lean', flowLineShort(loud).split('\n')[0], 'UW flow today: **bullish** options flow +$12.0M · 4 unusual trades · 3 opening sweeps');
eq('line: notable flow names the biggest trade', /^Biggest: calls bought \$2\.1M · 100 /.test(flowLineShort(loud).split('\n')[1]), true);
eq('line: quiet name says quiet', flowLineShort({ ticker: 'SAMPLF', net: 4e5, alerts: 1, sweeps: 0, top: null }), 'UW flow today: quiet (net +$400k)');
eq('line: no data → no line', flowLineShort({ ticker: 'SAMPLF', net: null, alerts: 0 }), null);

// ── tickers ──
eq('ticker: exchange prefix stripped', usTickerOf('NASDAQ:SAMPL'), 'SAMPL');
eq('ticker: bare', usTickerOf('SAMPL'), 'SAMPL');
eq('ticker: a ratio is not one ticker', usTickerOf('SAMPL/SAMPM'), null);
eq('ticker: non-US exchange', usTickerOf('KRX:005930'), null);

// ── QQQ/SPY rows from the close snapshot, today's alerts only ──
const snap = { tide: { date: '2030-01-02', net: 1, netCall: 2, netPut: 1, lean: 'calls' }, tickers: { SAMPLE: { netPrem: { net: -6e6 }, alerts: [
  { type: 'put', strike: 99, premium: 3e6, side: 'ask', sweep: true, opening: true, at: '2030-01-02T15:00:00Z' },
  { type: 'call', strike: 101, premium: 9e6, side: 'ask', at: '2030-01-01T15:00:00Z' }] } } };
const sr = snapNameRows(snap, '2030-01-02')[0];
eq('snap rows: yesterday\'s alert left out', [sr.alerts, sr.top.strike, sr.sweeps, sr.net], [1, 99, 1, -6e6]);

// ── the Desk card ──
const hits = { fresh: [{ name: 'SAMPLE · Mar \'30 call spread', rule: { state: 'hit', kind: 'stop', text: 'close below 100.00', symbol: 'NASDAQ:SAMPLE' } }], near: [] };
const withFlow = deskAlertCard(hits, { today: '2030-01-02', flowFor: () => 'UW flow today: quiet (net +$400k)' });
eq('desk: flow line under the rule', withFlow.embeds[0].fields[0].value, 'Stop · close below 100.00\nUW flow today: quiet (net +$400k)');
eq('desk: no flowFor → card unchanged', deskAlertCard(hits, { today: '2030-01-02' }).embeds[0].fields[0].value, 'Stop · close below 100.00');

// ── the gamma line ──
const g = { ok: true, session: 'open', agree: 4, scored: 4, checks: [] };
eq('gamma: agreement', gammaLine(g), "Gamma: UW's board **agrees** with dvcap's (4 of 4 checks, open read)");
eq('gamma: names what differs, short names', gammaLine({ ...g, agree: 3, checks: [{ name: 'put wall ↔ trapdoor', score: true, state: 'differ' }] }),
  "Gamma: UW's board **differs** from dvcap's on put wall (3 of 4 agree, open read)");
eq('gamma: nothing scored → no line', gammaLine({ ok: true, scored: 0 }), null);
const cc = closeCard({ ...snap, tickers: { SAMPLE: { netPrem: { net: 1e6 } } } }, { gamma: { SAMPLE: g } });
eq('close card: gamma line in the ticker field', /Gamma: UW's board \*\*agrees\*\*/.test(cc.embeds[0].fields.find(f => f.name === 'SAMPLE').value), true);
eq('close card: no gamma → no line', /Gamma:/.test(JSON.stringify(closeCard(snap))), false);

// ── the day's gamma readings ──
const kvG = memKv();
kvG.m.set(UW_GAMMA_KEY, [{ ok: true, symbol: 'SAMPLE', date: '2030-01-02', at: '2030-01-02T15:15:00Z', session: 'open', agree: 4, scored: 4, checks: [] },
  { ok: true, symbol: 'SAMPLE', date: '2030-01-01', at: '2030-01-01T22:00:00Z', session: 'close' }]);
eq('gammaToday: today\'s reading only', (await gammaToday('2030-01-02', kvG)).SAMPLE.session, 'open');
const sent = [];
await closeOut(snap, { kv: kvG, deliver: async (url, p) => { sent.push(p); return 'msg-1'; }, env: { DISCORD_PRIVATE_WEBHOOK: 'https://discord.com/api/webhooks/1/tok' } });
eq('closeOut: the posted card carries the gamma line', sent.length === 1 && /Gamma: UW's board/.test(JSON.stringify(sent[0])), true);

// ── the 16:12 pull keeps every name's row for the Desk card ──
const kvN = memKv();
kvN.m.set('dvcap:desk:rules:v1', { positions: [{ rules: [{ symbol: 'NASDAQ:SAMPL' }] }] });
const getN = async (path) => (/net-prem/.test(path) ? { data: [{ net_call_premium: '100000', net_put_premium: '0' }] } : { data: [] });
await namesOut({ kv: kvN, get: getN, deliver: async () => ({ ok: true }), env: {}, now: new Date('2030-01-02T21:12:00Z'), snap });
const kept = kvN.m.get(UW_NAMES_KEY);
eq('names: day kept', kept?.day, '2030-01-02');
eq('names: Desk name and snapshot tickers kept, notable or not', (kept?.rows || []).map(r => r.ticker).sort(), ['SAMPL', 'SAMPLE']);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
