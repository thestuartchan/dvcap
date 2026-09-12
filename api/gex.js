// api/gex.js — ONE function, two modes.
//
// It was two routes. Vercel's Hobby plan caps a deployment at 12 Serverless Functions and this
// project has exactly 12 with them merged; as two it was 13 and the entire deployment stopped
// shipping, leaving the previous build live. /api/atr answered 200 while both GEX routes 404'd and
// nothing announced the cause. Splitting them again means finding that out the hard way a second
// time, so the mode is a query parameter and the work lives in lib/gexStore.js.
//
//   GET /api/gex?symbol=QQQ          read the stored series (default)
//   GET /api/gex?snapshot=1[&dry=1]  capture today's chain — the cron target
import { kvConfigured, kvGetJson } from '../lib/kv.js';
import { captureGex, readGex, settledGex, observeRoll, OCC_ROLL_LOG_KEY, OCC_HEALTH_KEY, GEX_SYMBOLS } from '../lib/gexStore.js';
import { getQuotes } from '../lib/quotes.js';
import { marketState } from '../lib/sessions.js';
import { rollSummary, OCC_CONFIRM_MIN } from '../lib/occ.js';
import { healthSummary, transitionRuns, confirmMinVerdict } from '../lib/occHealth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!kvConfigured()) return res.status(200).json({ available: false, ok: false, reason: 'KV not configured' });

  if (String(req.query?.snapshot || '') === '1') {
    const symbols = String(req.query?.symbols || '').trim()
      ? String(req.query.symbols).split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
      : GEX_SYMBOLS;
    // `session` lets the workflow be explicit rather than relying on the clock; `dry=1` computes
    // and returns without writing, which is what the panel's live-refresh button uses.
    const session = ['open', 'close'].includes(String(req.query?.session || '')) ? String(req.query.session) : null;
    // The CBOE cross-check runs by default and can be turned off for a fast read — it is a 4-5MB
    // CDN fetch, which is cheap but not free, and a caller that only wants the flip should not pay
    // for a second opinion it is going to ignore.
    const compare = String(req.query?.compare ?? '') !== '0';
    const out = await captureGex({ symbols, dry: req.query?.dry === '1', session, compare });
    return res.status(200).json(out);
  }

  // GET /api/gex?settled=1&symbol=QQQ[&spot=716.5]  — today's settled book, recomputed at a spot.
  //
  // THE PANEL'S REFRESH BUTTON HAD NOTHING GOOD TO CALL. It used ?snapshot=1&dry=1, which reads
  // Yahoo — and Yahoo serves NO open interest before the US open, so the one time of day a trader
  // reaches for a fresh gamma map was the one time it could not produce one, and the panel fell
  // back to repricing yesterday's stored chain. This reads OCC's settled open interest against
  // CBOE's implied-vol surface and recomputes gamma here at whatever spot is passed in, so a
  // refresh at 08:00 and one at 15:00 both describe today's book at the price it is trading at.
  //
  // It never writes. captureGex owns the daily series, and a second writer racing it would put two
  // vintages under one date.
  // ── THE ROLL LOG ──────────────────────────────────────────────────────────
  // `?rolls=1` reads what has been observed; `&probe=1` also TAKES an observation first, which is
  // the cheap way to sample overnight: it fetches OCC and fingerprints it and does not solve a
  // gamma profile, so it costs one 280KB fetch rather than a full recompute.
  //
  // Every settled recompute records too — this endpoint exists so a sampler does not have to pay
  // for a map nobody is going to look at.
  // ── DID WHAT WENT OUT HOLD UP? ────────────────────────────────────────────
  // The loop this closes is not "when does OCC publish" — the rung has never trusted a clock, it
  // asks the file whether it rolled. It is "has the brief ever gone out on a book that was not
  // sound, and would anyone know". Every verdict is recorded now; this reads them back.
  if (String(req.query?.health || '') === '1') {
    const days = Math.min(180, Math.max(1, Number(req.query?.days) || 30));
    const [log, rolls] = await Promise.all([
      kvGetJson(OCC_HEALTH_KEY).then(v => v || []).catch(() => []),
      kvGetJson(OCC_ROLL_LOG_KEY).then(v => v || []).catch(() => []),
    ]);
    // Per root as well as combined — transitionRuns partitions by symbol internally, but a caller
    // reading one root's write shape should not have to trust that it did.
    const runs = transitionRuns(rolls);
    return res.status(200).json({
      mode: 'health', at: new Date().toISOString(), days,
      // The whole book, and each symbol, because one symbol failing while the other is fine is a
      // different problem from both failing and a combined rate hides it.
      overall: healthSummary(log, { days }),
      bySymbol: Object.fromEntries(GEX_SYMBOLS.map(s2 => [s2, healthSummary(log, { days, symbol: s2 })])),
      // ATOMIC OR PROGRESSIVE, with no sampling grid — a settlement written in one step produces
      // one transition, one written in several produces several, and the span between the first
      // and last is the floor OCC_CONFIRM_MIN has to clear.
      write: runs,
      writeBySymbol: Object.fromEntries(GEX_SYMBOLS.map(s2 => [s2, transitionRuns(rolls, { symbol: s2 })])),
      confirmMin: confirmMinVerdict(runs, OCC_CONFIRM_MIN),
      rolls: rollSummary(rolls, { againstUtc: '12:42' }),
    });
  }

  if (String(req.query?.rolls || '') === '1') {
    const syms = String(req.query?.symbols || req.query?.symbol || '').trim()
      ? String(req.query.symbols || req.query.symbol).split(',').map(x => x.trim().toUpperCase()).filter(Boolean)
      : GEX_SYMBOLS;
    const probed = [];
    if (String(req.query?.probe || '') === '1') {
      for (const sym of syms) { try { probed.push(await observeRoll(sym)); } catch (e) { probed.push({ symbol: sym, ok: false, why: String(e?.message || e) }); } }
    }
    const log = (await kvGetJson(OCC_ROLL_LOG_KEY)) || [];
    const against = /^\d{2}:\d{2}$/.test(String(req.query?.against || '')) ? String(req.query.against) : '12:42';
    return res.status(200).json({
      mode: 'rolls', at: new Date().toISOString(), against,
      probed: probed.length ? probed : undefined,
      // Per symbol AND combined: the two roots publish together on every observation so far, and a
      // summary that merged them would hide the night they did not.
      summary: Object.fromEntries(syms.map(s => [s, rollSummary(log, { symbol: s, againstUtc: against })])),
      log,
    });
  }

  if (String(req.query?.settled || '') === '1') {
    const syms = String(req.query?.symbols || req.query?.symbol || '').trim()
      ? String(req.query.symbols || req.query.symbol).split(',').map(x => x.trim().toUpperCase()).filter(Boolean)
      : GEX_SYMBOLS;
    const bad = syms.filter(x => !GEX_SYMBOLS.includes(x));
    if (bad.length) return res.status(400).json({ error: `unknown symbol ${bad.join(', ')}` });
    // ── THE SERVER DECIDES WHAT "THE CURRENT PRICE" MEANS ────────────────────
    // The panel was fetching /api/prices and passing the result. That route returns the REGULAR
    // print and never an extended-hours one, so pre-open it handed back the PRIOR CLOSE — 716.31
    // against a live pre-market 707.94 on 2026-09-10, a 1.2% error, labelled `spotSource: caller`
    // and therefore reported in the footer as the live spot. Exactly the defect just fixed in the
    // pre-read, one layer over: the map's own symbols were being priced off a quote that has no
    // pre/post overlay.
    //
    // So the spot is resolved HERE, with the same getQuotes({ prepost }) call the pre-read uses,
    // and there is one definition of the current price rather than one per caller. An explicit
    // ?spot= still wins — it is how a caller asks "what would the book look like at X" — but
    // nothing has to pass one to get the right answer.
    const spotIn = Number(req.query?.spot);
    const resolveSpot = async (sym) => {
      if (Number.isFinite(spotIn) && spotIn > 0 && syms.length === 1) return spotIn;
      try {
        const [q] = await getQuotes([sym], { prepost: true });
        // Outside regular hours the extended print is the live one and the regular is yesterday's.
        // Inside them it is the other way round, and a stale ext must never override a live regular.
        const shut = marketState(sym) !== 'open';
        const px = (shut && q?.ext && !q.ext.stale && q.ext.price > 0) ? q.ext.price : q?.price;
        return Number.isFinite(+px) && +px > 0 ? +px : null;
      } catch { return null; }   // settledGex falls back to CBOE's, and the footer names it
    };
    const results = [];
    for (const sym of syms) {
      // The stored row's expiries, so the settled map covers the same book as the series it sits
      // beside — otherwise the two disagree about the flip for reasons that are about coverage.
      const stored = await readGex(sym).catch(() => null);
      const out = await settledGex(sym, {
        spot: await resolveSpot(sym),
        expiries: stored?.latest?.expiries || null,
      });
      results.push({ symbol: sym, ...out });
    }
    return res.status(200).json({ mode: 'settled', at: new Date().toISOString(), results });
  }

  const symbol = String(req.query?.symbol || 'QQQ').toUpperCase();
  if (!GEX_SYMBOLS.includes(symbol)) return res.status(400).json({ error: `unknown symbol ${symbol}` });
  return res.status(200).json(await readGex(symbol));
}
