// test/flex.test.mjs — the Flex reader and the reconciliation, against fixture XML.
//
// There is no live call here on purpose: a test that needs a broker token is a test that does not
// run. The fixtures are the shapes IBKR actually answers with — the two-step envelope, the 1019
// "still generating" reply, a lot-level statement that would double every quantity if read naively,
// and the two symbol conventions (futures month codes, Hong Kong numerics) that make raw string
// matching fail.
import { parseFlexResponse, parseStatement, reconcile, rootOf, classOf, autoAddable, summarise, summariseActionable, actionable, signatureOf, isoDate, matchKey, planAck, sendRequestUrl, statementUrl, fetchStatement, elements, attrs, COST_TOLERANCE_PCT, asOfState } from '../lib/flex.js';
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

// IBKR_FLEX_BASE OVERRIDES THE HOST, so these two assertions were reading the environment rather
// than the code. Harmless locally, where it is unset — and the build runs this file with the
// DEPLOYMENT's variables, which is how the same class of mistake in test/hyperliquid.test.mjs
// took production down for the better part of an hour. Cleared and restored here so the answer is
// the same everywhere it runs.
{
  const saved = process.env.IBKR_FLEX_BASE;
  delete process.env.IBKR_FLEX_BASE;
  eq('the request URL is the documented one', sendRequestUrl('TK', 'Q1'),
    'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?t=TK&q=Q1&v=3');
  eq('the statement URL uses the one the response gave', statementUrl('https://x/GetStatement', '99', 'TK'), 'https://x/GetStatement?q=99&t=TK&v=3');
  ok('and falls back if it gave none', statementUrl(null, '99', 'TK').includes('/FlexWebService/GetStatement?q=99'));
  // And the override still works when it IS set — the point of the variable, now asserted rather
  // than assumed from its absence.
  process.env.IBKR_FLEX_BASE = 'https://flex.example';
  ok('a configured base overrides the host', sendRequestUrl('TK', 'Q1').startsWith('https://flex.example/'));
  if (saved === undefined) delete process.env.IBKR_FLEX_BASE; else process.env.IBKR_FLEX_BASE = saved;
}

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
// CURRENCY IS PART OF THE ROW. This fixture had none and defaulted to USD against a statement line
// in HKD, and it matched anyway — because the key was the root alone. That is the collapse the
// instrument key exists to end, so the fixture now says what the row would actually carry.
const HK = row('0981.HK-open', '0981.HK', [{ side: 'buy', qty: 500, price: 70.478952, date: '2026-07-10' }], { currency: 'HKD' });
const MGC = row('MGC-DEC26', 'MGC', [{ side: 'buy', qty: 1, price: 4649.70464, date: '2026-08-26' }], { margined: true, multiplier: 10 });
const HOOD_SHORT = row('HOOD-open', 'HOOD', [{ side: 'buy', qty: 50, price: 107.010003, date: '2026-08-21' }]);

const rec = reconcile([INTC, HK, MGC, HOOD_SHORT], st.positions, { today: '2026-08-27', asOf: '2026-08-27' });
eq('positions that match are quiet', rec.agree.map(a => a.root).sort(), ['0981', 'INTC', 'MGC']);
// A quantity must agree exactly. 50 against 100 is a fill the console never recorded.
eq('a quantity disagreement is reported', rec.differs.map(d => d.root), ['HOOD']);
eq('with both numbers, so it can be judged', rec.differs[0].qty, { console: 50, ibkr: 100 });
eq('and nothing invented for the part that agrees', rec.differs[0].avg, null);
// USFR is cash; AVGO is an option the console does not hold, expiring the day after the statement
// with no open date given — by the 0/1DTE rule a day trade, set aside rather than announced.
eq('nothing outside the console scope is auto-added', rec.adds, []);
eq('cash is reported as unmatched', rec.report.filter(r => r.kind === 'unmatched').map(r => `${r.root}:${r.assetClass}`).sort(), ['USFR:cash']);
eq('and the next-day option as a day trade', rec.report.filter(r => r.kind === 'daytrade-option').map(r => r.root), ['AVGO']);

// A share the console has never seen IS added.
const withNew = parseStatement(STMT.replace('</OpenPositions>',
  '<OpenPosition accountId="U1234567" currency="USD" assetCategory="STK" symbol="NVDA" description="NVIDIA CORP" conid="4815747" multiplier="1" position="20" markPrice="181.00" costBasisPrice="175.25" levelOfDetail="SUMMARY" /></OpenPositions>'));
const rec2 = reconcile([INTC, HK, MGC], withNew.positions, { today: '2026-08-27', asOf: '2026-08-27' });
eq('an unseen share is added', rec2.adds.map(r => r.symbol), ['HOOD', 'NVDA']);
const nvda = rec2.adds.find(r => r.symbol === 'NVDA');
eq('at the broker average cost, as one fill', nvda.fills, [{ id: 'f0', side: 'buy', qty: 20, price: 175.25, date: '2026-08-27', note: 'IBKR position average cost' }]);
eq('tagged so it is obvious where it came from', nvda.tags, ['new', 'flex']);
ok('and says in the row that the history is flat by construction', /statement reports a position, not the fills/.test(nvda.thesis));

