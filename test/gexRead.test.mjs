// test/gexRead.test.mjs — the sentences on the gamma tab.
// The behaviour that matters most is ABSTENTION: spot inside the flip zone is the common case on a
// real chain and genuinely is not a regime read. A panel that always has an opinion is one nobody
// should size off, so "no usable read" is tested harder than the readable cases.
import { gexRead, regimeOf, skewOf, ageOf, FLIP_MARGIN_PCT, wallAgreement } from '../lib/gexRead.js';
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
  // These fixtures carry no peak strikes at all, so neither wall can be any expiry's peak and the
  // line reports the count per wall. It still has to SPEAK — a spread book that says nothing about
  // its walls is the silent-agreement failure this block exists to prevent.
  ok('a spread book says so too', sp.lines.some(l => /call wall 740: 0 of 3; put wall 690: 0 of 3/.test(l)));
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

// ── CLEARING THE ZONE BY A HAIR IS NOT A REGIME ──────────────────────────────
// Not a hypothetical. On 2026-09-08 this board and an independent GEX source read the same QQQ
// chain at effectively the same spot and solved the flip 1.14 apart — 0.16% — with spot between
// the two, so one called positive gamma and the other negative. The board's arithmetic was right
// and its confidence was not: it had cleared the zone by 0.10% of spot.
{
  // The board's own numbers from that morning.
  const board = regimeOf({ spot: 718.96, flipLevel: 718.27, flipZoneLo: 699.5794, flipZoneHi: 718.2726 });
  eq('a 0.10% clearance is an edge, not a regime', board.state, 'edge');
  eq('but which side it leans is still a fact worth printing', board.lean, 'above');
  eq('and the clearance is reported exactly, not rounded away', board.clearancePct, 0.096);
  ok('the reason says why it is being withheld', /inside the margin/.test(board.reason));

  // The other source, same chain, same moment — its flip put spot INSIDE the zone entirely.
  const other = regimeOf({ spot: 719.06, flipLevel: 719.41, flipZoneLo: 699.58, flipZoneHi: 719.41 });
  eq('the other source read the same chain as inside the zone', other.state, 'inside');
  ok('so neither read supports a confident regime', ['edge', 'inside'].includes(board.state) && ['edge', 'inside'].includes(other.state));

  // The margin must not swallow a real regime.
  eq('a clear distance is still a regime',
     regimeOf({ spot: 730, flipLevel: 718.27, flipZoneLo: 699.58, flipZoneHi: 718.27 }).state, 'above');
  eq('and below is still below',
     regimeOf({ spot: 690, flipLevel: 718.27, flipZoneLo: 699.58, flipZoneHi: 718.27 }).state, 'below');

  // Exactly at the boundary, from both directions, since this is a threshold.
  const at = (clearPct) => {
    const spot = 700, hi = 700 - (spot * clearPct / 100);
    return regimeOf({ spot, flipLevel: hi, flipZoneLo: hi - 10, flipZoneHi: hi });
  };
  eq('just inside the margin is an edge', at(FLIP_MARGIN_PCT - 0.01).state, 'edge');
  eq('just outside it is a regime', at(FLIP_MARGIN_PCT + 0.01).state, 'above');
  eq('the margin is a quarter of a percent', FLIP_MARGIN_PCT, 0.25);
  // Wider than the 0.16% the two sources actually disagreed by, which is where it came from.
  ok('and it covers the disagreement it was derived from', FLIP_MARGIN_PCT > (1.14 / 719) * 100);

  // The margin is a parameter, so a caller can reason about a different one.
  eq('a caller can widen it', regimeOf({ spot: 730, flipLevel: 718.27, flipZoneLo: 699.58, flipZoneHi: 718.27 },
                                       { marginPct: 5 }).state, 'edge');

  // ── AND THE READ REFUSES THE STANCE ──
  const read = gexRead({ row: { spot: 718.96, flipLevel: 718.27, flipZoneLo: 699.5794, flipZoneHi: 718.2726,
                                gexUsd: 186000000, asOf: new Date().toISOString() }, now: new Date() });
  eq('the headline does not pick a side', read.headline, 'At the flip — no regime edge');
  eq('and the state is unclear rather than damp', read.state, 'unclear');
  ok('the stance says not to size off it', /Do not size off the flip/.test(read.stance));
  ok('and it does not tell you moves damp', !/damp|amplif/i.test(read.stance));
}

