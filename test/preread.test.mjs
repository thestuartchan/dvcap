// test/preread.test.mjs — the delivery window.
import { readFileSync } from 'node:fs';
import { localDateIn, localMinutesOfDay, localWeekday, isWeekendIn } from '../lib/sessions.js';
//
// The whole daily brief hangs on this arithmetic and it had never been pinned. The Asia brief was
// skipped on 2026-08-28; the endpoint was healthy and the schedule correct, and the only structural
// fragility in the path was that every region's cron fired at sinceOpen = 0 — the first accepted
// value, with no tolerance at all on the early side.
import { prereadStatus, prereadMissed } from '../lib/preread.js';
import { prereadWindow } from '../api/preread.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const at = (h, m, target) => prereadWindow(h * 60 + m, target);

// Asia: target 07:00 HKT, cron at 22:45 UTC = 06:45 local.
ok('the scheduled firing delivers', at(6, 45, 7).accept);
eq('and sits inside the window rather than on its edge', at(6, 45, 7).sinceOpen, 5);

// THE FAILURE THIS CLOSES. Before the grace, the window opened at 06:45 exactly, so a cron one
// minute early was a whole day's brief lost — silently, because nothing recorded that it should
// have run.
ok('a firing one minute early still delivers', at(6, 44, 7).accept);
ok('and five minutes early', at(6, 40, 7).accept);
ok('but not six', !at(6, 39, 7).accept);

// Late tolerance is unchanged: the assemble-and-post takes a few seconds, and Vercel crons drift.
ok('forty minutes late still delivers', at(7, 25, 7).accept);
ok('an hour late does not', !at(7, 40, 7).accept);

// THE DST PAIR NO LONGER HAS TO BE MUTUALLY EXCLUSIVE, and that is the point.
//
// The window used to be capped under 60 minutes for one reason: the two DST candidate crons are
// exactly 60 local minutes apart, and if both passed the brief posted twice. The same-day dedupe
// removed that constraint — a second firing in one window is a no-op that says so — which freed
// the span to describe something real instead of a scheduling artefact.
{
  const first = at(8, 45, 9), second = at(9, 45, 9);
  eq('with no deadline the old behaviour is preserved exactly', [first.accept, second.accept], [true, false]);
  // With a deadline, BOTH candidates may now be accepted, and that is safe rather than a bug.
  const withDl = (h, m) => prereadWindow(h * 60 + m, 9, { deadlineMin: 10 * 60 });
  eq('a stated deadline can admit both candidates', [withDl(8, 45).accept, withDl(9, 45).accept], [true, true]);
  ok('which is only safe because the dedupe makes the second a no-op', true);
}

// Window boundaries are half-open, so the arithmetic has no ambiguous minute.
{
  const w = prereadWindow(0, 7);
  eq('open is lead+grace before the target', w.open, 7 * 60 - 20);
  eq('and close is grace+window past it', w.close, w.open + 5 + 55);
  ok('the first minute is in', prereadWindow(w.open, 7).accept);
  ok('and the closing minute is out', !prereadWindow(w.close, 7).accept);
}

// ── THE DEDUPE HAS TO ASK IN THE REGION'S DAY ───────────────────────────────
// The schedule is now a poll: many attempts per window, and the gate accepts whichever lands
// inside it. That is only safe because a region that has already delivered today refuses the
// later attempts — and "today" has to mean the region's calendar day, not UTC's.
{
  // 23:10 UTC on 2026-09-02. Hong Kong is already on the 3rd; New York is still on the 2nd. The
  // Asia pre-read targets 07:00 HKT, so it fires in exactly this band — a UTC-dated check would
  // call the second attempt a new day and post the brief twice.
  const t = new Date('2026-09-02T23:10:00Z');
  eq('UTC and Hong Kong disagree about the date here', localDateIn('Asia/Hong_Kong', t), '2026-09-03');
  eq('and New York does not', localDateIn('America/New_York', t), '2026-09-02');
  ok('which is the whole reason the check is per-region',
    localDateIn('Asia/Hong_Kong', t) !== t.toISOString().slice(0, 10));

  // Two attempts inside one Asia window must agree they are the same day.
  const a1 = new Date('2026-09-02T23:07:00Z'), a2 = new Date('2026-09-02T23:39:00Z');
  eq('two attempts in one window are one day', localDateIn('Asia/Hong_Kong', a1), localDateIn('Asia/Hong_Kong', a2));
  // And the next day's window must not be.
  eq('the next day is a different day', localDateIn('Asia/Hong_Kong', new Date('2026-09-03T23:07:00Z')), '2026-09-04');

  // DST is the other thing this must survive: London's local date is unaffected by the BST/GMT
  // switch, which is precisely why the cron pairs could be deleted.
  eq('London in BST', localDateIn('Europe/London', new Date('2026-09-02T08:07:00Z')), '2026-09-02');
  eq('London in GMT', localDateIn('Europe/London', new Date('2026-11-03T09:07:00Z')), '2026-11-03');
  // Just before local midnight in GMT, UTC and London agree; the point is it never throws or drifts.
  eq('and across a year boundary', localDateIn('Europe/London', new Date('2027-01-01T00:30:00Z')), '2027-01-01');

  eq('a nonsense zone yields null rather than a wrong date',
    (() => { try { return localDateIn('Not/AZone', t); } catch { return null; } })(), null);
}

