// check-ui-prose.mjs — the reading tabs describe; they do not instruct.
//
// ── THE RULE ─────────────────────────────────────────────────────────────────
// The Discord pre-read runs every line it emits through assertObservational (lib/read.js), which
// bans the vocabulary of a trade call. The dashboard had no equivalent, and it showed: "Act now."
// "Consider rotating toward Treasuries and cash." "Start building insurance positions — don't
// wait." "Rotate now. Sell USFR → Buy IEF same day." — four surfaces issuing instructions in four
// vocabularies, keyed to labels a person sets by hand, beside the one composed stance that is
// actually guarded and audited.
//
// Every card on a reading tab is STATE → EVIDENCE → WHAT FLIPS IT. The stance is the tape's, and
// it lives in one place. This holds the line after the prose was cut back.
//
// ── SCOPE ────────────────────────────────────────────────────────────────────
// src/App.jsx only — the reading tabs. TradeConsole.jsx is where trades are actually recorded,
// and "Bought", "Sold", "＋ buy zone" are its controls, not its advice. lib/read.js's own list
// (buy/sell/trim/exit/allocate…) is deliberately NOT reused here: those are verbs the console's
// labels legitimately carry, so borrowing them would flag "Sell zone" and teach everyone to
// ignore the check. This list is the vocabulary of an INSTRUCTION TO THE READER — second-person,
// imperative, about what to do with money.
//
// Comments are stripped, not pattern-matched — the first cut of the sibling check flagged four of
// its own explanations. A phrase in commentary is history; the same phrase in a string ships.
import { readFileSync } from 'node:fs';

const FILES = ['src/App.jsx'];

const BANNED = [
  /\bact now\b/i,
  /\bconsider (rotating|adding|buying|selling|trimming|deploying|reducing)\b/i,
  /\bstart building\b/i,
  /\b(don'?t|do not) wait\b/i,
  /\brotate now\b/i,
  /\bsell \S+ → buy\b/i,
  /\bbuy \S+ in (partial|full) size\b/i,
  /\bexit entirely\b/i,
  /\bfull (IEF|TLT|equity|duration) position\b/i,
  /\bno action (needed|yet)\b/i,
  /\bhold (cash|existing positions|gold miners)\b/i,
  /\bavoid new \S+ entries\b/i,
  /\breduce equity exposure\b/i,
  /\bprioriti[sz]e insurance\b/i,
  /\bbegin (deploying|filling|rolling proceeds)\b/i,
  /\bdeploy(ment)? now\b/i,
  // Caught by reading the Indicators tab after the first draft passed it: three phrasings of the
  // same instruction the list above did not cover.
  /\brotate to \S+( and \S+)? immediately\b/i,
  // NARROWED after the first run against the cleaned tree. "Stage 2 — Accumulate insurance" is a
  // stage NAME on the Posture tab — the operator's own rulebook, where imperative wording is the
  // point — and "Defensive rotation." in a sector note describes what the market does, not what
  // the reader should. The instruction forms were "the window to accumulate insurance" and "full
  // defensive rotation warranted"; those are what is banned.
  /\bwindow to accumulate insurance\b/i,
  /\bfull defensive rotation\b/i,
  /\brotation warranted\b/i,
  /\bpositioning warranted\b/i,
  /\bcapital preservation is the priority\b/i,
];

function stripComments(src) {
  const out = []; let inBlock = false;
  for (const line of src.split('\n')) {
    let kept = '', i = 0;
    while (i < line.length) {
      if (inBlock) { const end = line.indexOf('*/', i); if (end === -1) break; inBlock = false; i = end + 2; continue; }
      const lc = line.indexOf('//', i), bc = line.indexOf('/*', i);
      const first = [lc, bc].filter(x => x !== -1).sort((a, b) => a - b)[0];
      if (first === undefined) { kept += line.slice(i); break; }
      kept += line.slice(i, first);
      if (first === lc) break;
      inBlock = true; i = first + 2;
    }
    out.push(kept);
  }
  return out;
}

let bad = 0;
for (const file of FILES) {
  const lines = stripComments(readFileSync(file, 'utf8'));
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    for (const re of BANNED) {
      const m = re.exec(l);
      if (!m) continue;
      console.error(`✗ ${file}:${i + 1} — "${m[0]}" is an instruction to the reader, on a tab that describes`);
      console.error(`    ${l.trim().slice(0, 120)}`);
      bad++;
    }
  });
}
if (bad) {
  console.error(`\n${bad} instruction${bad === 1 ? '' : 's'} in rendered text. State, evidence, what flips it — the stance lives on the Overview.`);
  process.exit(1);
}
console.log(`✔ ui-prose: no reader instructions in rendered text (${BANNED.length} patterns, ${FILES.join(', ')})`);
