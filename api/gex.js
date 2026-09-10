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
import { kvConfigured } from '../lib/kv.js';
import { captureGex, readGex, settledGex, GEX_SYMBOLS } from '../lib/gexStore.js';

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
  if (String(req.query?.settled || '') === '1') {
    const syms = String(req.query?.symbols || req.query?.symbol || '').trim()
      ? String(req.query.symbols || req.query.symbol).split(',').map(x => x.trim().toUpperCase()).filter(Boolean)
      : GEX_SYMBOLS;
    const bad = syms.filter(x => !GEX_SYMBOLS.includes(x));
    if (bad.length) return res.status(400).json({ error: `unknown symbol ${bad.join(', ')}` });
    const spotIn = Number(req.query?.spot);
    const results = [];
    for (const sym of syms) {
      // The stored row's expiries, so the settled map covers the same book as the series it sits
      // beside — otherwise the two disagree about the flip for reasons that are about coverage.
      const stored = await readGex(sym).catch(() => null);
      const out = await settledGex(sym, {
        spot: Number.isFinite(spotIn) && spotIn > 0 && syms.length === 1 ? spotIn : null,
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
