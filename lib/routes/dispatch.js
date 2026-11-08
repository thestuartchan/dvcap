// lib/routes/dispatch.js — one Vercel function serving several routes of one domain.
//
// WHY. Vercel Hobby deploys at most 12 functions, and a 13th silently fails the deployment
// (scripts/check-function-count.mjs). Routes are grouped by domain instead — market data, macro
// reads, hand-kept inputs — each group one function, each route one module in lib/routes/.
//
// THE OLD URLS STAY. vercel.json rewrites /api/prices → /api/market?route=prices and so on, and
// Vercel passes the original query string through, so every caller (the dashboard, the scheduler,
// workflows, Claude tasks) keeps calling the path it always called. `route` is removed from
// req.query before the handler runs, so a handler sees exactly the query it saw before.
//
// ROUTES lists every grouped route and the function serving it; vercel.json's rewrites are
// checked against it in test/routeDispatch.test.mjs.
export const ROUTES = Object.freeze({
  prices:         'market',
  atr:            'market',
  flow:           'market',
  indicators:     'macro',
  playbook:       'macro',
  'manual-entry': 'inputs',
  'korea-save':   'inputs',
  login:          'inputs',
});

export function dispatch(fn, handlers) {
  return async function handler(req, res) {
    const route = req.query?.route;
    const h = typeof route === 'string' && Object.hasOwn(handlers, route) ? handlers[route] : null;
    if (!h) {
      res.status(404).json({ error: `unknown route for /api/${fn}`, routes: Object.keys(handlers).map(r => `/api/${r}`) });
      return;
    }
    delete req.query.route;
    return h(req, res);
  };
}