// ── the same instrument under two names ──
// ── ONE ROOT, TWO LISTINGS ───────────────────────────────────────────────────
// ASML trades on Nasdaq in dollars and on Euronext Amsterdam in euros, and IBKR reports both as
// `ASML`. The console tells them apart as `ASML` and `ASML.AS`; rootOf() strips the suffix, and
// keyed by root alone the statement side kept whichever listing came second and lost the first.
{
  const nasdaq = row('ASML-us', 'ASML', [{ side: 'buy', qty: 10, price: 900, date: '2026-09-01' }], { currency: 'USD' });
  const ams    = row('ASML-eu', 'ASML.AS', [{ side: 'buy', qty: 5, price: 820, date: '2026-09-01' }], { currency: 'EUR' });
  const both = [
    { root: 'ASML', symbol: 'ASML', currency: 'USD', qty: 10, costBasisPrice: 900, assetCategory: 'STK' },
    { root: 'ASML', symbol: 'ASML', currency: 'EUR', qty: 5,  costBasisPrice: 820, assetCategory: 'STK' },
  ];
  const r = reconcile([nasdaq, ams], both, { today: '2026-09-13' });
  eq('both listings match, each to its own row', r.agree.map(a => a.rowId ?? a.id).sort(), ['ASML-eu', 'ASML-us'].sort());
  eq('neither is ambiguous', r.ambiguous, []);
  eq('nothing is added', r.adds, []);
  eq('and nothing is reported', r.report, []);
  // THE OLD FAILURE, PINNED. With one listing in the console and both at the broker, the second is
  // named as a currency mismatch — never matched to the wrong row, never silently dropped.
  const one = reconcile([nasdaq], both, { today: '2026-09-13' });
  eq('the held listing still matches', one.agree.length, 1);
  eq('the other is reported, not added', [one.adds.length, one.report.length], [0, 1]);
  eq('as a currency mismatch', one.report[0].kind, 'currency-mismatch');
  eq('naming the row it collides with', one.report[0].rowIds, ['ASML-us']);
}

// ── A ROW WHOSE CURRENCY IS WRONG IS NAMED ONCE, AS THAT ────────────────────
// The other way the same key mismatches: an HK stock left on USD in the console. Under the full
// key it no longer matches, and the first cut of this then reported it TWICE — as a currency
// mismatch and, because its key was never seen, as missing at the broker. One row, one verdict.
{
  const wrongCcy = row('0981.HK-usd', '0981.HK', [{ side: 'buy', qty: 500, price: 70.478952, date: '2026-07-10' }]);   // no currency → USD
  // The statement carries `0981`; matchKey normalises to `981`. Filter on the normalised form.
  const r = reconcile([wrongCcy], st.positions.filter(p => matchKey(p.root) === '981'), { today: '2026-08-27', asOf: '2026-08-27' });
  eq('it does not match', r.agree, []);
  eq('and is not auto-added as a duplicate', r.adds, []);
  eq('one report, not two', r.report.length, 1);
  eq('and it is the mismatch, not "missing"', r.report[0].kind, 'currency-mismatch');
  eq('with the console currency named', r.report[0].rowCurrencies, ['USD']);
  ok('and the fix pointed at', /currency is wrong/.test(r.report[0].note));
}

// IBKR reports SMIC as `981`; the console calls it `0981.HK` because the quote feed needs the
// padded form. Stripping the suffix is not enough — `0981` and `981` are still different strings,
// and the first live run announced the position as missing at the broker AND queued a duplicate
// row to add beside it.
eq('leading zeros do not make two instruments', matchKey('0981'), matchKey('981'));
eq('a letter root is untouched', matchKey('MGC'), 'MGC');
{
  const smicPos = parseStatement('<OpenPosition symbol="981" assetCategory="STK" currency="HKD" conid="132135163" multiplier="1" position="500" costBasisPrice="70.478952" />').positions;
  // In HKD, as the row would carry it. Currency-less it defaulted to USD and matched anyway on the
  // root alone — which is the collapse the instrument key ends. See the currency-mismatch case above.
  const consoleRow = row('0981.HK-open', '0981.HK', [{ side: 'buy', qty: 500, price: 70.478952, date: '2026-07-10' }], { currency: 'HKD' });
  const r = reconcile([consoleRow], smicPos, { today: '2026-08-27' });
  eq('so 981 and 0981.HK are one position', r.agree.map(a => a.id), ['0981.HK-open']);
  eq('nothing is queued to add', r.adds, []);
  eq('and nothing is reported missing', r.report, []);
  // Added from scratch it comes back padded, with the suffix the quote feed needs.
  eq('an unseen HK line is added in the console’s naming', reconcile([], smicPos, { today: '2026-08-27' }).adds[0].symbol, '0981.HK');
}

