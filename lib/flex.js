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
// IBKR has moved this host before (gdcdyn → ndcdyn), and a hard-coded base that goes stale looks
// exactly like a bad token from the outside. IBKR_FLEX_BASE overrides it without a deploy.
const DEFAULT_BASE = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
const base = () => String(process.env.IBKR_FLEX_BASE || '').trim().replace(/\/$/, '') || DEFAULT_BASE;

export const flexConfigured = () => !!(String(process.env.IBKR_FLEX_TOKEN || '').trim() &&
                                       String(process.env.IBKR_FLEX_QUERY_ID || '').trim());

export const flexEnv = () => ({
  token: String(process.env.IBKR_FLEX_TOKEN || '').trim(),
  queryId: String(process.env.IBKR_FLEX_QUERY_ID || '').trim(),
});

export const sendRequestUrl = (token, queryId) =>
  `${base()}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=${V}`;

// The statement URL comes back IN the response rather than being assumed, because IBKR has moved it
// before. Fall back to the documented path only if the response omits it.
export const statementUrl = (url, ref, token) =>
  `${url || `${base()}/GetStatement`}?q=${encodeURIComponent(ref)}&t=${encodeURIComponent(token)}&v=${V}`;

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
      // Flex names this `position`; some query templates emit `quantity`. Reading only one of them
      // yields a book of zero positions and no error at all, so both are accepted.
      qty: num(p.position ?? p.quantity),
      // `|| 1` here was a 10x money error waiting on a statement that omits the field. On a
      // margined instrument 1 is not a neutral default — see lib/futures.js. The broker's own
      // figure still wins where it sends one; the table only fills a gap, and a contract in
      // neither is left NULL so it is set by hand rather than computed wrongly.
      ...(() => {
        const m = multiplierFor(p.symbol, { stated: num(p.multiplier),
          margined: /^FUT$/i.test(String(p.assetCategory || '')), assetCategory: p.assetCategory });
        return { multiplier: m.multiplier, multiplierSource: m.source, ...(m.disagrees ? { multiplierDisagrees: m.disagrees } : {}) };
      })(),
      costBasisPrice: num(p.costBasisPrice),
      costBasisMoney: num(p.costBasisMoney),
      markPrice: num(p.markPrice),
      openDate: isoDate(p.holdingPeriodDateTime || p.openDateTime || p.reportDate),
      expiry: p.expiry || null,
      // An option's contract, where Flex serves it as fields (optionContractOf falls back to the
      // OCC symbol when it does not).
      strike: num(p.strike),
      putCall: p.putCall ? String(p.putCall).toUpperCase().slice(0, 1) : null,
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

// MATCH KEY. Two more ways the same instrument gets two names. IBKR reports SMIC as `981`; the
// console calls it `0981.HK`, because the quote feed needs the padded form. Stripping the suffix is
// not enough — `0981` and `981` are still different strings, and the first live run duly announced
// the position as missing at the broker AND queued a duplicate row to add beside it. Numeric roots
// are therefore compared without leading zeros.
export const matchKey = (root) => /^\d+$/.test(root) ? String(Number(root)) : root;

// ── ONE ROOT, TWO LISTINGS ───────────────────────────────────────────────────
// ASML trades on Nasdaq in dollars and on Euronext Amsterdam in euros, and IBKR reports both with
// symbol `ASML`. The console distinguishes them the only way it can — `ASML` versus `ASML.AS` —
// and rootOf() then strips the suffix, so both sides collapsed to the root `ASML`: two console
// rows shared one key, and on the statement side a Map keyed by root kept whichever listing came
// second and lost the first. The currency is the fact that separates them and it was being parsed
// on both sides and then thrown away.
//
// A key is a root AND a currency. Console rows default to USD (every path that creates one sets
// it), statement positions and trades carry IBKR's own, so the two agree wherever they agreed
// before and stop colliding where they did not.
export const instrumentKey = (root, currency) => `${matchKey(root)}|${String(currency || 'USD').toUpperCase()}`;
export const keyRoot = (key) => String(key || '').split('|')[0];

const consoleRoot = (r) => rootOf({ symbol: r.symbol, assetCategory: r.margined ? 'FUT' : 'STK', underlyingSymbol: r.flexRoot });
const consoleKey = (r) => instrumentKey(consoleRoot(r), r.currency);

