// lib/docBackup.js — the nightly copy of dvcap's Redis documents (build step 6).
//
// Redis is the system of record (lib/docStore.js). This keeps a dated, diffable history of it
// without touching main: one file, `dvcap-docs.json`, committed to the `data-backup` branch, once a
// night and only when something changed. vercel.json's ignoreCommand skips a build for that branch,
// so a backup is never a deployment.
//
// RESTORE: copy a document out of the file (git show data-backup:dvcap-docs.json) and write it to
// its Redis key (DOCS[name].key) — or delete the key, and readDoc falls back to the committed seed.
//
// What is in it: the curated documents only (DOCS). Never the trade console, fills or anything
// private: the repository is public, and so is this branch.
import { createHash } from 'node:crypto';
import { DOCS, readDoc } from './docStore.js';

export const BACKUP_BRANCH = 'data-backup';
export const BACKUP_PATH = 'dvcap-docs.json';
export const BACKUP_STATE_KEY = 'dvcap:doc:backup:v1';

export function backupPayload(docs, now = new Date()) {
  const ordered = Object.fromEntries(Object.keys(docs).sort().map(k => [k, docs[k]]));
  const body = JSON.stringify(ordered);
  return { hash: createHash('sha256').update(body).digest('hex').slice(0, 16), file: { at: now.toISOString(), docs: ordered } };
}

const gh = (env) => ({
  Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
  'User-Agent': 'dvcap-doc-backup', 'Content-Type': 'application/json',
});

// Make sure the branch exists (created from main the first time).
async function ensureBranch({ env, fetchImpl }) {
  const base = `https://api.github.com/repos/${env.GITHUB_REPO}`;
  const head = await fetchImpl(`${base}/git/ref/heads/${BACKUP_BRANCH}`, { headers: gh(env) });
  if (head.ok) return { ok: true, created: false };
  if (head.status !== 404) return { ok: false, why: `GitHub answered ${head.status} for the branch` };
  const main = await fetchImpl(`${base}/git/ref/heads/${env.GITHUB_BRANCH || 'main'}`, { headers: gh(env) });
  if (!main.ok) return { ok: false, why: `GitHub answered ${main.status} for main` };
  const sha = (await main.json())?.object?.sha;
  const made = await fetchImpl(`${base}/git/refs`, { method: 'POST', headers: gh(env), body: JSON.stringify({ ref: `refs/heads/${BACKUP_BRANCH}`, sha }) });
  return made.ok ? { ok: true, created: true } : { ok: false, why: `GitHub refused the branch (${made.status})` };
}

// One run. `read(name)` and `kv` are injectable; the defaults read Redis.
export async function backupDocs({ env = process.env, fetchImpl = fetch, kv, read = (n) => readDoc(n), now = new Date() } = {}) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return { ok: false, why: 'GITHUB_TOKEN / GITHUB_REPO not configured' };
  const docs = {}, from = {};
  for (const name of Object.keys(DOCS)) {
    const r = await read(name);
    // Belt and braces: a console must never reach a public branch, even from an old document.
    const { console: _never, ...doc } = r.doc && typeof r.doc === 'object' ? r.doc : {};
    docs[name] = doc; from[name] = r.from;
  }
  // Nothing in Redis yet means the seed is still the record — and the seed is already on main.
  if (Object.values(from).every(f => f === 'seed')) return { ok: true, skipped: 'every document is still its committed seed' };
  const { hash, file } = backupPayload(docs, now);
  const last = kv ? await kv.get(BACKUP_STATE_KEY).catch(() => null) : null;
  if (last?.hash === hash) return { ok: true, skipped: 'unchanged since the last backup', at: last.at };

  const br = await ensureBranch({ env, fetchImpl });
  if (!br.ok) return { ok: false, why: br.why };
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${BACKUP_PATH}`;
  const cur = await fetchImpl(`${url}?ref=${BACKUP_BRANCH}`, { headers: gh(env) });
  const sha = cur.ok ? (await cur.json())?.sha : null;
  const content = Buffer.from(JSON.stringify(file, null, 2) + '\n', 'utf8').toString('base64');
  const w = await fetchImpl(url, { method: 'PUT', headers: gh(env), body: JSON.stringify({
    message: `Backup — dvcap documents @ ${now.toISOString().slice(0, 10)}`, content, branch: BACKUP_BRANCH, ...(sha ? { sha } : {}) }) });
  if (!w.ok) return { ok: false, why: `GitHub refused the backup (${w.status})` };
  if (kv) await kv.set(BACKUP_STATE_KEY, { hash, at: now.toISOString() }).catch(() => null);
  return { ok: true, hash, branchCreated: br.created, docs: Object.keys(docs), from };
}