// ── a statement is a report about a PAST day ──
// "Last Business Day" still holds yesterday's positions, so a trade closed this morning looks
// exactly like a position the console forgot to record — and auto-adding it resurrects a trade that
// was just exited. METU was sold in full on the 27th; the statement of the 26th still shows 600.
{
  const metuPos = parseStatement('<OpenPosition symbol="METU" assetCategory="STK" currency="USD" multiplier="1" position="600" costBasisPrice="18.064459" />').positions;
  const closedHere = row('METU-open', 'METU', [
    { side: 'buy', qty: 600, price: 18.06401, date: '2026-08-18' },
    { side: 'sell', qty: 600, price: 19.975, date: '2026-08-27' }]);
  const r = reconcile([closedHere], metuPos, { today: '2026-08-27', asOf: '2026-08-26' });
  eq('a trade closed after the statement is not resurrected', r.adds, []);
  eq('it is reported for what it is', r.report.map(x => x.kind), ['closed-since-statement']);
  ok('naming both dates', /2026-08-26/.test(r.report[0].note) && /2026-08-27/.test(r.report[0].note));
  // Closed BEFORE the statement and still held there is a genuine disagreement, and still added.
  const older = row('METU-old', 'METU', [
    { side: 'buy', qty: 600, price: 18.06401, date: '2026-08-18' },
    { side: 'sell', qty: 600, price: 19.975, date: '2026-08-20' }]);
  eq('one closed before it still is', reconcile([older], metuPos, { today: '2026-08-27', asOf: '2026-08-26' }).adds.length, 1);
}
// The mirror image: bought today, so the statement cannot know about it yet.
{
  const fresh = row('NEW-open', 'NVDA', [{ side: 'buy', qty: 10, price: 180, date: '2026-08-27' }]);
  const r = reconcile([fresh], [], { today: '2026-08-27', asOf: '2026-08-26' });
  eq('a position opened after the statement is not "missing at the broker"', r.report.map(x => x.kind), ['opened-since-statement']);
  const old = row('OLD-open', 'NVDA', [{ side: 'buy', qty: 10, price: 180, date: '2026-08-01' }]);
  eq('an older one still is', reconcile([old], [], { today: '2026-08-27', asOf: '2026-08-26' }).report[0].kind, 'missing-at-broker');
}

// ── a divergence that is real, permanent, and expected ──
// IBKR reports a partially-exited position on the lots it actually matched; the console is
// average-cost throughout. ARM sits at 409.26 there and 331.56 here and always will.
{
  const arm = row('ARM-open', 'ARM', [
    { side: 'buy', qty: 8, price: 321.855, date: '2026-06-10' },
    { side: 'buy', qty: 1, price: 409.17, date: '2026-06-22' },
    { side: 'sell', qty: 8, price: 295.6375, date: '2026-07-07' }]);
  const armPos = parseStatement('<OpenPosition symbol="ARM" assetCategory="STK" currency="USD" multiplier="1" position="1" costBasisPrice="409.260003" />').positions;
  const r = reconcile([arm], armPos, { today: '2026-08-27' });
  eq('the disagreement is reported', r.differs.map(d => d.root), ['ARM']);
  ok('and explained rather than left as two numbers', /partly exited/.test(r.differs[0].note));
  eq('the quantity is not the problem', r.differs[0].qty, null);
  // Recording the broker's figure accepts it — against that exact number, not as a mute switch.
  const acked = reconcile([{ ...arm, costBasisAck: 409.260003 }], armPos, { today: '2026-08-27' });
  eq('an acknowledged divergence stops being reported', acked.differs, []);
  eq('but is still marked as such rather than looking clean', acked.agree[0].acknowledged, true);
  // If IBKR ever reports something ELSE, that is news again.
  const moved = parseStatement('<OpenPosition symbol="ARM" assetCategory="STK" currency="USD" multiplier="1" position="1" costBasisPrice="450.00" />').positions;
  eq('a new number is reported again', reconcile([{ ...arm, costBasisAck: 409.260003 }], moved, {}).differs.length, 1);
}

// Acknowledging by hand means editing a row, saving, and hoping the browser is running the build
// that knows the field exists — which is how the first attempt at it was lost. Naming the row in
// the request puts the whole round trip on the server.
{
  const arm = row('ARM-open', 'ARM', [
    { side: 'buy', qty: 8, price: 321.855, date: '2026-06-10' },
    { side: 'buy', qty: 1, price: 409.17, date: '2026-06-22' },
    { side: 'sell', qty: 8, price: 295.6375, date: '2026-07-07' }]);
  const armPos = parseStatement('<OpenPosition symbol="ARM" assetCategory="STK" currency="USD" multiplier="1" position="1" costBasisPrice="409.260003" />').positions;
  const rec = reconcile([arm], armPos, {});
  const plan = planAck(rec, ['ARM-open']);
  eq('the plan names the row and the number', plan.ack, [{ id: 'ARM-open', from: 331.556667, to: 409.260003 }]);
  eq('and nothing else', plan.refused, []);
  eq('a row that already agrees has nothing to acknowledge', planAck(rec, ['HOOD-open']).ack, []);
  ok('and says so', /already agrees|is not in it/.test(planAck(rec, ['HOOD-open']).refused[0].reason));
  // A quantity break is a fill the console never recorded. Accepting a cost basis would paper over it.
  const short = row('ARM-open', 'ARM', [{ side: 'buy', qty: 5, price: 300, date: '2026-06-10' }]);
  const qtyRec = reconcile([short], armPos, {});
  eq('a quantity break cannot be acknowledged', planAck(qtyRec, ['ARM-open']).ack, []);
  ok('because it is not an accounting convention', /quantity disagrees/.test(planAck(qtyRec, ['ARM-open']).refused[0].reason));
  eq('an empty request does nothing', planAck(rec, []), { ack: [], refused: [] });
  eq('and blanks are skipped rather than refused', planAck(rec, ['', '  ']), { ack: [], refused: [] });
}

