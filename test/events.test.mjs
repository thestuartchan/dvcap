// test/events.test.mjs — the catalyst list is hand-maintained and every entry eventually expires.
// What is tested here is mostly the failure shape: that the module says WHY it is empty, that a
// filtered price fetch cannot bind one name's run-up to another, and that an unresolved date is
// surfaced rather than silently picked.
import { eventPositioning, dueEvents, EVENTS, EVENT_CFG } from '../lib/events.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const NOW = Date.parse('2026-09-01T00:00:00Z');
const day = (n) => new Date(NOW + n * 86400000).toISOString().slice(0, 10);
const ev = (sym, days, extra = {}) => ({ name: sym, sym, date: day(days), label: 'earnings', ...extra });
const trend = (price, chg5d, chg20d, ma50) => ({ price, chg5d, chg20d, ma50 });

// ── the horizon ──────────────────────────────────────────────────────────────
{
  const events = [ev('A', -1), ev('B', 0), ev('C', 14), ev('D', 15)];
  const r = eventPositioning({ events, trends: {}, nowMs: NOW });
  eq('yesterday is out', r.events.some(e => e.sym === 'A'), false);
  eq('today is in', r.events.some(e => e.sym === 'B'), true);
  eq('the boundary day is in', r.events.some(e => e.sym === 'C'), true);
  eq('one day past it is out', r.events.some(e => e.sym === 'D'), false);
  eq('sorted by how close it is', r.events.map(e => e.sym), ['B', 'C']);
  eq('and the past one is counted, not just dropped', r.past, 1);
}
// dueEvents must agree with what eventPositioning surfaces, or the caller fetches the wrong prices.
{
  const events = [ev('A', -1), ev('B', 0), ev('C', 14), ev('D', 15)];
  const due = dueEvents(events, NOW).map(e => e.sym);
  const shown = eventPositioning({ events, trends: {}, nowMs: NOW }).events.map(e => e.sym);
  eq('dueEvents picks exactly what the card will show', due, shown);
}

// ── trends are keyed by symbol, not by position ──────────────────────────────
// This is the bug the sym-keyed map exists to make impossible: the caller only fetches prices for
// the in-horizon subset, so a positional array would hand entry 0's trend to whichever name
// happened to sort first.
{
  const events = [ev('FAR', 90), ev('NEAR', 3)];
  const r = eventPositioning({ events, trends: { NEAR: trend(110, 4, 20, 100) }, nowMs: NOW });
  eq('only the in-horizon name is shown', r.events.map(e => e.sym), ['NEAR']);
  eq('and it got its OWN run-up', r.events[0].chg20d, 20);
  eq('with the stretch measured off its own 50d', r.events[0].vs50dPct, 10);
}
{
  // A symbol with no fetched trend degrades to PARTIAL rather than borrowing someone else's.
  const r = eventPositioning({ events: [ev('X', 3)], trends: { Y: trend(110, 4, 20, 100) }, nowMs: NOW });
  eq('a name with no trend has no run data', r.events[0].reading, 'no run data');
  eq('and is marked PARTIAL', r.events[0].status, 'PARTIAL');
}

// ── the lean, and the verdict it withholds ───────────────────────────────────
{
  const hot = eventPositioning({ events: [ev('H', 3)], trends: { H: trend(110, 6, 22, 100) }, nowMs: NOW }).events[0];
  ok('a big run above the 50d leans stretched', /leans stretched/.test(hot.reading));
  eq('but it is still only a lean, never a verdict', hot.status, 'PARTIAL');
  eq('and the tone stays muted without IV', hot.tone, 'muted');

  const cold = eventPositioning({ events: [ev('L', 3)], trends: { L: trend(88, -3, -14, 100) }, nowMs: NOW }).events[0];
  ok('a sold-off name leans de-risked', /leans de-risked/.test(cold.reading));

  // Run-up alone must not call something stretched: AMD ran hard and still sat under its 50d.
  const under = eventPositioning({ events: [ev('U', 3)], trends: { U: trend(96, 6, 22, 100) }, nowMs: NOW }).events[0];
  ok('a hot run BELOW the 50d is not stretched', /neutral/.test(under.reading));
}
{
  // The full read is unreachable until an options feed is attached — but the shape is live.
  const r = eventPositioning({ events: [ev('IV', 3, { ivPercentile: 85 })], trends: { IV: trend(110, 6, 22, 100) }, nowMs: NOW }).events[0];
  eq('with IV the card commits', r.status, 'FULL');
  ok('and says what is priced in', /priced for perfection/.test(r.reading));
  eq('with a tone worth noticing', r.tone, 'amber');
}