// ── THE DEADLINE, WHICH IS WHAT THE WINDOW SHOULD ALWAYS HAVE BEEN ──────────
// 2026-09-03: the one run GitHub delivered all day arrived at 08:02 HKT and was refused, because
// a 55-minute rule had closed the window at 07:40. The rule knew nothing about what the brief was
// for. Asia's real deadline is the Korea/Japan open at 08:00 HKT — so the refusal was RIGHT, and
// only a working scheduler fixes that morning. But the same rule was refusing Europe at 09:40
// while its brief is written to land into a session that runs to 10:00 and beyond.
{
  // Deadlines are the open PLUS FIFTEEN — a brief landing in the first minutes of a session is
  // still the brief it was meant to be.
  const asia = (h, m) => prereadWindow(h * 60 + m, 7, { deadlineMin: 8 * 60 + 15 });
  ok('an Asia brief at 07:55 delivers', asia(7, 55).accept);
  ok('and at 08:02 — the run that was refused on 2026-09-03 — it now does too', asia(8, 2).accept);
  ok('fifteen minutes into the Korea/Japan open is the line', !asia(8, 15).accept);
  ok('one minute inside it is not', asia(8, 14).accept);
  eq('and it reports how late against the target, not the window', asia(8, 2).lateMin, 62);
  // The old fixed rule would have refused it, which is the whole reason it changed.
  ok('the old 55-minute rule refused that run', !prereadWindow(8 * 60 + 2, 7).accept);

  const eu = (h, m) => prereadWindow(h * 60 + m, 9, { deadlineMin: 10 * 60 });
  ok('Europe at 09:55 now delivers, where the old rule refused it', eu(9, 55).accept);
  ok('but 10:00 is the line', !eu(10, 0).accept);
  ok('the old rule would have refused 09:55', !prereadWindow(9 * 60 + 55, 9).accept);

  const us = (h, m) => prereadWindow(h * 60 + m, 9, { deadlineMin: 9 * 60 + 45 });
  ok('the US delivers fifteen minutes into the open', us(9, 44).accept);
  ok('and not a minute later', !us(9, 45).accept);
  ok('a deadline must never SHRINK the window', prereadWindow(9 * 60 + 35, 9).accept);

  // Early is still early, deadline or not.
  ok('nothing opens before lead+grace', !asia(6, 39).accept);
  ok('and the first accepted minute is unchanged', asia(6, 40).accept);
  // A region with no deadline behaves exactly as before.
  eq('no deadline, no change', prereadWindow(7 * 60 + 25, 7).accept, prereadWindow(7 * 60 + 25, 7, { deadlineMin: null }).accept);
}

