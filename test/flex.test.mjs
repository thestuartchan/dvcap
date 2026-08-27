// test/flex.test.mjs — the Flex reader and the reconciliation, against fixture XML.
//
// There is no live call here on purpose: a test that needs a broker token is a test that does not
// run. The fixtures are the shapes IBKR actually answers with — the two-step envelope, the 1019
// "still generating" reply, a lot-level statement that would double every quantity if read naively,
// and the two symbol conventions (futures month codes, Hong Kong numerics) that make raw string
// matching fail.
import { parseFlexResponse, parseStatement, reconcile, rootOf, classOf, autoAddable, rowFromPosition,
         summarise, isoDate, sendRequestUrl, statementUrl, fetchStatement, elements, attrs, COST_TOLERANCE_PCT } from '../lib/flex.js';
import { derivePosition } from '../lib/positions.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// ── the envelope ──
const SENT = `<?xml version="1.0" encoding="UTF-8"?>
<FlexStatementResponse timestamp="27 August, 2026 09:00 AM EDT">
<Status>Success</Status>
<ReferenceCode>1234567890</ReferenceCode>
<Url>https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</Url>
</FlexStatementResponse>`;
const sent = parseFlexResponse(SENT);
ok('a successful SendRequest is ok', sent.ok);
eq('and carries the reference code', sent.referenceCode, '1234567890');
eq('and the URL to ask next', sent.url, 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement');

// IBKR answers errors with HTTP 200 and an XML body, so the status has to be read.
const BAD = `<FlexStatementResponse><Status>Fail</Status><ErrorCode>1012</ErrorCode><ErrorMessage>Token has expired.</ErrorMessage></FlexStatementResponse>`;
const bad = parseFlexResponse(BAD);
ok('a failure is not ok even though the HTTP was 200', !bad.ok);
eq('the code survives', bad.errorCode, '1012');
ok('an expired token is not retryable', !bad.retryable);
// 1019 is the one error that means "ask again in a moment".
ok('but a statement in progress is', parseFlexResponse(`<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode><ErrorMessage>Statement generation in progress.</ErrorMessage></FlexStatementResponse>`).retryable);

eq('the request URL is the documented one', sendRequestUrl('TK', 'Q1'),
  'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?t=TK&q=Q1&v=3');
eq('the statement URL uses the one the response gave', statementUrl('https://x/GetStatement', '99', 'TK'), 'https://x/GetStatement?q=99&t=TK&v=3');
ok('and falls back if it gave none', statementUrl(null, '99', 'TK').includes('/FlexWebService/GetStatement?q=99'));

// ── the statement ──
const STMT = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="dvcap" type="AF">
<FlexStatements count="1">
<FlexStatement accountId="U1234567" fromDate="20260827" toDate="20260827" period="LastBusinessDay">
<OpenPositions>
<OpenPosition accountId="U1234567" currency="USD" assetCategory="STK" symbol="INTC" description="INTEL CORP" conid="270639" multiplier="1" position="30" markPrice="88.24" costBasisPrice="98.723337" costBasisMoney="2961.70" levelOfDetail="SUMMARY" holdingPeriodDateTime="20260805;123000" />
<OpenPosition accountId="U1234567" currency="USD" assetCategory="STK" symbol="INTC" description="INTEL CORP" conid="270639" multiplier="1" position="30" markPrice="88.24" costBasisPrice="98.723337" levelOfDetail="LOT" />
<OpenPosition accountId="U1234567" currency="HKD" assetCategory="STK" symbol="0981" description="SEMICONDUCTOR MANUFACTURIN" conid="132135163" multiplier="1" position="500" markPrice="71.30" costBasisPrice="70.478952" levelOfDetail="SUMMARY" />
<OpenPosition accountId="U1234567" currency="USD" assetCategory="FUT" symbol="MGCZ6" underlyingSymbol="MGC" description="MGC DEC26" conid="789" multiplier="10" position="1" markPrice="4649.80" costBasisPrice="4649.70464" expiry="20261229" levelOfDetail="SUMMARY" />
<OpenPosition accountId="U1234567" currency="USD" assetCategory="OPT" symbol="AVGO  260828C00360000" underlyingSymbol="AVGO" description="AVGO 28AUG26 360 C" conid="456" multiplier="100" position="5" markPrice="5.98" costBasisPrice="2.554549" levelOfDetail="SUMMARY" />
<OpenPosition accountId="U1234567" currency="USD" assetCategory="STK" symbol="USFR" description="WISDOMTREE FLOATING RATE" conid="321" multiplier="1" position="1058" markPrice="50.44" costBasisPrice="50.425674" levelOfDetail="SUMMARY" />
<OpenPosition accountId="U1234567" currency="USD" assetCategory="STK" symbol="HOOD" description="ROBINHOOD MARKETS INC - A" conid="654" multiplier="1" position="100" markPrice="108.54" costBasisPrice="107.010003" levelOfDetail="SUMMARY" />
</OpenPositions>
</FlexStatement>
</FlexStatements>
</FlexQueryResponse>`;
const st = parseStatement(STMT);
eq('the account is read', st.accountId, 'U1234567');
eq('and the as-of date', st.toDate, '20260827');
// A query saved with lot detail repeats every position. Reading both would double the book.
eq('lot rows are dropped, summary rows kept', st.positions.length, 6);
eq('so the quantity is the position, not twice it', st.positions.find(p => p.root === 'INTC').qty, 30);
eq('the open date is parsed out of the IBKR stamp', st.positions.find(p => p.root === 'INTC').openDate, '2026-08-05');
// Three date formats depending on how the query was saved; all three are the same day.
eq('a bare date parses', isoDate('20260805'), '2026-08-05');
eq('a date with a time parses', isoDate('20260805;123000'), '2026-08-05');
eq('an already-ISO date passes through', isoDate('2026-08-05'), '2026-08-05');
eq('and nothing is nothing', isoDate(''), null);

// Some query templates emit `quantity` instead of `position`. Reading only one gives a book of
// zero positions and no error at all.
eq('either name for the quantity is read',
  parseStatement('<OpenPosition symbol="X" assetCategory="STK" quantity="7" costBasisPrice="10" />').positions[0].qty, 7);
eq('and a zero position is dropped, not carried as a row',
  parseStatement('<OpenPosition symbol="X" assetCategory="STK" position="0" costBasisPrice="10" />').positions, []);

// ── symbols ──
eq('a futures month code is stripped', rootOf({ symbol: 'MGCZ6', assetCategory: 'FUT' }), 'MGC');
eq('a two-digit year too', rootOf({ symbol: 'MNQU26', assetCategory: 'FUT' }), 'MNQ');
eq('but underlyingSymbol wins when Flex gives it', rootOf({ symbol: 'MGCZ6', underlyingSymbol: 'MGC', assetCategory: 'FUT' }), 'MGC');
// A stock is never month-stripped, whatever it ends in — the rule is scoped to FUT for that reason.
eq('a stock ending in a month letter is left alone', rootOf({ symbol: 'Z', assetCategory: 'STK' }), 'Z');
eq('and so is one that merely looks like a contract', rootOf({ symbol: 'ABCZ6', assetCategory: 'STK' }), 'ABCZ6');
eq('a HK numeric loses its suffix on the console side', rootOf({ symbol: '0981.HK' }), '0981');

// ── classes ──
eq('shares are shares', classOf({ assetCategory: 'STK', symbol: 'INTC' }), 'shares');
eq('futures are futures', classOf({ assetCategory: 'FUT', symbol: 'MGCZ6' }), 'futures');
eq('an option is an option', classOf({ assetCategory: 'OPT', symbol: 'AVGO' }), 'option');
// FOP expires, so it is a trade rather than a hold — the same line the card draws.
eq('and so is an option on a future', classOf({ assetCategory: 'FOP', symbol: 'OGZ6' }), 'option');
eq('a T-bill ETF is cash', classOf({ assetCategory: 'STK', symbol: 'USFR' }), 'cash');
ok('shares auto-add', autoAddable({ assetCategory: 'STK', symbol: 'HOOD' }));
ok('futures auto-add', autoAddable({ assetCategory: 'FUT', symbol: 'MGCZ6' }));
ok('options never do', !autoAddable({ assetCategory: 'OPT', symbol: 'AVGO' }));
ok('nor does a cash leg', !autoAddable({ assetCategory: 'STK', symbol: 'SGOV' }));

// ── reconciliation ──
const row = (id, symbol, fills, extra = {}) => ({ id, symbol, ...extra, fills, derived: derivePosition(fills, { multiplier: extra.multiplier || 1 }) });
const INTC = row('INTC-open', 'INTC', [{ side: 'buy', qty: 30, price: 98.723337, date: '2026-08-05' }]);
const HK = row('0981.HK-open', '0981.HK', [{ side: 'buy', qty: 500, price: 70.478952, date: '2026-07-10' }]);
const MGC = row('MGC-DEC26', 'MGC', [{ side: 'buy', qty: 1, price: 4649.70464, date: '2026-08-26' }], { margined: true, multiplier: 10 });
const HOOD_SHORT = row('HOOD-open', 'HOOD', [{ side: 'buy', qty: 50, price: 107.010003, date: '2026-08-21' }]);

const rec = reconcile([INTC, HK, MGC, HOOD_SHORT], st.positions, { today: '2026-08-27', asOf: '2026-08-27' });
eq('positions that match are quiet', rec.agree.map(a => a.root).sort(), ['0981', 'INTC', 'MGC']);
// A quantity must agree exactly. 50 against 100 is a fill the console never recorded.
eq('a quantity disagreement is reported', rec.differs.map(d => d.root), ['HOOD']);
eq('with both numbers, so it can be judged', rec.differs[0].qty, { console: 50, ibkr: 100 });
eq('and nothing invented for the part that agrees', rec.differs[0].avg, null);
// USFR is cash and AVGO is an option: reported, never added.
eq('nothing outside the console scope is auto-added', rec.adds, []);
eq('they are reported instead', rec.report.filter(r => r.kind === 'unmatched').map(r => `${r.root}:${r.assetClass}`).sort(), ['AVGO:option', 'USFR:cash']);

// A share the console has never seen IS added.
const withNew = parseStatement(STMT.replace('</OpenPositions>',
  '<OpenPosition accountId="U1234567" currency="USD" assetCategory="STK" symbol="NVDA" description="NVIDIA CORP" conid="4815747" multiplier="1" position="20" markPrice="181.00" costBasisPrice="175.25" levelOfDetail="SUMMARY" /></OpenPositions>'));
const rec2 = reconcile([INTC, HK, MGC], withNew.positions, { today: '2026-08-27', asOf: '2026-08-27' });
eq('an unseen share is added', rec2.adds.map(r => r.symbol), ['HOOD', 'NVDA']);
const nvda = rec2.adds.find(r => r.symbol === 'NVDA');
eq('at the broker average cost, as one fill', nvda.fills, [{ id: 'f0', side: 'buy', qty: 20, price: 175.25, date: '2026-08-27', note: 'IBKR position average cost' }]);
eq('tagged so it is obvious where it came from', nvda.tags, ['new', 'flex']);
ok('and says in the row that the history is flat by construction', /statement reports a position, not the fills/.test(nvda.thesis));

// Hong Kong and futures come back in the console's own naming, not the broker's.
const hkAdd = reconcile([], st.positions, { today: '2026-08-27' }).adds;
eq('a HK numeric is added with the suffix the quote feed needs', hkAdd.find(r => r.symbol.startsWith('0981')).symbol, '0981.HK');
const mgcAdd = hkAdd.find(r => r.symbol === 'MGC');
ok('a future is added margined', mgcAdd.margined);
eq('with its multiplier', mgcAdd.multiplier, 10);

// Open here, absent there. NEVER removed — a sync that silently drops positions erases the book.
const rec3 = reconcile([INTC, row('SOXS-open', 'SOXS', [{ side: 'buy', qty: 50, price: 52.63, date: '2026-08-20' }])], st.positions, { today: '2026-08-27' });
const gone = rec3.report.filter(r => r.kind === 'missing-at-broker');
eq('a console row the broker does not have is reported', gone.map(g => g.root), ['SOXS']);
ok('and not deleted', !('remove' in rec3));

// Two open rows in one symbol cannot be resolved from a statement that knows nothing of the split.
const dup = reconcile([INTC, row('INTC-2', 'INTC', [{ side: 'buy', qty: 5, price: 90, date: '2026-08-20' }])], st.positions, { today: '2026-08-27' });
eq('an ambiguous match is declared, not guessed', dup.ambiguous.map(a => a.root), ['INTC']);
eq('and neither row is touched', dup.differs.filter(d => d.root === 'INTC'), []);

// Cost basis gets a tolerance; quantity does not.
const drift = reconcile([row('INTC-open', 'INTC', [{ side: 'buy', qty: 30, price: 98.5, date: '2026-08-05' }])],
  st.positions.filter(p => p.root === 'INTC'), { today: '2026-08-27' });
eq('a small cost difference is within tolerance', drift.agree.length, 1);
ok('the tolerance is a fraction of a percent', COST_TOLERANCE_PCT < 1);
const bigDrift = reconcile([row('INTC-open', 'INTC', [{ side: 'buy', qty: 30, price: 90, date: '2026-08-05' }])],
  st.positions.filter(p => p.root === 'INTC'), { today: '2026-08-27' });
eq('a real one is not', bigDrift.differs[0].avg, { console: 90, ibkr: 98.723337 });

// ── the summary ──
ok('a clean run says so', /all 3 positions reconcile/.test(summarise(reconcile([INTC, HK, MGC], st.positions.filter(p => ['INTC', '0981', 'MGC'].includes(p.root)), {}))));
const line = summarise(rec);
ok('otherwise it names what happened', /HOOD/.test(line) && /not auto-added/.test(line));
// Nothing in the summary is a size or a price — it goes to a channel.
ok('and never a quantity', !/\b(50|100|1058)\b/.test(line));

// ── the two hops ──
const responses = (...bodies) => { let i = 0; return async () => { const b = bodies[Math.min(i++, bodies.length - 1)]; return { ok: true, status: 200, text: async () => b }; }; };
const r1 = await fetchStatement({ token: 'T', queryId: 'Q', fetchImpl: responses(SENT, STMT), sleep: async () => {} });
ok('a two-hop fetch returns the statement', r1.ok && r1.statement.positions.length === 6);
// The first GetStatement almost always answers 1019.
const r2 = await fetchStatement({ token: 'T', queryId: 'Q', fetchImpl: responses(SENT, '<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode></FlexStatementResponse>', STMT), sleep: async () => {} });
ok('and retries through "still generating"', r2.ok);
const r3 = await fetchStatement({ token: 'T', queryId: 'Q', fetchImpl: responses(BAD), sleep: async () => {} });
ok('a bad token fails with the reason', !r3.ok && /1012/.test(r3.error));
const r4 = await fetchStatement({ token: '', queryId: '', fetchImpl: responses(SENT, STMT) });
ok('and no credentials fails before the network', !r4.ok && /IBKR_FLEX_TOKEN/.test(r4.error));
const r5 = await fetchStatement({ token: 'T', queryId: 'Q', fetchImpl: responses(SENT, '<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode></FlexStatementResponse>'), sleep: async () => {}, attempts: 2 });
ok('a statement that never arrives gives up saying so', !r5.ok && /still generating/.test(r5.error));
// A query saved WITHOUT open positions produces a statement that parses to nothing — a silent
// no-op is the worst answer, so it is an error naming the fix.
const r6 = await fetchStatement({ token: 'T', queryId: 'Q', fetchImpl: responses(SENT, '<FlexQueryResponse><FlexStatements count="1"></FlexStatements></FlexQueryResponse>'), sleep: async () => {} });
ok('a query with no positions section says which box to tick', !r6.ok && /Open Positions/.test(r6.error));

// ── the reader ──
eq('attributes are read off a tag', attrs('<X a="1" b="two" />'), { a: '1', b: 'two' });
eq('entities are decoded', attrs('<X d="AT&amp;T" />').d, 'AT&T');
eq('and not double-decoded', attrs('<X d="&amp;lt;" />').d, '&lt;');
eq('elements are found whether or not they self-close', elements('<A x="1"/><A x="2"></A>', 'A').map(a => a.x), ['1', '2']);

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
