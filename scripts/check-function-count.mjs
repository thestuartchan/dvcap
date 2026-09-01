// Vercel's Hobby plan caps a deployment at 12 Serverless Functions. Exceed it and the deployment
// does not ship — the previous build keeps serving, so the site looks fine while the new routes
// 404 and nothing anywhere names the cause. That is exactly how the GEX module appeared to deploy
// and did not: /api/atr answered 200 from the old build while /api/gex and /api/gex-snapshot were
// simply absent.
//
// A limit you find out about by deploying is a limit you find out about too late, so it is checked
// here instead.
import { readdirSync } from 'node:fs';

const LIMIT = 12;   // Vercel Hobby
const fns = readdirSync('api').filter(f => f.endsWith('.js')).sort();

if (fns.length > LIMIT) {
  console.error(`✖ function-count check FAILED — ${fns.length} serverless functions, Vercel Hobby allows ${LIMIT}:`);
  for (const f of fns) console.error(`    api/${f}`);
  console.error('  The deployment will NOT ship and the previous build will keep serving.');
  console.error('  Merge two routes into one with a mode parameter, as api/gex.js does.');
  process.exit(1);
}
const headroom = LIMIT - fns.length;
console.log(`✔ function-count check passed (${fns.length}/${LIMIT} serverless functions`
  + `${headroom === 0 ? ' — AT THE CAP, the next route must merge into an existing one' : `, ${headroom} spare`})`);
