#!/usr/bin/env node
// scripts/check-env-independent.mjs — the test suite must give the same answer in every environment.
//
// WHY THIS EXISTS. Vercel injects the deployment's environment variables into the BUILD, and the
// build runs `npm test` in prebuild. So a test that reads ambient configuration is not testing the
// code — it is testing the deployment it happens to be built by.
//
// On 2026-09-07 that took production down. test/hyperliquid.test.mjs asserted that an unset address
// reports `configured: false`, and expressed it as `fetchHlAccount({ address: undefined })` —
// which, because passing `undefined` explicitly still triggers a default parameter, read
// process.env.HYPERLIQUID_ADDRESS. Locally that is empty and it passed for days. The hour the
// variable was added in Vercel, every PRODUCTION build began failing there in about seven seconds
// while PREVIEW builds — a different variable set — stayed green. Two merges sat in main
// undeployed, one of them a security fix, with the site serving the build before them and no
// failing check anywhere on either pull request.
//
// The tell was the shape, not the log: same commit, green as a preview and red as production, is
// always configuration and never code.
//
// WHAT IT DOES. Runs the suite a second time with every variable the deployed code reads set to a
// dummy value. `npm test` has already run it with them absent, so between the two passes any test
// whose answer depends on the environment fails one of them.
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Every variable lib/, api/ and the middleware actually read — both `process.env.NAME` and the
// `process.env[CONST]` form, whose value is declared next to it as `export const CONST = 'NAME'`.
const sources = [
  ...readdirSync('lib').filter(f => f.endsWith('.js')).map(f => `lib/${f}`),
  ...readdirSync('api').filter(f => f.endsWith('.js')).map(f => `api/${f}`),
  'middleware.js',
];
const names = new Set();
for (const f of sources) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export const [A-Z_]+ = '([A-Z_][A-Z0-9_]*)'/g)) names.add(m[1]);
}
// The service-key list is a literal array rather than one constant per name.
for (const m of readFileSync('lib/apiauth.js', 'utf8').matchAll(/'([A-Z_]{4,})'/g)) names.add(m[1]);

const env = { ...process.env };
for (const n of names) env[n] = env[n] || 'check-env-independent-dummy';

const failed = [], broken = [];
const clean = { ...process.env };
for (const n of names) delete clean[n];

for (const f of readdirSync('test').filter(f => f.endsWith('.test.mjs'))) {
  let out;
  try {
    execFileSync('node', [`test/${f}`], { env, stdio: 'pipe', encoding: 'utf8' });
    continue;                                     // passes with the variables set: nothing to say
  } catch (e) { out = String(e.stdout || ''); }
  // IT FAILED WITH THEM SET. That is not yet a finding — the file might simply be broken, and
  // saying "this passes clean and fails with variables set" without having run it clean is a
  // diagnosis rather than an observation. The first version of this script did exactly that and
  // was wrong the first time it fired, on a test that was failing both ways.
  const why = out.split('\n').filter(l => l.includes('❌')).slice(0, 3)
                 .map(l => `        ${l.trim()}`).join('\n');
  try {
    execFileSync('node', [`test/${f}`], { env: clean, stdio: 'pipe', encoding: 'utf8' });
    failed.push(`test/${f}\n${why}`);            // passes clean, fails set — environment-dependent
  } catch {
    broken.push(`test/${f}`);                     // fails either way — an ordinary failure
  }
}

if (broken.length) {
  console.error(`✖ env-independence check could not run — ${broken.length} test file${broken.length === 1 ? '' : 's'} fail with or without the variables:`);
  for (const f of broken) console.error(`    ${f}`);
  console.error('  These are ordinary failures, not environment dependence. `npm test` reports them.');
  process.exit(1);
}
if (failed.length) {
  console.error(`✖ env-independence check FAILED — ${failed.length} test file${failed.length === 1 ? '' : 's'} read the environment:`);
  for (const f of failed) console.error(`    ${f}`);
  console.error('  Each PASSES with the variables unset and FAILS with them set — verified both ways.');
  console.error('  So it would pass as a preview build and fail as a production one. Save, delete,');
  console.error('  assert, restore — see the block in test/hyperliquid.test.mjs.');
  process.exit(1);
}
console.log(`✔ env-independence check passed (suite re-run with ${names.size} deployment variables set)`);
