// test/supplyChain.test.mjs — supplier / customer / competitor links from filings (lib/supplyChain.js).
// Fake companies and made-up sentences throughout; the real counterparty table is not used.
import { filingText, sentences, linksInSentence, extractLinks, edgesOf, edgeWeight, neighbours, graph, mapFor } from '../lib/supplyChain.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const T = [
  { ticker: 'XYZ', label: 'Xyzzy', re: /\bXyzzy\b/ },
  { ticker: 'ABC', label: 'Abacus', re: /\bAbacus\b/ },
  { ticker: 'DEF', label: 'Defco', re: /\bDefco\b/ },
];
const L = (s, filer = 'XYZ') => linksInSentence(s, filer, { counterparties: T }).map(l => [l.counterparty || l.label, l.relation, l.named, l.share]);

// ── What a sentence says ──
eq('a named foundry is a supplier', L('We rely on Abacus to manufacture all of our wafers.'), [['ABC', 'supplier', true, null]]);
eq('named competitors', L('Our competitors include Abacus and Defco.'), [['ABC', 'competitor', true, null], ['DEF', 'competitor', true, null]]);
eq('a named customer with its stated share', L('Sales to Abacus accounted for 14% of our total revenue in fiscal 2026.'), [['ABC', 'customer', true, 14]]);
eq('two named customers share no single figure', L('Sales to Abacus and Defco accounted for 14% and 11% of revenue.'), [['ABC', 'customer', true, null], ['DEF', 'customer', true, null]]);
eq('customer AND competitor in one sentence is left out', L('Abacus is both a significant customer and a competitor.'), []);
eq('supplier AND customer wording is left out', L('We purchase from Abacus, which is also a customer.'), []);
eq('the filer never links to itself', L('Xyzzy relies on its own foundries.'), []);
eq('lettered anonymised customers pair with their shares', L('Customers A and B accounted for 16% and 12% of our total revenue, respectively.'),
  [['Customer A', 'customer', false, 16], ['Customer B', 'customer', false, 12]]);
eq('one unnamed customer', L('One customer accounted for 21% of net sales in fiscal 2026.'), [['One customer', 'customer', false, 21]]);
eq('labels and shares that do not pair up are dropped', L('Customers A, B and C accounted for 30% of revenue combined.'), []);
eq('a sentence with no relation word is nothing', L('Abacus announced a new product in 2026.'), []);

// ── Shapes the first real run (28 annual reports) got wrong, rewritten with fake names ──
eq('a company courting "our customers" is not a customer', L('Defco uses its market position to target our customers with special incentives.'), []);
eq('"customer contracts" is not a customer list', L('As a result of our current customer contracts, all of the chips in our clusters are Abacus chips.'), []);
eq("another company's suppliers are not the filer's", L('For example, Abacus relies on suppliers such as Defco for semiconductor fabrication.'), []);
eq("a director's biography is not supply", L('Smith served 18 years with Abacus, a supplier of process control solutions, where he held several roles.'), []);
eq('co-ownership is not supply', L('Our wafer fab facility, which produces 8 inch wafers, is jointly owned by Abacus and ourselves.'), []);
eq('a hypothetical shift is not supply', L('In such event, we would expect to shift manufacturing to third-party foundries, particularly Abacus.'), []);
eq('"capable of" is not supply', L('There are few foundries capable of producing the nodes needed for our products – currently only Abacus and Defco.'), []);
eq('"competitive advantage" names no competitor', L('A core competitive advantage supports our 20-year agreement with Abacus to supply power.'), []);
eq('"anti-competition claims" names no competitor', L('Abacus amended its complaint to add anti-competition claims.'), []);
eq('"customers included" opens a list of customers', L('Our most significant customers during fiscal 2026 included Abacus Holdings, Inc., Defco Company, Ltd., and others.'), [['ABC', 'customer', true, null], ['DEF', 'customer', true, null]]);
eq('"customers (for example, …)" opens a list', L('Certain of our largest customers (for example, Abacus and Defco) develop their own chips.'), [['ABC', 'customer', true, null], ['DEF', 'customer', true, null]]);
eq('"securing customers … consoles for Defco" is not a list of customers', L('Our success depends on securing customers for our pipeline, including the success of next generation consoles for Defco.'), []);
eq('a named largest customer with a decimal share', L('In 2026 our largest customer, Abacus, accounted for 17.7% of our total revenues.'), [['ABC', 'customer', true, 17.7]]);
eq('"revenues from A, B and C each 10% or more" names customers, no share', L('In fiscal 2026, revenues from Abacus, Defco and Foo each comprised 10% or more of our revenues.'), [['ABC', 'customer', true, null], ['DEF', 'customer', true, null]]);
eq('a foundry list with a bracketed short name', L('Our primary foundry suppliers include Abacus Manufacturing Company (AMC), Defco and others.'), [['ABC', 'supplier', true, null], ['DEF', 'supplier', true, null]]);
eq('"manufactured by" a named supplier', L('We are reliant upon sole-source providers, such as with the tools manufactured by Abacus.'), [['ABC', 'supplier', true, null]]);
eq('a name after "Inc." stays in its sentence', sentences('We utilize Abacus for wafers and Defco Inc. (DF), for packaging. Next sentence here is separate.').length, 2);
eq('a list running past "Inc." stays in its sentence', sentences('Our competitors include Abacus, Inc. Defco Inc. and Foo Corporation. In addition, we see new entrants.').length, 2);
eq('"two customers … respectively" pairs in order', L('During fiscal 2026, two customers accounted for approximately 19% and 15%, respectively, of our net revenue.'),
  [['One customer', 'customer', false, 19], ['Another customer', 'customer', false, 15]]);
