// test/discordSplit.test.mjs — nothing is silently truncated.
import { splitForDiscord, overlongLines, EMBED_LIMIT, SECTION_RULE } from '../lib/discord.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const SEP = `\n\n${SECTION_RULE}\n\n`;
const section = (title, n) => `**${title}**\n` + Array.from({ length: n }, (_, i) => `• line ${i} of ${title}`).join('\n');

// ── THE BRIEF THAT WENT OUT CUT IN HALF ─────────────────────────────────────
// 2026-09-11, 12:59Z. The US pre-read was 6,122 characters against a 4,096 embed cap and
// `message.slice(0, 4096)` cut it without a word: BACKDROP, WHAT WOULD CHANGE IT, SINCE YOUR LAST
// BRIEF and the footer were lost, and the message ended on a dangling rule mid-heading.
{
  const brief = [section('MAP', 120), section('WATCHLIST', 40), section('CLOCK', 24),
                 section('OVERNIGHT', 20), section('BACKDROP', 80), section('CHANGE', 28)].join(SEP);
  ok('the fixture is over the cap, as the real brief was', brief.length > EMBED_LIMIT);

  const parts = splitForDiscord(brief);
  ok('it is split rather than cut', parts.length > 1);
  ok('every part is inside the cap', parts.every(p => p.length <= EMBED_LIMIT));
  // NOTHING IS LOST. Rejoining on the same rule must reproduce the input exactly — this is the
  // assertion the old code could never have passed.
  eq('and rejoining reproduces the brief exactly', parts.join(SEP), brief);
  // SPLIT AT SECTION BOUNDARIES, so a part never opens mid-sentence.
  ok('each part opens on a heading', parts.every(p => /^\*\*/.test(p)));
  ok('and none ends on a dangling rule', parts.every(p => !p.trimEnd().endsWith(SECTION_RULE)));
}

// ── A SHORT MESSAGE IS LEFT ALONE ───────────────────────────────────────────
// A single-part brief must not grow a split, a marker, or anything else it never needed.
{
  const short = section('CLOCK', 5);
  eq('one part, unchanged', splitForDiscord(short), [short]);
  eq('exactly at the cap is still one part', splitForDiscord('x'.repeat(EMBED_LIMIT)).length, 1);
  // ONE CHARACTER OVER IS TWO PARTS, AND THE CHARACTER SURVIVES. The first cut of this shaved an
  // overlong line to the cap and lost the tail in silence — the same defect as the one being
  // fixed, one level down.
  const over = splitForDiscord('x'.repeat(EMBED_LIMIT + 1));
  eq('one character over is two parts', over.length, 2);
  eq('and the character is not shaved off', over.join('').length, EMBED_LIMIT + 1);
  eq('nothing to post is no parts', splitForDiscord(''), []);
  eq('and neither is nothing at all', splitForDiscord(null), []);
}

// ── A SECTION BIGGER THAN THE CAP STILL HAS TO GO SOMEWHERE ─────────────────
// Split at line boundaries rather than mid-sentence: a brief that breaks in the middle of a
// number is worse than one that breaks between two bullets.
{
  const huge = section('MAP', 400);
  ok('the section alone is over the cap', huge.length > EMBED_LIMIT);
  const parts = splitForDiscord(huge);
  ok('it is still split', parts.length > 1);
  ok('every part inside the cap', parts.every(p => p.length <= EMBED_LIMIT));
  eq('and rejoining on newlines reproduces it', parts.join('\n'), huge);
  ok('no part begins mid-line', parts.every(p => /^(\*\*|• )/.test(p)));
}

// ── THE ONE CASE NOTHING CAN FIX IS REPORTED, NOT SWALLOWED ─────────────────
{
  const line = 'x'.repeat(EMBED_LIMIT + 50);
  eq('a single line over the cap is named', overlongLines(`ok\n${line}`).length, 1);
  eq('with its opening, so it can be found', overlongLines(`ok\n${line}`)[0].length, 80);
  eq('an ordinary brief reports none', overlongLines(section('MAP', 200)), []);
}

// ── A BREAK SOMEONE CHOSE, NOT ONE THE CAP IMPOSED ──────────────────────────
// Greedy fill puts the break wherever the 4,096th character lands. TODAY'S MAP is the surface a
// trade is placed against and the rest of the brief is the context that surface sits in — read at
// different moments, so they go out as two messages.
{
  const HEAD = "⚡ **TODAY'S MAP**";
  const brief = [`${HEAD}\nthe map`, section('WATCHLIST', 8), section('CLOCK', 6), section('BACKDROP', 10)].join(SEP);
  ok('the fixture is well inside the cap', brief.length < EMBED_LIMIT);
  eq('and without a break it is one message', splitForDiscord(brief).length, 1);

  const parts = splitForDiscord(brief, { breakAfter: [HEAD] });
  eq('the map gets its own message', parts.length, 2);
  ok('part 1 is the map', parts[0].startsWith(HEAD) && !parts[0].includes('WATCHLIST'));
  ok('part 2 is everything after it', parts[1].includes('WATCHLIST') && parts[1].includes('BACKDROP'));
  // A DELIBERATE BREAK MUST NOT COST WHAT THE FIX BOUGHT. Rejoining still reproduces the brief.
  eq('and rejoining still loses nothing', parts.join(SEP), brief);

  // A MINIMUM, NEVER A MAXIMUM. A forced part still over the cap is split again underneath, so
  // this can never reintroduce the truncation it sits on top of.
  const fat = [`${HEAD}\n` + section('MAP', 200), section('BACKDROP', 200)].join(SEP);
  const fatParts = splitForDiscord(fat, { breakAfter: [HEAD] });
  ok('an over-cap forced part is split again', fatParts.length > 2);
  ok('every part still inside the cap', fatParts.every(p => p.length <= EMBED_LIMIT));

  // A brief that does not contain the marker is untouched — Asia and Europe carry no map.
  const noMap = [section('CLOCK', 6), section('BACKDROP', 10)].join(SEP);
  eq('no marker, no forced break', splitForDiscord(noMap, { breakAfter: [HEAD] }), [noMap]);
  // The header block ahead of the map rides with it rather than becoming a message of its own.
  const withHeader = ['🇺🇸 **DAILY PRE-READ**', `${HEAD}\nthe map`, section('CLOCK', 6)].join(SEP);
  const hp = splitForDiscord(withHeader, { breakAfter: [HEAD] });
  eq('the brief header rides with the map', hp.length, 2);
  ok('in part 1', hp[0].includes('DAILY PRE-READ') && hp[0].includes(HEAD));
}

// ── THE REAL BRIEF, AS CAPTURED ─────────────────────────────────────────────
// The goldens are the actual assembled output. If a future section pushes one over the cap, this
// is where it shows up — as a split that still reproduces the brief, never as a loss.
{
  const goldens = ['asia', 'eu', 'us'].map(r => ({
    region: r, text: readFileSync(new URL(`./golden-preread-${r}.txt`, import.meta.url), 'utf8'),
  }));
  ok('there are briefs to check', goldens.length === 3);
  for (const g of goldens) {
    const parts = splitForDiscord(g.text);
    ok(`${g.region}: every part inside the cap (${g.text.length} chars → ${parts.length})`,
       parts.every(p => p.length <= EMBED_LIMIT));
    eq(`${g.region}: rejoining loses nothing`, parts.join(SEP), g.text);
    eq(`${g.region}: no line is individually over the cap`, overlongLines(g.text), []);
  }
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
