// lib/actions.js — the daily "action required" strip (panel brief, console rework, Step 4b).
//
// One line per item that needs a decision TODAY, sorted by urgency, above the tabs. Empty when
// nothing needs doing — the strip is absent, never "nothing to do", because a strip that is always
// there is a strip that stops being read. In order:
//
//   0  a contract past expiry with quantity still open
//   1  a hard exit date reached (lib/instruments.js)
//   2  a level hit (the alert engine, lib/positions.js levelHits)
//   3  a stop within 1 ATR of the price (lib/atr.js stopInAtr)
//   4  an option with fewer than 7 days to expiry
//   5  a swing trade in its fourth session or later (lib/leverage.js SWING.maxSessions)
//
// Pure: everything it reads is handed in, so the same list can be built in a test with no feed.
import { stopInAtr, ATR_TIGHT_STOP } from './atr.js';
import { SWING } from './leverage.js';

export const DTE_WARN = 7;

const nameOf = (r) => (r?.opt ? `${r.symbol} ${r.opt.label}` : r?.symbol || '?');

// `rows` are derived console rows (with derived, opt, levels, state); `hits` the alert engine's
// output; `swingLines` the exposure book's swing bucket lines; `atrOf(row)` the ATR for the row's
// quote symbol or null; `priceOf(row, level)` the price a level is judged against.
export function actionItems({ rows = [], hits = [], swingLines = [], atrOf = () => null, priceOf = () => null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const items = [];
  const live = rows.filter(r => r?.derived?.status !== 'closed');
  for (const r of live) {
    const o = r.opt;
    if (o?.expired) items.push({ id: r.id, rank: 0, kind: 'expired', tone: 'danger', text: `${nameOf(r)} — past expiry ${o.expiry} with ${r.derived.qty} still open` });
    else if (o?.hardDateReached) items.push({ id: r.id, rank: 1, kind: 'hard-date', tone: 'danger', text: `${nameOf(r)} — hard exit date ${o.hardDate === today ? 'today' : o.hardDate}` });
  }
  for (const h of hits) {
    const r = h.position;
    const what = h.level?.on === 'underlying' ? 'underlying' : r?.opt ? 'combo mark' : 'price';
    items.push({ id: r.id, rank: 2, kind: 'alert', tone: 'warn', text: `${nameOf(r)} — ${h.level.kind} level ${h.level.at}${h.level.to ? '–' + h.level.to : ''} hit, ${what} ${h.price}` });
  }
  for (const r of live) {
    if (r.derived?.status !== 'open') continue;
    const stop = (r.levels || []).find(l => l.kind === 'stop' && l.at != null && l.on !== 'underlying');
    if (!stop) continue;
    // A level already hit is listed above; this is the one about to be.
    if (hits.some(h => h.position?.id === r.id && h.level?.id === stop.id)) continue;
    const atrs = stopInAtr({ price: priceOf(r, stop), stop: stop.at, atr: atrOf(r) });
    if (atrs != null && atrs <= ATR_TIGHT_STOP) items.push({ id: r.id, rank: 3, kind: 'stop-near', tone: 'warn', text: `${nameOf(r)} — stop ${stop.at} is ${atrs} ATR away` });
  }
  for (const r of live) {
    const o = r.opt;
    if (o && !o.expired && !o.hardDateReached && o.dte != null && o.dte < DTE_WARN && r.derived?.qty > 0) {
      items.push({ id: r.id, rank: 4, kind: 'dte', tone: 'warn', text: `${nameOf(r)} — ${o.dte} day${o.dte === 1 ? '' : 's'} to expiry` });
    }
  }
  for (const l of swingLines) {
    if (l?.sessionsHeld != null && l.sessionsHeld > SWING.maxSessions) {
      const r = live.find(x => x.symbol === l.symbol);
      items.push({ id: r?.id ?? l.symbol, rank: 5, kind: 'swing', tone: 'warn', text: `${l.symbol} — swing trade in session ${l.sessionsHeld}, past the ${SWING.maxSessions}-session window` });
    }
  }
  items.sort((a, b) => a.rank - b.rank || String(a.text).localeCompare(String(b.text)));
  return items;
}