// `rows` are console rows with `derived` already computed. Open rows are matched; CLOSED ones are
// still needed, because a statement is a report about a past day and the console has kept trading
// since — see the stale-statement handling below.
//
// IMPORTANT: reconcile against the UNADJUSTED cost basis. A rolled position's `avgCost` is
// back-adjusted through the legs behind it (applyRolls in lib/positions.js), which is the right
// number for a card and the wrong one here — the broker reports the contract, not the trade, so an
// adjusted entry would disagree with every statement for ever. api/flex-sync.js deliberately does
// not call applyRolls, and this reads `unadjustedAvgCost` if it is ever handed rows that did.
//
// Matching is by root among rows that are still open. Two open rows sharing a root is not
// resolvable from a statement that does not know about the console's split, so it is reported
// rather than guessed at.
// ── THE ROW AS THE STATEMENT'S DAY SAW IT ────────────────────────────────────
// A statement is a report about ONE past day, and the console keeps trading after it is cut. The
// two existing since-the-statement kinds cover a row that opened or closed in the gap; they do not
// cover the far more common case of a row merely REDUCED — or added to — in it.
//
// ASTX on 2026-09-02: bought 500 @ 9.20 on 09-01, sold 400 @ 10.60 on 09-02, 100 left. The 09-01
// statement correctly says 500 and the console correctly says 100, and the reconciler called that
// a disagreement — the loudest verdict it has, for two sources that are both right.
//
// NOT AN INVERSION. The first version undid the later fills arithmetically, which worked for
// quantity and quietly did not for cost: under average-cost accounting a SELL leaves the average
// untouched, so ASTX passed, while a BUY after the statement moves it and there is no term to
// subtract. Measured: buy 500 @ 9.20 then 100 @ 12.00 gives 9.67 against the statement's 9.20, and
// the batch was still discarded on a cost basis nobody disagreed about.
//
// So the fills are TRUNCATED to the statement's date and the position re-derived from them. That
// is exact in both fields by construction, reuses the same derivation the console itself runs
// rather than a second implementation of it, and cannot drift from it.
//
// `derive` is the caller's row -> derived function, so this stays free of a positions.js import and
import { multiplierFor } from './futures.js';
import { isDerivativeRow, legsOf, underlyingOf, legKey } from './instruments.js';
import { contractKey, parseOptionSymbol } from './bookExposure.js';
// both call sites use the deriver they already have.
export function asOfState(row, asOf, derive) {
  if (!asOf || typeof derive !== 'function') return null;
  const fills = Array.isArray(row?.fills) ? row.fills : (row?.derived?.fills || []);
  const after = fills.filter(f => f?.date && f.date > asOf);
  if (!after.length) return null;            // nothing moved — the live row IS the as-of row
  const d = derive({ ...row, fills: fills.filter(f => !(f?.date && f.date > asOf)) });
  if (!d) return null;
  return { qty: d.qty ?? null, avgCost: d.unadjustedAvgCost ?? d.avgCost ?? null, moved: after.length };
}

// ── OPTIONS, MATCHED BY CONTRACT ─────────────────────────────────────────────
// Options were reported as outside the console's scope, and were — until the console learned to
// hold options and spreads (lib/instruments.js). Now a statement option line is matched against
// the console's legs, CONTRACT BY CONTRACT: a SOFI Nov20 17/20 call vertical is one console row and
// two statement lines (+15 of the 17C, −15 of the 20C), so every console row is expanded into its
// legs, signed by leg side and row direction, summed per contract, and compared with the
// statement's signed position. The share row on the same underlying is never involved.
//
// DAY TRADES ARE LEFT OUT. A contract opened at 0 or 1 day to expiry is a day trade (the console's
// scope is swing and long holds), so it is named and set aside rather than matched or announced.
// DTE is measured from the day it was opened where the statement says so, else the statement's own
// day. Rows are compared AS OF the statement's day (asOfState), so a spread opened or closed since
// is not a disagreement.
export const DAYTRADE_MAX_DTE = 1;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
export function optionContractOf(p) {
  const exp = isoDate(p?.expiry);
  if (p?.strike > 0 && (p.putCall === 'C' || p.putCall === 'P') && exp) {
    return { root: String(p.root || '').toUpperCase(), expiry: exp, type: p.putCall === 'P' ? 'put' : 'call', strike: +p.strike };
  }
  const o = parseOptionSymbol(p?.symbol);
  return o ? { root: String(p?.root || o.root).toUpperCase(), expiry: o.expiry, type: o.type, strike: o.strike } : null;
}
export const contractLabel = (c) => `${c.root} ${c.expiry} ${c.strike}${c.type === 'put' ? 'P' : 'C'}`;
export function isDayTradeOption(c, { openDate = null, asOf = null } = {}) {
  const from = isoDate(openDate) || isoDate(asOf);
  if (!c?.expiry || !from) return false;
  return daysBetween(from, c.expiry) <= DAYTRADE_MAX_DTE;
}

