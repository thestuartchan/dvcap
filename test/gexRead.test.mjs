// test/gexRead.test.mjs — the sentences on the gamma tab.
// The behaviour that matters most is ABSTENTION: spot inside the flip zone is the common case on a
// real chain and genuinely is not a regime read. A panel that always has an opinion is one nobody
// should size off, so "no usable read" is tested harder than the readable cases.
import { gexRead, regimeOf, skewOf, ageOf } from '../lib/gexRead.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const NOW = new Date('2026-09-02T09:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();

// ── age, in hours, because a stale flip reads precise ────────────────────────
{
  eq('under an hour reads in minutes', ageOf(hoursAgo(0.5), NOW).label, '30 min ago');
  eq('and is fresh', ageOf(hoursAgo(0.5), NOW).level, 'fresh');
  eq('three hours is aging but usable', ageOf(hoursAgo(3), NOW).level, 'aging');
  eq('eight hours is stale', ageOf(hoursAgo(8), NOW).level, 'stale');
  ok('and flagged as such', ageOf(hoursAgo(8), NOW).stale);
  eq('a day is a previous session', ageOf(hoursAgo(26), NOW).level, 'previous-session');
  ok('and says so in words rather than a number', /previous session/.test(ageOf(hoursAgo(26), NOW).label));
  // The failure this replaced: "captured today" at 14:00 off an 09:00 capture.
  ok('five hours is not described as fresh', ageOf(hoursAgo(5), NOW).level !== 'fresh');
  eq('no timestamp is stale, never fresh', ageOf(null, NOW).stale, true);
  eq('and an unparseable one too', ageOf('nonsense', NOW).stale, true);
}

// ── the regime, read off the ZONE ────────────────────────────────────────────
{
  const below = regimeOf({ spot: 700, flipLevel: 715, flipZoneLo: 709, flipZoneHi: 715 });
  eq('below the whole zone is a real read', below.state, 'below');
  eq('with the distance to the flip', below.distance, 15);

  const above = regimeOf({ spot: 730, flipLevel: 715, flipZoneLo: 709, flipZoneHi: 715 });
  eq('above the whole zone likewise', above.state, 'above');

  // The case that matters: this is what a live chain usually looks like.
  const inside = regimeOf({ spot: 707.64, flipLevel: 719.55, flipZoneLo: 702.45, flipZoneHi: 719.55 });
  eq('inside the zone is its own answer', inside.state, 'inside');
  eq('and reports how wide the doubt is', inside.zoneWidth, 17.1);
  ok('naming both bounds rather than a midpoint', /702\.45–719\.55/.test(inside.reason));

  eq('no flip solved is unknown', regimeOf({ spot: 700, flipLevel: null }).state, 'unknown');
  eq('no spot either', regimeOf({ spot: null, flipLevel: 715 }).state, 'unknown');
  // With no zone the flip itself is the boundary — a single-point zone, not a licence to guess.
  eq('a missing zone falls back to the flip', regimeOf({ spot: 700, flipLevel: 715 }).state, 'below');
}

// ── the skew, which survives when the flip does not ─────────────────────────
{
  const s = skewOf([{ strike: 705, netGexUsd: -3e9 }, { strike: 715, netGexUsd: 8e8 }], 710);
  eq('gamma below spot is summed apart from above', [s.below, s.above], [-3e9, 8e8]);
  eq('heavier side named', s.heavier, 'below');
  ok('with a ratio', s.ratio > 3);

  const bal = skewOf([{ strike: 705, netGexUsd: -1e9 }, { strike: 715, netGexUsd: -1.1e9 }], 710);
  eq('a balanced book names no side', bal.heavier, null);
  // Only lopsided AND negative is a finding — a book heavy on the POSITIVE side is not the thing
  // the sentence is warning about.
  const pos = skewOf([{ strike: 705, netGexUsd: 3e9 }, { strike: 715, netGexUsd: 1e8 }], 710);
  eq('lopsided but positive is not flagged', pos.heavier, null);
  eq('strikes exactly at spot count to neither side', skewOf([{ strike: 710, netGexUsd: -5e9 }], 710).below, 0);
  eq('no strikes, no skew', skewOf([], 710), null);
  eq('no spot, no skew', skewOf([{ strike: 705, netGexUsd: -1 }], null), null);
}

