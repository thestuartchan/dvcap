// lib/ogeRead.js — reading the President's / VP's OGE 278-T trade reports (scanned PDFs).
//
// OGE posts the 278-T as a scan with Adobe's OCR text layer on top. The text is noisy ("lourchaso",
// "$1 000 001 • $5 000 000", "8/312026") but the row numbers, names and amounts survive well enough
// to say "row 63 looks like NVIDIA, $250K–$500K" so Stu can check that row in the PDF himself
// (Stu, 13 Nov 2026: "Even if it reads it wrong … list the row #").
//
// Steps: the text layer → lines of cells (by position) → rows → the amount bracket matched by digits
// (fuzzy, OCR-tolerant) → stock or bond → a ticker guessed from SEC's company names. Nothing here is
// an LLM; every guess is marked as a guess on the card.

// ── 1. THE TEXT LAYER → LINES OF CELLS ──────────────────────────────────────
// items: unpdf/pdf.js text items {str, transform:[a,b,c,d,x,y], width}. Words on one baseline (±3pt)
// form a line; a gap wider than CELL_GAP points starts a new cell (the form's columns).
const CELL_GAP = 9;
const NAME_END = 480;   // the name column ends where the transaction type begins
export function linesOf(items, page = 1) {
  const words = (items || []).filter(it => it && String(it.str || '').trim()).map(it => ({
    s: String(it.str).trim(), x: Number(it.transform?.[4]) || 0, y: Number(it.transform?.[5]) || 0, w: Number(it.width) || 0 }));
  words.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const w of words) {
    const l = lines.find(z => Math.abs(z.y - w.y) <= 3);
    if (l) l.words.push(w); else lines.push({ y: w.y, words: [w] });
  }
  const out = lines.sort((a, b) => b.y - a.y).map(l => {
    const ws = l.words.sort((a, b) => a.x - b.x);
    const cells = [];
    let cur = null, end = -Infinity;
    for (const w of ws) {
      if (!cur || w.x - end > CELL_GAP) { cur = { x: w.x, t: w.s }; cells.push(cur); } else cur.t += ` ${w.s}`;
      end = Math.max(end, w.x + w.w);
    }
    return { page, y: l.y, cells: cells.map(c => ({ x: Math.round(c.x), t: c.t })) };
  });
  // The scan's right-hand columns (date, flag, amount) often sit a few points off the row's baseline:
  // a line that starts right of the name column and has no row number joins the nearest row within 6pt.
  const isRow = (l) => /^\d{1,4}(\s|$)/.test(l.cells[0]?.t || '') && l.cells[0].x < 100;
  const rows = out.filter(isRow);
  const keep = [];
  // Likewise a name alone on its line (x ≈ 106) a few points above or below a row that has none.
  const hasName = (r) => r.cells.some(c => c.x >= 95 && c.x < NAME_END);
  const join = (r, l) => { r.cells = [...r.cells, ...l.cells].sort((a, b) => a.x - b.x); };
  for (const l of out) {
    const x0 = l.cells[0]?.x ?? 0;
    if (isRow(l) || x0 < 95) { keep.push(l); continue; }
    const nameOnly = x0 < 300;
    let best = null;
    for (const r of rows) {
      const d = Math.abs(r.y - l.y);
      if (d <= (nameOnly ? 9 : 6) && (!nameOnly || !hasName(r)) && (!best || d < Math.abs(best.y - l.y))) best = r;
    }
    if (best) join(best, l); else keep.push(l);
  }
  return keep;
}
export async function pdfLines(bytes) {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes, { verbosity: 0 });   // quiet: scanned fonts warn on every page
  const out = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    out.push(...linesOf((await page.getTextContent()).items, p));
  }
  return out;
}