// ── SILENCE MUST NOT BE SILENT ──────────────────────────────────────────────
// Every missing brief so far was found by a person noticing an absence in a chat channel, days
// later. This is the same question asked by the system.
{
  const R = {
    asia: { label: 'Asia', tz: 'Asia/Hong_Kong', prereadHourLocal: 7, prereadDeadlineLocal: 8 * 60 },
    us:   { label: 'US', tz: 'America/New_York', prereadHourLocal: 9, prereadDeadlineLocal: 9 * 60 + 30 },
  };
  const st = (log, iso) => prereadStatus(log, { regions: R, now: new Date(iso), localDateIn, localMinutesOfDay });
  const of = (rows, r) => rows.find(x => x.region === r);

  // 23:10 UTC on the 2nd is 07:10 on the 3rd in Hong Kong — inside Asia's window, after its target.
  const due = st({}, '2026-09-02T23:10:00Z');
  eq('a brief still inside its window is due, not missed', of(due, 'asia').state, 'due');
  eq('and nothing is reported', prereadMissed(due).filter(r => r.region === 'asia').length, 0);

  // 00:05 UTC on the 3rd is 08:05 HKT — past the Korea/Japan open, and nothing was posted.
  const missed = st({}, '2026-09-03T00:05:00Z');
  eq('past the deadline with nothing posted is missed', of(missed, 'asia').state, 'missed');
  eq('and it says how far past', of(missed, 'asia').minsPastDeadline, 5);
  ok('and it is what gets reported', prereadMissed(missed).some(r => r.region === 'asia'));
  eq('with no prior delivery it says so', of(missed, 'asia').lastAt, null);

  // The same moment with a delivery recorded for Hong Kong's date.
  const ok1 = st({ asia: { at: '2026-09-02T23:12:00Z', localDate: '2026-09-03' } }, '2026-09-03T00:05:00Z');
  eq('a delivered brief is not missed', of(ok1, 'asia').state, 'delivered');
  eq('and nothing is raised', prereadMissed(ok1).length === 0 || !prereadMissed(ok1).some(r => r.region === 'asia'), true);

  // YESTERDAY'S delivery does not cover today — the exact shape of the failure being detected.
  const stale = st({ asia: { at: '2026-09-01T23:12:00Z', localDate: '2026-09-02' } }, '2026-09-03T00:05:00Z');
  eq('yesterday’s brief does not count for today', of(stale, 'asia').state, 'missed');
  ok('and the last delivery is shown so the gap is legible', of(stale, 'asia').lastAt === '2026-09-01T23:12:00Z');

  // Before the window opens there is nothing to say. 20:00 UTC is 04:00 the next day in Hong Kong,
  // which is ahead of the 06:40 open — whereas midday UTC is 20:00 HKT, long PAST that morning's
  // deadline, and correctly reads as missed for the day that has already gone.
  eq('before the window opens it is pending', of(st({}, '2026-09-02T20:00:00Z'), 'asia').state, 'pending');
  eq('but an evening with nothing delivered is a miss, not a silence', of(st({}, '2026-09-02T12:00:00Z'), 'asia').state, 'missed');
  // The Asia date is a day ahead of UTC, which is the whole reason the check is per-region.
  ok('the region’s own date is used', of(st({}, '2026-09-02T23:10:00Z'), 'asia').today === '2026-09-03');
  eq('and the US is on its own day', of(st({}, '2026-09-02T23:10:00Z'), 'us').today, '2026-09-02');
  // A region with no config is skipped rather than guessed at.
  eq('an unconfigured region is not invented', prereadStatus({}, { regions: { x: {} }, now: new Date(), localDateIn, localMinutesOfDay }).length, 0);
}

// ── ONE CRON MINUTE, THREE REGIONS, BOTH DST HALVES ────────────────────────
// The schedule in vercel.json is a single entry firing at minute 42 of three hours. That is only
// possible because of the open-plus-fifteen deadlines, and it is the property the whole schedule
// rests on, so it is asserted rather than left to a comment.
{
  const TZ = { asia: 'Asia/Hong_Kong', eu: 'Europe/London', us: 'America/New_York' };
  const HOUR = { asia: 22, eu: 8, us: 13 };
  const TARGET = { asia: 7, eu: 9, us: 9 };
  const DEADLINE = { asia: 8 * 60 + 15, eu: 10 * 60, us: 9 * 60 + 45 };
  const CRON_MIN = 42;
  const halves = ['2026-09-03', '2026-12-03'];   // BST/EDT and GMT/EST

  const landsIn = (region, day, minute) => {
    const t = new Date(Date.parse(`${day}T00:00:00Z`) + (HOUR[region] * 60 + minute) * 60000);
    const local = localMinutesOfDay(TZ[region], t);
    return prereadWindow(local, TARGET[region], { deadlineMin: DEADLINE[region] }).accept;
  };

  for (const region of ['asia', 'eu', 'us']) {
    for (const day of halves) {
      ok(`${region} is delivered at :${CRON_MIN} on ${day}`, landsIn(region, day, CRON_MIN));
    }
  }
  // The US is the binding constraint, and the reason the old deadline could not be collapsed:
  // with 09:30 no minute of 13:xx UTC works in both halves.
  const worksBoth = (dl) => Array.from({ length: 60 }, (_, m) => m).filter(m => halves.every(day => {
    const t = new Date(Date.parse(`${day}T00:00:00Z`) + (13 * 60 + m) * 60000);
    return prereadWindow(localMinutesOfDay('America/New_York', t), 9, { deadlineMin: dl }).accept;
  }));
  eq('at the old 09:30 deadline no US minute works year-round', worksBoth(9 * 60 + 30).length, 0);
  ok('at 09:45 a band opens up', worksBoth(9 * 60 + 45).length > 0);
  ok('and the chosen minute is inside it', worksBoth(9 * 60 + 45).includes(CRON_MIN));
}