// ── the broker reports the CONTRACT, the card reports the TRADE ──
// A rolled position's avgCost is back-adjusted through its legs (applyRolls). That is right for a
// card and wrong here: reconciling against it would disagree with every statement for ever.
{
  const rolled = { id: 'MGC-DEC26', symbol: 'MGC', margined: true, multiplier: 10,
    derived: { status: 'open', qty: 1, avgCost: 4478.80464, unadjustedAvgCost: 4649.70464, multiplier: 10, sold: 0 } };
  const mgcPos = parseStatement('<OpenPosition symbol="MGCZ6" underlyingSymbol="MGC" assetCategory="FUT" currency="USD" multiplier="10" position="1" costBasisPrice="4649.70464" />').positions;
  eq('the unadjusted basis is what is compared', reconcile([rolled], mgcPos, {}).agree.map(a => a.root), ['MGC']);
  eq('so a roll does not generate a daily disagreement', reconcile([rolled], mgcPos, {}).differs, []);
}

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

// ── what gets said out loud ──
// A reconciliation nobody reads does not exist. But a channel that repeats the same disagreement
// every morning becomes wallpaper, so the signature is over WHAT is wrong, not that something is.
{
  const armPos = parseStatement('<OpenPosition symbol="ARM" assetCategory="STK" currency="USD" multiplier="1" position="1" costBasisPrice="409.260003" />').positions;
  const arm = row('ARM-open', 'ARM', [
    { side: 'buy', qty: 8, price: 321.855, date: '2026-06-10' },
    { side: 'buy', qty: 1, price: 409.17, date: '2026-06-22' },
    { side: 'sell', qty: 8, price: 295.6375, date: '2026-07-07' }]);
  const day1 = reconcile([arm], armPos, {});
  eq('a disagreement is actionable', actionable(day1), ['differs:ARM-open:c409.260003']);
  eq('and reads as itself', summariseActionable(day1), '1 disagrees with the statement (ARM)');
  eq('the same disagreement tomorrow is the same signature', signatureOf(reconcile([arm], armPos, {})), signatureOf(day1));
  // A DIFFERENT number is news again.
  const moved = parseStatement('<OpenPosition symbol="ARM" assetCategory="STK" currency="USD" multiplier="1" position="1" costBasisPrice="450" />').positions;
  ok('a new number changes it', signatureOf(reconcile([arm], moved, {})) !== signatureOf(day1));
  // Acknowledged, it stops being actionable at all.
  eq('an acknowledged row says nothing', actionable(reconcile([{ ...arm, costBasisAck: 409.260003 }], armPos, {})), []);
}
{
  // Options are in scope now (the console holds options and spreads): one held at IBKR and not in
  // the console is announced. A day trade — opened at 0 or 1 day to expiry — is not.
  const opts = parseStatement('<OpenPosition symbol="QQQ 260911C00737000" underlyingSymbol="QQQ" assetCategory="OPT" currency="USD" multiplier="100" position="15" costBasisPrice="8.77" />').positions;
  const rec = reconcile([], opts, {});
  eq('an option the console does not hold is added, like a share', [rec.report.length, rec.adds.length, actionable(rec).length], [0, 1, 1]);
  eq('and named by its contract', summariseActionable(rec), "added QQQ Sep11'26 737C");
  eq('but the channel gets the ticker only — the contract stays in the console', summariseActionable(rec, { forChannel: true }), 'added QQQ option');
  const day = parseStatement('<OpenPosition symbol="QQQ 260911C00737000" underlyingSymbol="QQQ" assetCategory="OPT" currency="USD" multiplier="100" position="15" costBasisPrice="8.77" holdingPeriodDateTime="20260910;093500" />').positions;
  const recDay = reconcile([], day, { asOf: '2026-09-10' });
  eq('a 1DTE option is a day trade: named, not announced', [recDay.report.map(r => r.kind), actionable(recDay).length], [['daytrade-option'], 0]);
  eq('and the channel stays quiet', summariseActionable(recDay), '');
}
{
  // Nor is a position that moved after the statement was cut — that resolves itself tomorrow.
  const metuPos = parseStatement('<OpenPosition symbol="METU" assetCategory="STK" currency="USD" multiplier="1" position="600" costBasisPrice="18.06" />').positions;
  const closedHere = row('METU-open', 'METU', [
    { side: 'buy', qty: 600, price: 18.06401, date: '2026-08-18' },
    { side: 'sell', qty: 600, price: 19.975, date: '2026-08-27' }]);
  eq('a trade closed since the statement is not announced', actionable(reconcile([closedHere], metuPos, { asOf: '2026-08-26' })), []);
}
{
  // A position open here and gone at the broker IS actionable — that is the mirror of the failure
  // this whole thing exists to catch, and it used to reach nobody because only adds were posted.
  const gone = row('SOXS-open', 'SOXS', [{ side: 'buy', qty: 50, price: 52.63, date: '2026-08-01' }]);
  const rec = reconcile([gone], [], { asOf: '2026-08-26' });
  eq('a position missing at the broker is announced', actionable(rec), ['missing:SOXS-open']);
  ok('and named', /SOXS/.test(summariseActionable(rec)));
}

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

