// Regression tests for lib/kv.js credential discovery.
// Vercel's Upstash integration lets the user choose ANY env-var prefix at install time, so a
// hard-coded name would leave the console silently unsynced — a failure indistinguishable from
// "not installed". Discovery must find the REST credentials whatever they are called, and must
// never accept the rediss:// protocol URL that fetch() cannot use.
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = g === w; console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${g} want ${w}`)); ok ? pass++ : fail++; };

const CASES = [
  ['canonical KV names',   { KV_REST_API_URL: 'https://a.upstash.io', KV_REST_API_TOKEN: 't' }, true],
  ['UPSTASH_ prefix',      { UPSTASH_REDIS_REST_URL: 'https://a.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' }, true],
  ['STORAGE_ prefix',      { STORAGE_REST_API_URL: 'https://a.upstash.io', STORAGE_REST_API_TOKEN: 't' }, true],
  ['REDIS_ prefix',        { REDIS_REST_API_URL: 'https://a.upstash.io', REDIS_REST_API_TOKEN: 't' }, true],
  ['protocol URL only',    { KV_URL: 'rediss://default:pw@a.upstash.io:6379' }, false],
  ['protocol + REST mixed',{ STORAGE_URL: 'rediss://default:pw@a.upstash.io:6379', STORAGE_REST_API_URL: 'https://a.upstash.io', STORAGE_REST_API_TOKEN: 't' }, true],
  ['url without token',    { KV_REST_API_URL: 'https://a.upstash.io' }, false],
  ['non-upstash host',     { KV_REST_API_URL: 'https://evil.example.com', KV_REST_API_TOKEN: 't' }, false],
  ['nothing set',          {}, false],
];

for (const [name, env, want] of CASES) {
  for (const k of Object.keys(process.env)) if (/UPSTASH|KV_|STORAGE|REDIS/.test(k)) delete process.env[k];
  Object.assign(process.env, env);
  const m = await import('../lib/kv.js?v=' + Math.random());
  eq(name, m.kvConfigured(), want);
}
console.log(fail ? `\n❌ ${fail} FAILED` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
