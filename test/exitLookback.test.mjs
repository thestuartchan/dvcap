// test/exitLookback.test.mjs — the ranged statement that finds an option card's exit
// (lib/exitLookback.js): resumed across Re-checks, kept once read, fitted to the time left, and
// never dropped without a word. Fake tickers and figures.
import { readExitWindow, attemptsWithin, lookbackLine, RANGE_PENDING_KEY, RANGE_UNITS_KEY } from '../lib/exitLookback.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const SENT = (ref) => `<FlexStatementResponse><Status>Success</Status><ReferenceCode>${ref}</ReferenceCode><Url>https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</Url></FlexStatementResponse>`;
const GEN = '<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode><ErrorMessage>Statement generation in progress.</ErrorMessage></FlexStatementResponse>';
const opt = (o) => `<Order accountId="U0000000" currency="USD" assetCategory="OPT" symbol="ZZZ 261030${o.pc}00${o.k}000" conid="77${o.k}" underlyingSymbol="ZZZ" multiplier="100" strike="${o.k}" expiry="20261030" putCall="${o.pc}" tradeDate="20261029" dateTime="20261029;150000" buySell="SELL" quantity="-1" tradePrice="${o.px}" ibCommission="0" ibOrderID="${o.oid}" levelOfDetail="ORDER" transactionType="ExchTrade" />`;
const STMT = `<FlexQueryResponse queryName="q" type="AF"><FlexStatements count="1"><FlexStatement accountId="U0000000" fromDate="20261016" toDate="20261030" period="Custom">
<OpenPositions></OpenPositions><Trades>${opt({ k: 100, pc: 'P', px: 1.1, oid: 9001 })}${opt({ k: 120, pc: 'C', px: 0.9, oid: 9002 })}</Trades>
</FlexStatement></FlexStatements></FlexQueryResponse>`;

const memKv = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => { if (v == null) m.delete(k); else m.set(k, v); } }; };
const seq = (...bodies) => { const urls = []; let i = 0; const f = async (u) => { urls.push(String(u)); const b = bodies[Math.min(i++, bodies.length - 1)]; return { ok: true, status: 200, text: async () => b }; }; f.urls = urls; return f; };
const back = { from: '2026-10-16', to: '2026-10-30' };
const base = { token: 'T', queryId: 'Q', sleep: async () => {} };

// ── STILL BUILDING: REMEMBERED, NOT DROPPED ──
{
  const kv = memKv();
  const f1 = seq(SENT('R1'), GEN);
  const r1 = await readExitWindow(back, { ...base, kv, fetchImpl: f1, budgetMs: 8000 });
  eq('IBKR still building: says pending, no units', [r1.state, r1.units], ['pending', null]);
  eq('…and remembers the request for the next Re-check (no token stored)', [kv.m.get(RANGE_PENDING_KEY)?.referenceCode, JSON.stringify(kv.m.get(RANGE_PENDING_KEY)).includes('T&')], ['R1', false]);
  eq('the banner says so', /still building/.test(lookbackLine(back, r1)), true);

  const f2 = seq(STMT);
  const r2 = await readExitWindow(back, { ...base, kv, fetchImpl: f2, budgetMs: 8000 });
  eq('next Re-check polls THAT request, no new SendRequest', [r2.state, f2.urls.some(u => /SendRequest/.test(u)), f2.urls.some(u => /q=R1/.test(u))], ['read', false, true]);
  eq('…reads the exit orders', r2.units.filter(u => u.type === 'OPT' || u.type === 'COMBO').length >= 1, true);
  eq('…forgets the pending request and keeps the units', [kv.m.has(RANGE_PENDING_KEY), kv.m.get(RANGE_UNITS_KEY)?.from], [false, '2026-10-16']);

  const f3 = seq(GEN);
  const r3 = await readExitWindow(back, { ...base, kv, fetchImpl: f3 });
  eq('a third Re-check uses the kept units, asks IBKR nothing', [r3.state, f3.urls.length], ['cached', 0]);
  const r4 = await readExitWindow({ from: '2026-10-16', to: '2026-11-02' }, { ...base, kv, fetchImpl: seq(SENT('R2'), GEN), budgetMs: 4000 });
  eq('a new statement day reads afresh', r4.state, 'pending');
}

// ── A PENDING REQUEST FOR ANOTHER RANGE IS NOT RESUMED ──
{
  const kv = memKv();
  await kv.set(RANGE_PENDING_KEY, { from: '2026-10-01', to: '2026-10-29', url: 'https://ndcdyn.interactivebrokers.com/x', referenceCode: 'OLD' });
  const f = seq(SENT('R9'), STMT);
  const r = await readExitWindow(back, { ...base, kv, fetchImpl: f, budgetMs: 8000 });
  eq('other range: a fresh request', [r.state, f.urls.some(u => /OLD/.test(u)), f.urls.some(u => /SendRequest/.test(u))], ['read', false, true]);
}

// ── REFUSED: SAID, NOT SILENT ──
{
  const r = await readExitWindow(back, { ...base, kv: memKv(), fetchImpl: seq('<FlexStatementResponse><Status>Fail</Status><ErrorCode>1020</ErrorCode><ErrorMessage>Invalid request</ErrorMessage></FlexStatementResponse>') });
  eq('refused: failed, with the reason', [r.state, /1020/.test(r.error)], ['failed', true]);
  eq('the banner says to Re-check or record by hand', /record it by hand/.test(lookbackLine(back, r)), true);
}

// ── THE WAIT FITS THE TIME LEFT ──
{
  const W = [3000, 3000, 4000, 5000, 6000, 7000, 8000, 9000];
  eq('3s left: one poll', attemptsWithin(3000, W), 1);
  eq('20s left: a few polls', attemptsWithin(20000, W), 4);
  eq('lots of time: capped at the full schedule', attemptsWithin(999999, W), W.length + 1);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
