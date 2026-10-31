// lib/dayTradeJournal.js — the trades that do NOT go into the console, as round trips.
//
// The console keeps swings and holds; everything its rules leave out is the day-trading record,
// kept in its own artifact so it can be reviewed: P&L, copy trades, and how results move when a
// rule set changes. The rules, as decided on 6 Oct:
//   • a round trip held under 24 hours (opening fill to the fill that took it flat) is a day trade;
//   • an option opened at 0–1 days to expiry is a day trade however long it was held;
//   • QQQ options are not a console instrument at all (0/1DTE only from 6 Oct; earlier QQQ option
//     swings were copy trades and stay out) — every QQQ option round trip belongs here.
// A round trip is cut flat to flat in the BROKER's own position, so a scalp on top of a held
// position is never one: it moved a tracked position, and the console has it.
//
// IBKR only. Hyperliquid was dropped on 6 Oct: the weekly feed cannot reach it, and a record that
// stops updating halfway is worse than none.
// Two sources, never mixed for one week:
//   SHEET  the retiring trade sheet's "Fills (auto)" (lib/fillAudit.js parseBrokerFills — IBKR
//          times corrected), with full option contracts. Used up to FEED_FROM.
//   IBKR   the IBKR connector's trade feed, from FEED_FROM on. It names a fill's underlying and
//          type but not an option's strike or expiry. The Flex statement does, and the weekly sync
//          reads it for the same window (api/flex-sync.js ?journal=1): each option order's
//          contract, joined to the feed by IBKR's order id, so a round trip is cut per CONTRACT.
//          Without it options fall back to one group per underlying. A multi-leg order and fills
//          that built a position still open are left out, and the round-trip boundary starts
//          from the broker's current position.
// Every P&L is IBKR's own realised figure, net of commission. No position, size or balance leaves this module for anywhere public:
// its output is written only to the private artifact's database.
import { brokerKey, segments, consoleSymbolOf, openedAtDte } from './fillAudit.js';
import { parseOptionSymbol } from './bookExposure.js';

export const DAY_TRADE_MAX_HOURS = 24;
export const OPTION_DAY_MAX_DTE = 1;
export const FEED_FROM = '2026-10-03';            // sheet before this date, IBKR feed from it
export const JOURNAL_ONLY = Object.freeze([{ root: 'QQQ', kind: 'option', why: 'QQQ options are day-trade only' }]);
export const VENUES = Object.freeze(['IBKR']);
// Fixed, stated conversion for the few non-dollar trades. Both are pegs: HKD in the 7.75–7.85
// band, AED hard at 3.6725 (lib/fxrates.js). A currency missing here leaves pnlUsd null, which the
// week's total would read as zero — so a new currency is added here before it is traded.
export const USD_PER = Object.freeze({ USD: 1, HKD: 1 / 7.8, AED: 1 / 3.6725 });

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const r2 = (v) => (v == null ? null : +(+v).toFixed(2));
const idSafe = (s) => String(s || '').replace(/[^A-Za-z0-9_.~:@+-]/g, '').slice(0, 120) || 'x';

