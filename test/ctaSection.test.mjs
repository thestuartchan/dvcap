// test/ctaSection.test.mjs — the pre-read's trend-fund section (lib/briefSections.js ctaSection).
import { ctaSection, CTA_NAMES, CTA_TRIGGER_SIGMAS } from '../lib/briefSections.js';
import { assertObservational } from '../lib/read.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// The book as the live model read it on 2026-09-25.
const book = { at: '2026-09-25T12:00:00Z', markets: [
  { key: 'ES', ok: true, position: 0.76, stance: 'long', change: 0.41, cut: { label: '1m', flip: 7690, flipPct: -1.34, flipSigmas: -1.85 } },
  { key: 'NQ', ok: true, position: 0.82, stance: 'max long', change: 0.53, cut: { label: '3m', flip: 29368.25, flipPct: -5.17, flipSigmas: -4.08 } },
  { key: 'ZN', ok: true, position: -1, stance: 'max short', change: 0, cut: { label: '1m', flip: 108.66, flipPct: 3.7, flipSigmas: 13.66 } },
  { key: 'DX', ok: true, position: 0.54, stance: 'long', change: 0.13, cut: { label: '1m', flip: 98.92, flipPct: -2.04, flipSigmas: -6.93 } },
  { key: 'CL', ok: true, position: 0.84, stance: 'max long', change: -0.11, cut: { label: '1m', flip: 82.23, flipPct: -11.06, flipSigmas: -3.75 } },
  { key: 'GC', ok: true, position: 0.07, stance: 'neutral', change: -0.18, cut: { label: 'net', net: true, flip: 4273.95, flipPct: -1.39, flipSigmas: -1.05, side: 'below', tips: 'short' } },
] };
const now = new Date('2026-09-25T12:30:00Z');
const s = ctaSection(book, { now });
const lines = s.split('\n');
{
  eq('one line per market, biggest first, then the two-line key', lines.length, 8);
  eq('the crowded short leads', lines[0], '• **10Y note** max short 100% · crowded');
  eq('a crowded long, with its week\'s arrow', lines[2], '• **Nasdaq** max long 82% ▲ · crowded');
  eq('a near trigger sits on its own market\'s line', lines[3], '• **S&P** long 76% ▲ — model selling starts below **7,690** (−1.3%)');
  eq('a far trigger is not shown', lines[1], '• **crude** max long 84% · crowded');
  eq('neutral, with the level that tips it', lines[5], '• **gold** neutral — tips net short below **4,273.95** (−1.4%)');
  eq('the key says what the numbers and marks mean', lines[6], '_How to read: % = share of the model\'s maximum long or short · crowded = 80%+ (little left to add, the most to unwind if the trend turns) · ▲▼ = a 20-point move this week_');
  eq('then what a level is, and what it is not', lines[7], '_A level = the daily close that sets the funds trading the other way, shown when within 3 normal days; an intraday poke through it does not count · a model of trend funds, not their orders_');
  for (const l of lines) ok(`observational: "${l.replace(/\*/g, '').slice(2, 40)}"`, assertObservational(l).ok);
}
{
  const short = ctaSection({ at: book.at, markets: [{ key: 'ZN', ok: true, position: -1, stance: 'max short', change: 0, cut: { label: '1m', flip: 106, flipPct: 1.1, flipSigmas: 1.2 } }] }, { now });
  ok('a short is covering, above', /\*\*10Y note\*\* max short 100% · crowded — short covering starts above \*\*106\*\* \(\+1\.1%\)/.test(short));
  const far = ctaSection({ at: book.at, markets: [book.markets[2]] }, { now });
  ok(`nothing within ${CTA_TRIGGER_SIGMAS} normal days says so`, /no trigger within 3 normal days of price/.test(far));
  ok('nothing is marked crowded under 80%', !/· crowded(?! =)/.test(ctaSection({ at: book.at, markets: [book.markets[5]] }, { now })));
  ok('an old model says so', /⚠️ model from 08:00Z/.test(ctaSection({ ...book, at: '2026-09-25T08:00:00Z' }, { now })));
  eq('no book, no section', ctaSection(null), null);
  eq('a book with no usable market, no section', ctaSection({ markets: [{ key: 'ES', ok: false }] }), null);
  eq('the names', Object.keys(CTA_NAMES), ['ES', 'NQ', 'ZN', 'DX', 'CL', 'GC']);
}
console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
