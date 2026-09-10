// test/prereadRender.test.mjs — the whole brief, rendered from frozen real feed output.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// MEASURED on the live Asia brief of 2026-09-10: six of its thirty content lines — one in five —
// never rendered in a local run, because their inputs come from keyed feeds. Money, Credit and
// Inflation are the entire macro backdrop and all three were among them.
//
// A section of the product was reaching the reader before it reached anyone who could check it.
// That is how "the one it targets is the lower of the two" shipped over a core PCE of 3.34 against
// a core CPI of 2.47 — a sentence asserting the opposite of what its own two numbers said, on the
// only inflation line in the brief.
//
// check-env-independent.mjs does not catch this and is not meant to: it sets every variable to a
// DUMMY, which proves the answer does not depend on configuration. A dummy key returns no data, so
// the branches that need data still do not run. The two checks are complements — that one asserts
// configuration changes nothing, this one asserts every line gets rendered by somebody.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
// test/fixtures-preread-*.json is one capture of ?state=1 per region: the assembled inputs, frozen.
// Nothing in them is private — it is market data, the same figures the brief prints.
//
// THE FIXTURES ARE FROZEN ON PURPOSE. Prices move every day; a golden file rendered from live data
// would change every run and teach a reader to ignore the diff. These change only when re-captured,
// so any difference in the rendered output is a change in the CODE, and it is visible in the diff
// of the pull request that caused it.
//
// `now` is pinned for the same reason — CLOCK counts down to the next open, and freshness ages
// every quote, so an unpinned clock would make the golden unstable in a way that has nothing to do
// with the brief.
//
// EACH FIXTURE IS RENDERED AT ITS OWN CAPTURE INSTANT, not at one shared constant. A shared one was
// eighteen minutes before the captures, and eighteen minutes is enough to move a quote across the
// live/delayed boundary — so the golden would have described a freshness that never existed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { buildBlocks, assembleDiscord } from '../api/preread.js';
import { UNIVERSE } from '../data/universe.js';
import { gaugesLeaning } from '../lib/gates.js';
import { composeRead } from '../lib/read.js';
import KOFIA_STORE from '../data/korea_kofia.json' with { type: 'json' };

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const REGIONS = ['asia', 'eu', 'us'];
const UPDATE = process.env.UPDATE_GOLDEN === '1';

const rendered = {};
for (const region of REGIONS) {
  const fx = JSON.parse(readFileSync(new URL(`./fixtures-preread-${region}.json`, import.meta.url), 'utf8'));
  const s = fx.state;
  const NOW = new Date(fx.capturedAt);
  // ── REBUILT, NOT REPLAYED ──────────────────────────────────────────────────
  // `leaning` and `composed` are OUTPUTS of lib/gates.js and lib/read.js, and the capture contains
  // both. Rendering the frozen copies would mean a change to either — a new gauge, a reworded row,
  // a rescoped region filter — could never reach the golden, which is the one thing this file
  // exists to prevent. They are recomputed here from the same inputs assemble.js hands them, so the
  // golden is sensitive to the gauge set and the composer as well as to the renderers.
  const leaning = gaugesLeaning({
    credit: s.regime.credit, korea: s.regime.korea,
    vix: s.cross?.volCredit?.rows?.find(r => r.sym === '^VIX'),
    nq: s.nqLow, kofiaLatest: KOFIA_STORE.latest || {}, us30y: s.macro.us30y,
    // `now` PINNED, for the same reason composeRead's is below: the 30Y tripwire ages its own
    // observation against the render date, so an unpinned wall clock would move the golden every
    // day with no code change between.
    now: fx.capturedAt,
  });
  const composed = composeRead({
    credit: s.regime.credit, korea: s.regime.korea, cross: s.cross, hyg: s.hyg, leaning,
    regimeSignal: s.macro.regimeSignal, kofiaLatest: KOFIA_STORE.latest || {},
    staleNotes: [], usRthOpen: s.usRthOpen, usPrevSession: s.usPrevSession,
    // `now` PINNED HERE TOO. composeRead defaults it to the wall clock, and the OAS staleness rule
    // is hour-dependent — FRED publishes the prior business day during the US morning, so the same
    // observation reads "as of 2026-09-08" before 12:00Z and "no new print since 2026-09-08" after
    // it. The golden was blessed at 10:00Z and started failing at 12:45Z with no code change
    // between, which is the same drift already fixed for the per-quote freshness labels turning up
    // one layer down.
  }, { region, now: NOW });
  const blocks = buildBlocks(region, s.quotes, s.indices, s.macro, s.regime, s.cal, s.cross, s.sox,
    { leaning, composed, foreign: {}, now: NOW });
  const text = assembleDiscord(region, UNIVERSE[region].label, blocks)
    // The header carries the render time and is the one line that cannot be frozen.
    .replace(/· \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z\*\*/, '· <TIME>**');
  rendered[region] = text;

  const goldenUrl = new URL(`./golden-preread-${region}.txt`, import.meta.url);
  if (UPDATE || !existsSync(goldenUrl)) { writeFileSync(goldenUrl, text); console.log(`📝 wrote golden for ${region}`); continue; }
  const want = readFileSync(goldenUrl, 'utf8');
  if (text === want) { console.log(`✅ ${region} brief matches its golden`); pass++; }
  else {
    fail++;
    console.log(`❌ ${region} brief differs from its golden`);
    const a = want.split('\n'), b = text.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) console.log(`   line ${i + 1}\n   - ${a[i] ?? '(none)'}\n   + ${b[i] ?? '(none)'}`);
    }
    console.log('   Re-run with UPDATE_GOLDEN=1 once the new output is what you intend.');
  }
}