export function reconcile(rows = [], positions = [], { today = new Date().toISOString().slice(0, 10), asOf = null, derive = null } = {}) {
  // A SETUP IS NOT A POSITION. status is 'setup' only when a row has no fills at all — nothing is
  // held, so there is nothing for a broker to disagree about. Filtering on `!== 'closed'` swept
  // them in and reported NVDA and DBA, both watchlist rows with no fills, as "open here but not at
  // the broker" — which is true of every setup that will ever exist and so tells nobody anything.
  // Option and spread rows are matched by contract below, never by their underlying's symbol: a
  // SOFI spread row keyed as SOFI made the SOFI share row "ambiguous".
  const openRows = rows.filter(r => r?.derived?.status === 'open' && !isDerivativeRow(r));
  const closedRows = rows.filter(r => r?.derived?.status === 'closed' && !isDerivativeRow(r));
  const byRoot = new Map();
  for (const r of openRows) {
    const k = consoleKey(r);
    byRoot.set(k, [...(byRoot.get(k) || []), r]);
  }
  // Root-only index, kept ONLY to name a currency mismatch. A console row left on USD for an HKD
  // stock used to match on root alone; under the full key it would silently fail to match and the
  // position would be auto-added as a duplicate beside it. Reported instead, never guessed.
  const byRootOnly = new Map();
  for (const r of openRows) {
    const k = matchKey(consoleRoot(r));
    byRootOnly.set(k, [...(byRootOnly.get(k) || []), r]);
  }
  // What the console has FINISHED since the statement was cut. A "Last Business Day" report still
  // holds yesterday's positions, so a trade closed this morning looks exactly like a position the
  // console forgot to record — and auto-adding it resurrects a trade you have just exited.
  const closedSince = new Map();
  for (const r of closedRows) {
    const end = r.derived?.lastDate;
    if (!asOf || !end || end < asOf) continue;
    const k = consoleKey(r);
    closedSince.set(k, [...(closedSince.get(k) || []), r]);
  }
  const seen = new Set();
  // Rows already named in a currency-mismatch report. Their key was never `seen` (the statement
  // carries the other currency), so the missing-at-broker pass below would name them a second
  // time as absent — one row, two verdicts, and the second one wrong.
  const namedInMismatch = new Set();
  const agree = [], differs = [], ambiguous = [], adds = [], report = [];
  const optionLines = [];

  for (const p of positions) {
    // ── AN OPTION IS NOT ITS UNDERLYING ──
    // An option position's root is the underlying's symbol, so an INTC call line (6 contracts)
    // keyed the same as the INTC share row (30 shares) and was reported as a quantity
    // disagreement against it — "console 30, statement 6: a fill is missing" — over a position
    // the console does not track at all. Options are outside the console's scope (the trade
    // planner already skips them); they are reported, and never matched against a share row.
    if (classOf(p) === 'option') { optionLines.push(p); continue; }
    const key = instrumentKey(p.root, p.currency);
    const rows2 = byRoot.get(key) || [];
    seen.add(key);
    if (rows2.length > 1) { ambiguous.push({ root: p.root, currency: p.currency || 'USD', rowIds: rows2.map(r => r.id), reason: 'two open console rows share this symbol and currency — matched none' }); continue; }
    if (!rows2.length) {
      const kind = classOf(p);
      const done = closedSince.get(key) || [];
      // SAME ROOT, DIFFERENT CURRENCY. Either a second listing the console does not hold, or a row
      // whose currency was left wrong — and only a person can tell which, so it is neither matched
      // nor added. The candidates are named so the fix is one field away.
      const sameRoot = (byRootOnly.get(matchKey(p.root)) || []).filter(r => !rows2.includes(r));
      if (sameRoot.length && !done.length) {
        for (const r of sameRoot) namedInMismatch.add(r.id);
        report.push({ kind: 'currency-mismatch', root: p.root, currency: p.currency || 'USD', qty: p.qty,
          rowIds: sameRoot.map(r => r.id), rowCurrencies: sameRoot.map(r => r.currency || 'USD'),
          note: `the statement holds ${p.root} in ${p.currency || 'USD'}; the console holds it in ${[...new Set(sameRoot.map(r => r.currency || 'USD'))].join('/')} — a second listing, or a row whose currency is wrong. Not matched and not added.` });
        continue;
      }
      if (done.length) {
        report.push({ kind: 'closed-since-statement', root: p.root, ids: done.map(r => r.id), closedOn: done[0].derived?.lastDate,
          note: `the statement is from ${asOf} and this was closed on ${done[0].derived?.lastDate} — nothing to add` });
      } else if (autoAddable(p)) adds.push(rowFromPosition(p, { today, asOf }));
      else report.push({ kind: 'unmatched', root: p.root, assetClass: kind, qty: p.qty, note: kind === 'option' ? 'options are outside the console\'s scope — add it by hand if you want it tracked' : 'not auto-added' });
      continue;
    }
    const r = rows2[0];
    const qty = r.derived?.qty ?? null;
    const avg = r.derived?.unadjustedAvgCost ?? r.derived?.avgCost ?? null;
    const qtyOk = qty != null && Math.abs(qty - Math.abs(p.qty)) < 1e-6;
    // A KNOWN divergence, acknowledged once. IBKR reports position average cost on an average-cost
    // basis but a partially-exited position on the lot basis it actually matched, so ARM sits at
    // 409.26 there and 331.56 here and always will. Recording the broker's number as `costBasisAck`
    // says "I have seen this and it is expected" — and because the check is against that exact
    // number rather than a mute switch, the day IBKR reports something else it is reported again.
    const acked = Number(r.costBasisAck);
    const costOk = near(avg, p.costBasisPrice) || (Number.isFinite(acked) && near(acked, p.costBasisPrice, 0.01));
    if (qtyOk && costOk) { agree.push({ id: r.id, root: p.root, qty, ...(Number.isFinite(acked) && !near(avg, p.costBasisPrice) ? { acknowledged: true } : {}) }); continue; }
    // Reduced (or added to) since the statement was cut. Checked BEFORE the disagreement is
    // recorded, because it is a different finding: the row and the statement agree about the day
    // the statement describes, and the next one will show the new size. Reported like the other
    // two since-the-statement kinds, which means it is deliberately not `actionable`.
    const back = asOfState(r, asOf, derive);
    // BOTH fields, not just the quantity. "We agree about the day the statement describes" is only
    // true if the cost basis agrees about it too, and re-deriving gives that for free.
    if (back && !(qtyOk && costOk)
        && back.qty != null && Math.abs(back.qty - Math.abs(p.qty)) < 1e-6
        && near(back.avgCost, p.costBasisPrice)) {
      report.push({ kind: 'changed-since-statement', root: p.root, id: r.id,
        qty: { console: qty, ibkr: Math.abs(p.qty), asOf: back.qty },
        avg: { console: avg, ibkr: p.costBasisPrice, asOf: back.avgCost },
        note: `the statement of ${asOf} holds ${Math.abs(p.qty)} @ ${p.costBasisPrice}; ${back.moved} fill${back.moved === 1 ? '' : 's'} since then leave ${qty} @ ${avg}, and the row re-derived to ${asOf} is exactly the statement's figures — they agree about ${asOf}` });
      continue;
    }
    differs.push({
      id: r.id, root: p.root,
      // Where the row moved after the statement, the as-of figure is attached to BOTH fields: it
      // was tried and did not reconcile, which makes this a stronger finding than a bare mismatch
      // rather than a weaker one, so it is said out loud rather than dropped.
      qty: qtyOk ? null : { console: qty, ibkr: Math.abs(p.qty), ...(back ? { asOf: back.qty } : {}) },
      avg: costOk ? null : { console: avg, ibkr: p.costBasisPrice, ...(back ? { asOf: back.avgCost } : {}) },
      // Both cost bases, ALWAYS — `avg` above is null when they agree, and the reconciling fill
      // for a quantity gap needs the figures whether or not they agree.
      basis: { console: avg, ibkr: p.costBasisPrice, agree: costOk },
      ...(costOk || !(r.derived?.sold > 0) ? {} : { note: 'this position has been partly exited, so the console (average cost) and IBKR (the lots it actually matched) will not agree — set costBasisAck to the IBKR figure to accept it' }),
    });
  }

  // ── A CONTRACT SIZE NOBODY KNOWS ──
  // Money-valued output on a margined row with no multiplier is wrong by whatever the real contract
  // size is, and looks exactly as confident as a correct one — MGC posted −$242.00 against a true
  // −$2,420.00 for a whole month. So it is named rather than defaulted.
  for (const r of openRows) {
    if (!r.margined) continue;
    const m = Number(r.multiplier);
    if (Number.isFinite(m) && m > 0) continue;
    report.push({ kind: 'multiplier-unknown', root: consoleRoot(r), id: r.id,
      note: 'a margined row with no contract multiplier — every money figure on it is computed at x1, which for a futures contract is not a default but a specific wrong answer. Set it on the row; lib/futures.js carries the standard sizes.' });
  }

  // ── THE OPTION BOOK ──
  // What the console held in each contract on the statement's day.
  const expected = new Map();
  for (const r of rows) {
    if (!isDerivativeRow(r)) continue;
    const st = r?.derived?.status;
    if (st !== 'open' && st !== 'closed') continue;
    const back = asOfState(r, asOf, derive);
    const q = back ? (back.qty ?? 0) : (st === 'open' ? (r.derived?.qty ?? 0) : 0);
    if (!(q > 0)) continue;
    const dir = String(r.side || '').toLowerCase() === 'short' ? -1 : 1;
    const root = underlyingOf(r);
    for (const leg of legsOf(r)) {
      const k = legKey(root, leg);
      const e = expected.get(k) || { qty: 0, ids: [], contract: { root, expiry: leg.expiry, type: leg.right === 'P' ? 'put' : 'call', strike: leg.strike }, opened: r.derived?.firstDate || null };
      e.qty += q * (leg.ratio || 1) * (leg.side === 'short' ? -1 : 1) * dir;
      if (!e.ids.includes(r.id)) e.ids.push(r.id);
      expected.set(k, e);
    }
  }
  const optSeen = new Set();
  for (const p of optionLines) {
    const c = optionContractOf(p);
    if (!c) { report.push({ kind: 'unmatched', root: p.root, assetClass: 'option', qty: p.qty, note: 'an option line whose contract could not be read — strike, right or expiry missing' }); continue; }
    const k = contractKey(c);
    optSeen.add(k);
    const label = contractLabel(c);
    const e = expected.get(k);
    // Agreement first: a console contract that matches is matched, whatever its expiry. The
    // day-trade rule only decides whether a DISAGREEMENT is worth saying.
    if (e && Math.abs(e.qty - p.qty) < 1e-6) { agree.push({ id: e.ids.join('+'), root: p.root, contract: label, qty: p.qty }); continue; }
    if (isDayTradeOption(c, { openDate: p.openDate, asOf })) {
      report.push({ kind: 'daytrade-option', root: p.root, contract: label, qty: p.qty, note: `${DAYTRADE_MAX_DTE} day or less to expiry when opened — a day trade, left out of the console` });
      continue;
    }
    if (e) {
      report.push({ kind: 'option-differs', root: p.root, contract: label, ids: e.ids, qty: { console: e.qty, ibkr: p.qty },
        note: `the console holds ${e.qty} of ${label} and the statement ${p.qty} — a fill is missing on one side` });
      continue;
    }
    report.push({ kind: 'option-not-in-console', root: p.root, contract: label, qty: p.qty,
      note: `held at IBKR and not in the console — add it (as an option, or as a leg of its spread) if it is a swing position` });
  }
  for (const [k, e] of expected) {
    if (optSeen.has(k) || Math.abs(e.qty) < 1e-9) continue;
    if (isDayTradeOption(e.contract, { openDate: e.opened, asOf })) continue;
    report.push({ kind: 'option-missing-at-broker', root: e.contract.root, contract: contractLabel(e.contract), ids: e.ids, qty: e.qty,
      note: 'held in the console, not in the statement — closed or expired at the broker, or entered wrongly here' });
  }

  // Open in the console, absent from the statement. Reported, never removed.
  for (const [key, rows2] of byRoot) {
    if (seen.has(key)) continue;
    if (rows2.some(r => namedInMismatch.has(r.id))) continue;   // already reported, under the right name
    for (const r of rows2) {
      const start = r.derived?.firstDate;
      if (asOf && start && start > asOf) {
        report.push({ kind: 'opened-since-statement', root: consoleRoot(r), id: r.id, openedOn: start,
          note: `opened on ${start}, after the statement of ${asOf} — it will appear in the next one` });
      } else {
        report.push({ kind: 'missing-at-broker', root: consoleRoot(r), id: r.id, qty: r.derived?.qty ?? null, note: 'open here, not in the statement — closed at the broker, held elsewhere, or outside the query\'s scope' });
      }
    }
  }
  return { agree, differs, ambiguous, adds, report };
}

