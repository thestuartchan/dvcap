// check-no-llm-feeds.mjs — build gate against fabricated data feeds.
//
// RULE: an LLM call must never stand in for a data feed. A model asked to "return today's price"
// with no market-data tool wired in answers from training data — a plausible number that the UI
// then renders as a live quote with a moving average. That is fabricated data presented as a feed.
// FRED / Yahoo / FiscalData / the /api proxy are feeds; api.anthropic.com is not.
//
// This is the enforceable core of the broader principle "any numeric field rendered without a
// verified source and timestamp fails the build": we can't statically prove every number carries a
// source, but we CAN ban the one pattern that manufactures numbers out of nothing.
//
// Scope: source only (src/, api/, lib/). dist/ and node_modules/ are excluded.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const ROOTS = ['src', 'api', 'lib'];
const EXTS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx']);
// A model endpoint reached over the wire. Reaching an LLM API from feed/UI code is the smell —
// there is no legitimate reason for this dashboard's price/indicator paths to call one.
const BANNED = [
  { re: /https?:\/\/api\.anthropic\.com/i, why: 'anthropic.com API call — an LLM is not a data feed' },
  { re: /https?:\/\/api\.openai\.com/i,    why: 'openai.com API call — an LLM is not a data feed' },
  { re: /generativelanguage\.googleapis\.com/i, why: 'Gemini API call — an LLM is not a data feed' },
];

function walk(dir) {
  let out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (name !== 'node_modules') out = out.concat(walk(p)); }
    else if (EXTS.has(extname(p))) out.push(p);
  }
  return out;
}

const violations = [];
for (const root of ROOTS) {
  let files;
  try { files = walk(root); } catch { continue; } // root may not exist
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // A throw that DISABLES the pattern is allowed — it's the guardrail, not a call. Skip lines
      // that only NAME the host in a comment/error string without fetching it.
      const isFetch = /\bfetch\s*\(/.test(line) || /axios|XMLHttpRequest|\.get\(|\.post\(/.test(line);
      for (const { re, why } of BANNED) {
        if (re.test(line) && isFetch) violations.push({ file, line: i + 1, why, text: line.trim().slice(0, 100) });
      }
    });
  }
}

if (violations.length) {
  console.error('✖ no-LLM-feeds check FAILED — a model call is being used as a data feed:\n');
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.why}\n    ${v.text}`);
  console.error('\nData must come from a real feed (FRED / Yahoo / the /api proxy), never an LLM.');
  process.exit(1);
}
console.log('✔ no-LLM-feeds check passed (no model endpoint used as a data feed)');