// ── an unresolved date is shown, not guessed ─────────────────────────────────
{
  const r = eventPositioning({ events: [ev('AVGO', 3, { alt: ['2026-09-02'] })], trends: {}, nowMs: NOW }).events[0];
  ok('a conflicting date is called out', /date unconfirmed/.test(r.dateNote));
  ok('naming the other candidate', /2026-09-02/.test(r.dateNote));
  eq('and the alternates survive to the card', r.alt, ['2026-09-02']);
}
{
  const r = eventPositioning({ events: [ev('CLEAN', 3)], trends: {}, nowMs: NOW }).events[0];
  eq('a single-dated event says nothing about dates', r.dateNote, null);
}

// ── why it is empty ──────────────────────────────────────────────────────────
// An empty card that has run out of list and an empty card in a quiet fortnight are the same
// picture and completely different facts.
{
  const r = eventPositioning({ events: [], trends: {}, nowMs: NOW });
  eq('an unconfigured list says so', r.reason, 'no catalysts configured');
  eq('and offers no next', r.next, null);
}
{
  const r = eventPositioning({ events: [ev('OLD', -5), ev('OLDER', -40)], trends: {}, nowMs: NOW });
  ok('a fully expired list asks to be restocked', /needs restocking/.test(r.reason));
  ok('and names the file to edit', /lib\/events\.js/.test(r.reason));
  eq('counting every one of them', [r.configured, r.past], [2, 2]);
}
{
  const r = eventPositioning({ events: [ev('SOON', 40), ev('LATER', 90)], trends: {}, nowMs: NOW });
  eq('a quiet fortnight is not a broken list', r.available, false);
  ok('it points at what is past the edge', /next is SOON \(SOON\) in 40/.test(r.reason));
  eq('and hands the card the whole entry', [r.next.sym, r.next.daysTo], ['SOON', 40]);
}
{
  // `next` is what sits past the horizon — never something already on the card.
  const r = eventPositioning({ events: [ev('IN', 3), ev('OUT', 30)], trends: {}, nowMs: NOW });
  eq('with events showing, reason is silent', r.reason, null);
  eq('and next is the one beyond the horizon', r.next.sym, 'OUT');
}

// ── a bad date cannot poison the list ────────────────────────────────────────
{
  const r = eventPositioning({ events: [{ name: 'Bad', sym: 'BAD', date: 'not-a-date' }, ev('GOOD', 3)], trends: {}, nowMs: NOW });
  eq('an unparseable date is skipped, not rendered as NaN', r.events.map(e => e.sym), ['GOOD']);
  eq('and is not counted as past either', r.past, 0);
  eq('nor promoted to next', r.next, null);
}

// ── the shipped list ─────────────────────────────────────────────────────────
{
  ok('the list is stocked', EVENTS.length > 0);
  eq('every entry has a ticker — that is what makes it a catalyst and not a calendar row',
    EVENTS.filter(e => !e.sym).length, 0);
  eq('every date parses', EVENTS.filter(e => !Number.isFinite(Date.parse(`${e.date}T00:00:00Z`))).length, 0);
  // The list is curated to year-end; if it has all gone past, the card is a restocking notice.
  const live = EVENTS.filter(e => e.date >= '2026-09-01');
  ok('and it runs past the current quarter', live.length >= 10);
  eq('horizon is a fortnight', EVENT_CFG.horizonDays, 14);
}

console.log(`\n${fail ? '❌' : '✅'} ${fail ? `${fail} FAILED, ` : 'ALL '}${pass} PASSED`);
process.exit(fail ? 1 : 0);