// ── A STATEMENT DESCRIBES ONE DAY; THE CONSOLE KEPT TRADING ─────────────────
// The live case from 2026-09-02. Bought 500 ASTX @ 9.20 on 09-01, sold 400 @ 10.60 on 09-02,
// 100 left. The statement is cut on 09-01 and says 500. Both are right about their own day, and
// the reconciler called it a disagreement.
{
  const astx = {
    id: 'astx', symbol: 'ASTX',
    derived: { status: 'open', qty: 100, avgCost: 9.2, unadjustedAvgCost: 9.2, sold: 400,
      firstDate: '2026-09-01', lastDate: '2026-09-02',
      fills: [
        { side: 'buy',  qty: 500, price: 9.2,  date: '2026-09-01' },
        { side: 'sell', qty: 400, price: 10.6, date: '2026-09-02' },
      ] },
  };
  const stmt = [{ root: 'ASTX', symbol: 'ASTX', qty: 500, costBasisPrice: 9.2, assetCategory: 'STK' }];

  const derive = (r) => derivePosition(r.fills || [], { multiplier: r.multiplier });
  const back = asOfState(astx, '2026-09-01', derive);
  eq('re-deriving to the statement day gives its quantity', back.qty, 500);
  // The cost too, which the arithmetic rewind could not do — see the note in lib/flex.js.
  eq('and its cost basis', back.avgCost, 9.2);
  eq('and says how many fills moved', back.moved, 1);
  eq('a fill ON the statement date is not excluded', asOfState(astx, '2026-09-02', derive), null);
  eq('no asOf, no rewind', asOfState(astx, null, derive), null);
  eq('no deriver, no rewind', asOfState(astx, '2026-09-01', null), null);

  const rec = reconcile([astx], stmt, { today: '2026-09-02', asOf: '2026-09-01', derive });
  eq('it is no longer called a disagreement', rec.differs.length, 0);
  const chg = rec.report.filter(r => r.kind === 'changed-since-statement');
  eq('it is reported as movement since the statement', chg.length, 1);
  eq('carrying both figures and the rewind', chg[0].qty.console, 100);
  eq('the broker figure', chg[0].qty.ibkr, 500);
  eq('and what the console rewinds to', chg[0].qty.asOf, 500);
  // Deliberately NOT actionable — it resolves itself when the next statement is cut, and posting
  // it daily is how a channel becomes wallpaper.
  ok('and it does not page anyone', !actionable(rec).some(a => a.includes('astx')));

  // A rewind that does NOT reconcile is a real finding and must survive.
  const wrong = reconcile([astx], [{ ...stmt[0], qty: 900 }], { today: '2026-09-02', asOf: '2026-09-01', derive });
  eq('an unexplained gap is still a disagreement', wrong.differs.length, 1);
  eq('and it shows what the rewind produced', wrong.differs[0].qty.asOf, 500);
  eq('against what the broker says', wrong.differs[0].qty.ibkr, 900);

  // With no fills after the statement, nothing changes — the old path is untouched.
  const settled = { ...astx, derived: { ...astx.derived, fills: [astx.derived.fills[0]], qty: 500, sold: 0, lastDate: '2026-09-01' } };
  eq('a quiet row still reconciles normally', reconcile([settled], stmt, { today: '2026-09-02', asOf: '2026-09-01', derive }).agree.length, 1);
}

// ── A SETUP IS NOT A POSITION ───────────────────────────────────────────────
// NVDA and DBA on the same run: watchlist rows with no fills, reported as "open here but not at
// the broker". True of every setup that will ever exist, so it tells nobody anything.
{
  const setup = (sym) => ({ id: sym.toLowerCase(), symbol: sym,
    derived: { status: 'setup', qty: 0, avgCost: null, fills: [] } });
  const rec = reconcile([setup('NVDA'), setup('DBA')], [], { today: '2026-09-02', asOf: '2026-09-01' });
  eq('setups are not reported as missing at the broker',
    rec.report.filter(r => r.kind === 'missing-at-broker').length, 0);
  eq('nor as anything else', rec.report.length, 0);
  ok('and nothing about them is actionable', !actionable(rec).length);

  // A REAL position absent from the statement must still be reported — this is the line the fix
  // must not cross.
  const held = { id: 'held', symbol: 'GOOGL',
    derived: { status: 'open', qty: 50, avgCost: 354.85, firstDate: '2026-06-01', fills: [
      { side: 'buy', qty: 50, price: 354.85, date: '2026-06-01' }] } };
  const rec2 = reconcile([held], [], { today: '2026-09-02', asOf: '2026-09-01' });
  eq('a genuinely held position is still flagged',
    rec2.report.filter(r => r.kind === 'missing-at-broker').length, 1);

  // A row with an incomplete fill is 'open' (held, pending a quantity) and must stay in scope.
  const pending = { id: 'p', symbol: 'INTC',
    derived: { status: 'open', qty: 0, needsQty: true, avgCost: null, firstDate: '2026-08-01',
      fills: [], incomplete: [{ side: 'buy', price: 98.72, date: '2026-08-01' }] } };
  eq('an incomplete buy is still a position',
    reconcile([pending], [], { today: '2026-09-02', asOf: '2026-09-01' })
      .report.filter(r => r.kind === 'missing-at-broker').length, 1);
}