// ── 2. AMOUNTS ───────────────────────────────────────────────────────────────
// The 278-T brackets. The OCR'd amount is reduced to its digits and matched to the nearest bracket
// by edit distance, so "$1 000 001 • SS 000 000" still reads as $1,000,001 – $5,000,000.
export const BRACKETS = Object.freeze([
  { lo: 1001, hi: 15000, label: '$1K–$15K' },
  { lo: 15001, hi: 50000, label: '$15K–$50K' },
  { lo: 50001, hi: 100000, label: '$50K–$100K' },
  { lo: 100001, hi: 250000, label: '$100K–$250K' },
  { lo: 250001, hi: 500000, label: '$250K–$500K' },
  { lo: 500001, hi: 1000000, label: '$500K–$1M' },
  { lo: 1000001, hi: 5000000, label: '$1M–$5M' },
  { lo: 5000001, hi: 25000000, label: '$5M–$25M' },
  { lo: 25000001, hi: 50000000, label: '$25M–$50M' },
  { lo: 50000001, hi: null, label: 'Over $50M' },
  { lo: 1000001, hi: null, label: 'Over $1M', over: true },   // spouse / dependent assets
]);
const editDistance = (a, b) => {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
};
// OCR look-alikes inside an amount: O/D/o → 0, l/I/i/| → 1, S → 5 (a "$" read as S costs one edit).
const amountDigits = (s) => String(s || '').replace(/[ODoQ]/g, '0').replace(/[lIi|!]/g, '1').replace(/S/g, '5').replace(/\D/g, '');
export function amountOf(text) {
  const t = String(text || '');
  if (!/[\d$S]/.test(t)) return null;
  if (/over/i.test(t)) {
    const d = amountDigits(t.replace(/^.*over/i, ''));
    return d.startsWith('50') || d.length >= 8 ? BRACKETS[9] : d ? BRACKETS[10] : null;
  }
  const d = amountDigits(t);
  if (d.length < 4) return null;
  let best = null, bestD = Infinity;
  for (const b of BRACKETS) {
    if (b.hi == null) continue;
    const want = `${b.lo}${b.hi}`;
    const dist = editDistance(d, want);
    if (dist < bestD) { best = b; bestD = dist; }
  }
  return bestD <= Math.max(2, Math.floor(d.length / 4)) ? best : null;
}

// ── 3. ROWS ──────────────────────────────────────────────────────────────────
// A transaction line starts with its row number in the first cell. The last cells carry the type
// (Purchase / Sale / Exchange), the date, the >30-days flag (Yes / No) and the amount.
const sideOf = (s) => {
  const t = String(s || '');
  if (/xch|chang/i.test(t)) return 'Exchange';
  if (/p\W?u\W?r|urc|rch|ur[ce]h|chas|has[oe]|[ae]s[oe]\b/i.test(t)) return 'Buy';      // "lourchaso", "1purehaso", "louri:haso"
  if (/(^|[^a-z])[s5]\s?a\s?[l1It]|sal[eo]/i.test(t)) return 'Sell';                       // "salo", "sate"
  return null;
};
const dateOf = (s) => { const m = /(\d{1,2})\s*\/\s*(\d{1,2})/.exec(String(s || '').replace(/(\d)[lI|](?=\d)/g, '$1/')); return m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31 ? `${+m[1]}/${+m[2]}` : null; };
// Bonds: a coupon ("5.00 %") or a maturity ("Due Jun 1 2027"), as munis, Treasuries and notes carry.
export const isBond = (name) => /\d\s*\.?\s*\d*\s*%|\bdu[eo]\b|\bb\s*[/I1]\s*e\b|\btreas|\bt-?bill/i.test(String(name || ''));
export function rowsOf(lines) {
  const rows = [];
  for (const l of lines || []) {
    const c = l.cells || [];
    const m = /^(\d{1,4})$/.exec(c[0]?.t || '') || /^(\d{1,4})\s+(.+)$/.exec(c[0]?.t || '');
    if (!m || !c.length) continue;
    const rest = m[2] ? [{ x: c[0].x, t: m[2] }, ...c.slice(1)] : c.slice(1);
    if (!rest.length) continue;
    const named = (rest[0].x ?? 0) < NAME_END;
    const name = named ? rest[0].t.replace(/\s+/g, ' ').trim() : '(name unread)';
    if (named && !/[A-Za-z]{3}/.test(name)) continue;
    const tail = (named ? rest.slice(1) : rest).map(x => x.t).join(' | ');
    // The amount: from the first "$" / "S" + digit after the Yes / No flag (or the last cell).
    const flag = /\b(Y[eo]s|N[o0])\b/i.exec(tail);
    const amtText = flag ? tail.slice(flag.index + flag[0].length) : rest.at(-1)?.t || '';
    const before = flag ? tail.slice(0, flag.index) : tail;
    rows.push({ row: Number(m[1]), page: l.page, name, side: sideOf(before), date: dateOf(before), amount: amountOf(amtText), bond: isBond(name) });
  }
  // A row number seen twice (a wrapped line read again): keep the first with an amount.
  const seen = new Map();
  for (const r of rows) { const p = seen.get(r.row); if (!p || (!p.amount && r.amount)) seen.set(r.row, r); }
  return [...seen.values()].sort((a, b) => a.row - b.row);
}

