// test/staleprint.test.mjs — "flat" and "nothing published" are different facts.
//
// Observed 2026-09-09. Header: "CREDIT CALM · OAS 2.68". READ block: "CREDIT, CALM, flat — OAS
// 2.68 (+0 1d)". There had been no new OAS observation; the last print was 2026-09-07.
//
// "+0 1d" is a claim about the market — the spread was unchanged yesterday. The truth was a claim
// about the release calendar — the series did not publish. Those call for opposite responses, and
// they rendered identically. The observation age was already computed and carried on the object;
// nothing consumed it, and `basis` was the string '1D' hardcoded at every call site.
import { composeRead, noNewPrint, deltaPhrase } from '../lib/read.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const OBS = (d, biz) => ({ available: true, obsDate: d, bizDays: biz, calendarDays: biz, chip: biz <= 1 ? 'neutral' : 'amber' });

// ── the predicate ────────────────────────────────────────────────────────────
{
  // A daily FRED series publishes with a one-business-day lag as a matter of course. Yesterday's
  // print read today is the ORDINARY case and must not be flagged, or the warning is always on.
  eq('yesterday\'s print is not stale', noNewPrint(OBS('2026-09-08', 1)), false);
  eq('same-day is certainly not', noNewPrint(OBS('2026-09-09', 0)), false);
  eq('two business days is', noNewPrint(OBS('2026-09-07', 2)), true);
  eq('and three certainly is', noNewPrint(OBS('2026-09-04', 3)), true);
  eq('no observation object at all is not a stale print', noNewPrint(null), false);
  eq('nor is an unavailable one', noNewPrint({ available: false }), false);
}

// ── the phrase ───────────────────────────────────────────────────────────────
{
  const d1 = { delta: 0, basis: '1d', to: 2.68 };
  eq('a fresh print keeps the delta', deltaPhrase(d1, OBS('2026-09-08', 1)), '+0 1d');
  // The exact string the panel was printing, and what replaces it.
  const stale = deltaPhrase(d1, OBS('2026-09-07', 2));
  ok('a stale print says so instead', /no new print since 2026-09-07/.test(stale));
  ok('and gives the gap in business days', /2 business days/.test(stale));
  ok('and never renders as a delta', !/\+0/.test(stale));
  eq('no delta at all is null', deltaPhrase(null, OBS('2026-09-07', 2)), null);
}

// ── the READ block ───────────────────────────────────────────────────────────
{
  const base = (obs) => composeRead({
    credit: { level: 'CALM', word: 'FLAT', state: 'calm', d1: { delta: 0, basis: '1d', to: 2.68 }, obs },
    hyg: { available: true, changePct: 0.12, stressing: false },
    usRthOpen: true,
  });

  const fresh = base(OBS('2026-09-08', 1));
  const stale = base(OBS('2026-09-07', 2));
  const row = (r) => r.structured.rows.find(x => x.label === 'CREDIT');

  ok('the fresh row still carries the direction word', /flat/i.test(row(fresh).state));
  ok('and the delta', /\+0 1d/.test(row(fresh).detail));

  // THE FIX. "CALM, flat" asserts the spread did not move; what happened is that nothing
  // published, and the direction word is the part that lies.
  eq('the stale row drops the direction word', row(stale).state, 'CALM');
  ok('and says nothing published', /no new print since 2026-09-07/.test(row(stale).detail));
  ok('it never prints "+0 1d"', !/\+0 1d/.test(row(stale).detail));
  eq('the row is flagged for the UI', row(stale).stale, true);
  // HY OAS is the master regime gate — a stale one is not a muted footnote.
  eq('and toned as a warning rather than muted', row(stale).tone, 'amber');
  eq('while a fresh calm row stays muted', row(fresh).tone, 'muted');

  // HYG is the live tell against an EOD/T+1 series; marking it live is the whole point of showing
  // it beside a stale OAS.
  ok('HYG is labelled live so the contrast is visible', /HYG .* \(live\)/.test(row(stale).detail));

  // The prose has to agree with the structured row, or the card contradicts itself.
  const prose = stale.sentences.join(' ');
  ok('the prose says which reading it is', /2026-09-07 reading/.test(prose));
  ok('and that the direction describes the move INTO it', /not today/.test(prose));

  // Confidence. A gate input being stale caps the grade: the number of things wrong is not the
  // same as how badly the worst one is wrong.
  eq('a stale master gate drops confidence to low', stale.confidence, 'low');
  ok('and names itself in the caveats', stale.caveats.some(c => /master|credit gate is reading a stale/i.test(c)));
  ok('with the date', stale.caveats.some(c => /2026-09-07/.test(c)));
  ok('a fresh board is not dragged down by it', fresh.confidence !== 'low');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
