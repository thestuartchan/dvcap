// test/walletpublish.test.mjs — once a day, without trusting a cron to fire.
//
// The card used to publish only when GitHub reported the schedule as '0 22 * * *'. GitHub does not
// honour that: on 2026-09-08 this workflow was scheduled for ~36 detect runs and one publish and
// got five, all detect — the 22:00 entry was dropped outright and the card had never published on
// its own schedule at all. So the hour and a recorded date decide instead, and any surviving
// evening run carries the day. That rule is here because it is the only thing standing between
// "once a day" and "twice, or never".
import { shouldPublish, utcDate, PUBLISH_HOUR_UTC } from '../api/tradecard.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const at = (iso) => new Date(iso);

eq('the publish hour is 22:00 UTC', PUBLISH_HOUR_UTC, 22);

// ── BEFORE THE HOUR ──────────────────────────────────────────────────────────
ok('a morning run does not publish', !shouldPublish({ clock: at('2026-09-09T06:00:00Z'), lastPosted: null }));
ok('nor one at 21:59', !shouldPublish({ clock: at('2026-09-09T21:59:00Z'), lastPosted: null }));

// ── AT AND AFTER IT ──────────────────────────────────────────────────────────
ok('the hour itself publishes', shouldPublish({ clock: at('2026-09-09T22:00:00Z'), lastPosted: null }));
ok('and so does any later run — this is what survives a dropped cron',
   shouldPublish({ clock: at('2026-09-09T23:30:00Z'), lastPosted: null }));
ok('including one that lands after a day with no posts at all',
   shouldPublish({ clock: at('2026-09-09T22:14:00Z'), lastPosted: '2026-09-07' }));

// ── ONCE A DAY ───────────────────────────────────────────────────────────────
// Four scheduled runs sit between 22:00 and midnight. Exactly one must send.
{
  let posts = 0, lastPosted = null;
  for (const t of ['22:00', '22:30', '23:00', '23:30']) {
    const clock = at(`2026-09-09T${t}:00Z`);
    if (shouldPublish({ clock, lastPosted })) { posts++; lastPosted = utcDate(clock); }
  }
  eq('four evening runs produce exactly one card', posts, 1);
}
ok('a second run the same evening does not repeat it',
   !shouldPublish({ clock: at('2026-09-09T23:00:00Z'), lastPosted: '2026-09-09' }));
ok('but the next day it goes again',
   shouldPublish({ clock: at('2026-09-10T22:00:00Z'), lastPosted: '2026-09-09' }));

// ── THE MANUAL OVERRIDE ──────────────────────────────────────────────────────
ok('a forced run publishes at any hour', shouldPublish({ forced: true, clock: at('2026-09-09T03:00:00Z'), lastPosted: null }));
ok('and even if today has already gone out', shouldPublish({ forced: true, clock: at('2026-09-09T23:00:00Z'), lastPosted: '2026-09-09' }));

// ── THE DATE IS UTC, NOT LOCAL ───────────────────────────────────────────────
// The stamp and the comparison must use the same calendar, or a run either side of midnight UTC
// reads as a different day and sends twice.
eq('the stamp is the UTC date', utcDate(at('2026-09-09T23:59:00Z')), '2026-09-09');
eq('and just past midnight it has rolled', utcDate(at('2026-09-10T00:01:00Z')), '2026-09-10');
ok('so a 00:01 run does not re-send the 23:00 card — it is before the hour anyway',
   !shouldPublish({ clock: at('2026-09-10T00:01:00Z'), lastPosted: '2026-09-09' }));

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
