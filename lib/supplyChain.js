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
  { ticker: 'GFS', label: 'GlobalFoundries', re: /\bGlobalFoundries\b|\bGLOBALFOUNDRIES\b|\bGlobal Foundries\b/ },
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
  { ticker: 'AAPL', label: 'Apple', re: /\bApple Inc\b|\bApple\b(?=,|\)| (?:and|or|accounted|represented|is|was)\b)/ },
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

// Wording that says what the named company is to the filer. A keyword alone is not enough: the
// first real run (28 annual reports) showed "customers" next to any company name ("Intel targets
// our customers"), "supplier" in directors' biographies, "competitive" in "competitive advantage",
// and supplier wording about another company's suppliers ("NVIDIA relies on suppliers such as
// TSMC" in CoreWeave's 10-K). So a supplier or customer link needs the name in the position the
// wording points at (the list after "customers include", the name after "sales to"); the plain
// keywords below only decide whether a sentence is about supply at all.
const SUPPLIER_KW = /\b(suppliers?|sole[- ]sourced?|single[- ]sourced?|foundr(?:y|ies)|fabricat\w*|wafers?|subcontract\w*|contract manufactur\w*|assembly and test|packaging (?:and|services|partners?)|manufactur\w* (?:for|by) us|(?:we|the company) (?:rely|relies|depend|depends) (?:up)?on|purchase[sd]? (?:from|of)|procure\w*)\b/i;
const CUSTOMER_KW = /\b(customers?|sales to|revenues? from|largest (?:end )?customer|accounted for (?:approximately )?\d)/i;
const COMPETITOR_KW = /\bcompet(?:e|es|ing|itors?|ition)\b|\bcompetitive products\b/i;
// "Competitive" wording that names no competitor: stripped before COMPETITOR_KW is tested.
const NOT_COMPETITION = /\b(?:anti-?competiti\w*|unfair competition|competition (?:law|authorit\w*|claims?)|competitive(?:ness)? (?:advantage|disadvantage|position|landscape|environment|pressures?|strengths?)|highly competitive|competitiveness)\b/gi;
const REVENUE_KW = /\b(revenues?|net sales|total sales|sales)\b/i;
const PCT = /(\d{1,2}(?:\.\d)?)\s?%/g;
// The filer speaking about itself. A supplier sentence without it is about someone else's supply.
const FIRST_PERSON = /\b(?:we|our|us|ourselves)\b|\bthe Company\b/i;
// "Would shift manufacturing to TSMC", "foundries capable of producing": not a relationship today.
const HYPOTHETICAL = /\b(?:would|could|might|in such event|capable of)\b/i;
// Co-ownership ("jointly owned by TSMC and ourselves") is not supply.
const OWNERSHIP = /\b(?:jointly owned|ownership|owned by|shares)\b/i;
// Revenue-share wording that is a threshold or a group, not one customer's share.
const THRESHOLD = /\b(?:or more|more than|at least|greater than|in excess of|exceed\w*)\b|\b(?:top|largest) (?:two|three|four|five|ten|\d+)\b|\bno (?:in ?dividual |single |end )?customer\b/i;