// A statement row is a POSITION, not a history: it knows what is held and at what average, not the
// fills that got there. So the synthetic row carries one fill at the broker's own average cost,
// which is exactly what the console needs to compute everything else, and says so in the note.
export function rowFromPosition(p, { today = new Date().toISOString().slice(0, 10), asOf = null } = {}) {
  const stamp = asOf || today;
  const futures = classOf(p) === 'futures';
  // Hong Kong codes are numeric and IBKR drops the leading zeros; the console (and the quote feed)
  // want the padded four-digit form with the suffix.
  const hk = /^\d{1,5}$/.test(p.root) && p.currency === 'HKD';
  const hkCode = hk ? p.root.padStart(4, '0') : null;
  return {
    id: `${hk ? hkCode : p.root}-flex-${(p.conid || p.symbol || '').toString().slice(0, 12)}`,
    symbol: hk ? `${hkCode}.HK` : p.root,
    currency: p.currency || 'USD',
    // Carried from the parsed position, which has already consulted the table. Null means the
    // contract is unknown to both the broker and lib/futures.js — the row is still created, and
    // reconcile reports it, because a position you hold is not made less real by that.
    multiplier: p.multiplier ?? null,
    multiplierSource: p.multiplierSource || null,
    margined: futures,
    trade: futures && p.expiry ? `${p.expiry.slice(0, 6)} futures` : '',
    thesis: `Added from the IBKR statement of ${stamp}. One fill at the broker's average cost — a statement reports a position, not the fills behind it, so the entry history is flat by construction. Edit it if the detail matters.`,
    levels: [],
    tags: ['new', 'flex'],
    // THE SIGN IS THE DIRECTION. IBKR reports a short as a NEGATIVE quantity, and every comparison
    // in this file takes Math.abs() of it — correct while the console could only hold longs, and
    // the exact point at which a broker-sourced short would have been created as a long and then
    // computed backwards for the rest of its life. The magnitude is still what reconciles; the sign
    // decides which way the row points and which fill opens it.
    side: p.qty < 0 ? 'short' : 'long',
    fills: [{ id: 'f0', side: p.qty < 0 ? 'sell' : 'buy', qty: Math.abs(p.qty), price: p.costBasisPrice, date: p.openDate || stamp, note: 'IBKR position average cost' }],
  };
}

