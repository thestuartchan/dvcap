// scripts/check-deploy.mjs — is what is on main actually the thing that is live?
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// 2026-09-11. Production stopped deploying at 13:29Z and nothing said so for forty minutes.
//
// A hand entry in the console changed data/korea_kofia.json, which the brief read straight off its
// module import, which moved the rendered asia brief, which failed its golden, which failed
// `prebuild`, which failed the Vercel build. Three commits in a row went undeployed — the Korea
// entry, an OAS entry, and a pre-read change that had touched none of it.
//
// Every signal available said things were fine:
//
//   • version.json answered, and answered with a plausible sha — the LAST GOOD build's. It is a
//     static asset, so it came back `x-vercel-cache: HIT` with `age: 1202`, and a cache-busting
//     query string did not shake it loose.
//   • the serverless API answered too, cheerfully, running the old bundle.
//   • the pull request merged green, because there is no CI on this repo: the build runs on
//     Vercel, and Vercel's verdict arrives as a COMMIT STATUS on GitHub, which nothing was reading.
//
// The one authoritative signal was the one nobody looked at. That is what this reads.
//
// NOT part of `prebuild` — it needs the network, and a build that checks its own deployment is a
// circle. Run it AFTER a merge, before saying something shipped:
//
//   npm run check:deploy            # origin/main, once
//   npm run check:deploy -- --wait  # poll until the build reaches a verdict
//   npm run check:deploy -- <sha> --wait --timeout=900
//
// THE RATE LIMIT IS LOW ENOUGH TO MATTER. Unauthenticated GitHub allows 60 calls an hour per IP,
// which a shared or NAT'd address can exhaust without you — and `--wait` spends one every twenty
// seconds. Set GITHUB_TOKEN (any token with read access to the repo) if it starts answering 403.
// The npm script sets NODE_USE_ENV_PROXY=1 so that node's fetch goes through an HTTPS_PROXY when
// one is configured, the way curl already does; with no proxy set it changes nothing.
//
// Exit codes are the point — this is meant to be believed by a script, not only read:
//   0  built and live
//   1  the build FAILED
//   2  no verdict yet (still building, or nothing reported)
//   3  the build succeeded but the live site is serving something else

export const DEFAULT_URL = 'https://dvcap.vercel.app';
export const DEFAULT_TIMEOUT_S = 600;
export const POLL_S = 20;

