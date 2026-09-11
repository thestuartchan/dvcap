// test/checkDeploy.test.mjs — the check that would have caught a deploy that never happened.
//
// On 2026-09-11 production stopped deploying at 13:29Z and every signal available said otherwise:
// version.json answered from a CDN cache with the last good build's sha, the serverless API
// answered with the old bundle, and the pull request merged green because the build verdict lives
// on GitHub as a commit status that nothing was reading. Forty minutes.
//
// The asserted behaviour here is mostly about what the check must NOT say.
import { repoFromRemote, readStatus, verdict, TERMINAL } from '../scripts/check-deploy.mjs';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

const SHA = 'de20bc49dbadea2bc993a7e0d5054e65165d5416';
const live = (sha, extra = {}) => ({ url: 'https://dvcap.vercel.app', sha, age: '12', cache: 'MISS', ...extra });

// ── the remote ───────────────────────────────────────────────────────────────
{
  eq('ssh remote', repoFromRemote('git@github.com:thestuartchan/dvcap.git'), { owner: 'thestuartchan', repo: 'dvcap' });
  eq('https remote', repoFromRemote('https://github.com/thestuartchan/dvcap.git'), { owner: 'thestuartchan', repo: 'dvcap' });
  eq('without the .git', repoFromRemote('https://github.com/thestuartchan/dvcap'), { owner: 'thestuartchan', repo: 'dvcap' });
  eq('with a trailing slash', repoFromRemote('https://github.com/thestuartchan/dvcap/'), { owner: 'thestuartchan', repo: 'dvcap' });
  eq('something else entirely', repoFromRemote('https://gitlab.com/a/b.git'), null);
  eq('nothing at all', repoFromRemote(''), null);
}

// ── the status ───────────────────────────────────────────────────────────────
{
  const failing = readStatus({ state: 'failure', statuses: [
    { state: 'failure', description: 'Deployment has failed — run this Vercel CLI command: npx vercel inspect dpl_X --logs',
      target_url: 'https://vercel.com/dvcap/dvcap/X', updated_at: '2026-09-11T13:40:00Z' }] });
  eq('a failed deployment reads as failed', failing.state, 'failure');
  ok('and carries the reason, which is the only place it is named', /vercel inspect/.test(failing.description));
  ok('and the link to it', failing.url.includes('vercel.com'));

  // THE ONE THAT MATTERED. GitHub returns `state: "pending"` with an EMPTY statuses array for a
  // commit no build has reported on — a queued deployment, a webhook that has not landed, or a
  // commit the builder never saw. Reading that as anything but "no verdict yet" is the bug.
  eq('no statuses at all is not success', readStatus({ state: 'pending', statuses: [] }).state, 'none');
  eq('nor is a malformed answer', readStatus({}).state, 'none');
  eq('nor is null', readStatus(null).state, 'none');

  // The combined state is already the worst of several checks, which is the answer wanted; the
  // failing row is the one picked for the description so a green check cannot mask a red one.
  const mixed = readStatus({ state: 'failure', statuses: [
    { state: 'success', description: 'tests passed' },
    { state: 'failure', description: 'Deployment has failed', target_url: 'https://vercel.com/x' }] });
  eq('a mixed result reports the failure', mixed.state, 'failure');
  eq('and describes the failing one, not the passing one', mixed.description, 'Deployment has failed');
  eq('and counts them', mixed.n, 2);

  eq('terminal states are the three that end a build', [...TERMINAL].sort(), ['error', 'failure', 'success']);
}

// ── the verdict ──────────────────────────────────────────────────────────────
{
  // ONLY ONE PATH RETURNS 0, and it requires the live site to answer with the sha that was built.
  const good = verdict({ status: readStatus({ state: 'success', statuses: [{ state: 'success' }] }), live: live(SHA), wantSha: SHA });
  eq('built and live is 0', good.code, 0);
  ok('and says which host is serving it', good.lines.join(' ').includes('dvcap.vercel.app'));

  const bad = verdict({ status: readStatus({ state: 'failure', statuses: [{ state: 'failure', description: 'Deployment has failed' }] }), live: null, wantSha: SHA });
  eq('a failed build is 1', bad.code, 1);
  // THE SENTENCE THAT WAS MISSING FOR FORTY MINUTES.
  ok('and says the live site will answer anyway', /will answer normally/.test(bad.lines.join(' ')));

  eq('no verdict yet is 2', verdict({ status: readStatus({ state: 'pending', statuses: [] }), live: null, wantSha: SHA }).code, 2);
  eq('still building is 2', verdict({ status: readStatus({ state: 'pending', statuses: [{ state: 'pending' }] }), live: null, wantSha: SHA }).code, 2);

  // A SUCCESSFUL BUILD IS NOT THE SAME CLAIM AS A LIVE ONE — this is the half that version.json
  // alone cannot answer, because a static asset behind a CDN can lag a good deploy by minutes.
  const stale = verdict({ status: readStatus({ state: 'success', statuses: [{ state: 'success' }] }),
    live: live('98b3a7f9d824105e2d83fdf29a20f0187f923049', { age: '1202', cache: 'HIT' }), wantSha: SHA });
  eq('built but serving something else is 3', stale.code, 3);
  ok('and the cache verdict travels with it', /x-vercel-cache: HIT/.test(stale.lines.join(' ')));
  ok('and the age, so a lag can be told from a problem', /age 1202s/.test(stale.lines.join(' ')));
  ok('and it refuses to call it live', /not yet live/.test(stale.lines.join(' ')));

  // A live site that does not answer is not evidence of anything, and must not read as success.
  eq('no answer from the live site is 3, never 0', verdict({
    status: readStatus({ state: 'success', statuses: [{ state: 'success' }] }), live: null, wantSha: SHA }).code, 3);

  // Short and long sha forms name the same commit.
  eq('a short sha matches the full one', verdict({
    status: readStatus({ state: 'success', statuses: [{ state: 'success' }] }), live: live(SHA), wantSha: SHA.slice(0, 7) }).code, 0);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
