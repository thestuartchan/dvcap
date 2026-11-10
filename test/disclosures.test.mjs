// test/disclosures.test.mjs — politicians' and insiders' trades from the filings (lib/disclosures.js).
import { deflateRawSync } from 'node:zlib';
import { unzipEntry, parseHouseIndex, parsePtrText, companyName, settleCompany, amountMin, flagsFor, congressCard, parseForm4, form4Flags, insiderClusters, insiderScanCard, insiderRoundupCard, parseCurrentFeed, ideaTickers, watchSet } from '../lib/disclosures.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

// A two-member zip built by hand, as the House Clerk ships its index.
function zip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, text] of files) {
    const data = deflateRawSync(Buffer.from(text)), n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(text.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(text.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data); centrals.push(ch, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}
const xml = `<?xml version="1.0"?><FinancialDisclosure>
<Member><Prefix>Hon.</Prefix><Last>Salazar</Last><First>Maria Elvira</First><Suffix /><FilingType>P</FilingType><StateDst>FL27</StateDst><Year>2026</Year><FilingDate>11/5/2026</FilingDate><DocID>20035778</DocID></Member>
<Member><Prefix /><Last>Aaron</Last><First>Richard</First><Suffix /><FilingType>W</FilingType><StateDst>MI04</StateDst><Year>2026</Year><FilingDate>4/15/2026</FilingDate><DocID>8068</DocID></Member>
</FinancialDisclosure>`;
const z = zip([['2026FD.txt', 'tab text'], ['2026FD.xml', xml]]);
eq('unzip finds the XML member by predicate', unzipEntry(z, n => n.endsWith('.xml')).toString(), xml);
eq('the House index keeps trade filings (P) only, with an ISO filing date',
  parseHouseIndex(xml), [{ docId: '20035778', name: 'Hon. Maria Elvira Salazar', district: 'FL27', year: 2026, filed: '2026-11-05' }]);

// The same PTR as two extractors lay it out: ticker before the code (unpdf) and after the amount (pdfplumber).
const unpdfText = `Cisco Systems, Inc. - Common Stock
(CSCO) [ST]
S 10/23/2026 11/01/2026 $1,001 - $15,000
F S : New
NVIDIA Corporation - Common Stock
(NVDA) [OP]
P 10/23/2026 11/01/2026 $250,001 - $500,000
Procter & Gamble Company (PG) [ST] S (partial) 08/01/2026 11/01/2026 Over $50,000,000`;
const plumberText = `Cisco Systems, Inc. - Common Stock S 10/23/2026 11/01/2026 $1,001 - $15,000
(CSCO) [ST]
F S : New
NVIDIA Corporation - Common Stock P 10/23/2026 11/01/2026 $250,001 - $500,000
(NVDA) [OP]
Procter & Gamble Company (PG) [ST] S (partial) 08/01/2026 11/01/2026 Over $50,000,000`;
const want = [['CSCO', 'ST', 'sell', false, '$1,001 - $15,000', 1001], ['NVDA', 'OP', 'buy', false, '$250,001 - $500,000', 250001], ['PG', 'ST', 'sell', true, 'Over $50,000,000', 50000000]];
const shape = (ts) => ts.map(t => [t.ticker, t.assetType, t.side, t.partial, t.amount, t.amountMin]);
eq('PTR text, ticker above the trade line (unpdf layout)', shape(parsePtrText(unpdfText)), want);
eq('PTR text, ticker below the trade line (pdfplumber layout)', shape(parsePtrText(plumberText)), want);
eq('trade and notification dates read as ISO', [parsePtrText(unpdfText)[0].traded, parsePtrText(unpdfText)[0].notified], ['2026-10-23', '2026-11-01']);
eq('a scanned PTR (no text) yields no trades', parsePtrText(''), []);
eq('amount bands read from the bottom', [amountMin('$15,001 - $50,000'), amountMin('Over $1,000,000'), amountMin('x')], [15001, 1000000, null]);

const [csco, nvda, pg] = parsePtrText(unpdfText);
const watch = new Set(['CSCO']);
eq('flags: watchlist only', flagsFor(csco, { member: 'A', filed: '2026-11-05', watch }), ['watchlist']);
eq('flags: $250k+ and an option', flagsFor(nvda, { member: 'A', filed: '2026-11-05' }), ['$250k+', 'option']);
eq('flags: filed more than 45 days after the trade', flagsFor(pg, { member: 'A', filed: '2026-11-05' }), ['$250k+', 'filed 96d late']);
const hist = [{ member: 'B', ticker: 'CSCO', side: 'sell', traded: '2026-10-20' }, { member: 'C', ticker: 'CSCO', side: 'sell', traded: '2026-10-25' },
              { member: 'D', ticker: 'CSCO', side: 'buy', traded: '2026-10-25' }, { member: 'E', ticker: 'CSCO', side: 'sell', traded: '2026-08-01' }];
eq('flags: a cluster counts other members, same side, inside 30 days', flagsFor(csco, { member: 'A', filed: '2026-11-05', history: hist, today: '2026-11-05' }), ['cluster: 3 members selling']);
eq('flags: the same member twice is not a cluster', flagsFor(csco, { member: 'B', filed: '2026-11-05', history: hist, today: '2026-11-05' }), []);

const filing = { docId: '20035778', name: 'Hon. Maria Elvira Salazar', district: 'FL27', filed: '2026-11-05' };
eq('no flagged trade, no card', congressCard(filing, [{ tr: csco, flags: [] }]), null);
const card = congressCard(filing, [{ tr: csco, flags: [] }, { tr: nvda, flags: ['$250k+', 'option'] }], { url: 'https://x' });
eq('card: one line per flagged trade with the company name, plus the unflagged count, no mentions',
  [card.embeds[0].description, card.allowed_mentions.parse.length],
  ['**NVDA** NVIDIA Corporation · BUY option · $250,001 - $500,000 · traded 2026-10-23 · _$250k+, option_\n+1 other trade in this filing, unflagged', 0]);
eq('company names read in both layouts', [parsePtrText(unpdfText).map(t => t.company), parsePtrText(plumberText).map(t => t.company)],
  [['Cisco Systems, Inc.', 'NVIDIA Corporation', 'Procter & Gamble Company'], ['Cisco Systems, Inc.', 'NVIDIA Corporation', 'Procter & Gamble Company']]);
eq('company name drops owner code and share class', companyName('SP Alphabet Inc. - Class A Common Stock'), 'Alphabet Inc.');
eq('SEC name trims an account label in front', settleCompany({ ticker: 'TSM', company: 'Brokerage Taiwan Semiconductor Manufacturing Company Ltd.' }, { TSM: [1, 'TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD'] }), 'Taiwan Semiconductor Manufacturing Company Ltd.');
eq('SEC name fills in when the text had none', settleCompany({ ticker: 'BRK.B', company: null }, { 'BRK-B': [1, 'BERKSHIRE HATHAWAY INC'] }), 'BERKSHIRE HATHAWAY INC');
eq('no ticker, no company line', congressCard(filing, [{ tr: { ticker: null, asset: 'US Treasury Note', side: 'buy', amount: '$1,001 - $15,000', traded: '2026-10-01' }, flags: ['$250k+'] }]).embeds[0].description.startsWith('**US Treasury Note** BUY'), true);
eq('card says nothing about holdings', /held|position|size/i.test(JSON.stringify(card)), false);

// Form 4: a director's open-market buy, and an officer's unplanned sale.
const f4 = (code, shares, price, { plan = false, officer = '' } = {}) => `<ownershipDocument><issuer><issuerCik>1</issuerCik><issuerName>ACME</issuerName><issuerTradingSymbol>acme</issuerTradingSymbol></issuer>
<reportingOwner><reportingOwnerId><rptOwnerName>DOE JANE ${code}</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>${officer ? 0 : 1}</isDirector><isOfficer>${officer ? 1 : 0}</isOfficer>${officer ? `<officerTitle>${officer}</officerTitle>` : ''}<isTenPercentOwner>0</isTenPercentOwner></reportingOwnerRelationship></reportingOwner>
<aff10b5One>${plan ? 1 : 0}</aff10b5One><nonDerivativeTable><nonDerivativeTransaction><transactionDate><value>2026-11-04</value></transactionDate><transactionCoding><transactionCode>${code}</transactionCode></transactionCoding>
<transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare><value>${price}</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>${code === 'P' ? 'A' : 'D'}</value></transactionAcquiredDisposedCode></transactionAmounts></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>`;
const buy = parseForm4(f4('P', 1000, 50));
eq('Form 4 parse: ticker upper-cased, role, code, value', [buy.ticker, buy.role, buy.txns[0].code, buy.txns[0].value, buy.plan], ['ACME', 'Director', 'P', 50000, false]);
const sale = parseForm4(f4('S', 40000, 50, { officer: 'CFO' })), planned = parseForm4(f4('S', 40000, 50, { officer: 'CEO', plan: true }));
const bigBuy = parseForm4(f4('P', 20000, 50)), ceoBuy = parseForm4(f4('P', 3000, 50, { officer: 'Chief Executive Officer' })), gift = parseForm4(f4('G', 500000, 0));
const W = new Set(['ACME']);
eq('flags: a $500k+ open-market buy anywhere', form4Flags(bigBuy).flags, ['$500k+ buy']);
eq('flags: a CEO buying $100k+ anywhere', form4Flags(ceoBuy).flags, ['CEO/CFO buy']);
eq('flags: a small director buy only counts on the watchlist', [form4Flags(buy).flags, form4Flags(buy, { watch: W }).flags], [[], ['watchlist buy']]);
eq('flags: an unplanned $1M+ sale on the watchlist; a planned one and a gift never', [form4Flags(sale, { watch: W }).flags, form4Flags(planned, { watch: W }).flags, form4Flags(gift, { watch: W }).flags], [['watchlist: unplanned sale'], [], []]);
const hist4 = [{ ticker: 'ACME', owner: 'A', date: '2026-11-01' }, { ticker: 'ACME', owner: 'B', date: '2026-11-03' }, { ticker: 'ACME', owner: 'C', date: '2026-11-05' },
               { ticker: 'ZZZ', owner: 'A', date: '2026-11-05' }, { ticker: 'ZZZ', owner: 'A', date: '2026-11-06' }, { ticker: 'OLD', owner: 'A', date: '2026-09-01' }, { ticker: 'OLD', owner: 'B', date: '2026-09-02' }, { ticker: 'OLD', owner: 'C', date: '2026-09-03' }];
eq('clusters: 3 different insiders inside 14 days; repeats and old buys do not count', insiderClusters(hist4, { today: '2026-11-06' }), [{ ticker: 'ACME', insiders: 3 }]);
eq('clusters: one already posted is not posted again', insiderClusters(hist4, { today: '2026-11-06', already: ['ACME'] }), []);
eq('scan card: nothing flagged, nothing posted', insiderScanCard([], []), null);
{
  const big = { ...sale, role: 'President and CEO', txns: sale.txns.map(x => ({ ...x, value: 12_000_000 })) };
  eq('flags: a top exec\'s unplanned $10M+ sale anywhere; planned, 10% owner or under $10M never',
    [form4Flags(big).flags, form4Flags({ ...big, plan: true }).flags, form4Flags({ ...big, role: 'President and CEO, 10% owner' }).flags,
     form4Flags({ ...big, txns: sale.txns.map(x => ({ ...x, value: 9_000_000 })) }).flags],
    [['top-exec unplanned sale'], [], [], []]);
  eq('parse: a 10b5-1 plan named only in a footnote counts as planned',
    parseForm4('<issuer><issuerTradingSymbol>ACME</issuerTradingSymbol></issuer><footnotes><footnote id="F1">Sold under a Rule 10b5-1 trading plan adopted May 2026.</footnote></footnotes>').plan, true);
}
const sc = insiderScanCard([{ ...bigBuy, ...form4Flags(bigBuy) }], [{ ticker: 'ACME', insiders: 3 }]).embeds[0].description;
eq('scan card: cluster first, then the flagged buy', sc, '🧲 **ACME** cluster: 3 insiders bought in the last 14 days\n🟢 **ACME** BUY $1.0M · DOE JANE P (Director) · 2026-11-04 · _$500k+ buy_');
eq('roundup: a quiet week says so', insiderRoundupCard([], { from: 'a', to: 'b' }).embeds[0].description, 'No open-market insider buys recorded this week.');
const atom = `<feed><entry><title>4 - DOE JANE (0001) (Reporting)</title><link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1/000119312526452288/0001193125-26-452288-index.htm"/><category scheme="https://www.sec.gov/" label="form type" term="4"/></entry>
<entry><title>4 - ACME (0001121788) (Issuer)</title><link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1121788/000119312526452288/0001193125-26-452288-index.htm"/><category scheme="https://www.sec.gov/" label="form type" term="4"/></entry>
<entry><title>4/A - X (0009) (Issuer)</title><link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/9/000000000926000001/x-index.htm"/><category scheme="https://www.sec.gov/" label="form type" term="4/A"/></entry></feed>`;
eq('latest-filings feed: one row per Form 4, from the issuer entry', parseCurrentFeed(atom), [{ cik: '1121788', acc: '000119312526452288' }]);
eq('idea tickers: pairs give both legs', ideaTickers([{ ticker: 'XSW/SOXX' }, { ticker: 'RSP vs QQQ' }, { ticker: 'NKE' }, {}]), ['XSW', 'SOXX', 'RSP', 'QQQ', 'NKE']);
eq('watchlist: US tickers only, from the book and the env list', [...watchSet(['NVDA', '0981.HK', 'MCL', 'BRK.B', 'DEWA.AE'], 'crwd, xsw')], ['NVDA', 'MCL', 'BRK.B', 'CRWD', 'XSW']);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