// `git@github.com:owner/repo.git`, `https://github.com/owner/repo.git`, or the bare form.
export function repoFromRemote(url) {
  const m = String(url || '').trim().match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// GitHub's combined status for a commit. Vercel posts ONE status per deployment; a repo with real
// CI would post several, and the combined `state` is already the worst of them, which is the
// answer we want. The per-status rows are kept for the description and the inspect URL — "run this
// Vercel CLI command" is the only place the reason for a failure is named.
//
// NO STATUSES AT ALL is not success. It means the build has not been reported yet — a queued
// deployment, a webhook that has not landed, or a commit Vercel never saw — and calling that
// "fine" is precisely the mistake this file exists to stop.
export function readStatus(json) {
  const rows = Array.isArray(json?.statuses) ? json.statuses : [];
  const state = rows.length ? String(json?.state || 'pending') : 'none';
  const pick = rows.find(r => r.state === 'failure' || r.state === 'error') || rows[0] || null;
  return {
    state,
    n: rows.length,
    description: pick?.description || null,
    url: pick?.target_url || null,
    at: pick?.updated_at || pick?.created_at || null,
  };
}

export const TERMINAL = new Set(['success', 'failure', 'error']);

// The live check is deliberately suspicious of its own answer. version.json is a STATIC asset
// behind a CDN, so a matching sha proves the edge is current and a stale one proves nothing on its
// own — `age` and the cache verdict travel with it so the difference is visible rather than
// guessed at.
export function verdict({ status, live, wantSha }) {
  const short = (s) => String(s || '').slice(0, 7);
  const want = short(wantSha);
  const lines = [];
  if (status.state === 'failure' || status.state === 'error') {
    lines.push(`✘ the build FAILED for ${want}`);
    if (status.description) lines.push(`  ${status.description}`);
    if (status.url) lines.push(`  ${status.url}`);
    lines.push('  Nothing deployed. Whatever is live is an older build, and it will answer normally.');
    return { code: 1, lines };
  }
  if (status.state === 'none') {
    lines.push(`◌ no deployment reported for ${want} yet — queued, or the webhook has not landed.`);
    return { code: 2, lines };
  }
  if (status.state !== 'success') {
    lines.push(`◌ still building ${want} (${status.state})${status.n ? ` · ${status.n} status${status.n > 1 ? 'es' : ''}` : ''}`);
    return { code: 2, lines };
  }
  lines.push(`✔ the build succeeded for ${want}`);
  if (!live || !live.sha) {
    lines.push('  but the live site did not answer with a version — check it by hand before saying it shipped.');
    return { code: 3, lines };
  }
  const age = Number.isFinite(+live.age) ? `, age ${live.age}s` : '';
  if (short(live.sha) === want) {
    lines.push(`  and ${new URL(live.url).host} is serving it (${short(live.sha)}${age})`);
    return { code: 0, lines };
  }
  lines.push(`  but ${new URL(live.url).host} is serving ${short(live.sha)}${age}${live.cache ? ` · x-vercel-cache: ${live.cache}` : ''}`);
  lines.push('  A cache HIT on a static asset can lag a good deploy by minutes; a MISS that still');
  lines.push('  disagrees means something else is on top. Either way this is not yet live.');
  return { code: 3, lines };
}

// ── everything below touches the network ─────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { execSync } = await import('node:child_process');
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(`--${n}`);
  const opt = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
  const sha = args.find(a => /^[0-9a-f]{7,40}$/i.test(a))
    || execSync('git rev-parse origin/main', { encoding: 'utf8' }).trim();
  const site = process.env.DEPLOY_URL || DEFAULT_URL;
  const r = repoFromRemote(execSync('git remote get-url origin', { encoding: 'utf8' }));
  if (!r) { console.error('✖ cannot read owner/repo from the origin remote'); process.exit(2); }

  // A USER-AGENT IS NOT OPTIONAL. GitHub answers an unauthenticated API call without one with a
  // bare 403, which reads exactly like a permissions problem and is not one. GITHUB_TOKEN is used
  // when it is there — the unauthenticated limit is 60 calls an hour and `--wait` spends one every
  // twenty seconds.
  // A USER-AGENT IS NOT OPTIONAL. GitHub answers an unauthenticated API call without one with a
  // bare 403, which reads exactly like a permissions problem and is not one.
  //
  // GITHUB_TOKEN is USED IF IT WORKS, NOT IF IT EXISTS. The variable is set in several environments
  // this runs in — CI, a sandbox, a proxy — and not all of them hold a token GitHub will accept; one
  // of them answers 401, which is the check failing for a reason that has nothing to do with the
  // deployment. A 401 falls back to the unauthenticated read (60 calls an hour, which `--wait`
  // spends one of every twenty seconds) rather than reporting a problem that is not there.
  const base = { Accept: 'application/vnd.github+json', 'User-Agent': 'dvcap-check-deploy' };
  let auth = process.env.GITHUB_TOKEN ? { ...base, Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : base;
  const getStatus = async () => {
    const url = `https://api.github.com/repos/${r.owner}/${r.repo}/commits/${sha}/status`;
    let res = await fetch(url, { headers: auth });
    if (res.status === 401 && auth !== base) { auth = base; res = await fetch(url, { headers: auth }); }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}${res.status === 403 ? ' — rate limited; set a working GITHUB_TOKEN' : ''}`);
    return readStatus(await res.json());
  };
  const getLive = async () => {
    try {
      const res = await fetch(`${site}/version.json`, { cache: 'no-store' });
      const j = await res.json();
      return { url: site, sha: j?.sha || null, age: res.headers.get('age'), cache: res.headers.get('x-vercel-cache') };
    } catch { return null; }
  };

  // A CHECK THAT CANNOT REACH ITS SOURCE EXITS 2, NOT 1 AND NEVER 0. "I could not find out" and
  // "the build failed" are different answers, and so are "I could not find out" and "it is fine".
  try {
    const deadline = Date.now() + (+opt('timeout', DEFAULT_TIMEOUT_S) * 1000);
    let status = await getStatus();
    // POLLING IS OPT-IN. A single read is the honest default: "not yet" is a real answer and a
    // caller that wants to wait says so.
    while (flag('wait') && !TERMINAL.has(status.state) && Date.now() < deadline) {
      console.log(`  … ${status.state} — waiting`);
      await new Promise(r2 => setTimeout(r2, POLL_S * 1000));
      status = await getStatus();
    }
    const v = verdict({ status, live: status.state === 'success' ? await getLive() : null, wantSha: sha });
    for (const l of v.lines) console.log(l);
    process.exit(v.code);
  } catch (e) {
    console.error(`◌ could not check ${sha.slice(0, 7)}: ${e?.message || e}`);
    process.exit(2);
  }
}