// ── 4. TICKERS FROM SEC'S COMPANY NAMES ──────────────────────────────────────
// secMap: { TICKER: [cik, name] } (company_tickers.json, kept in KV by the DES page). Names are reduced
// to a compact key (suffixes like INC / CORP / CL A / HLDGS dropped); a filing name that matches one
// key, or is the start of keys that all belong to one company (the form truncates long names), gets
// that company's first ticker. Anything else gets no ticker: the name is shown as read.
const DROP = new Set(['INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'COS', 'LTD', 'LIMITED', 'PLC', 'LLC', 'LP', 'CL', 'CLASS',
  'HLDGS', 'HOLDINGS', 'HLDG', 'HOLDING', 'GROUP', 'GRP', 'THE', 'NEW', 'DEL', 'DE', 'COM', 'SHS', 'ORD', 'REIT', 'PAR', 'NON', 'VOTING',
  'ADR', 'SPONSORED', 'SPON', 'SA', 'NV', 'AG', 'SE', 'IRELAND', 'TR', 'TRUST', 'COMMON', 'STOCK', 'NPV']);
const SWAP = { INTERNATIONAL: 'INTL', INTERNATL: 'INTL', TECHNOLOGIES: 'TECHNOLOGIES', SVCS: 'SERVICES', SVC: 'SERVICES', INDS: 'INDUSTRIES',
  PPTYS: 'PROPERTIES', MFG: 'MANUFACTURING', PHARM: 'PHARMACEUTICALS', PHARMA: 'PHARMACEUTICALS', SYS: 'SYSTEMS', SOLUTIONS: 'SOLUTIONS', PTS: 'PARTS', ENTMT: 'ENTERTAINMENT' };