{
  // A BUY after the statement is the case the arithmetic rewind could not reach: it reconciles the
  // quantity and leaves the average somewhere the statement never claimed. Measured at 9.67 against
  // a statement of 9.20, and the batch was discarded on a figure nobody disagreed about.
  const derive = (r) => derivePosition(r.fills || [], { multiplier: r.multiplier });
  const fills = [
    { side: 'buy', qty: 500, price: 9.20, date: '2026-09-01' },
    { side: 'buy', qty: 100, price: 12.00, date: '2026-09-02' },
  ];
  const row = { id: 'astx', symbol: 'ASTX', fills, derived: derive({ fills }) };
  ok('the live average has moved off the statement', Math.abs(row.derived.avgCost - 9.2) > 0.4);
  const back = asOfState(row, '2026-09-01', derive);
  eq('but the as-of average is the statement’s', back.avgCost, 9.2);
  eq('as is the as-of quantity', back.qty, 500);

  const stmt = [{ root: 'ASTX', symbol: 'ASTX', qty: 500, costBasisPrice: 9.2, assetCategory: 'STK' }];
  const rec = reconcile([row], stmt, { today: '2026-09-02', asOf: '2026-09-01', derive });
  eq('so an add after the statement is not a disagreement', rec.differs.length, 0);
  eq('it is movement since the statement', rec.report.filter(r => r.kind === 'changed-since-statement').length, 1);

  // A cost that does NOT re-derive to the statement is still a disagreement, with both figures.
  const bad = reconcile([row], [{ ...stmt[0], costBasisPrice: 7.5 }], { today: '2026-09-02', asOf: '2026-09-01', derive });
  eq('a cost that does not reconcile still differs', bad.differs.length, 1);
  eq('carrying the as-of figure it was compared against', bad.differs[0].avg.asOf, 9.2);
}

// ── AN OPTION IS NOT ITS UNDERLYING ──────────────────────────────────────────
// 2026-09-14: INTC read "console 30, statement 6: a fill is missing here". The 6 was the option
// line — six contracts on INTC — keyed by its underlying and compared against the 30-share row.
{
  const { parseStatement, reconcile } = await import('../lib/flex.js');
  const xml = `<FlexQueryResponse><FlexStatements><FlexStatement accountId="U1" fromDate="2026-09-11" toDate="2026-09-11"><OpenPositions>
<OpenPosition accountId="U1" currency="USD" assetCategory="STK" symbol="INTC" position="30" costBasisPrice="25.00" levelOfDetail="SUMMARY" />
<OpenPosition accountId="U1" currency="USD" assetCategory="OPT" symbol="INTC  261017C00030000" underlyingSymbol="INTC" multiplier="100" position="6" costBasisPrice="1.20" levelOfDetail="SUMMARY" />
</OpenPositions></FlexStatement></FlexStatements></FlexQueryResponse>`;
  const st = parseStatement(xml);
  const rows = [{ id: 'intc', symbol: 'INTC', currency: 'USD', side: 'long', status: 'open', derived: { qty: 30, avgCost: 25, unadjustedAvgCost: 25, status: 'open', sold: 0 } }];
  const rec = reconcile(rows, st.positions, { asOf: '2026-09-11', derive: r => r.derived });
  eq('the share row agrees with the share line', rec.agree.map(a => a.root), ['INTC']);
  eq('and is not contradicted by the option line', rec.differs, []);
  eq('the option is added as its own contract', rec.adds.map(r => [r.instrument, r.legs[0].strike, r.legs[0].expiry, r.fills[0].qty]), [['option', 30, '2026-10-17', 6]]);
}