const LIST_TRIGGER = /\b(?:include[sd]?|including|such as|are|were|is|was)\b|\((?:for example|e\.g\.|such as|including),?/gi;
// "Customers" as a noun, not "customer contracts" (CoreWeave: "our current customer contracts, all of
// the GPUs … are NVIDIA GPUs" is about its supplier).
const CUSTOMER_NOUN = /\bcustomers\b(?!['’])|\bcustomer\b(?=,? (?:is|was|includes?|included)\b)/gi;
const SUPPLIER_NOUN = /\b(?:foundr(?:y|ies)|suppliers?|subcontractors?|contract manufacturers?|CMs|providers?|vendors?)\b/gi;
const SUPPLIED_BY = /\b(?:manufactured|supplied|fabricated|produced) by\s*$/i;
const RELY_ON = /\b(?:rely|relies|depend|depends|reliant|dependent)\b(?: \w+){0,3} (?:up)?on\b/gi;
const WE_USE = /\bwe (?:[\w-]+ ){0,4}(?:utilize|use|engage(?: with)?)\b/i;
const SUPPLY_CONTEXT = /\b(?:wafers?|foundr\w*|manufactur\w*|fabricat\w*|assembly|packaging|production)\b/i;
const SALES_TO = /\b(?:sales to|revenues? from)\s+/gi;
const TOP_CUSTOMER = /\b(?:top|largest|major|significant|key|biggest) customer,?\s*$/i;

// Long enough for a competition section's one-sentence list of 25 companies (Marvell's runs ~1,000).
const MAX_SENTENCE = 1200;

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

// Sentence ends. A full stop after a company suffix ("GLOBALFOUNDRIES Inc. (GF) …", "Advanced
// Micro Devices, Inc., Broadcom Inc. …") is not one when what follows carries on: a bracket, or
// the next company of a list. Splitting there cut names off from the sentence about them.
const SUFFIX_END = /\b(?:Inc|Ltd|Co|Corp|N\.V|S\.A|L\.P|e\.g|i\.e|U\.S)\.$/;
const CARRIES_ON = /^(?:\(|[A-Z][\w&.-]*(?: [A-Z][\w&.-]*){0,4},? (?:Inc|Ltd|Corp|Corporation|Co|LLC|N\.V|AG|SE|plc)\b)/;
export function sentences(text = '') {
  const parts = String(text).split(/(?<=[.!?])\s+(?=[A-Z"“(])/);
  const out = [];
  for (const p of parts) {
    if (out.length && SUFFIX_END.test(out[out.length - 1]) && CARRIES_ON.test(p)) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out.map(s => s.trim()).filter(s => s.length >= 25 && s.length <= MAX_SENTENCE);
}

// Every place a counterparty is named in a sentence, minus the filer itself.
function namesIn(s, filer, table = COUNTERPARTIES) {
  const out = [];
  for (const c of table) {
    if (c.ticker === filer) continue;
    const re = new RegExp(c.re.source, c.re.flags.includes('g') ? c.re.flags : `${c.re.flags}g`);
    const at = [...s.matchAll(re)].map(m => m.index);
    if (at.length) out.push({ ...c, at });
  }
  return out;
}

// True when the text between a trigger and a name reads like the earlier items of a list
// ("Micron Technology, Inc., Samsung Electronics Company, Ltd., and "), not a clause.
function listGap(gap) {
  const g = gap.replace(/\([^()]{0,40}\)/g, ' ').replace(/\bbut (?:are |is )?not limited to\b/gi, ' ').replace(/\bin alphabetical order\b/gi, ' ');
  if (g.length > 220 || /[()]/.test(g)) return false;
  return g.split(/,|;|\band\b|\bor\b/).map(c => c.trim()).filter(Boolean)
    .every(c => /^["“]?[A-Z0-9]/.test(c) && c.split(/\s+/).length <= 6);
}

// Is the name at `at` inside a list that a trigger opens, with `noun` (customers, foundries…) at
// most 120 characters before the trigger?
function inListOf(s, at, noun) {
  for (const t of [...s.matchAll(LIST_TRIGGER)].reverse()) {
    const end = t.index + t[0].length;
    if (end > at) continue;
    const hasNoun = new RegExp(noun.source, 'i').test(s.slice(Math.max(0, t.index - 120), t.index));
    if (hasNoun && listGap(s.slice(end, at))) return true;
    return false; // only the nearest trigger before the name counts
  }
  return false;
}

function isSupplierAt(s, at) {
  if (inListOf(s, at, SUPPLIER_NOUN)) return true;
  const head = s.slice(0, at);
  if (SUPPLIED_BY.test(head)) return true;
  for (const m of head.matchAll(RELY_ON)) if (listGap(head.slice(m.index + m[0].length)) || /^\s*(?:[\w-]+\s+){0,5}(?:with|including)\s+$/i.test(head.slice(m.index + m[0].length))) return true;
  if (/\b(?:obtain|purchase|procure|source|buy)\w*\s+(?:[\w-]+\s+){0,5}?from\s+(?:[\w-]+\s+){0,4}?$/i.test(head)) return true;
  const use = head.match(WE_USE);
  return !!use && SUPPLY_CONTEXT.test(s);
}

function isCustomerAt(s, at, len) {
  if (inListOf(s, at, CUSTOMER_NOUN)) return true;
  const head = s.slice(0, at), tail = s.slice(at + len);
  if (TOP_CUSTOMER.test(head)) return true;
  const sales = [...head.matchAll(SALES_TO)].pop();
  if (sales) {
    const gap = head.slice(sales.index + sales[0].length);
    if (listGap(gap) || /^(?:[\w-]+\s+){0,4}?with\s+$/i.test(gap)) return true;
  }
  if (/^[\w.,\s-]{0,30}?,? (?:which|who) (?:is|was|has been|remains)(?: currently| also)? (?:a|an|our)(?: [\w-]+){0,2} customer\b/i.test(tail)) return true;
  if (/^[\w.,\s-]{0,30}? (?:to be|is|was|as|became|remains)(?: currently| also)? (?:a|an|our)(?: [\w-]+){0,2} customer\b/i.test(tail)) return true;
  return /^[\w.,\s-]{0,30}? (?:accounted for|represented) (?:approximately )?\d/i.test(tail);
}

const COUNT = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const RANKED = /\b(largest|second[- ]largest|third[- ]largest) (?:end |direct )?customer\b/gi;
const ORDINAL = ['One customer', 'Another customer', 'A third customer', 'A fourth customer', 'A fifth customer'];
const yearsIn = (s) => [...new Set([...s.matchAll(/\b(20\d\d)\b/g)].map(m => +m[1]))];

// Anonymised customers with the share the sentence states. Returns [{ label, share }] only when
// labels and percentages pair up one to one: "Customer A accounted for 12%", "Customers A and B
// … 16% and 12%", "sales to one direct customer represented 22% … another direct customer 14%",
// "two customers accounted for 19% and 15%, respectively", "one of our end customers accounted
// for 12%". A sentence giving one customer across years ("2025, 2024 and 2023 … 32%, 28% and
// 21%, respectively") keeps the latest year's figure. Thresholds ("10% or more"), groups ("top
// five customers") and receivables are not revenue shares and are skipped.
function anonymisedCustomers(s) {
  if (!REVENUE_KW.test(s) || !/accounted for|represented|comprised/i.test(s)) return [];
  if (THRESHOLD.test(s) || /receivable/i.test(s)) return [];
  let pcts = [...s.matchAll(PCT)].map(m => +m[1]).filter(p => p > 0 && p < 100);
  const years = yearsIn(s);
  const lettered = [...s.matchAll(/\bCustomers? ([A-Z](?:(?:, | and |, and )[A-Z])*)\b/g)]
    .flatMap(m => m[1].split(/, and |, | and /)).filter(x => /^[A-Z]$/.test(x)).map(x => `Customer ${x}`);
  if (lettered.length) {
    const uniq = [...new Set(lettered)];
    return uniq.length === pcts.length ? uniq.map((label, i) => ({ label, share: pcts[i] })) : [];
  }
  const ranked = [...s.matchAll(RANKED)];
  const D = '(?:direct |indirect |end |single )?';
  const ones = [...s.matchAll(new RegExp(`\\b(?:one|another|a second|a third) ${D}customer\\b|\\bone of our ${D}customers\\b`, 'gi'))].length;
  const counted = s.match(new RegExp(`\\b(two|three|four|five) ${D}customers?\\b`, 'i'));
  if (/\b(?:two|three|four|five|several|ten) (?:[\w-]+ )?customers\b/i.test(s) && !counted) return [];
  let n = counted ? (ones ? 0 : COUNT[counted[1].toLowerCase()]) : ones;
  if (!n && ranked.length === 1) n = 1;
  if (!n || (n && ranked.length && (ones || counted))) return [];
  // One customer, several years, "respectively": the latest year's share.
  if (n === 1 && pcts.length > 1 && years.length === pcts.length && /respective/i.test(s)) {
    const order = /\b(20\d\d)\b[^%]*?\b(20\d\d)\b/.exec(s);
    const descending = order && +order[1] > +order[2];
    pcts = [descending ? pcts[0] : pcts[pcts.length - 1]];
  }
  if (pcts.length !== n) return [];
  if (!ones && !counted) {
    const r = ranked[0][1].toLowerCase().replace(' ', '-');
    return [{ label: `${r[0].toUpperCase()}${r.slice(1)} customer`, share: pcts[0] }];
  }
  return pcts.map((share, i) => ({ label: ORDINAL[i], share }));
}

// The links one sentence states, from the filer's point of view: `relation` is what the
// counterparty is TO THE FILER (its supplier, its customer, its competitor). A name the sentence
// makes two things (a customer and a competitor) is left out.
export function linksInSentence(s, filer, { counterparties = COUNTERPARTIES } = {}) {
  const plain = s.replace(NOT_COMPETITION, ' ');
  const hasS = SUPPLIER_KW.test(s), hasC = CUSTOMER_KW.test(s), hasK = COMPETITOR_KW.test(plain);
  const names = namesIn(s, filer, counterparties);
  if (!names.length) {
    if (!hasC || hasS) return [];
    return anonymisedCustomers(s).map(a => ({ counterparty: null, label: a.label, relation: 'customer', named: false, share: a.share }));
  }
  const firstPerson = FIRST_PERSON.test(s), hypothetical = HYPOTHETICAL.test(s);
  const found = [];
  for (const n of names) {
    const len = (s.slice(n.at[0]).match(n.re) || [''])[0].length;
    const sup = hasS && firstPerson && !hypothetical && !OWNERSHIP.test(s) && n.at.some(a => isSupplierAt(s, a));
    const cus = hasC && !hypothetical && n.at.some(a => isCustomerAt(s, a, len));
    const roles = [sup && 'supplier', cus && 'customer'].filter(Boolean);
    if (roles.length === 1 && !hasK) found.push({ n, relation: roles[0] });
    else if (!roles.length && hasK && !hasS && !hasC) found.push({ n, relation: 'competitor' });
  }
  // A share only when the sentence names one company and states one percentage of revenue.
  const pcts = [...s.matchAll(PCT)].map(m => +m[1]);
  return found.map(({ n, relation }) => ({
    counterparty: n.ticker, label: n.label, relation, named: true,
    share: relation === 'customer' && names.length === 1 && pcts.length === 1 && REVENUE_KW.test(s) && !THRESHOLD.test(s) ? pcts[0] : null,
  }));
}

// Every link in a filing's text. One entry per counterparty and relation: the first sentence that
// states it is quoted, a stated revenue share is preferred, and `mentions` counts the rest.
// Anonymised customers are re-stated every year ("For fiscal year 2024, one customer…"), so only
// the latest year the filing gives them for is kept: an older year's share is not this year's.
// "Latest" counts every customer-share sentence, read or not: when the newest year's sentence is
// one the rules can't pair up, the older years are dropped too rather than shown as current.
export function extractLinks(text, { filer, filing = null, counterparties = COUNTERPARTIES } = {}) {
  const out = new Map();
  let latestStated = 0;
  for (const s of sentences(text)) {
    if (/customer/i.test(s) && REVENUE_KW.test(s) && /accounted for|represented|comprised/i.test(s) && /%/.test(s) && !/receivable/i.test(s)) latestStated = Math.max(latestStated, ...yearsIn(s));
    for (const l of linksInSentence(s, filer, { counterparties })) {
      const year = l.named ? null : Math.max(0, ...yearsIn(s));
      const key = `${l.relation}|${l.counterparty || l.label}|${year ?? ''}`;
      const prev = out.get(key);
      if (!prev) out.set(key, { ...l, quote: s, mentions: 1, filing, year });
      else {
        prev.mentions++;
        if (prev.share == null && l.share != null) Object.assign(prev, { share: l.share, quote: s });
      }
    }
  }
  const links = [...out.values()];
  const latest = Math.max(latestStated, ...links.filter(l => !l.named).map(l => l.year));
  return links.filter(l => l.named || l.year === latest).map(({ year: _y, ...l }) => l);
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

// What the ticker page's map card draws for one company: its neighbours by role, whether its own
// filing was read, and the plain reason when there is nothing to draw. Tickers the dashboard writes
// differently from the map (GOOG for GOOGL) are folded in.
const ALIAS = { GOOG: 'GOOGL' };
export function mapFor(data, ticker) {
  const id = ALIAS[ticker] || ticker;
  const co = data?.companies?.[id] || null;
  const n = neighbours(data, id);
  const count = n.suppliers.length + n.customers.length + n.competitors.length;
  const empty = count ? null : co ? 'read' : data?.missing?.[id] ? 'missing' : 'none';
  return { centre: id, label: labelOf(id, data), filer: co ? { name: co.name, filing: co.filing || null } : null,
    missing: data?.missing?.[id] || null, ...n, empty };
}
