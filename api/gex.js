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
import { captureGex, readGex, GEX_SYMBOLS } from '../lib/gexStore.js';

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
    const out = await captureGex({ symbols, dry: req.query?.dry === '1', session });
    return res.status(200).json(out);
  }

  const symbol = String(req.query?.symbol || 'QQQ').toUpperCase();
  if (!GEX_SYMBOLS.includes(symbol)) return res.status(400).json({ error: `unknown symbol ${symbol}` });
  return res.status(200).json(await readGex(symbol));
}
