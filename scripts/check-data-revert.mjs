#!/usr/bin/env node
// scripts/check-data-revert.mjs — does this branch quietly undo operator data?
//
// data/*.json is not source. It is written back to `main` continuously by the console and the
// manual-entry API — 32 commits in the three days this was written, about ten a day. Every one is
// a figure somebody entered by hand and cannot retype from memory.
//
// Git alone does not lose them: a branch that never touches data/ merges cleanly and main's newer
// version survives. The loss needs the branch to CARRY a change to those files, which happens by
// accident — a stale working tree swept up by `git add -A`, a stash popped over newer content, a
// script that rewrites a file wholesale. The branch then asserts old content as a deliberate
// change, and a deliberate change is exactly what a merge is obliged to honour. It nearly happened
// on about five of the last seven merges here, once over 139 lines of korea_kofia.json, and it was
// caught every time by a person remembering to look. That is not a control.
//
// THE QUESTION IS WHAT THE BRANCH INTRODUCED, not how the two tips differ. Comparing the tips
// (`git diff main HEAD`) flags any branch that is merely BEHIND — it sees main's newer data against
// the branch's older copy and calls it a rewind, when merging such a branch reverts nothing at all,
// because git keeps main's version for a file the branch never touched. That check would have cried
// wolf on almost every branch here, which is the surest way to get a warning ignored.
//
// The three-dot diff asks the right question: what changed from the merge base to this branch. A
// branch that never touched data/ is silent however far behind it drifts, and a branch that did is
// caught — including after a rebase, when the merge base becomes main and a stale file committed on
// top stands out as the deliberate-looking change it will be treated as.
//
// WARN, DO NOT BLOCK. A data change on a branch is not proof of a revert; sometimes it is meant.
// A check that fails a build over a maybe is a check people learn to bypass. It exits 0 always.

import { execFileSync } from 'node:child_process';

const CI = !!process.env.GITHUB_ACTIONS;
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
const tryGit = (...a) => { try { return git(...a); } catch { return null; } };
const lines = (s) => (s || '').split('\n').map(x => x.trim()).filter(Boolean);
const plural = (n, s, p = s + 's') => `${n} ${n === 1 ? s : p}`;

const BASE_REF = process.env.DATA_BASE_REF
  || (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main');
const DIR = 'data/';

if (!tryGit('rev-parse', '--verify', BASE_REF)) {
  console.log(`ℹ data-revert: ${BASE_REF} is not available here (shallow clone or no remote) — skipped.`);
  process.exit(0);
}
const head = git('rev-parse', 'HEAD');

// Changes this branch INTRODUCED under data/ — three-dot, so being behind is not a finding.
const changed = lines(git('diff', '--name-only', `${BASE_REF}...${head}`, '--', DIR));

// A REVERT, PROVEN RATHER THAN GUESSED. If the exact content this branch carries for a file is a
// blob that already appeared in the base branch's history for that path — and is not what the base
// holds now — the branch is not editing the file, it is rewinding it, and we can say to when.
function rewind(file) {
  const mine = tryGit('rev-parse', `${head}:${file}`);
  if (!mine) return null;                                     // deleted on the branch
  const commits = lines(tryGit('log', '--format=%H %ad', '--date=short', BASE_REF, '--', file) || '');
  for (const line of commits) {
    const [sha, date] = line.split(' ');
    if (tryGit('rev-parse', `${sha}:${file}`) === mine) return { sha: sha.slice(0, 7), date };
  }
  return null;
}

const reverts = [], edits = [];
for (const f of changed) {
  const r = rewind(f);
  (r ? reverts : edits).push({ file: f, ...(r || {}) });
}

// Uncommitted data changes are not a revert yet, but they are one `git add -A` from becoming one.
const dirty = lines(tryGit('status', '--porcelain', '--', DIR) || '').map(l => l.slice(3).trim()).filter(Boolean);

const out = [];
if (reverts.length) {
  out.push(`REWINDS ${plural(reverts.length, 'operator data file')} to an earlier state of ${BASE_REF}:`);
  for (const r of reverts) {
    const stat = (git('diff', '--shortstat', `${BASE_REF}...${head}`, '--', r.file) || '').trim();
    out.push(`  ${r.file} — this branch holds the version from ${r.date} (${r.sha}); ${stat || 'no line change'}`);
  }
  out.push('  Merging would undo every hand-entered figure written since.');
}
if (edits.length) {
  out.push(`${plural(edits.length, 'operator data file')} differ${edits.length === 1 ? 's' : ''} from ${BASE_REF} but ${edits.length === 1 ? 'does' : 'do'} not match any earlier state of it:`);
  for (const e of edits) out.push(`  ${e.file} — ${(git('diff', '--shortstat', `${BASE_REF}...${head}`, '--', e.file) || '').trim() || 'no line change'}`);
  out.push('  Not a rewind. Intentional data change, or a partial overwrite — worth a look either way.');
}
if (dirty.length) {
  out.push(`${plural(dirty.length, 'uncommitted data file')} in the working tree, which \`git add -A\` would sweep in:`);
  for (const f of dirty) out.push(`  ${f}`);
}

const remedy = [
  'What to do:',
  `  git fetch origin && git rebase ${BASE_REF}`,
  `  git diff --stat ${BASE_REF}...HEAD -- ${DIR}   # expect empty unless you meant it`,
  '',
  'If the change IS intended, nothing is wrong — this points, it does not judge.',
];

if (out.length) {
  console.log(['⚠ operator data may be reverted by this branch', '', ...out, '', ...remedy].join('\n'));
  if (CI) {
    console.log(`::warning title=Operator data at risk::${out[0]} — rebase on ${BASE_REF} before merging`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `### ⚠ Operator data may be reverted\n\n\`\`\`\n${[...out, '', ...remedy].join('\n')}\n\`\`\`\n`);
    }
  }
} else {
  const behind = lines(git('rev-list', '--count', `${head}..${BASE_REF}`, '--', DIR))[0] || '0';
  console.log(`✅ data-revert: this branch introduces no change under ${DIR}`
    + (Number(behind) ? `\n   (${BASE_REF} has ${plural(Number(behind), 'data commit')} this branch does not; a merge keeps them)` : ''));
}

// Warn-first, by decision. To make it blocking: `process.exit(out.length ? 1 : 0)` here, AND tick
// it as a required status check in branch protection — a blocking script that is not required is
// just a red mark people scroll past.
process.exit(0);
