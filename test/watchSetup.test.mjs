// test/watchSetup.test.mjs — the watchlist answers "where is a move set up", not "what moved".
//
// Built on synthetic bars whose ATR, range and levels are known by construction, so each tag is
// checked against a fact rather than against whatever the code said.
import {
  setupStats, setupTags, setupCandidates, setups, extendedLine, renderSetups,
  SETUP_MAX, GAP_MIN_PCT, COIL_PCTILE_MAX, LEVEL_MAX_ATR, EXTENDED_MIN_ATR, CANDIDATE_MAX,
} from '../lib/watchSetup.js';
import { assertObservational } from '../lib/read.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// A year of bars at a steady $2 range around a drifting close, with the last days shaped on demand.
const day = (i) => { const d = new Date(Date.UTC(2025, 8, 1)); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };
function bars({ n = 260, range = 2, close = 100, last = [] } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ date: day(i), high: close + range / 2, low: close - range / 2, close });
  for (let j = 0; j < last.length; j++) out[n - last.length + j] = { date: day(n - last.length + j), ...last[j] };
  return out;
}

// A coil: thirteen quiet days at a quarter of the usual range, and yesterday narrower still.
const coilBars = () => bars({ last: [...Array.from({ length: 13 }, () => ({ high: 100.25, low: 99.75, close: 100 })), { high: 100.2, low: 99.8, close: 100 }] });

// ── THE STATS ────────────────────────────────────────────────────────────────
{
  const s = setupStats(bars());
  eq('a steady $2 range is a $2 ATR', s.atr, 2);
  eq('yesterday is the last bar before the open', [s.yHigh, s.yLow, s.yClose, s.yDate], [101, 99, 100, day(259)]);
  eq('the 52-week levels', [s.hi52, s.lo52], [101, 99]);
  eq('a flat tape has no move in ATRs', s.yMoveAtr, 0);
  eq('every day the same range is not a narrow day — a tie is not a coil', s.nr7, false);
  // During the session the last bar is today and partial — yesterday is the one before it.
  const open = setupStats(bars({ last: [{ high: 120, low: 80, close: 100 }] }), { open: true });
  eq('open: the partial bar is skipped', [open.yHigh, open.yLow], [101, 99]);
  eq('too few bars, no stats', setupStats(bars({ n: 10 })), null);
  eq('garbage, no stats', setupStats(null), null);
  // A coil: the last fourteen days at a quarter of the usual range.
  const coiled = setupStats(coilBars());
  ok('a quiet fortnight puts the ATR at the bottom of its year', coiled.atrPctile != null && coiled.atrPctile <= COIL_PCTILE_MAX);
  ok('and the range is narrowest in seven', coiled.nr7);
}

