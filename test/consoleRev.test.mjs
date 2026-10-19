// test/consoleRev.test.mjs — a Console save from a stale copy is refused (lib/consoleRev.js,
// api/manual-entry.js). The handler runs against a Redis stand-in; the rows are made up.
import { readFileSync } from 'node:fs';
import { saveCheck, revOf, nextRev } from '../lib/consoleRev.js';
import { mintSession, sessionCookie } from '../lib/session.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// ── The rule ──
eq('no stored copy: any save starts the count', [saveCheck(null, undefined), saveCheck(null, 0)], [{ ok: true, rev: 1, legacy: true }, { ok: true, rev: 1 }]);
eq('a stored copy from before revisions: an old tab may still save, once', saveCheck({ rows: [] }, undefined), { ok: true, rev: 1, legacy: true });
eq('the copy this tab read: saved, one revision on', saveCheck({ rev: 4 }, 4), { ok: true, rev: 5 });
const stale = saveCheck({ rev: 6, updatedAt: '2026-10-16T21:05:00.000Z' }, 4);
eq('an older copy: refused, with the current revision and when it changed', [stale.ok, stale.status, stale.current, stale.reason, /21:05 UTC/.test(stale.error)], [false, 409, 6, 'stale', true]);
const old = saveCheck({ rev: 2 }, undefined);
eq('no revision once revisions exist: an old tab, told to reload', [old.ok, old.status, old.reason, /Reload/.test(old.error)], [false, 409, 'no-revision', true]);
eq('a revision that is not a whole number is a bad request', saveCheck({ rev: 2 }, 'x').status, 400);
eq('revOf reads what is there and nothing else', [revOf(null), revOf({ rev: 3 }), revOf({ rev: -1 }), revOf({ rev: 'x' })], [0, 3, 0, 0]);
eq('the IBKR sync stamps the next one', [nextRev(null), nextRev({ rev: 9 })], [1, 10]);
eq('the IBKR sync does stamp it on its console write', /rows: \[\.\.\.merged, \.\.\.fresh\], settings, updatedAt: new Date\(\)\.toISOString\(\), rev: nextRev\(stored\)/.test(readFileSync('api/flex-sync.js', 'utf8')), true);

// ── Through the route ──
const mem = new Map();
const redis = ([cmd, key, ...rest]) => {
  switch (String(cmd).toUpperCase()) {
    case 'GET': return mem.has(key) ? mem.get(key) : null;
    case 'SET': mem.set(key, rest[0]); return 'OK';
    case 'EXPIRE': return 1;
    default: return null;
  }
};
process.env.KV_REST_API_URL = 'https://stand-in.upstash.io';
process.env.KV_REST_API_TOKEN = 'stand-in';
process.env.GITHUB_TOKEN = 'unused'; process.env.GITHUB_REPO = 'x/y';
process.env.DASHBOARD_PASSWORD = 'session-secret-for-tests';
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith(process.env.KV_REST_API_URL)) return { ok: true, status: 200, json: async () => ({ result: redis(JSON.parse(init.body)) }) };
  // The data file on GitHub: there is none here.
  if (/api\.github\.com/.test(String(url))) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  throw new Error(`unexpected network call in a test: ${url}`);
};
const { CONSOLE_KEY } = await import('../lib/kv.js');
const { default: entry } = await import('../api/manual-entry.js');
const cookie = sessionCookie(await mintSession(process.env.DASHBOARD_PASSWORD)).split(';')[0];
const save = async (consoleIn) => {
  const out = { code: 0, body: null };
  const res = { status(c) { out.code = c; return res; }, json(b) { out.body = b; return res; }, setHeader() {}, end() { return res; } };
  await entry({ method: 'POST', query: {}, headers: { host: 'x', cookie, 'content-type': 'application/json' }, body: { console: consoleIn } }, res);
  return out;
};
const row = (id, price) => ({ id, symbol: 'XYZ', currency: 'USD', levels: [], tags: [], fills: [{ id: 'f1', side: 'buy', qty: 1, price, date: '2026-10-01' }] });
const stored = () => JSON.parse(mem.get(CONSOLE_KEY));

mem.set(CONSOLE_KEY, JSON.stringify({ rows: [row('XYZ-a', 10)], settings: {} }));
const first = await save({ rows: [row('XYZ-a', 11)] });
eq('the first save after this ships: accepted, revision 1', [first.code, first.body.console.stored, first.body.console.rev, stored().rev], [200, 'kv', 1, 1]);
const second = await save({ rows: [row('XYZ-a', 12)], baseRev: 1 });
eq('a save from the copy it read: accepted, revision 2', [second.code, second.body.console.rev, stored().rows[0].fills[0].price], [200, 2, 12]);

// The IBKR sync writes in between (a new revision), and a tab still holding revision 2 saves.
mem.set(CONSOLE_KEY, JSON.stringify({ ...stored(), rows: [row('XYZ-a', 12), row('ABC-b', 5)], rev: 3, updatedAt: '2026-10-16T21:05:00.000Z' }));
const refused = await save({ rows: [row('XYZ-a', 13)], baseRev: 2 });
eq('a save from the older copy is refused and the newer copy is untouched',
  [refused.code, refused.body.console.stored, refused.body.console.reason, refused.body.console.rev, stored().rows.map(r => r.id), stored().rev],
  [409, 'refused', 'stale', 3, ['XYZ-a', 'ABC-b'], 3]);
const oldTab = await save({ rows: [row('XYZ-a', 13)] });
eq('a tab with no revision at all is refused too, now that one exists', [oldTab.code, oldTab.body.console.reason, stored().rev], [409, 'no-revision', 3]);
const overwrite = await save({ rows: [row('XYZ-a', 13)], baseRev: 3 });
eq('overwriting on purpose (against the revision the server holds) goes through', [overwrite.code, overwrite.body.console.rev, stored().rows.length], [200, 4, 1]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
