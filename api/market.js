// api/market.js — market data: quotes (/api/prices), bars, ATR and filings (/api/atr), and the
// Unusual Whales flow snapshot (/api/flow). prices and atr are public by declaration
// (scripts/check-api-auth.mjs); flow gates every data answer itself (lib/routes/flow.js: licensed
// for personal use, so the dashboard session or the service key only).
// The routes live in lib/routes/; lib/routes/dispatch.js says why they share one function.
import prices from '../lib/routes/prices.js';
import atr from '../lib/routes/atr.js';
import flow from '../lib/routes/flow.js';
import { dispatch } from '../lib/routes/dispatch.js';

export default dispatch('market', { prices, atr, flow });