// ── THE TAGS ─────────────────────────────────────────────────────────────────
{
  // The averages sit on the close in a flat tape, so they are dropped here to test the other levels.
  const flat = { ...setupStats(bars()), ma50: null, ma200: null };
  const base = { sym: 'X', price: 100, changePct: 0, setup: flat };
  // GAPPING: a live pre-market print, a real gap.
  const gap = setupTags({ ...base, ext: { price: 102.1, changePct: 2.1, stale: false, session: 'pre' } });
  eq('a pre-market gap is tagged', gap.find(t => t.kind === 'gap')?.text, 'gapping +2.1% pre-market');
  eq('drift is not a gap', setupTags({ ...base, ext: { price: 100.3, changePct: 0.3, stale: false, session: 'pre' } }).some(t => t.kind === 'gap'), false);
  eq('a stale print is not a gap', setupTags({ ...base, ext: { price: 102.1, changePct: 2.1, stale: true, session: 'pre' } }).some(t => t.kind === 'gap'), false);
  eq('an after-hours print is not a gap', setupTags({ ...base, ext: { price: 102.1, changePct: 2.1, stale: false, session: 'post' } }).some(t => t.kind === 'gap'), false);
  eq('the gap floor is stated', GAP_MIN_PCT, 0.75);
  // AT A LEVEL: the pre-market print against the named levels, in ATRs.
  const near = setupTags({ ...base, ext: { price: 100.4, changePct: 0.4, stale: false, session: 'pre' } });
  eq('within half an ATR of yesterday\'s high, in ATRs', near.find(t => t.kind === 'level')?.text, '0.3 ATR under yesterday\'s high (101.00)');
  const over = setupTags({ ...base, price: 101.4, ext: null });
  eq('over a level says over', over.find(t => t.kind === 'level')?.text, '0.2 ATR over yesterday\'s high (101.00)');
  const far = setupTags({ ...base, price: 100, setup: { ...flat, yHigh: 110, yLow: 90, hi52: 120, lo52: 80, ma50: 95, ma200: 90 } });
  eq('nothing inside half an ATR, no level tag', far.some(t => t.kind === 'level'), false);
  const avg = setupTags({ ...base, price: 100.4, setup: { ...flat, ma50: 100 } });
  eq('the nearest level wins — here the 50-day average', avg.find(t => t.kind === 'level')?.text, '0.2 ATR over the 50-day average (100.00)');
  eq('the level width is stated', LEVEL_MAX_ATR, 0.5);
  // COILED.
  const coiled = setupStats(coilBars());
  const coil = setupTags({ ...base, setup: coiled });
  ok('a coil is tagged with the percentile and the narrow day', /^coiled: 14-day range at the \d+(st|nd|rd|th) percentile of its year, narrowest day in 7$/.test(coil.find(t => t.kind === 'coil')?.text || ''));
  // CATALYST: today or tomorrow, from the cached feed's answer.
  const today = '2026-09-23', tomorrow = '2026-09-24';
  eq('earnings today', setupTags(base, { earnings: { ok: true, date: today, time: 'after close', status: 'confirmed' }, today, tomorrow }).find(t => t.kind === 'catalyst')?.text, 'earnings today (after close)');
  eq('earnings tomorrow, estimated', setupTags(base, { earnings: { ok: true, date: tomorrow, time: null, status: 'estimated' }, today, tomorrow }).find(t => t.kind === 'catalyst')?.text, 'earnings tomorrow, estimated');
  eq('earnings next week is not a tag', setupTags(base, { earnings: { ok: true, date: '2026-09-30' }, today, tomorrow }).some(t => t.kind === 'catalyst'), false);
  eq('a feed with no date is not a tag', setupTags(base, { earnings: { ok: false, date: null }, today, tomorrow }).some(t => t.kind === 'catalyst'), false);
  eq('no setup, no ext: no tags', setupTags({ sym: 'X', price: 100 }), []);
}

