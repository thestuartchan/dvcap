#!/usr/bin/env node
// scripts/write-version.mjs — stamp the build with the commit it came from.
//
// Merging is not deploying. Vercel validates vercel.json on every build and REJECTS the deployment
// if it does not like it, leaving the PREVIOUS build serving happily under the same URL — which is
// what scripts/check-function-count.mjs warns about in those exact words. Nothing about a green
// merge distinguishes "shipped" from "rejected", and the last schedule change here could only be
// confirmed by posting a real message to a real Discord channel.
//
// This was first written as api/version.js and the function-count guard refused it: thirteen
// serverless functions against Vercel Hobby's twelve. Being told by one guard that the other guard
// was about to be needed is a good argument for it, and a STATIC file is the better answer anyway
// — it costs no function, cannot fail at runtime, and is baked into the artifact rather than
// reporting on it.
//
// Vercel injects VERCEL_GIT_COMMIT_SHA into every build with no configuration and no secret, so
// nothing here is private: it reports what is already public in the repository.

import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const env = (...names) => {
  for (const n of names) if (process.env[n]) return process.env[n];
  return null;
};
const localSha = () => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; }
};

// The build environment is the source of truth; git is the fallback for a local build, and is
// labelled as such so a dev build is never mistaken for a deployment.
const sha = env('VERCEL_GIT_COMMIT_SHA', 'GITHUB_SHA') || localSha();
const onVercel = !!env('VERCEL_GIT_COMMIT_SHA');

const body = {
  sha: sha || null,
  short: sha ? sha.slice(0, 7) : null,
  ref: env('VERCEL_GIT_COMMIT_REF', 'GITHUB_REF_NAME'),
  // "production" or "preview". A preview URL answering as production is its own class of
  // confusion and it has cost time here before.
  env: env('VERCEL_ENV') || (onVercel ? 'unknown' : 'local'),
  // BUILD time, which is the honest one: this file is written once, when the artifact is made.
  builtAt: new Date().toISOString(),
  // Says plainly where the sha came from, so a local build is never read as a deployment.
  source: onVercel ? 'vercel' : (sha ? 'local-git' : 'none'),
};

mkdirSync('public', { recursive: true });
writeFileSync('public/version.json', JSON.stringify(body, null, 2) + '\n');
console.log(`✅ version: ${body.short || '(unknown)'} · ${body.env} · ${body.source}`);
