// A test suite that prints its pass count BEFORE its last assertion reports a number that is not
// the number of tests that ran. This has happened twice: test/fxrates.test.mjs sat at 21 while 15
// appended assertions ran uncounted (a stray process.exit was also terminating it early), and
// test/decisions.test.mjs reported 39 while running 71.
//
// It is a quiet failure — every assertion still passes, the suite still exits 0, and the only
// symptom is a total that stops growing. Appending to a test file is the most natural thing to do
// to one, so this checks the shape rather than trusting the habit.
//
// IT HAPPENED A THIRD TIME, PAST THIS CHECK. test/prereadSections.test.mjs reported 100 while
// running 179, and this file said the suite was fine — because the pattern it looked for was
// `ALL ${pass}` or `${pass} PASSED`, and that suite prints `${pass} passed, ${fail} failed` in
// lower case. A suite whose summary did not match was treated as "reports some other way" and
// skipped entirely, so the check silently covered fewer files than it appeared to.
//
// The match is now any console.log that interpolates `pass`, and the count of suites actually
// examined is printed — a check that quietly stops checking things is the same class of bug it
// exists to catch.
import { readdirSync, readFileSync } from 'node:fs';

const dir = 'test';
const bad = [], unsummarised = [];
let checked = 0;
for (const f of readdirSync(dir).filter(n => n.endsWith('.test.mjs')).sort()) {
  const lines = readFileSync(`${dir}/${f}`, 'utf8').split('\n');
  const idx = (re) => lines.reduce((last, l, i) => re.test(l) ? i : last, -1);
  const summary = idx(/console\.log\([^\n]*\$\{pass\}/);
  const exit    = idx(/^\s*process\.exit\(/);
  // Any line that looks like an assertion call at the start of a statement.
  const lastAssert = idx(/^\s*(eq|ok|near|is|assert)\s*\(/);
  if (summary === -1) { unsummarised.push(f); continue; }   // suite reports some other way
  checked++;
  if (lastAssert > summary) bad.push(`${f}: summary at line ${summary + 1}, but an assertion runs at line ${lastAssert + 1}`);
  else if (exit !== -1 && exit < lastAssert) bad.push(`${f}: process.exit at line ${exit + 1} terminates before the assertion at line ${lastAssert + 1}`);
}

if (bad.length) {
  console.error('✖ test-summary check FAILED — a suite counts fewer tests than it runs:');
  for (const b of bad) console.error(`  ${b}`);
  console.error('  Move the summary console.log and process.exit to the very end of the file.');
  process.exit(1);
}
console.log(`✔ test-summary check passed (${checked} suites count every assertion they run`
  + `${unsummarised.length ? `; ${unsummarised.length} report no interpolated total: ${unsummarised.join(', ')}` : ''})`);