// ── THE FILL THAT CLOSES A QUANTITY GAP ──────────────────────────────────────
// IBKR is the record: the banner says what to record, not that something differs.
{
  const { reconcilingFill } = await import('../lib/flex.js');
  const add = reconcilingFill({ qty: { console: 1058, ibkr: 1063 }, avg: { console: 50.4257, ibkr: 50.43 } }, { asOf: '2026-09-11' });
  eq('a statement holding more is a buy of the difference', [add.side, add.qty], ['add', 5]);
  // (1063 × 50.43 − 1058 × 50.4257) / 5 = 51.34 — the one price that lands the average on the statement's.
  eq('priced so the average lands on the statement basis', add.price, 51.3399);
  ok('and the text says so, with the date', /record 5 bought at 51\.3399, which lands the average on the statement's 50\.43, dated on or before 2026-09-11/.test(add.text));
  const cut = reconcilingFill({ qty: { console: 200, ibkr: 150 }, avg: { console: 30, ibkr: 30 } }, { asOf: '2026-09-11' });
  eq('a statement holding less is a sale of the difference with no price — a reduction does not move the average', [cut.side, cut.qty, cut.price], ['reduce', 50, null]);
  ok('and says why the price is the operator\'s', /at the price received/.test(cut.text));
  const wild = reconcilingFill({ qty: { console: 100, ibkr: 101 }, avg: { console: 10, ibkr: 20 } });
  eq('an implausible solved price is not offered', wild.price, null);
  ok('and the reason is stated', /cannot be reached by one fill/.test(wild.text));
  const fresh = reconcilingFill({ qty: { console: 0, ibkr: 40 }, avg: { console: null, ibkr: 12.5 } });
  eq('nothing held before: the statement basis is the price', [fresh.qty, fresh.price], [40, 12.5]);
  eq('no quantity gap is no fill', reconcilingFill({ avg: { console: 1, ibkr: 2 } }), null);
  // Four decimals, not floating-point residue: 2108.7533 − 1058 is 1050.7533, not 1050.7532999999999.
  const frac = reconcilingFill({ qty: { console: 1058, ibkr: 2108.7533 }, basis: { console: 50.4257, ibkr: 50.43, agree: true } }, { asOf: '2026-09-11' });
  eq('a fractional gap is stated to four decimals', frac.qty, 1050.7533);
  eq('and when the cost bases already agree the missing buy is priced at the average, with the wording of a buy', [frac.side, frac.price], ['add', 50.43]);
  ok('never as a reduction', /bought at 50\.43 — the cost bases already agree/.test(frac.text) && !/reduction/.test(frac.text));
  // The statement's own trade lines beat any solving.
  const carried = reconcilingFill({ qty: { console: 30, ibkr: 6 }, basis: { console: 25, ibkr: 25, agree: true } },
    { asOf: '2026-09-11', statementFills: [{ side: 'sell', qty: 24, price: 26.1, date: '2026-09-10', tradeId: '77' }] });
  eq('a fill the statement carries is proposed exactly', [carried.fromStatement, carried.covers, carried.price, carried.date], [true, true, 26.1, '2026-09-10']);
  ok('and the text says it applies with the batch or can be recorded now', /the statement carries it: sold 24 @ 26\.1 on 2026-09-10 — these apply with the batch/.test(carried.text));
  const partial = reconcilingFill({ qty: { console: 30, ibkr: 6 } }, { statementFills: [{ side: 'sell', qty: 10, price: 26, date: '2026-09-10' }] });
  eq('fills that cover only part of the gap say so', partial.covers, false);
  ok('a sale outside the window says where the price is', /IBKR trade confirmation/.test(reconcilingFill({ qty: { console: 30, ibkr: 6 } }).text));
}

// ── OPTIONS MATCHED BY CONTRACT (2026-09-26) ──
// A SOFI Nov20 17/20 call vertical is ONE console row and TWO statement lines. Matched leg by leg,
// signed; the SOFI share row beside it is untouched.
{
  const { parseStatement, reconcile, actionable, isDayTradeOption, optionContractOf, summariseActionable } = await import('../lib/flex.js');
  const xml = (lines) => `<FlexQueryResponse><FlexStatements><FlexStatement accountId="U1" fromDate="2026-09-24" toDate="2026-09-24"><OpenPositions>${lines}</OpenPositions></FlexStatement></FlexStatements></FlexQueryResponse>`;
  const SH = '<OpenPosition currency="USD" assetCategory="STK" symbol="SOFI" position="500" costBasisPrice="16.68" levelOfDetail="SUMMARY" />';
  const L17 = (q = 15) => `<OpenPosition currency="USD" assetCategory="OPT" symbol="SOFI  261120C00017000" underlyingSymbol="SOFI" multiplier="100" position="${q}" costBasisPrice="1.9" strike="17" putCall="C" expiry="20261120" holdingPeriodDateTime="20260923" levelOfDetail="SUMMARY" />`;
  const L20 = (q = -15) => `<OpenPosition currency="USD" assetCategory="OPT" symbol="SOFI  261120C00020000" underlyingSymbol="SOFI" multiplier="100" position="${q}" costBasisPrice="1.05" strike="20" putCall="C" expiry="20261120" holdingPeriodDateTime="20260923" levelOfDetail="SUMMARY" />`;
  const share = { id: 'sofi-sh', symbol: 'SOFI', currency: 'USD', side: 'long', fills: [{ side: 'buy', qty: 500, price: 16.68, date: '2026-09-23' }], derived: { qty: 500, avgCost: 16.68, unadjustedAvgCost: 16.68, status: 'open', sold: 0, firstDate: '2026-09-23' } };
  const spread = { id: 'sofi-sp', symbol: 'SOFI', underlying: 'SOFI', instrument: 'spread', currency: 'USD', side: 'long', multiplier: 100,
    legs: [{ right: 'C', strike: 17, expiry: '2026-11-20', side: 'long', ratio: 1 }, { right: 'C', strike: 20, expiry: '2026-11-20', side: 'short', ratio: 1 }],
    fills: [{ side: 'buy', qty: 15, price: 0.85, date: '2026-09-23' }], derived: { qty: 15, avgCost: 0.85, status: 'open', sold: 0, firstDate: '2026-09-23' } };
  const derive = (r) => ({ qty: (r.fills || []).reduce((a, f) => a + (f.side === 'buy' ? f.qty : -f.qty), 0), avgCost: r.derived?.avgCost });
  const run = (lines, rows = [share, spread]) => reconcile(rows, parseStatement(xml(lines)).positions, { asOf: '2026-09-24', derive });

  const ok1 = run(SH + L17() + L20());
  eq('the share row and both legs agree', ok1.agree.map(a => a.contract || a.root).sort(), ['SOFI', 'SOFI 2026-11-20 17C', 'SOFI 2026-11-20 20C']);
  eq('the spread row no longer makes the share row ambiguous', ok1.ambiguous, []);
  eq('nothing to announce', actionable(ok1), []);

  const short = run(SH + L17() + L20(-10));
  eq('a leg that disagrees is named with both numbers', short.report.filter(r => r.kind === 'option-differs').map(r => [r.contract, r.qty]), [['SOFI 2026-11-20 20C', { console: -15, ibkr: -10 }]]);
  eq('and is announced', actionable(short).length, 1);
  eq('in the channel by ticker, not contract', summariseActionable(short, { forChannel: true }), '1 option contract to check (SOFI)');

  const gone = run(SH);
  eq('legs the console holds and IBKR does not', gone.report.filter(r => r.kind === 'option-missing-at-broker').map(r => r.contract).sort(), ['SOFI 2026-11-20 17C', 'SOFI 2026-11-20 20C']);

  const extra = run(SH + L17() + L20() + '<OpenPosition currency="USD" assetCategory="OPT" symbol="WFC   261016C00085000" underlyingSymbol="WFC" multiplier="100" position="30" costBasisPrice="1.2" strike="85" putCall="C" expiry="20261016" holdingPeriodDateTime="20260915" levelOfDetail="SUMMARY" />');
  eq('an option only IBKR holds is added', extra.adds.map(r => [r.symbol, r.instrument, r.side, r.legs[0].right, r.legs[0].strike, r.fills[0].qty, r.fills[0].price, r.fills[0].date]),
     [['WFC', 'option', 'long', 'C', 85, 30, 1.2, '2026-09-15']]);
  // The added row matches the next statement: the add is stable, not repeated.
  const withWfc = [share, spread, { ...extra.adds[0], derived: { qty: 30, avgCost: 1.2, status: 'open', firstDate: '2026-09-15' } }];
  const again = reconcile(withWfc, parseStatement(xml(SH + L17() + L20() + '<OpenPosition currency="USD" assetCategory="OPT" symbol="WFC   261016C00085000" underlyingSymbol="WFC" multiplier="100" position="30" costBasisPrice="1.2" strike="85" putCall="C" expiry="20261016" holdingPeriodDateTime="20260915" levelOfDetail="SUMMARY" />')).positions, { asOf: '2026-09-24', derive });
  eq('and agrees the day after', [again.adds.length, again.agree.length, actionable(again)], [0, 4, []]);
  // A short option alone is a short row.
  const shortPut = run(SH + L17() + L20() + '<OpenPosition currency="USD" assetCategory="OPT" symbol="XLE   261120P00080000" underlyingSymbol="XLE" multiplier="100" position="-5" costBasisPrice="2.1" strike="80" putCall="P" expiry="20261120" holdingPeriodDateTime="20260910" levelOfDetail="SUMMARY" />');
  eq('a short option is added short', shortPut.adds.map(r => [r.side, r.legs[0].side, r.fills[0].side, r.fills[0].qty]), [['short', 'long', 'sell', 5]]);
  // A spread held only at IBKR: two legs opened together → ONE spread row, net debit.
  const onlyIbkr = run(SH + L17() + L20(), [share]);
  eq('legs opened together become one spread', onlyIbkr.adds.map(r => [r.instrument, r.legs.map(l => `${l.side} ${l.strike}${l.right}`), r.fills[0].qty, r.fills[0].price]),
     [['spread', ['long 17C', 'short 20C'], 15, 0.85]]);
  const spreadRow = { ...onlyIbkr.adds[0], derived: { qty: 15, avgCost: 0.85, status: 'open', firstDate: '2026-09-23' } };
  eq('and that spread matches both lines next time', run(SH + L17() + L20(), [share, spreadRow]).agree.length, 3);

  // A short spread: the row is short, so its legs flip.
  const shortSpread = { ...spread, id: 'sofi-short', side: 'short', fills: [{ side: 'sell', qty: 15, price: 0.85, date: '2026-09-23' }] };
  eq('a short spread is the legs flipped', run(SH + L17(-15) + L20(15), [share, { ...shortSpread, derived: { ...spread.derived } }]).agree.length, 3);

  // Opened after the statement's day: not expected in it, so not "missing at broker".
  const later = { ...spread, fills: [{ side: 'buy', qty: 15, price: 0.85, date: '2026-09-25' }], derived: { ...spread.derived, firstDate: '2026-09-25' } };
  eq('a spread opened after the statement is not a finding', run(SH, [share, later]).report.filter(r => r.kind.startsWith('option')), []);

  // Day trades: 0 or 1 day to expiry at the open.
  const c = optionContractOf({ root: 'QQQ', strike: 740, putCall: 'P', expiry: '20260925' });
  eq('contract from fields', c, { root: 'QQQ', expiry: '2026-09-25', type: 'put', strike: 740 });
  eq('0DTE is a day trade', isDayTradeOption(c, { openDate: '2026-09-25' }), true);
  eq('1DTE is a day trade', isDayTradeOption(c, { openDate: '2026-09-24' }), true);
  eq('2DTE is not', isDayTradeOption(c, { openDate: '2026-09-23' }), false);
  const dt = run(SH + L17() + L20() + '<OpenPosition currency="USD" assetCategory="OPT" symbol="QQQ   260925P00740000" underlyingSymbol="QQQ" multiplier="100" position="5" costBasisPrice="2" strike="740" putCall="P" expiry="20260925" holdingPeriodDateTime="20260924;150000" levelOfDetail="SUMMARY" />');
  const nearExp = { ...spread, id: 'near', legs: [{ right: 'C', strike: 17, expiry: '2026-09-25', side: 'long', ratio: 1 }], instrument: 'option' };
  const L17near = '<OpenPosition currency="USD" assetCategory="OPT" symbol="SOFI  260925C00017000" underlyingSymbol="SOFI" multiplier="100" position="15" costBasisPrice="1" strike="17" putCall="C" expiry="20260925" levelOfDetail="SUMMARY" />';
  eq('a swing option the console holds still matches the day before expiry', run(SH + L17near, [share, nearExp]).agree.map(a => a.contract || a.root).sort(), ['SOFI', 'SOFI 2026-09-25 17C']);
  eq('a 1DTE line is set aside, not matched or announced', [dt.report.filter(r => r.kind === 'daytrade-option').map(r => r.contract), actionable(dt)], [['QQQ 2026-09-25 740P'], []]);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