// ── Acknowledging a divergence ────────────────────────────────────────────────
// Recording `costBasisAck` by hand means editing a row, saving, and hoping the browser is running
// the build that knows the field exists — which is exactly how the first attempt at it was lost.
// Naming the row in the request instead puts the whole round trip on the server: the statement is
// already open, the broker's figure is already in hand, and the answer says what was written.
//
// It refuses a row whose QUANTITY also disagrees. That is a fill the console never recorded, not an
// accounting convention, and accepting a cost basis would paper over it.
export function planAck(rec, ids = []) {
  const ack = [], refused = [];
  for (const raw of ids) {
    const id = String(raw || '').trim();
    if (!id) continue;
    const d = rec.differs.find(x => x.id === id);
    if (!d) { refused.push({ id, reason: 'nothing to acknowledge — this row already agrees with the statement, or is not in it' }); continue; }
    if (d.qty) { refused.push({ id, reason: 'the quantity disagrees too, which is a fill the console never recorded rather than an accounting convention — fix that first' }); continue; }
    if (!d.avg || d.avg.ibkr == null) { refused.push({ id, reason: 'the statement carries no cost basis for this position to acknowledge' }); continue; }
    ack.push({ id, from: d.avg.console, to: d.avg.ibkr });
  }
  return { ack, refused };
}

