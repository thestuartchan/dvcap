// test/docStore.test.mjs — Redis as the system of record (lib/docStore.js) and its nightly backup
// to the data-backup branch (lib/docBackup.js). Build step 6: no data commits on main.
import { readFileSync } from 'node:fs';
import { DOCS, readDoc, writeDoc } from '../lib/docStore.js';
import { backupDocs, backupPayload, BACKUP_BRANCH, BACKUP_PATH, BACKUP_STATE_KEY } from '../lib/docBackup.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const memKv = (on = true) => { const m = new Map(); return { m, configured: () => on, get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); return true; } }; };

// ── Reads and writes ──
{
  const off = memKv(false);
  const r = await readDoc('manual', { kv: off });
  eq('no Redis: the committed file is the seed', [r.from, !!r.doc.fedPath], ['seed', true]);
  eq('no Redis: a write says it did not save', await writeDoc('manual', { x: 1 }, { kv: off }), false);
  const kv = memKv();
  eq('Redis empty: still the seed', (await readDoc('regime', { kv })).from, 'seed');
  eq('a write lands in its own key', [await writeDoc('regime', { rows: [{ date: '2026-11-09' }] }, { kv }), kv.m.has(DOCS.regime.key)], [true, true]);
  const back = await readDoc('regime', { kv });
  eq('and is what the next read returns', [back.from, back.doc.rows[0].date], ['redis', '2026-11-09']);
  const a = await readDoc('manual', { kv }); a.doc.fedPath = 'mutated';
  eq('a seed read is a copy: mutating it changes nothing', (await readDoc('manual', { kv })).doc.fedPath === 'mutated', false);
  let threw = false; try { await readDoc('nope', { kv }); } catch { threw = true; }
  eq('an unknown document is refused', threw, true);
}

// ── Backup ──
const res = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const env = { GITHUB_TOKEN: 't', GITHUB_REPO: 'owner/repo' };
const docsRead = (over = {}) => async (n) => ({ doc: over[n] ?? { n }, from: 'redis' });
{
  eq('the payload hash ignores key order', backupPayload({ a: 1, b: 2 }).hash, backupPayload({ b: 2, a: 1 }).hash);
  eq('and changes with the content', backupPayload({ a: 1 }).hash === backupPayload({ a: 2 }).hash, false);
  eq('no token: no backup, and it says why', (await backupDocs({ env: {}, read: docsRead() })).why, 'GITHUB_TOKEN / GITHUB_REPO not configured');
  eq('everything still on its seed: nothing to back up', (await backupDocs({ env, read: async () => ({ doc: {}, from: 'seed' }) })).skipped, 'every document is still its committed seed');
}
{
  const calls = []; const kv = memKv();
  const fetchImpl = async (url, o = {}) => {
    calls.push([o.method || 'GET', url.replace('https://api.github.com/repos/owner/repo', ''), o.body ? JSON.parse(o.body) : null]);
    if (url.endsWith(`/git/ref/heads/${BACKUP_BRANCH}`)) return res(404);
    if (url.endsWith('/git/ref/heads/main')) return res(200, { object: { sha: 'abc' } });
    if (url.endsWith('/git/refs')) return res(201);
    if (url.includes(`/contents/${BACKUP_PATH}?ref=`)) return res(404);
    if (url.endsWith(`/contents/${BACKUP_PATH}`)) return res(201);
    return res(500);
  };
  const r = await backupDocs({ env, fetchImpl, kv, read: docsRead({ manual: { fedPath: 1, console: { rows: ['PRIVATE'] } } }), now: new Date('2026-11-09T23:10:00Z') });
  eq('first run: the branch is created from main', [r.ok, r.branchCreated, calls.find(c => c[1] === '/git/refs')?.[2]], [true, true, { ref: `refs/heads/${BACKUP_BRANCH}`, sha: 'abc' }]);
  const put = calls.find(c => c[0] === 'PUT');
  eq('one file, on the backup branch, never main', [put[1], put[2].branch], [`/contents/${BACKUP_PATH}`, BACKUP_BRANCH]);
  const file = JSON.parse(Buffer.from(put[2].content, 'base64').toString('utf8'));
  eq('it carries every document', Object.keys(file.docs), Object.keys(DOCS).sort());
  eq('and never a console, even if a document had one', JSON.stringify(file).includes('PRIVATE'), false);
  eq('the hash is remembered', kv.m.get(BACKUP_STATE_KEY)?.hash, r.hash);
  calls.length = 0;
  const again = await backupDocs({ env, fetchImpl, kv, read: docsRead({ manual: { fedPath: 1 } }) });
  eq('unchanged the next night: no commit at all', [again.skipped, calls.length], ['unchanged since the last backup', 0]);
}
{
  const fetchImpl = async (url, o = {}) => {
    if (url.endsWith(`/git/ref/heads/${BACKUP_BRANCH}`)) return res(200);
    if (url.includes(`/contents/${BACKUP_PATH}?ref=`)) return res(200, { sha: 'old' });
    if (o.method === 'PUT') return res(409);
    return res(500);
  };
  const r = await backupDocs({ env, fetchImpl, kv: memKv(), read: docsRead() });
  eq('a refused commit is a failure that says so, never a throw', [r.ok, r.why], [false, 'GitHub refused the backup (409)']);
}

// ── Nothing commits these documents to main any more ──
const strip = (p) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
eq('the regime log no longer writes through the contents API', /contents\//.test(strip('lib/regimeLog.js')), false);
eq('manual-entry writes its document to Redis', strip('lib/routes/manual-entry.js').includes("writeDoc('manual'"), true);
eq('manual-entry no longer reads or writes data/manual_entry.json on GitHub', /manual_entry\.json/.test(strip('lib/routes/manual-entry.js')), false);
eq('no server module bakes the manual store in at build time', ['lib/assemble.js', 'api/preread.js'].some(p => /manual_entry\.json/.test(strip(p))), false);
const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
eq('a backup commit is never a deployment', vercel.ignoreCommand, '[ "$VERCEL_GIT_COMMIT_REF" = "data-backup" ]');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