export function nameKey(name, { truncated = false } = {}) {
  let s = String(name || '')
    .replace(/([A-Z])l(?=[A-Z])/g, '$1T')          // OCR: STEPSlONE → STEPSTONE
    .replace(/(^|\s)l(?=[A-Z]{2})/g, '$1T')         // OCR: lYLER → TYLER
    .toUpperCase().replace(/\$\.?\d+/g, ' ').replace(/[.'’,]/g, '').replace(/&/g, ' AND ');
  let toks = s.split(/[^A-Z0-9]+/).filter(Boolean).map(t => SWAP[t] || t);
  // A last word cut short by the form ("TECHNOLOGIES IN") that starts a dropped suffix goes too.
  if (truncated && toks.length > 1) { const last = toks.at(-1); if (last.length <= 3 && [...DROP].some(d => d.startsWith(last) && d !== last)) toks = toks.slice(0, -1); }
  // A last word one OCR slip from a suffix ("Microsoft Coro", "Nvidia Core") goes too.
  if (toks.length > 1 && /^(COR[OEFP]?|C0RP|[1lI]NC|INC[.,]?)$/.test(toks.at(-1))) toks = toks.slice(0, -1);
  toks = toks.filter(t => !DROP.has(t));
  while (toks.length > 1 && /^[A-Z]$/.test(toks.at(-1))) toks = toks.slice(0, -1);   // "CL A", a trailing "F"
  const key = toks.join('');
  // Run-together words ("NETFLIXINC"): strip a glued suffix.
  return key.replace(/(INC|CORP|CO|LTD|PLC|HLDGS)$/, (m, _s, i) => (i >= 4 ? '' : m));
}
export function tickerIndex(secMap) {
  const byKey = new Map();
  for (const [t, v] of Object.entries(secMap || {})) {
    if (!Array.isArray(v) || !v[1]) continue;
    const k = nameKey(v[1]);
    if (k.length < 2) continue;
    const had = byKey.get(k);
    if (!had) byKey.set(k, { ticker: t, cik: v[0] });
    else if (had.cik !== v[0]) byKey.set(k, { ticker: null, cik: null });   // two companies, one name: no guess
  }
  // SEC's list runs roughly largest company first: its order breaks ties on the card (Nvidia before a small cap).
  const order = new Map(Object.keys(secMap || {}).map((t, i) => [t, i]));
  return { byKey, keys: [...byKey.keys()], tickers: new Set(Object.keys(secMap || {})), order };
}
export function guessTicker(name, idx) {
  if (!idx?.byKey?.size) return null;
  const k = nameKey(name, { truncated: true });
  if (k.length < 2) return null;
  const exact = idx.byKey.get(k);
  if (exact) return exact.ticker;   // null when two companies share the name
  if (k.length >= 6) {
    const hits = idx.keys.filter(x => x.startsWith(k)).map(x => idx.byKey.get(x));
    if (hits.length && hits[0].cik != null && hits.every(h => h.cik === hits[0].cik)) return hits[0].ticker;
  }
  // A short name that is itself a ticker ("IBM CORP", "FOX CORP CL A").
  if (k.length <= 4 && idx.tickers.has(k)) return k;
  // OCR slips ("NETFLLX", "PALANTLRTECHNOLOLES"): the one company within a few edits, if no other is as close.
  if (k.length >= 6) {
    const room = Math.floor(k.length / 5);
    let best = null, bestD = Infinity, tie = false;
    for (const x of idx.keys) {
      if (x[0] !== k[0] || x[1] !== k[1] || Math.abs(x.length - k.length) > room) continue;
      const d = editDistance(k, x);
      const h = idx.byKey.get(x);
      if (d < bestD) { best = h; bestD = d; tie = false; } else if (d === bestD && h.cik !== best?.cik) tie = true;
    }
    if (best?.ticker && bestD <= room && !tie) return best.ticker;
  }
  return null;
}

// ── 5. THE CARD'S SECTIONS ───────────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayWord = (md) => { if (!md) return null; const [m, d] = md.split('/').map(Number); return `${MONTHS[m - 1]} ${d}`; };
const rank = (r) => (r.amount ? BRACKETS.indexOf(r.amount) === 10 ? 6.5 : BRACKETS.indexOf(r.amount) : -1);
// An OCR'd date is shown only when its month fits the report (up to four months before it): "3I11no26"
// read as Mar 11 on an August trade is dropped rather than shown wrong.
const plausible = (md, through) => {
  if (!md || !through) return !!md;
  const m = Number(md.split('/')[0]), t = Number(String(through).slice(5, 7));
  return Number.isFinite(t) && t >= 1 ? (t - m + 12) % 12 <= 4 : true;
};
export function tradeLine(r, { watch, through } = {}) {
  const tk = r.ticker ? `**${r.ticker}${r.sure ? '' : '?'}** ` : '';   // sure: the filing itself names the ticker
  const name = r.ticker ? r.name : `**${r.name}**`;
  const bits = [`\`#${r.label ?? r.row}\` ${tk}${name}`.slice(0, 120), r.amount ? `**${r.amount.label}**` : 'amount unread', plausible(r.date, through) ? dayWord(r.date) : null];
  if (r.ticker && watch?.has?.(r.ticker)) bits.push('_watchlist_');
  if (r.side === 'Exchange') bits.push('exchange');
  // The same company's other rows on this side ride on its line, biggest first.
  if (r.more?.length) bits.push(`+${r.more.length} more: ${r.more.slice(0, 3).map(m => `#${m.label ?? m.row} ${m.amount?.label || '?'}`).join(', ')}${r.more.length > 3 ? ' …' : ''}`);
  return bits.filter(Boolean).join(' · ');
}
// One entry per company per side: the biggest row leads, the rest are listed on its line. Order: amount
// bracket, then a recognised company before an unrecognised name, then company size (SEC order), then row.
export function groupTrades(list, idx = null) {
  const byBig = (a, b) => rank(b) - rank(a) || a.row - b.row;
  const groups = new Map();
  for (const r of [...list].sort(byBig)) {
    const k = r.ticker ? `${r.side}:${r.ticker}` : `row:${r.row}`;
    const g = groups.get(k);
    if (g) g.more.push(r); else groups.set(k, { ...r, more: [] });
  }
  const size = (r) => (r.ticker ? idx?.order?.get(r.ticker) ?? 1e6 : 2e6);
  return [...groups.values()].sort((a, b) => rank(b) - rank(a) || size(a) - size(b) || a.row - b.row);
}
// The text block under the card's header: biggest stock / fund buys and sells, then the bonds in one line.
export const OGE_LIST = Object.freeze({ buys: 15, sells: 15 });
export function tradesBlock(rows, { idx = null, watch = null, limits = OGE_LIST, through = null } = {}) {
  const GAP = '\n\u200b';
  const stocks = rows.filter(r => !r.bond).map(r => ({ ...r, ticker: guessTicker(r.name, idx) }));
  const bonds = rows.filter(r => r.bond);
  const byBig = (a, b) => rank(b) - rank(a) || a.row - b.row;
  const buyRows = stocks.filter(r => r.side === 'Buy'), sellRows = stocks.filter(r => r.side === 'Sell' || r.side === 'Exchange');
  const buys = groupTrades(buyRows, idx), sells = groupTrades(sellRows, idx);
  const other = stocks.filter(r => !r.side);
  const parts = [`**${Number(rows.length).toLocaleString('en-US')} rows read** · ${Number(stocks.length).toLocaleString('en-US')} stocks & funds · ${bonds.length} bonds`,
    '_Machine-read from the scan: names, tickers (marked ?) and amounts can be off. The `#` is the row in the PDF._'];
  const section = (title, list, n, count) => {
    if (!list.length) return;
    const rest = list.slice(n);
    const more = rest.length ? `\n+${rest.length} more (${[...new Set(rest.map(r => r.amount?.label).filter(Boolean))].slice(0, 3).join(', ') || 'amounts unread'})` : '';
    parts.push(`${GAP}\n**${title}** (${count} rows)\n${list.slice(0, n).map(r => tradeLine(r, { watch, through })).join('\n')}${more}`);
  };
  section('Biggest buys', buys, limits.buys, buyRows.length);
  section('Biggest sells', sells, limits.sells, sellRows.length);
  if (other.length) parts.push(`${GAP}\n**Type unread** (${other.length}): ${other.slice(0, 5).map(r => `\`#${r.row}\` ${r.name}`).join(' · ')}${other.length > 5 ? ' …' : ''}`);
  if (bonds.length) {
    const top = bonds.filter(r => r.amount).sort(byBig);
    const best = top[0]?.amount;
    const at = best ? top.filter(r => r.amount === best) : [];
    parts.push(`${GAP}\n**Bonds** (${bonds.length}): munis and notes${best ? ` · biggest ${best.label} ×${at.length} (rows ${at.slice(0, 6).map(r => r.row).join(', ')}${at.length > 6 ? ' …' : ''})` : ''}`);
  }
  return { text: parts.join('\n'), stocks: stocks.length, bonds: bonds.length, rows: rows.length };
}

const n = (x) => Number(x).toLocaleString('en-US');
// ── 6. ANNUAL REPORTS (OGE 278e): HOLDINGS ───────────────────────────────────
// The annual report lists what the filer owns, part by part (2: employment assets and retirement
// accounts, 5: spouse's, 6: other assets), each row with a VALUE bracket. Rows are numbered "3.1." and
// the columns sit wherever that report's scan put them, so each page's header row ("# · Description ·
// EIF · Value · Income Type …") gives the x positions. Pages without a Value column (transactions,
// liabilities) are skipped.
const NUM_RE = /^[\dIl|]{1,4}(\.[\dIl|]{1,3})*\.?$/;
export function annualRows(lines) {
  const out = [];
  let head = null, page = 0, seq = 0;
  for (const l of lines || []) {
    if (l.page !== page) { page = l.page; }
    const c = l.cells || [];
    const t = c.map(x => x.t).join(' ');
    if (/^Part \d+:/.test(c[0]?.t || '')) { head = null; continue; }
    const desc = c.find(x => /^Description$/i.test(x.t)), val = c.find(x => /^Value$/i.test(x.t));
    if (desc && /\bType\b|\bValue\b|\bAmount\b/i.test(t)) {
      head = val ? { desc: desc.x, eif: c.find(x => /^EIF$/i.test(x.t))?.x ?? null, value: val.x,
        income: c.find(x => /^Income/i.test(x.t))?.x ?? Infinity } : null;
      continue;
    }
    if (!head) continue;
    const first = c[0];
    if (!first || first.x >= head.desc - 5) continue;                       // an account label, a wrapped line
    const valueFrom = (head.eif ?? head.value) - 8;
    const d = c.find(x => x.x >= head.desc - 8 && x.x < valueFrom);
    const vtext = c.filter(x => x.x >= valueFrom && x.x < head.income - 5).map(x => x.t).join(' ').replace(/^(Yes|No|N\/A|NIA|N\/\s?A)\b\s*/i, '');
    if (!d || !/[A-Za-z]{2}/.test(d.t)) continue;
    const num = NUM_RE.test(first.t) ? first.t.replace(/[Il|]/g, '1').replace(/\.$/, '') : '?';
    const none = /none|less than/i.test(vtext);
    const amount = none ? null : amountOf(vtext);
    if (!amount && !none) continue;                                         // a parent account with no value of its own
    out.push({ row: ++seq, label: num, page: l.page, name: d.t.replace(/\s+/g, ' ').trim(), amount, none, bond: isBond(d.t), side: 'Hold' });
  }
  return out;
}
// "SPY - SPDR S&P" (e-filed reports put the ticker first): that ticker, else the guess from SEC names.
// Cash, property, private funds, notes and coins are not listed companies: no guess for those.
const NOT_LISTED = /\b(bitcoin|ether(eum)?|crypto|cash|bank|savings|checking|account|real estate|promissory|note|loan|LP|L\.P\.|LLC|fund|portfolio|trust|annuity|insurance|IRA|401\(?k)\b/i;
const tickerOf = (name, idx) => {
  const t = /^([A-Z]{1,5}) - /.exec(name)?.[1];
  if (t) return { ticker: t, sure: true };
  return { ticker: NOT_LISTED.test(name) ? null : guessTicker(name, idx), sure: false };
};
export const OGE_HOLDINGS = Object.freeze({ listed: 15, other: 8 });
export function holdingsBlock(rows, { idx = null, limits = OGE_HOLDINGS } = {}) {
  const GAP = '\n\u200b';
  const valued = rows.filter(r => r.amount && !/^see (line|part|schedule|attach)/i.test(r.name));
  const stocks = valued.filter(r => !r.bond).map(r => ({ ...r, ...tickerOf(r.name, idx) }));
  const bonds = valued.filter(r => r.bond);
  // Listed companies and funds first (what moves with the market), then the private side: companies,
  // property, cash, notes.
  const listed = groupTrades(stocks.filter(r => r.ticker), idx), other = groupTrades(stocks.filter(r => !r.ticker), idx);
  const under = rows.filter(r => r.none).length;
  const parts = [`**${n(rows.length)} holdings read** · ${n(stocks.filter(r => r.ticker).length)} listed · ${n(stocks.filter(r => !r.ticker).length)} private, cash & other · ${n(bonds.length)} bonds${under ? ` · ${n(under)} under $1K` : ''}`,
    '_Machine-read from the scan: names, tickers (? = guessed) and values can be off. The `#` is the line in the PDF. Values are ranges as filed._'];
  const section = (title, list, n) => {
    if (!list.length) return;
    const rest = list.slice(n);
    parts.push(`${GAP}\n**${title}**\n${list.slice(0, n).map(r => tradeLine(r)).join('\n')}${rest.length ? `\n+${n(rest.length)} more (${[...new Set(rest.map(r => r.amount?.label))].slice(0, 3).join(', ')})` : ''}`);
  };
  section('Biggest listed stocks & funds', listed, limits.listed);
  section('Biggest private holdings, property & cash', other, limits.other);
  if (bonds.length) {
    const top = [...bonds].sort((a, b) => rank(b) - rank(a) || a.row - b.row);
    const best = top[0].amount, at = top.filter(r => r.amount === best);
    parts.push(`${GAP}\n**Bonds** (${bonds.length}): munis and notes · biggest ${best.label} ×${at.length} (lines ${at.slice(0, 6).map(r => r.label).join(', ')}${at.length > 6 ? ' …' : ''})`);
  }
  return { text: parts.join('\n'), rows: rows.length, stocks: stocks.length, bonds: bonds.length };
}
