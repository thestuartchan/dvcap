// api/market.js — market data: quotes (/api/prices) and bars, ATR and filings (/api/atr).
// Public by declaration (scripts/check-api-auth.mjs): public tickers only, no account state.
// The routes live in lib/routes/; lib/routes/dispatch.js says why they share one function.
import prices from '../lib/routes/prices.js';
import atr from '../lib/routes/atr.js';
import { dispatch } from '../lib/routes/dispatch.js';

export default dispatch('market', { prices, atr });
