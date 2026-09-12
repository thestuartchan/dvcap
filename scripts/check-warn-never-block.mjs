// check-warn-never-block.mjs — no component that evaluates a limit may refuse.
//
// ── THE RULE ─────────────────────────────────────────────────────────────────
// The tool informs. It never restricts. Frameworks exist to build best practice, and the room to
// act on instinct in an exceptional situation is the thing that makes an operator good at this — a
// tool that decides has removed it. Overrides should be infrequent rather than frequent, but they
// must never be foreclosed.
//
// The position sizer was the outlier: past 1.5× NLV it struck the computed size through, printed
// ⛔ EXCEEDS CEILING, and offered the size that would fit instead — so the one question asked of it
// went unanswered exactly when the answer was most worth arguing with.
//
// ── WHAT THIS CHECKS, AND WHAT IT CANNOT ─────────────────────────────────────
// "Takes no action" is not decidable from source. What IS decidable is the vocabulary, and the
// vocabulary is how the rule erodes: ⛔ reads as a refusal, and a glyph that says "stopped" on a
// panel that stops nothing teaches a reader to discount every flag beside it. The first thing a
// re-introduced block would do is reach for that glyph again.
//
// So: the refusal glyph may not appear in rendered strings, and a limit may not be described with
// the verbs of prohibition. Commentary is exempt — this file and the code it guards both need to
// name the thing they removed.
//
// It is a tripwire, not a proof. The substantive guarantee lives in test/sizer.test.mjs, which
// asserts that a size is returned at every input including an absurd one.
import { readFileSync, readdirSync } from 'node:fs';

const FILES = [
  ...readdirSync('lib').filter(f => f.endsWith('.js')).map(f => `lib/${f}`),
  ...readdirSync('src').filter(f => f.endsWith('.jsx')).map(f => `src/${f}`),
];

// The glyph, and the verbs that describe a limit ACTING rather than reporting.
const BANNED = [
  { re: /⛔/, why: 'the refusal glyph — use ⚠, which is what a flag that takes no action looks like' },
  { re: /\bEXCEEDS CEILING\b/, why: 'a verdict that replaced an answer; report the number and the ceiling instead' },
];

// COMMENTS ARE STRIPPED, NOT PATTERN-MATCHED. A first cut tested whether a line STARTED like a
// comment, which misses both shapes this codebase actually uses: `{/* … */}` for JSX, and the
// continuation lines of a block comment whose prose does not begin with `*`. It flagged four of its
// own explanations, which is the check failing in the direction that gets it deleted.
//
// Tracked across lines instead: a `/*` opens and the next `*/` closes, and `//` ends a line. What
// is left is what ships.
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    let kept = '', i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) break;                       // the whole rest of the line is inside it
        inBlock = false; i = end + 2; continue;
      }
      const lineC = line.indexOf('//', i), blockC = line.indexOf('/*', i);
      const first = [lineC, blockC].filter(x => x !== -1).sort((a, b) => a - b)[0];
      if (first === undefined) { kept += line.slice(i); break; }
      kept += line.slice(i, first);
      if (first === lineC) break;
      inBlock = true; i = first + 2;
    }
    out.push(kept);
  }
  return out;
}

let bad = 0, scanned = 0;
for (const file of FILES) {
  const lines = stripComments(readFileSync(file, 'utf8'));
  scanned++;
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    for (const b of BANNED) {
      if (!b.re.test(l)) continue;
      console.error(`✗ ${file}:${i + 1} — ${b.why}`);
      console.error(`    ${l.trim().slice(0, 110)}`);
      bad++;
    }
  });
}

if (bad) {
  console.error(`\n${bad} refusal${bad === 1 ? '' : 's'} in rendered text. The tool informs; it never restricts.`);
  process.exit(1);
}
console.log(`✔ warn-never-block: no refusal vocabulary in rendered text (${scanned} files)`);