// ── THE CLAIM MUST AGREE WITH THE NUMBERS ────────────────────────────────────
// The bug was not a missing test, it was a SENTENCE that contradicted the two figures printed
// inside it. A golden file makes that visible to a reader; this makes it visible to the build.
//
// Asserted against the fixture's real values (core PCE 3.34, core CPI 2.47) rather than against
// the words, so it stays true if the wording is rewritten and fails if the comparison is inverted
// again.
{
  const s = JSON.parse(readFileSync(new URL('./fixtures-preread-asia.json', import.meta.url), 'utf8')).state;
  const pce = s.macro?.corePce?.value, cpi = s.macro?.coreCpi?.value;
  ok('the fixture actually exercises the inflation branch', pce != null && cpi != null);
  const line = rendered.asia.split('\n').find(l => /Inflation:/.test(l));
  ok('and the line renders at all', !!line);
  if (line) {
    // Whichever number is larger, the sentence must not call the Fed's gauge the smaller one.
    const fedIsHigher = +pce > +cpi;
    ok('the Fed gauge is named as the higher figure when it is',
       !fedIsHigher || /higher at/.test(line));
    ok('and the reading is not the reassuring one', !fedIsHigher || !/lower of the two/.test(line));
    // Both figures reach the reader, so the claim can be checked without leaving the line.
    ok('both numbers are shown', line.includes(String(pce)) && line.includes(String(cpi)));
  }
}

// ── THE STATES A CAPTURE CANNOT CATCH ────────────────────────────────────────
// A fixture is one instant, and some lines only exist in an instant that instant was not. The
// stale-print warning needs the market open while the feed is still serving prior closes, and a
// capture taken pre-open can never be that.
//
// So the flag is flipped on the REAL fixture and the brief re-rendered. This is not an invented
// state: it is the same live data with one boolean set to the other value the code already handles,
// and it is the only way to look at a line that would otherwise reach a reader unseen.
{
  const fx = JSON.parse(readFileSync(new URL('./fixtures-preread-asia.json', import.meta.url), 'utf8'));
  const s = fx.state;
  const NOW = new Date(fx.capturedAt);
  const stale = buildBlocks('asia', s.quotes, s.indices, s.macro,
    { ...s.regime, staleWhileOpen: true }, s.cal, s.cross, s.sox,
    { leaning: s.leaning, composed: s.composed, foreign: {}, now: NOW });
  // Only the BACKDROP warning is under test here, and it does not read the gauges.
  rendered._staleWhileOpen = stale.backdropLines || '';
  ok('an open market on stale prints says so', /⚠️ \*\*Equity prints are stale\*\*/.test(stale.backdropLines));
  // AND THE CUTS GO QUIET. The warning is only half the behaviour; the other half is that the
  // sector reads computed from those prints must not still be printed beside it as if current.
  ok('and the sector cuts it invalidates are suppressed', !/Inside chips|AI vs the rest/.test(stale.backdropLines));
}

// ── NO LINE SHIPS UNRENDERED ─────────────────────────────────────────────────
// Every distinct line marker the brief can emit must appear in at least one rendered golden. A
// marker that appears in none is a line nobody — not the suite, not me — has ever looked at, which
// is the precondition for every bug on this page so far.
//
// Matched on the EMOJI that opens each line, because that is what makes a line a line here and it
// is stable across rewording. A new marker fails the build until a fixture produces it or it is
// waived below with a reason.
{
  const sources = ['../api/preread.js', '../lib/briefSections.js', '../lib/gexBrief.js', '../lib/watchlist.js']
    .map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  // Only inside template literals and quoted strings, and only where the emoji opens the content —
  // a `${...}` or a bullet may precede it. The commentary above each line is full of the same
  // symbols and is not output.
  const emitted = new Set();
  for (const m of sources.matchAll(/[`'"](?:• |\$\{[^}]*\} )?(\p{Extended_Pictographic}[️]?)\s*\*\*/gu)) emitted.add(m[1]);

  // WAIVED, each with the reason it cannot appear in these three fixtures. A waiver is a debt, not
  // an exemption: it says the line is still unseen, and names what would have to be true to see it.
  //
  // WHAT IT DOES NOT CATCH: two different lines sharing a marker. ⚠️ opens both the stale-print
  // warning and the conflict lead, so rendering either satisfies both. It catches a whole line
  // SHAPE never being looked at, which is the failure that has actually happened here.
  const WAIVED = new Map([
    ['🕐', 'the half-day banner — needs an exchange on an early-close session on the capture date'],
    ['🟢', 'a wire that stopped being true — needs two briefs, and SINCE has no prior snapshot here'],
    ['🔄', 'the same: the delta section renders nothing without a previous delivered brief'],
    ['📏', 'the expected range — lives in the GEX map, which needs the option book from KV'],
    ['⚡', 'the GEX map itself, for the same reason'],
    ['⚪', 'a market shut for a weekend or holiday on the capture date'],
    ['👀', 'the watchlist heading — the fixtures carry no cross-region quote batch'],
  ]);

  const seen = new Set();
  for (const t of Object.values(rendered)) {
    for (const e of emitted) if (t.includes(e)) seen.add(e);
  }
  const unseen = [...emitted].filter(e => !seen.has(e) && !WAIVED.has(e));
  eq(`every line marker the brief can emit is rendered by a fixture${unseen.length ? ` — unseen: ${unseen.join(' ')}` : ''}`, unseen, []);
  ok('and the check is looking at a real set of markers', emitted.size >= 10);
  // A waiver for a marker that no longer exists is stale bookkeeping pretending to be a decision.
  const stale = [...WAIVED.keys()].filter(e => !emitted.has(e));
  eq(`no stale waivers${stale.length ? ` — ${stale.join(' ')}` : ''}`, stale, []);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
