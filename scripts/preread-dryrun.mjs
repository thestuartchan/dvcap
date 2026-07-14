// Local dry-run for the Asia/EU/US Pre-Read — no Vercel CLI needed.
// Usage:  node --env-file=.env.local scripts/preread-dryrun.mjs [asia|eu|us] [post]
//   - loads .env.local (FRED_API_KEY, ANTHROPIC_API_KEY, DISCORD_WEBHOOK) via Node's --env-file
//   - calls the real api/preread.js handler with a mocked req/res
//   - prints the Discord message, the regime JSON, and a per-quote src/stale audit
// Passing "post" as the 2nd arg sets ?post=1 (actually hits the Discord webhook).

import handler from '../api/preread.js';

const region = (process.argv[2] || 'asia').toLowerCase();
const post = process.argv[3] === 'post' ? '1' : undefined;

// --- fail fast on missing keys, so we don't get a confusing API error ---
const missing = [];
if (!process.env.FRED_API_KEY) missing.push('FRED_API_KEY');
if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
if (post && !process.env.DISCORD_WEBHOOK) missing.push('DISCORD_WEBHOOK (needed for post)');
if (missing.length) {
  console.error(`\n✖ Missing env var(s): ${missing.join(', ')}`);
  console.error('  Add them to .env.local, then re-run.\n');
  process.exit(1);
}

// --- mock the Vercel req/res the handler expects ---
const req = { query: { region, ...(post ? { post } : {}) } };
let captured = { status: 200, body: null };
const res = {
  status(code) { captured.status = code; return this; },
  json(obj) { captured.body = obj; return this; },
};

console.log(`\n▶ Dry-run: region=${region}${post ? ' (POSTING to Discord)' : ' (no post)'}\n`);

try {
  await handler(req, res);
} catch (e) {
  console.error('✖ Handler threw:', e);
  process.exit(1);
}

const { status, body } = captured;
if (status !== 200) {
  console.error(`✖ Handler returned status ${status}:`, body);
  process.exit(1);
}

// --- 1) the Discord-ready message, exactly as it would post ---
console.log('════════ MESSAGE ════════\n');
console.log(body.message);

// --- 2) regime JSON ---
console.log('\n════════ REGIME (computed) ════════\n');
console.log(JSON.stringify(body.regime, null, 2));

// --- 3) Discord post result (only when 'post' was requested) ---
if (body.posted != null) {
  console.log('\n════════ DISCORD POST ════════\n');
  console.log(body.posted.ok
    ? `✔ posted OK (HTTP ${body.posted.status})`
    : `✖ POST FAILED — ${JSON.stringify(body.posted)}`);
}

console.log(`\n✔ handler status ${status} · generatedAt ${body.generatedAt}`);
console.log('  (Review the ⚠️ stale flags above — oil should read yahoo-oil, not a laundered close.)\n');
