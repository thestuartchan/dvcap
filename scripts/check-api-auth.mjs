#!/usr/bin/env node
// scripts/check-api-auth.mjs — every route that can read or write private state must gate itself.
//
// middleware.js matches `/` and nothing else, so the login page protects the DASHBOARD and none of
// the API beneath it. Three routes were open in production on 2026-09-06 — the trade console with
// its fills and account equity, the IBKR account, and the endpoint that posts the Discord card —
// and each was open for the same reason: nobody was checking that they checked.
//
// A route is exempt only by being named here, with a reason, which is a decision someone makes on
// purpose rather than an omission nobody sees.
import { readdirSync, readFileSync } from 'node:fs';

const PUBLIC = {
  'login.js':      'issues the session cookie — it is the thing you call before you have one',
  'prices.js':     'market quotes only, edge-cached and shared; carries nothing about the account',
  'indicators.js': 'public macro series (FRED, Yahoo); no account state',
  'gex.js':        'options-chain aggregates for public tickers; no account state',
  'atr.js':        'price bars for a public ticker; no account state',
  'playbook.js':   'the composed regional read; no positions and no sizes',
  'preread.js':    'the composed brief; deliberately reachable so a run can be triggered by hand',
};

const files = readdirSync('api').filter(f => f.endsWith('.js')).sort();
const open = [];
for (const f of files) {
  if (PUBLIC[f]) continue;
  // Comments are stripped first. The first version of this flagged api/tradecard.js for the
  // fail-open pattern quoted in the comment ABOVE the fix that removed it — a checker that reads
  // prose as code will be argued with until it is switched off.
  const raw = readFileSync(`api/${f}`, 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const gated = /authorised\s*\(|hasSessionCookie\s*\(|mwd_auth/.test(src);
  if (!gated) open.push(f);
  // Fail-open is not a gate. `if (!want) return true` turns a missing variable into an open door.
  if (/if\s*\(\s*!\s*want\s*\)\s*return\s+true/.test(src)) open.push(`${f} (fails OPEN when its secret is unset)`);
}

if (open.length) {
  console.error(`✖ api-auth check FAILED — ${open.length} route${open.length === 1 ? '' : 's'} not gated:`);
  for (const f of open) console.error(`    api/${f}`);
  console.error('  Add authorised(req) from lib/apiauth.js, or list it in PUBLIC here with a reason.');
  process.exit(1);
}
console.log(`✔ api-auth check passed (${files.length - Object.keys(PUBLIC).length} gated, ${Object.keys(PUBLIC).length} public by declaration)`);