// ── the whole read ───────────────────────────────────────────────────────────
{
  const r = gexRead({ row: { asOf: hoursAgo(1), spot: 700, gexUsd: -5e9, flipLevel: 715,
    flipZoneLo: 709, flipZoneHi: 715, callWall: 720, putWall: 690 }, byStrike: [], now: NOW });
  eq('below the zone is called negative gamma', r.state, 'amplify');
  ok('in plain words', /moves amplify/.test(r.headline));
  ok('and the stance is about stops and size, not direction', /stop|size/i.test(r.stance));
  eq('confidence is clear when the zone is clear', r.confidence, 'clear');
}
{
  const r = gexRead({ row: { asOf: hoursAgo(1), spot: 730, gexUsd: 5e9, flipLevel: 715,
    flipZoneLo: 709, flipZoneHi: 715 }, now: NOW });
  eq('above the zone damps', r.state, 'damp');
  ok('and says breakouts fail', /fail|revers/i.test(r.stance));
}
{
  // THE ABSTENTION. Real numbers from 2026-09-01.
  const r = gexRead({ row: { asOf: hoursAgo(1), spot: 707.64, gexUsd: -2.75e9, flipLevel: 719.55,
    flipZoneLo: 702.45, flipZoneHi: 719.55, flipFragile: true, callWall: 710, putWall: 700 }, now: NOW });
  eq('spot inside the zone refuses a regime call', r.state, 'unclear');
  eq('and says so in the headline', r.headline, 'No usable regime read');
  eq('with no confidence claimed', r.confidence, 'none');
  ok('the stance tells you not to size off it', /do not size off the flip/i.test(r.stance));
  ok('and explains that both sides are defensible', /both.*defensible|neither is a finding/i.test(r.stance));
}
{
  // Staleness is a line in the read, not a footnote elsewhere.
  const stale = gexRead({ row: { asOf: hoursAgo(9), spot: 700, flipLevel: 715, flipZoneLo: 709, flipZoneHi: 715 }, now: NOW });
  ok('a stale row warns inside the read', stale.lines.some(l => /refresh before sizing/i.test(l)));
  const old = gexRead({ row: { asOf: hoursAgo(30), spot: 700, flipLevel: 715, flipZoneLo: 709, flipZoneHi: 715 }, now: NOW });
  ok('a previous session warns harder', old.lines.some(l => /previous session|settled since/i.test(l)));
  const fresh = gexRead({ row: { asOf: hoursAgo(0.5), spot: 700, flipLevel: 715, flipZoneLo: 709, flipZoneHi: 715 }, now: NOW });
  ok('a fresh one does not nag', !fresh.lines.some(l => /refresh/i.test(l)));
  // A live recompute says what it is, since it is a different thing from a stored capture.
  const liveR = gexRead({ row: { asOf: hoursAgo(0), spot: 700, flipLevel: 715, flipZoneLo: 709, flipZoneHi: 715 }, now: NOW, live: true });
  ok('a live read explains that OI has not changed', liveR.lines.some(l => /same settled open interest/i.test(l)));
}
{
  const none = gexRead({ row: null, now: NOW });
  eq('no row at all is handled', none.ok, false);
  ok('with something readable', none.lines.length > 0);
  eq('an empty call does not throw', gexRead().ok, false);
}

// ── CONCENTRATION BELONGS NEXT TO THE WALLS, NOT SIX SCREENS BELOW THEM ─────
{
  const row = { asOf: hoursAgo(1), spot: 700, gexUsd: -5e9, flipLevel: 715,
    flipZoneLo: 712, flipZoneHi: 718, callWall: 740, putWall: 690 };
  const dominated = { dominated: true, frontExpiry: '2026-09-02', frontShare: 71.4,
    expiries: [{ expiry: '2026-09-02' }, { expiry: '2026-09-04' }] };
  const spread = { dominated: false, frontExpiry: '2026-09-02', frontShare: 18.2,
    expiries: [{ expiry: '2026-09-02' }, { expiry: '2026-09-04' }, { expiry: '2026-09-18' }] };

  const d = gexRead({ row, grid: dominated, now: NOW });
  ok('a dominated book is called out in the read', d.lines.some(l => l.includes('71.4%')));
  ok('and names the expiry that owns it', d.lines.some(l => l.includes('2026-09-02') && l.includes('expires')));
  eq('and is flagged on the object', d.concentrated, true);
  // The point of moving it: it has to land AFTER the walls line, where it qualifies something.
  const wallAt = d.lines.findIndex(l => l.includes('Walls at'));
  const concAt = d.lines.findIndex(l => l.includes('71.4%'));
  ok('the walls are stated first, then qualified', wallAt >= 0 && concAt === wallAt + 1);

  const sp = gexRead({ row, grid: spread, now: NOW });
  ok('a spread book says so too', sp.lines.some(l => l.includes('3 expiries')));
  eq('and is not flagged', sp.concentrated, false);
  ok('silence is not the same as agreement — both cases speak', sp.lines.length === d.lines.length);

  // Concentration qualifies the WALLS. It does not make the regime read wrong, and must not
  // quietly downgrade a clear flip read into a low-confidence one.
  const plain = gexRead({ row, now: NOW });
  eq('confidence is unchanged by concentration', d.confidence, plain.confidence);
  eq('and the headline too', d.headline, plain.headline);
  eq('no grid means no line rather than a guess', plain.lines.some(l => l.includes('expiries')), false);
  eq('and no flag', plain.concentrated, false);
  // A single-expiry grid has nothing to compare across, so the "holds across N expiries" claim
  // would be vacuous.
  const one = gexRead({ row, grid: { dominated: false, frontShare: 100, expiries: [{ expiry: '2026-09-02' }] }, now: NOW });
  eq('one expiry makes no cross-expiry claim', one.lines.some(l => l.includes('hold across')), false);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
