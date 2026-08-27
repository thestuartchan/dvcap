// lib/flex.js — IBKR Flex Web Service: read the broker's own position list and reconcile it
// against the console.
//
// WHY FLEX AND NOT THE TRADING API. The Client Portal and TWS APIs need a session that a human
// authenticates and that expires; neither survives on a cron. Flex is a token in a query string
// against a saved report, which is the only shape of IBKR access a scheduled function can actually
// hold. The cost is that it is a REPORT, not a feed: it answers with yesterday's close-of-business
// state (or intraday, depending on how the query is saved), so this is a daily reconciliation, not
// a live sync. That is the right granularity for a book measured in weeks.
//
// TWO STEPS, always:
//   1. SendRequest?t=TOKEN&q=QUERY&v=3   → a reference code, or an error code
//   2. GetStatement?q=REF&t=TOKEN&v=3    → the XML, or 1019 "generation in progress" → wait, retry
//
// WHAT IT IS ALLOWED TO DO. Auto-add SHARES and FUTURES it finds and the console lacks; report
// everything else. Options and cash equivalents are deliberately outside the console's card scope
// (lib/tradecard.js), so auto-adding them would re-create a row that the card then hides, every
// single day. And it NEVER deletes: a console row missing from the broker is reported, because the
// honest reading of "IBKR does not have this" is ambiguous — it may be closed, it may be held
// elsewhere, and a sync that silently drops positions is one bad report away from erasing the book.
//
// TRUST. The statement is the broker's own record and outranks the console on quantity and cost
// basis — but only as a REPORT. Nothing here writes; api/flex-sync.js decides what to apply.

const V = 3;
const BASE = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';

export const flexConfigured = () => !!(String(process.env.IBKR_FLEX_TOKEN || '').trim() &&
                                       String(process.env.IBKR_FLEX_QUERY_ID || '').trim());

export const flexEnv = () => ({
  token: String(process.env.IBKR_FLEX_TOKEN || '').trim(),
  queryId: String(process.env.IBKR_FLEX_QUERY_ID || '').trim(),
});

export const sendRequestUrl = (token, queryId) =>
  `${BASE}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=${V}`;

// The statement URL comes back IN the response rather than being assumed, because IBKR has moved it
// before. Fall back to the documented path only if the response omits it.
export const statementUrl = (url, ref, token) =>
  `${url || `${BASE}/GetStatement`}?q=${encodeURIComponent(ref)}&t=${encodeURIComponent(token)}&v=${V}`;

// ── XML ───────────────────────────────────────────────────────────────────────
// A hand-rolled reader rather than a parser dependency. The statement is machine-generated,
// attribute-only and shallow: every field this needs is an attribute on a self-closing element.
// package.json carries three runtime dependencies and this is not worth being the fourth.
const unescape = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&');   // last, so &amp;lt; does not become <