// New York calendar date of an instant, and the ISO week it falls in (Monday start).
export function nyDate(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}
export function isoWeek(dateIso) {
  const d = new Date(`${dateIso}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;                // Monday 0
  d.setUTCDate(d.getUTCDate() - day + 3);             // the week's Thursday decides its year
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// Why a round trip is in the journal, or null when it belongs to the console.
export function journalReason(rt) {
  const only = JOURNAL_ONLY.find(j => j.root === rt.underlying && j.kind === rt.kind);
  if (rt.holdMin != null && rt.holdMin < DAY_TRADE_MAX_HOURS * 60) return 'held under 24h';
  if (rt.kind === 'option' && rt.dte != null && rt.dte <= OPTION_DAY_MAX_DTE) return `opened at ${rt.dte} DTE`;
  if (only) return only.why;
  return null;
}

function summarise(seg) {
  const first = seg.fills[0], last = seg.fills.at(-1);
  const side = first.side === 'buy' ? 'long' : 'short';
  const opening = side === 'long' ? 'buy' : 'sell';
  const ins = seg.fills.filter(f => f.side === opening), outs = seg.fills.filter(f => f.side !== opening);
  const vwap = (fs) => { const q = fs.reduce((a, f) => a + f.qty, 0); return q > 0 ? +(fs.reduce((a, f) => a + f.qty * f.price, 0) / q).toPrecision(8) : null; };
  const t0 = Date.parse(first.time || ''), t1 = Date.parse(last.time || '');
  const holdMin = Number.isFinite(t0) && Number.isFinite(t1) ? Math.round((t1 - t0) / 60000) : null;
  // IBKR's realised P&L already includes commission.
  let pnl = seg.fills.reduce((a, f) => a + (num(f.realized) || 0), 0);
  // EXCEPT ON AN EXPIRY. The trade feed books an option that expired as a fill at 0 with a realised
  // P&L of 0, so a long held to a worthless expiry read as breaking even when it lost its whole
  // premium. A round trip that ends in such a booking is counted from its cash instead: what the
  // closing fills brought in, less what the opening fills cost, less every commission — the same
  // figure IBKR's statement realises. `gross` is the fill's net_amount (price × size × multiplier).
  const expired = seg.fills.some(f => f.side !== opening && f.price === 0 && Math.abs(num(f.realized) || 0) < 0.01);
  if (expired && seg.fills.every(f => f.price === 0 || Number.isFinite(f.gross))) {
    const cash = (fs) => fs.reduce((a, f) => a + (f.price === 0 ? 0 : Math.abs(f.gross)), 0);
    const fees = seg.fills.reduce((a, f) => a + Math.abs(num(f.fee) || 0), 0);
    pnl = (side === 'long' ? cash(outs) - cash(ins) : cash(ins) - cash(outs)) - fees;
  }
  const ccy = String(first.currency || 'USD').toUpperCase();
  const rate = USD_PER[ccy] ?? null;
  return {
    side, openedAt: first.time || null, closedAt: last.time || null,
    date: nyDate(first.time) || first.date, closeDate: nyDate(last.time) || last.date,
    holdMin, fills: seg.fills.length,
    qty: +ins.reduce((a, f) => a + f.qty, 0).toFixed(8), avgIn: vwap(ins), avgOut: vwap(outs),
    pnl: r2(pnl), ccy, pnlUsd: rate == null ? null : r2(pnl * rate),
    ...(expired ? { expired: true } : {}),
  };
}

// ── FROM THE SHEET ───────────────────────────────────────────────────────────
// `fills` from parseBrokerFills. Closed round trips only (an open one, or a sale of shares bought
// before the sheet began, is not a day trade by construction).
export function roundTripsFromSheet(fills = [], { until = FEED_FROM } = {}) {
  const groups = new Map();
  for (const f of fills) {
    const k = brokerKey(f);
    if (!k) continue;
    const venue = String(f.venue || '') || 'IBKR';
    if (!VENUES.includes(venue)) continue;
    const key = `${venue}|${k.key}`;
    if (!groups.has(key)) groups.set(key, { k, venue, fills: [] });
    groups.get(key).fills.push(f);
  }
  const out = [];
  for (const { k, venue, fills: fs } of groups.values()) {
    const sorted = [...fs].sort((a, b) => (a.time || a.date).localeCompare(b.time || b.date));
    for (const seg of segments(sorted)) {
      if (seg.kind !== 'day' && seg.kind !== 'swing') continue;
      const s = summarise(seg);
      if (until && s.date >= until) continue;
      const opt = k.kind === 'option' ? parseOptionSymbol(seg.fills[0].symbol) : null;
      const kind = k.kind === 'equity' ? 'stock' : k.kind;
      const rt = {
        id: idSafe(`ib-${seg.fills[0].uid}`),
        venue, source: 'sheet', kind,
        symbol: consoleSymbolOf(seg.fills[0]),
        underlying: opt?.root || (k.kind === 'future' ? k.key.slice(4) : k.kind === 'equity' ? consoleSymbolOf(seg.fills[0]) : k.key),
        contract: opt ? consoleSymbolOf(seg.fills[0]) : null,
        dte: opt ? openedAtDte(seg.fills[0]) : null,
        ...s,
      };
      rt.reason = journalReason(rt);
      if (rt.reason) out.push(rt);
    }
  }
  return out.sort((a, b) => String(a.openedAt).localeCompare(String(b.openedAt)));
}

// ── WHICH CONTRACT AN OPTION FILL WAS ────────────────────────────────────────
// 17 Oct 2026: the feed names every option fill by its underlying alone, so one contract held
// across days (partly sold, the rest expiring) kept the underlying's combined position from going
// flat — and the separate day trades taken meanwhile were swallowed into one multi-day "trade".
// The total was right; the count, the holds and every per-trade figure were not.

// The connector's position line: "XYZ Oct15'26 100 CALL @AMEX" → { root, expiry, right, strike }.
export function contractFromDescription(desc) {
  const d = String(desc || '').replace(/@\S+/g, '').replace(/\bCALL\b/i, 'C').replace(/\bPUT\b/i, 'P').trim();
  const o = parseOptionSymbol(d);
  return o ? { root: o.root, expiry: o.expiry, right: o.type === 'call' ? 'C' : 'P', strike: +o.strike } : null;
}
export const contractKey = (c) => (c?.root && c.expiry && c.right && c.strike != null ? `${c.root}|${c.expiry}|${c.right}|${+c.strike}` : null);
// The sheet's spelling, so a feed row and a sheet row read the same: "XYZ 2026-10-15 100C".
export const contractLabel = (c) => `${c.root} ${c.expiry} ${+c.strike}${c.right}`;

// The Flex statement's option orders, reduced to what the join needs: the order id and the
// contract, plus side, size, price and date for the fallback match below. Served only to the
// journal sync (api/flex-sync.js ?journal=1), which writes nowhere public.
export function journalOrdersFromFlex(rows = []) {
  const out = [];
  for (const t of rows) {
    if (!/^(OPT|FOP)$/.test(String(t.assetCategory || ''))) continue;
    const occ = parseOptionSymbol(t.symbol);
    const c = {
      root: String(t.root || '').split(/\s+/)[0] || occ?.root,
      expiry: t.expiry || occ?.expiry || null,
      right: t.right || (occ ? (occ.type === 'call' ? 'C' : 'P') : null),
      strike: t.strike ?? (occ ? occ.strike : null),
    };
    if (!contractKey(c)) continue;
    out.push({ orderId: t.orderId || null, ...c, side: t.side, qty: t.qty, price: t.rawPrice ?? t.price, date: t.date });
  }
  return out;
}

// Each option fill's contract, in three steps, each refusing to guess:
//   1. IBKR's order id, which the feed and the statement share.
//   2. Failing that, the ORDER as the feed saw it (its fills summed) against a statement order on
//      the same New York date, side and size, price within half a percent — one candidate only.
//   3. The broker's expiry booking (a fill at 0 with no order of its own) goes to the one expired
//      contract its size takes flat.
// Returns Map(fill uid → contract). A root with any option fill left unresolved is left out of the
// map entirely, so it falls back to one group per underlying rather than being half split.
export function resolveContracts(fills = [], orders = [], positions = []) {
  const out = new Map();
  const opt = fills.filter(f => f.cls === 'OPT' || f.cls === 'FOP');
  if (!opt.length || !orders.length) return { byFill: out, unresolvedRoots: [...new Set(opt.map(f => f.root))] };
  const byId = new Map();
  for (const o of orders) {
    if (!o.orderId) continue;
    const k = contractKey(o), was = byId.get(o.orderId);
    byId.set(o.orderId, was === undefined || was?.key === k ? { key: k, c: o } : null);   // null: one id, two contracts
  }
  const used = new Set();
  const byOrder = new Map();
  for (const f of opt) byOrder.set(f.order, [...(byOrder.get(f.order) || []), f]);
  const pending = [];
  for (const [order, fs] of byOrder) {
    const hit = order ? byId.get(order) : undefined;
    if (hit) { for (const f of fs) out.set(f.uid, hit.c); used.add(order); continue; }
    pending.push(fs);
  }
  // 2. The feed's order against the statement's, when the ids did not meet.
  const freeOrders = orders.filter(o => !o.orderId || !used.has(o.orderId));
  const expiries = [];
  for (const fs of pending) {
    const qty = fs.reduce((a, f) => a + f.qty, 0);
    const px = qty ? fs.reduce((a, f) => a + f.qty * f.price, 0) / qty : null;
    if (!(px > 0)) { expiries.push(...fs); continue; }
    const day = nyDate(fs[0].time) || fs[0].date;
    const cands = freeOrders.filter(o => o.root === fs[0].root && o.side === fs[0].side && o.date === day
      && Math.abs(o.qty - qty) < 1e-9 && o.price > 0 && Math.abs(o.price - px) / o.price <= 0.005);
    if (cands.length === 1) { for (const f of fs) out.set(f.uid, cands[0]); freeOrders.splice(freeOrders.indexOf(cands[0]), 1); }
  }
  // 3. Expiry bookings: the contract this size closes, among those expired by the booking's date.
  const signed = (f) => (f.side === 'buy' ? f.qty : -f.qty);
  for (const f of expiries) {
    const day = nyDate(f.time) || f.date;
    const net = new Map();
    for (const g of opt) {
      const c = out.get(g.uid);
      if (!c || g.root !== f.root) continue;
      const k = contractKey(c);
      net.set(k, { c, n: (net.get(k)?.n || 0) + signed(g) });
    }
    const cands = [...net.values()].filter(({ c, n }) => c.expiry <= day && Math.abs(n + signed(f)) < 1e-9
      && !positions.some(p => p.ck === contractKey(c) && Math.abs(p.qty) > 1e-9));
    if (cands.length === 1) out.set(f.uid, cands[0].c);
  }
  const unresolvedRoots = [...new Set(opt.filter(f => !out.has(f.uid)).map(f => f.root))];
  for (const f of opt) if (unresolvedRoots.includes(f.root)) out.delete(f.uid);
  return { byFill: out, unresolvedRoots };
}

// ── FROM THE IBKR FEED ───────────────────────────────────────────────────────
// `trades`: the connector's get_account_trades list. `positions`: its get_account_positions list,
// taken at the same time — the position each underlying started the window with is the position
// now less what the window did, so a cut is flat-to-flat in the broker's real position.
const FEED_KIND = { STK: 'stock', OPT: 'option', FOP: 'option', FUT: 'future' };
const posRoot = (desc) => {
  const d = String(desc || '').trim().toUpperCase(), root = d.split(/\s+/)[0];
  if (/@SEHK/.test(d) && /^\d+$/.test(root)) return `${root.padStart(4, '0')}.HK`;
  return /@(DFM|ADX)\b/.test(d) ? `${root}.AE` : root;
};
// `contracts`: journalOrdersFromFlex output for the same window, or null to group options by
// underlying as before. `report`, when passed, receives which roots could not be split.
export function roundTripsFromIbkr({ trades = [], positions = [], since = FEED_FROM, contracts = null, report = null } = {}) {
  // 1. Multi-leg orders (both sides in one order id) are spreads — the console's, never a day trade
  //    by this route.
  const sidesByOrder = new Map();
  for (const t of trades) sidesByOrder.set(t.order_id, (sidesByOrder.get(t.order_id) || new Set()).add(t.side));
  // An exercise or assignment (31 Oct 2026): the feed books the option leaving at 0 and the shares
  // (or future) it delivers under the same order id. The option's value went into the delivery, so
  // neither side is a trade with a P&L of its own — read alone, the option looks like a worthless
  // expiry and the delivery like a scalp. Their fills still move the position below; a round trip
  // holding any of them is not recorded.
  const optAtZero = new Set(trades.filter(t => /^(OPT|FOP)$/i.test(String(t.sec_type || '')) && num(t.price) === 0 && t.order_id != null).map(t => t.order_id));
  const exercised = new Set(trades.filter(t => /^(STK|FUT)$/i.test(String(t.sec_type || '')) && optAtZero.has(t.order_id)).map(t => t.order_id));
  const pos = positions.map(p => ({ root: posRoot(p.contract_description), cls: String(p.asset_class || '').toUpperCase(),
    qty: num(p.position) || 0, avg: num(p.average_price),
    ck: /^(OPT|FOP)$/i.test(String(p.asset_class || '')) ? contractKey(contractFromDescription(p.contract_description)) : null }));
  const fills = [];
  for (const t of trades) {
    const cls = String(t.sec_type || '').toUpperCase();
    if (!FEED_KIND[cls]) continue;                              // FX conversions and the like
    if ((sidesByOrder.get(t.order_id)?.size || 0) > 1) continue;
    const side = String(t.side || '').toUpperCase() === 'BUY' ? 'buy' : 'sell';
    const qty = Math.abs(num(t.size) || 0), price = num(t.price);
    if (!qty || price == null) continue;
    // Hong Kong shares come through as the bare code ("981"); the console writes them "0981.HK".
    const raw = String(t.symbol || '').toUpperCase();
    const ccyT = String(t.currency).toUpperCase();
    const root = cls === 'STK' && ccyT === 'HKD' && /^\d+$/.test(raw) ? `${raw.padStart(4, '0')}.HK`
      : cls === 'STK' && ccyT === 'AED' ? `${raw}.AE` : raw;
    fills.push({ uid: String(t.trade_id), order: t.order_id == null ? null : String(t.order_id), root, cls, side, qty, price, time: t.trade_time, date: String(t.trade_time || '').slice(0, 10),
                 realized: num(t.realized_pnl) || 0, fee: -Math.abs(num(t.commission) || 0), gross: num(t.net_amount), currency: t.currency || 'USD',
                 ...(exercised.has(t.order_id) ? { exercise: true } : {}) });
  }
  const { byFill, unresolvedRoots } = contracts ? resolveContracts(fills, contracts, pos) : { byFill: new Map(), unresolvedRoots: [] };
  if (report) Object.assign(report, { split: !!contracts, unresolvedRoots, resolvedFills: byFill.size });
  // 2. A fill that built a position still open (a separately-ordered spread leg) is the console's.
  //    With the contract known, only that contract's line can be the one it built.
  const kept = [];
  for (const f of fills) {
    if (f.cls === 'OPT' || f.cls === 'FOP') {
      const ck = contractKey(byFill.get(f.uid));
      const built = pos.find(p => p.root === f.root && p.cls === f.cls && p.avg > 0 && (!ck || !p.ck || p.ck === ck)
        && Math.sign(p.qty) === (f.side === 'buy' ? 1 : -1) && Math.abs(f.price - p.avg) / p.avg <= 0.02);
      if (built) { built.built = true; continue; }
    }
    kept.push(f);
  }
  const groups = new Map();
  for (const f of kept) {
    const c = byFill.get(f.uid) || null;
    const k = `${f.root}|${f.cls}|${contractKey(c) || ''}`;
    if (!groups.has(k)) groups.set(k, { root: f.root, cls: f.cls, c, fs: [] });
    groups.get(k).fs.push(f);
  }
  const out = [];
  for (const { root, cls, c, fs } of groups.values()) {
    const ck = contractKey(c);
    // Fills at the same second (one order split across exchanges) come back in any order; the trade
    // id breaks the tie, so a round trip's id — its first fill's — is the same on every sync.
    fs.sort((a, b) => String(a.time).localeCompare(String(b.time)) || a.uid.localeCompare(b.uid));
    // A held option the walk's own fills did not build (its fills were set aside above) is still
    // counted, so scalps on top of it are not mistaken for round trips; one they built is not.
    const nowPos = pos.filter(p => p.root === root && p.cls === cls && !p.built && (!ck || p.ck === ck)).reduce((a, p) => a + p.qty, 0);
    const windowNet = fs.reduce((a, f) => a + (f.side === 'buy' ? f.qty : -f.qty), 0);
    // Walk from the position the window started with. A round trip begins only where the broker
    // was flat, and ends where it is flat again; fills on a position held from before are not one.
    let net = nowPos - windowNet, cur = null;
    for (const f of fs) {
      if (Math.abs(net) < 1e-9) cur = [];
      if (cur) cur.push(f);
      net += f.side === 'buy' ? f.qty : -f.qty;
      if (Math.abs(net) < 1e-9) {
        // A fill that opens a round trip realises nothing. One that does was closing something held
        // from before — a spread's legs closed one order at a time look flat-to-flat under one
        // root, but the spread is the console's, never a day trade.
        // Nor is a run of bookings alone — every fill at 0 is the broker closing legs held from
        // before (an expiry, or an exercise), paired up only because the underlying was not split
        // by contract.
        if (cur?.length && Math.abs(cur[0].realized) < 0.01 && !cur.some(f => f.exercise) && !cur.every(f => f.price === 0)) {
          const s = summarise({ fills: cur });
          if (!since || s.date >= since) {
            const label = c ? contractLabel(c) : null;
            const dte = c && s.date ? Math.round((Date.parse(`${c.expiry}T12:00:00Z`) - Date.parse(`${s.date}T12:00:00Z`)) / 86400000) : null;
            const rt = { id: idSafe(`ib-${cur[0].uid}`), venue: 'IBKR', source: 'ibkr', kind: FEED_KIND[cls],
              symbol: label || (cls === 'OPT' || cls === 'FOP' ? `${root} options` : root), underlying: root, contract: label, dte, ...s };
            rt.reason = journalReason(rt);
            if (rt.reason) out.push(rt);
          }
        }
        cur = null;
      }
    }
  }
  return out.sort((a, b) => String(a.openedAt).localeCompare(String(b.openedAt)));
}

// ── ONE DOCUMENT PER WEEK ────────────────────────────────────────────────────
// What the artifact stores: weeks/<YYYY-Www>, by the week a round trip CLOSED in (New York). A
// futures trade closed on a Sunday evening belongs to the trading week that session opens.
export function weekOf(r) {
  const d = r.closeDate || r.date;
  if (new Date(`${d}T12:00:00Z`).getUTCDay() !== 0) return isoWeek(d);
  return isoWeek(new Date(Date.parse(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10));
}
const weekDoc = (week, trades) => ({
  week, trades: trades.sort((a, b) => String(a.openedAt).localeCompare(String(b.openedAt))),
  pnlUsd: r2(trades.reduce((a, t) => a + (t.pnlUsd || 0), 0)), count: trades.length,
  source: [...new Set(trades.map(t => t.source))].sort().join('+'),
});
export function toWeeks(rows = []) { return mergeWeeks([], rows); }
// Existing week documents plus new round trips; a trade id seen again replaces the old copy.
// A feed round trip is also known by what it was — underlying, side, size, opened and closed to the
// second — so one that comes back under another id (synced before ids were tie-broken) replaces
// the stored copy and keeps the stored id, which any copy-trade mark points at.
const feedKey = (r) => r.source === 'ibkr' ? [r.underlying, r.kind, r.side, r.qty, r.openedAt, r.closedAt].join('|') : null;
export function mergeWeeks(existing = [], rows = []) {
  const weeks = new Map(), idByKey = new Map();
  const put = (r) => {
    const k = feedKey(r), was = k && idByKey.get(k);
    if (was && was !== r.id) r = { ...r, id: was };
    if (k) idByKey.set(k, r.id);
    const w = weekOf(r); if (!weeks.has(w)) weeks.set(w, new Map()); weeks.get(w).set(r.id, r);
  };
  for (const doc of existing) for (const t of doc.trades || []) put(t);
  for (const r of rows) put(r);
  return [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, m]) => weekDoc(week, [...m.values()]));
}