// ── THE LIST ─────────────────────────────────────────────────────────────────
{
  const flat = { ...setupStats(bars()), ma50: null, ma200: null };
  const nothing = { ...flat, yHigh: 110, yLow: 90, hi52: 120, lo52: 80 };
  const coiled = { ...setupStats(coilBars()), ma50: null, ma200: null };
  const pre = (pct) => ({ price: 100 * (1 + pct / 100), changePct: pct, stale: false, session: 'pre' });
  const rows = [
    { sym: 'NVDA', price: 100, changePct: 0, setup: flat, ext: pre(2.1) },                 // gap + level (0.6 ATR over high? no: 102.1 is 1.1 over 101 → 0.55 ATR, outside) → gap only
    { sym: 'MU', price: 100, changePct: 0, setup: coiled, ext: pre(1.2) },                 // gap + coil + level
    { sym: 'AMD', price: 100, changePct: 0, setup: nothing, ext: pre(0.2) },               // nothing
    { sym: 'INTC', price: 100, changePct: 0, setup: coiled, ext: null },                   // coil + level (at yesterday's close ≈ high?) → coil (+ level if inside)
    { sym: 'ARM', price: 100, changePct: 0, setup: flat, ext: pre(-3.0) },                 // gap
    { sym: 'META', price: 100, changePct: 0, setup: flat, ext: pre(1.0) },                 // gap
    { sym: 'GOOGL', price: 100, changePct: 0, setup: flat, ext: pre(0.9) },                // gap
    { sym: 'AMZN', price: null, setup: flat },                                             // no price: skipped
  ];
  const list = setups(rows, { today: '2026-09-23', tomorrow: '2026-09-24' });
  eq('capped', list.length <= SETUP_MAX, true);
  eq('the name carrying the most tags leads', list[0].sym, 'MU');
  // META and GOOGL gap onto yesterday's high and carry two tags; the fifth slot goes to the
  // single-tag name with the bigger gap, and NVDA, with the smaller one, misses the cut.
  eq('ties break on the size of the gap', list[4].sym, 'ARM');
  ok('the smaller gap misses the cut', !list.some(r => r.sym === 'NVDA'));
  ok('a name with nothing set up is not listed', !list.some(r => r.sym === 'AMD'));
  ok('a name with no price is not listed', !list.some(r => r.sym === 'AMZN'));
  ok('the earnings feed is asked about tagged names only, capped', setupCandidates(rows).length <= CANDIDATE_MAX && !setupCandidates(rows).includes('AMD'));
  eq('the candidates lead with the most-tagged', setupCandidates(rows)[0], 'MU');

  // Yesterday's movers: extended in ATRs, one line, or nothing.
  const bySym = new Map(rows.map(r => [r.sym, r]));
  const movers = [{ sym: 'NVDA', name: 'NVDA', price: 106, changePct: 6.0 }, { sym: 'AMD', name: 'AMD', price: 101, changePct: 1.0 }];
  const ext = extendedLine(movers, bySym);
  ok('a 6% day on a $2 ATR is extended', /^_extended after yesterday, not a setup: NVDA \+6\.0% \(3\.0 ATR\)_$/.test(ext));
  eq('a 1% day is not', extendedLine([movers[1]], bySym), null);
  eq('the threshold is stated', EXTENDED_MIN_ATR, 2);
  eq('no ATR known, no claim', extendedLine(movers, new Map()), null);

  // Rendering: name, ticker in a code span, price, the tags — and the extended line last.
  const text = renderSetups(list, { extended: ext });
  ok('a row renders name, ticker, price and tags', /^• \*\*MU\*\* · 101\.20 — gapping \+1\.2% pre-market · coiled: /m.test(text));
  ok('a name with a display name renders it with the ticker in a code span', /^• \*\*[^*]+\*\* `[A-Z0-9.]+` · /m.test(renderSetups([{ sym: '0005.HK', name: 'HSBC', price: 70, tags: [{ text: 'gapping +1.0% pre-market' }] }])));
  ok('the extended line closes the section', text.split('\n').at(-1).startsWith('_extended after yesterday'));
  eq('nothing set up renders nothing', renderSetups([], {}), null);
  // Observational, every line.
  for (const l of text.split('\n')) { let bad = null; try { assertObservational(l); } catch (e) { bad = e; } ok(`observational: ${l.slice(0, 36)}…`, !bad); }
}

// ── WIRED IN, AND NOTHING FROM THE BOOK ──────────────────────────────────────
{
  const src = readFileSync('api/preread.js', 'utf8');
  ok('the pre-read renders setups, not movers', /renderSetups\(setups\(wrows/.test(src) && !/renderWatchlist\(/.test(src));
  ok('the movers survive only as the extended line', /extended: extendedLine\(movers, rowsBySym\)/.test(src));
  ok('the earnings feed is asked about candidates only', /for \(const sym of setupCandidates\(wrows/.test(src));
  ok('the universe quotes come in-process, with the pre-market overlay', /getQuotes\(missing, \{ prepost: region === 'us' \}\)/.test(src));
  ok('the old /api/prices hop is gone', !/\/api\/prices\?tickers=/.test(src));
  const lib = readFileSync('lib/watchSetup.js', 'utf8');
  ok('no console, no positions, no holdings reach the setup list', !/CONSOLE_KEY|positions|holding/i.test(lib.replace(/\/\/.*$/gm, '')));
  const q = readFileSync('lib/quotes.js', 'utf8');
  ok('the quote row carries the setup stats', /setup: o\.setup \?\? null/.test(q) && /setupStats\(c\.bars/.test(q));
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
