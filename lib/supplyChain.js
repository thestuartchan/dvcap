// lib/supplyChain.js — supplier, customer and competitor maps from companies' own SEC filings.
//
// WHAT THIS IS. Bloomberg's SPLC answers "who sells to whom" from a paid dataset. This builds the
// free part of that from the one source that cannot be second-hand: the company's own annual
// report (10-K, or 20-F for a foreign filer). Every link carries the filing it came from and the
// exact sentence that states it, so a reader can check it in one click. Nothing comes from press,
// summaries or a model. scripts/supplychain-build.mjs reads the filings; this file is pure.
//
// WHAT A FILING CAN AND CANNOT SAY.
//   • Suppliers are often NAMED ("we rely on TSMC to manufacture our wafers").
//   • Customers are often ANONYMISED ("Customer A accounted for 12% of revenue"). Those are kept as
//     anonymised links with the share the filing states. Naming one would need another primary
//     filing that says so, quoted on its own link; this file never infers it.
//   • Competitors are usually named in the competition section.
// A sentence that is ambiguous (it names a company as both customer and competitor, or carries
// both supplier and customer wording) is left out. A missing link beats a wrong one.

// The ~30 names the map covers: the AI and semiconductor complex the dashboard already watches
// (data/universe.js, the ratios, the playbook names, Smart Money). No position data is read.
export const SC_UNIVERSE = Object.freeze([
  'NVDA', 'AMD', 'INTC', 'AVGO', 'QCOM', 'MRVL', 'ARM', 'MU', 'SNDK', 'TSM', 'ASML', 'AMAT', 'LRCX',
  'TXN', 'ADI', 'NXPI', 'STM', 'GLW', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'ORCL', 'CRWV', 'SAP',
  'VST', 'GEV',
]);