eq('"one direct customer … another direct customer"', L('For fiscal year 2026, sales to one direct customer represented 22% of total revenue and sales to another direct customer represented 14% of total revenue.'),
  [['One customer', 'customer', false, 22], ['Another customer', 'customer', false, 14]]);
eq('a "10% or more" threshold is not a share', L('In fiscal 2026 there were two customers (one distributor and one direct customer) whose revenues represented 10% or more of total net revenue.'), []);
eq('receivables are not revenue', L('One customer accounted for 44% of our net accounts receivable balance and revenue.'), []);
eq('one customer over several years keeps the latest year', L('During fiscal years 2026, 2025 and 2024, one customer accounted for 32%, 28% and 21% of our net revenue, respectively.'), [['One customer', 'customer', false, 32]]);
eq('a ranked customer over ascending years keeps the latest', L('Our largest customer in 2024 and 2025 accounted for 25% and 19% of our net revenue in the respective year.'), [['Largest customer', 'customer', false, 19]]);
{
  const t = 'In fiscal 2026, four customers accounted for 16%, 15%, 12%, and 11% of total revenues, respectively. In fiscal 2024, one customer accounted for approximately 17% of total revenues.';
  eq('an older year is not shown as this year', extractLinks(t, { filer: 'XYZ', counterparties: T }).map(l => [l.label, l.share]),
    [['One customer', 16], ['Another customer', 15], ['A third customer', 12], ['A fourth customer', 11]]);
  const u = 'In fiscal 2026, customers in several regions accounted for 30%, 25% and 20% of revenue. In fiscal 2024, one customer accounted for approximately 17% of total revenues.';
  eq("an older year is dropped even when the newest year's sentence can't be read", extractLinks(u, { filer: 'XYZ', counterparties: T }), []);
}

// ── A whole filing ──
const html = `<html><ix:header><ix:hidden>Abacus 99%</ix:hidden></ix:header><body>
<p>Item 1. Business.</p><p>We rely on Abacus to manufacture our wafers.</p>
<div style="display:none">Customer Z accounted for 99% of revenue.</div>
<p>Our competitors include Defco.</p><p>We also rely on Abacus for packaging and test services.</p>
<p>Customer A accounted for 13% of our total revenue.</p></body></html>`;
const text = filingText(html);
eq('hidden XBRL and display:none blocks are not read', [/99%/.test(text), /Customer Z/.test(text)], [false, false]);
eq('sentences split on full stops', sentences('We rely on Abacus for wafers. Our competitors include Defco.').length, 2);
const filing = { form: '10-K', accession: '0000000000-26-000001', url: 'https://example.invalid/x.htm', date: '2026-02-01' };
const links = extractLinks(text, { filer: 'XYZ', filing, counterparties: T });
eq('one link per counterparty and relation, the repeats counted', links.map(l => [l.counterparty || l.label, l.relation, l.mentions]),
  [['ABC', 'supplier', 2], ['DEF', 'competitor', 1], ['Customer A', 'customer', 1]]);