export function attrs(tag) {
  const out = {};
  for (const m of String(tag).matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = unescape(m[2]);
  return out;
}

// Every <Name .../> or <Name ...> in the document, as attribute maps.
export function elements(xml, name) {
  const re = new RegExp(`<${name}\\b([^>]*?)/?>`, 'g');
  return [...String(xml || '').matchAll(re)].map(m => attrs(m[0]));
}

export function textOf(xml, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(String(xml || ''));
  return m ? unescape(m[1]).trim() : null;
}

// The SendRequest / GetStatement envelope. IBKR answers errors with HTTP 200 and an XML body, so
// "it did not throw" says nothing — the status has to be read.
export function parseFlexResponse(xml) {
  const s = String(xml || '');
  const status = textOf(s, 'Status');
  const code = textOf(s, 'ErrorCode') ?? textOf(s, 'code');
  const message = textOf(s, 'ErrorMessage') ?? textOf(s, 'message');
  return {
    ok: status === 'Success' && !code,
    status: status || (code ? 'Fail' : null),
    referenceCode: textOf(s, 'ReferenceCode'),
    url: textOf(s, 'Url'),
    errorCode: code ? String(code) : null,
    errorMessage: message || null,
    // 1019 is "your report is still being generated" — the one error that means "ask again".
    retryable: String(code) === '1019',
  };
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// IBKR stamps dates as 20260805, or 20260805;123000 with a time, or 2026-08-05 depending on the
// query's date format. All three mean the same day.
export function isoDate(v) {
  const s = String(v || '').trim().split(/[;\s]/)[0];
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

// ── Asset classes ─────────────────────────────────────────────────────────────
// Flex's assetCategory, mapped to what the console does with it. FOP (options on futures) is an
// option: it expires, so it is a trade, not a hold — the same distinction the card draws.
export const CASH_EQUIVALENTS = new Set(['USFR', 'SGOV', 'BIL', 'SHV', 'TFLO', 'GBIL', 'XBIL', 'TBIL', 'CLIP', 'JPST', 'MINT', 'ICSH', 'BOXX']);

export function classOf(pos) {
  const cat = String(pos?.assetCategory || '').toUpperCase();
  if (cat === 'OPT' || cat === 'FOP') return 'option';
  if (cat === 'FUT') return 'futures';
  if (cat === 'CASH' || cat === 'CFD') return 'other';
  if (cat === 'STK' || cat === 'FUND' || cat === 'ETF') {
    return CASH_EQUIVALENTS.has(rootOf(pos)) ? 'cash' : 'shares';
  }
  return 'other';
}

// The console auto-adds only what its card would show. Everything else is reported.
export const autoAddable = (pos) => classOf(pos) === 'shares' || classOf(pos) === 'futures';

// ── Symbols ───────────────────────────────────────────────────────────────────
// The two sides name things differently and matching on the raw string fails on both classes that
// matter. Futures: IBKR says MGCZ6, the console says MGC. Hong Kong: IBKR says 0981, the console
// says 0981.HK so the quote feed can find it. Both reduce to the same root.
//
// underlyingSymbol is preferred where Flex supplies it, because stripping a month code by pattern
// is a guess and the field is the answer.
const MONTH_CODES = 'FGHJKMNQUVXZ';
export function rootOf(pos) {
  if (typeof pos === 'string') pos = { symbol: pos };
  const under = String(pos?.underlyingSymbol || '').trim().toUpperCase();
  if (under) return under.split('.')[0];
  const sym = String(pos?.symbol || '').trim().toUpperCase().split('.')[0];
  if (String(pos?.assetCategory || '').toUpperCase() === 'FUT') {
    // MGCZ6 / MNQU26 → MGC / MNQ. Only strips a MONTH+year tail, so a stock ending in a month
    // letter (e.g. "Z") is untouched.
    const m = /^([A-Z0-9]{1,5}?)([FGHJKMNQUVXZ])(\d{1,2})$/.exec(sym);
    if (m && MONTH_CODES.includes(m[2])) return m[1];
  }
  return sym;
}

// ── The statement ─────────────────────────────────────────────────────────────
export function parseStatement(xml) {
  const s = String(xml || '');
  const stmt = elements(s, 'FlexStatement')[0] || {};
  const positions = elements(s, 'OpenPosition')
    // A query can be saved with lot-level detail, which repeats each position once per lot on top
    // of the summary row. Keep SUMMARY when the field is present, so quantities are not doubled.
    .filter(p => !p.levelOfDetail || String(p.levelOfDetail).toUpperCase() === 'SUMMARY')
    .map(p => ({
      symbol: String(p.symbol || '').toUpperCase(),
      root: rootOf(p),
      description: p.description || null,
      assetCategory: String(p.assetCategory || '').toUpperCase(),
      currency: String(p.currency || '').toUpperCase() || null,
      qty: num(p.position),
      multiplier: num(p.multiplier) || 1,
      costBasisPrice: num(p.costBasisPrice),
      costBasisMoney: num(p.costBasisMoney),
      markPrice: num(p.markPrice),
      openDate: isoDate(p.holdingPeriodDateTime || p.openDateTime),
      expiry: p.expiry || null,
      conid: p.conid || null,
    }))
    .filter(p => p.qty != null && p.qty !== 0);
  return {
    accountId: stmt.accountId || null,
    fromDate: stmt.fromDate || null,
    toDate: stmt.toDate || null,
    positions,
  };
}

// ── Reconciliation ────────────────────────────────────────────────────────────
// Tolerances. A quantity must agree exactly — a share is a share, and 30 vs 29 is a fill the
// console never recorded. Cost basis is allowed to drift a little, because the two sides compute it
// differently at the edges (IBKR reports position average cost on an average-cost basis and
// per-trade realised P&L on FIFO; the console is average-cost throughout) and because commissions
// land in it at different precisions.
export const COST_TOLERANCE_PCT = 0.5;

const near = (a, b, pct = COST_TOLERANCE_PCT) =>
  a == null || b == null ? false : Math.abs(a - b) <= Math.abs(b) * (pct / 100) + 1e-9;

// `openRows` are console rows with `derived` already computed (qty, avgCost). Matching is by ROOT
// among rows that are still open. Two open rows sharing a root is not resolvable from a statement
// that does not know about the console's split, so it is reported rather than guessed at.
export function reconcile(openRows = [], positions = [], { today = new Date().toISOString().slice(0, 10), asOf = null } = {}) {
  const byRoot = new Map();
  for (const r of openRows) {
    const k = rootOf({ symbol: r.symbol, assetCategory: r.margined ? 'FUT' : 'STK', underlyingSymbol: r.flexRoot });
    byRoot.set(k, [...(byRoot.get(k) || []), r]);
  }
  const seen = new Set();
  const agree = [], differs = [], ambiguous = [], adds = [], report = [];

  for (const p of positions) {
    const rows = byRoot.get(p.root) || [];
    seen.add(p.root);
    if (rows.length > 1) { ambiguous.push({ root: p.root, rowIds: rows.map(r => r.id), reason: 'two open console rows share this symbol — matched none' }); continue; }
    if (!rows.length) {
      const kind = classOf(p);
      if (autoAddable(p)) adds.push(rowFromPosition(p, { today, asOf }));
      else report.push({ kind: 'unmatched', root: p.root, assetClass: kind, qty: p.qty, note: kind === 'option' ? 'options are outside the console\'s scope — add it by hand if you want it tracked' : 'not auto-added' });
      continue;
    }
    const r = rows[0];
    const qty = r.derived?.qty ?? null;
    const avg = r.derived?.avgCost ?? null;
    const qtyOk = qty != null && Math.abs(qty - Math.abs(p.qty)) < 1e-6;
    const costOk = near(avg, p.costBasisPrice);
    if (qtyOk && costOk) { agree.push({ id: r.id, root: p.root, qty }); continue; }
    differs.push({
      id: r.id, root: p.root,
      qty: qtyOk ? null : { console: qty, ibkr: Math.abs(p.qty) },
      avg: costOk ? null : { console: avg, ibkr: p.costBasisPrice },
    });
  }

  // Open in the console, absent from the statement. Reported, never removed.
  for (const [root, rows] of byRoot) {
    if (seen.has(root)) continue;
    for (const r of rows) report.push({ kind: 'missing-at-broker', root, id: r.id, qty: r.derived?.qty ?? null, note: 'open here, not in the statement — closed at the broker, held elsewhere, or outside the query\'s scope' });
  }
  return { agree, differs, ambiguous, adds, report };
}

// A statement row is a POSITION, not a history: it knows what is held and at what average, not the
// fills that got there. So the synthetic row carries one fill at the broker's own average cost,
// which is exactly what the console needs to compute everything else, and says so in the note.
export function rowFromPosition(p, { today = new Date().toISOString().slice(0, 10), asOf = null } = {}) {
  const stamp = asOf || today;
  const futures = classOf(p) === 'futures';
  const hk = /^\d{4,5}$/.test(p.root) && p.currency === 'HKD';
  return {
    id: `${p.root}-flex-${(p.conid || p.symbol || '').toString().slice(0, 12)}`,
    symbol: hk ? `${p.root}.HK` : p.root,
    currency: p.currency || 'USD',
    multiplier: p.multiplier || 1,
    margined: futures,
    trade: futures && p.expiry ? `${p.expiry.slice(0, 6)} futures` : '',
    thesis: `Added from the IBKR statement of ${stamp}. One fill at the broker's average cost — a statement reports a position, not the fills behind it, so the entry history is flat by construction. Edit it if the detail matters.`,
    levels: [],
    tags: ['new', 'flex'],
    fills: [{ id: 'f0', side: 'buy', qty: Math.abs(p.qty), price: p.costBasisPrice, date: p.openDate || stamp, note: 'IBKR position average cost' }],
  };
}

// A one-screen summary for the endpoint's answer and for the Discord note. Counts and symbols only
// — no quantity, no cost basis, nothing that would put a size in a channel.
export function summarise(rec) {
  const bits = [];
  if (rec.adds.length) bits.push(`added ${rec.adds.map(r => r.symbol).join(', ')}`);
  if (rec.differs.length) bits.push(`${rec.differs.length} disagree${rec.differs.length === 1 ? 's' : ''} with the statement (${rec.differs.map(d => d.root).join(', ')})`);
  if (rec.ambiguous.length) bits.push(`${rec.ambiguous.length} ambiguous`);
  const missing = rec.report.filter(r => r.kind === 'missing-at-broker');
  if (missing.length) bits.push(`${missing.length} open here but not at the broker (${missing.map(m => m.root).join(', ')})`);
  const unmatched = rec.report.filter(r => r.kind === 'unmatched');
  if (unmatched.length) bits.push(`${unmatched.length} not auto-added (${unmatched.map(m => `${m.root} ${m.assetClass}`).join(', ')})`);
  return bits.length ? bits.join(' · ') : `all ${rec.agree.length} positions reconcile`;
}

// ── Fetch ─────────────────────────────────────────────────────────────────────
// Two hops with a wait between them, because step 2 usually answers 1019 the first time. The delay
// is injectable so tests do not sleep.
export async function fetchStatement({ token, queryId, fetchImpl = fetch, sleep = (ms) => new Promise(r => setTimeout(r, ms)), attempts = 5, waitMs = 3000 } = {}) {
  if (!token || !queryId) return { ok: false, error: 'IBKR_FLEX_TOKEN / IBKR_FLEX_QUERY_ID not set' };
  const send = await fetchImpl(sendRequestUrl(token, queryId));
  if (!send.ok) return { ok: false, error: `SendRequest HTTP ${send.status}` };
  const first = parseFlexResponse(await send.text());
  if (!first.ok || !first.referenceCode) {
    return { ok: false, error: `SendRequest ${first.errorCode || first.status || 'failed'}${first.errorMessage ? `: ${first.errorMessage}` : ''}` };
  }
  const url = statementUrl(first.url, first.referenceCode, token);
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(waitMs);
    const r = await fetchImpl(url);
    if (!r.ok) return { ok: false, error: `GetStatement HTTP ${r.status}` };
    const xml = await r.text();
    const env = parseFlexResponse(xml);
    if (env.retryable) continue;
    if (env.errorCode) return { ok: false, error: `GetStatement ${env.errorCode}${env.errorMessage ? `: ${env.errorMessage}` : ''}` };
    if (!/<OpenPosition\b/.test(xml) && !/<FlexStatement\b/.test(xml)) return { ok: false, error: 'statement had no positions section — check the query includes Open Positions' };
    return { ok: true, xml, statement: parseStatement(xml) };
  }
  return { ok: false, error: `statement still generating after ${attempts} attempts` };
}