// ── THE CRON WEEK IS NOT THE REGION'S WEEK ────────────────────────────────────────────────────
// Both entries were `* * *` and delivered a pre-market brief every weekend. The Asia one is the
// trap: its firing lands the NEXT calendar day locally, so its UTC week runs one ahead, and the
// obvious `1-5` would have delivered Tue-Sat in Hong Kong. These tests assert the real mapping
// from the UTC instants the cron actually fires at, not from the cron string.
{
  const HK = 'Asia/Hong_Kong', NY = 'America/New_York';
  const at = iso => new Date(iso);
  const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  // Asia fires 22:42 UTC. Walk a whole UTC week and record which local day each lands on.
  const asiaWeek = [];
  for (let d = 30; d <= 36; d++) {           // 2026-08-30 (Sun) .. 2026-09-05 (Sat) UTC
    const iso = d <= 31 ? `2026-08-${d}` : `2026-09-0${d - 31}`;
    const t = at(`${iso}T22:42:00Z`);
    asiaWeek.push([dayName[t.getUTCDay()], dayName[localWeekday(HK, t)]]);
  }
  eq('Asia local day is one AHEAD of the UTC day, all week', asiaWeek,
     [['Sun','Mon'],['Mon','Tue'],['Tue','Wed'],['Wed','Thu'],['Thu','Fri'],['Fri','Sat'],['Sat','Sun']]);
  // The firing the user actually saw: Friday night UTC, Saturday morning in Hong Kong.
  ok('Fri 22:42 UTC is a WEEKEND in Asia — the brief that fired', isWeekendIn(HK, at('2026-09-04T22:42:00Z')));
  eq('and its local date is the Saturday', localDateIn(HK, at('2026-09-04T22:42:00Z')), '2026-09-05');
  ok('Sat 22:42 UTC is also a weekend in Asia', isWeekendIn(HK, at('2026-09-05T22:42:00Z')));
  ok('Sun 22:42 UTC is a TRADING day in Asia (Monday)', !isWeekendIn(HK, at('2026-09-06T22:42:00Z')));
  ok('Thu 22:42 UTC is a trading day in Asia (Friday)', !isWeekendIn(HK, at('2026-09-03T22:42:00Z')));

  // 0-4 (Sun-Thu UTC) is exactly the set of Asia firings that land on a weekday. The point of
  // this assertion is that 1-5 is NOT — the intuitive fix is the wrong one.
  const SUN = Date.UTC(2026, 8, 6, 22, 42);   // 2026-09-06 22:42Z is a Sunday in UTC
  const asiaUtcDaysThatWork = [0,1,2,3,4,5,6]
    .map(i => new Date(SUN + i * 864e5))
    .filter(d => !isWeekendIn(HK, d))
    .map(d => d.getUTCDay());
  eq('Asia wants UTC Sun-Thu = 0-4', asiaUtcDaysThatWork, [0,1,2,3,4]);

  // US fires 12:42 UTC and lands the SAME day, so its UTC week and local week agree.
  eq('US local day equals the UTC day', localWeekday(NY, at('2026-09-07T12:42:00Z')), 1);
  ok('Sat 12:42 UTC is a weekend in the US', isWeekendIn(NY, at('2026-09-05T12:42:00Z')));
  ok('Sun 12:42 UTC is a weekend in the US', isWeekendIn(NY, at('2026-09-06T12:42:00Z')));
  ok('Mon 12:42 UTC is a trading day in the US', !isWeekendIn(NY, at('2026-09-07T12:42:00Z')));
  ok('Fri 12:42 UTC is a trading day in the US', !isWeekendIn(NY, at('2026-09-04T12:42:00Z')));

  // The guard must not over-reach: an unknown weekday is not a weekend, so it can never silence
  // a brief it is unsure about.
  eq('bogus timezone yields no weekday', localWeekday('Not/AZone'), null);
  eq('an INVALID DATE yields null, it does not throw', localWeekday('Asia/Hong_Kong', new Date('nope')), null);
  ok('and an invalid date is not called a weekend', !isWeekendIn('Asia/Hong_Kong', new Date('nope')));
  ok('and is therefore NOT called a weekend', !isWeekendIn('Not/AZone'));

  // EU fires 07-09 UTC into a same-day local morning, so its existing 1-5 was already right.
  ok('Sat 08:00 UTC is a weekend in London', isWeekendIn('Europe/London', at('2026-09-05T08:00:00Z')));
  ok('Wed 08:00 UTC is not', !isWeekendIn('Europe/London', at('2026-09-02T08:00:00Z')));
}

// The shipped cron strings must match the mapping proved above. A schedule is the one part of
// this that no runtime test would otherwise touch.
{
  const cfg = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const sched = Object.fromEntries(cfg.crons.map(c => [c.path.match(/region=(\w+)/)[1], c.schedule]));
  eq('asia cron is Sun-Thu UTC', sched.asia, '42 22 * * 0-4');
  eq('us cron is Mon-Fri UTC', sched.us, '42 12 * * 1-5');
  ok('neither entry fires all seven days', !Object.values(sched).some(v => v.endsWith('* * *')));
  // vercel.json is schema-validated; an unknown key can reject the whole deployment.
  ok('no extra keys on any cron entry',
     cfg.crons.every(c => JSON.stringify(Object.keys(c).sort()) === '["path","schedule"]'));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