// Counterparty names as filings write them → a ticker where one exists. Patterns are deliberately
// strict: a bare "Arm" or "Flex" is a common word, so only the full company name matches.
export const COUNTERPARTIES = Object.freeze([
  { ticker: 'TSM', label: 'TSMC', re: /\bTSMC\b|\bTaiwan Semiconductor Manufacturing\b/ },
  { ticker: '005930.KS', label: 'Samsung', re: /\bSamsung\b/ },
  { ticker: '000660.KS', label: 'SK hynix', re: /\bSK ?[Hh]ynix\b/ },
  { ticker: 'MU', label: 'Micron', re: /\bMicron\b/ },
  { ticker: 'NVDA', label: 'Nvidia', re: /\bNVIDIA\b|\bNvidia\b/ },
  { ticker: 'AMD', label: 'AMD', re: /\bAdvanced Micro Devices\b|\bAMD\b/ },
  { ticker: 'INTC', label: 'Intel', re: /\bIntel\b(?! ?ligen)/ },
  { ticker: 'AVGO', label: 'Broadcom', re: /\bBroadcom\b/ },
  { ticker: 'QCOM', label: 'Qualcomm', re: /\bQualcomm\b|\bQUALCOMM\b/ },
  { ticker: 'MRVL', label: 'Marvell', re: /\bMarvell\b/ },
  { ticker: 'ARM', label: 'Arm', re: /\bArm Holdings\b|\bArm Limited\b|\bARM Limited\b/ },
  { ticker: 'ASML', label: 'ASML', re: /\bASML\b/ },
  { ticker: 'AMAT', label: 'Applied Materials', re: /\bApplied Materials\b/ },
  { ticker: 'LRCX', label: 'Lam Research', re: /\bLam Research\b/ },
  { ticker: 'KLAC', label: 'KLA', re: /\bKLA\b/ },
  { ticker: '8035.T', label: 'Tokyo Electron', re: /\bTokyo Electron\b/ },
  { ticker: 'AMKR', label: 'Amkor', re: /\bAmkor\b/ },
  { ticker: 'ASX', label: 'ASE', re: /\bASE Technology\b|\bAdvanced Semiconductor Engineering\b/ },
  { ticker: '2317.TW', label: 'Foxconn (Hon Hai)', re: /\bHon Hai\b|\bFoxconn\b/ },
  { ticker: '3231.TW', label: 'Wistron', re: /\bWistron\b/ },
  { ticker: '2382.TW', label: 'Quanta', re: /\bQuanta Computer\b/ },
  { ticker: 'GFS', label: 'GlobalFoundries', re: /\bGlobalFoundries\b|\bGLOBALFOUNDRIES\b/ },
  { ticker: 'UMC', label: 'UMC', re: /\bUnited Microelectronics\b/ },
  { ticker: '0981.HK', label: 'SMIC', re: /\bSMIC\b|\bSemiconductor Manufacturing International\b/ },
  { ticker: 'STM', label: 'STMicro', re: /\bSTMicroelectronics\b/ },
  { ticker: 'TXN', label: 'Texas Instruments', re: /\bTexas Instruments\b/ },
  { ticker: 'ADI', label: 'Analog Devices', re: /\bAnalog Devices\b/ },
  { ticker: 'NXPI', label: 'NXP', re: /\bNXP\b/ },
  { ticker: 'SNDK', label: 'SanDisk', re: /\bSanDisk\b|\bSandisk\b/ },
  { ticker: 'WDC', label: 'Western Digital', re: /\bWestern Digital\b/ },
  { ticker: '285A.T', label: 'Kioxia', re: /\bKioxia\b|\bKIOXIA\b/ },
  { ticker: 'MSFT', label: 'Microsoft', re: /\bMicrosoft\b/ },
  { ticker: 'AMZN', label: 'Amazon', re: /\bAmazon\b/ },
  { ticker: 'GOOGL', label: 'Alphabet (Google)', re: /\bAlphabet\b|\bGoogle\b/ },
  { ticker: 'META', label: 'Meta', re: /\bMeta Platforms\b/ },
  { ticker: 'AAPL', label: 'Apple', re: /\bApple Inc\b|\bApple\b(?= (?:and|or|,|accounted|represented|is|was))/ },
  { ticker: 'ORCL', label: 'Oracle', re: /\bOracle\b/ },
  { ticker: 'DELL', label: 'Dell', re: /\bDell\b/ },
  { ticker: 'HPE', label: 'HPE', re: /\bHewlett Packard Enterprise\b/ },
  { ticker: 'SMCI', label: 'Super Micro', re: /\bSuper Micro\b|\bSupermicro\b/ },
  { ticker: 'CRWV', label: 'CoreWeave', re: /\bCoreWeave\b/ },
  { ticker: 'GLW', label: 'Corning', re: /\bCorning\b/ },
  { ticker: 'CSCO', label: 'Cisco', re: /\bCisco\b/ },
  { ticker: 'ANET', label: 'Arista', re: /\bArista\b/ },
  { ticker: 'JBL', label: 'Jabil', re: /\bJabil\b/ },
  { ticker: 'CLS', label: 'Celestica', re: /\bCelestica\b/ },
  { ticker: 'SAP', label: 'SAP', re: /\bSAP SE\b/ },
  { ticker: 'VST', label: 'Vistra', re: /\bVistra\b/ },
  { ticker: 'GEV', label: 'GE Vernova', re: /\bGE Vernova\b/ },
  { ticker: 'OPENAI', label: 'OpenAI', re: /\bOpenAI\b/ },
]);

// Wording that says what the named company is to the filer.
const SUPPLIER_KW = /\b(suppliers?|sole[- ]sourced?|single[- ]sourced?|foundr(?:y|ies)|fabricat\w*|wafers?|subcontract\w*|contract manufactur\w*|assembly and test|packaging (?:and|services|partners?)|manufactur\w* (?:for|by) us|(?:we|the company) (?:rely|relies|depend|depends) (?:up)?on|purchase[sd]? (?:from|of)|procure\w*)\b/i;
const CUSTOMER_KW = /\b(customers?|sales to|revenue from|largest (?:end )?customer|accounted for (?:approximately )?\d)/i;
const COMPETITOR_KW = /\bcompet(?:e|es|ing|itors?|ition|itive)\b/i;
const REVENUE_KW = /\b(revenue|net sales|total sales|sales)\b/i;
const PCT = /(\d{1,2}(?:\.\d)?)\s?%/g;

const MAX_SENTENCE = 700;

