// lib/githubDispatch.js — start a GitHub workflow now (workflow_dispatch), for the jobs that must
// commit to the repo. lib/cronRouter.js calls it on the job's slot: GitHub's own schedules ran 3–6
// hours late, a dispatch starts at once.
//
// 6 Nov 2026: this was lib/preOpenDispatch.js, which also kept a once-a-day pre-open record and a
// Data health panel with a retry button. The per-minute scheduler replaced all of that: the signal
// board is a scheduler job (signal-board, 07:50 New York), and its runs show on the Job health panel.
// Env: GITHUB_TOKEN (Actions: write), GITHUB_REPO, GITHUB_BRANCH (default main).

// What a refused dispatch usually means, for the person reading Data health. Status codes only.
export function refusalHint(status) {
  if (status === 401) return 'GitHub refused the token: expired or revoked';
  if (status === 403) return 'the token lacks Actions: write on this repository';
  if (status === 404) return 'workflow not found, or the token cannot see the repository';
  if (status === 422) return 'the workflow has no workflow_dispatch trigger, or the branch is wrong';
  return null;
}

export async function dispatchOne(wf, { env, fetchImpl, now }) {
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${wf}/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'dvcap-scheduler', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: env.GITHUB_BRANCH || 'main' }),
      signal: AbortSignal.timeout(10000),
    });
    const ok = r.status === 204 || !!r.ok;
    return { workflow: wf, ok, status: r.status, at: now.toISOString(), ...(ok ? {} : { hint: refusalHint(r.status) }) };
  } catch (e) {
    return { workflow: wf, ok: false, status: null, at: now.toISOString(), error: String(e?.message || e).slice(0, 120) };
  }
}