// ── THE FILL THAT CLOSES A QUANTITY GAP ──────────────────────────────────────
// IBKR is the record. When the statement holds more than the console, the console is missing a
// fill of the difference; when it holds less, a fill went out. Both sides' quantities and cost
// bases are known, so the reconciling fill can be stated — and for an ADD its price can be
// solved so that the row's average lands on the statement's cost basis:
//   (q0·a0 + dq·p) / (q0 + dq) = ibkr  →  p = ((q0 + dq)·ibkr − q0·a0) / dq
// A REDUCTION does not move the average, so its price is whatever was received and cannot be
// inferred; it is stated as a fill of known size with the price left to the operator. A solved
// price that is not plausible — negative, or far from the statement's own basis — is not offered.
export function reconcilingFill(d, { asOf = null, statementFills = [] } = {}) {
  if (!d?.qty) return null;
  const q0 = Number(d.qty.console), q1 = Number(d.qty.ibkr);
  if (!Number.isFinite(q0) || !Number.isFinite(q1) || q0 === q1) return null;
  // Four decimals: a cash ETF reinvests distributions into fractional shares, and 2108.7533 minus
  // 1058 in floating point is 1050.7532999999999, which is not a quantity anyone can type.
  const dq = +(q1 - q0).toFixed(4);
  const side = dq > 0 ? 'add' : 'reduce';
  const qty = Math.abs(dq);
  const verb = side === 'add' ? 'bought' : 'sold';
  // ── THE STATEMENT'S OWN TRADE LINES, WHEN IT HAS THEM ──
  // IBKR is the record: if the statement's Trades section carries fills for this root that the
  // console has not adopted, those ARE the missing fills — exact price, exact day, trade id — and
  // nothing needs solving. They apply with the batch once it reconciles, or can be recorded now.
  const fills = (statementFills || []).filter(f => f && Number.isFinite(+f.qty) && Number.isFinite(+f.price));
  if (fills.length) {
    const lines = fills.map(f => `${f.side === 'buy' ? 'bought' : 'sold'} ${+(+f.qty).toFixed(4)} @ ${f.price}${f.date ? ` on ${f.date}` : ''}`);
    const net = +fills.reduce((a, f) => a + (f.side === 'buy' ? 1 : -1) * +f.qty, 0).toFixed(4);
    const covers = Math.abs(net - dq) < 1e-6;
    return {
      side, qty, price: +fills[0].price, date: fills[0].date || asOf, fills,
      fromStatement: true, covers,
      text: `the statement carries it: ${lines.join('; ')}${covers ? '' : ` (net ${net >= 0 ? '+' : ''}${net}, against a gap of ${dq >= 0 ? '+' : ''}${dq})`} — ${covers ? 'these apply with the batch once it reconciles, or record them now' : 'these are part of it; the rest is older than the statement window'}`,
    };
  }
  const b = d.basis || d.avg || {};
  const a0 = Number(b.console), a1 = Number(b.ibkr ?? b.console);
  let price = null, priceNote;
  if (side === 'add' && q0 > 0 && Number.isFinite(a0) && Number.isFinite(a1) && b.agree) {
    // The averages already agree, so the missing buy went in at (or near) the average.
    price = +a1.toFixed(4); priceNote = `at ${price} — the cost bases already agree, so the missing buy went in at the average`;
  } else if (side === 'add' && q0 > 0 && Number.isFinite(a0) && Number.isFinite(a1)) {
    const p = ((q0 + dq) * a1 - q0 * a0) / dq;
    const plausible = Number.isFinite(p) && p > 0 && Math.abs(p - a1) <= Math.abs(a1) * 0.5;
    if (plausible) { price = +p.toFixed(4); priceNote = `at ${price}, which lands the average on the statement's ${a1}`; }
    else priceNote = `price unknown — the statement's basis ${a1} cannot be reached by one fill from the console's ${a0}`;
  } else if (side === 'add' && Number.isFinite(a1)) {
    price = +a1.toFixed(4); priceNote = `at the statement's basis ${price} — nothing held before, so that is the average`;
  } else if (side === 'add') {
    priceNote = 'price unknown — the statement carries no cost basis for it';
  } else {
    priceNote = 'at the price received — a sale does not move the average, so the statement cannot say; it is on the IBKR trade confirmation, or in the statement\'s Trades section if the window reaches that day';
  }
  return {
    side, qty, price, date: asOf, fromStatement: false,
    text: `record ${qty} ${verb} ${priceNote}${asOf ? `, dated on or before ${asOf}` : ''}`,
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
  const since = rec.report.filter(r => r.kind === 'closed-since-statement' || r.kind === 'opened-since-statement' || r.kind === 'changed-since-statement');
  if (since.length) bits.push(`${since.length} moved after the statement was cut (${since.map(m => m.root).join(', ')})`);
  const opt = optionFindings(rec);
  if (opt.length) bits.push(`${opt.length} option contract${opt.length === 1 ? '' : 's'} to check (${opt.map(o => o.contract).join(', ')})`);
  const unmatched = rec.report.filter(r => r.kind === 'unmatched');
  if (unmatched.length) bits.push(`${unmatched.length} not auto-added (${unmatched.map(m => `${m.root} ${m.assetClass}`).join(', ')})`);
  const day = rec.report.filter(r => r.kind === 'daytrade-option');
  if (day.length) bits.push(`${day.length} day-trade option${day.length === 1 ? '' : 's'} left out`);
  return bits.length ? bits.join(' · ') : `all ${rec.agree.length} positions reconcile`;
}

// ── What needs a human ────────────────────────────────────────────────────────
// A daily reconciliation is only useful if it SAYS something when it finds something, and stays
// quiet otherwise. The endpoint's full answer goes to whoever called it; the channel gets only the
// part that needs acting on.
//
// Left out deliberately: `unmatched` (cash legs and anything else outside the console's scope
// permanently, so they appear in every run for ever), day-trade options, and the since-the-statement kinds, which
// resolve themselves as soon as the next statement is cut. Reporting either daily would train the
// reader to ignore the message, which costs more than the message is worth.
export const OPTION_FINDINGS = Object.freeze(['option-differs', 'option-not-in-console', 'option-missing-at-broker']);
export const optionFindings = (rec) => rec.report.filter(r => OPTION_FINDINGS.includes(r.kind));
export function actionable(rec) {
  return [
    // Option contracts the two sides disagree about. Day-trade options are not here: left out on
    // purpose, like the since-the-statement kinds.
    ...optionFindings(rec).map(o => `${o.kind}:${o.contract}:${o.qty?.ibkr ?? o.qty?.console ?? o.qty}`),
    ...rec.adds.map(r => `add:${r.id}`),
    ...rec.differs.map(d => `differs:${d.id}:${d.qty ? `q${d.qty.ibkr}` : ''}${d.avg ? `c${d.avg.ibkr}` : ''}`),
    ...rec.ambiguous.map(a => `ambiguous:${a.root}`),
    ...rec.report.filter(r => r.kind === 'missing-at-broker').map(r => `missing:${r.id}`),
  ].sort();
}

// The signature is over WHAT is wrong, not that something is. A disagreement that persists is the
// same news on day two, and posting it every morning is how a channel becomes wallpaper — but if
// IBKR reports a different number tomorrow, the signature changes and it is said again.
export const signatureOf = (rec) => actionable(rec).join('|');

export function summariseActionable(rec) {
  const bits = [];
  if (rec.adds.length) bits.push(`added ${rec.adds.map(r => r.symbol).join(', ')}`);
  if (rec.differs.length) bits.push(`${rec.differs.length} disagree${rec.differs.length === 1 ? 's' : ''} with the statement (${rec.differs.map(d => d.root).join(', ')})`);
  if (rec.ambiguous.length) bits.push(`${rec.ambiguous.length} ambiguous (${rec.ambiguous.map(a => a.root).join(', ')})`);
  const missing = rec.report.filter(r => r.kind === 'missing-at-broker');
  if (missing.length) bits.push(`${missing.length} open here but not at the broker (${missing.map(m => m.root).join(', ')})`);
  const opt = optionFindings(rec);
  if (opt.length) bits.push(`${opt.length} option contract${opt.length === 1 ? '' : 's'} to check (${opt.map(o => o.contract).join(', ')})`);
  return bits.join(' · ');
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
