// lib/docStore.js — Redis is the system of record for dvcap's curated state (build step 6).
//
// BEFORE: the regime log, the hand-kept macro inputs, the Korea readings and the Signal Board
// history were committed to the repo on every write — two routes through GitHub's contents API and
// two GitHub workflows: ~75 commits a month on main, each one a redeploy.
//
// NOW: each is one Redis document. Reads come from Redis; the committed file is only the SEED,
// served when Redis has nothing yet, so the switch loses nothing and the first write migrates it.
// The files stop changing on main. A nightly job (lib/docBackup.js) copies every document to the
// `data-backup` branch, so there is still a dated, diffable history — off main, with no redeploy.
//
// Only curated, non-private state lives here. The trade console stays in its own key
// (lib/kv.js CONSOLE_KEY) and is never in a document or a backup.
import { kvGetJson, kvSetJson, kvConfigured } from './kv.js';

export const DOCS = Object.freeze({
  manual: { key: 'dvcap:doc:manual:v1', path: 'data/manual_entry.json',
            seed: () => import('../data/manual_entry.json', { with: { type: 'json' } }) },
  regime: { key: 'dvcap:doc:regime:v1', path: 'data/regime_history.json',
            seed: () => import('../data/regime_history.json', { with: { type: 'json' } }) },
  // Korea flows and balances (lib/koreaStore.js shape): the daily fetch and the hand paste.
  kofia:  { key: 'dvcap:doc:kofia:v1', path: 'data/korea_kofia.json',
            seed: () => import('../data/korea_kofia.json', { with: { type: 'json' } }) },
  // The Signal Board's daily rows and their scores (lib/signalBoardSnapshot.js).
  signalBoard: { key: 'dvcap:doc:signal-board:v1', path: 'data/signal_board_history.json',
            seed: () => import('../data/signal_board_history.json', { with: { type: 'json' } }) },
});

const defaultKv = { configured: kvConfigured, get: kvGetJson, set: kvSetJson };
const clone = (v) => JSON.parse(JSON.stringify(v));

// { doc, from: 'redis' | 'seed' }. A copy, always: callers mutate what they read before writing it.
export async function readDoc(name, { kv = defaultKv } = {}) {
  const d = DOCS[name];
  if (!d) throw new Error(`unknown document: ${name}`);
  if (kv.configured()) {
    const v = await kv.get(d.key).catch(() => null);
    if (v && typeof v === 'object') return { doc: v, from: 'redis' };
  }
  const seed = await d.seed();
  return { doc: clone(seed.default ?? seed), from: 'seed' };
}

// Replace a document. False when Redis is not configured or refuses: the caller says so rather
// than pretend it saved.
export async function writeDoc(name, doc, { kv = defaultKv } = {}) {
  const d = DOCS[name];
  if (!d) throw new Error(`unknown document: ${name}`);
  if (!kv.configured()) return false;
  return !!(await kv.set(d.key, doc).catch(() => false));
}

export const storeConfigured = () => kvConfigured();