// ── DO THE WALLS ACTUALLY HOLD? ──────────────────────────────────────────────
// The old test was gamma CONCENTRATION: front expiry under half the gross gamma meant "the walls
// hold across N expiries — a level rather than one day's positioning". Different claim, and it does
// not follow. QQQ on 2026-09-08 is the counterexample, taken from the panel's own table.
{
  const E = (expiry, shareOfAbs, peakPutStrike, peakCallStrike) => ({ expiry, shareOfAbs, peakPutStrike, peakCallStrike });
  const real = { frontShare: 24.9, frontExpiry: '2026-09-08', dominated: false, expiries: [
    E('2026-09-08', 24.9, 717, 720), E('2026-09-09', 12.3, 714, 722), E('2026-09-10', 0.9, 715, 725),
    E('2026-09-18', 22.3, 700, 730), E('2026-10-16', 16.8, 700, 750), E('2026-12-18', 22.9, 660, 780),
  ] };

  const wa = wallAgreement(real, 720, 717);
  eq('only the front expiry peaks at the headline walls', wa.agree, 1);
  eq('out of six', wa.total, 6);
  eq('and it is named', wa.matched, ['2026-09-08']);
  ok('which is not a majority', !wa.majority);
  // The old rule would have passed this: the front carries well under half the gross gamma.
  ok('even though no single expiry dominates the gamma', real.frontShare < 50);

  const read = gexRead({
    row: { spot: 717.34, flipLevel: 718.54, flipZoneLo: 710.2605, flipZoneHi: 718.5382,
           callWall: 720, putWall: 717, gexUsd: -1960000000, asOf: '2026-09-08T13:40:00Z' },
    grid: real, now: new Date('2026-09-08T13:45:00Z'), live: true });
  const said = read.lines.join(' ');
  ok('the read says only one expiry peaks at both walls', /Only 1 of 6 expiries peaks at both walls/.test(said));
  ok('and that it expires today', /2026-09-08, expiring today/.test(said));
  // Both walls ARE that expiry's own peaks here, so the closing clause must not claim otherwise.
  ok('and it does not call either wall an aggregate', !/is a sum rather than a level/.test(said));
  ok('it says instead that no ONE expiry claims both', /no single expiry claims both/.test(said));
  // The per-wall split, which the combined count hid.
  eq('the call wall is one expiry\'s peak', [wa.call.agree, wa.call.matched], [1, ['2026-09-08']]);
  eq('and so is the put wall', [wa.put.agree, wa.put.matched], [1, ['2026-09-08']]);
  ok('and it no longer claims the walls hold across six', !/walls hold across 6/.test(said));
  ok('nor that they are a multi-expiry level', !/are a multi-expiry level/.test(said));

  // ── THE CASE THAT EXPOSED THE SPLIT: QQQ, 2026-09-09 ───────────────────────
  // Peaks taken from the live grid that morning. The put wall at 700 is 2026-09-18's own heaviest
  // put strike; nothing peaks at the 720 call wall — every expiry's heaviest call sits above it
  // (719 / 722 / 725 / 730 / 750 / 780). The combined count is therefore 0, and reporting only
  // that said "0 of 6 expiries peaks at these strikes" while the panel's per-row badge — which
  // tested EITHER wall — marked 2026-09-18 as matching. One card, two answers.
  {
    const g0909 = { frontShare: 23.7, frontExpiry: '2026-09-09', dominated: false, expiries: [
      E('2026-09-09', 23.7, 717, 719), E('2026-09-10', 16.6, 710, 722), E('2026-09-11', 17, 705, 725),
      E('2026-09-18', 15.4, 700, 730), E('2026-10-16', 7.8, 670, 750), E('2026-12-18', 19.5, 660, 780),
    ] };
    const w = wallAgreement(g0909, 720, 700);
    eq('no expiry peaks at both walls', w.agree, 0);
    eq('nothing peaks at the 720 call wall', w.call.agree, 0);
    eq('but one expiry peaks at the 700 put wall', [w.put.agree, w.put.matched], [1, ['2026-09-18']]);

    const said0909 = gexRead({
      row: { spot: 718.36, flipLevel: 718.83, flipZoneLo: 709.75, flipZoneHi: 718.83,
             callWall: 720, putWall: 700, gexUsd: -443800000, asOf: '2026-09-09T13:55:00Z' },
      grid: g0909, now: new Date('2026-09-09T13:56:00Z'), live: true }).lines.join(' ');
    ok('the read reports each wall separately', /call wall 720: 0 of 6; put wall 700: 1 of 6 \(2026-09-18\)/.test(said0909));
    ok('it says no expiry peaks at BOTH', /No expiry peaks at both walls/.test(said0909));
    // The old line claimed a remainder that a zero count does not have.
    ok('and it no longer says "the rest peak wider"', !/The rest peak wider/.test(said0909));
    // Only the call wall is unsupported. Saying "neither" would be as wrong as saying "both hold".
    ok('only the call wall is called a sum', /No expiry peaks at the call wall/.test(said0909));
    ok('and the put wall is not lumped in with it', !/Neither is any single expiry/.test(said0909));
  }

  // Both walls unsupported: the "neither" branch, which must not fire above.
  {
    const none = { frontShare: 20, frontExpiry: 'a', dominated: false, expiries: [
      E('a', 20, 705, 725), E('b', 20, 710, 730), E('c', 20, 715, 735), E('d', 20, 690, 745),
    ] };
    const w = wallAgreement(none, 720, 700);
    eq('neither wall is any expiry\'s peak', [w.agree, w.call.agree, w.put.agree], [0, 0, 0]);
    const said = gexRead({ row: { spot: 718, flipLevel: 718, flipZoneLo: 710, flipZoneHi: 718,
                                  callWall: 720, putWall: 700, gexUsd: -1e8, asOf: '2026-09-09T13:55:00Z' },
                           grid: none, now: new Date('2026-09-09T13:56:00Z'), live: true }).lines.join(' ');
    ok('both are called sums', /Neither is any single expiry's peak/.test(said));
    ok('and neither is singled out', !/No expiry peaks at the call wall/.test(said));
  }

  // NOT ONE-DIRECTIONAL. Walls that genuinely repeat must still be reported as holding, or the fix
  // has simply replaced one wrong answer with another.
  const agreeing = { frontShare: 24.9, frontExpiry: '2026-09-08', dominated: false, expiries: [
    E('2026-09-08', 24.9, 700, 730), E('2026-09-09', 12.3, 700, 730),
    E('2026-09-18', 22.3, 700, 730), E('2026-12-18', 22.9, 660, 780),
  ] };
  const wb = wallAgreement(agreeing, 730, 700);
  eq('three of four expiries agreeing is a majority', [wb.agree, wb.total, wb.majority], [3, 4, true]);
  const good = gexRead({ row: { spot: 717, flipLevel: 700, flipZoneLo: 690, flipZoneHi: 695,
                                callWall: 730, putWall: 700, gexUsd: 1e9, asOf: '2026-09-08T13:40:00Z' },
                         grid: agreeing, now: new Date('2026-09-08T13:45:00Z'), live: true });
  ok('and is reported as holding', /walls hold across 3 of 4 expiries/.test(good.lines.join(' ')));

  // Exactly half counts as holding — the tie has to fall somewhere and "half the book agrees" is
  // support rather than absence of it.
  eq('a tie is a majority', wallAgreement({ expiries: [E('a', 1, 700, 730), E('b', 1, 660, 780)] }, 730, 700).majority, true);

  // Degenerate inputs must not throw or assert anything.
  eq('no walls, no claim', wallAgreement(real, null, null), null);
  eq('no grid, no claim', wallAgreement(null, 720, 717), null);
  eq('an empty expiry list makes no claim', wallAgreement({ expiries: [] }, 720, 717), null);
  // A single expiry cannot support a multi-expiry claim either way, so the line is not printed.
  const one = gexRead({ row: { spot: 717, flipLevel: 700, flipZoneLo: 690, flipZoneHi: 695,
                               callWall: 730, putWall: 700, gexUsd: 1e9, asOf: '2026-09-08T13:40:00Z' },
                        grid: { frontShare: 100, frontExpiry: 'x', dominated: false, expiries: [E('x', 100, 700, 730)] },
                        now: new Date('2026-09-08T13:45:00Z'), live: true });
  ok('one expiry says nothing about holding across expiries', !/expiries peaks|walls hold across/.test(one.lines.join(' ')));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
