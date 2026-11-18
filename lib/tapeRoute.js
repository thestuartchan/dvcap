// lib/tapeRoute.js — /api/gex?tape=… : the level tape and the watch list (lib/levelTape.js).
//
//   GET  ?tape=capture              the 15-minute capture (scheduler: level-tape)
//   GET  ?tape=score[&date=]        grade a day's tape after the close (scheduler: level-score)
//   GET  ?tape=read                 the panel: watch list, today's boards, the scorecard, last grades
//   POST ?tape=watch&op=add&symbol= add a name for today and the next session (captured at once)
//   POST ?tape=watch&op=remove&symbol=
//
// EVERY BRANCH IS GATED (dashboard session or the scheduler's service key): the answers carry UW
// numbers (personal-use licence) and the watch list is which names are being planned — the book.
// The capture and score answers, which the scheduler records, carry counts and part states only.
import { kvGetJson, kvSetJson, kvSetJsonEx } from './kv.js';
import { authorised, refusalReason } from './apiauth.js';
import { settledGex, readGex } from './gexStore.js';
import { resolveSpot } from './gexFeedBoard.js';
import { marketState } from './sessions.js';
import { uwConfigured, uwGet, uwUsage } from './uw.js';
import { yahooBars } from './yahoo.js';
import { fetchEarnings } from './earnings.js';
import {
  captureTape, captureOne, appendCapture, scoreDay, scoreSummary, latestBoard, activeWatch, addToWatch, removeFromWatch,
  uwBudgetOk, nyDay, BOOK_SYMBOLS, WATCH_KEY, TAPE_KEY, TAPE_INDEX_KEY, TAPE_TTL_S, SCORE_AGG_KEY, SCORE_DAY_KEY,
  TAPE_HEALTH_KEY, TAPE_RULE, TAPE_EVERY_MIN,
} from './levelTape.js';

const kv = { get: kvGetJson, set: kvSetJson, setEx: kvSetJsonEx };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function tapeDeps(env = process.env) {
  return {
    spotOf: (sym) => resolveSpot(sym),
    // The book pair is priced over the same expiries as its stored series (as the settled route
    // does), so the tape's flip is the board's flip; a watch name is a custom read, nothing recorded.
    settled: async (sym, { spot }) => {
      if (BOOK_SYMBOLS.includes(sym)) {
        const stored = await readGex(sym).catch(() => null);
        return settledGex(sym, { spot, expiries: stored?.latest?.expiries || null });
      }
      return settledGex(sym, { spot, record: false });
    },
    uw: uwConfigured(env) ? (path, o = {}) => uwGet(path, { ...o, env }) : null,
    budgetOk: () => uwBudgetOk(uwUsage),
  };
}

export async function serveTape(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!(await authorised(req))) return res.status(401).json({ ok: false, error: 'unauthorised', why: refusalReason(req) });
  const mode = String(req.query?.tape || '');
  const now = new Date();
  const today = nyDay(now);

  if (mode === 'capture') {
    const out = await captureTape({ now, kv, deps: tapeDeps(), isOpen: (t) => marketState('QQQ', t) === 'open' });
    return res.status(200).json(out);
  }

  if (mode === 'score') {
    const date = DATE_RE.test(String(req.query?.date || '')) ? String(req.query.date) : today;
    const out = await scoreDay({ date, kv, barsOf: (s) => yahooBars(s, { range: '5d', interval: '5m' }) });
    return res.status(200).json(out);
  }

  if (mode === 'watch') {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, error: 'POST only' }); }
    const op = String(req.query?.op || '');
    const symbol = String(req.query?.symbol || '').trim().toUpperCase();
    const watch = await kvGetJson(WATCH_KEY).catch(() => null);
    if (op === 'remove') {
      const r = removeFromWatch(watch, symbol, { today });
      if (r.ok) await kvSetJson(WATCH_KEY, r.watch);
      return res.status(200).json({ ok: r.ok, why: r.why, watch: r.watch.names });
    }
    if (op !== 'add') return res.status(400).json({ ok: false, error: 'op must be add or remove' });
    const earnings = /^[A-Z]{1,6}$/.test(symbol) ? await fetchEarnings(symbol, { timeoutMs: 6000 }).catch(() => null) : null;
    const r = addToWatch(watch, symbol, { today, earnings: earnings?.ok ? earnings : null });
    if (!r.ok) return res.status(200).json({ ok: false, why: r.why, watch: activeWatch(watch, today) });
    await kvSetJson(WATCH_KEY, r.watch);
    // A first capture now, inside the session, so the panel has something before the next slot.
    let first = 'not in session';
    if (marketState('QQQ', now) === 'open') {
      const cap = await captureOne(symbol, { now, book: false, deps: tapeDeps() });
      const ok = await kv.setEx(TAPE_KEY(symbol, today), appendCapture(await kvGetJson(TAPE_KEY(symbol, today)).catch(() => null), cap, { symbol, date: today }), TAPE_TTL_S).catch(() => false);
      const idx = await kvGetJson(TAPE_INDEX_KEY(today)).catch(() => null);
      await kv.setEx(TAPE_INDEX_KEY(today), [...new Set([...(Array.isArray(idx) ? idx : []), ...BOOK_SYMBOLS, symbol])], TAPE_TTL_S).catch(() => {});
      first = ok ? 'captured' : 'not kept';
    }
    return res.status(200).json({ ok: true, entry: r.entry, first, watch: r.watch.names });
  }

  if (mode === 'read') {
    const watch = activeWatch(await kvGetJson(WATCH_KEY).catch(() => null), today);
    const syms = [...BOOK_SYMBOLS, ...watch.map(n => n.symbol)];
    const tapes = await Promise.all(syms.map(s => kvGetJson(TAPE_KEY(s, today)).catch(() => null)));
    const agg = await kvGetJson(SCORE_AGG_KEY).catch(() => null);
    const scored = Object.keys(agg?.days || {}).sort();
    const lastDate = scored.length ? scored[scored.length - 1] : null;
    const graded = lastDate ? await kvGetJson(SCORE_DAY_KEY(lastDate)).catch(() => null) : null;
    const health = await kvGetJson(TAPE_HEALTH_KEY).catch(() => null);
    return res.status(200).json({
      ok: true, date: today, rule: TAPE_RULE, everyMin: TAPE_EVERY_MIN, watch,
      boards: Object.fromEntries(syms.map((s, i) => [s, latestBoard(tapes[i])])),
      summary: { QQQ: scoreSummary(agg, 'QQQ'), SPY: scoreSummary(agg, 'SPY'), watch: scoreSummary(agg, 'watch') },
      graded: graded ? { date: graded.date, rows: graded.rows } : null,
      health: health ? { at: health.at, usage: health.usage } : null,
      uwConfigured: uwConfigured(),
    });
  }

  return res.status(400).json({ ok: false, error: 'tape must be capture, score, read or watch' });
}