// HTML → plain text, for a filing's primary document. Inline-XBRL headers and hidden blocks are
// dropped (they hold tagged facts, not prose); entities are decoded; whitespace collapsed.
export function filingText(html = '') {
  return String(html)
    .replace(/<ix:header>[\s\S]*?<\/ix:header>/gi, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<div[^>]*display:\s*none[^>]*>[\s\S]*?<\/div>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\u2029')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#8217;|&rsquo;|&#x2019;/gi, '’').replace(/&#8216;|&lsquo;/gi, '‘')
    .replace(/&#8220;|&ldquo;|&#8221;|&rdquo;/gi, '"').replace(/&#8211;|&ndash;/gi, '–').replace(/&#8212;|&mdash;/gi, '—')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    // A block's end is a sentence's end: keep the block's own punctuation, add a stop only when
    // it has none (a heading, a table cell), so one paragraph never reads into the next.
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(/([.!?:;])\s*(?:\u2029\s*)+/g, '$1 ')
    .replace(/\s*(?:\u2029\s*)+/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sentences(text = '') {
  return String(text).split(/(?<=[.!?])\s+(?=[A-Z"“(])/).map(s => s.trim()).filter(s => s.length >= 25 && s.length <= MAX_SENTENCE);
}

// The names in a sentence, minus the filer itself.
function namesIn(s, filer, table = COUNTERPARTIES) {
  return table.filter(c => c.ticker !== filer && c.re.test(s));
}

// "Customer A accounted for 12%" / "Customers A and B accounted for 14% and 11%" /
// "one customer accounted for 16% of revenue". Returns [{ label, share }] only when the labels and
// the percentages pair up one to one; anything else is too uncertain to keep.
function anonymisedCustomers(s) {
  if (!REVENUE_KW.test(s) || !/accounted for|represented|comprised/i.test(s)) return [];
  const pcts = [...s.matchAll(PCT)].map(m => +m[1]).filter(p => p > 0 && p < 100);
  const lettered = [...s.matchAll(/\bCustomers? ([A-Z](?:(?:, | and |, and )[A-Z])*)\b/g)]
    .flatMap(m => m[1].split(/, and |, | and /)).filter(x => /^[A-Z]$/.test(x)).map(x => `Customer ${x}`);
  if (lettered.length) {
    const uniq = [...new Set(lettered)];
    return uniq.length === pcts.length ? uniq.map((label, i) => ({ label, share: pcts[i] })) : [];
  }
  if (/\b(one|a single) (?:direct |indirect |end )?customer\b/i.test(s) && pcts.length === 1) return [{ label: 'One customer', share: pcts[0] }];
  return [];
}

// The links one sentence states, from the filer's point of view: `relation` is what the
// counterparty is TO THE FILER (its supplier, its customer, its competitor).
export function linksInSentence(s, filer, { counterparties = COUNTERPARTIES } = {}) {
  const hasS = SUPPLIER_KW.test(s), hasC = CUSTOMER_KW.test(s), hasK = COMPETITOR_KW.test(s);
  const names = namesIn(s, filer, counterparties);
  if (!names.length) {
    if (!hasC || hasS) return [];
    return anonymisedCustomers(s).map(a => ({ counterparty: null, label: a.label, relation: 'customer', named: false, share: a.share }));
  }
  let relation = null;
  if (hasK && !hasS && !hasC) relation = 'competitor';
  else if (hasS && !hasC && !hasK) relation = 'supplier';
  else if (hasC && !hasS && !hasK) relation = 'customer';
  if (!relation) return [];
  // A share only when the sentence names one company and states one percentage of revenue.
  const pcts = [...s.matchAll(PCT)].map(m => +m[1]);
  const share = relation === 'customer' && names.length === 1 && pcts.length === 1 && REVENUE_KW.test(s) ? pcts[0] : null;
  return names.map(n => ({ counterparty: n.ticker, label: n.label, relation, named: true, share }));
}

// Every link in a filing's text. One entry per counterparty and relation: the first sentence that
// states it is quoted, a stated revenue share is preferred, and `mentions` counts the rest.
export function extractLinks(text, { filer, filing = null, counterparties = COUNTERPARTIES } = {}) {
  const out = new Map();
  for (const s of sentences(text)) {
    for (const l of linksInSentence(s, filer, { counterparties })) {
      const key = `${l.relation}|${l.counterparty || l.label}`;
      const prev = out.get(key);
      if (!prev) out.set(key, { ...l, quote: s, mentions: 1, filing });
      else {
        prev.mentions++;
        if (prev.share == null && l.share != null) Object.assign(prev, { share: l.share, quote: s });
      }
    }
  }
  return [...out.values()];
}

// ── THE GRAPH ────────────────────────────────────────────────────────────────
// Links are stored per filer. Edges are normalised so a link stated by both sides is one edge:
// supply edges run from seller to buyer; competitor edges are undirected (stored sorted).
export function edgesOf(data) {
  const edges = new Map();
  for (const [filer, co] of Object.entries(data?.companies || {})) {
    for (const l of co.links || []) {
      const other = l.counterparty || `${filer}:${l.label}`;
      let from, to, type;
      if (l.relation === 'supplier') { from = other; to = filer; type = 'supply'; }
      else if (l.relation === 'customer') { from = filer; to = other; type = 'supply'; }
      else { [from, to] = [filer, other].sort(); type = 'compete'; }
      const key = `${type}|${from}|${to}`;
      const e = edges.get(key) || { from, to, type, named: l.named, share: null, sources: [] };
      e.sources.push({ filer, quote: l.quote, filing: l.filing || co.filing || null, share: l.share ?? null });
      if (l.share != null && (e.share == null || l.share > e.share)) e.share = l.share;
      edges.set(key, e);
    }
  }
  return [...edges.values()].map(e => ({ ...e, weight: edgeWeight(e) }));
}

// How heavy to draw an edge: a stated revenue share sets it (10% → 1, 30%+ → 3); otherwise one
// for a link one filing states and two for a link both companies' filings state.
export function edgeWeight(e) {
  if (e.share != null) return Math.max(1, Math.min(3, +(e.share / 10).toFixed(1)));
  const filers = new Set((e.sources || []).map(s => s.filer));
  return filers.size >= 2 ? 2 : 1;
}

// A node's display name: the counterparty table's, the stored link label, or the id itself.
const labelOf = (id, data = null) => COUNTERPARTIES.find(c => c.ticker === id)?.label
  || data?.companies?.[id]?.name || (id.includes(':') ? id.split(':')[1] : id);

// One company's neighbours, grouped by what they are to it. `named: true` drops anonymised links.
export function neighbours(data, ticker, { named = false } = {}) {
  const out = { suppliers: [], customers: [], competitors: [] };
  for (const e of edgesOf(data)) {
    if (named && !e.named) continue;
    const row = (id) => ({ ticker: id.includes(':') ? null : id, label: labelOf(id, data), named: e.named, share: e.share, weight: e.weight, sources: e.sources });
    if (e.type === 'supply' && e.to === ticker) out.suppliers.push(row(e.from));
    else if (e.type === 'supply' && e.from === ticker) out.customers.push(row(e.to));
    else if (e.type === 'compete' && (e.from === ticker || e.to === ticker)) out.competitors.push(row(e.from === ticker ? e.to : e.from));
  }
  const byWeight = (a, b) => b.weight - a.weight || String(a.label).localeCompare(String(b.label));
  for (const k of Object.keys(out)) out[k].sort(byWeight);
  return out;
}

// The map around one company, to depth 1 or 2. Competitors are shown around the centre only, so a
// second ring stays a supply chain and does not turn into the whole industry.
export function graph(data, centre, { depth = 1, named = false, competitors = true } = {}) {
  const all = edgesOf(data).filter(e => !named || e.named);
  const nodes = new Map([[centre, { id: centre, label: labelOf(centre, data), depth: 0 }]]);
  const keep = new Set();
  let frontier = [centre];
  for (let d = 1; d <= Math.max(1, Math.min(2, depth)); d++) {
    const next = [];
    for (const e of all) {
      if (e.type === 'compete' && (!competitors || d > 1)) continue;
      for (const id of frontier) {
        const other = e.from === id ? e.to : e.to === id ? e.from : null;
        if (!other) continue;
        keep.add(e);
        if (!nodes.has(other)) { nodes.set(other, { id: other, label: labelOf(other, data), depth: d, inUniverse: SC_UNIVERSE.includes(other) }); next.push(other); }
      }
    }
    frontier = next;
  }
  return { centre, nodes: [...nodes.values()], edges: [...keep] };
}