eq('each link quotes its sentence and names the filing', [links[0].quote, links[0].filing.accession], ['We rely on Abacus to manufacture our wafers.', '0000000000-26-000001']);

// ── The graph ──
const data = { companies: {
  XYZ: { name: 'Xyzzy', filing, links: [
    { counterparty: 'ABC', label: 'Abacus', relation: 'supplier', named: true, share: null, quote: 'q1' },
    { counterparty: 'DEF', label: 'Defco', relation: 'competitor', named: true, share: null, quote: 'q2' },
    { counterparty: null, label: 'Customer A', relation: 'customer', named: false, share: 13, quote: 'q3' }] },
  ABC: { name: 'Abacus', filing, links: [
    { counterparty: 'XYZ', label: 'Xyzzy', relation: 'customer', named: true, share: 22, quote: 'q4' }] },
} };
const edges = edgesOf(data);
const supply = edges.find(e => e.type === 'supply' && e.from === 'ABC' && e.to === 'XYZ');
eq('a link both sides state is one edge, with both quotes', [supply.sources.map(s => s.filer), supply.share], [['XYZ', 'ABC'], 22]);
eq('a stated share sets the weight; two filings outweigh one', [edgeWeight({ share: 22, sources: [] }), edgeWeight({ share: null, sources: [{ filer: 'A' }, { filer: 'B' }] }), edgeWeight({ share: null, sources: [{ filer: 'A' }] })], [2.2, 2, 1]);
const n = neighbours(data, 'XYZ');
eq('neighbours by role', [n.suppliers.map(x => x.ticker), n.competitors.map(x => x.ticker), n.customers.map(x => x.label)], [['ABC'], ['DEF'], ['Customer A']]);
eq('named only drops the anonymised customer', neighbours(data, 'XYZ', { named: true }).customers, []);
eq('the supplier sees the filer as its customer', neighbours(data, 'ABC').customers.map(x => x.ticker), ['XYZ']);
const g1 = graph(data, 'ABC', { depth: 1 }), g2 = graph(data, 'ABC', { depth: 2 });
eq('depth 1 is the direct neighbours', g1.nodes.map(x => x.id).sort(), ['ABC', 'XYZ']);
eq('depth 2 follows the supply chain, not the competitors of neighbours', g2.nodes.map(x => x.id).sort(), ['ABC', 'XYZ', 'XYZ:Customer A']);
eq('competitors appear around the centre', graph(data, 'XYZ').nodes.some(x => x.id === 'DEF'), true);

// ── The ticker page's card ──
const m = mapFor(data, 'XYZ');
eq('the card: roles, and the filer read', [m.suppliers.map(x => x.ticker), m.customers.map(x => [x.label, x.named, x.share]), m.competitors.map(x => x.ticker), m.filer.name, m.empty],
  [['ABC'], [['Customer A', false, 13]], ['DEF'], 'Xyzzy', null]);
eq('a company only others name has no filing of its own but still has links', [mapFor(data, 'DEF').filer, mapFor(data, 'DEF').competitors.map(x => x.ticker), mapFor(data, 'DEF').empty], [null, ['XYZ'], null]);
eq('a company read with no links says so', mapFor({ companies: { QQQ: { name: 'Q', links: [] } } }, 'QQQ').empty, 'read');
eq('a company not read says so', [mapFor({ companies: {}, missing: { QQQ: 'HTTP 404' } }, 'QQQ').empty, mapFor({ companies: {} }, 'ZZZ').empty], ['missing', 'none']);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
