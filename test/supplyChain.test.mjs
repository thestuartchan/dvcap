// test/supplyChain.test.mjs — supplier / customer / competitor links from filings (lib/supplyChain.js).
// Fake companies and made-up sentences throughout; the real counterparty table is not used.
import { filingText, sentences, linksInSentence, extractLinks, edgesOf, edgeWeight, neighbours, graph } from '../lib/supplyChain.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
