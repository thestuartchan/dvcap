// api/atr.js — daily ATR per symbol, for the pre-trade guard panel.
//
// SEPARATE FROM /api/prices ON PURPOSE. Price is a 2-minute number and the console refetches it
// on every symbol change; ATR is a DAILY one computed from a year of bars. Putting it on the hot
// path would mean pulling 250 bars per symbol every couple of minutes to recompute a figure that
// cannot have moved. This route caches for six hours and serves last-good for a day.
//
// FUTURES: pass the SPECIFIC CONTRACT (MGCZ26=F), never the continuous symbol (GC=F). A roll gap
// is a discontinuity between two different instruments and true range scores it as a real day's
// move — measured, it inflates ATR to 2.4x on the day and is still a third too wide a trading
// month later, which is exactly the month the new contract is being sized in.
import { yahooDailyOHLCDetailed } from '../lib/yahoo.js';
import { atrSummary, ATR_PERIOD } from '../lib/atr.js';

const MAX_SYMBOLS = 24;   // the console asks for its open rows, not a universe

export default async function handler(req, res) {
  const { tickers, period } = req.query || {};
  if (!tickers) return res.status(400).json({ error: 'Missing tickers' });
  const list = [...new Set(String(tickers).split(',').map(t => t.trim()).filter(Boolean))].slice(0, MAX_SYMBOLS);
  const p = Number.isFinite(+period) && +period > 1 ? Math.trunc(+period) : ATR_PERIOD;

  const out = {};
  for (let i = 0; i < list.length; i++) {
    // Same 120ms stagger as api/prices.js — the keyless endpoint refuses a burst.
    if (i > 0) await new Promise(r => setTimeout(r, 120));
    const sym = list[i];
    try {
      const d = await yahooDailyOHLCDetailed(sym, '1y');
      if (!d.ok) { out[sym] = { status: d.status, httpStatus: d.httpStatus ?? null, error: d.error ?? null }; continue; }
      const s = atrSummary(d.bars, p);
      // EVERY SYMBOL GETS A KEY. Omitting it made "we could not reach Yahoo", "Yahoo has never
      // heard of this ticker" and "this listed three weeks ago" identical to the client, which
      // then had one sentence for all three. A status is always present; `atr` may be null.
      out[sym] = s.atr != null
        ? { status: 'ok', ...s }
        : { status: 'short-history', bars: d.bars.length, needed: p + 1, period: p };
    } catch (e) {
      out[sym] = { status: 'fetch-failed', error: String(e?.name || e).slice(0, 60) };
    }
  }

  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
  return res.status(200).json(out);
}
