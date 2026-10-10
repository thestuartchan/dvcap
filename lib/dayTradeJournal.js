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
//          type but not an option's strike or expiry, so options are grouped by underlying; a
//          multi-leg order and fills that built a position still open are left out, and the
//          round-trip boundary starts from the broker's current position.
// Every P&L is IBKR's own realised figure, net of commission. No position, size or balance leaves this module for anywhere public:
// its output is written only to the private artifact's database.
import { brokerKey, segments, consoleSymbolOf, openedAtDte } from './fillAudit.js';
import { parseOptionSymbol } from './bookExposure.js';

export const DAY_TRADE_MAX_HOURS = 24;
export const OPTION_DAY_MAX_DTE = 1;
export const FEED_FROM = '2026-10-03';            // sheet before this date, IBKR feed from it
export const JOURNAL_ONLY = Object.freeze([{ root: 'QQQ', kind: 'option', why: 'QQQ options are day-trade only' }]);
export const VENUES = Object.freeze(['IBKR']);
// Fixed, stated conversion for the few non-dollar trades (HKD is pegged in a 7.75–7.85 band).
export const USD_PER = Object.freeze({ USD: 1, HKD: 1 / 7.8 });

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
  const pnl = seg.fills.reduce((a, f) => a + (num(f.realized) || 0), 0);
  const ccy = String(first.currency || 'USD').toUpperCase();
  const rate = USD_PER[ccy] ?? null;
  return {
    side, openedAt: first.time || null, closedAt: last.time || null,
    date: nyDate(first.time) || first.date, closeDate: nyDate(last.time) || last.date,
    holdMin, fills: seg.fills.length,
    qty: +ins.reduce((a, f) => a + f.qty, 0).toFixed(8), avgIn: vwap(ins), avgOut: vwap(outs),
    pnl: r2(pnl), ccy, pnlUsd: rate == null ? null : r2(pnl * rate),
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

// ── FROM THE IBKR FEED ───────────────────────────────────────────────────────
// `trades`: the connector's get_account_trades list. `positions`: its get_account_positions list,
// taken at the same time — the position each underlying started the window with is the position
// now less what the window did, so a cut is flat-to-flat in the broker's real position.
const FEED_KIND = { STK: 'stock', OPT: 'option', FOP: 'option', FUT: 'future' };
const posRoot = (desc) => {
  const d = String(desc || '').trim().toUpperCase(), root = d.split(/\s+/)[0];
  return /@SEHK/.test(d) && /^\d+$/.test(root) ? `${root.padStart(4, '0')}.HK` : root;
};
export function roundTripsFromIbkr({ trades = [], positions = [], since = FEED_FROM } = {}) {
  // 1. Multi-leg orders (both sides in one order id) are spreads — the console's, never a day trade
  //    by this route.
  const sidesByOrder = new Map();
  for (const t of trades) sidesByOrder.set(t.order_id, (sidesByOrder.get(t.order_id) || new Set()).add(t.side));
  const pos = positions.map(p => ({ root: posRoot(p.contract_description), cls: String(p.asset_class || '').toUpperCase(),
    qty: num(p.position) || 0, avg: num(p.average_price) }));
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
    const root = cls === 'STK' && String(t.currency).toUpperCase() === 'HKD' && /^\d+$/.test(raw) ? `${raw.padStart(4, '0')}.HK` : raw;
    // 2. A fill that built a position still open (a separately-ordered spread leg) is the console's.
    const built = (cls === 'OPT' || cls === 'FOP') && pos.find(p => p.root === root && p.cls === cls && p.avg > 0
      && Math.sign(p.qty) === (side === 'buy' ? 1 : -1) && Math.abs(price - p.avg) / p.avg <= 0.02);
    if (built) { built.built = true; continue; }
    fills.push({ uid: String(t.trade_id), root, cls, side, qty, price, time: t.trade_time, date: String(t.trade_time || '').slice(0, 10),
                 realized: num(t.realized_pnl) || 0, fee: -Math.abs(num(t.commission) || 0), currency: t.currency || 'USD' });
  }
  const groups = new Map();
  for (const f of fills) { const k = `${f.root}|${f.cls}`; groups.set(k, [...(groups.get(k) || []), f]); }
  const out = [];
  for (const [k, fs] of groups) {
    const [root, cls] = k.split('|');
    // Fills at the same second (one order split across exchanges) come back in any order; the trade
    // id breaks the tie, so a round trip's id — its first fill's — is the same on every sync.
    fs.sort((a, b) => String(a.time).localeCompare(String(b.time)) || a.uid.localeCompare(b.uid));
    // A held option the walk's own fills did not build (its fills were set aside above) is still
    // counted, so scalps on top of it are not mistaken for round trips; one they built is not.
    const nowPos = pos.filter(p => p.root === root && p.cls === cls && !p.built).reduce((a, p) => a + p.qty, 0);
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
        if (cur?.length && Math.abs(cur[0].realized) < 0.01) {
          const s = summarise({ fills: cur });
          if (!since || s.date >= since) {
            const rt = { id: idSafe(`ib-${cur[0].uid}`), venue: 'IBKR', source: 'ibkr', kind: FEED_KIND[cls],
              symbol: cls === 'OPT' || cls === 'FOP' ? `${root} options` : root, underlying: root, contract: null, dte: null, ...s };
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
