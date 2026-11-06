// test/githubDispatch.test.mjs — starting a GitHub workflow on the scheduler's slot (lib/githubDispatch.js).
import { dispatchOne, refusalHint } from '../lib/githubDispatch.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const env = { GITHUB_TOKEN: 't', GITHUB_REPO: 'owner/repo' };
const now = new Date('2026-11-06T12:45:00Z');
{
  let seen = null;
  const r = await dispatchOne('signal-board.yml', { env, now, fetchImpl: async (url, o) => { seen = { url, body: JSON.parse(o.body), auth: o.headers.Authorization }; return { status: 204, ok: true }; } });
  eq('a 204 is accepted', [r.ok, r.status, r.workflow], [true, 204, 'signal-board.yml']);
  eq('it asks for the workflow on main', [seen.url, seen.body.ref], ['https://api.github.com/repos/owner/repo/actions/workflows/signal-board.yml/dispatches', 'main']);
  eq('with the token', seen.auth, 'Bearer t');
  const b = await dispatchOne('x.yml', { env: { ...env, GITHUB_BRANCH: 'dev' }, now, fetchImpl: async (u, o) => { seen = JSON.parse(o.body); return { status: 204 }; } });
  eq('another branch when set', [b.ok, seen.ref], [true, 'dev']);
}
{
  const r = await dispatchOne('signal-board.yml', { env, now, fetchImpl: async () => ({ status: 403, ok: false }) });
  eq('a refusal says what it usually means', [r.ok, r.hint], [false, 'the token lacks Actions: write on this repository']);
  const t = await dispatchOne('signal-board.yml', { env, now, fetchImpl: async () => { throw new Error('network down'); } });
  eq('a network failure is a failure, never a throw', [t.ok, t.status, t.error], [false, null, 'network down']);
  eq('hints for 401, 404, 422; none for others', [401, 404, 422, 500].map(s => refusalHint(s) != null), [true, true, true, false]);
}
console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
